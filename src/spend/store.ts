/**
 * The spend store: the one place that decides whether a request may be sent.
 *
 * Every attempt is in one of three states:
 *   reserved  - admitted and in flight; its worst case is held
 *   settled   - finished with a known cost; the hold is replaced by the real amount
 *   retained  - the outcome is unknown (timeout, crash, no usage block); the full hold stays
 *
 * Nothing ever releases a hold on a timer. A hold leaves only by being settled.
 */
export type AttemptState = "reserved" | "settled" | "retained";

export interface EnvelopeTotals {
  /** Known cost of finished attempts. */
  settledNano: number;
  /** Holds for attempts still in flight. */
  heldNano: number;
  /** Holds kept for attempts whose outcome is unknown. */
  retainedNano: number;
  /** settled + held + retained: what the envelope must assume is spent. */
  committedNano: number;
  attempts: number;
  /** Why the envelope admits nothing, or null when it is open. Only an operator clears it. */
  suspended: string | null;
  /** The operator's note authorizing paid requests from this envelope, or null when none are allowed. */
  paidAllowed: string | null;
}

export type ReserveResult =
  | { ok: true; duplicate: false; totals: EnvelopeTotals }
  /** This attempt id was already admitted. The caller must not send it again. */
  | { ok: true; duplicate: true; state: AttemptState; totals: EnvelopeTotals }
  | { ok: false; reason: "limit" | "suspended" | "paid-not-enabled"; totals: EnvelopeTotals };

export interface SettleResult {
  /** False when the attempt was already settled; the totals did not change. */
  applied: boolean;
  /** What the store has on record for this attempt after the call. */
  chargedNano: number;
  /**
   * True when the attempt was already settled at a different amount. The first amount stays,
   * and the envelope is suspended in the same step: two sources disagree about what a request
   * cost, and a person has to say which is right.
   */
  mismatch: boolean;
  /**
   * True when the real cost was above the hold. The real cost is still charged, and the
   * envelope is suspended in the same step: a hold that failed to bound a charge means the
   * guard's arithmetic is wrong, and nothing more may be sent until a person has looked.
   */
  overHold: boolean;
  totals: EnvelopeTotals;
}

export interface ReserveArgs {
  envelope: string;
  attemptId: string;
  amountNano: number;
  limitNano: number;
  /**
   * True when the request would spend real money. It is then admitted only if an operator
   * has authorized paid requests on this envelope. The check is part of the same atomic step.
   */
  billable?: boolean;
}

export interface SpendStore {
  /**
   * Atomically: if committed + amount <= limit, record the hold and admit the attempt.
   * Check and write happen as one step, so concurrent callers cannot both squeeze in.
   */
  reserve(args: ReserveArgs): Promise<ReserveResult>;
  /** Replace an attempt's hold with its real cost. Only the first settlement counts. */
  settle(args: { envelope: string; attemptId: string; actualNano: number }): Promise<SettleResult>;
  /** Mark an attempt's outcome as unknown. Its full hold stays charged. */
  retain(args: { envelope: string; attemptId: string }): Promise<EnvelopeTotals>;
  /** Stop admitting anything from this envelope. Holds and settlements still work. */
  suspend(args: { envelope: string; reason: string }): Promise<EnvelopeTotals>;
  totals(envelope: string): Promise<EnvelopeTotals>;
}

interface Attempt {
  state: AttemptState;
  holdNano: number;
  chargedNano: number;
}

const assertAmount = (n: number, name: string) => {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`${name} must be a non-negative integer of nanodollars`);
};

/**
 * In-memory store for tests and offline runs. Each method runs to completion without
 * awaiting, so on one event loop the check-and-reserve is atomic.
 * The deployed store must give the same guarantees with one transaction per call.
 */
export class MemorySpendStore implements SpendStore {
  private readonly envelopes = new Map<string, Map<string, Attempt>>();
  private readonly suspensions = new Map<string, string>();
  private readonly paid = new Map<string, string>();

  private attemptsOf(envelope: string): Map<string, Attempt> {
    let attempts = this.envelopes.get(envelope);
    if (!attempts) this.envelopes.set(envelope, (attempts = new Map()));
    return attempts;
  }

