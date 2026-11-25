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
const provider = (reply: (url: string, init: RequestInit) => Response | Promise<Response>, timeoutMs?: number) => {
  const fake = fakeFetch(reply);
  return { ember: new EmberProvider({ apiKey: "test-key-not-real", fetch: fake.impl, ...(timeoutMs ? { timeoutMs } : {}) }), calls: fake.calls };
};
const failure = (promise: Promise<unknown>): Promise<Error> => promise.then(() => new Error("did not fail"), (e: Error) => e);

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
  it("encodes a request to the exact body it will send", async () => {
    const { ember, calls } = provider(() => json(okBody));
    const body = ember.encode(request);
    expect(JSON.parse(body)).toEqual(toWireBody(request));
    await ember.send(body);
    // Byte for byte: what was measured is what goes out.
    expect(calls[0]!.init.body).toBe(body);
  });

  it("sends one POST to the chat completions endpoint with the key in a header only", async () => {
    const { ember, calls } = provider(() => json(okBody));
    const response = await ember.send(ember.encode(request));

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

  it("refuses to follow a redirect, which would repeat the POST under one hold", async () => {
    const { ember, calls } = provider(() => json(okBody));
    await ember.send(ember.encode(request));
    expect(calls[0]!.init.redirect).toBe("error");
  });

  it("does not expose the key on the object", () => {
    const { ember } = provider(() => json(okBody));
    expect(JSON.stringify(ember)).not.toContain("test-key-not-real");
    expect(Object.values(ember)).not.toContain("test-key-not-real");
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

  it.each([400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504])(
    "treats HTTP %i as possibly billed: the request reached the API",
    async (status) => {
      const { ember } = provider(() => json({ error: { message: "nope" } }, status));
      const error = await failure(ember.send(ember.encode(request)));
      expect(error).toBeInstanceOf(EmberHttpError);
      expect(error).not.toBeInstanceOf(NotDispatchedError);
    },
  );

  it("treats a reply that is not JSON as possibly billed", async () => {
    const { ember } = provider(() => new Response("<html>bad gateway</html>", { status: 200 }));
    expect(await failure(ember.send(ember.encode(request)))).not.toBeInstanceOf(NotDispatchedError);
  });

  it("aborts when no reply arrives in time", async () => {
    const { ember } = provider(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      10,
    );
    const error = await failure(ember.send(ember.encode(request)));
    expect(error.name).toBe("AbortError");
    expect(error).not.toBeInstanceOf(NotDispatchedError);
  });

  it("aborts when the headers arrive but the body never finishes", async () => {
    const { ember } = provider(
      (_url, init) =>
        ({
          ok: true,
          status: 200,
          // Headers are in; the body stalls until the request is aborted.
          text: () =>
            new Promise<string>((_resolve, reject) => {
              init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            }),
        }) as unknown as Response,
      10,
    );
    const error = await failure(ember.send(ember.encode(request)));
    expect(error.name).toBe("AbortError");
  });

  it("never retries", async () => {
    const { ember, calls } = provider(() => json({ error: {} }, 503));
    await failure(ember.send(ember.encode(request)));
    expect(calls).toHaveLength(1);
  });
});

describe("EmberProvider behind the spend guard", () => {
  const hold = worstCaseNano(150);
  const run = async (reply: () => Response) => {
    const store = new MemorySpendStore();
    const { ember, calls } = provider(reply);
    const metered = createMetered({ provider: ember, store, envelope: "e", limitNano: 10 * hold });
    const result = await metered({ step: "t", promptId: "p", attemptId: "turn-1", messages: request.messages, maxOutputTokens: 150 });
    return { result, totals: await store.totals("e"), calls };
  };

  it("settles a normal reply at its real cost", async () => {
    const { result, totals } = await run(() => json(okBody));
    expect(result).toMatchObject({ ok: true, settled: true, breached: false });
    expect(totals).toMatchObject({ settledNano: 206_200, heldNano: 0, retainedNano: 0, suspended: null });
  });

  it("sends exactly the body it measured", async () => {
    const { calls } = await run(() => json(okBody));
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(toWireBody({ ...request, maxOutputTokens: 150 }));
  });

  it.each([400, 401, 429, 500])("keeps the full hold after HTTP %i: nothing here proves it was free", async (status) => {
    const { result, totals } = await run(() => json({ error: {} }, status));
    expect(result).toMatchObject({ ok: false, sent: true, reason: "outcome-unknown" });
    expect(totals).toMatchObject({ settledNano: 0, retainedNano: hold });
  });

  it("keeps the full hold after a reply without usage or a reply that is not JSON", async () => {
    expect((await run(() => json({ choices: [{ message: { content: "hi" } }] }))).totals.retainedNano).toBe(hold);
    expect((await run(() => new Response("<html>bad gateway</html>", { status: 200 }))).totals.retainedNano).toBe(hold);
  });

  it("suspends the envelope when the API reports more output than the limit allowed", async () => {
    // 150 was the limit. A reply billed for far more means the hold did not bound the cost.
    const { result, totals } = await run(() => json({ ...okBody, usage: { prompt_tokens: 3_500, completion_tokens: 100_000 } }));
    expect(result).toMatchObject({ ok: true, breached: true });
    expect(totals.settledNano).toBe(3_500 * 100 + 100_000 * 500);
    expect(totals.suspended).not.toBeNull();
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
