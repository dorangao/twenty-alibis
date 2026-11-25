import type { Metered, MeteredRequest } from "../metered";
import type { ProviderResponse, ToolCall } from "../provider/types";

/** What later steps of a batch may need from earlier replies. */
export interface TrialContext {
  calls: Record<string, ToolCall | undefined>;
  skeleton?: string | undefined;
}

export interface TrialStep {
  n: number;
  /** What the request is for, in English and Simplified Chinese. */
  what: [en: string, zh: string];
  /** Returns null when the step cannot be built: an earlier step did not give what it needs. */
  build(ctx: TrialContext): Omit<MeteredRequest, "attemptId"> | null;
  after?(response: ProviderResponse, ctx: TrialContext): void;
}

/**
 * What happened to one request. Only "ok" is a clean result.
 *   ok           sent, cost confirmed by the store, and the reply is usable
 *   truncated    sent and confirmed, but the reply was cut off or empty: the cost is real, the result is not usable
 *   unconfirmed  sent and priced, but the store did not confirm the settlement, or the envelope was suspended
 *   failed       sent, outcome unknown: its full hold stays charged
 *   refused      not sent
 *   earlier      not sent now: this id went out in an earlier run
 *   skipped      not sent: it needs the reply of a step that did not produce one in this run
 *   not-reached  not sent: the run stopped before it
 */
export type TrialOutcome = "ok" | "truncated" | "unconfirmed" | "failed" | "refused" | "earlier" | "skipped" | "not-reached";

export interface TrialRow {
  id: string;
  step: string;
  outcome: TrialOutcome;
  detail: string;
  ms?: number;
  input?: number;
  cached?: number;
  output?: number;
  reasoning?: number | undefined;
  /** Set whenever the request was priced, usable or not: a truncated reply still cost money. */
  costNano?: number;
  response?: ProviderResponse;
}

export interface TrialReport {
  rows: TrialRow[];
  /** True only when every step was sent in this run, confirmed, and gave a usable reply. */
  complete: boolean;
  /** Cost of every request priced in this run, including truncated and unconfirmed ones. */
  pricedNano: number;
}

/**
 * Run a fixed list of requests, one after another.
 *
 * - A request that fails, is refused, or whose cost is not confirmed stops the batch.
 * - A reply that is cut off is recorded with its cost and the batch goes on, but a later
 *   step that needed that reply is skipped rather than built from nothing.
 * - An id that already went out in an earlier run is not sent again, and anything that
 *   depended on its reply is skipped. Such a run is reported as incomplete, never as a success.
 */
export async function runBatch(args: {
  metered: Metered;
  steps: TrialStep[];
  idOf: (n: number) => string;
  onRow?: (step: TrialStep, row: TrialRow) => void;
  now?: () => number;
}): Promise<TrialReport> {
  const now = args.now ?? Date.now;
  const rows: TrialRow[] = [];
  const ctx: TrialContext = { calls: {} };
  let stopped = false;

  const record = (step: TrialStep, row: TrialRow) => {
    rows.push(row);
    args.onRow?.(step, row);
  };

  for (const s of args.steps) {
    const id = args.idOf(s.n);
    if (stopped) {
      record(s, { id, step: "-", outcome: "not-reached", detail: "" });
      continue;
    }
    const built = s.build(ctx);
    if (!built) {
      record(s, { id, step: "-", outcome: "skipped", detail: "" });
      continue;
    }
    const started = now();
    const result = await args.metered({ ...built, attemptId: id });
    const ms = now() - started;

    if (!result.ok) {
      if (!result.sent && result.reason === "duplicate-attempt") {
        record(s, { id, step: built.step, outcome: "earlier", detail: "" });
        continue;
      }
      const detail = result.sent && result.error ? `${result.reason}: ${String((result.error as Error).message ?? result.error).slice(0, 300)}` : result.reason;
      record(s, { id, step: built.step, outcome: result.sent ? "failed" : "refused", detail, ms });
      stopped = true;
      continue;
    }

    const response = result.response;
    const u = response.usage!;
    const usable = response.finishReason !== "length" && (response.toolCalls.length > 0 || Boolean(response.text));
    const confirmed = result.settled && !result.breached;
    const outcome: TrialOutcome = !confirmed ? "unconfirmed" : usable ? "ok" : "truncated";
    const detail = result.breached
      ? "the envelope was suspended"
      : !result.settled
        ? "the store did not confirm the settlement"
        : usable
          ? ""
          : `finish ${response.finishReason ?? "?"}, no usable reply`;
    record(s, { id, step: built.step, outcome, detail, ms, input: u.inputTokens, cached: u.cachedTokens, output: u.outputTokens, reasoning: u.reasoningTokens, costNano: result.costNano, response });
    if (!confirmed) stopped = true;
    else if (usable) s.after?.(response, ctx);
  }

  return {
    rows,
    complete: rows.length > 0 && rows.every((r) => r.outcome === "ok"),
    pricedNano: rows.reduce((sum, r) => sum + (r.costNano ?? 0), 0),
  };
}
