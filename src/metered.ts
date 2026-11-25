import { MODEL, TIER_LIMIT_TOKENS, costNano, worstCaseNano } from "./spend/pricing";
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

/**
 * The encoded body may not be larger than this. It keeps every request far below the
 * 200K-token line where the price triples. This is a margin, not a proof: see `bound` below.
 */
export const MAX_PAYLOAD_BYTES = 50_000;
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
}

export type RefusalReason =
  | "bad-request"
  | "bad-output-limit"
  | "effort-not-allowed"
  | "payload-too-large"
  | "kill-switch"
  | "envelope-exhausted"
  | "envelope-suspended"
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
 *   3. Reserve the worst case. Refuse if the envelope cannot cover it or is suspended.
 *   4. Check the kill switch again. A request that waited on the store must not slip past a
 *      switch that was thrown meanwhile.
 *   5. Send the body once.
 *   6. Settle with the real cost. If the reply has no usable usage block, or anything failed
 *      after sending began, the full hold stays charged for good.
 *
 * `bound`: the hold assumes the input is under 200K tokens. That cannot be proven before
 * sending, so it is checked after: if a reply reports more input tokens than the guard
 * assumed possible, or a cost above the hold, the envelope is suspended at once.
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
    const holdNano = worstCaseNano(maxOutputTokens);

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
      reserved = await deps.store.reserve({ envelope: deps.envelope, attemptId, amountNano: holdNano, limitNano: deps.limitNano });
    } catch {
      return refuse("store-unavailable");
    }
    if (!reserved.ok) return refuse(reserved.reason === "suspended" ? "envelope-suspended" : "envelope-exhausted");
    if (reserved.duplicate) return refuse("duplicate-attempt");

    /** Nothing has left this machine, so the hold can be settled at zero. If that fails, the hold stays. */
    const standDown = async (reason: RefusalReason): Promise<MeteredResult> => {
      let committedNano: number | undefined;
      try {
        committedNano = (await deps.store.settle({ envelope: deps.envelope, attemptId, actualNano: 0 })).totals.committedNano;
      } catch {
        // Still reserved in the store, which is the safe side.
      }
      emit({ outcome: "not-sent", holdNano, costNano: 0, ...(committedNano !== undefined ? { committedNano } : {}) });
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
      emit({ outcome: "retained", holdNano, costNano: holdNano, ...(committedNano !== undefined ? { committedNano } : {}) });
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
    if (response.usage.inputTokens > TIER_LIMIT_TOKENS) {
      breaches.push(`${response.usage.inputTokens} input tokens is above the ${TIER_LIMIT_TOKENS} the hold assumed`);
    }
    if (cost > holdNano) breaches.push(`cost ${cost} is above the hold ${holdNano}`);

    let committedNano: number | undefined;
    let settled = false;
    try {
      const result = await deps.store.settle({ envelope: deps.envelope, attemptId, actualNano: cost });
      committedNano = result.totals.committedNano;
      settled = true;
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
