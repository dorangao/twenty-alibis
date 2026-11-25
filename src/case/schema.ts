import { z } from "zod";

/**
 * The case contract.
 *
 * A case file holds two kinds of things:
 *  - the hidden truth (where each suspect really was, who has which means and motive, the culprit)
 *  - what a player can reach: canonical topics (testimony) and inspections (evidence)
 *
 * Everything here is data. Code decides whether a case is fair; see validate.ts and solver.ts.
 */

const Id = z.string().min(1);
const Text = z.object({ en: z.string().min(1), zh: z.string().min(1) }).strict();

/** A typed claim about the world. Testimony and evidence both point at these. */
export const PropositionSchema = z.discriminatedUnion("kind", [
  /** `subject` was at `location` during `slot`. */
  z.object({ kind: z.literal("at"), subject: Id, slot: Id, location: Id }).strict(),
  /** `subject` has (value: true) or lacks (value: false) the means `means`. */
  z.object({ kind: z.literal("means"), subject: Id, means: Id, value: z.boolean() }).strict(),
  /** `subject` has (value: true) or lacks (value: false) the motive `motive`. */
  z.object({ kind: z.literal("motive"), subject: Id, motive: Id, value: z.boolean() }).strict(),
]);

export const AssertionSchema = z.object({ id: Id, prop: PropositionSchema }).strict();

export const SuspectSchema = z
  .object({
    id: Id,
    name: Text,
    role: Text,
    /** Safe to show the model: voice and manner only, never facts about the case. */
    persona: Text,
    /** Hidden truth: slot id -> location id, one entry per slot. */
    whereabouts: z.record(Id, Id),
    /** Hidden truth: means ids this suspect really has. */
    means: z.array(Id),
    /** Hidden truth: motive ids this suspect really has. */
    motives: z.array(Id),
    /** Assertion ids this suspect states that are false. Every false statement must be listed. */
    lies: z.array(Id),
  })
  .strict();

export const EvidenceSchema = z
  .object({
    id: Id,
    kind: z.enum(["record", "object"]),
    /** Only authoritative evidence can prove or rule out anything. It must match the truth. */
    authoritative: z.boolean(),
    proves: z.array(Id),
    text: Text,
  })
  .strict();

/** A canonical question for one suspect. Asking it always yields these statements. */
export const TopicSchema = z
  .object({
    id: Id,
    suspect: Id,
    label: Text,
    yields: z.array(Id),
    /** Assertion or evidence ids the player must already hold before this topic is visible. */
    requires: z.array(Id).optional(),
  })
  .strict();

/** A record or place the player can examine. It yields evidence. */
export const InspectionSchema = z
  .object({
    id: Id,
    label: Text,
    yields: z.array(Id),
    requires: z.array(Id).optional(),
  })
  .strict();

export const CaseSchema = z
  .object({
    id: Id,
    title: Text,
    setting: Text,
    /** Ordered time slots. */
    slots: z.array(Id).min(1),
    locations: z.array(z.object({ id: Id, name: Text, adjacent: z.array(Id) }).strict()).min(1),
    victim: z
      .object({
        name: Text,
        death: z.object({ slot: Id, location: Id }).strict(),
        found: z.object({ slot: Id, location: Id }).strict(),
        /** Public: the means that was used. Who had it is what the player must establish. */
        means: Id,
        cause: Text,
      })
      .strict(),
    means: z.array(z.object({ id: Id, name: Text }).strict()).min(1),
    motives: z.array(z.object({ id: Id, text: Text }).strict()).min(1),
    suspects: z.array(SuspectSchema).min(2),
    assertions: z.array(AssertionSchema),
    evidence: z.array(EvidenceSchema),
    /** Evidence the player holds before taking any action. */
    briefing: z.object({ evidence: z.array(Id) }).strict(),
    actions: z
      .object({ topics: z.array(TopicSchema), inspections: z.array(InspectionSchema) })
      .strict(),
    /** Hidden truth. */
    culprit: z.object({ suspect: Id, motive: Id }).strict(),
    /** The most actions one session allows. A proof must fit inside it. */
    sessionCap: z.number().int().positive(),
  })
  .strict();

export type Text = z.infer<typeof Text>;
export type Proposition = z.infer<typeof PropositionSchema>;
export type Assertion = z.infer<typeof AssertionSchema>;
export type Suspect = z.infer<typeof SuspectSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Topic = z.infer<typeof TopicSchema>;
export type Inspection = z.infer<typeof InspectionSchema>;
export type Case = z.infer<typeof CaseSchema>;
