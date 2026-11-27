// Types only: the page never imports the server's code.
import type { Replay, ReplayCard, ReplayFrame, ReplayMove, ReplayPlayer } from "../../src/web/replay";
import { GameError } from "./api";
import { S } from "./strings";

export type { Replay, ReplayCard, ReplayFrame, ReplayMove, ReplayPlayer };

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

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isText = (x: unknown): boolean => isObject(x) && typeof x.en === "string" && typeof x.zh === "string";
const isCount = (x: unknown): boolean => typeof x === "number" && Number.isInteger(x) && x >= 0;
const isPlayer = (x: unknown): boolean => isObject(x) && (x.kind === "solver" || (x.kind === "detective" && typeof x.model === "string" && isCount(x.turns) && isCount(x.unused) && isCount(x.requests) && isCount(x.costNano)));
const isCard = (x: unknown): x is ReplayCard => isObject(x) && typeof x.id === "string" && ID.test(x.id) && isText(x.title) && isText(x.setting) && isCount(x.suspects) && isCount(x.actions) && isPlayer(x.player);

/** The replays a list file names. Entries that are not replay cards are left out; a file that is not a list gives none. */
export function cardsOf(data: unknown, base: string): Listed[] {
  if (!isObject(data) || data.version !== 1 || !Array.isArray(data.replays)) return [];
  return data.replays.filter(isCard).map((card) => ({ id: card.id, title: card.title, setting: card.setting, suspects: card.suspects, actions: card.actions, player: card.player, base }));
}

/**
 * A replay file's contents, if they are the replay that was asked for: the right name, an
 * opening frame, then one move to a frame, with the game over in the last frame and in no
 * earlier one. Null otherwise.
 */
export function replayOf(data: unknown, id: string): Replay | null {
  if (!isCard(data) || data.id !== id) return null;
  const whole = data as unknown as Record<string, unknown>;
  if (whole.version !== 1 || !Array.isArray(whole.frames) || whole.frames.length < 2) return null;
  const frames = whole.frames as unknown[];
  for (const [i, frame] of frames.entries()) {
    if (!isObject(frame) || !isObject(frame.view)) return null;
    const view = frame.view;
    const last = i === frames.length - 1;
    if (!Array.isArray(view.people) || !Array.isArray(view.evidence) || !Array.isArray(view.topics) || !Array.isArray(view.inspections) || !Array.isArray(view.transcript) || !Array.isArray(view.statements) || !Array.isArray(view.rules)) return null;
    if (!isObject(view.actions) || !isObject(view.cost) || !isObject(view.victim) || !isText(view.title)) return null;
    if (view.over !== last || (last && (!isObject(view.verdict) || !isObject(view.reveal)))) return null;
    // Every frame but the first is reached by a move.
    if ((i === 0) !== (frame.move === undefined)) return null;
    if (i > 0 && !(isObject(frame.move) && (frame.move.kind === "ask" || frame.move.kind === "inspect" || frame.move.kind === "accuse"))) return null;
  }
  return data as unknown as Replay;
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
    replay = ID.test(card.id) ? replayOf(await read(`${card.base}/${card.id}.json`), card.id) : null;
  } catch {
    replay = null;
  }
  if (!replay) throw new GameError("replay", S.replayFailed);
  return replay;
}

/** The step to show after a move of `by` from `step`, kept inside the replay. */
export const stepBy = (replay: Replay, step: number, by: number): number => Math.min(replay.frames.length - 1, Math.max(0, step + by));
