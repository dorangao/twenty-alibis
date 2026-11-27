import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { archivePass } from "../src/case/fixtures/archive";
import { createMetered, type TraceEvent } from "../src/metered";
import { FakeProvider } from "../src/provider/fake";
import type { ProviderRequest, ProviderResponse } from "../src/provider/types";
import { usdToNano } from "../src/spend/pricing";
import { connectRedis } from "../src/spend/redis-client";
import type { ScriptRunner } from "../src/spend/redis-store";
import { MemorySpendStore, type EnvelopeTotals } from "../src/spend/store";
import { DEFAULT_LIMITS } from "../src/web/allowance";
import type { ApiError, CasesReply, ViewReply } from "../src/web/api";
import { ConfigError, deployedApi, deployedListener, readDeployedConfig, reconnecting, redisTrace, WEB_PREFIX, type DeployedParts } from "../src/web/deployed";
import { redisRun, redisUrl } from "./redis-run";

const repo = resolve(import.meta.dirname, "..");
const good = { PUBLIC_ORIGIN: "https://game.test", REDIS_URL: "redis://127.0.0.1:6379/15", SPEND_ENVELOPE: "deployed", SPEND_LIMIT_USD: "2.5" };
const usage = { inputTokens: 1_000, cachedTokens: 0, outputTokens: 60 };
function wellBehaved(request: ProviderRequest): ProviderResponse {
  if (request.tools?.length) {
    const menu = (request.tools[0]!.parameters as { properties: { topic: { enum: string[] } } }).properties.topic.enum;
    return { text: null, toolCalls: [{ id: "call_1", name: "recall", arguments: JSON.stringify({ topic: menu[0] }) }], usage, finishReason: "tool_calls" };
  }
  const recalled = JSON.parse(request.messages.find((m) => m.role === "tool")!.content) as { statements: { id: string; en: string }[] };
  return { text: JSON.stringify({ assertions: recalled.statements.map((s) => s.id), line: recalled.statements.map((s) => s.en).join(" "), language: "en" }), toolCalls: [], usage, finishReason: "stop" };
}
const open: EnvelopeTotals = { settledNano: 0, heldNano: 0, retainedNano: 0, committedNano: 0, attempts: 0, suspended: null, paidAllowed: "judges" };

describe("the deployed server's configuration", () => {
  it("reads the origin, the spend settings and the allowance, with defaults for what is optional", () => {
    expect(readDeployedConfig(good)).toEqual({ origin: "https://game.test", redisUrl: good.REDIS_URL, envelope: "deployed", limitNano: usdToNano(2.5), limits: DEFAULT_LIMITS, prefix: WEB_PREFIX, casesDir: "cases/released" });
    const set = readDeployedConfig({ ...good, VISITOR_GAMES_PER_DAY: "3", VISITOR_REQUESTS_PER_DAY: "40", GAMES_PER_HOUR: "12", WEB_KEY_PREFIX: "ta:preview" });
    expect(set.limits).toEqual({ ...DEFAULT_LIMITS, sessionsPerVisitor: 3, requestsPerVisitor: 40, sessionsPerHour: 12 });
    expect(set.prefix).toBe("ta:preview");
  });

  it("takes only the site's own https origin, with nothing after the host", () => {
    expect(readDeployedConfig({ ...good, PUBLIC_ORIGIN: "https://game.test:8443" }).origin).toBe("https://game.test:8443");
    for (const bad of [undefined, "", "  ", "game.test", "http://game.test", "https://game.test/", "https://game.test/play", "https://user@game.test", "null", "*"]) {
      expect(() => readDeployedConfig({ ...good, PUBLIC_ORIGIN: bad }), String(bad)).toThrow(ConfigError);
    }
  });

  it("names the setting that is missing or wrong, and never repeats a value", () => {
    const cases: [Record<string, string | undefined>, string][] = [
      [{ ...good, PUBLIC_ORIGIN: undefined }, "PUBLIC_ORIGIN is not set"],
      [{ ...good, PUBLIC_ORIGIN: "http://secret-host.test" }, "PUBLIC_ORIGIN must be the site's own https origin, with nothing after the host"],
      [{ ...good, REDIS_URL: undefined }, "REDIS_URL is not set"],
      [{ ...good, SPEND_ENVELOPE: "" }, "SPEND_ENVELOPE is not set"],
      [{ ...good, SPEND_LIMIT_USD: "lots" }, "SPEND_LIMIT_USD must be a positive number of dollars"],
      [{ ...good, GAMES_PER_HOUR: "0" }, "GAMES_PER_HOUR must be a whole number above zero"],
      [{ ...good, VISITOR_GAMES_PER_DAY: "2.5" }, "VISITOR_GAMES_PER_DAY must be a whole number above zero"],
      [{ ...good, VISITOR_REQUESTS_PER_DAY: "-4" }, "VISITOR_REQUESTS_PER_DAY must be a whole number above zero"],
      [{ ...good, WEB_KEY_PREFIX: "ta web*" }, "WEB_KEY_PREFIX may only have letters, digits, ':', '_' and '-'"],
    ];
    for (const [env, message] of cases) {
      let thrown: unknown;
      try {
        readDeployedConfig(env);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, message).toBeInstanceOf(ConfigError);
      expect((thrown as Error).message).toBe(message);
    }
  });
});

