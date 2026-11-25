import type { AttemptState, EnvelopeTotals, ReserveResult, SettleResult, SpendStore } from "./store";

/**
 * The one Redis capability this store needs: run a script atomically.
 * Any client fits (a TCP client locally, a hosted vendor's client when deployed).
 */
export interface ScriptRunner {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

/**
 * Thrown when an envelope has no record in Redis. That happens before `init()`, and also if
 * the data was lost. Either way the guard must refuse: a missing counter is not a zero counter.
 */
export class EnvelopeNotInitializedError extends Error {
  override readonly name: string = "EnvelopeNotInitializedError";
  constructor(envelope: string, detail = "is not initialized in Redis; refusing to count from zero") {
    super(`spend envelope "${envelope}" ${detail}`);
  }
}

/**
 * Thrown when an envelope's record exists but a required number is missing or unreadable.
 * Nothing is read as zero and nothing is repaired automatically: a person has to reconcile it.
 */
export class EnvelopeCorruptError extends EnvelopeNotInitializedError {
  override readonly name = "EnvelopeCorruptError";
  constructor(envelope: string) {
    super(envelope, "has a damaged record in Redis (a required field is missing or not a number); refusing to use it");
  }
}

/*
 * One Redis hash per envelope holds everything: the fixed limit, the running totals, the
 * suspension flag, and one field per attempt ("a:<id>" = "state|hold|charged"). Because it is
 * a single key, the totals and the attempts cannot be lost, expired or evicted separately.
 */
const PREAMBLE = `
local K = KEYS[1]
local function health()
  if redis.call('EXISTS', K) == 0 then return 'missing' end
  local v = redis.call('HMGET', K, 'limit', 'settled', 'held', 'retained', 'attempts')
  for i = 1, 5 do
    if not v[i] or not tonumber(v[i]) or tonumber(v[i]) < 0 then return 'corrupt' end
  end
  return 'ok'
end
local function reply(status, extra)
  local v = redis.call('HMGET', K, 'settled', 'held', 'retained', 'attempts', 'suspended', 'limit')
  return { status, extra or '', v[1], v[2], v[3], v[4], v[5] or '', v[6] }
end
local function attempt(id)
  local raw = redis.call('HGET', K, 'a:' .. id)
  if not raw then return nil end
  local state, hold = string.match(raw, '^([^|]+)|([^|]+)|')
  return state, hold
end
`;

// ARGV: limit, carried, now
const INIT = `${PREAMBLE}
local h = health()
if h == 'ok' then return reply('exists') end
if h == 'corrupt' then return { 'corrupt' } end
redis.call('HSET', K, 'limit', ARGV[1], 'carried', ARGV[2], 'created', ARGV[3],
  'settled', ARGV[2], 'held', '0', 'retained', '0', 'attempts', '0')
return reply('created')
`;

// ARGV: attempt id, amount, limit
const RESERVE = `${PREAMBLE}
local h = health()
if h ~= 'ok' then return { h } end
local state = attempt(ARGV[1])
if state then return reply('duplicate', state) end
if redis.call('HEXISTS', K, 'suspended') == 1 then return reply('suspended') end
local v = redis.call('HMGET', K, 'limit', 'settled', 'held', 'retained')
local limit = math.min(tonumber(ARGV[3]), tonumber(v[1]))
if tonumber(v[2]) + tonumber(v[3]) + tonumber(v[4]) + tonumber(ARGV[2]) > limit then return reply('limit') end
redis.call('HSET', K, 'a:' .. ARGV[1], 'reserved|' .. ARGV[2] .. '|0')
redis.call('HINCRBY', K, 'held', ARGV[2])
redis.call('HINCRBY', K, 'attempts', '1')
return reply('ok')
`;

// ARGV: attempt id, actual
const SETTLE = `${PREAMBLE}
local h = health()
if h ~= 'ok' then return { h } end
local state, hold = attempt(ARGV[1])
if not state then return { 'unknown' } end
if state == 'settled' then return reply('duplicate') end
redis.call('HINCRBY', K, state == 'reserved' and 'held' or 'retained', '-' .. hold)
redis.call('HINCRBY', K, 'settled', ARGV[2])
redis.call('HSET', K, 'a:' .. ARGV[1], 'settled|' .. hold .. '|' .. ARGV[2])
local over = tonumber(ARGV[2]) > tonumber(hold)
if over then
  redis.call('HSETNX', K, 'suspended', 'attempt ' .. ARGV[1] .. ' cost ' .. ARGV[2] .. ', above its hold of ' .. hold)
end
return reply('ok', over and 'over' or '')
`;

// ARGV: attempt id
const RETAIN = `${PREAMBLE}
local h = health()
if h ~= 'ok' then return { h } end
local state, hold = attempt(ARGV[1])
if not state then return { 'unknown' } end
if state == 'reserved' then
  redis.call('HINCRBY', K, 'held', '-' .. hold)
  redis.call('HINCRBY', K, 'retained', hold)
  redis.call('HSET', K, 'a:' .. ARGV[1], 'retained|' .. hold .. '|0')
end
return reply('ok')
`;

// ARGV: reason
const SUSPEND = `${PREAMBLE}
local h = health()
if h ~= 'ok' then return { h } end
redis.call('HSETNX', K, 'suspended', ARGV[1])
return reply('ok')
`;

const RESUME = `${PREAMBLE}
local h = health()
if h ~= 'ok' then return { h } end
redis.call('HDEL', K, 'suspended')
return reply('ok')
`;

const TOTALS = `${PREAMBLE}
local h = health()
if h ~= 'ok' then return { h } end
return reply('ok')
`;

const DUMP = `${PREAMBLE}
local h = health()
if h ~= 'ok' then return { h } end
return { 'ok', unpack(redis.call('HGETALL', K)) }
`;

const wholeNano = (n: number, name: string): string => {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${name} must be a non-negative integer of nanodollars`);
  return String(n);
};
const cleanId = (id: string): string => {
  if (typeof id !== "string" || id.length === 0 || id.length > 200 || id.includes("|")) {
    throw new RangeError("attemptId must be 1 to 200 characters and may not contain '|'");
  }
  return id;
};

export interface AttemptRecord {
  attemptId: string;
  state: AttemptState;
  holdNano: number;
  chargedNano: number;
}

/**
 * The durable spend store. Every method is one Lua script on one key, so the check and the
 * write are a single atomic step no matter how many processes share the envelope.
 *
 * - The limit is fixed when the envelope is initialized. A caller may pass a lower limit,
 *   never a higher one.
 * - A missing or damaged record refuses every call. Nothing is read as zero.
 * - A settlement above its hold suspends the envelope in the same step.
 *
 * Redis must keep this key: no expiry is ever set, and the server must not evict
 * (`maxmemory-policy noeviction`) or lose acknowledged writes on restart.
 */
export class RedisSpendStore implements SpendStore {
  private readonly prefix: string;
  private readonly now: () => Date;

  constructor(
    private readonly redis: ScriptRunner,
    options: { prefix?: string; now?: () => Date } = {},
  ) {
    this.prefix = options.prefix ?? "ta";
    this.now = options.now ?? (() => new Date());
  }

  /** The envelope's one key. The name is also the hash tag. */
  keyOf(envelope: string): string {
    return `${this.prefix}:{${envelope}}`;
  }

  private async raw(envelope: string, script: string, args: string[]): Promise<string[]> {
    const reply = await this.redis.eval(script, [this.keyOf(envelope)], args);
    if (!Array.isArray(reply) || typeof reply[0] !== "string") throw new Error("unexpected reply from the spend store");
    const status = reply[0];
    if (status === "missing") throw new EnvelopeNotInitializedError(envelope);
    if (status === "corrupt") throw new EnvelopeCorruptError(envelope);
    if (status === "unknown") throw new Error(`unknown attempt in envelope ${envelope}`);
    return reply.map(String);
  }

  private async run(envelope: string, script: string, args: string[]) {
    const [status, extra, settled, held, retained, attempts, suspended, limit] = await this.raw(envelope, script, args);
    const settledNano = Number(settled);
    const heldNano = Number(held);
    const retainedNano = Number(retained);
    const numbers = [settledNano, heldNano, retainedNano, Number(attempts), Number(limit)];
    if (numbers.some((n) => !Number.isSafeInteger(n) || n < 0)) throw new EnvelopeCorruptError(envelope);
    const totals: EnvelopeTotals = {
      settledNano,
      heldNano,
      retainedNano,
      committedNano: settledNano + heldNano + retainedNano,
      attempts: Number(attempts),
      suspended: suspended ? suspended : null,
    };
    return { status: status!, extra: extra ?? "", totals, limitNano: Number(limit) };
  }

  /**
   * Create the envelope's record. Does nothing if a healthy one exists, and refuses if a
   * damaged one does. `carriedNano` is spend from before this record existed (from the ledger).
   */
  async init(args: { envelope: string; limitNano: number; carriedNano?: number }): Promise<{ created: boolean; limitNano: number; totals: EnvelopeTotals }> {
    const { status, totals, limitNano } = await this.run(args.envelope, INIT, [
      wholeNano(args.limitNano, "limitNano"),
      wholeNano(args.carriedNano ?? 0, "carriedNano"),
      this.now().toISOString(),
    ]);
    return { created: status === "created", limitNano, totals };
  }

  async reserve(args: { envelope: string; attemptId: string; amountNano: number; limitNano: number }): Promise<ReserveResult> {
    const { status, extra, totals } = await this.run(args.envelope, RESERVE, [
      cleanId(args.attemptId),
      wholeNano(args.amountNano, "amountNano"),
      wholeNano(args.limitNano, "limitNano"),
    ]);
    if (status === "ok") return { ok: true, duplicate: false, totals };
    if (status === "duplicate") return { ok: true, duplicate: true, state: extra as AttemptState, totals };
    return { ok: false, reason: status === "suspended" ? "suspended" : "limit", totals };
  }

  async settle(args: { envelope: string; attemptId: string; actualNano: number }): Promise<SettleResult> {
    const { status, extra, totals } = await this.run(args.envelope, SETTLE, [cleanId(args.attemptId), wholeNano(args.actualNano, "actualNano")]);
    return { applied: status === "ok", overHold: extra === "over", totals };
  }

  async retain(args: { envelope: string; attemptId: string }): Promise<EnvelopeTotals> {
    return (await this.run(args.envelope, RETAIN, [cleanId(args.attemptId)])).totals;
  }

  async suspend(args: { envelope: string; reason: string }): Promise<EnvelopeTotals> {
    return (await this.run(args.envelope, SUSPEND, [(args.reason || "suspended").slice(0, 500)])).totals;
  }

  /** Operator action: admit requests again after a suspension has been looked into. */
  async resume(envelope: string): Promise<EnvelopeTotals> {
    return (await this.run(envelope, RESUME, [])).totals;
  }

  async totals(envelope: string): Promise<EnvelopeTotals> {
    return (await this.run(envelope, TOTALS, [])).totals;
  }

  /** The limit fixed at initialization. */
  async limit(envelope: string): Promise<number> {
    return (await this.run(envelope, TOTALS, [])).limitNano;
  }

  /** Operator view: every attempt on record. */
  async attempts(envelope: string): Promise<AttemptRecord[]> {
    const flat = (await this.raw(envelope, DUMP, [])).slice(1);
    const records: AttemptRecord[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const field = flat[i]!;
      if (!field.startsWith("a:")) continue;
      const [state, hold, charged] = flat[i + 1]!.split("|");
      records.push({ attemptId: field.slice(2), state: state as AttemptState, holdNano: Number(hold), chargedNano: Number(charged) });
    }
    return records;
  }

  /**
   * Operator check: do the running totals equal what the attempt records add up to?
   * A mismatch means the record was altered outside this store.
   */
  async audit(envelope: string): Promise<{ consistent: boolean; totals: EnvelopeTotals; fromAttempts: { settledNano: number; heldNano: number; retainedNano: number; attempts: number } }> {
    const flat = (await this.raw(envelope, DUMP, [])).slice(1);
    const fields = new Map<string, string>();
    for (let i = 0; i + 1 < flat.length; i += 2) fields.set(flat[i]!, flat[i + 1]!);
    const sum = { settledNano: Number(fields.get("carried") ?? 0), heldNano: 0, retainedNano: 0, attempts: 0 };
    for (const [field, value] of fields) {
      if (!field.startsWith("a:")) continue;
      const [state, hold, charged] = value.split("|");
      sum.attempts++;
      if (state === "settled") sum.settledNano += Number(charged);
      else if (state === "reserved") sum.heldNano += Number(hold);
      else sum.retainedNano += Number(hold);
    }
    const totals = await this.totals(envelope);
    const consistent =
      sum.settledNano === totals.settledNano && sum.heldNano === totals.heldNano && sum.retainedNano === totals.retainedNano && sum.attempts === totals.attempts;
    return { consistent, totals, fromAttempts: sum };
  }
}
