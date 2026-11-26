import { randomUUID } from "node:crypto";
import type { ScriptRunner } from "./redis-store";

/**
 * One runner at a time, per envelope.
 *
 * Request ids stop two runs from sending the same request. They do not stop two runs from
 * working on the same batch at once, and that breaks two promises: a run that is refused a
 * request could write over the results of the run that sent it, and a run could go on
 * sending after another run's request had failed.
 *
 * So a paid run first takes a lease on the envelope, and only then reads the store and makes
 * its plan. The lease lives next to the spend counter, in the same Redis, so it holds across
 * terminals, checkouts and machines that share that counter. It has a time limit and is
 * renewed before every request: a run that crashes stops renewing, and the lease frees
 * itself. Taking, renewing and releasing are each one atomic script, so two runs can never
 * both hold it, and a run can only renew or release a lease that is still its own.
 */
export interface RunLock {
  /** Take the lease. Null when another run holds it. */
  acquire(): Promise<RunLease | null>;
}

export interface RunLease {
  /** Keep the lease for another term. False when it is no longer this run's: the run must send nothing more. */
  renew(): Promise<boolean>;
  /** Give the lease up, if it is still this run's. */
  release(): Promise<void>;
}

/** How long a lease lasts without being renewed. Longer than any one request can take. */
export const RUN_LEASE_MS = 120_000;

/** A lock inside one process. Tests use it, and it is the default when no other is given. */
export function memoryRunLock(): RunLock {
  let owner: string | null = null;
  return {
    acquire: async () => {
      if (owner !== null) return null;
      const token = randomUUID();
      owner = token;
      return {
        renew: async () => owner === token,
        release: async () => {
          if (owner === token) owner = null;
        },
      };
    },
  };
}

const ACQUIRE = "if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 else return 0 end";
const RENEW = "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]) return 1 else return 0 end";
const RELEASE = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

/** The lease kept in Redis under `key`. It expires after `ttlMs` unless renewed. */
export function redisRunLock(redis: ScriptRunner, key: string, options: { ttlMs?: number } = {}): RunLock {
  const ttl = String(options.ttlMs ?? RUN_LEASE_MS);
  return {
    acquire: async () => {
      const token = randomUUID();
      if (Number(await redis.eval(ACQUIRE, [key], [token, ttl])) !== 1) return null;
      return {
        renew: async () => Number(await redis.eval(RENEW, [key], [token, ttl])) === 1,
        release: async () => {
          await redis.eval(RELEASE, [key], [token]);
        },
      };
    },
  };
}
