import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { archivePass } from "../case/fixtures/archive";
import type { Case } from "../case/schema";
import { loadCase } from "../game/load-case";

/**
 * The cases a server offers: the handwritten case, and every case file in `dir` that passes
 * the gate (well formed, consistent, provable by a player). A file that does not pass is
 * left out and named in `skipped`, by file name only.
 *
 * Only whole-case files are read: "<id>.json". The writer's working files beside them
 * ("<id>.skeleton.json", "<id>.game.json" …) are not cases.
 */
export function loadLibrary(dir?: string): { cases: Case[]; skipped: string[] } {
  const cases: Case[] = [archivePass];
  const skipped: string[] = [];
  if (!dir) return { cases, skipped };
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^[a-z0-9-]+\.json$/.test(name)).sort();
  } catch {
    return { cases, skipped };
  }
  for (const name of names) {
    let loaded: ReturnType<typeof loadCase>;
    try {
      loaded = loadCase(readFileSync(join(dir, name), "utf8"));
    } catch {
      skipped.push(name);
      continue;
    }
    if (!loaded.ok || cases.some((c) => c.id === loaded.c.id)) skipped.push(name);
    else cases.push(loaded.c);
  }
  return { cases, skipped };
}
