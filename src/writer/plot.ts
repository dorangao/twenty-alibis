import { z } from "zod";
import type { ChatMessage } from "../provider/types";

/**
 * What the model is asked to write: a plot, in two stages.
 *
 *  1. The skeleton: the setting, the rooms and their doors, the victim, the means, the
 *     possible motives, and the people with their voices. No answer key is in it, so the
 *     voices are written before anyone knows who did it.
 *  2. The people: who did it, where each person was in every slot, who holds the means and
 *     who has which motive.
 *
 * The model writes no ids. Stage 1 returns lists; code numbers them. Stage 2 is given
 * exactly those ids as its only choices. Everything that needs careful bookkeeping
 * (statements, records, what proves what, what can be asked and inspected) is built by
 * code from the plot: see compile.ts.
 */

const HAN = /\p{Script=Han}/u;
/** The same thing said twice. A clear mix-up of the two languages is refused; whether the prose is good is a person's call. */
const Text = z
  .object({
    en: z.string().trim().min(1).refine((v) => /[A-Za-z]/.test(v) && !HAN.test(v), "the English text must be in English"),
    zh: z.string().trim().min(1).refine((v) => HAN.test(v), "the Chinese text must be in Chinese"),
  })
  .strict();

/** A real clock time, "00:00" to "23:59". */
const Clock = z.string().refine((v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v), "a time slot must be a clock time such as 21:00");

export const SkeletonSchema = z
  .object({
    title: Text,
    setting: Text,
    /** Clock times, in order. The death is in the second. */
    slots: z
      .array(Clock)
      .min(3)
      .max(5)
      .refine((slots) => slots.every((slot, i) => i === 0 || slot > slots[i - 1]!), "time slots must be in order, each later than the last"),
    /** `doors` lists the English names of the rooms this room opens onto. */
    rooms: z.array(z.object({ name: Text, doors: z.array(z.string()) }).strict()).min(3).max(8),
    victim: z.object({ name: Text, cause: Text }).strict(),
    means: Text,
    motives: z.array(Text).min(2).max(4),
    suspects: z.array(z.object({ name: Text, role: Text, persona: Text }).strict()).min(4).max(24),
  })
  .strict();
export type Skeleton = z.infer<typeof SkeletonSchema>;

