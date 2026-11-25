import { describe, expect, it } from "vitest";
import { createMetered } from "../src/metered";
import { EMBER_BASE_URL, EmberHttpError, EmberProvider, fromWireBody, toWireBody } from "../src/provider/ember";
import { NotDispatchedError, type ProviderRequest } from "../src/provider/types";
import { worstCaseNano } from "../src/spend/pricing";
import { MemorySpendStore } from "../src/spend/store";
import { readSpendConfig, resolveApiKey } from "../src/runtime";

/**
 * The real provider is tested against a stand-in for `fetch`. No test in this file, or in
 * this repository, sends a request to the Meta Model API.
 */
const request: ProviderRequest = {
  model: "muse-ember-1.0",
  messages: [
    { role: "system", content: "You are Ada." },
    { role: "user", content: "21:00 你在哪里？" },
  ],
  maxOutputTokens: 150,
  reasoningEffort: "low",
};

const okBody = {
  choices: [{ message: { role: "assistant", content: "In the foyer." }, finish_reason: "stop" }],
  usage: {
    prompt_tokens: 3_500,
    completion_tokens: 250,
    prompt_tokens_details: { cached_tokens: 2_800 },
    completion_tokens_details: { reasoning_tokens: 40 },
  },
};

function fakeFetch(reply: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return reply(String(input), init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the request Ember receives", () => {
  it("always carries the model, an output limit, a reasoning effort, and no streaming", () => {
    expect(toWireBody(request)).toEqual({
      model: "muse-ember-1.0",
      messages: [
        { role: "system", content: "You are Ada." },
        { role: "user", content: "21:00 你在哪里？" },
      ],
      max_tokens: 150,
      reasoning_effort: "low",
      stream: false,
    });
  });

  it("is stateless: no stored conversation, no file reference, no hosted tool", () => {
    const body = JSON.stringify(
      toWireBody({
        ...request,
        tools: [{ name: "recall", description: "What this suspect knows about a topic.", parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] } }],
        responseSchema: { name: "reply", schema: { type: "object" } },
      }),
    );
    for (const forbidden of ["previous_response_id", "conversation", "file_id", "web_search", "store"]) {
      expect(body).not.toContain(forbidden);
    }
    expect(JSON.parse(body).tools).toEqual([
      { type: "function", function: { name: "recall", description: "What this suspect knows about a topic.", parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] } } },
    ]);
    expect(JSON.parse(body).response_format).toEqual({ type: "json_schema", json_schema: { name: "reply", schema: { type: "object" }, strict: true } });
  });

  it("round-trips tool calls and tool results", () => {
    const body = toWireBody({
      ...request,
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "recall", arguments: '{"topic":"21:00"}' }] },
        { role: "tool", content: '["a-ada-foyer-2100"]', toolCallId: "call_1" },
      ],
    });
    expect(body.messages).toEqual([
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "recall", arguments: '{"topic":"21:00"}' } }] },
      { role: "tool", content: '["a-ada-foyer-2100"]', tool_call_id: "call_1" },
    ]);
  });
});

