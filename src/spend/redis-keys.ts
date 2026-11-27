/**
 * Finding keys by pattern without holding the database up.
 *
 * `KEYS` examines the whole database in one command, and nothing else is served while it
 * runs. `SCAN` does the same work in small batches, with other commands served in between.
 * Anything here that might be pointed at a store other things share uses SCAN.
 */
export interface Scanner {
  scan(cursor: string, match: "MATCH", pattern: string, count: "COUNT", batch: number): Promise<[cursor: string, keys: string[]]>;
}

/** How many keys one SCAN step is asked to look at. */
export const SCAN_BATCH = 200;

/**
 * The keys matching `pattern`. With `atMost`, it stops as soon as that many have been found:
 * a caller that only needs to know whether any exist asks for one.
 */
export async function scanKeys(redis: Scanner, pattern: string, atMost = Number.POSITIVE_INFINITY): Promise<string[]> {
  const found = new Set<string>();
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", SCAN_BATCH);
    for (const key of batch) found.add(key);
    cursor = next;
  } while (cursor !== "0" && found.size < atMost);
  return [...found];
}
