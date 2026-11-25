import type { Case } from "./schema";

/**
 * What a player holds at some moment: the ids of evidence they have been given or have
 * inspected, and the ids of statements they have heard.
 */
export interface Held {
  has(id: string): boolean;
}

/** What a player holds before taking any action: the briefing evidence. */
export function startingHeld(c: Case): Set<string> {
  return new Set(c.briefing.evidence);
}

/**
 * The one rule for whether a topic or an inspection is open to the player right now:
 * everything it requires is already held.
 *
 * The solver, a suspect's topic menu and `recall` all use this same function, so what the
 * solver counts as reachable and what a suspect will actually talk about cannot drift apart.
 */
export function isOpen(action: { requires?: readonly string[] | undefined }, held: Held): boolean {
  return (action.requires ?? []).every((id) => held.has(id));
}
