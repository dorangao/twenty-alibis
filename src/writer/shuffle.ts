import { plotIds, type People, type Skeleton } from "./plot";

/**
 * Put the roster in an order that has nothing to do with the plot.
 *
 * A model asked to decide who did it tends to pick the first person on its list, and to
 * give means and motive to the first few. Three real plots in a row had the culprit first
 * and the shortlist in places one to four. A player who notices can name the culprit of
 * the next case from the list alone, and the briefing's own records list people in roster
 * order, so they would point the same way.
 *
 * So code reorders the people twice, each time by a seed and a fixed rule, so the same seed
 * always gives the same case and a case can be rebuilt:
 *
 *  - before the second request (`shuffleRoster`), so that who the model lists first when it
 *    decides the plot is not who it named first;
 *  - after it (`shufflePlot`), so that a person's place in the finished case says nothing
 *    about the plot.
 *
 * Nothing else changes: each person keeps their name, voice, whereabouts, means and motive.
 */

/** A small, fixed generator of numbers from a string. The same seed always gives the same sequence. */
function numbersFrom(seed: string): () => number {
  // FNV-1a over the seed's characters, then mulberry32.
  let h = 0x811c9dc5;
  for (const ch of seed) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The new order: `order[i]` is the old position of the person who now stands at position i. */
export function rosterOrder(seed: string, size: number): number[] {
  const next = numbersFrom(seed);
  const order = Array.from({ length: size }, (_x, i) => i);
  for (let i = size - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/**
 * The skeleton with its people in the seeded order, before anyone has decided who did it.
 *
 * Reordering after the plot is written hides the culprit's place in the list, but not a
 * second trace: the model names people in a recognizable order (two real rosters ran
 * through the alphabet) and then picks the first one it named. Sorted by name, the culprit
 * was still first. So the list is reordered before the second request as well: the person
 * the model then sees first is no longer the first it named.
 */
export function shuffleRoster(seed: string, skeleton: Skeleton): Skeleton {
  const order = rosterOrder(seed, skeleton.suspects.length);
  return { ...skeleton, suspects: order.map((from) => skeleton.suspects[from]!) };
}

/**
 * The same plot with its people in the seeded order. The people stage must have exactly one
 * row per person of the skeleton; a plot that does not is returned as it is, for the
 * compiler to refuse with its own reasons.
 */
export function shufflePlot(seed: string, skeleton: Skeleton, people: People): { skeleton: Skeleton; people: People } {
  const ids = plotIds(skeleton).suspects;
  const rows = new Map(people.suspects.map((row) => [row.id, row]));
  if (people.suspects.length !== ids.length || rows.size !== ids.length || !ids.every((id) => rows.has(id))) return { skeleton, people };

  const order = rosterOrder(seed, ids.length);
  /** Old id -> new id. */
  const moved = new Map(order.map((from, to) => [ids[from]!, ids[to]!]));
  return {
    skeleton: { ...skeleton, suspects: order.map((from) => skeleton.suspects[from]!) },
    people: {
      culprit: moved.get(people.culprit) ?? people.culprit,
      suspects: order.map((from, to) => ({ ...rows.get(ids[from]!)!, id: ids[to]! })),
    },
  };
}
