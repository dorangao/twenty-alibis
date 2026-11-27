import { randomUUID } from "node:crypto";
import type { ScriptRunner } from "../spend/redis-store";
import { MAX_SESSIONS, SESSION_TTL_MS, type SaveRecord, type SessionRecord, type SessionStore } from "./sessions";

/**
 * Sessions in Redis, for a server that runs as many short-lived workers.
 *
 * A worker keeps nothing between requests, and two workers can be handed the same session at
 * the same moment. So the rules the in-memory store keeps with a Set are kept here by Redis
 * itself, each in one atomic script:
 *
 *   one at a time   A worker takes a lease on the session before it does anything. The lease
 *                   is a key that holds the worker's own token and runs out by itself. While
 *                   the worker is at work it renews the lease; a worker that dies stops
 *                   renewing, and the session is free again a little later.
 *   owner first     The lease is only offered to the session's owner. Anyone else is told
 *                   "missing", whether the session is free, at work, or not there at all.
 *   no overwrite    A record is written only by the worker whose token is in the lease, and
 *                   only if the session's owner and revision are still what that worker read.
 *                   A worker that was slow, lost its lease and comes back later changes
 *                   nothing: its write is refused.
 *
 * What is kept, under `prefix`:
 *
 *   <prefix>:s:<id>         a hash: the record as JSON, and its owner and revision beside it
 *                           so a script can check them without reading the JSON. It expires
 *                           when the session does.
 *   <prefix>:s:<id>:lease   the token of the worker at work on it, with a time limit
 *   <prefix>:open           a sorted set of the games in play, by the time each expires
 *
 * A game takes a place in `open` when it starts and gives it up when it ends with an
 * accusation or expires. When every place is taken a new session is refused: a game someone
 * is still playing is never dropped to make room.
 *
 * If Redis cannot be reached or refuses a command, the call rejects. Nothing is assumed and
 * nothing is kept in the worker instead.
 */
export interface RedisSessionOptions {
  /** The first part of every key, e.g. "ta:web". Keys of other applications in the same Redis are never touched. */
  prefix: string;
  max?: number;
  ttlMs?: number;
  /** How long a lease lasts without being renewed. It is renewed three times in each term. */
  leaseMs?: number;
  now?: () => number;
}

/** How long a lease lasts without being renewed. A lost worker's session is free again after this long at most. */
export const SESSION_LEASE_MS = 30_000;

/** Thrown when a record could not be kept: the lease was lost, or the session was changed by someone else. */
export class SessionWriteError extends Error {
  override readonly name = "SessionWriteError";
  constructor(readonly why: string) {
    super(`the session could not be kept: ${why}`);
  }
}

// KEYS: session, open.  ARGV: id, record, owner, revision, expires at, now, the most games in play, time left
// "Expires at" and "now" are the server's clock and are only compared with each other, in
// `open`. The session's own time limit is given as time left, which Redis counts on its own
// clock: the two clocks need not agree.
const CREATE = `
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[6])
if redis.call('EXISTS', KEYS[1]) == 1 then return 'exists' end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[7]) then return 'full' end
redis.call('HSET', KEYS[1], 'record', ARGV[2], 'owner', ARGV[3], 'revision', ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[8])
redis.call('ZADD', KEYS[2], ARGV[5], ARGV[1])
return 'ok'
`;

// KEYS: session, lease
const READ = `
return { redis.call('HGET', KEYS[1], 'record'), redis.call('EXISTS', KEYS[2]) }
`;

// KEYS: session, lease.  ARGV: owner, token, lease term
// The owner is checked before the lease is tried: only the owner can learn that it is taken.
const ADMIT = `
local v = redis.call('HMGET', KEYS[1], 'owner', 'record', 'revision')
if not v[1] or v[1] ~= ARGV[1] then return { 'missing' } end
if not v[2] or not v[3] then return { 'damaged' } end
if not redis.call('SET', KEYS[2], ARGV[2], 'NX', 'PX', ARGV[3]) then return { 'busy' } end
return { 'ok', v[2], v[3] }
`;

// The check every write makes. ARGV: token, owner, the revision this worker last read or wrote.
const MAY_WRITE = `
local function may_write()
  if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 'lease-lost' end
  local v = redis.call('HMGET', KEYS[1], 'owner', 'revision')
  if not v[1] then return 'gone' end
  if v[1] ~= ARGV[2] or v[2] ~= ARGV[3] then return 'changed' end
  return 'ok'
end
`;

