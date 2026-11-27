import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareOutputDir } from "../scripts/build-output-dir";
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

const prefix = redisRun();

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
  const LIMIT = usdToNano(2.5);
  /** A snapshot of the envelope: its totals, and the limit fixed in Redis. */
  const snap = (totals: Partial<EnvelopeTotals> = {}, limitNano = LIMIT) => async () => ({ totals: { ...open, ...totals }, limitNano });
  const parts = (model: Partial<NonNullable<DeployedParts["model"]>> | null, now?: () => number): DeployedParts => ({
    cases: [archivePass],
    redis: down,
    origin: "https://game.test",
    limits: DEFAULT_LIMITS,
    prefix: "ta-test-unused",
    model: model === null ? null : { metered, snapshot: snap(), limitNano: LIMIT, disabled: () => false, settle: async () => undefined, ...model },
    ...(now ? { now } : {}),
  });
  const model = async (api: (request: Request) => Promise<Response>): Promise<string> => ((await (await api(new Request("https://game.test/api/cases"))).json()) as CasesReply).model;
  const begin = (api: (request: Request) => Promise<Response>) => api(new Request("https://game.test/api/sessions", { method: "POST", headers: { origin: "https://game.test" }, body: JSON.stringify({ caseId: archivePass.id }) }));

  it("is on only with a key, the switch off, paid requests authorized, no suspension, and room for one more request", async () => {
    expect(await model(deployedApi(parts({})))).toBe("on");
    expect(await model(deployedApi(parts(null)))).toBe("off");
    expect(await model(deployedApi(parts({ disabled: () => true })))).toBe("off");
    expect(await model(deployedApi(parts({ snapshot: snap({ paidAllowed: null }) })))).toBe("off");
    expect(await model(deployedApi(parts({ snapshot: snap({ suspended: "a reply cost more than its hold" }) })))).toBe("off");
    expect(await model(deployedApi(parts({ snapshot: async () => Promise.reject(new Error("the envelope is not initialized")) })))).toBe("off");
    // Room: the envelope must be able to hold one request at its worst case, about 31 cents.
    expect(await model(deployedApi(parts({ snapshot: snap({ committedNano: usdToNano(2.1) }) })))).toBe("on");
    expect(await model(deployedApi(parts({ snapshot: snap({ committedNano: usdToNano(2.3) }) })))).toBe("off");
  });

  it("judges room by the limit in force: the smaller of the configured one and the one fixed in Redis, as the guard does", async () => {
    const spent = { committedNano: usdToNano(0.8) };
    // Configured for 2.50, but the envelope was made with 1.00: 20 cents are left, not room for a request.
    expect(await model(deployedApi(parts({ snapshot: snap(spent, usdToNano(1)) })))).toBe("off");
    // Configured lower than the envelope was made with: the lower one counts too.
    expect(await model(deployedApi(parts({ limitNano: usdToNano(1), snapshot: snap(spent, usdToNano(2.5)) })))).toBe("off");
    // Both leave room.
    expect(await model(deployedApi(parts({ limitNano: usdToNano(2), snapshot: snap(spent, usdToNano(2.5)) })))).toBe("on");
    expect(await model(deployedApi(parts({ limitNano: usdToNano(2.5), snapshot: snap(spent, usdToNano(2)) })))).toBe("on");
  });

  it("for a request that only reads, asks the counter at most once in five seconds, and the server's own switch every time", async () => {
    let clock = 0;
    let asked = 0;
    let totals: Partial<EnvelopeTotals> = {};
    let disabled = false;
    const api = deployedApi(parts({ snapshot: async () => (asked++, { totals: { ...open, ...totals }, limitNano: LIMIT }), disabled: () => disabled }, () => clock));
    expect(await model(api)).toBe("on");
    totals = { paidAllowed: null };
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

  it("for a request that changes something, asks the counter afresh every time, and what it learns is what reads are then told", async () => {
    let asked = 0;
    let totals: Partial<EnvelopeTotals> = {};
    const api = deployedApi(parts({ snapshot: async () => (asked++, { totals: { ...open, ...totals }, limitNano: LIMIT }) }, () => 0));
    expect(await model(api)).toBe("on");
    expect(asked).toBe(1);
    totals = { paidAllowed: null };
    // Redis is out of reach in this test, so no game starts; the counter was asked all the same.
    expect((await begin(api)).status).toBe(500);
    expect(asked).toBe(2);
    expect((await begin(api)).status).toBe(500);
    expect(asked).toBe(3);
    // A read right after, with the clock where it was, is told what the last fresh look found.
    expect(await model(api)).toBe("off");
    expect(asked).toBe(3);
  });

  it.skipIf(!redisUrl)("a new game's mode is decided on what is true when it starts, not on what was true up to five seconds before", async () => {
    const { runner, close } = await connectRedis(redisUrl!);
    try {
      let totals: Partial<EnvelopeTotals> = {};
      const provider = new FakeProvider(wellBehaved);
      const live = createMetered({ inputBound: { tokensPerByte: 100 }, provider, store: new MemorySpendStore(), envelope: "e", limitNano: usdToNano(1) });
      const api = deployedApi({ ...parts({ metered: live, snapshot: async () => ({ totals: { ...open, ...totals }, limitNano: LIMIT }) }, () => 0), redis: runner, prefix: `${prefix}:fresh-${randomUUID()}` });
      const start = async () => {
        const r = await begin(api);
        return { view: ((await r.json()) as ViewReply).view, cookie: r.headers.get("set-cookie")!.split(";")[0]! };
      };
      // The library was shown with the model on. Then paid requests are closed. The clock does not move.
      expect(await model(api)).toBe("on");
      totals = { paidAllowed: null };
      const closed = await start();
      expect(closed.view.model).toBe("off");
      // Reopened: that game stays off for good, and sends nothing when asked in the player's own words.
      totals = {};
      const typed = await api(new Request(`https://game.test/api/sessions/${closed.view.session}/ask`, { method: "POST", headers: { origin: "https://game.test", cookie: closed.cookie }, body: JSON.stringify({ revision: closed.view.revision, person: "P1", question: "Where were you at nine?" }) }));
      expect(((await typed.json()) as ApiError).error.code).toBe("model-off");
      expect(provider.dispatched).toBe(0);
      // And a game begun now is live at once, though a read a moment ago was told "off".
      expect((await start()).view.model).toBe("on");
    } finally {
      await close();
    }
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
    const start = await begin(api);
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

describe("the folder a build writes into", () => {
  const dirs: string[] = [];
  const fresh = () => {
    const dir = mkdtempSync(join(tmpdir(), "ta-out-"));
    dirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const tree = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
  /** What an earlier build leaves. */
  const built = (out: string) => {
    mkdirSync(join(out, "static/assets"), { recursive: true });
    mkdirSync(join(out, "functions/api.func"), { recursive: true });
    writeFileSync(join(out, "static/assets/old.js"), "old");
    writeFileSync(join(out, "functions/api.func/index.mjs"), "old");
    writeFileSync(join(out, "config.json"), JSON.stringify({ version: 3, routes: [] }));
  };

  it("takes a folder that does not exist yet, and one that is empty, whoever named it", () => {
    for (const own of [false, true]) {
      const parent = fresh();
      expect(prepareOutputDir(join(parent, "new/deeper"), { own })).toEqual({ ok: true });
      expect(existsSync(join(parent, "new/deeper"))).toBe(true);
      expect(prepareOutputDir(fresh(), { own })).toEqual({ ok: true });
    }
  });

  it("never removes anything from a folder that was named on the command line, whatever it looks like", () => {
    const cases: [string, (out: string) => void][] = [
      ["somebody's work", (out) => (mkdirSync(join(out, "notes")), writeFileSync(join(out, "notes/draft.md"), "three days of work"))],
      // A config file of another program that happens to say "version 3", and nothing else.
      ["a foreign version-3 config", (out) => writeFileSync(join(out, "config.json"), JSON.stringify({ version: 3, database: "prod" }))],
      // Another project's build output, in exactly the layout this build writes.
      ["another project's build", built],
      ["an empty file", (out) => writeFileSync(join(out, ".keep"), "")],
    ];
    for (const [what, fill] of cases) {
      const out = fresh();
      fill(out);
      const before = tree(out);
      const contents = before.filter((f) => lstatSync(join(out, f)).isFile()).map((f) => readFileSync(join(out, f), "utf8"));
      expect(prepareOutputDir(out, { own: false }), what).toEqual({ ok: false, why: "not-empty" });
      expect(tree(out), what).toEqual(before);
      expect(before.filter((f) => lstatSync(join(out, f)).isFile()).map((f) => readFileSync(join(out, f), "utf8")), what).toEqual(contents);
    }
  });

  it("in the project's own folder, takes an earlier build's output and removes that, and only that", () => {
    const out = fresh();
    built(out);
    expect(prepareOutputDir(out, { own: true })).toEqual({ ok: true });
    expect(tree(out)).toEqual([]);
  });

  it("even in the project's own folder, refuses if anything else is there, and touches nothing", () => {
    for (const withBuild of [false, true]) {
      const out = fresh();
      mkdirSync(join(out, "notes"));
      writeFileSync(join(out, "notes/draft.md"), "three days of work");
      if (withBuild) built(out);
      const before = tree(out);
      expect(prepareOutputDir(out, { own: true }), String(withBuild)).toEqual({ ok: false, why: "holds-other-files" });
      expect(tree(out)).toEqual(before);
      expect(readFileSync(join(out, "notes/draft.md"), "utf8")).toBe("three days of work");
    }
    // Only a build's names, but no build's config file: not a build.
    for (const config of [undefined, "{not json", JSON.stringify({ version: 2 }), JSON.stringify({ name: "my-app" }), "null"]) {
      const out = fresh();
      mkdirSync(join(out, "static"));
      writeFileSync(join(out, "static/thesis.pdf"), "kept in a folder called static");
      if (config !== undefined) writeFileSync(join(out, "config.json"), config);
      const before = tree(out);
      expect(prepareOutputDir(out, { own: true }), String(config)).toEqual({ ok: false, why: "not-a-build" });
      expect(tree(out)).toEqual(before);
    }
  });

  it("refuses a path that is a file", () => {
    for (const own of [false, true]) {
      const file = join(fresh(), "output");
      writeFileSync(file, "a file");
      expect(prepareOutputDir(file, { own })).toEqual({ ok: false, why: "not-a-folder" });
      expect(readFileSync(file, "utf8")).toBe("a file");
    }
  });

  it("the build command refuses a folder named with --out that is not empty, before it builds anything, and says so in both languages", () => {
    for (const fill of [(out: string) => writeFileSync(join(out, "keep.txt"), "mine"), (out: string) => writeFileSync(join(out, "config.json"), JSON.stringify({ version: 3 })), built]) {
      const out = fresh();
      fill(out);
      const before = tree(out);
      const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/build-vercel.ts", "--out", out], { cwd: repo, encoding: "utf8", env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" } });
      expect(run.status).toBe(1);
      expect(run.stdout).toContain("Nothing was changed");
      expect(run.stdout).toContain("没有改动任何内容");
      expect(tree(out)).toEqual(before);
    }
  });

  it("the build command treats only the repository's own .vercel/output as its own", () => {
    const script = readFileSync(join(repo, "scripts/build-vercel.ts"), "utf8");
    expect(script).toContain('const own = join(repo, ".vercel/output");');
    expect(script).toContain("prepareOutputDir(out, { own: out === own })");
  });
});

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
    // The published replays are among the page's files: they play with the function gone.
    expect(readdirSync(join(out, "static/replays")).sort()).toEqual(["index.json", "lighthouse.json"]);
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
