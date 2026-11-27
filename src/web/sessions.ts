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
  /**
   * The number of a question that has begun and whose result is not kept yet. It is written
   * down before the question's first request to the model, and removed when the result is
   * kept. If it is still there when nobody is at work on the session, that work was lost: the
   * server stopped between sending and keeping. The game then stands where it stood, the
   * question's requests may have been charged, and its number is never used again.
   */
  inFlight?: number;
  /**
   * How many questions were begun and never finished. What their requests cost, if anything,
   * is counted by the spend guard and is in no turn of this session.
   */
  lost?: number;
}

/**
 * What a piece of work is handed besides the record: its hold on the session. Both calls
 * reject when the work no longer holds it, because another worker has taken the session or
 * because the session is gone. The work must then send nothing more.
 */
export interface Hold {
  /** Keep a record now, in the middle of the work, without ending the work. */
  save(record: SessionRecord): Promise<void>;
  /** Make sure this work still holds the session. Asked before each further request to the model. */
  check(): Promise<void>;
}

/** Thrown inside a piece of work when its session ran out or was dropped while it was at work. */
export class SessionGoneError extends Error {
  override readonly name = "SessionGoneError";
  constructor() {
    super("the session is gone");
  }
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
  /**
   * The record as it was last kept, or null, and whether a request is at work on it right
   * now. A read does not wait for that request.
   */
  read(id: string): Promise<{ record: SessionRecord; busy: boolean } | null>;
  /**
   * Run `work` on a record, alone, and keep the record it returns. If `work` throws, nothing
   * more is kept and the error is passed on.
   *
   * `work` is also handed its hold on the session. `hold.save` keeps a record at once, while
   * the work goes on: the API uses it to write down that a question has begun before the
   * first request for it is sent. What it kept stays kept even if the work never finishes.
   * `hold.check` says whether the work still holds the session.
   *
   * "expired": the session ran out while this work was on it. Nothing more is kept, and the
   * work's answer is not given: it would describe a game that can no longer be read.
   *
   * `owner` is checked first, before anything else is said: to anyone but its owner a session
   * is "missing", whether or not it exists and whether or not it is at work. Only its owner
   * can learn that it is busy.
   */
  update<T>(
    id: string,
    owner: string,
    work: (record: SessionRecord, hold: Hold) => Promise<{ record: SessionRecord; value: T }>,
  ): Promise<{ ok: true; value: T } | { ok: false; why: "missing" | "busy" | "expired" }>;
}

/**
 * The most sessions the in-memory store keeps. When it is full, room is made only from games
 * that are over: one that has expired, or one that has ended with an accusation. A game
 * someone is still playing is never dropped to make room, however long they have been
 * thinking; the new session is refused instead.
 */
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
      // Expired sessions go first.
      for (const id of [...kept.keys()]) live(id);
      if (kept.size >= max) {
        // Then the oldest game that has ended. An unfinished game is never dropped.
        const finished = [...kept.entries()].find(([id, r]) => r.session.verdict !== undefined && !busy.has(id));
        if (finished === undefined) return false;
        kept.delete(finished[0]);
      }
      kept.set(record.session.id, record);
      return true;
    },
    read: async (id) => {
      const record = live(id);
      return record ? { record, busy: busy.has(id) } : null;
    },
    update: async (id, owner, work) => {
      const record = live(id);
      // Not there, or not theirs: the same answer, given before "busy" could tell them apart.
      if (!record || record.owner !== owner) return { ok: false, why: "missing" };
      if (busy.has(id)) return { ok: false, why: "busy" };
      busy.add(id);
      try {
        // A session whose time ran out while this was at work is gone, like one that was dropped.
        const here = (): void => {
          if (!kept.has(id) || now() - record.createdAt >= ttl) throw new SessionGoneError();
        };
        const done = await work(record, {
          save: async (next) => {
            here();
            kept.set(id, next);
          },
          check: async () => here(),
        });
        here();
        kept.set(id, done.record);
        return { ok: true, value: done.value };
      } catch (error) {
        if (!(error instanceof SessionGoneError)) throw error;
        kept.delete(id);
        return { ok: false, why: "expired" };
      } finally {
        busy.delete(id);
      }
    },
  };
}
