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
}

export type ReserveResult =
  | { ok: true; duplicate: false; totals: EnvelopeTotals }
  /** This attempt id was already admitted. The caller must not send it again. */
  | { ok: true; duplicate: true; state: AttemptState; totals: EnvelopeTotals }
  | { ok: false; reason: "limit"; totals: EnvelopeTotals };

export interface SettleResult {
  /** False when the attempt was already settled; the totals did not change. */
  applied: boolean;
  /** True when the real cost was above the hold. The real cost is still charged. */
  overHold: boolean;
  totals: EnvelopeTotals;
}

export interface SpendStore {
  /**
   * Atomically: if committed + amount <= limit, record the hold and admit the attempt.
   * Check and write happen as one step, so concurrent callers cannot both squeeze in.
   */
  reserve(args: { envelope: string; attemptId: string; amountNano: number; limitNano: number }): Promise<ReserveResult>;
  /** Replace an attempt's hold with its real cost. Only the first settlement counts. */
  settle(args: { envelope: string; attemptId: string; actualNano: number }): Promise<SettleResult>;
  /** Mark an attempt's outcome as unknown. Its full hold stays charged. */
  retain(args: { envelope: string; attemptId: string }): Promise<EnvelopeTotals>;
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

  private attemptsOf(envelope: string): Map<string, Attempt> {
    let attempts = this.envelopes.get(envelope);
    if (!attempts) this.envelopes.set(envelope, (attempts = new Map()));
    return attempts;
  }

  private sum(envelope: string): EnvelopeTotals {
    const t = { settledNano: 0, heldNano: 0, retainedNano: 0, committedNano: 0, attempts: 0 };
    for (const a of this.attemptsOf(envelope).values()) {
      t.attempts++;
      if (a.state === "settled") t.settledNano += a.chargedNano;
      else if (a.state === "reserved") t.heldNano += a.holdNano;
      else t.retainedNano += a.holdNano;
    }
    t.committedNano = t.settledNano + t.heldNano + t.retainedNano;
    return t;
  }

  async reserve(args: { envelope: string; attemptId: string; amountNano: number; limitNano: number }): Promise<ReserveResult> {
    assertAmount(args.amountNano, "amountNano");
    assertAmount(args.limitNano, "limitNano");
    const attempts = this.attemptsOf(args.envelope);
    const existing = attempts.get(args.attemptId);
    if (existing) return { ok: true, duplicate: true, state: existing.state, totals: this.sum(args.envelope) };

    const before = this.sum(args.envelope);
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
      return { applied: false, overHold: false, totals: this.sum(args.envelope) };
    }
    const overHold = args.actualNano > attempt.holdNano;
    attempt.state = "settled";
    attempt.chargedNano = args.actualNano;
    return { applied: true, overHold, totals: this.sum(args.envelope) };
  }

  async retain(args: { envelope: string; attemptId: string }): Promise<EnvelopeTotals> {
    const attempt = this.attemptsOf(args.envelope).get(args.attemptId);
    if (!attempt) throw new Error(`unknown attempt ${args.attemptId} in envelope ${args.envelope}`);
    if (attempt.state === "reserved") attempt.state = "retained";
    return this.sum(args.envelope);
  }

  async totals(envelope: string): Promise<EnvelopeTotals> {
    return this.sum(envelope);
  }
}