// KEYS: session, lease.  ARGV: token, owner, revision read, record, its revision
const SAVE = `${MAY_WRITE}
local said = may_write()
if said ~= 'ok' then return said end
redis.call('HSET', KEYS[1], 'record', ARGV[4], 'revision', ARGV[5])
return 'ok'
`;

// KEYS: session, lease, open.  ARGV: token, owner, revision read, record, its revision, '1' if the game is over, id
// The lease is given up in the same step, whatever the answer, unless it was not this worker's.
const COMMIT = `${MAY_WRITE}
local said = may_write()
if said == 'lease-lost' then return said end
redis.call('DEL', KEYS[2])
if said ~= 'ok' then return said end
redis.call('HSET', KEYS[1], 'record', ARGV[4], 'revision', ARGV[5])
if ARGV[6] == '1' then redis.call('ZREM', KEYS[3], ARGV[7]) end
return 'ok'
`;

const RENEW = "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]) return 1 else return 0 end";
const RELEASE = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

/** A record read back from Redis. Anything that is not a record of this session is an error, never a guess. */
function parse(id: string, raw: unknown): SessionRecord {
  let value: unknown;
  try {
    value = JSON.parse(String(raw));
  } catch {
    throw new SessionWriteError("its record cannot be read");
  }
  const record = value as Partial<SessionRecord> | null;
  if (!record || typeof record !== "object" || record.session?.id !== id || typeof record.owner !== "string" || !Number.isSafeInteger(record.revision)) {
    throw new SessionWriteError("its record cannot be read");
  }
  return record as SessionRecord;
}

export function redisSessions(redis: ScriptRunner, options: RedisSessionOptions): SessionStore {
  const max = options.max ?? MAX_SESSIONS;
  const ttl = options.ttlMs ?? SESSION_TTL_MS;
  const leaseMs = options.leaseMs ?? SESSION_LEASE_MS;
  const now = options.now ?? Date.now;
  const key = (id: string): string => `${options.prefix}:s:${id}`;
  const lease = (id: string): string => `${key(id)}:lease`;
  const open = `${options.prefix}:open`;

  return {
    create: async (record) => {
      const id = record.session.id;
      const at = now();
      const expires = record.createdAt + ttl;
      // A session whose time is already up is not kept at all.
      if (expires <= at) return false;
      const said = await redis.eval(CREATE, [key(id), open], [id, JSON.stringify(record), record.owner, String(record.revision), String(expires), String(at), String(max), String(expires - at)]);
      return said === "ok";
    },

    read: async (id) => {
      const [raw, held] = (await redis.eval(READ, [key(id), lease(id)], [])) as [unknown, unknown];
      if (raw === null || raw === undefined) return null;
      return { record: parse(id, raw), busy: Number(held) === 1 };
    },

    update: async (id, owner, work) => {
      const token = randomUUID();
      const admitted = (await redis.eval(ADMIT, [key(id), lease(id)], [owner, token, String(leaseMs)])) as string[];
      if (admitted[0] === "missing") return { ok: false, why: "missing" };
      if (admitted[0] === "busy") return { ok: false, why: "busy" };
      if (admitted[0] !== "ok") throw new SessionWriteError("its record cannot be read");

      // From here on the lease is this worker's, and must be given up on every way out.
      let ours = true;
      const beat = setInterval(() => {
        // A renewal that fails is not acted on here: every write checks the lease itself.
        void redis.eval(RENEW, [lease(id)], [token, String(leaseMs)]).catch(() => undefined);
      }, Math.max(1, Math.floor(leaseMs / 3)));
      beat.unref?.();
      try {
        const record = parse(id, admitted[1]);
        // The revision Redis holds, as this worker knows it. A write is taken only if it still is.
        let revision = String(admitted[2]);
        const save: SaveRecord = async (next) => {
          const said = String(await redis.eval(SAVE, [key(id), lease(id)], [token, owner, revision, JSON.stringify(next), String(next.revision)]));
          if (said !== "ok") throw new SessionWriteError(said);
          revision = String(next.revision);
        };
        const done = await work(record, save);
        const over = done.record.session.verdict !== undefined ? "1" : "0";
        const said = String(await redis.eval(COMMIT, [key(id), lease(id), open], [token, owner, revision, JSON.stringify(done.record), String(done.record.revision), over, id]));
        // Whatever it said, the lease is no longer held by this worker.
        ours = false;
        // "gone": the session ran out while this was at work. It stays gone; the answer is still given.
        if (said !== "ok" && said !== "gone") throw new SessionWriteError(said);
        return { ok: true, value: done.value };
      } finally {
        clearInterval(beat);
        if (ours) await redis.eval(RELEASE, [lease(id)], [token]).catch(() => undefined);
      }
    },
  };
}