  private sum(envelope: string): EnvelopeTotals {
    const t: EnvelopeTotals = { settledNano: 0, heldNano: 0, retainedNano: 0, committedNano: 0, attempts: 0, suspended: this.suspensions.get(envelope) ?? null, paidAllowed: this.paid.get(envelope) ?? null };
    for (const a of this.attemptsOf(envelope).values()) {
      t.attempts++;
      if (a.state === "settled") t.settledNano += a.chargedNano;
      else if (a.state === "reserved") t.heldNano += a.holdNano;
      else t.retainedNano += a.holdNano;
    }
    t.committedNano = t.settledNano + t.heldNano + t.retainedNano;
    return t;
  }

  async reserve(args: ReserveArgs): Promise<ReserveResult> {
    assertAmount(args.amountNano, "amountNano");
    assertAmount(args.limitNano, "limitNano");
    const attempts = this.attemptsOf(args.envelope);
    const existing = attempts.get(args.attemptId);
    if (existing) return { ok: true, duplicate: true, state: existing.state, totals: this.sum(args.envelope) };

    const before = this.sum(args.envelope);
    if (before.suspended !== null) return { ok: false, reason: "suspended", totals: before };
    if (args.billable && before.paidAllowed === null) return { ok: false, reason: "paid-not-enabled", totals: before };
    if (before.committedNano + args.amountNano > args.limitNano) {
      return { ok: false, reason: "limit", totals: before };
    }
    attempts.set(args.attemptId, { state: "reserved", holdNano: args.amountNano, chargedNano: 0 });
    return { ok: true, duplicate: false, totals: this.sum(args.envelope) };
  }

  async settle(args: { envelope: string; attemptId: string; actualNano: number }): Promise<SettleResult> {
    assertAmount(args.actualNano, "actualNano");
    const attempt = this.attemptsOf(args.envelope).get(args.attemptId);
    if (!attempt) throw new Error(`unknown attempt ${args.attemptId} in envelope ${args.envelope}`);
    if (attempt.state === "settled") {
      const mismatch = attempt.chargedNano !== args.actualNano;
      if (mismatch && !this.suspensions.has(args.envelope)) {
        this.suspensions.set(args.envelope, `attempt ${args.attemptId} is settled at ${attempt.chargedNano} but a second settlement says ${args.actualNano}`);
      }
      return { applied: false, chargedNano: attempt.chargedNano, mismatch, overHold: false, totals: this.sum(args.envelope) };
    }
    const overHold = args.actualNano > attempt.holdNano;
    attempt.state = "settled";
    attempt.chargedNano = args.actualNano;
    if (overHold && !this.suspensions.has(args.envelope)) {
      this.suspensions.set(args.envelope, `attempt ${args.attemptId} cost ${args.actualNano}, above its hold of ${attempt.holdNano}`);
    }
    return { applied: true, chargedNano: args.actualNano, mismatch: false, overHold, totals: this.sum(args.envelope) };
  }

  async retain(args: { envelope: string; attemptId: string }): Promise<EnvelopeTotals> {
    const attempt = this.attemptsOf(args.envelope).get(args.attemptId);
    if (!attempt) throw new Error(`unknown attempt ${args.attemptId} in envelope ${args.envelope}`);
    if (attempt.state === "reserved") attempt.state = "retained";
    return this.sum(args.envelope);
  }

  async suspend(args: { envelope: string; reason: string }): Promise<EnvelopeTotals> {
    // The first reason is the one worth keeping.
    if (!this.suspensions.has(args.envelope)) this.suspensions.set(args.envelope, args.reason || "suspended");
    return this.sum(args.envelope);
  }

  /** Operator action: allow requests that spend real money. The note says on whose word. */
  async allowPaid(args: { envelope: string; note: string }): Promise<EnvelopeTotals> {
    if (!args.note.trim()) throw new Error("allowing paid requests needs a note saying who authorized it");
    this.paid.set(args.envelope, args.note.trim());
    return this.sum(args.envelope);
  }

  /** Operator action: stop allowing paid requests. */
  async revokePaid(envelope: string): Promise<EnvelopeTotals> {
    this.paid.delete(envelope);
    return this.sum(envelope);
  }

  /** Operator action: admit requests again. */
  async resume(envelope: string): Promise<EnvelopeTotals> {
    this.suspensions.delete(envelope);
    return this.sum(envelope);
  }

  async totals(envelope: string): Promise<EnvelopeTotals> {
    return this.sum(envelope);
  }
}
