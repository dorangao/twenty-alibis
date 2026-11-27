/**
 * Which view of a game is the newest.
 *
 * Answers from the server can arrive out of order: a read that was slow can come back after
 * an action that was quick. Every view carries its session and a revision that only rises,
 * so the page can tell. A view replaces the one on screen unless it is an older view of the
 * same game. A view of another game always replaces it: the page moved on.
 */
export interface Stamp {
  session: string;
  revision: number;
}

export function supersedes(shown: Stamp | null, next: Stamp): boolean {
  return shown === null || shown.session !== next.session || next.revision >= shown.revision;
}
