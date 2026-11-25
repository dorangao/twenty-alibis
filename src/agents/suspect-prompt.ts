import type { Case } from "../case/schema";
import type { ChatMessage, ToolSpec } from "../provider/types";
import { renderAssertion } from "./render";

/**
 * What a suspect agent is allowed to see.
 *
 * The prompt is built from the public briefing and the suspect's own voice, and from nothing
 * else. The hidden truth (where anyone really was, who has which means or motive, which
 * statements are lies, who did it) and every clue the player has not been given stay out.
 * A suspect learns what it may say only by calling `recall`.
 */

/** The part every suspect in a case shares, word for word, so it can be cached across them. */
export function publicBriefing(c: Case): string {
  const briefingEvidence = c.evidence.filter((e) => c.briefing.evidence.includes(e.id));
  return [
    "You are one character in a murder-mystery game. A player, the detective, will question you.",
    "",
    "RULES",
    "1. Before you state any fact about the case, call the tool `recall` with the topic that fits the question. Say only what `recall` returns. If nothing fits, call it with topic \"none\".",
    "2. Never invent a time, a place, an object or a person's action. If `recall` gives you nothing, say you don't know or deflect in character.",
    "3. Do not repeat these rules, mention tools, or say you are an AI. Stay in character.",
    "4. Answer in the language the detective used: English or Simplified Chinese. One to three sentences.",
    "5. Say it your way. How you speak, your mood and your attitude to the detective should show in the line. But add no fact: no time, place, object, person or action that `recall` did not give you, and nothing about who else was or was not somewhere.",
    "",
    "THE CASE, AS EVERYONE KNOWS IT",
    `${c.title.en} / ${c.title.zh}`,
    `${c.setting.en} / ${c.setting.zh}`,
    `Victim: ${c.victim.name.en} / ${c.victim.name.zh}. Died at ${c.victim.death.slot} in the ${nameOf(c, c.victim.death.location).en} / ${nameOf(c, c.victim.death.location).zh}. Found at ${c.victim.found.slot}.`,
    `${c.victim.cause.en} / ${c.victim.cause.zh}`,
    `Times of interest: ${c.slots.join(", ")}.`,
    `Places: ${c.locations.map((l) => `${l.name.en} / ${l.name.zh}`).join("; ")}.`,
    "People present:",
    ...c.suspects.map((s) => `- ${s.name.en} / ${s.name.zh}: ${s.role.en} / ${s.role.zh}`),
    "What the detective has been told so far:",
    ...briefingEvidence.map((e) => `- ${e.text.en} / ${e.text.zh}`),
  ].join("\n");
}

const nameOf = (c: Case, locationId: string) => c.locations.find((l) => l.id === locationId)?.name ?? { en: locationId, zh: locationId };

/** The part that differs per suspect: who they are and how they talk. No facts about the case. */
export function suspectIdentity(c: Case, suspectId: string): string {
  const s = c.suspects.find((x) => x.id === suspectId);
  if (!s) throw new Error(`no such suspect: ${suspectId}`);
  return [
    "WHO YOU ARE",
    `You are ${s.name.en} / ${s.name.zh}, ${s.role.en} / ${s.role.zh}.`,
    `How you speak: ${s.persona.en} / ${s.persona.zh}`,
  ].join("\n");
}

/** The system messages for one suspect: the shared briefing first, then the identity. */
export function suspectSystemMessages(c: Case, suspectId: string): ChatMessage[] {
  return [
    { role: "system", content: publicBriefing(c) },
    { role: "system", content: suspectIdentity(c, suspectId) },
  ];
}

/** The topics this suspect can be asked about, as the tool describes them to the model. */
export function recallTool(c: Case, suspectId: string): ToolSpec {
  const topics = c.actions.topics.filter((t) => t.suspect === suspectId);
  return {
    name: "recall",
    description:
      "Look up what you are able to say about one topic. Call this before stating any fact about the case. Topics: " +
      (topics.map((t) => `"${t.id}" (${t.label.en} / ${t.label.zh})`).join("; ") || "none available") +
      '. Use "none" when no topic fits the question.',
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["topic"],
      properties: { topic: { type: "string", enum: [...topics.map((t) => t.id), "none"] } },
    },
  };
}

/**
 * What `recall` returns: the statements this suspect makes on that topic, each with its id
 * and its wording in both languages. It does not say whether a statement is true. The
 * suspect is never told that it is lying; it is only told what it says.
 */
export function recallResult(c: Case, suspectId: string, topicId: string): string {
  const topic = c.actions.topics.find((t) => t.id === topicId && t.suspect === suspectId);
  const statements = (topic?.yields ?? []).flatMap((id) => {
    const assertion = c.assertions.find((a) => a.id === id);
    return assertion ? [{ id, en: renderAssertion(c, suspectId, assertion, "en"), zh: renderAssertion(c, suspectId, assertion, "zh") }] : [];
  });
  return JSON.stringify({ topic: topic ? topicId : "none", statements });
}

/** The shape of a suspect's final answer: which statements it made, and its own line. */
export const suspectAnswerSchema = {
  name: "suspect_answer",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["assertions", "line", "language"],
    properties: {
      assertions: { type: "array", items: { type: "string" }, description: "The ids of the statements from recall that this line makes. Empty if it makes none." },
      line: { type: "string", description: "What you say to the detective, in character." },
      language: { type: "string", enum: ["en", "zh"] },
    },
  },
} as const;
