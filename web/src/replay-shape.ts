// Types only: the page never imports the server's code. This file imports nothing else, so
// the scripts that write replay files and the dev server that hands them out can use the
// same checks the page does.
import type { Replay, ReplayCard } from "../../src/web/replay";

/**
 * What a replay file must look like before anything draws it or lists it.
 *
 * The page's components read a replay's fields without asking again whether they are there,
 * so everything they read is checked here, down to the leaves: a file with a part missing or
 * of the wrong kind is not a replay. The same checks say whether a file in a folder of
 * replays is one, before it is replaced or handed out.
 */
type Check = (x: unknown) => boolean;

const str: Check = (x) => typeof x === "string";
const bool: Check = (x) => typeof x === "boolean";
const count: Check = (x) => typeof x === "number" && Number.isInteger(x) && x >= 0;
const absent: Check = (x) => x === undefined;
const oneOf = (...values: readonly unknown[]): Check => (x) => values.includes(x);
const list = (item: Check): Check => (x) => Array.isArray(x) && x.every(item);
/** An object with exactly these parts in it, each as it should be. A part that is not named is not allowed. */
const shape = (parts: Record<string, Check>): Check => (x) =>
  typeof x === "object" &&
  x !== null &&
  !Array.isArray(x) &&
  // Its own names only: "constructor" and the like are names every object answers to, and are not parts.
  Object.keys(x).every((key) => Object.hasOwn(parts, key)) &&
  Object.entries(parts).every(([key, check]) => check(Object.hasOwn(x, key) ? (x as Record<string, unknown>)[key] : undefined));

const text = shape({ en: str, zh: str });
const handle = (prefix: string): Check => (x) => typeof x === "string" && new RegExp(`^${prefix}[1-9]\\d{0,3}$`).test(x);
const person = handle("P");
const place = shape({ slot: str, room: text });

/** A replay's own name: lower-case letters, digits and hyphens. "index" is the list's name, never a replay's. */
export const isReplayId = (x: unknown): x is string => typeof x === "string" && x.length <= 60 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x) && x !== "index";

const player: Check = (x) => shape({ kind: oneOf("solver") })(x) || shape({ kind: oneOf("detective"), model: str, turns: count, unused: count, requests: count, costNano: count })(x);
const card = { id: isReplayId as Check, title: text, setting: text, suspects: count, actions: count, player };
const isCard = shape(card);

const move: Check = (x) =>
  shape({ kind: oneOf("ask"), person, topic: handle("T"), label: text })(x) || shape({ kind: oneOf("inspect"), inspection: handle("I"), label: text })(x) || shape({ kind: oneOf("accuse"), person, evidence: list(handle("E")) })(x);

const verdict = shape({ accused: person, cited: list(handle("E")), outcome: oneOf("solved"), missing: list(str), open: list(person), accusedRuledOut: bool, actions: count });
const reveal = shape({
  culprit: person,
  motive: text,
  timeline: list(shape({ person, at: list(place) })),
  lies: list(shape({ person, text, heard: bool, caught: bool })),
});

/** A view as a replay holds it. Before the last frame the game is not over and there is no verdict or reveal; in the last it is solved. */
const view = (last: boolean): Check =>
  shape({
    session: str,
    revision: count,
    caseId: str,
    title: text,
    setting: text,
    victim: shape({ name: text, cause: text, died: place, found: place }),
    rules: list(text),
    noteMark: text,
    people: list(shape({ handle: person, name: text, role: text })),
    rooms: list(text),
    slots: list(str),
    actions: shape({ used: count, cap: count, left: count }),
    model: oneOf("off"),
    evidence: list(shape({ handle: handle("E"), text, note: bool })),
    statements: list(shape({ key: str, turn: count, person, text, contradictedBy: list(handle("E")) })),
    topics: list(shape({ handle: handle("T"), person, label: text, heard: bool })),
    inspections: list(shape({ handle: handle("I"), label: text, done: bool })),
    transcript: list(shape({ n: count, person, question: str, line: str, language: oneOf("en", "zh"), source: str, noted: count })),
    cost: shape({ requests: count, nano: count, unfinished: count }),
    over: oneOf(last),
    verdict: last ? verdict : absent,
    reveal: last ? reveal : absent,
  });

/** A list file's replays. Null when the file is not a list of replay cards, every one of them whole. */
export function indexOf(data: unknown): ReplayCard[] | null {
  if (!shape({ version: oneOf(1), replays: list(isCard) })(data)) return null;
  const cards = (data as { replays: ReplayCard[] }).replays;
  // A name is listed once.
  return new Set(cards.map((c) => c.id)).size === cards.length ? cards : null;
}

/**
 * A replay file's contents, if they are the replay that was asked for: the right name, an
 * opening frame with no move, then one move to a frame, every view whole, the game over and
 * solved in the last frame and in no earlier one. Null otherwise.
 */
export function replayOf(data: unknown, id: string): Replay | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const frames = (data as { frames?: unknown }).frames;
  if (!Array.isArray(frames) || frames.length < 2) return null;
  const last = frames.length - 1;
  const frame = (i: number): Check => shape({ move: i === 0 ? absent : move, view: view(i === last) });
  if (!shape({ ...card, version: oneOf(1), frames: (x) => (x as unknown[]).every((f, i) => frame(i)(f)) })(data)) return null;
  const replay = data as Replay;
  if (replay.id !== id) return null;
  // People a move or a statement names are on the roster.
  const roster = new Set(replay.frames[0]!.view.people.map((p) => p.handle));
  for (const f of replay.frames) if (f.move && f.move.kind !== "inspect" && !roster.has(f.move.person)) return null;
  return replay;
}
