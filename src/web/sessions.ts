import type { Session } from "../game/session";

/**
 * A session as the server keeps it: the game's own state, and what the web needs around it.
 *
 * The session's id is a locator. It appears in the path, in views, and in the ids of the
 * model requests the session makes, which are written to the spend store and its trace. So it
 * must not be a credential, and it is not: what proves a request may touch a session is the
 * visitor's secret, which travels only in a cookie the page's scripts cannot read, and of
 * which only a hash is kept here.
 */
export interface SessionRecord {
  session: Session;
  /** The hash of the visitor secret that started it. Only that visitor may read or play it. */
  owner: string;
  /** Rises by one each time the session is changed and kept. A page acts on the revision it was last shown. */
  revision: number;
  /** Decided when the session starts and never raised: a session that began with the model off stays off. */
  mode: "off" | "live";
  /** Which version of the case this session is playing. A case that changes ends its sessions. */
  caseVersion: string;
  /**
   * The public handles of topics and inspections: an entry's place in the list, plus one, is
   * its number (T1, I1 …). A thing gets its place the first time it is open to the player
   * and keeps it, so a number says nothing about what is still locked.
   */
  topics: string[];
  inspections: string[];
  createdAt: number;
}

/**
 * Where sessions are kept. Its one rule is that a session's requests run one at a time. Two
 * clicks, or two tabs, must not both take "the next action": they could spend two actions,
 * or send the model two requests for one question. A request that arrives while another is
 * at work on the same session is told so and does nothing. It is not queued.
 */
export interface SessionStore {
  /** Keep a new session. False when there is no room and nothing can be dropped to make some. */
  create(record: SessionRecord): Promise<boolean>;
  /** The record as it was last kept, or null. A read does not wait for a request that is at work. */
  read(id: string): Promise<SessionRecord | null>;
  /**
   * Run `work` on a record, alone, and keep the record it returns. If `work` throws, nothing
   * is kept and the error is passed on.
   */
  update<T>(id: string, work: (record: SessionRecord) => Promise<{ record: SessionRecord; value: T }>): Promise<{ ok: true; value: T } | { ok: false; why: "missing" | "busy" }>;
}

/** The most sessions the in-memory store keeps. The oldest idle one makes room for a new one. */
export const MAX_SESSIONS = 500;
/** How long a session is kept. After that it is gone, and its id answers like one that never was. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

/** Sessions in this process's memory. For local play and tests; they are gone when the server stops. */
export function memorySessions(options: { max?: number; ttlMs?: number; now?: () => number } = {}): SessionStore {
  const max = options.max ?? MAX_SESSIONS;
  const ttl = options.ttlMs ?? SESSION_TTL_MS;
  const now = options.now ?? Date.now;
  // A Map keeps insertion order, so the first key is the oldest.
  const kept = new Map<string, SessionRecord>();
  const busy = new Set<string>();
  const live = (id: string): SessionRecord | undefined => {
    const record = kept.get(id);
    if (!record) return undefined;
    if (now() - record.createdAt < ttl || busy.has(id)) return record;
    kept.delete(id);
    return undefined;
  };
  return {
    create: async (record) => {
      for (const id of [...kept.keys()]) live(id);
      if (kept.size >= max) {
        const oldest = [...kept.keys()].find((id) => !busy.has(id));
        // Every session is at work: none may be dropped, so the new one is not kept.
        if (oldest === undefined) return false;
        kept.delete(oldest);
      }
      kept.set(record.session.id, record);
      return true;
    },
    read: async (id) => live(id) ?? null,
    update: async (id, work) => {
      const record = live(id);
      if (!record) return { ok: false, why: "missing" };
      if (busy.has(id)) return { ok: false, why: "busy" };
      busy.add(id);
      try {
        const done = await work(record);
        // Still there: a session that was dropped while this ran stays dropped.
        if (kept.has(id)) kept.set(id, done.record);
        return { ok: true, value: done.value };
      } finally {
        busy.delete(id);
      }
    },
  };
}
