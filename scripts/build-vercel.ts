/**
 * Build what the host runs, in the layout it reads (Vercel's Build Output API, version 3).
 * 构建部署产物，按托管平台读取的目录结构（Vercel Build Output API 第 3 版）写出。
 *
 *   npm run build:vercel [-- --out <folder>]        default folder: .vercel/output
 *
 * A folder named with --out must be new or empty: nothing in it is ever removed. The default
 * folder, which is this project's own, is written over if it holds an earlier build's output
 * and nothing else. Anything else is refused, and nothing is touched.
 *
 *   <out>/config.json                     the routes: /api/* goes to the function, the rest is files
 *   <out>/static/                         the page, built by Vite. No case text is in it.
 *   <out>/functions/api.func/index.mjs    the game API, bundled into one file with all it imports
 *   <out>/functions/api.func/.vc-config.json
 *   <out>/functions/api.func/cases/released/   the released case files, read by the function
 *
 * The function is bundled here, not compiled by the host, so the file that is deployed is
 * the file that was tested: test/deployed.test.ts copies it out of the repository and runs
 * it with plain Node. Nothing is uploaded or deployed by this script.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "vite";
import { prepareOutputDir } from "./build-output-dir";
import { say } from "./say";

const args = process.argv.slice(2);
if (args.length !== 0 && !(args.length === 2 && args[0] === "--out" && args[1])) {
  say("Usage: npm run build:vercel [-- --out <folder>]. Nothing was built.", "用法：npm run build:vercel [-- --out <目录>]。没有构建任何内容。");
  process.exit(1);
}
const repo = resolve(import.meta.dirname, "..");
/** The project's own output folder: the one place a build may write over an earlier build. */
const own = join(repo, ".vercel/output");
const out = resolve(args[1] ?? own);
const func = join(out, "functions/api.func");

/** How long the host lets the function run. One question is at most three requests of a minute each. */
const MAX_DURATION_S = 200;

// A folder named on the command line must be new or empty. Only the project's own default
// folder is written over, and only when it holds nothing but an earlier build.
const ready = prepareOutputDir(out, { own: out === own });
if (!ready.ok) {
  const why = {
    "not-a-folder": ["it is not a folder", "它不是一个目录"],
    "not-empty": ["it is not empty, and a folder named with --out is never cleared", "它不是空的，而用 --out 指定的目录从不会被清空"],
    "holds-other-files": ["it holds files that are not a build's output", "里面有不属于构建产物的文件"],
    "not-a-build": ["what is in it is not an earlier build's output", "里面的内容不是之前的构建产物"],
  }[ready.why];
  say(`Not built: ${out} cannot be used, because ${why[0]}. Nothing was changed. Name a new or empty folder.`, `没有构建：不能使用 ${out}，因为${why[1]}。没有改动任何内容。请指定一个新的或空的目录。`);
  process.exit(1);
}
mkdirSync(func, { recursive: true });

// The page.
await build({ configFile: join(repo, "vite.config.ts"), logLevel: "warn", build: { outDir: join(out, "static"), emptyOutDir: true } });

// The function: one file, with everything it imports inside it, for Node.
await build({
  configFile: false,
  root: repo,
  logLevel: "warn",
  publicDir: false,
  ssr: { noExternal: true, target: "node" },
  build: {
    ssr: join(repo, "src/web/function.ts"),
    outDir: func,
    emptyOutDir: false,
    target: "node22",
    minify: false,
    copyPublicDir: false,
    rollupOptions: { output: { format: "esm", entryFileNames: "index.mjs", codeSplitting: false } },
  },
});

writeFileSync(join(func, ".vc-config.json"), `${JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false, shouldAddSourcemapSupport: false, maxDuration: MAX_DURATION_S }, null, 2)}\n`);

// The released cases go beside the function, where it looks for them.
const released = join(repo, "cases/released");
let cases = 0;
if (existsSync(released)) {
  mkdirSync(join(func, "cases/released"), { recursive: true });
  for (const name of readdirSync(released).filter((n) => /^[a-z0-9-]+\.json$/.test(n))) {
    cpSync(join(released, name), join(func, "cases/released", name));
    cases++;
  }
}

writeFileSync(join(out, "config.json"), `${JSON.stringify({ version: 3, routes: [{ src: "^/api(?:/.*)?$", dest: "/api" }, { handle: "filesystem" }] }, null, 2)}\n`);

say(`Built into ${out}: the page, the function, and ${cases} released case file(s). Nothing was deployed.`, `已构建到 ${out}：页面、函数，以及 ${cases} 个已发布的案件文件。没有部署任何内容。`);
