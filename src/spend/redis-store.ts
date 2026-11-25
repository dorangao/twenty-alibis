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
  override readonly name = "EnvelopeNotInitializedError";
  constructor(envelope: string) {
    super(`spend envelope "${envelope}" is not initialized in Redis; refusing to count from zero`);
  }
}

const PREAMBLE = `
local function fmt(n) return string.format('%.0f', n) end
local function ready() return redis.call('EXISTS', KEYS[1]) == 1 and redis.call('EXISTS', KEYS[2]) == 1 end
local function totals()
  local t = redis.call('HMGET', KEYS[2], 'settled', 'held', 'retained', 'attempts')
  return tonumber(t[1] or '0'), tonumber(t[2] or '0'), tonumber(t[3] or '0'), tonumber(t[4] or '0')
end
local function reply(status, extra)
  local s, h, r, n = totals()
  return { status, extra or '', fmt(s), fmt(h), fmt(r), fmt(n) }
end
`;

// KEYS: meta, totals.  ARGV: limit, carried, now
const INIT = `${PREAMBLE}
if redis.call('EXISTS', KEYS[1]) == 1 then
  return reply('exists', redis.call('HGET', KEYS[1], 'limit'))
end
redis.call('HSET', KEYS[1], 'limit', ARGV[1], 'carried', ARGV[2], 'created', ARGV[3])
redis.call('DEL', KEYS[2])
redis.call('HSET', KEYS[2], 'settled', ARGV[2], 'held', '0', 'retained', '0', 'attempts', '0')
return reply('created', ARGV[1])
`;

// KEYS: meta, totals, attempt.  ARGV: amount, limit, now
const RESERVE = `${PREAMBLE}
if not ready() then return { 'uninitialized' } end
local state = redis.call('HGET', KEYS[3], 'state')
if state then return reply('duplicate', state) end
local limit = math.min(tonumber(ARGV[2]), tonumber(redis.call('HGET', KEYS[1], 'limit')))
local s, h, r = totals()
if s + h + r + tonumber(ARGV[1]) > limit then return reply('limit') end
redis.call('HSET', KEYS[3], 'state', 'reserved', 'hold', ARGV[1], 'charged', '0', 'at', ARGV[3])
redis.call('HINCRBY', KEYS[2], 'held', ARGV[1])
redis.call('HINCRBY', KEYS[2], 'attempts', '1')
return reply('ok')
`;

// KEYS: meta, totals, attempt.  ARGV: actual, now
const SETTLE = `${PREAMBLE}
if not ready() then return { 'uninitialized' } end
local a = redis.call('HMGET', KEYS[3], 'state', 'hold')
if not a[1] then return { 'unknown' } end
if a[1] == 'settled' then return reply('duplicate') end
local hold = tonumber(a[2])
redis.call('HINCRBY', KEYS[2], a[1] == 'reserved' and 'held' or 'retained', fmt(-hold))
redis.call('HINCRBY', KEYS[2], 'settled', ARGV[1])
redis.call('HSET', KEYS[3], 'state', 'settled', 'charged', ARGV[1], 'settled_at', ARGV[2])
return reply('ok', tonumber(ARGV[1]) > hold and 'over' or '')
`;

// KEYS: meta, totals, attempt.
const RETAIN = `${PREAMBLE}
if not ready() then return { 'uninitialized' } end
local a = redis.call('HMGET', KEYS[3], 'state', 'hold')
if not a[1] then return { 'unknown' } end
if a[1] == 'reserved' then
  redis.call('HINCRBY', KEYS[2], 'held', fmt(-tonumber(a[2])))
  redis.call('HINCRBY', KEYS[2], 'retained', a[2])
  redis.call('HSET', KEYS[3], 'state', 'retained')
end
return reply('ok')
`;

// KEYS: meta, totals.
const TOTALS = `${PREAMBLE}
if not ready() then return { 'uninitialized' } end
return reply('ok', redis.call('HGET', KEYS[1], 'limit'))
`;

