import type { Usage } from "../spend/pricing";
import type { ChatMessage, Provider, ProviderRequest, ProviderResponse, ToolCall } from "./types";

export const EMBER_BASE_URL = "https://api.meta.ai/v1";

/**
 * Any reply that is not a success. The request reached the API, so this program cannot know
 * from the status alone whether it was billed: the spend guard keeps the full hold until a
 * person reconciles it against the dashboard. That includes 400, 401 and 429.
 */
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
  /**
   * The whole exchange, from sending to the last byte of the reply, must finish within this.
   * Otherwise it is aborted and treated as "may have been billed".
   */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * The only real model provider: Muse Ember through the Chat Completions endpoint.
 *
 * One `send` is one HTTP request. There is no retry, no streaming, no stored conversation and
 * no redirect: a redirect would repeat the POST under a single hold, so it is an error.
 * Everything the model sees is in the body. Use it only through `createMetered()`.
 */
export class EmberProvider implements Provider {
  readonly name = "ember";
  readonly billable = true;
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

  /** The exact body text for a request. The spend guard measures this and passes it to `send`. */
  encode(request: ProviderRequest): string {
    return JSON.stringify(toWireBody(request));
  }

  async send(body: string): Promise<ProviderResponse> {
    const controller = new AbortController();
    // The timer covers the reply body too: headers arriving does not mean the reply will finish.
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
        body,
        redirect: "error",
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new EmberHttpError(response.status, text.slice(0, 300));
      return fromWireBody(JSON.parse(text));
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The request body. Exported so tests can check exactly what would be sent. */
export function toWireBody(request: ProviderRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages.map(toWireMessage),
    // On this API the limit covers reasoning tokens and visible output together.
    // `max_completion_tokens` is the current name; `max_tokens` is a deprecated alias.
    max_completion_tokens: request.maxOutputTokens,
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
    // An assistant turn that only calls tools carries no text: the API's own examples send null.
    content: m.toolCalls && m.content === "" ? null : m.content,
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