describe("one Redis connection, opened again when it has died", () => {
  /** Connections a test can kill. */
  const fleet = () => {
    const made: { dead: boolean; closed: boolean; evals: number; pings: number; fail?: Error; hang?: boolean }[] = [];
    const connect = async () => {
      const c: (typeof made)[number] = { dead: false, closed: false, evals: 0, pings: 0 };
      made.push(c);
      return {
        runner: {
          eval: async () => {
            c.evals++;
            if (c.fail) throw c.fail;
            if (c.dead) throw new Error("Connection is closed.");
            return made.length;
          },
        },
        ping: async () => {
          c.pings++;
          if (c.hang) return new Promise<string>(() => undefined);
          if (c.dead) throw new Error("Connection is closed.");
          return "PONG";
        },
        close: async () => {
          c.closed = true;
        },
      };
    };
    return { made, connect };
  };
  const reply = Object.assign(new Error("ERR a count is damaged"), { name: "ReplyError" });

  it("opens one connection on first use and keeps it; many callers at once share it", async () => {
    const { made, connect } = fleet();
    const redis = reconnecting(connect);
    expect(made).toHaveLength(0);
    await Promise.all([redis.eval("s", [], []), redis.eval("s", [], []), redis.eval("s", [], [])]);
    await redis.eval("s", [], []);
    expect(made).toHaveLength(1);
    expect(made[0]!.evals).toBe(4);
    expect(made[0]!.pings).toBe(0);
  });

  it("a command that fails is not sent again; the next command gets a new connection", async () => {
    const { made, connect } = fleet();
    const redis = reconnecting(connect);
    await redis.eval("s", [], []);
    made[0]!.dead = true;
    await expect(redis.eval("s", [], [])).rejects.toThrow("Connection is closed.");
    expect(made[0]!.evals).toBe(2);
    expect(made[0]!.closed).toBe(true);
    expect(made).toHaveLength(1);
    expect(await redis.eval("s", [], [])).toBe(2);
    expect(made).toHaveLength(2);
  });

  it("an answer from Redis that says no is an answer: the connection is kept", async () => {
    const { made, connect } = fleet();
    const redis = reconnecting(connect);
    await redis.eval("s", [], []);
    made[0]!.fail = reply;
    await expect(redis.eval("s", [], [])).rejects.toThrow("a count is damaged");
    delete made[0]!.fail;
    await redis.eval("s", [], []);
    expect(made).toHaveLength(1);
    expect(made[0]!.closed).toBe(false);
  });

  it("after sitting idle it asks for a sign of life first, and replaces a connection that gives none, dead or silent", async () => {
    for (const how of ["dead", "hang"] as const) {
      const { made, connect } = fleet();
      let clock = 0;
      const redis = reconnecting(connect, { idleMs: 1_000, pingTimeoutMs: 30, now: () => clock });
      await redis.eval("s", [], []);
      clock = 1_000;
      await redis.eval("s", [], []);
      // Not idle long enough: no question asked.
      expect(made[0]!.pings).toBe(0);
      clock = 2_001;
      await redis.eval("s", [], []);
      // Idle, and alive: asked once, kept.
      expect(made[0]!.pings).toBe(1);
      expect(made).toHaveLength(1);
      made[0]![how] = true;
      clock = 4_000;
      // Idle, and gone: replaced before the command is sent, so the command itself does not fail.
      expect(await redis.eval("s", [], []), how).toBe(2);
      expect(made[0]!.closed).toBe(true);
      expect(made[0]!.evals).toBe(3);
      expect(made[1]!.evals).toBe(1);
    }
  });

  it("if a connection cannot be opened the command rejects, and the next one tries again", async () => {
    let tries = 0;
    const { connect } = fleet();
    const redis = reconnecting(async () => {
      if (++tries === 1) throw new Error("connect ETIMEDOUT");
      return connect();
    });
    await expect(redis.eval("s", [], [])).rejects.toThrow("ETIMEDOUT");
    expect(await redis.eval("s", [], [])).toBe(1);
  });
});

