import { hearsWord, mentions } from "../agents/line-guard";
import { nameProblems, type Roster } from "./names";
import { plotIds, type Skeleton, type SkeletonBrief } from "./plot";

/**
 * What can be known to be wrong with a skeleton before the second request is spent on it.
 *
 * The second request costs money and cannot fix the first: a room nobody can reach, a
 * roster the line guard cannot tell apart, the wrong number of people, or a reason for
 * nobody having seen the act that points at a person or a room will sink the case whatever
 * the plot is. So these are checked first, and a bad skeleton ends the attempt after one
 * request.
 */

/** Which rooms open onto which. A door works both ways, whichever room lists it. */
export function resolveDoors(skeleton: Skeleton): { doors: Map<string, Set<string>>; problems: string[] } {
  const ids = plotIds(skeleton);
  const problems: string[] = [];
  const roomByName = new Map(skeleton.rooms.map((r, i) => [r.name.en.trim().toLowerCase(), ids.rooms[i]!]));
  if (roomByName.size !== skeleton.rooms.length) problems.push("two rooms have the same English name");
  const doors = new Map<string, Set<string>>(ids.rooms.map((r) => [r, new Set<string>()]));
  skeleton.rooms.forEach((room, i) => {
    for (const name of room.doors) {
      const other = roomByName.get(name.trim().toLowerCase());
      if (!other) problems.push(`room "${room.name.en}" lists a door to "${name}", which is not a room`);
      else if (other !== ids.rooms[i]) {
        doors.get(ids.rooms[i]!)!.add(other);
        doors.get(other)!.add(ids.rooms[i]!);
      }
    }
  });
  return { doors, problems };
}

/** The skeleton as the name checks read it, under the ids the compiled case will use. */
export function skeletonRoster(skeleton: Skeleton): Roster {
  const ids = plotIds(skeleton);
  return {
    suspects: skeleton.suspects.map((s, i) => ({ id: ids.suspects[i]!, name: s.name, role: s.role, persona: s.persona })),
    locations: skeleton.rooms.map((r, i) => ({ id: ids.rooms[i]!, name: r.name })),
    means: [{ id: "m-01", name: skeleton.means }],
    slots: skeleton.slots,
  };
}

/**
 * What is wrong with the reason nobody saw the act (`victim.unseen`).
 *
 * The reason is written before the culprit and the room are chosen, and the briefing shows
 * it to the player as a fact. So it may not name a person: code holds no fact that would
 * make that true, and it would point at someone. It may not name a room: the death may
 * happen in another. It may not give a time: the death has its own. Code can check these
 * three things and that the sentence is there in both languages. Whether it is a good
 * reason is a person's call.
 *
 * A person is heard the way the line guard hears one, in any word of their name. A room is
 * heard only in its whole name: "nobody in the room could see" must not count as naming the
 * "Lamp room".
 */
export function unseenProblems(skeleton: Skeleton): string[] {
  const { unseen } = skeleton.victim;
  const both = `${unseen.en}\n${unseen.zh}`;
  const shown = `"${unseen.en}" / “${unseen.zh}”`;
  const problems: string[] = [];
  const heard = mentions({ suspects: skeletonRoster(skeleton).suspects, locations: [], means: [], slots: [] }, both);
  const people = heard.filter((m) => !m.startsWith("time "));
  const times = heard.filter((m) => m.startsWith("time "));
  if (people.length > 0) problems.push(`the reason nobody saw the act names a person (${people.join(", ")}): ${shown}`);
  const rooms = skeleton.rooms.filter((r) => hearsWord(r.name.en.trim().toLowerCase(), unseen.en) || unseen.zh.includes(r.name.zh.trim()));
  if (rooms.length > 0) problems.push(`the reason nobody saw the act names a room (${rooms.map((r) => r.name.en).join(", ")}), and the room of the death is not chosen yet: ${shown}`);
  if (times.length > 0) problems.push(`the reason nobody saw the act gives a time (${times.map((t) => t.slice(5)).join(", ")}): ${shown}`);
  return problems;
}

export function skeletonProblems(skeleton: Skeleton, brief?: SkeletonBrief): string[] {
  const problems: string[] = [];
  const ids = plotIds(skeleton);
  if (brief && skeleton.suspects.length !== brief.suspects) problems.push(`the skeleton has ${skeleton.suspects.length} suspects; ${brief.suspects} were asked for`);
  if (brief && skeleton.rooms.length !== brief.rooms) problems.push(`the skeleton has ${skeleton.rooms.length} rooms; ${brief.rooms} were asked for`);

  const { doors, problems: doorProblems } = resolveDoors(skeleton);
  problems.push(...doorProblems);
  // Every room must be reachable from the first: a room behind no door can hold nobody who moves.
  const reached = new Set<string>([ids.rooms[0]!]);
  for (const queue = [ids.rooms[0]!]; queue.length > 0; ) {
    for (const next of doors.get(queue.shift()!)!) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  skeleton.rooms.forEach((room, i) => {
    if (!reached.has(ids.rooms[i]!)) problems.push(`room "${room.name.en}" cannot be reached from "${skeleton.rooms[0]!.name.en}" through any doors`);
  });

  problems.push(...nameProblems(skeletonRoster(skeleton)));
  problems.push(...unseenProblems(skeleton));
  return problems;
}
