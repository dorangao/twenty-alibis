import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cardOf, REPLAY_VERSION, type Replay, type ReplayCard, type ReplayIndex } from "../src/web/replay";
import { indexOf, isReplayId, replayOf } from "../web/src/replay-shape";

/** A replay as the text of its file: one frame to a line, so a change to one frame is one changed line. */
export function replayText(replay: Replay): string {
  const { frames, ...head } = replay;
  const open = JSON.stringify(head).slice(0, -1);
  return `${open},"frames":[\n${frames.map((frame) => JSON.stringify(frame)).join(",\n")}\n]}\n`;
}

export function indexText(index: ReplayIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

export type WriteRefusal =
  /** The replay is not whole, or its name is not a replay's name ("index" is the list's). */
  | "bad-replay"
  /** The folder's index.json is there and is not a list of replays. */
  | "bad-index"
  /** A file with the replay's name is there and is not an earlier version of this replay. */
  | "not-a-replay"
  /** Another run is writing to this folder right now. */
  | "busy";

/** A file that is there, an ordinary file, and whose contents parse. Undefined when it is not there. */
function readOwn(path: string): { data: unknown } | "not-a-file" | undefined {
  if (!existsSync(path) && !isLink(path)) return undefined;
  if (!lstatSync(path).isFile()) return "not-a-file";
  try {
    return { data: JSON.parse(readFileSync(path, "utf8")) as unknown };
  } catch {
    return { data: undefined };
  }
}
const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** What the writer does to the disk when it puts its files in place. A test can stand in for it. */
export interface PublishIo {
  rename(from: string, to: string): void;
}

/** The name of the file that says a run is writing to a folder. */
export const LOCK = ".replays.lock";

/**
 * Put a replay in a folder of replays: its own file, "<id>.json", and its line in the
 * folder's "index.json", which is what a page reads to list them.
 *
 * It writes over a file only if that file is its own: an earlier version of the same
 * replay, or the folder's list of replays. A case file that happens to have the replay's
 * name, a link, or an index.json that belongs to something else is left alone, and then
 * nothing at all is written. Every check comes before the first write.
 *
 * The new files are written whole in a folder of this run's own, made for it under a name
 * nothing else has, and then moved into place, the replay first and the list last: a reader
 * never sees half a file, and the list never names a replay that is not there yet. That
 * folder is the only thing this run ever removes. Whatever else is in the replays folder,
 * whatever it is called, is not touched.
 *
 * One run at a time writes to a folder; a second is told so ("busy") and writes nothing. The
 * sign that a run is writing is the file ".replays.lock". A run that is killed cannot take
 * it away: if no run is going and the file is still there, delete it by hand. Nothing else
 * needs repair, because nothing is ever half in place.
 */
export function writeReplay(dir: string, replay: Replay, io: PublishIo = { rename: renameSync }): { ok: true; files: string[] } | { ok: false; why: WriteRefusal } {
  if (!isReplayId(replay.id) || replayOf(JSON.parse(JSON.stringify(replay)), replay.id) === null) return { ok: false, why: "bad-replay" };
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${replay.id}.json`);
  const indexPath = join(dir, "index.json");
  const lock = join(dir, LOCK);
  let held: number;
  try {
    // Made only if it is not there: two runs cannot both have it.
    held = openSync(lock, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { ok: false, why: "busy" };
    throw error;
  }
  /** This run's own folder for the new files. Set once it has been made, and removed at the end. */
  let staging: string | null = null;
  try {
    let cards: ReplayCard[] = [];
    const index = readOwn(indexPath);
    if (index !== undefined) {
      const listed = index === "not-a-file" ? null : indexOf(index.data);
      if (listed === null) return { ok: false, why: "bad-index" };
      cards = listed;
    }
    const existing = readOwn(file);
    if (existing !== undefined && (existing === "not-a-file" || replayOf(existing.data, replay.id) === null)) return { ok: false, why: "not-a-replay" };

    cards = [...cards.filter((card) => card.id !== replay.id), cardOf(replay)].sort((a, b) => a.id.localeCompare(b.id));
    // In the same folder, so that moving a file out of it is one step on one disk.
    staging = mkdtempSync(join(dir, ".replay-staging-"));
    writeFileSync(join(staging, "replay.json"), replayText(replay), { flag: "wx" });
    writeFileSync(join(staging, "index.json"), indexText({ version: REPLAY_VERSION, replays: cards }), { flag: "wx" });
    io.rename(join(staging, "replay.json"), file);
    io.rename(join(staging, "index.json"), indexPath);
    return { ok: true, files: [file, indexPath] };
  } finally {
    // Only what this run made: its own folder, and its lock.
    if (staging !== null) rmSync(staging, { recursive: true, force: true });
    closeSync(held);
    rmSync(lock, { force: true });
  }
}
