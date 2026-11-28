import type { Assertion, Case, Evidence, Text } from "../case/schema";
import { deathSlot, NO_MOTIVE, plotIds, type People, type Skeleton } from "./plot";
import { resolveDoors } from "./skeleton";

/**
 * Turn a plot into a full case.
 *
 * The plot says what happened. Everything here is bookkeeping that follows from it:
 *
 *  - One statement per suspect: where they were at the time of death. An innocent suspect
 *    states the truth. The culprit states a room next to the scene; that is the case's
 *    declared lie. Statement ids have one pattern for everyone, so an id never says who lies.
 *  - Records, all authoritative and all true because they are read off the plot: a register
 *    of who holds the means and who does not; the victim's papers, saying who had which
 *    motive and, for anyone who holds the means, that they had none; one record per room,
 *    occupied or empty, listing who was there at the time of death.
 *  - The record of the scene can only be inspected after one witness has been heard. The
 *    briefing says who that is. The witness is never one of the people the briefing shows
 *    with both means and motive, so who the witness is says nothing about who did it.
 *
 * A plot that cannot be compiled is refused with its reasons. A compiled case is not yet an
 * accepted case: the validator and the solver judge it next (`checkCase`), then the quality
 * gate (quality.ts).
 */

export type CompileResult =
  | {
      ok: true;
      case: Case;
      scene: string;
      witness: string;
      shortlist: string[];
      /** True when another shortlisted suspect really was in the room the culprit claims. */
      sharedAlibi: boolean;
    }
  | { ok: false; problems: string[] };

const listEn = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
const listZh = (names: string[]) => names.join("、");

