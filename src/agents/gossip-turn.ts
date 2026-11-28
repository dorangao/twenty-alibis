import type { Case } from "../case/schema";
import type { GossipPlan } from "../game/gossip";
import type { Metered } from "../metered";
import type { ChatMessage } from "../provider/types";
import { renderAssertion } from "./render";
import { suspectIdentity } from "./suspect-prompt";

/**
 * One suspect's part in a gossip round: of a few people, pick the one to tell.
 *
 * Code has already decided who speaks, which of its own statements it passes on, and who the
 * candidates are. The model is asked for one letter. It is shown the public case, the
 * speaker's own voice, the statement as code words it, and the candidates' names and roles:
 * nothing about where anyone really was, who did it, or what the player has found. The
 * statement is the speaker's public claim, which may be false; the model is not told whether
 * it is.
 *
 * One request, no retry. A reply that is not exactly one of the letters, or that was cut
 * off, or whose cost could not be confirmed, picks nobody: the event does not happen.
 */
export const GOSSIP_PROMPT_ID = "gossip-v1";
/** Room for the reasoning the model does even at minimal effort, and one short answer. */
export const GOSSIP_OUTPUT_TOKENS = 400;

const LETTERS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

/** The part every speaker in a case shares, word for word. */
export function gossipBriefing(c: Case): string {
  const scene = c.locations.find((l) => l.id === c.victim.death.location)?.name ?? { en: c.victim.death.location, zh: c.victim.death.location };
  return [
    "You are one character in a murder-mystery game. Between the detective's questions, the people in the house talk to each other.",
    "",
    "YOUR TASK",
    "You will be given one thing you say when the detective asks you, and a short list of people, each with a letter.",
    "Choose the one person you would repeat it to, as your character would: someone you trust, someone you want on your side, or someone you would rather hear it from you.",
    "Answer with that person's letter and nothing else. Do not explain.",
    "",
    "THE CASE, AS EVERYONE KNOWS IT",
    `${c.title.en} / ${c.title.zh}`,
    `${c.setting.en} / ${c.setting.zh}`,
    `Victim: ${c.victim.name.en} / ${c.victim.name.zh}. Died at ${c.victim.death.slot} in the ${scene.en} / ${scene.zh}. Found at ${c.victim.found.slot}.`,
    "People present:",
    ...c.suspects.map((s) => `- ${s.name.en} / ${s.name.zh}: ${s.role.en} / ${s.role.zh}`),
  ].join("\n");
}

/** The messages for one speaker's choice, and the letter each candidate was given. */
export function gossipMessages(c: Case, plan: GossipPlan): { messages: ChatMessage[]; letters: Map<string, string> } {
  const topic = c.actions.topics.find((t) => t.id === plan.topic && t.suspect === plan.speaker);
  if (!topic) throw new Error(`${plan.speaker} has no topic called ${plan.topic}`);
  if (plan.candidates.length < 2 || plan.candidates.length > LETTERS.length) throw new Error("a choice needs between two and eight candidates");
  const statements = topic.yields.flatMap((id) => {
    const assertion = c.assertions.find((a) => a.id === id);
    return assertion ? [`- ${renderAssertion(c, plan.speaker, assertion, "en")} / ${renderAssertion(c, plan.speaker, assertion, "zh")}`] : [];
  });
  const letters = new Map<string, string>();
  const lines = plan.candidates.map((id, i) => {
    const person = c.suspects.find((s) => s.id === id);
    if (!person) throw new Error(`no such suspect: ${id}`);
    letters.set(LETTERS[i]!, id);
    return `${LETTERS[i]}. ${person.name.en} / ${person.name.zh}: ${person.role.en} / ${person.role.zh}`;
  });
  const user = [`When the detective asks you "${topic.label.en} / ${topic.label.zh}", you say:`, ...statements, "", "Who you could tell:", ...lines, "", "Answer with one letter."].join("\n");
  return {
    messages: [
      { role: "system", content: gossipBriefing(c) },
      { role: "system", content: suspectIdentity(c, plan.speaker) },
      { role: "user", content: user },
    ],
    letters,
  };
}

export interface RecipientChoice {
  /** The person picked, or null when nobody was. */
  to: string | null;
  /** 1 when the request left this machine, else 0. */
  requests: number;
  /** The confirmed cost, when the request came back and its cost was confirmed. */
  costNano: number;
  /** Set when the request was refused, failed, came back unconfirmed, or suspended the envelope. */
  problem?: string;
  /** Set when a reply came back and picked nobody: it was cut off, or was not one of the letters. */
  unusable?: "cut-off" | "not-a-letter";
}

/** Ask the speaker's agent which candidate to tell. `attemptId` names this one request. */
export async function chooseRecipient(args: { metered: Metered; c: Case; plan: GossipPlan; attemptId: string; cacheKey?: string }): Promise<RecipientChoice> {
  const { messages, letters } = gossipMessages(args.c, args.plan);
  const result = await args.metered({
    step: "gossip.tell",
    promptId: GOSSIP_PROMPT_ID,
    attemptId: args.attemptId,
    messages,
    responseSchema: {
      name: "gossip_choice",
      schema: { type: "object", additionalProperties: false, required: ["to"], properties: { to: { type: "string", enum: [...letters.keys()] } } },
    },
    maxOutputTokens: GOSSIP_OUTPUT_TOKENS,
    reasoningEffort: "minimal",
    ...(args.cacheKey ? { cacheKey: args.cacheKey } : {}),
  });
  if (!result.ok) return result.sent ? { to: null, requests: 1, costNano: 0, problem: "failed:outcome-unknown" } : { to: null, requests: 0, costNano: 0, problem: `refused:${result.reason}` };
  const costNano = result.settled ? result.costNano : 0;
  // A reply whose cost is unconfirmed, or that suspended the envelope, is not acted on.
  if (result.breached) return { to: null, requests: 1, costNano, problem: "envelope-suspended" };
  if (!result.settled) return { to: null, requests: 1, costNano, problem: "unconfirmed:not-settled" };
  if (result.response.finishReason !== "stop") return { to: null, requests: 1, costNano, unusable: "cut-off" };
  const to = letterOf(result.response.text, letters);
  return { to, requests: 1, costNano, ...(to === null ? { unusable: "not-a-letter" as const } : {}) };
}

/** The candidate a reply names: the text must be an object with one field, `to`, holding one of the letters. */
function letterOf(text: string | null, letters: Map<string, string>): string | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const to = (value as { to?: unknown }).to;
  if (keys.length !== 1 || keys[0] !== "to" || typeof to !== "string") return null;
  return letters.get(to) ?? null;
}
