import { MODEL, costNano, worstCaseNano } from "./spend/pricing";
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

/** A request body larger than this is refused. It keeps every request far inside the low price tier. */
export const MAX_PAYLOAD_BYTES = 50_000;
/** No role may ask for more output than this in one request. */
export const MAX_OUTPUT_TOKENS_CEILING = 32_000;

export interface MeteredRequest {
  /** Which part of the game is asking, e.g. "suspect.answer". Goes in the trace. */
  step: string;
  /** Which prompt template was used. Goes in the trace instead of the prompt text. */
  promptId: string;
  /**
   * An id for this physical attempt. Reusing an id never sends a second request, so a client
   * that repeats an action cannot be billed twice. Omit it to get a fresh id.
   */
  attemptId?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  responseSchema?: { name: string; schema: Record<string, unknown> };
  maxOutputTokens: number;
  /** Defaults to "low". The API's own default is "max". */
  reasoningEffort?: ReasoningEffort;
}

export type RefusalReason =
  | "kill-switch"
  | "payload-too-large"
  | "bad-output-limit"
  | "envelope-exhausted"
  | "duplicate-attempt"
  | "store-unavailable"
  | "not-dispatched";

export type MeteredResult =
  | { ok: true; attemptId: string; response: ProviderResponse; costNano: number }
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
  outcome: "settled" | "retained" | "not-sent" | `refused:${RefusalReason}`;
  holdNano: number;
  costNano: number;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  /** What the envelope must assume is spent after this event. */
  committedNano?: number;
}

export interface MeteredDeps {
  provider: Provider;
  store: SpendStore;
  /** Which budget this process draws from, e.g. "local" or "deployed". */
  envelope: string;
  limitNano: number;
  /** Checked before every dispatch. When it returns true, nothing is sent. */
  killSwitch?: () => boolean | Promise<boolean>;
  trace?: (event: TraceEvent) => void;
  newAttemptId?: () => string;
  now?: () => Date;
}

const payloadBytes = (r: Pick<ProviderRequest, "messages" | "tools" | "responseSchema">) =>
  new TextEncoder().encode(JSON.stringify([r.messages, r.tools ?? null, r.responseSchema ?? null])).length;

/**
 * The only way a model request leaves this program.
 *
 * Order of operations, for every physical request:
 *   1. refuse if the kill switch is on, the body is too large, or the output limit is missing
 *   2. reserve the worst case in the store; refuse if the envelope cannot cover it
 *   3. send exactly once (no retries here, and providers must not retry either)
 *   4. settle with the real cost from the usage block
 * If step 3 ends without a usage block, the full hold stays charged for good.
 */
export function createMetered(deps: MeteredDeps) {
  const now = deps.now ?? (() => new Date());
  const newAttemptId = deps.newAttemptId ?? (() => crypto.randomUUID());

  return async function metered(request: MeteredRequest): Promise<MeteredResult> {
    const attemptId = request.attemptId ?? newAttemptId();
    const reasoningEffort = request.reasoningEffort ?? "low";
    const base = {
      attemptId,
      envelope: deps.envelope,
      step: request.step,
      promptId: request.promptId,
      model: MODEL,
      reasoningEffort,
      maxOutputTokens: request.maxOutputTokens,
    };
    const emit = (event: Omit<TraceEvent, keyof typeof base | "at">) =>
      deps.trace?.({ at: now().toISOString(), ...base, ...event });
    const refuse = (reason: RefusalReason): MeteredResult => {
      emit({ outcome: `refused:${reason}`, holdNano: 0, costNano: 0 });
      return { ok: false, attemptId, sent: false, reason };
    };

    // 1. Checks that need no store.
    const validLimit =
      Number.isInteger(request.maxOutputTokens) &&
      request.maxOutputTokens > 0 &&
      request.maxOutputTokens <= MAX_OUTPUT_TOKENS_CEILING;
    if (!validLimit) return refuse("bad-output-limit");
    if (payloadBytes(request) > MAX_PAYLOAD_BYTES) return refuse("payload-too-large");
    try {
      if (deps.killSwitch && (await deps.killSwitch())) return refuse("kill-switch");
    } catch {
      return refuse("kill-switch"); // cannot read the switch: assume it is on
    }

    // 2. Reserve. If the store cannot answer, nothing is sent.
    const holdNano = worstCaseNano(request.maxOutputTokens);
    let reserved;
    try {
      reserved = await deps.store.reserve({
        envelope: deps.envelope,
        attemptId,
        amountNano: holdNano,
        limitNano: deps.limitNano,
      });
    } catch {
      return refuse("store-unavailable");
    }
    if (!reserved.ok) return refuse("envelope-exhausted");
    if (reserved.duplicate) return refuse("duplicate-attempt");

    // 3. Send once.
    const providerRequest: ProviderRequest = {
      model: MODEL,
      messages: request.messages,
      maxOutputTokens: request.maxOutputTokens,
      reasoningEffort,
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.responseSchema ? { responseSchema: request.responseSchema } : {}),
    };
    let response: ProviderResponse;
    try {
      response = await deps.provider.complete(providerRequest);
    } catch (error) {
      if (error instanceof NotDispatchedError) {
        // The provider is certain nothing left the machine, so the hold can be settled at zero.
        let committedNano: number | undefined;
        try {
          committedNano = (await deps.store.settle({ envelope: deps.envelope, attemptId, actualNano: 0 })).totals.committedNano;
        } catch {
          // The hold stays in the store, which is the safe side.
        }
        emit({ outcome: "not-sent", holdNano, costNano: 0, ...(committedNano !== undefined ? { committedNano } : {}) });
        return { ok: false, attemptId, sent: false, reason: "not-dispatched" };
      }
      return keepHold(error);
    }

    // 4. Settle with the real cost. No usage block means the cost is unknown.
    if (!response.usage) return keepHold(undefined);
    let cost: number;
    try {
      cost = costNano(response.usage);
    } catch (error) {
      return keepHold(error); // a usage block we cannot price is treated as unknown
    }
    let committedNano: number | undefined;
    try {
      committedNano = (await deps.store.settle({ envelope: deps.envelope, attemptId, actualNano: cost })).totals.committedNano;
    } catch {
      // The store still holds the worst case for this attempt, which is the safe side.
    }
    emit({
      outcome: "settled",
      holdNano,
      costNano: cost,
      inputTokens: response.usage.inputTokens,
      cachedTokens: response.usage.cachedTokens,
      outputTokens: response.usage.outputTokens,
      ...(response.usage.reasoningTokens !== undefined ? { reasoningTokens: response.usage.reasoningTokens } : {}),
      ...(committedNano !== undefined ? { committedNano } : {}),
    });
    return { ok: true, attemptId, response, costNano: cost };

    async function keepHold(error: unknown): Promise<MeteredResult> {
      let committedNano: number | undefined;
      try {
        committedNano = (await deps.store.retain({ envelope: deps.envelope, attemptId })).committedNano;
      } catch {
        // Still reserved in the store, so the hold is kept either way.
      }
      emit({ outcome: "retained", holdNano, costNano: holdNano, ...(committedNano !== undefined ? { committedNano } : {}) });
      return { ok: false, attemptId, sent: true, reason: "outcome-unknown", error };
    }
  };
}

export type Metered = ReturnType<typeof createMetered>;
