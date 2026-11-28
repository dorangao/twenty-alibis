import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createViteServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { archiveFailTwin, archivePass } from "../src/case/fixtures/archive";
import { noModel } from "../src/game/terminal";
import { MAX_BODY_BYTES, type ApiError, type CasesReply, type ViewReply } from "../src/web/api";
import { loadLibrary } from "../src/web/library";
import { lighthouseCase, lighthouseFileText, RELEASED_LIGHTHOUSE } from "../src/web/released";
import { bodyOf, nodeListener } from "../src/web/node";
import { memorySessions } from "../src/web/sessions";
import { compilePlot } from "../src/writer/compile";
import { lighthousePeople, lighthouseSkeleton } from "../src/writer/fixtures/lighthouse";
import { GOSSIP_LOOK_MS, GOSSIP_LOOKS, roundSummary, type Round } from "../web/src/gossip-text";
import { supersedes } from "../web/src/latest";
import { SESSION_LEASE_MS } from "../src/web/redis-sessions";
import { S, victimLine } from "../web/src/strings";

const built = compilePlot("lighthouse", lighthouseSkeleton, lighthousePeople);
if (!built.ok) throw new Error(built.problems.join("; "));
const lighthouse = built.case;

describe("the game API behind Node's http server", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const listener = nodeListener({ cases: [archivePass, lighthouse], sessions: memorySessions(), metered: noModel, modelOff: true });
    server = createServer((req, res) => void listener(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves a whole game over a real socket: the library, a session with its cookie, an action", async () => {
    const cases = (await (await fetch(`${base}/api/cases`)).json()) as CasesReply;
    expect(cases.cases.map((c) => c.id)).toEqual([archivePass.id, lighthouse.id]);

    const started = await fetch(`${base}/api/sessions`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ caseId: lighthouse.id }) });
    expect(started.status).toBe(201);
    expect(started.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(started.headers.get("cache-control")).toBe("no-store");
    const setCookie = started.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^ta_visitor=[0-9a-f]{64}; Path=\/api; HttpOnly; SameSite=Strict; Max-Age=604800$/);
    const cookie = setCookie.split(";")[0]!;
    const view = ((await started.json()) as ViewReply).view;

    const acted = await fetch(`${base}/api/sessions/${view.session}/inspect`, { method: "POST", headers: { origin: base, cookie }, body: JSON.stringify({ revision: view.revision, inspection: "I1" }) });
    expect(acted.status).toBe(200);
    expect(((await acted.json()) as ViewReply).view.actions.used).toBe(1);
    // Without the cookie the session is not there; from another origin the request is refused.
    expect((await fetch(`${base}/api/sessions/${view.session}`)).status).toBe(404);
    expect((await fetch(`${base}/api/sessions`, { method: "POST", headers: { origin: "http://elsewhere.example" }, body: JSON.stringify({ caseId: lighthouse.id }) })).status).toBe(403);
  });

  it("believes a forwarded scheme only when told it sits behind a proxy it trusts", async () => {
    const https = base.replace("http://", "https://");
    const forwarded = (origin: string) => fetch(`${base}/api/sessions`, { method: "POST", headers: { origin, "x-forwarded-proto": "https" }, body: JSON.stringify({ caseId: lighthouse.id }) });
    // Reached directly: any client can send that header, so it changes nothing. The origin is still http.
    expect((await forwarded(https)).status).toBe(403);
    const direct = await forwarded(base);
    expect(direct.status).toBe(201);
    expect(direct.headers.get("set-cookie")).not.toMatch(/Secure/);

    // Behind a trusted proxy the header is believed, and the cookie is marked Secure.
    const listener = nodeListener({ cases: [lighthouse], sessions: memorySessions(), metered: noModel, modelOff: true }, { trustProxy: true });
    const proxied = createServer((req, res) => void listener(req, res));
    await new Promise<void>((resolve) => proxied.listen(0, "127.0.0.1", resolve));
    const at = `127.0.0.1:${(proxied.address() as AddressInfo).port}`;
    try {
      const started = await fetch(`http://${at}/api/sessions`, { method: "POST", headers: { origin: `https://${at}`, "x-forwarded-proto": "https" }, body: JSON.stringify({ caseId: lighthouse.id }) });
      expect(started.status).toBe(201);
      expect(started.headers.get("set-cookie")).toMatch(/; Secure$/);
    } finally {
      await new Promise<void>((resolve) => proxied.close(() => resolve()));
    }
  });

  it("refuses a body over the limit without keeping it", async () => {
    const r = await fetch(`${base}/api/sessions`, { method: "POST", headers: { origin: base }, body: JSON.stringify({ caseId: lighthouse.id, pad: "x".repeat(MAX_BODY_BYTES * 50) }) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as ApiError).error.code).toBe("bad-request");
  });
});