export const PeopleSchema = z
  .object({
    culprit: z.string(),
    suspects: z.array(
      z
        .object({
          id: z.string(),
          whereabouts: z.array(z.object({ slot: z.string(), room: z.string() }).strict()),
          has_means: z.boolean(),
          motive: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type People = z.infer<typeof PeopleSchema>;

/** The ids code gives to what stage 1 listed. Stage 2 may use these and nothing else. */
export interface PlotIds {
  suspects: string[];
  rooms: string[];
  slots: string[];
  motives: string[];
}
export const NO_MOTIVE = "none";

const pad = (n: number) => String(n + 1).padStart(2, "0");
export function plotIds(skeleton: Skeleton): PlotIds {
  return {
    suspects: skeleton.suspects.map((_s, i) => `s-${pad(i)}`),
    rooms: skeleton.rooms.map((_r, i) => `l-${pad(i)}`),
    slots: [...skeleton.slots],
    motives: skeleton.motives.map((_m, i) => `mo-${pad(i)}`),
  };
}

/** The slot of the death: always the second, so there is a "before" and an "after". */
export const deathSlot = (skeleton: Skeleton): string => skeleton.slots[1]!;

// ---- The two requests ----

const object = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const text = object({ en: { type: "string" }, zh: { type: "string" } });
const list = (items: unknown) => ({ type: "array", items });

export const skeletonRequestSchema = {
  name: "case_skeleton",
  schema: object({
    title: text,
    setting: text,
    slots: list({ type: "string" }),
    rooms: list(object({ name: text, doors: list({ type: "string" }) })),
    victim: object({ name: text, cause: text }),
    means: text,
    motives: list(text),
    suspects: list(object({ name: text, role: text, persona: text })),
  }),
};

export function peopleRequestSchema(ids: PlotIds) {
  return {
    name: "case_people",
    schema: object({
      culprit: { type: "string", enum: ids.suspects },
      suspects: list(
        object({
          id: { type: "string", enum: ids.suspects },
          whereabouts: list(object({ slot: { type: "string", enum: ids.slots }, room: { type: "string", enum: ids.rooms } })),
          has_means: { type: "boolean" },
          motive: { type: "string", enum: [...ids.motives, NO_MOTIVE] },
        }),
      ),
    }),
  };
}

const WRITER_SYSTEM =
  "You write plots for a murder-mystery game. Output data only, in the requested JSON shape. Every name and description is given in English (en) and in Simplified Chinese (zh), saying the same thing.";

export interface SkeletonBrief {
  /** One line on where and when, e.g. "a lighthouse during a storm". */
  theme: string;
  suspects: number;
  rooms: number;
}

export function skeletonMessages(brief: SkeletonBrief): ChatMessage[] {
  return [
    { role: "system", content: WRITER_SYSTEM },
    {
      role: "user",
      content: [
        `Write the skeleton of a new case set in ${brief.theme}.`,
        `- Three time slots, twenty minutes apart, written like "21:00".`,
        `- ${brief.rooms} rooms that form one building. For each room list in "doors" the English names of the rooms it opens onto. Every room must be reachable.`,
        `- One victim, with a one-sentence cause of death that says what was used.`,
        `- "means": the one thing a person needed to do it (a key, a tool, a pass). Several people will hold it.`,
        `- Three possible motives, each a short sentence about what someone stood to lose or gain, written so it could be true of several people.`,
        `- ${brief.suspects} suspects. For each: a name, a role in the house, and a "persona": how they speak and carry themselves, in one sentence. A persona is voice and manner only: no facts about the evening, and nothing about guilt or innocence.`,
        `Write exactly ${brief.suspects} suspects and exactly ${brief.rooms} rooms. Count them before you answer.`,
        "Names:",
        "- Every English name has a given name and a family name, each of at least three letters, and no two people share either.",
        "- No name is an everyday English word (not May, Will, Grace, Mark, Rose, Hope, Hall, Park).",
        "- Every Chinese name is an ordinary Chinese name of two or three characters, a surname and a given name written as one word with no space, such as 魏立群. It is the person's own Chinese name, not the English name spelled out in Chinese sounds.",
        "- No two Chinese names share two characters in a row, and no Chinese name contains a room's Chinese name.",
        "- No person's English name appears inside a room's name or another person's name.",
        "- Room names are distinct words too: no two rooms share a word.",
        "- A role never contains a person's name.",
      ].join("\n"),
    },
  ];
}

export function peopleMessages(skeleton: Skeleton, ids: PlotIds): ChatMessage[] {
  const death = deathSlot(skeleton);
  return [
    { role: "system", content: WRITER_SYSTEM },
    {
      role: "user",
      content: [
        "Here is a case skeleton. Decide what happened.",
        `Title: ${skeleton.title.en}. ${skeleton.setting.en}`,
        `Victim: ${skeleton.victim.name.en}. ${skeleton.victim.cause.en}`,
        `What was needed: ${skeleton.means.en}`,
        `Time slots: ${ids.slots.join(", ")}. The death is at ${death}.`,
        "Rooms:",
        ...skeleton.rooms.map((r, i) => `- ${ids.rooms[i]}: ${r.name.en}. Doors to: ${r.doors.join(", ") || "none listed"}`),
        "Motives:",
        ...skeleton.motives.map((m, i) => `- ${ids.motives[i]}: ${m.en}`),
        "People:",
        ...skeleton.suspects.map((s, i) => `- ${ids.suspects[i]}: ${s.name.en}, ${s.role.en}`),
        "",
        "Rules:",
        `1. Give every person exactly one row, and in it one room for each of the slots ${ids.slots.join(", ")}.`,
        "2. Between one slot and the next a person stays put or goes through one door.",
        `3. Pick the culprit. At ${death} the culprit is in a room that has at least one door. The victim dies in that room.`,
        "4. The culprit holds the means and has a motive.",
        "5. At least three other people also hold the means and have a motive. This matters: the detective must have several people to suspect.",
        `   At ${death}, at least one of those other people is in a room that has a door to the culprit's room.`,
        `6. Nobody else who holds the means and has a motive is in the culprit's room at ${death}.`,
        "7. At least one person who does not have both the means and a motive is somewhere in the building, for the detective to talk to.",
        `8. Use "${NO_MOTIVE}" for a person with no motive.`,
      ].join("\n"),
    },
  ];
}