export function compilePlot(id: string, skeleton: Skeleton, people: People): CompileResult {
  const ids = plotIds(skeleton);
  const problems: string[] = [];
  const death = deathSlot(skeleton);

  // ---- Rooms and doors. A door works both ways, whichever room lists it. ----
  const { doors, problems: doorProblems } = resolveDoors(skeleton);
  problems.push(...doorProblems);

  // ---- The people rows: one per suspect, one room per slot. ----
  const rows = new Map<string, People["suspects"][number]>();
  for (const row of people.suspects) {
    if (!ids.suspects.includes(row.id)) problems.push(`the people stage names ${row.id}, who is not in the skeleton`);
    else if (rows.has(row.id)) problems.push(`the people stage has two rows for ${row.id}`);
    else rows.set(row.id, row);
  }
  for (const s of ids.suspects) if (!rows.has(s)) problems.push(`the people stage has no row for ${s}`);
  const whereabouts = new Map<string, Record<string, string>>();
  for (const [s, row] of rows) {
    const where: Record<string, string> = {};
    for (const w of row.whereabouts) {
      if (!ids.slots.includes(w.slot)) problems.push(`${s} has a room at ${w.slot}, which is not a time slot`);
      else if (!ids.rooms.includes(w.room)) problems.push(`${s} is placed in ${w.room}, which is not a room`);
      else if (where[w.slot]) problems.push(`${s} has two rooms at ${w.slot}`);
      else where[w.slot] = w.room;
    }
    for (const slot of ids.slots) if (!where[slot]) problems.push(`${s} has no room at ${slot}`);
    if (row.motive !== NO_MOTIVE && !ids.motives.includes(row.motive)) problems.push(`${s} has the motive ${row.motive}, which is not listed`);
    whereabouts.set(s, where);
  }
  if (!ids.suspects.includes(people.culprit)) problems.push(`the culprit ${people.culprit} is not in the skeleton`);
  if (problems.length > 0) return { ok: false, problems };

  const row = (s: string) => rows.get(s)!;
  const hasMeans = (s: string) => row(s).has_means;
  const motiveOf = (s: string) => (row(s).motive === NO_MOTIVE ? null : row(s).motive);
  const roomAtDeath = (s: string) => whereabouts.get(s)![death]!;
  const nameOf = (s: string): Text => skeleton.suspects[ids.suspects.indexOf(s)]!.name;
  const roomName = (r: string): Text => skeleton.rooms[ids.rooms.indexOf(r)]!.name;

  // ---- The scene, and the room the culprit claims instead. ----
  const culprit = people.culprit;
  const scene = roomAtDeath(culprit);
  const culpritOK = hasMeans(culprit) && motiveOf(culprit) !== null;
  // Who the briefing will show with both means and motive.
  const shortlist = ids.suspects.filter((s) => hasMeans(s) && motiveOf(s) !== null);
  // The culprit claims a room next to the scene. A room where another shortlisted person
  // really was is preferred: then two of the people under suspicion say the same room, and
  // the claim alone does not mark the liar.
  const next = ids.rooms.filter((r) => doors.get(scene)!.has(r));
  const shared = next.find((r) => shortlist.some((s) => s !== culprit && roomAtDeath(s) === r));
  const claimed = shared ?? next[0];
  if (!claimed) problems.push(`the scene, "${roomName(scene).en}", has no door, so the culprit has no neighbouring room to claim`);
  if (!hasMeans(culprit)) problems.push("the culprit does not hold the means");
  if (!motiveOf(culprit)) problems.push("the culprit has no motive");

  // ---- Who keeps the scene's record: the first person the briefing does not show with both means and motive. ----
  const witness = ids.suspects.find((s) => !shortlist.includes(s));
  if (!witness) problems.push("everyone holds the means and has a motive, so there is no one to keep the scene's record");
  if (problems.length > 0 || !claimed || !witness || !culpritOK) return { ok: false, problems };

  // ---- Statements and facts. ----
  // Ids say what kind of thing an assertion is, never whether it is true. Every suspect's
  // statement is "<n>-says" and every recorded place is "<n>-was", guilty or not: the id of
  // a statement reaches the model inside `recall`, and must not tell it who is lying.
  const assertions: Assertion[] = [];
  const says = (s: string) => `a-${s.slice(2)}-says`;
  const was = (s: string) => `a-${s.slice(2)}-was`;
  for (const s of ids.suspects) {
    assertions.push({ id: says(s), prop: { kind: "at", subject: s, slot: death, location: s === culprit ? claimed : roomAtDeath(s) } });
    assertions.push({ id: was(s), prop: { kind: "at", subject: s, slot: death, location: roomAtDeath(s) } });
  }
  const means = (s: string) => `a-${s.slice(2)}-means`;
  for (const s of ids.suspects) assertions.push({ id: means(s), prop: { kind: "means", subject: s, means: "m-01", value: hasMeans(s) } });
  const motive = (s: string, m: string) => `a-${s.slice(2)}-${m}`;
  for (const s of ids.suspects) {
    const own = motiveOf(s);
    if (own) assertions.push({ id: motive(s, own), prop: { kind: "motive", subject: s, motive: own, value: true } });
    // Someone who holds the means and has no motive can only be ruled out by a record that
    // says so for every listed motive. Silence in the papers rules nobody out.
    else if (hasMeans(s)) for (const m of ids.motives) assertions.push({ id: motive(s, m), prop: { kind: "motive", subject: s, motive: m, value: false } });
  }

  // ---- Records. ----
  const evidence: Evidence[] = [];
  const briefing: string[] = [];
  const holders = ids.suspects.filter(hasMeans);
  evidence.push({
    id: "e-register",
    kind: "record",
    authoritative: true,
    proves: ids.suspects.map(means),
    text: {
      en: `Register for "${skeleton.means.en}": held by ${listEn(holders.map((s) => nameOf(s).en))}. Nobody else holds one.`,
      zh: `“${skeleton.means.zh}”登记：持有者为${listZh(holders.map((s) => nameOf(s).zh))}。其他人都没有。`,
    },
  });
  briefing.push("e-register");
  ids.motives.forEach((m, i) => {
    const who = ids.suspects.filter((s) => motiveOf(s) === m);
    if (who.length === 0) return;
    evidence.push({
      id: `e-papers-${m.slice(3)}`,
      kind: "record",
      authoritative: true,
      proves: who.map((s) => motive(s, m)),
      text: {
        en: `The victim's papers: "${skeleton.motives[i]!.en}" This is true of ${listEn(who.map((s) => nameOf(s).en))}.`,
        zh: `死者的文件：“${skeleton.motives[i]!.zh}”符合这一条的有${listZh(who.map((s) => nameOf(s).zh))}。`,
      },
    });
    briefing.push(`e-papers-${m.slice(3)}`);
  });
  const cleared = ids.suspects.filter((s) => hasMeans(s) && motiveOf(s) === null);
  if (cleared.length > 0) {
    evidence.push({
      id: "e-papers-none",
      kind: "record",
      authoritative: true,
      proves: cleared.flatMap((s) => ids.motives.map((m) => motive(s, m))),
      text: {
        en: `The victim's papers give ${listEn(cleared.map((s) => nameOf(s).en))} none of the listed motives.`,
        zh: `死者的文件表明，${listZh(cleared.map((s) => nameOf(s).zh))}不符合上述任何一条动机。`,
      },
    });
    briefing.push("e-papers-none");
  }
  // A note, not proof: it tells the player whose account to hear before the scene's record can
  // be seen. "Account", because what opens the record is holding that person's statement, and
  // it can reach the player from them or from someone they told.
  evidence.push({
    id: "e-keeper",
    kind: "record",
    authoritative: false,
    proves: [],
    text: {
      en: `The record of who was in the ${roomName(scene).en.toLowerCase()} is kept by ${nameOf(witness).en}. Hear their account first.`,
      zh: `${roomName(scene).zh}的出入记录由${nameOf(witness).zh}保管。先听听这个人的说法。`,
    },
  });
  briefing.push("e-keeper");

  // One record for every room, in the skeleton's order, occupied or not. If only occupied
  // rooms could be inspected, the menu itself would say which rooms were empty.
  for (const r of ids.rooms) {
    const present = ids.suspects.filter((s) => roomAtDeath(s) === r);
    evidence.push({
      id: `e-room-${r.slice(2)}`,
      kind: "record",
      authoritative: true,
      proves: present.map(was),
      text:
        present.length === 0
          ? { en: `${roomName(r).en}, ${death}: nobody was recorded here.`, zh: `${roomName(r).zh}，${death}：没有人在这里的记录。` }
          : {
              en: `${roomName(r).en}, ${death}: ${listEn(present.map((s) => nameOf(s).en))} ${present.length === 1 ? "was" : "were"} here.`,
              zh: `${roomName(r).zh}，${death}：${listZh(present.map((s) => nameOf(s).zh))}在这里。`,
            },
    });
  }

  const c: Case = {
    id,
    title: skeleton.title,
    setting: skeleton.setting,
    slots: ids.slots,
    locations: skeleton.rooms.map((room, i) => ({ id: ids.rooms[i]!, name: room.name, adjacent: [...doors.get(ids.rooms[i]!)!] })),
    victim: { name: skeleton.victim.name, death: { slot: death, location: scene }, found: { slot: ids.slots.at(-1)!, location: scene }, means: "m-01", cause: skeleton.victim.cause },
    means: [{ id: "m-01", name: skeleton.means }],
    motives: skeleton.motives.map((text, i) => ({ id: ids.motives[i]!, text })),
    suspects: skeleton.suspects.map((s, i) => {
      const sid = ids.suspects[i]!;
      const own = motiveOf(sid);
      return { id: sid, name: s.name, role: s.role, persona: s.persona, whereabouts: whereabouts.get(sid)!, means: hasMeans(sid) ? ["m-01"] : [], motives: own ? [own] : [], lies: sid === culprit ? [says(sid)] : [] };
    }),
    assertions,
    evidence,
    briefing: { evidence: briefing },
    actions: {
      topics: ids.suspects.map((s) => ({
        id: `t-${s.slice(2)}`,
        suspect: s,
        label: { en: `Where were you at ${death}?`, zh: `${death} 你在哪里？` },
        yields: [says(s)],
      })),
      inspections: ids.rooms.map((r) => ({
        id: `i-${r.slice(2)}`,
        label: { en: `Check who was in the ${roomName(r).en.toLowerCase()} at ${death}`, zh: `查看 ${death} 谁在${roomName(r).zh}` },
        yields: [`e-room-${r.slice(2)}`],
        // The scene's record is kept by the witness: it opens once the witness has been heard.
        ...(r === scene ? { requires: [says(witness)] } : {}),
      })),
    },
    culprit: { suspect: culprit, motive: motiveOf(culprit)! },
    // Enough to hear everyone and look at every record, so one play can both prove the case and catch the lie.
    sessionCap: ids.suspects.length + ids.rooms.length,
  };
  return { ok: true, case: c, scene, witness, shortlist, sharedAlibi: shared !== undefined };
}
