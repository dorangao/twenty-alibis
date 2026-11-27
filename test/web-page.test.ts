import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { archiveFailTwin, archivePass } from "../src/case/fixtures/archive";
import { noModel } from "../src/game/terminal";
import { MAX_BODY_BYTES, type ApiError, type CasesReply, type ViewReply } from "../src/web/api";
import { loadLibrary } from "../src/web/library";
import { nodeListener } from "../src/web/node";
import { memorySessions } from "../src/web/sessions";
import { compilePlot } from "../src/writer/compile";
import { lighthousePeople, lighthouseSkeleton } from "../src/writer/fixtures/lighthouse";
import { S } from "../web/src/strings";

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

  it("marks the cookie Secure when the proxy in front says the visitor used https", async () => {
    const origin = base.replace("http://", "https://");
    const started = await fetch(`${base}/api/sessions`, { method: "POST", headers: { origin, "x-forwarded-proto": "https" }, body: JSON.stringify({ caseId: lighthouse.id }) });
    expect(started.status).toBe(201);
    expect(started.headers.get("set-cookie")).toMatch(/; Secure$/);
  });

  it("refuses a body over the limit without keeping it", async () => {
    const r = await fetch(`${base}/api/sessions`, { method: "POST", headers: { origin: base }, body: JSON.stringify({ caseId: lighthouse.id, pad: "x".repeat(MAX_BODY_BYTES * 50) }) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as ApiError).error.code).toBe("bad-request");
  });
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
    const build = spawnSync("npx", ["vite", "build", "--outDir", out, "--emptyOutDir"], { encoding: "utf8", env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" } });
    expect(build.status, build.stderr).toBe(0);
    const files = readdirSync(join(out, "assets"));
    expect(files.some((name) => name.endsWith(".js"))).toBe(true);
    const bundle = [readFileSync(join(out, "index.html"), "utf8"), ...files.map((name) => readFileSync(join(out, "assets", name), "utf8"))].join("\n");
    for (const c of [archivePass, lighthouse]) {
      const secrets = [c.title.en, c.title.zh, c.setting.en, ...c.suspects.flatMap((s) => [s.name.en, s.name.zh]), ...c.evidence.flatMap((e) => [e.text.en, e.text.zh]), ...c.assertions.map((a) => a.id)];
      for (const secret of secrets) expect(bundle.includes(secret), `${c.id}: ${secret}`).toBe(false);
    }
    // The rules of proof come from the server too: the page does not carry a copy that could drift.
    expect(bundle).not.toContain("A room's record lists the people who were seen there.");
  }, 60_000);
});
