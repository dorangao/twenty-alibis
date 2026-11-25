import type { Provider, ProviderRequest, ProviderResponse } from "./types";

export type FakeHandler = (request: ProviderRequest, index: number) => ProviderResponse | Promise<ProviderResponse>;

/**
 * A scripted provider. Tests and CI use only this: no key, no network, no cost.
 * It counts every dispatch, so a test can assert that a refused request was never sent.
 */
export class FakeProvider implements Provider {
  readonly name = "fake";
  readonly requests: ProviderRequest[] = [];

  constructor(private readonly handler: FakeHandler) {}

  get dispatched(): number {
    return this.requests.length;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const index = this.requests.length;
    this.requests.push(request);
    return this.handler(request, index);
  }
}

/** A fake that answers each request with the next scripted response, then repeats the last. */
export function scripted(responses: ProviderResponse[]): FakeProvider {
  if (responses.length === 0) throw new Error("scripted() needs at least one response");
  return new FakeProvider((_request, index) => responses[Math.min(index, responses.length - 1)]!);
}

export function textResponse(text: string, usage?: ProviderResponse["usage"]): ProviderResponse {
  return usage ? { text, toolCalls: [], usage } : { text, toolCalls: [] };
}
