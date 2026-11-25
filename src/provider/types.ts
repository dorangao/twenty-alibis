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

/** One physical request per call. A provider must never resend on its own. */
export interface Provider {
  readonly name: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}

/**
 * Thrown by a provider only when it is certain nothing was sent (for example, a local
 * validation failure). Any other error is treated as "may have been billed".
 */
export class NotDispatchedError extends Error {
  override readonly name = "NotDispatchedError";
}
