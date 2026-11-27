import type { Session } from "../game/session";

/**
 * Where sessions are kept, on the server.
 *
 * A session id is random and is the only credential: whoever has it can play that session,
 * and nobody else can see it. The store's one rule is that a session's requests run one at a
 * time. Two clicks, or two tabs, must not both take "the next action": they could spend two
 * actions, or send the model two requests for one question. A request that arrives while
 * another is at work on the same session is told so and does nothing. It is not queued: the
 * page can ask again.
 */
export interface SessionStore {
  /** Keep a new session. */
  create(session: Session): Promise<void>;
  /** The session as it stands, or null. A read does not wait for a request that is at work. */
  read(id: string): Promise<Session | null>;
  /**
   * Run `work` on a session, alone, and keep the session it returns. If `work` throws,
   * nothing is kept and the error is passed on.
   */
  update<T>(id: string, work: (session: Session) => Promise<{ session: Session; value: T }>): Promise<{ ok: true; value: T } | { ok: false; why: "missing" | "busy" }>;
}

/** The most sessions the in-memory store keeps. The oldest idle one makes room for a new one. */
export const MAX_SESSIONS = 500;

/** Sessions in this process's memory. For local play and tests; they are gone when the server stops. */
export function memorySessions(options: { max?: number } = {}): SessionStore {
  const max = options.max ?? MAX_SESSIONS;
  // A Map keeps insertion order, so the first key is the oldest.
  const kept = new Map<string, Session>();
  const busy = new Set<string>();
  return {
    create: async (session) => {
      if (kept.size >= max) {
        const oldest = [...kept.keys()].find((id) => !busy.has(id));
        if (oldest !== undefined) kept.delete(oldest);
      }
      kept.set(session.id, session);
    },
    read: async (id) => kept.get(id) ?? null,
    update: async (id, work) => {
      const session = kept.get(id);
      if (!session) return { ok: false, why: "missing" };
      if (busy.has(id)) return { ok: false, why: "busy" };
      busy.add(id);
      try {
        const done = await work(session);
        // Still there: a session that was dropped to make room while this ran stays dropped.
        if (kept.has(id)) kept.set(id, done.session);
        return { ok: true, value: done.value };
      } finally {
        busy.delete(id);
      }
    },
  };
}
