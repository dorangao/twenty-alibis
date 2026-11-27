// Types only: the page never imports the server's code.
import type { Replay, ReplayCard, ReplayFrame, ReplayMove, ReplayPlayer } from "../../src/web/replay";
import { GameError } from "./api";
import { indexOf, isReplayId, replayOf } from "./replay-shape";
import { S } from "./strings";

export type { Replay, ReplayCard, ReplayFrame, ReplayMove, ReplayPlayer };
export { replayOf };

/**
 * Replays are plain files beside the page: a list, "index.json", and one file for each
 * replay. Reading them asks nothing of the game's server, so they are there when the server
 * is not, and watching one sends nothing and spends nothing.
 *
 * A file is checked before it is used. One that is not a replay is left out of the list, or
 * refused when opened: the page never tries to draw something it cannot read.
 */

/** A replay in a list, and the folder its file is in. */
export interface Listed extends ReplayCard {
  base: string;
}

/** Where the published replays are. */
export const REPLAYS = "/replays";
/** Where the dev server hands out replays that wait to be looked at before they are published. A build has no such folder. */
export const PREVIEW = "/replays/preview";

/** The replays a list file names, each with the folder it is in. A file that is not a list of replay cards gives none. */
export function cardsOf(data: unknown, base: string): Listed[] {
  return (indexOf(data) ?? []).map((card) => ({ ...card, base }));
}

async function read(path: string): Promise<unknown> {
  const response = await fetch(path, { credentials: "omit" });
  if (!response.ok) throw new Error(String(response.status));
  return (await response.json()) as unknown;
}

/** The replays listed in a folder. None if the list is not there or cannot be read: that is not an error. */
export async function listReplays(base: string): Promise<Listed[]> {
  try {
    return cardsOf(await read(`${base}/index.json`), base);
  } catch {
    return [];
  }
}

/** One replay, whole. */
export async function loadReplay(card: Listed): Promise<Replay> {
  let replay: Replay | null = null;
  try {
    replay = isReplayId(card.id) ? replayOf(await read(`${card.base}/${card.id}.json`), card.id) : null;
  } catch {
    replay = null;
  }
  if (!replay) throw new GameError("replay", S.replayFailed);
  return replay;
}

/** The step to show after a move of `by` from `step`, kept inside the replay. */
export const stepBy = (replay: Replay, step: number, by: number): number => Math.min(replay.frames.length - 1, Math.max(0, step + by));