describe("whether the model is on, for a deployed server", () => {
  const down: ScriptRunner = { eval: () => Promise.reject(new Error("no redis in this test")) };
  const metered = createMetered({ inputBound: { tokensPerByte: 100 }, provider: new FakeProvider(wellBehaved), store: new MemorySpendStore(), envelope: "e", limitNano: usdToNano(1) });
  const parts = (model: Partial<NonNullable<DeployedParts["model"]>> | null, now?: () => number): DeployedParts => ({
    cases: [archivePass],
    redis: down,
    origin: "https://game.test",
    limits: DEFAULT_LIMITS,
    prefix: "ta-test-unused",
    model: model === null ? null : { metered, totals: async () => open, limitNano: usdToNano(2.5), disabled: () => false, settle: async () => undefined, ...model },
    ...(now ? { now } : {}),
  });
  const model = async (api: (request: Request) => Promise<Response>): Promise<string> => ((await (await api(new Request("https://game.test/api/cases"))).json()) as CasesReply).model;

  it("is on only with a key, the switch off, paid requests authorized, no suspension, and room for one more request", async () => {
    expect(await model(deployedApi(parts({})))).toBe("on");
    expect(await model(deployedApi(parts(null)))).toBe("off");
    expect(await model(deployedApi(parts({ disabled: () => true })))).toBe("off");
    expect(await model(deployedApi(parts({ totals: async () => ({ ...open, paidAllowed: null }) })))).toBe("off");
    expect(await model(deployedApi(parts({ totals: async () => ({ ...open, suspended: "a reply cost more than its hold" }) })))).toBe("off");
    expect(await model(deployedApi(parts({ totals: async () => Promise.reject(new Error("the envelope is not initialized")) })))).toBe("off");
    // Room: the envelope must be able to hold one request at its worst case, about 31 cents.
    expect(await model(deployedApi(parts({ totals: async () => ({ ...open, committedNano: usdToNano(2.1) }) })))).toBe("on");
    expect(await model(deployedApi(parts({ totals: async () => ({ ...open, committedNano: usdToNano(2.3) }) })))).toBe("off");
  });

  it("asks the counter at most once in five seconds, and the server's own switch every time", async () => {
    let clock = 0;
    let asked = 0;
    let totals = open;
    let disabled = false;
    const api = deployedApi(parts({ totals: async () => (asked++, totals), disabled: () => disabled }, () => clock));
    expect(await model(api)).toBe("on");
    totals = { ...open, paidAllowed: null };
    clock = 4_999;
    expect(await model(api)).toBe("on");
    expect(asked).toBe(1);
    // The switch is not remembered: it turns the model off at once, and on again at once.
    disabled = true;
    expect(await model(api)).toBe("off");
    disabled = false;
    expect(await model(api)).toBe("on");
    clock = 5_000;
    expect(await model(api)).toBe("off");
    expect(asked).toBe(2);
  });

  it("waits for the trace lines that are still being written before it answers", async () => {
    let settled = 0;
    const api = deployedApi(parts({ settle: async () => void settled++ }));
    await api(new Request("https://game.test/api/cases"));
    expect(settled).toBe(1);
  });

  it("with Redis out of reach the library is still listed, and no game starts", async () => {
    const api = deployedApi(parts({}));
    expect((await api(new Request("https://game.test/api/cases"))).status).toBe(200);
    const start = await api(new Request("https://game.test/api/sessions", { method: "POST", headers: { origin: "https://game.test" }, body: JSON.stringify({ caseId: archivePass.id }) }));
    expect(start.status).toBe(500);
    expect(((await start.json()) as ApiError).error.code).toBe("server");
    expect(start.headers.get("set-cookie")).toBeNull();
  });
});

