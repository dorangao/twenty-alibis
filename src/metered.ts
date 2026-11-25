import { MODEL, TIER_LIMIT_TOKENS, absoluteWorstNano, costNano, worstCaseNano } from "./spend/pricing";
import type { SpendStore } from "./spend/store";
import {
  NotDispatchedError,
  type ChatMessage,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
  type ReasoningEffort,
  type ToolSpec,
} from "./provider/types";

/** The encoded body may not be larger than this. */
export const MAX_PAYLOAD_BYTES = 50_000;
/** A measured tokens-per-byte figure is doubled before it is trusted. */
export const BOUND_SAFETY_FACTOR = 2;

/**
 * An upper bound on how many input tokens one byte of body becomes. It is honored only for a
 * provider that spends nothing (tests and offline runs). A request that spends money always
 * holds the full context-window worst case: a ratio measured on some requests is not a
 * maximum for the next one, so it is never allowed to shrink a real hold.
 */
export interface InputBound {
  tokensPerByte: number;
}
/** No role may ask for more output than this in one request. */
export const MAX_OUTPUT_TOKENS_CEILING = 32_000;
/** Reasoning efforts allowed unless the caller of createMetered() widens the list. */
export const DEFAULT_ALLOWED_EFFORTS: readonly ReasoningEffort[] = ["minimal", "low"];

export interface MeteredRequest {
  /** Which part of the game is asking, e.g. "suspect.answer". Goes in the trace. */
  step: string;
  /** Which prompt template was used. Goes in the trace instead of the prompt text. */
  promptId: string;
  /**
   * A stable id for this one physical request, chosen by the caller before it is sent, e.g.
   * "<session>:<turn>:<step>:<n>". If the same action is delivered twice, it carries the same
   * id and is sent once. There is no default: a random id would make every redelivery new.
   */
  attemptId: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  responseSchema?: { name: string; schema: Record<string, unknown> };
  maxOutputTokens: number;
  /** Defaults to "low". The API's own default is "max". */
  reasoningEffort?: ReasoningEffort;
  /** A label for requests that share a prompt prefix, e.g. the case id. No content. */
  cacheKey?: string;
}

export type RefusalReason =
  | "bad-request"
  | "bad-output-limit"
  | "effort-not-allowed"
  | "payload-too-large"
  | "kill-switch"
  | "envelope-exhausted"
  | "envelope-suspended"
  | "paid-not-enabled"
  | "duplicate-attempt"
  | "store-unavailable"
  | "not-dispatched";

export type MeteredResult =
  | {
      ok: true;
      attemptId: string;
      response: ProviderResponse;
      costNano: number;
      /** False when the store did not confirm the settlement. The full hold then stays charged. */
      settled: boolean;
      /** True when the cost was above the hold, or the input was larger than the guard assumed. The envelope is now suspended. */
      breached: boolean;
    }
  /** Nothing was sent and nothing was charged. */
  | { ok: false; attemptId: string; sent: false; reason: RefusalReason }
  /** The request may have been billed. Its full hold stays charged. */
  | { ok: false; attemptId: string; sent: true; reason: "outcome-unknown"; error?: unknown };

/** One line of the usage trace. It never contains prompt or reply text. */
export interface TraceEvent {
  at: string;
  attemptId: string;
  envelope: string;
  step: string;
  promptId: string;
  model: typeof MODEL;
  reasoningEffort: ReasoningEffort;
  maxOutputTokens: number;
  /** Size of the exact body that was, or would have been, sent. */
  payloadBytes: number;
  /**
   * settled         sent, priced, and the store confirmed the cost
   * settle-pending  sent and priced, but the store did not confirm; the full hold stays
   * retained        sent, outcome or cost unknown; the full hold stays
   * not-sent        admitted, then stopped before anything left this machine
   * refused:<why>   never admitted
   */
  outcome: "settled" | "settle-pending" | "retained" | "not-sent" | `refused:${RefusalReason}`;
  holdNano: number;
  /**
   * What the hold was sized for. "context-window": the most any request can cost at all.
   * "low-tier": a measured bound showed this body stays under the line where the price triples.
   */
  holdBasis?: "context-window" | "low-tier";
  costNano: number;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  /** Set when the guard's own assumptions failed and the envelope was suspended. */
  breach?: string;
  /** What the envelope must assume is spent after this event. */
  committedNano?: number;
}

