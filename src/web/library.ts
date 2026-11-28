import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { archivePass } from "../case/fixtures/archive";
import type { Case } from "../case/schema";
import { loadCase } from "../game/load-case";
import { indexOf, replayOf } from "../../web/src/replay-shape";

/**
 * The cases a server offers: the handwritten case, and every case file in the folders given
 * that passes the gate (well formed, consistent, provable by a player). A file that does not
 * pass is left out and named in `skipped`, by file name only. The folders are read in the
 * order given, and a case is listed once: a file whose case is already listed is skipped.
 *
 * Only whole-case files are read: "<id>.json". The writer's working files beside them
 * ("<id>.skeleton.json", "<id>.game.json" …) are not cases.
 */
/** The names a replay folder's files may have: "index.json", or a replay's own name. */
const REPLAY_FILE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;
/** No replay is anywhere near this size. A larger file is not read. */
const MAX_REPLAY_BYTES = 5_000_000;

/** The parsed contents of an ordinary file in `dir`. Null for a link, a folder, a file too large, or one that is not JSON. */
function ownJson(dir: string, name: string): unknown {
  const path = join(dir, name);
  try {
    // Not followed if it is a link: a link in this folder could point anywhere.
    const found = lstatSync(path);
    if (!found.isFile() || found.size > MAX_REPLAY_BYTES) return null;
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * A file from the folder where replays wait to be looked at before they are published, for
 * a dev server to hand to the page. `name` is what came after the folder in the address.
 *
 * Three things must hold, or the answer is null:
 *   - the name is a plain replay file name: no slash, no dot but the one before "json", so
 *     nothing outside the folder can be asked for;
 *   - the file is an ordinary file in the folder, not a link;
 *   - its contents are what the name says. "index.json" must be a list of replays, and any
 *     other name must be a replay that list names, whole. A case file, or any other JSON
 *     that was copied here by mistake, is not handed out.
 *
 * What is returned is the checked contents written out again, not the file's own bytes.
 *
 * A replay gives away its case's answer. That is what a replay is; but it is why this
 * folder is not among the files a build publishes.
 */
export function previewReplayFile(dir: string, name: string): string | null {
  if (!REPLAY_FILE.test(name)) return null;
  const cards = indexOf(ownJson(dir, "index.json"));
  if (cards === null) return null;
  if (name === "index.json") return JSON.stringify({ version: 1, replays: cards });
  const id = name.slice(0, -".json".length);
  if (!cards.some((card) => card.id === id)) return null;
  const replay = replayOf(ownJson(dir, name), id);
  return replay === null ? null : JSON.stringify(replay);
}

export function loadLibrary(...dirs: string[]): { cases: Case[]; skipped: string[] } {
  const cases: Case[] = [archivePass];
  const skipped: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => /^[a-z0-9-]+\.json$/.test(name)).sort();
    } catch {
      // A folder that is not there offers nothing.
      continue;
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
  }
  return { cases, skipped };
}
