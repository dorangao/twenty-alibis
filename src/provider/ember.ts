import type { Usage } from "../spend/pricing";
import {
  NotDispatchedError,
  type ChatMessage,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
  type ToolCall,
} from "./types";

export const EMBER_BASE_URL = "https://api.meta.ai/v1";

/**
 * HTTP statuses that mean the API turned the request away before running the model:
 * a malformed request, a bad or missing key, an unknown route, a body that is too large,
 * or a rate limit. Nothing was generated, so nothing was billed.
 * Every other failure (timeouts, 5xx, a dropped connection, an unreadable body) is treated
 * as "may have been billed" and the spend guard keeps the full hold.
 */
const TURNED_AWAY = new Set([400, 401, 403, 404, 413, 422, 429]);

export class EmberHttpError extends Error {
  override readonly name = "EmberHttpError";
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Meta Model API returned HTTP ${status}: ${detail}`);
  }
}

export interface EmberProviderOptions {
  apiKey: string;
  baseUrl?: string;
  /** A request that runs longer than this is aborted and treated as "may have been billed". */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * The only real model provider: Muse Ember through the Chat Completions endpoint.
 *
 * One call is one HTTP request. There is no retry, no streaming and no stored conversation:
 * everything the model sees is in the request body. Use it only through `createMetered()`.
 */
export class EmberProvider implements Provider {
  readonly name = "ember";
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  readonly #apiKey: string;

  constructor(options: EmberProviderOptions) {
    if (!options.apiKey) throw new Error("EmberProvider needs an API key");
    this.#apiKey = options.apiKey;
    this.url = `${(options.baseUrl ?? EMBER_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(toWireBody(request)),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      if (TURNED_AWAY.has(response.status)) {
        throw new NotDispatchedError(`Meta Model API turned the request away (HTTP ${response.status}): ${detail}`);
      }
      throw new EmberHttpError(response.status, detail);
    }
    return fromWireBody(await response.json());
  }
}

/** The request body. Exported so tests can check exactly what would be sent. */
export function toWireBody(request: ProviderRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages.map(toWireMessage),
    // On this API the limit covers reasoning tokens and visible output together.
    max_tokens: request.maxOutputTokens,
    reasoning_effort: request.reasoningEffort,
    stream: false,
    ...(request.tools
      ? { tools: request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) }
      : {}),
    ...(request.responseSchema
      ? { response_format: { type: "json_schema", json_schema: { name: request.responseSchema.name, schema: request.responseSchema.schema, strict: true } } }
      : {}),
  };
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  return {
    role: m.role,
    content: m.content,
    ...(m.toolCalls
      ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) }
      : {}),
    ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
  };
}

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

/** Read a response body. A missing or malformed usage block comes back as `usage: undefined`. */
export function fromWireBody(body: unknown): ProviderResponse {
  const root = (body ?? {}) as Record<string, any>;
  const choice = root.choices?.[0];
  const message = choice?.message ?? {};

  const toolCalls: ToolCall[] = Array.isArray(message.tool_calls)
    ? message.tool_calls
        .filter((c: any) => c && typeof c.id === "string" && typeof c.function?.name === "string")
        .map((c: any) => ({ id: c.id, name: c.function.name, arguments: typeof c.function.arguments === "string" ? c.function.arguments : "" }))
    : [];

  const inputTokens = count(root.usage?.prompt_tokens);
  const outputTokens = count(root.usage?.completion_tokens);
  let usage: Usage | undefined;
  if (inputTokens !== undefined && outputTokens !== undefined) {
    const reasoningTokens = count(root.usage?.completion_tokens_details?.reasoning_tokens);
    usage = {
      inputTokens,
      cachedTokens: count(root.usage?.prompt_tokens_details?.cached_tokens) ?? 0,
      outputTokens,
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    };
  }

  return {
    text: typeof message.content === "string" ? message.content : null,
    toolCalls,
    ...(usage ? { usage } : {}),
    ...(typeof choice?.finish_reason === "string" ? { finishReason: choice.finish_reason } : {}),
  };
}
