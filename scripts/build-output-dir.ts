import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** What a build writes at the top of its output folder, and nothing else. */
export const OWNED = ["config.json", "functions", "static"] as const;

export type Refusal = "not-a-folder" | "not-empty" | "holds-other-files" | "not-a-build";

/**
 * Make the output folder ready for a build, without ever removing anything that is not this
 * project's own build output.
 *
 * A folder named by the person running the build is taken only if it does not exist or is
 * empty. Nothing in it is ever removed: what looks like an earlier build may be another
 * project's, or somebody's `config.json` that happens to say "version 3", and there is no
 * way to tell from here.
 *
 * The project's own default folder (`own`: `.vercel/output` inside this repository) is the
 * one place a build may write over: there, if the folder holds exactly what a build leaves
 * (nothing but `config.json`, `functions` and `static`, with a `config.json` that is a Build
 * Output file), those three are removed, and only those. If it holds anything else, that
 * too is refused.
 *
 * Every refusal comes before a single file is touched.
 */
export function prepareOutputDir(out: string, options: { own: boolean }): { ok: true } | { ok: false; why: Refusal } {
  if (!existsSync(out)) {
    mkdirSync(out, { recursive: true });
    return { ok: true };
  }
  if (!lstatSync(out).isDirectory()) return { ok: false, why: "not-a-folder" };
  const entries = readdirSync(out);
  if (entries.length === 0) return { ok: true };
  if (!options.own) return { ok: false, why: "not-empty" };
  if (entries.some((name) => !(OWNED as readonly string[]).includes(name))) return { ok: false, why: "holds-other-files" };
  let version: unknown;
  try {
    version = (JSON.parse(readFileSync(join(out, "config.json"), "utf8")) as { version?: unknown }).version;
  } catch {
    version = undefined;
  }
  if (version !== 3) return { ok: false, why: "not-a-build" };
  for (const name of OWNED) rmSync(join(out, name), { recursive: true, force: true });
  return { ok: true };
}