describe("an upload that is too long, or not wanted", () => {
  /** A client that keeps sending a body with no declared length until the server hangs up. */
  async function endless(port: number, origin: string): Promise<number> {
    return new Promise<number>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      const chunk = "x".repeat(16_000);
      let sent = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pump = () => {
        if (socket.destroyed || sent >= 40_000_000) return;
        socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
        sent += chunk.length;
        timer = setTimeout(pump, 0);
      };
      socket.on("connect", () => {
        socket.write(`POST /api/sessions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nTransfer-Encoding: chunked\r\n\r\n`);
        pump();
      });
      socket.on("data", () => undefined);
      socket.on("error", () => undefined);
      socket.on("close", () => {
        clearTimeout(timer);
        resolve(sent);
      });
    });
  }

  it("the body is taken from its source a chunk at a time, only when asked for, and not at all once the reader stops", async () => {
    // A source of a thousand chunks that counts how many have been taken from it.
    let taken = 0;
    const source = Readable.from(
      (function* () {
        for (let i = 0; i < 1_000; i++) {
          taken++;
          yield Buffer.alloc(1_000, 120);
        }
      })(),
      { objectMode: false, highWaterMark: 1_000 },
    );
    const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
    const body = bodyOf(source);
    // Nobody is reading. Nothing flows: at most a chunk or two is waiting.
    await tick();
    expect(taken).toBeLessThanOrEqual(4);
    const reader = body.getReader();
    expect((await reader.read()).value!.byteLength).toBe(1_000);
    expect((await reader.read()).value!.byteLength).toBe(1_000);
    await tick();
    const whenStopped = taken;
    expect(whenStopped).toBeLessThanOrEqual(8);
    // The reader has had enough. Nothing more is taken, however long we wait.
    await reader.cancel();
    await tick();
    await tick();
    expect(taken).toBe(whenStopped);
    // It listens to its source no longer.
    expect([source.listenerCount("data"), source.listenerCount("end"), source.listenerCount("error")]).toEqual([0, 0, 0]);
    source.destroy();
  });

  it("the body's ending is told once: an end or an error after the reader has stopped, or twice, does no harm", async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
    // Stopped by the reader, then the source ends and errors anyway.
    const stopped = new Readable({ read() {} });
    const reader = bodyOf(stopped).getReader();
    stopped.push(Buffer.from("abc"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("abc");
    await reader.cancel();
    await reader.cancel();
    stopped.on("error", () => undefined);
    stopped.emit("end");
    stopped.emit("end");
    stopped.emit("error", new Error("late"));
    await tick();
    expect([stopped.listenerCount("data"), stopped.listenerCount("end")]).toEqual([0, 0]);

    // Ended normally: the reader sees the end once, and a second end is ignored.
    const ended = new Readable({ read() {} });
    const whole = bodyOf(ended).getReader();
    ended.push(Buffer.from("xyz"));
    ended.push(null);
    expect(new TextDecoder().decode((await whole.read()).value)).toBe("xyz");
    expect((await whole.read()).done).toBe(true);
    ended.emit("end");
    await tick();
    expect(ended.listenerCount("end")).toBe(0);

    // Broken: the reader is told of the error once.
    const broken = new Readable({ read() {} });
    const failing = bodyOf(broken).getReader();
    const outcome = failing.read().then(
      () => "read",
      (error: Error) => error.message,
    );
    broken.destroy(new Error("socket hung up"));
    expect(await outcome).toBe("socket hung up");
    broken.on("error", () => undefined);
    broken.emit("error", new Error("again"));
    await tick();
  });

  it("is taken in no further than the handler reads: cut off at the limit, and not read at all from the wrong origin", async () => {
    const seen: { status: number; bytesRead: number }[] = [];
    const listener = nodeListener({ cases: [archivePass], sessions: memorySessions(), metered: noModel, modelOff: true });
    const server = createServer((req, res) => {
      res.on("finish", () => seen.push({ status: res.statusCode, bytesRead: req.socket.bytesRead }));
      void listener(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      // From the game's own origin: the handler reads up to its 4,000 bytes, refuses, and the server hangs up.
      const tried = await endless(port, `http://127.0.0.1:${port}`);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.status).toBe(400);
      // The client would have gone on to 40 MB. The server took a socket buffer or two, not megabytes.
      expect(seen[0]!.bytesRead).toBeLessThan(300_000);
      expect(tried).toBeLessThan(40_000_000);
      // From another origin: refused on its headers. The body is not read.
      await endless(port, "http://elsewhere.example");
      expect(seen).toHaveLength(2);
      expect(seen[1]!.status).toBe(403);
      expect(seen[1]!.bytesRead).toBeLessThan(300_000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});

describe("the dev server hands out the page, and nothing else in the checkout", () => {
  it("refuses case files, traces, the server's source and the tests, however they are asked for", async () => {
    // Its own cache folder, so running the tests does not disturb a dev server that is already up.
    const dev = await createViteServer({ configFile: "vite.config.ts", logLevel: "silent", cacheDir: mkdtempSync(join(tmpdir(), "vite-cache-")), server: { port: 0, host: "127.0.0.1", strictPort: false } });
    await dev.listen();
    const base = `http://127.0.0.1:${(dev.httpServer!.address() as AddressInfo).port}`;
    const repo = process.cwd();
    try {
      // The page and its own source are served, and so is the game API.
      expect((await fetch(`${base}/`)).status).toBe(200);
      const main = await fetch(`${base}/src/main.tsx`);
      expect(main.status).toBe(200);
      expect(await main.text()).toContain("createRoot");
      expect((await fetch(`${base}/api/cases`)).status).toBe(200);
      // Files that exist in every checkout stand in for the ones that must not get out: the handwritten
      // case's source holds its answer, and package.json sits where a case folder would.
      const outside = ["src/case/fixtures/archive.ts", "src/web/api.ts", "test/web-page.test.ts", "scripts/pilot.ts", "package.json", "vite.config.ts"];
      const secret = /culprit|"devDependencies"|createRuntime|defineConfig/;
      for (const file of outside) {
        for (const ask of [`/@fs${repo}/${file}`, `/@fs${repo}/${file}?raw`, `/@fs${repo}/${file}?import`, `/@fs${repo}/${file}?url`, `/@fs/${repo}/web/../${file}`]) {
          const r = await fetch(`${base}${ask}`);
          const body = await r.text();
          expect(r.status, ask).toBe(403);
          expect(body, ask).not.toMatch(secret);
        }
        // Asked for by climbing out of the page's folder: the page itself comes back, never the file.
        const climbed = await (await fetch(`${base}/../${file}`)).text();
        expect(climbed, file).not.toMatch(secret);
      }
      // The published replays are files beside the page. The ones that wait to be looked at are
      // handed out by plain file name only: nothing else can be reached through that address.
      const replays = await fetch(`${base}/replays/index.json`);
      expect(replays.status).toBe(200);
      expect(((await replays.json()) as { replays: { id: string }[] }).replays.map((r) => r.id)).toEqual(["lighthouse"]);
      for (const name of ["..%2F..%2F..%2Fpackage.json", "%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json", "..%2Fpilot-a-1.json", "deeper/x.json", "notes.txt", "package.json", ""]) {
        const r = await fetch(`${base}/replays/preview/${name}`);
        const body = await r.text();
        expect(r.status, name).toBe(404);
        expect(body, name).toBe("{}");
      }
      expect((await fetch(`${base}/replays/preview/index.json`, { method: "POST" })).status).toBe(404);
      // The policy itself, as the server resolved it.
      const fs = dev.config.server.fs;
      expect(fs.strict).toBe(true);
      expect(fs.allow.some((dir) => dir === repo || repo.startsWith(`${dir}/`) || dir === "/")).toBe(false);
      expect(fs.allow.some((dir) => dir.endsWith("/web"))).toBe(true);
      for (const dir of ["cases", "traces", "src", "test", "scripts"]) expect(fs.deny).toContain(`${repo}/${dir}/**`);
    } finally {
      await dev.close();
    }
  }, 60_000);
});

describe("starting the dev server", () => {
  it("names its config, so a cold start in a checkout without one stops instead of serving the folder", () => {
    // Vite started without a config serves the folder it is in, all of it. That is what happens
    // if the config is merely looked for and is not there, as on a commit from before the page.
    const scripts = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts.dev).toMatch(/\bvite --config vite\.config\.ts\b/);
    expect(scripts["build:web"]).toMatch(/\bvite build --config vite\.config\.ts\b/);
    // In a folder with no config, holding one harmless file: the named config is missing, and Vite refuses to start.
    const empty = mkdtempSync(join(tmpdir(), "no-config-"));
    writeFileSync(join(empty, "sentinel.txt"), "harmless");
    const vite = join(process.cwd(), "node_modules/.bin/vite");
    const run = spawnSync(vite, ["--config", "vite.config.ts", "--port", "0"], { cwd: empty, encoding: "utf8", timeout: 20_000, env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" } });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1);
    // It stopped because the config it was told to use is not there, and it never listened.
    const said = `${run.stdout}${run.stderr}`;
    expect(said).toContain("failed to load config from");
    expect(said).toContain("vite.config.ts");
    expect(said).not.toMatch(/Local:\s+http/);
  }, 30_000);
});

describe("the cases a local server offers", () => {
  it("is the handwritten case, plus every case file in the folder that passes the gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "library-"));
    writeFileSync(join(dir, "good-case.json"), JSON.stringify({ accepted: true, case: lighthouse }));
    // A second copy of the same case, a case no player could prove, something that is not a case, and the writer's working files.
    writeFileSync(join(dir, "same-again.json"), JSON.stringify(lighthouse));
    writeFileSync(join(dir, "unprovable.json"), JSON.stringify({ accepted: true, case: archiveFailTwin }));
    writeFileSync(join(dir, "junk.json"), "not json");
    writeFileSync(join(dir, "good-case.skeleton.json"), JSON.stringify(lighthouse));
    writeFileSync(join(dir, "good-case.g2.game.json"), JSON.stringify(lighthouse));
    writeFileSync(join(dir, "notes.txt"), "hello");
    const library = loadLibrary(dir);
    expect(library.cases.map((c) => c.id)).toEqual([archivePass.id, lighthouse.id]);
    // Left out, by file name only: nothing of why, which could name the case's people.
    expect(library.skipped).toEqual(["junk.json", "same-again.json", "unprovable.json"]);
  });

  it("is the handwritten case alone when there is no folder", () => {
    expect(loadLibrary().cases.map((c) => c.id)).toEqual([archivePass.id]);
    expect(loadLibrary("/no/such/folder")).toEqual({ cases: [archivePass], skipped: [] });
  });

  it("reads several folders in the order given, and lists a case once", () => {
    const first = mkdtempSync(join(tmpdir(), "library-a-"));
    const second = mkdtempSync(join(tmpdir(), "library-b-"));
    writeFileSync(join(first, "lighthouse.json"), JSON.stringify(lighthouse));
    // The same case again under another file name, and a case of its own.
    writeFileSync(join(second, "copy.json"), JSON.stringify(lighthouse));
    writeFileSync(join(second, "mine.json"), JSON.stringify({ ...archivePass, id: "mine" }));
    const library = loadLibrary(first, "/no/such/folder", second);
    expect(library.cases.map((c) => c.id)).toEqual([archivePass.id, lighthouse.id, "mine"]);
    expect(library.skipped).toEqual(["copy.json"]);
  });
});

describe("the released lighthouse", () => {
  const repo = join(import.meta.dirname, "..");

  it("is the handwritten plot, compiled today: the file in the repository cannot drift from it", () => {
    // If this fails after a change to the plot or to the code that compiles it: npm run release:lighthouse
    expect(readFileSync(join(repo, RELEASED_LIGHTHOUSE), "utf8")).toBe(lighthouseFileText());
    expect(lighthouseCase()).toEqual(lighthouse);
  });

  it("is the one case in the released folder, and passes the gate a server puts it through", () => {
    const library = loadLibrary(join(repo, "cases/released"));
    expect(library.skipped).toEqual([]);
    expect(library.cases.map((c) => c.id)).toEqual([archivePass.id, "lighthouse"]);
    expect(library.cases[1]).toEqual(lighthouse);
    expect(library.cases[1]!.suspects).toHaveLength(20);
    // Releasing a case is a person's decision, one case at a time: nothing else is in the folder.
    expect(readdirSync(join(repo, "cases/released")).sort()).toEqual(["README.md", "lighthouse.json"]);
  });
});

describe("the page", () => {
  const sources = readdirSync("web/src").filter((name) => /\.tsx?$/.test(name));

  it("imports the server's code for its types only, so no case can be bundled into it", () => {
    expect(sources.length).toBeGreaterThan(3);
    for (const name of sources) {
      const text = readFileSync(join("web/src", name), "utf8");
      for (const line of text.split("\n")) {
        // Any import that leaves web/ must be `import type`.
        if (/from\s+"\.\.\/\.\.\//.test(line)) expect(line, `${name}: ${line}`).toMatch(/^import type /);
      }
      expect(text, name).not.toMatch(/import\(\s*"\.\.\/\.\.\//);
      expect(text, name).not.toMatch(/require\(/);
    }
  });

  it("shows a view only if it is not older than the one on screen: answers can arrive out of order", () => {
    const at = (session: string, revision: number) => ({ session, revision });
    // Nothing on screen yet, or another game: always shown.
    expect(supersedes(null, at("a", 1))).toBe(true);
    expect(supersedes(at("a", 7), at("b", 1))).toBe(true);
    // The same game: newer and equal are shown, older is not.
    expect(supersedes(at("a", 2), at("a", 3))).toBe(true);
    expect(supersedes(at("a", 2), at("a", 2))).toBe(true);
    expect(supersedes(at("a", 3), at("a", 2))).toBe(false);
    expect(supersedes(at("a", 3), at("a", 1))).toBe(false);
  });

  it("says of a gossip round only what happened in it: who picked, who told nobody, and what is unconfirmed", () => {
    const talk = (by: "code" | "model") => ({ from: "P1", to: "P2", by });
    const round = (over: Partial<Round>): Round => ({ n: 1, after: 4, state: "done", chosenBy: "model", talks: [], asked: 0, requests: 0, nano: 0, unconfirmed: 0, ...over });
    // Model off: code picked, and says so. With nobody told there is nothing to say.
    expect(roundSummary("en", round({ chosenBy: "code", talks: [talk("code"), talk("code")] }))).toEqual(["Code chose who was told. Nothing was sent."]);
    expect(roundSummary("zh", round({ chosenBy: "code", talks: [talk("code")] }))).toEqual(["由代码决定告诉谁。没有发送请求。"]);
    expect(roundSummary("en", round({ chosenBy: "code" }))).toEqual([]);
    // Every agent chose.
    expect(roundSummary("en", round({ asked: 3, requests: 3, talks: [talk("model"), talk("model"), talk("model")] }))).toEqual(["3 speakers' agents chose whom to tell."]);
    // A mixed round: one chose, one had a single candidate, two could not ask, one request unconfirmed.
    const mixed = round({ asked: 3, requests: 2, unconfirmed: 1, talks: [talk("model"), talk("code")] });
    expect(roundSummary("en", mixed)).toEqual([
      "1 speaker's agent chose whom to tell.",
      "1 had one person left to tell, and code told them.",
      "2 were to ask their agent and told nobody: the model could not be used, or its answer could not be. Code does not pick for them.",
      "1 request went out with its cost unconfirmed. What it cost, if anything, is counted on the server and is not in the page's total.",
    ]);
    expect(roundSummary("zh", mixed)).toEqual([
      "1 位说话者的智能体自己决定了告诉谁。",
      "1 位只剩一个人可告诉，由代码告诉了那个人。",
      "2 位本该由智能体来选，但没能选成（模型用不了，或回复不可用），所以谁也没告诉。代码不会替它们选。",
      "有 1 次请求已经发出，但费用未确认。它们如果产生了费用，由服务器计入，不在页面的合计里。",
    ]);
    // Nobody is credited with a choice when none was accepted, in either language.
    for (const lang of ["en", "zh"] as const) {
      for (const none of [round({ asked: 4 }), round({ asked: 2, requests: 2, unconfirmed: 2 }), round({ asked: 1, talks: [talk("code")] })]) {
        expect(roundSummary(lang, none).join(" ")).not.toMatch(/chose whom to tell|自己决定了告诉谁/);
      }
    }
    // The page looks at a round someone else is running for longer than a lost server holds the game, then stops.
    expect(GOSSIP_LOOKS * GOSSIP_LOOK_MS).toBeGreaterThan(SESSION_LEASE_MS);
    expect(GOSSIP_LOOKS).toBeLessThanOrEqual(30);
  });

  it("says where the body was found when that is not where the victim died", () => {
    const name = { en: "Dr. Chen", zh: "陈医生" };
    const lamp = { en: "Lamp Room", zh: "灯室" };
    const cellar = { en: "Cellar", zh: "地窖" };
    const same = { name, died: { slot: "21:00", room: lamp }, found: { slot: "21:20", room: lamp } };
    const moved = { ...same, found: { slot: "21:20", room: cellar } };
    expect(victimLine("en", same)).toBe("Dr. Chen died at 21:00 in the lamp room and was found at 21:20.");
    expect(victimLine("zh", same)).toBe("陈医生于 21:00 死在灯室，21:20 被发现。");
    expect(victimLine("en", moved)).toBe("Dr. Chen died at 21:00 in the lamp room and was found in the cellar at 21:20.");
    expect(victimLine("zh", moved)).toBe("陈医生于 21:00 死在灯室，21:20 在地窖被发现。");
  });

  it("says everything in both languages", () => {
    const cjk = /[一-鿿]/;
    for (const [key, text] of Object.entries(S)) {
      expect(text.en.trim().length, key).toBeGreaterThan(0);
      expect(text.zh.trim().length, key).toBeGreaterThan(0);
      // The language switch names the other language in that language; everything else is in its own.
      if (key === "language") continue;
      expect(text.en, key).not.toMatch(cjk);
      expect(text.zh, key).toMatch(cjk);
    }
  });

  it("builds, and the built files hold no case: no title, no person, no record", () => {
    const out = mkdtempSync(join(tmpdir(), "page-"));
    const build = spawnSync("npx", ["vite", "build", "--config", "vite.config.ts", "--outDir", out, "--emptyOutDir"], { encoding: "utf8", env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" } });
    expect(build.status, build.stderr).toBe(0);
    const files = readdirSync(join(out, "assets"));
    expect(files.some((name) => name.endsWith(".js"))).toBe(true);
    const bundle = [readFileSync(join(out, "index.html"), "utf8"), ...files.map((name) => readFileSync(join(out, "assets", name), "utf8"))].join("\n");
    for (const c of [archivePass, lighthouse]) {
      const secrets = [c.title.en, c.title.zh, c.setting.en, ...c.suspects.flatMap((s) => [s.name.en, s.name.zh]), ...c.evidence.flatMap((e) => [e.text.en, e.text.zh]), ...c.assertions.map((a) => a.id)];
      for (const secret of secrets) expect(bundle.includes(secret), `${c.id}: ${secret}`).toBe(false);
    }
    // The published replays go out with the page, as files of their own; the ones that wait to be looked at do not.
    expect(readdirSync(join(out, "replays")).sort()).toEqual(["index.json", "lighthouse.json"]);
    // The rules of proof come from the server too: the page does not carry a copy that could drift.
    expect(bundle).not.toContain("A room's record lists the people who were seen there.");
  }, 60_000);
});
