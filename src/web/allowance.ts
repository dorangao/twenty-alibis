import type { ScriptRunner } from "../spend/redis-store";

/**
 * How much one visitor, and all visitors together, may ask of the server in a while.
 *
 * This is a fairness control, not the money limit. A visitor is known only by a cookie, and
 * anyone can throw a cookie away and be a new visitor. What these limits do is stop one
 * person, or one open tab, from using up what was meant for everyone, and slow down a script
 * that starts games in a loop. What stops the spending for good is the spend guard's
 * envelope, in dollars, which does not care who is asking.
 *
 *   sessions per visitor   times one visitor may start a game in the window
 *   requests per visitor   attempts one visitor's games may make to send a request to the
 *                          model in the window, across all of their games. Every physical
 *                          attempt counts: the one that picks the topic, the answer, and a
 *                          retry.
 *   sessions per hour      times everyone together may start a game in an hour
 *
 * These count attempts, and each is counted before anything else is asked. A request that
 * the spend guard then refuses has still used one, and so has a start that then found the
 * server full. Nothing is given back: for a fairness rule that is close enough, and it
 * keeps the count to one atomic step.
 *
 * The visitor's window starts with the first thing they do and is not moved by what they do
 * later. The hour is the clock's own hour-long blocks, so a little more than the limit can
 * be started across the edge of two blocks.
 */
export interface Allowance {
  /**
   * Count one new game for this visitor. "visitor": they have started as many as one visitor
   * may. "site": everyone together has started as many as may be started this hour. Nothing
   * is counted unless the answer is "ok".
   */
  session(visitor: string): Promise<"ok" | "visitor" | "site">;
  /** Take one request to the model from this visitor's allowance. False when none is left; nothing is taken then. */
  request(visitor: string): Promise<boolean>;
}

export interface AllowanceLimits {
  sessionsPerVisitor: number;
  requestsPerVisitor: number;
  sessionsPerHour: number;
  /** How long a visitor's counts are kept from their first use. */
  visitorWindowMs: number;
}

const HOUR_MS = 60 * 60 * 1_000;

/**
 * The limits used when none are given. Chosen so that one visitor can play a few whole games
 * with typed questions in a day; the operator sets the real ones for the money at hand.
 */
export const DEFAULT_LIMITS: AllowanceLimits = { sessionsPerVisitor: 8, requestsPerVisitor: 150, sessionsPerHour: 60, visitorWindowMs: 24 * HOUR_MS };

/** Limits kept in this process's memory. For local play and tests. */
export function memoryAllowance(limits: AllowanceLimits = DEFAULT_LIMITS, now: () => number = Date.now): Allowance {
  const visitors = new Map<string, { since: number; sessions: number; requests: number }>();
  const hours = new Map<number, number>();
  const of = (visitor: string): { since: number; sessions: number; requests: number } => {
    const found = visitors.get(visitor);
    if (found && now() - found.since < limits.visitorWindowMs) return found;
    const fresh = { since: now(), sessions: 0, requests: 0 };
    visitors.set(visitor, fresh);
    return fresh;
  };
  return {
    session: async (visitor) => {
      const mine = of(visitor);
      if (mine.sessions >= limits.sessionsPerVisitor) return "visitor";
      const hour = Math.floor(now() / HOUR_MS);
      const all = hours.get(hour) ?? 0;
      if (all >= limits.sessionsPerHour) return "site";
      mine.sessions++;
      hours.clear();
      hours.set(hour, all + 1);
      return "ok";
    },
    request: async (visitor) => {
      const mine = of(visitor);
      if (mine.requests >= limits.requestsPerVisitor) return false;
      mine.requests++;
      return true;
    },
  };
}

/*
 * A count that is there but is not a whole number makes the script fail, and the call
 * rejects: a damaged count is never read as zero.
 */
const COUNT = `
local function count(raw)
  if not raw then return 0 end
  local n = tonumber(raw)
  if not n or n < 0 or n ~= math.floor(n) then error('a count is damaged') end
  return n
end
`;

// KEYS: visitor, hour.  ARGV: sessions per visitor, sessions per hour, visitor window, how long the hour's count is kept
const SESSION = `${COUNT}
if count(redis.call('HGET', KEYS[1], 'sessions')) >= tonumber(ARGV[1]) then return 'visitor' end
if count(redis.call('GET', KEYS[2])) >= tonumber(ARGV[2]) then return 'site' end
redis.call('HINCRBY', KEYS[1], 'sessions', 1)
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
return 'ok'
`;

// KEYS: visitor.  ARGV: requests per visitor, visitor window
const REQUEST = `${COUNT}
if count(redis.call('HGET', KEYS[1], 'requests')) >= tonumber(ARGV[1]) then return 0 end
redis.call('HINCRBY', KEYS[1], 'requests', 1)
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 1
`;

/**
 * The same limits kept in Redis, so every worker counts in one place. Keys:
 *
 *   <prefix>:v:<visitor>   a hash of the visitor's two counts; it expires one window after it was first written
 *   <prefix>:new:<hour>    how many games were started in that hour
 *
 * `visitor` is the hash of the visitor's secret, never the secret. If Redis cannot be reached
 * or refuses, the call rejects, and the caller must treat that as "no".
 */
export function redisAllowance(redis: ScriptRunner, options: { prefix: string; limits?: AllowanceLimits; now?: () => number }): Allowance {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const now = options.now ?? Date.now;
  const visitorKey = (visitor: string): string => `${options.prefix}:v:${visitor}`;
  return {
    session: async (visitor) => {
      const hour = `${options.prefix}:new:${Math.floor(now() / HOUR_MS)}`;
      const said = await redis.eval(SESSION, [visitorKey(visitor), hour], [String(limits.sessionsPerVisitor), String(limits.sessionsPerHour), String(limits.visitorWindowMs), String(2 * HOUR_MS)]);
      if (said !== "ok" && said !== "visitor" && said !== "site") throw new Error("the allowance could not be read");
      return said;
    },
    request: async (visitor) => {
      const said = Number(await redis.eval(REQUEST, [visitorKey(visitor)], [String(limits.requestsPerVisitor), String(limits.visitorWindowMs)]));
      if (said !== 0 && said !== 1) throw new Error("the allowance could not be read");
      return said === 1;
    },
  };
}