export interface MeteredDeps {
  provider: Provider;
  store: SpendStore;
  /** Which budget this process draws from, e.g. "local" or "deployed". */
  envelope: string;
  limitNano: number;
  /**
   * Checked before reserving and again immediately before sending. When it returns true, or
   * cannot be read, nothing is sent.
   */
  killSwitch?: () => boolean | Promise<boolean>;
  /** Defaults to minimal and low. Anything else must be allowed here on purpose. */
  allowedEfforts?: readonly ReasoningEffort[];
  /**
   * For a provider that spends nothing only: lets a body that this bound keeps in the low
   * price tier use the smaller low-tier hold. Ignored for a billable provider, which always
   * holds the most a request can ever cost.
   */
  inputBound?: InputBound;
  /** A failing trace sink never changes what is sent or charged. */
  trace?: (event: TraceEvent) => void;
  now?: () => Date;
}

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/**
 * The only way a model request leaves this program.
 *
 * For every physical request, in this order:
 *   1. Before anything else, and before any waiting: copy the request, encode it to the exact
 *      body text, and check that. From here on only that text and those copied numbers are
 *      used, so a caller that changes its objects later changes nothing.
 *   2. Refuse if the kill switch is on.
 *   3. Reserve the worst case. Refuse if the envelope cannot cover it, is suspended, or has
 *      no operator authorization for a request that spends real money.
 *   4. Check the kill switch again. A request that waited on the store must not slip past a
 *      switch that was thrown meanwhile.
 *   5. Send the body once.
 *   6. Settle with the real cost. If the reply has no usable usage block, or anything failed
 *      after sending began, the full hold stays charged for good.
 *
 * How large the hold is: for a request that spends money it is always the most any request
 * can cost (a full context window at the high price plus the whole output limit at the high
 * price). That needs no assumption about how many tokens a body becomes. Only a provider that
 * spends nothing may use a smaller, low-tier hold. Either way the reply is checked: a cost
 * above the hold suspends the envelope at once.
 */
