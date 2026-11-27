import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cardOf, REPLAY_VERSION, type Replay, type ReplayCard, type ReplayIndex } from "../src/web/replay";

/** A replay as the text of its file: one frame to a line, so a change to one frame is one changed line. */
export function replayText(replay: Replay): string {
  const { frames, ...head } = replay;
  const open = JSON.stringify(head).slice(0, -1);
  return `${open},"frames":[\n${frames.map((frame) => JSON.stringify(frame)).join(",\n")}\n]}\n`;
}

export function indexText(index: ReplayIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

/**
 * Put a replay in a folder of replays: its own file, "<id>.json", and its line in the
 * folder's "index.json", which is what a page reads to list them. Two files are written and
 * nothing else in the folder is touched. A replay with the same id is replaced. If the
 * folder's index is there and is not a replay index, nothing is written.
 */
export function writeReplay(dir: string, replay: Replay): { ok: true; files: string[] } | { ok: false; why: "bad-index" } {
  const indexPath = join(dir, "index.json");
  let cards: ReplayCard[] = [];
  if (existsSync(indexPath)) {
    let index: Partial<ReplayIndex> | null;
    try {
      index = JSON.parse(readFileSync(indexPath, "utf8")) as Partial<ReplayIndex> | null;
    } catch {
      index = null;
    }
    if (!index || index.version !== REPLAY_VERSION || !Array.isArray(index.replays)) return { ok: false, why: "bad-index" };
    cards = index.replays;
  }
  cards = [...cards.filter((card) => card.id !== replay.id), cardOf(replay)].sort((a, b) => a.id.localeCompare(b.id));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${replay.id}.json`);
  writeFileSync(file, replayText(replay));
  writeFileSync(indexPath, indexText({ version: REPLAY_VERSION, replays: cards }));
  return { ok: true, files: [file, indexPath] };
}