describe("EmberProvider", () => {
  it("sends one POST to the chat completions endpoint with the key in a header only", async () => {
    const { impl, calls } = fakeFetch(() => json(okBody));
    const provider = new EmberProvider({ apiKey: "test-key-not-real", fetch: impl });
    const response = await provider.complete(request);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${EMBER_BASE_URL}/chat/completions`);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer test-key-not-real");
    expect(String(calls[0]!.init.body)).not.toContain("test-key-not-real");
    expect(response).toEqual({
      text: "In the foyer.",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 3_500, cachedTokens: 2_800, outputTokens: 250, reasoningTokens: 40 },
    });
  });

  it("does not expose the key on the object", () => {
    const provider = new EmberProvider({ apiKey: "test-key-not-real", fetch: fakeFetch(() => json(okBody)).impl });
    expect(JSON.stringify(provider)).not.toContain("test-key-not-real");
    expect(Object.values(provider)).not.toContain("test-key-not-real");
  });

  it("reads tool calls", () => {
    const response = fromWireBody({
      choices: [{ message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "recall", arguments: '{"topic":"21:00"}' } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(response.text).toBeNull();
    expect(response.toolCalls).toEqual([{ id: "call_1", name: "recall", arguments: '{"topic":"21:00"}' }]);
    expect(response.usage).toEqual({ inputTokens: 10, cachedTokens: 0, outputTokens: 5 });
  });

  it("reports no usage when the block is missing or malformed", () => {
    expect(fromWireBody({ choices: [{ message: { content: "hi" } }] }).usage).toBeUndefined();
    expect(fromWireBody({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: "many", completion_tokens: 5 } }).usage).toBeUndefined();
    expect(fromWireBody({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 5, completion_tokens: -1 } }).usage).toBeUndefined();
    expect(fromWireBody(null)).toEqual({ text: null, toolCalls: [] });
  });

  it.each([400, 401, 403, 404, 413, 422, 429])("treats HTTP %i as turned away: nothing was billed", async (status) => {
    const provider = new EmberProvider({ apiKey: "k", fetch: fakeFetch(() => json({ error: { message: "nope" } }, status)).impl });
    await expect(provider.complete(request)).rejects.toBeInstanceOf(NotDispatchedError);
  });

  it.each([408, 409, 500, 502, 503, 504])("treats HTTP %i as possibly billed", async (status) => {
    const provider = new EmberProvider({ apiKey: "k", fetch: fakeFetch(() => json({ error: { message: "oops" } }, status)).impl });
    const error = await provider.complete(request).catch((e) => e);
    expect(error).toBeInstanceOf(EmberHttpError);
    expect(error).not.toBeInstanceOf(NotDispatchedError);
  });

  it("aborts a request that runs past the timeout, and that counts as possibly billed", async () => {
    const { impl } = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const provider = new EmberProvider({ apiKey: "k", fetch: impl, timeoutMs: 10 });
    const error = await provider.complete(request).catch((e) => e);
    expect(error).not.toBeInstanceOf(NotDispatchedError);
    expect(error.name).toBe("AbortError");
  });

  it("never retries", async () => {
    const { impl, calls } = fakeFetch(() => json({ error: {} }, 503));
    await new EmberProvider({ apiKey: "k", fetch: impl }).complete(request).catch(() => {});
    expect(calls).toHaveLength(1);
  });
});

describe("EmberProvider behind the spend guard", () => {
  const hold = worstCaseNano(150);
  const run = async (reply: () => Response) => {
    const store = new MemorySpendStore();
    const provider = new EmberProvider({ apiKey: "k", fetch: fakeFetch(reply).impl });
    const metered = createMetered({ provider, store, envelope: "e", limitNano: 10 * hold });
    const result = await metered({ step: "t", promptId: "p", messages: request.messages, maxOutputTokens: 150 });
    return { result, totals: await store.totals("e") };
  };

  it("settles a normal reply at its real cost", async () => {
    const { result, totals } = await run(() => json(okBody));
    expect(result.ok).toBe(true);
    expect(totals).toMatchObject({ settledNano: 206_200, heldNano: 0, retainedNano: 0 });
  });

  it("charges nothing for a request the API turned away", async () => {
    const { result, totals } = await run(() => json({ error: {} }, 429));
    expect(result).toMatchObject({ ok: false, sent: false, reason: "not-dispatched" });
    expect(totals.committedNano).toBe(0);
  });

  it("keeps the full hold after a server error or a reply without usage", async () => {
    expect((await run(() => json({ error: {} }, 500))).totals.retainedNano).toBe(hold);
    expect((await run(() => json({ choices: [{ message: { content: "hi" } }] }))).totals.retainedNano).toBe(hold);
    expect((await run(() => new Response("<html>bad gateway</html>", { status: 200 }))).totals.retainedNano).toBe(hold);
  });
});

describe("runtime settings", () => {
  it("finds the key under any accepted name and prefers EMBER_API_KEY", () => {
    expect(resolveApiKey({})).toBeNull();
    expect(resolveApiKey({ EMBER_API_KEY: "  " })).toBeNull();
    expect(resolveApiKey({ META_API_KEY: "m" })).toEqual({ name: "META_API_KEY", key: "m" });
    expect(resolveApiKey({ MUSE_API_KEY: "u", EMBER_API_KEY: "e" })).toEqual({ name: "EMBER_API_KEY", key: "e" });
  });

  it("refuses to run without a Redis URL, an envelope and a positive limit", () => {
    const good = { REDIS_URL: "redis://127.0.0.1:6379", SPEND_ENVELOPE: "local", SPEND_LIMIT_USD: "6" };
    expect(readSpendConfig(good)).toEqual({ redisUrl: "redis://127.0.0.1:6379", envelope: "local", limitNano: 6_000_000_000 });
    expect(() => readSpendConfig({ ...good, REDIS_URL: "" })).toThrow();
    expect(() => readSpendConfig({ ...good, SPEND_ENVELOPE: undefined })).toThrow();
    for (const limit of ["", "0", "-1", "lots"]) {
      expect(() => readSpendConfig({ ...good, SPEND_LIMIT_USD: limit })).toThrow();
    }
  });
});