const wholeNano = (n: number, name: string): string => {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${name} must be a non-negative integer of nanodollars`);
  return String(n);
};

/**
 * The durable spend store. Every method is one Lua script, so the check and the write are a
 * single atomic step no matter how many processes share the envelope.
 *
 * The limit is fixed when the envelope is initialized. A caller may pass a lower limit, never
 * a higher one.
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

  // The envelope name is the hash tag, so one envelope's keys always live together.
  private key(envelope: string, suffix: string): string {
    return `${this.prefix}:{${envelope}}:${suffix}`;
  }
  private base(envelope: string): [string, string] {
    return [this.key(envelope, "meta"), this.key(envelope, "totals")];
  }

  private async run(envelope: string, script: string, keys: string[], args: string[]) {
    const raw = await this.redis.eval(script, keys, args);
    if (!Array.isArray(raw) || typeof raw[0] !== "string") throw new Error("unexpected reply from the spend store");
    const [status, extra, settled, held, retained, attempts] = raw.map(String);
    if (status === "uninitialized") throw new EnvelopeNotInitializedError(envelope);
    if (status === "unknown") throw new Error(`unknown attempt in envelope ${envelope}`);
    const settledNano = Number(settled);
    const heldNano = Number(held);
    const retainedNano = Number(retained);
    const totals: EnvelopeTotals = {
      settledNano,
      heldNano,
      retainedNano,
      committedNano: settledNano + heldNano + retainedNano,
      attempts: Number(attempts),
    };
    if (Object.values(totals).some((n) => !Number.isSafeInteger(n) || n < 0)) {
      throw new Error("the spend store returned totals that are not whole, non-negative numbers");
    }
    return { status: status!, extra: extra ?? "", totals };
  }

  /**
   * Create the envelope's record. Does nothing if it already exists.
   * `carriedNano` is spend that happened before this record existed (taken from the ledger).
   */
  async init(args: { envelope: string; limitNano: number; carriedNano?: number }): Promise<{ created: boolean; limitNano: number; totals: EnvelopeTotals }> {
    const { status, extra, totals } = await this.run(args.envelope, INIT, this.base(args.envelope), [
      wholeNano(args.limitNano, "limitNano"),
      wholeNano(args.carriedNano ?? 0, "carriedNano"),
      this.now().toISOString(),
    ]);
    return { created: status === "created", limitNano: Number(extra), totals };
  }

  async reserve(args: { envelope: string; attemptId: string; amountNano: number; limitNano: number }): Promise<ReserveResult> {
    const { status, extra, totals } = await this.run(
      args.envelope,
      RESERVE,
      [...this.base(args.envelope), this.key(args.envelope, `attempt:${args.attemptId}`)],
      [wholeNano(args.amountNano, "amountNano"), wholeNano(args.limitNano, "limitNano"), this.now().toISOString()],
    );
    if (status === "ok") return { ok: true, duplicate: false, totals };
    if (status === "duplicate") return { ok: true, duplicate: true, state: extra as AttemptState, totals };
    return { ok: false, reason: "limit", totals };
  }

  async settle(args: { envelope: string; attemptId: string; actualNano: number }): Promise<SettleResult> {
    const { status, extra, totals } = await this.run(
      args.envelope,
      SETTLE,
      [...this.base(args.envelope), this.key(args.envelope, `attempt:${args.attemptId}`)],
      [wholeNano(args.actualNano, "actualNano"), this.now().toISOString()],
    );
    return { applied: status === "ok", overHold: extra === "over", totals };
  }

  async retain(args: { envelope: string; attemptId: string }): Promise<EnvelopeTotals> {
    const { totals } = await this.run(
      args.envelope,
      RETAIN,
      [...this.base(args.envelope), this.key(args.envelope, `attempt:${args.attemptId}`)],
      [],
    );
    return totals;
  }

  async totals(envelope: string): Promise<EnvelopeTotals> {
    return (await this.run(envelope, TOTALS, this.base(envelope), [])).totals;
  }

  /** The limit fixed at initialization. */
  async limit(envelope: string): Promise<number> {
    return Number((await this.run(envelope, TOTALS, this.base(envelope), [])).extra);
  }
}