describe("the usage trace in Redis", () => {
  it("writes one line per request and keeps writes that are on their way where the worker can wait for them", async () => {
    const calls: { keys: string[]; args: string[] }[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const redis: ScriptRunner = { eval: async (_script, keys, args) => (calls.push({ keys, args }), await gate, 1) };
    const pending = new Set<Promise<unknown>>();
    const trace = redisTrace(redis, "p:trace:e", pending);
    const event: TraceEvent = { at: "2026-11-27T00:00:00.000Z", attemptId: "s:1:answer", envelope: "e", step: "suspect.answer", promptId: "suspect-v2", model: "muse-ember-1.0", reasoningEffort: "low", maxOutputTokens: 500, payloadBytes: 10, outcome: "settled", holdNano: 1, costNano: 1 };
    trace(event);
    trace(event);
    expect(pending.size).toBe(2);
    expect(calls[0]).toEqual({ keys: ["p:trace:e"], args: [JSON.stringify(event), "50000"] });
    release();
    await Promise.allSettled([...pending]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(pending.size).toBe(0);
  });

  it("a line that cannot be written is lost, and nothing is thrown", async () => {
    const pending = new Set<Promise<unknown>>();
    const trace = redisTrace({ eval: () => Promise.reject(new Error("down")) }, "k", pending);
    expect(() => trace({} as never)).not.toThrow();
    await Promise.allSettled([...pending]);
  });
});

describe("the deployed listener", () => {
  let server: Server;
  let base: string;
  let listener: ReturnType<typeof deployedListener>;
  beforeAll(async () => {
    server = createServer((req, res) => void listener(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("without its configuration: the fixed server error, the reason in the log by name only, and it tries again at the next request", async () => {
    const log: string[] = [];
    let tries = 0;
    listener = deployedListener(() => {
      tries++;
      if (tries === 1) throw new ConfigError("PUBLIC_ORIGIN is not set");
      if (tries === 2) throw new Error("connect ECONNREFUSED 10.1.2.3:6379 with password hunter2");
      return { cases: [archivePass], redis: { eval: () => Promise.reject(new Error("no redis")) }, origin: "https://game.test", limits: DEFAULT_LIMITS, prefix: "ta-test-unused", model: null };
    }, (line) => log.push(line));
    for (const path of ["/api/cases", "/api/sessions/00000000-0000-4000-8000-000000000001"]) {
      const r = await fetch(`${base}${path}`);
      expect(r.status).toBe(500);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(await r.json()).toEqual({ error: { code: "server", text: { en: "Something went wrong on the server. Reload the page to see where the game stands.", zh: "服务器出了问题。请刷新页面，查看这一局的进展。" } } });
    }
    expect(log).toEqual(["twenty-alibis: the server is not ready: PUBLIC_ORIGIN is not set", "twenty-alibis: the server is not ready: it could not be set up"]);
    // Third time it is set up, and stays set up.
    expect((await fetch(`${base}/api/cases`)).status).toBe(200);
    expect((await fetch(`${base}/api/cases`)).status).toBe(200);
    expect(tries).toBe(3);
  });

  it("goes by the configured origin, whatever host and scheme the request arrived with", async () => {
    listener = deployedListener(() => ({ cases: [archivePass], redis: { eval: () => Promise.reject(new Error("no redis")) }, origin: "https://game.test", limits: DEFAULT_LIMITS, prefix: "ta-test-unused", model: null }));
    const post = (origin: string) => fetch(`${base}/api/sessions`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ caseId: archivePass.id }) });
    // From the address the request arrived at: not the game's page.
    expect(((await (await post(base)).json()) as ApiError).error.code).toBe("forbidden");
    // From the game's page: let through, as far as Redis, which this test does not have.
    expect(((await (await post("https://game.test")).json()) as ApiError).error.code).toBe("server");
  });
});

const prefix = redisRun();

describe("the function as it is built for the host", () => {
  let out: string;
  let home: string;
  const children: ChildProcess[] = [];
  /** Run the built function with plain Node, from a folder outside the repository, with only the environment given. */
  const run = async (env: Record<string, string>): Promise<{ base: string; errors: () => string }> => {
    const child = spawn(process.execPath, ["harness.mjs"], { cwd: home, env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const port = await new Promise<string>((done, fail) => {
      let stdout = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const found = /PORT (\d+)/.exec(stdout);
        if (found) done(found[1]!);
      });
      child.on("exit", () => fail(new Error(`the function did not start: ${stderr}`)));
    });
    return { base: `http://127.0.0.1:${port}`, errors: () => stderr };
  };

  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "ta-build-"));
    const built = spawnSync(process.execPath, ["--import", "tsx", "scripts/build-vercel.ts", "--out", out], { cwd: repo, encoding: "utf8", env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" } });
    if (built.status !== 0) throw new Error(`the build failed: ${built.stdout}\n${built.stderr}`);
    // Out of the repository: nothing here can reach the source or the installed packages.
    home = mkdtempSync(join(tmpdir(), "ta-func-"));
    cpSync(join(out, "functions/api.func"), home, { recursive: true });
    writeFileSync(
      join(home, "harness.mjs"),
      `import { createServer } from "node:http";
const { default: listener } = await import("./index.mjs");
const server = createServer((req, res) => void listener(req, res));
server.listen(0, "127.0.0.1", () => console.log("PORT " + server.address().port));
`,
    );
  }, 60_000);
  afterAll(() => {
    for (const child of children) child.kill();
    for (const dir of [out, home]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("is laid out as the host reads it: routes, the page as files, one function file and its settings", () => {
    expect(JSON.parse(readFileSync(join(out, "config.json"), "utf8"))).toEqual({ version: 3, routes: [{ src: "^/api(?:/.*)?$", dest: "/api" }, { handle: "filesystem" }] });
    expect(JSON.parse(readFileSync(join(out, "functions/api.func/.vc-config.json"), "utf8"))).toEqual({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false, shouldAddSourcemapSupport: false, maxDuration: 200 });
    expect(readdirSync(join(out, "functions/api.func")).sort()).toEqual([".vc-config.json", "cases", "index.mjs"]);
    expect(existsSync(join(out, "static/index.html"))).toBe(true);
    // The route's pattern: everything under /api, and nothing that only starts like it.
    const route = /^\/api(?:\/.*)?$/;
    expect(["/api", "/api/cases", "/api/sessions/x/ask"].every((p) => route.test(p))).toBe(true);
    expect(["/", "/apiary", "/assets/api.js", "/index.html"].some((p) => route.test(p))).toBe(false);
  });

  it("puts no case text in the page's files: the cases are in the function only", () => {
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
    const page = files(join(out, "static")).map((f) => readFileSync(f, "utf8")).join("\n");
    const func = readFileSync(join(out, "functions/api.func/index.mjs"), "utf8");
    for (const text of [archivePass.title.en, archivePass.evidence[0]!.text.en, archivePass.suspects[0]!.name.en]) {
      expect(page, text).not.toContain(text);
      expect(func, text).toContain(text);
    }
  });

  it("with no configuration at all it answers with the fixed error and logs the setting's name", async () => {
    const { base, errors } = await run({});
    const r = await fetch(`${base}/api/cases`);
    expect(r.status).toBe(500);
    expect(((await r.json()) as ApiError).error.code).toBe("server");
    expect(errors()).toContain("twenty-alibis: the server is not ready: PUBLIC_ORIGIN is not set");
  });

  it.skipIf(!redisUrl)("with its configuration and no key it plays a game with the model off, keeping everything in Redis under its prefix", async () => {
    const mine = `${prefix}:web`;
    const { base, errors } = await run({ PUBLIC_ORIGIN: "https://game.test", REDIS_URL: redisUrl!, SPEND_ENVELOPE: `test-${randomUUID()}`, SPEND_LIMIT_USD: "1", WEB_KEY_PREFIX: mine });
    const cases = (await (await fetch(`${base}/api/cases`)).json()) as CasesReply;
    expect(cases.model).toBe("off");
    expect(cases.cases.map((c) => c.id)).toEqual([archivePass.id]);

    const post = (path: string, body: unknown, cookie?: string, origin = "https://game.test") => fetch(`${base}${path}`, { method: "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    // Not from the game's page: refused.
    expect((await post("/api/sessions", { caseId: archivePass.id }, undefined, base)).status).toBe(403);
    const started = await post("/api/sessions", { caseId: archivePass.id });
    expect(started.status).toBe(201);
    const issued = started.headers.get("set-cookie")!;
    expect(issued).toMatch(/^ta_visitor=[0-9a-f]{64}; Path=\/api; HttpOnly; SameSite=Strict; Max-Age=604800; Secure$/);
    const cookie = issued.split(";")[0]!;
    let view = ((await started.json()) as ViewReply).view;
    expect(view).toMatchObject({ model: "off", revision: 1, cost: { requests: 0, nano: 0, unfinished: 0 } });

    const inspected = await post(`/api/sessions/${view.session}/inspect`, { revision: view.revision, inspection: "I1" }, cookie);
    expect(inspected.status).toBe(200);
    view = ((await inspected.json()) as ViewReply).view;
    expect(view.actions.used).toBe(1);
    const topic = await post(`/api/sessions/${view.session}/ask`, { revision: view.revision, topic: "T1", language: "zh" }, cookie);
    expect(((await topic.json()) as ViewReply).ask).toMatchObject({ recorded: true, shown: { source: "rendered", language: "zh" } });
    // A typed question needs the model.
    const typed = await post(`/api/sessions/${view.session}/ask`, { revision: view.revision + 1, person: "P1", question: "Where were you?" }, cookie);
    expect(((await typed.json()) as ApiError).error.code).toBe("model-off");
    // Read back by GET; a visitor without the cookie finds nothing.
    expect((await fetch(`${base}/api/sessions/${view.session}`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${base}/api/sessions/${view.session}`)).status).toBe(404);

    // What it kept is in Redis, under its own prefix.
    const { runner, close } = await connectRedis(redisUrl!);
    try {
      expect(Number(await runner.eval("return redis.call('EXISTS', KEYS[1])", [`${mine}:s:${view.session}`], []))).toBe(1);
      expect(Number(await runner.eval("return redis.call('ZCARD', KEYS[1])", [`${mine}:open`], []))).toBe(1);
    } finally {
      await close();
    }
    expect(errors()).toBe("");
  });
});
