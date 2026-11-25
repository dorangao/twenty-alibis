import type { MODEL, Usage } from "../spend/pricing";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ToolCall {
  id: string;
  name: string;
  /** JSON text, exactly as the model produced it. */
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

/**
 * One stateless request: everything the model sees is inline in `messages`.
 * There is deliberately no field for a stored conversation id, a file reference or a hosted
 * tool. A short id can stand for a long billed context, and then the size of this object
 * would say nothing about the cost.
 */
export interface ProviderRequest {
  model: typeof MODEL;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  responseSchema?: { name: string; schema: Record<string, unknown> };
  maxOutputTokens: number;
  reasoningEffort: ReasoningEffort;
}

export interface ProviderResponse {
  text: string | null;
  toolCalls: ToolCall[];
  /** Missing when the provider did not report usage. The spend guard then keeps the full hold. */
  usage?: Usage;
  finishReason?: string;
}

/**
 * A provider works in two steps so the spend guard can measure exactly what will be sent.
 *
 *   encode  turns a request into the exact text of the body. No I/O, no side effects.
 *   send    sends that text, once. It never resends, retries or follows a redirect.
 *
 * The guard checks the size of the encoded body, reserves for it, and passes that same text
 * to `send`. What was checked and what is sent cannot differ.
 */
export interface Provider {
  readonly name: string;
  /**
   * True when `send` spends real money. A billable provider is refused unless the envelope
   * carries an operator's explicit authorization for paid requests. Having a key is not enough.
   */
  readonly billable: boolean;
  encode(request: ProviderRequest): string;
  send(body: string): Promise<ProviderResponse>;
}

/**
 * Thrown by `send` only when it is certain that nothing left this machine: a local check
 * failed before any network call. Once a request has been handed to the network, every
 * failure, including an HTTP error reply, counts as "may have been billed".
 */
export class NotDispatchedError extends Error {
  override readonly name = "NotDispatchedError";
}