export function createMetered(deps: MeteredDeps) {
  const now = deps.now ?? (() => new Date());
  const allowedEfforts = deps.allowedEfforts ?? DEFAULT_ALLOWED_EFFORTS;

  return async function metered(request: MeteredRequest): Promise<MeteredResult> {
    // ---- 1. Freeze. Everything in this block is synchronous. ----
    const attemptId = typeof request.attemptId === "string" ? request.attemptId : "";
    const step = String(request.step);
    const promptId = String(request.promptId);
    const maxOutputTokens = request.maxOutputTokens;
    const reasoningEffort: ReasoningEffort = request.reasoningEffort ?? "low";

    let body: string | null = null;
    try {
      const snapshot: ProviderRequest = structuredClone({
        model: MODEL,
        messages: request.messages,
        maxOutputTokens,
        reasoningEffort,
        ...(request.tools ? { tools: request.tools } : {}),
        ...(request.responseSchema ? { responseSchema: request.responseSchema } : {}),
        ...(typeof request.cacheKey === "string" && request.cacheKey ? { cacheKey: request.cacheKey } : {}),
      });
      body = deps.provider.encode(snapshot);
    } catch {
      body = null; // not cloneable or not encodable: nothing can be measured, so nothing is sent
    }
    const payloadBytes = body === null ? 0 : utf8Length(body);

    const base = { attemptId, envelope: deps.envelope, step, promptId, model: MODEL, reasoningEffort, maxOutputTokens, payloadBytes };
    const emit = (event: Omit<TraceEvent, keyof typeof base | "at">) => {
      try {
        deps.trace?.({ at: now().toISOString(), ...base, ...event });
      } catch {
        // The trace is a record, not a control. Losing a line must not change the outcome.
      }
    };
    const refuse = (reason: RefusalReason): MeteredResult => {
      emit({ outcome: `refused:${reason}`, holdNano: 0, costNano: 0 });
      return { ok: false, attemptId, sent: false, reason };
    };

    if (body === null || attemptId.length === 0 || attemptId.length > 200) return refuse("bad-request");
    const validLimit = Number.isInteger(maxOutputTokens) && maxOutputTokens > 0 && maxOutputTokens <= MAX_OUTPUT_TOKENS_CEILING;
    if (!validLimit) return refuse("bad-output-limit");
    if (!allowedEfforts.includes(reasoningEffort)) return refuse("effort-not-allowed");
    if (payloadBytes > MAX_PAYLOAD_BYTES) return refuse("payload-too-large");

    // A request that spends money never gets a hold smaller than the full context-window
    // worst case, whatever ratio the caller supplies.
    const bound = deps.provider.billable === true ? undefined : deps.inputBound;
    const usableBound = bound !== undefined && Number.isFinite(bound.tokensPerByte) && bound.tokensPerByte > 0;
    const assumedInputTokens = usableBound ? Math.ceil(payloadBytes * bound.tokensPerByte * BOUND_SAFETY_FACTOR) : null;
    const lowTier = assumedInputTokens !== null && assumedInputTokens <= TIER_LIMIT_TOKENS;
    const holdBasis = lowTier ? ("low-tier" as const) : ("context-window" as const);
    const holdNano = lowTier ? worstCaseNano(maxOutputTokens) : absoluteWorstNano(maxOutputTokens);

    const switchIsOn = async (): Promise<boolean> => {
      if (!deps.killSwitch) return false;
      try {
        return Boolean(await deps.killSwitch());
      } catch {
        return true; // cannot read the switch: assume it is on
      }
    };

    // ---- 2. Kill switch. ----
    if (await switchIsOn()) return refuse("kill-switch");

    // ---- 3. Reserve. If the store cannot answer, nothing is sent. ----
    let reserved;
    try {
      reserved = await deps.store.reserve({
        envelope: deps.envelope,
        attemptId,
        amountNano: holdNano,
        limitNano: deps.limitNano,
        billable: deps.provider.billable === true,
      });
    } catch {
      return refuse("store-unavailable");
    }
    if (!reserved.ok) {
      if (reserved.reason === "suspended") return refuse("envelope-suspended");
      if (reserved.reason === "paid-not-enabled") return refuse("paid-not-enabled");
      return refuse("envelope-exhausted");
    }
    if (reserved.duplicate) return refuse("duplicate-attempt");

    /** Nothing has left this machine, so the hold can be settled at zero. If that fails, the hold stays. */
    const standDown = async (reason: RefusalReason): Promise<MeteredResult> => {
      let committedNano: number | undefined;
      try {
        committedNano = (await deps.store.settle({ envelope: deps.envelope, attemptId, actualNano: 0 })).totals.committedNano;
      } catch {
        // Still reserved in the store, which is the safe side.
      }
      emit({ outcome: "not-sent", holdNano, holdBasis, costNano: 0, ...(committedNano !== undefined ? { committedNano } : {}) });
      return { ok: false, attemptId, sent: false, reason };
    };
    /** Sending began. Whatever happened after, the full hold stays. */
    const keepHold = async (error: unknown): Promise<MeteredResult> => {
      let committedNano: number | undefined;
      try {
        committedNano = (await deps.store.retain({ envelope: deps.envelope, attemptId })).committedNano;
      } catch {
        // Still reserved in the store, so the hold is kept either way.
      }
      emit({ outcome: "retained", holdNano, holdBasis, costNano: holdNano, ...(committedNano !== undefined ? { committedNano } : {}) });
      return { ok: false, attemptId, sent: true, reason: "outcome-unknown", error };
    };

    // ---- 4. Kill switch again, at the last moment before sending. ----
    if (await switchIsOn()) return standDown("kill-switch");

    // ---- 5. Send the frozen body, once. ----
    let response: ProviderResponse;
    try {
      response = await deps.provider.send(body);
    } catch (error) {
      return error instanceof NotDispatchedError ? standDown("not-dispatched") : keepHold(error);
    }

    // ---- 6. Settle. ----
    if (!response.usage) return keepHold(undefined);
    let cost: number;
    try {
      cost = costNano(response.usage);
    } catch (error) {
      return keepHold(error); // a usage block that cannot be priced is an unknown cost
    }

    // Did the guard's own assumptions hold? If not, stop the envelope before anything else goes out.
    const breaches: string[] = [];
    if (lowTier && response.usage.inputTokens > assumedInputTokens) {
      // The measured bound was wrong for this body. Every hold sized with it is suspect.
      breaches.push(`${response.usage.inputTokens} input tokens is above the ${assumedInputTokens} the measured bound allowed`);
    }
    if (cost > holdNano) breaches.push(`cost ${cost} is above the hold ${holdNano}`);
    if (response.usage.outputTokens > maxOutputTokens) {
      // The hold counts on the API honouring the output limit. If it billed more than the
      // limit, that assumption is false even when this one reply still fits its hold.
      breaches.push(`${response.usage.outputTokens} output tokens were billed, above the limit of ${maxOutputTokens}`);
    }

    let committedNano: number | undefined;
    let settled = false;
    try {
      const result = await deps.store.settle({ envelope: deps.envelope, attemptId, actualNano: cost });
      committedNano = result.totals.committedNano;
      if (result.mismatch) {
        // Someone settled this attempt at another amount while it was in flight. The store
        // keeps that amount and has suspended the envelope; this cost is not confirmed.
        breaches.push(`the store already holds ${result.chargedNano} for this attempt, but the reply costs ${cost}`);
      } else {
        settled = true;
      }
      if (result.overHold && !breaches.some((b) => b.startsWith("cost"))) breaches.push(`cost ${cost} is above the hold ${holdNano}`);
    } catch {
      // The store still holds the worst case for this attempt. It is reconciled by id later.
    }
    if (breaches.length > 0) {
      try {
        await deps.store.suspend({ envelope: deps.envelope, reason: `${attemptId}: ${breaches.join("; ")}` });
      } catch {
        // If the store cannot be reached, it cannot admit anything either.
      }
    }
    emit({
      outcome: settled ? "settled" : "settle-pending",
      holdNano,
      holdBasis,
      costNano: cost,
      inputTokens: response.usage.inputTokens,
      cachedTokens: response.usage.cachedTokens,
      outputTokens: response.usage.outputTokens,
      ...(response.usage.reasoningTokens !== undefined ? { reasoningTokens: response.usage.reasoningTokens } : {}),
      ...(breaches.length > 0 ? { breach: breaches.join("; ") } : {}),
      ...(committedNano !== undefined ? { committedNano } : {}),
    });
    return { ok: true, attemptId, response, costNano: cost, settled, breached: breaches.length > 0 };
  };
}

export type Metered = ReturnType<typeof createMetered>;
