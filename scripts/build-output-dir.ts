import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** What a build writes at the top of its output folder, and nothing else. */
export const OWNED = ["config.json", "functions", "static"] as const;

/**
 * Make the output folder ready for a build, without ever removing anything that is not a
 * build's own.
 *
 * The folder is taken if it does not exist, if it is empty, or if it holds exactly what an
 * earlier build left: nothing but `config.json`, `functions` and `static`, with a
 * `config.json` that is a Build Output file. In that last case those three are removed, and
 * only those. Anything else is refused before a single file is touched: a folder that holds
 * other things is somebody's work, whatever name it was given on the command line.
 */
export function prepareOutputDir(out: string): { ok: true } | { ok: false; why: "not-a-folder" | "holds-other-files" | "not-a-build" } {
  if (!existsSync(out)) {
    mkdirSync(out, { recursive: true });
    return { ok: true };
  }
  if (!lstatSync(out).isDirectory()) return { ok: false, why: "not-a-folder" };
  const entries = readdirSync(out);
  if (entries.length === 0) return { ok: true };
  if (entries.some((name) => !(OWNED as readonly string[]).includes(name))) return { ok: false, why: "holds-other-files" };
  // Only a build's own names are here. It is an earlier build if its config file says so.
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
