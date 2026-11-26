import type { Case } from "../case/schema";
import { PROOF_RULES } from "../game/rules";
import { accuse, actionsLeft, ask, inspect, inspectionMenu, notebook, SessionError, startSession, topicMenu, type Session, type Verdict } from "../game/session";
import { noModel } from "../game/terminal";
import type { Metered } from "../metered";
import type { ChatMessage } from "../provider/types";
import type { Usage } from "../spend/pricing";

/**
 * A detective that plays a case the way a player does.
 *
 * Each turn it is shown what a player would see: the public case, the notebook as code
 * words it, and what is open to ask and inspect. It answers with one action, chosen from a
 * list that holds only what is open right now. Code applies the action through the same
 * session functions a player uses, so the detective can do nothing a player cannot, and it
 * is scored by the same code.
 *
 * It is never shown the answer, anyone's true whereabouts, which statements are lies, or a
 * record it has not inspected. It has no memory of its own: the notebook is its memory.
 *
 * A case counts as solved by an agent only when this detective, seeing only that, earns a
 * "solved" verdict from the scorer.
 */

export const DETECTIVE_PROMPT_ID = "detective-v3";
/** Output limit per turn, reasoning included. */
// Measured against the real model: with the scene's record in the notebook a turn's reasoning
// alone passed 800 tokens and the reply was cut off with no answer in it. Reasoning counts
// toward this limit, so it has to leave room for the thinking as well as the answer.
export const DETECTIVE_OUTPUT_TOKENS = 3_000;
/** Two unusable replies in a row end the game: the detective is not making progress. */
export const MAX_WASTED_IN_A_ROW = 2;

export interface DetectiveStep {
  turn: number;
  /** What the detective did, in plain words, or why its reply could not be used. */
  did: string;
  /** False when the reply could not be used and nothing happened. */
  used: boolean;
}

export interface DetectiveReport {
  /**
   * solved, right-but-unproven, wrong: the scorer's verdict on the accusation it made.
   * no-accusation: it ran out of turns, wasted too many, or a request did not come back.
   */
  outcome: Verdict["outcome"] | "no-accusation";
  verdict?: Verdict;
  /** Turns taken: one request to the detective each. */
  turns: number;
  /** Game actions used, as a player's would be counted. */
  actions: number;
  /** Requests that left this machine: the detective's, plus any the suspects made. */
  requests: number;
  /** The confirmed cost of the whole game: `detectiveCostNano` plus `suspectCostNano`. */
  costNano: number;
  /** The confirmed cost of the detective's own requests. */
  detectiveCostNano: number;
  /** The confirmed cost of the requests the suspects made. Zero when their model is off. */
  suspectCostNano: number;
  steps: DetectiveStep[];
  session: Session;
  /** Set when a request was refused, failed, or came back unconfirmed. The caller should stop its run. */
  problem?: string;
}

export interface DetectiveArgs {
  /** For the detective's own requests. */
  metered: Metered;
  /**
   * For the suspects it questions. By default the model is off for them: a topic from the
   * menu gives the statement as code words it, which is all a detective needs, and costs nothing.
   */
  suspects?: Metered;
  c: Case;
  /** A stable id for this game. Its requests are "<gameId>:d<turn>". */
  gameId: string;
  /** The most turns it may take. Defaults to the session cap plus two. */
  maxTurns?: number;
  cacheKey?: string;
  /** The output limit for each turn, reasoning included. Defaults to DETECTIVE_OUTPUT_TOKENS. */
  maxOutputTokens?: number;
  /**
   * Called with every reply of the detective's the moment it arrives, before it is read or
   * acted on. A caller that pays for replies saves them here.
   */
  onReply?: (reply: DetectiveReply) => void;
}

/** One reply of the detective's exactly as it arrived. */
export interface DetectiveReply {
  attemptId: string;
  turn: number;
  /** The reply's text, untouched. Null when the model sent none. */
  text: string | null;
  finishReason: string | undefined;
  usage: Usage | undefined;
  settled: boolean;
  breached: boolean;
}

const object = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const NONE = "none";

/** The part every turn of a game shares: the rules and the public case. */
export function detectiveBriefing(c: Case): string {
  const scene = c.locations.find((l) => l.id === c.victim.death.location);
  const n = PROOF_RULES.length;
  return [
    "You are the detective in a murder-mystery game. Each turn you take exactly one action.",
    "",
    "RULES",
    // The rules of proof, word for word as a person at the terminal is told them.
    ...PROOF_RULES.map((rule, i) => `${i + 1}. ${rule.en}`),
    `${n + 1}. A person no record rules out is still open, even when nothing points at them. So before you accuse, check every other person against your records, and keep inspecting while anyone is still open.`,
    `${n + 2}. You have a limited number of actions. Asking a topic or inspecting a record costs one. Accusing ends the game.`,
    `${n + 3}. Do not accuse until your records do all of rules 2 to ${n + 1}. If you are out of actions, accuse with what you have. When you accuse, cite every record you hold.`,
    `${n + 4}. Decide and answer. You do not need to explain your choice.`,
    "",
    "THE CASE",
    `${c.title.en}. ${c.setting.en}`,
    `${c.victim.name.en} died at ${c.victim.death.slot} in the ${scene?.name.en.toLowerCase() ?? "?"} and was found at ${c.victim.found.slot}.`,
    c.victim.cause.en,
    "People:",
    ...c.suspects.map((s, i) => `- P${i + 1}: ${s.name.en}, ${s.role.en}`),
  ].join("\n");
}

/**
 * The numbers the detective uses for topics and inspections. A thing gets its number the
 * first time it is open to the player, in the order a player's menu would list it, and
 * keeps it. So a number says nothing about what is still locked: a case whose locked record
 * sits first in the file and one where it sits last look the same until it opens.
 */
interface Handles {
  topics: Map<string, number>;
  inspections: Map<string, number>;
}

/** What the detective is shown this turn, and the handles it may answer with. */
function view(c: Case, s: Session, handles: Handles) {
  const book = notebook(c, s);
  const name = (id: string) => c.suspects.find((x) => x.id === id)?.name.en ?? id;
  // Handles are positions in lists that only grow or never change, so a handle means the same thing every turn.
  const records = book.evidence.map((e, i) => ({ handle: `R${i + 1}`, id: e.id, text: e.text.en, authoritative: e.authoritative }));
  const number = (map: Map<string, number>, id: string): number => {
    if (!map.has(id)) map.set(id, map.size + 1);
    return map.get(id)!;
  };
  const topics = c.suspects
    .flatMap((x) => topicMenu(c, s, x.id).map((m) => ({ ...m, suspect: x.id })))
    .map((m) => ({ handle: `T${number(handles.topics, m.id)}`, n: number(handles.topics, m.id), id: m.id, suspect: m.suspect, label: m.label.en, heard: m.heard }))
    .filter((m) => !m.heard)
    .sort((a, b) => a.n - b.n);
  const inspections = inspectionMenu(c, s)
    .map((m) => ({ handle: `I${number(handles.inspections, m.id)}`, n: number(handles.inspections, m.id), id: m.id, label: m.label.en, done: m.done }))
    .filter((m) => !m.done)
    .sort((a, b) => a.n - b.n);
  const left = actionsLeft(c, s);
  const text = [
    `Actions left: ${left}.`,
    "",
    "YOUR NOTEBOOK",
    "Records:",
    ...records.map((r) => `- ${r.handle}: ${r.text}${r.authoritative ? "" : " (a note, not proof)"}`),
    "Statements heard:",
    ...(book.statements.length > 0 ? book.statements.map((st) => `- ${name(st.suspect)}: "${st.en}"`) : ["- none yet"]),
    ...(book.contradictions.length > 0
      ? ["Contradictions:", ...book.contradictions.map((x) => `- ${name(x.suspect)}'s statement is against ${records.find((r) => r.id === x.evidence)?.handle ?? "a record"}.`)]
      : []),
    "",
    "WHAT YOU CAN DO",
    ...(left > 0 && topics.length > 0 ? ["Ask a topic:", ...topics.map((t) => `- ${t.handle}: ask ${name(t.suspect)}: "${t.label}"`)] : []),
    ...(left > 0 && inspections.length > 0 ? ["Inspect:", ...inspections.map((x) => `- ${x.handle}: ${x.label}`)] : []),
    `Accuse: name a person (P1 to P${c.suspects.length}) and list the records you cite.`,
    "",
    `Answer with one action. Use "${NONE}" for the fields your action does not need, and an empty list for "cite" unless you accuse.`,
  ].join("\n");
  return { text, records, topics, inspections, left };
}

export async function playDetective(args: DetectiveArgs): Promise<DetectiveReport> {
  const { c } = args;
  const suspects = args.suspects ?? noModel;
  const maxTurns = args.maxTurns ?? c.sessionCap + 2;
  let s = startSession(c, args.gameId);
  const steps: DetectiveStep[] = [];
  let requests = 0;
  let costNano = 0;
  let wasted = 0;
  let taken = 0;
  let problem: string | undefined;
  const handles: Handles = { topics: new Map(), inspections: new Map() };
  /** True when the caller turned the suspects' model on. Then a refusal from it is a problem, not the expected "model off". */
  const liveSuspects = args.suspects !== undefined;

  const report = (outcome: DetectiveReport["outcome"], verdict?: Verdict): DetectiveReport => ({
    outcome,
    ...(verdict ? { verdict } : {}),
    turns: taken,
    actions: s.actions,
    requests: requests + s.turns.reduce((sum, t) => sum + t.turn.requests, 0),
    costNano: costNano + s.turns.reduce((sum, t) => sum + t.turn.costNano, 0),
    detectiveCostNano: costNano,
    suspectCostNano: s.turns.reduce((sum, t) => sum + t.turn.costNano, 0),
    steps,
    session: s,
    ...(problem ? { problem } : {}),
  });
  const system: ChatMessage = { role: "system", content: detectiveBriefing(c) };

  for (let turn = 1; turn <= maxTurns; turn++) {
    taken = turn;
    const now = view(c, s, handles);
    const canAct = now.left > 0;
    const schema = {
      name: "detective_action",
      schema: object({
        action: { type: "string", enum: canAct ? ["ask", "inspect", "accuse"] : ["accuse"] },
        topic: { type: "string", enum: [...(canAct ? now.topics.map((t) => t.handle) : []), NONE] },
        inspection: { type: "string", enum: [...(canAct ? now.inspections.map((x) => x.handle) : []), NONE] },
        person: { type: "string", enum: [...c.suspects.map((_x, i) => `P${i + 1}`), NONE] },
        // With nothing in the notebook there is nothing to cite: an empty list is the only legal value.
        cite: now.records.length > 0 ? { type: "array", items: { type: "string", enum: now.records.map((r) => r.handle) } } : { type: "array", items: { type: "string" }, maxItems: 0 },
      }),
    };
    const result = await args.metered({
      step: "detective.turn",
      promptId: DETECTIVE_PROMPT_ID,
      attemptId: `${args.gameId}:d${turn}`,
      messages: [system, { role: "user", content: now.text }],
      responseSchema: schema,
      maxOutputTokens: args.maxOutputTokens ?? DETECTIVE_OUTPUT_TOKENS,
      ...(args.cacheKey ? { cacheKey: args.cacheKey } : {}),
    });
    if (!result.ok) {
      if (result.sent) requests++;
      problem = result.sent ? "failed:outcome-unknown" : `refused:${result.reason}`;
      steps.push({ turn, did: `the request did not come back: ${problem}`, used: false });
      return report("no-accusation");
    }
    requests++;
    args.onReply?.({ attemptId: `${args.gameId}:d${turn}`, turn, text: result.response.text, finishReason: result.response.finishReason, usage: result.response.usage, settled: result.settled, breached: result.breached });
    if (result.settled) costNano += result.costNano;
    if (result.breached) problem = "envelope-suspended";
    else if (!result.settled) problem = "unconfirmed:not-settled";
    // The reply is here, but its cost is unconfirmed or the envelope is suspended. Nothing it
    // asks for is done: an action taken on such a reply could send more requests, or end the
    // game with a verdict that would then be counted.
    if (problem) {
      steps.push({ turn, did: `the reply came back but was not acted on: ${problem}`, used: false });
      return report("no-accusation");
    }

    // Read the reply. Anything that is not a legal action right now is a wasted turn.
    const waste = (why: string): boolean => {
      steps.push({ turn, did: why, used: false });
      return ++wasted >= MAX_WASTED_IN_A_ROW;
    };
    type Reply = { action?: unknown; topic?: unknown; inspection?: unknown; person?: unknown; cite?: unknown };
    const read = (): Reply | null => {
      // Only a reply the model says it finished is read.
      if (result.response.finishReason !== "stop") return null;
      try {
        const parsed = JSON.parse(result.response.text ?? "") as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Reply) : null;
      } catch {
        return null;
      }
    };
    const reply = read();
    let stop = false;
    if (!reply) {
      const finish = result.response.finishReason;
      stop = waste(finish === "length" ? "the reply was cut off at the output limit" : finish !== "stop" ? `the reply did not end normally (finish: ${finish ?? "not given"})` : "the reply was not the object asked for");
    }
    else {
      try {
        if (reply.action === "ask") {
          const topic = now.topics.find((t) => t.handle === reply.topic);
          if (!topic || !canAct) stop = waste(`asked for a topic that is not open: ${String(reply.topic)}`);
          else {
            const asked = await ask(suspects, c, s, { suspect: topic.suspect, topic: topic.id, language: "en", ...(args.cacheKey ? { cacheKey: args.cacheKey } : {}) });
            s = asked.session;
            wasted = 0;
            steps.push({ turn, did: `asked ${topic.handle} (${topic.id})`, used: true });
            // With the suspects' model off, a refusal is the expected path. With it on, any problem ends the game.
            if (asked.turn.problem && (liveSuspects || asked.turn.requests > 0)) problem = `suspect:${asked.turn.problem}`;
          }
        } else if (reply.action === "inspect") {
          const item = now.inspections.find((x) => x.handle === reply.inspection);
          if (!item || !canAct) stop = waste(`asked to inspect something that is not open: ${String(reply.inspection)}`);
          else {
            s = inspect(c, s, item.id).session;
            wasted = 0;
            steps.push({ turn, did: `inspected ${item.handle} (${item.id})`, used: true });
          }
        } else if (reply.action === "accuse") {
          const index = typeof reply.person === "string" && /^P\d+$/.test(reply.person) ? Number(reply.person.slice(1)) - 1 : -1;
          const accused = c.suspects[index];
          const cited = Array.isArray(reply.cite) ? reply.cite.map((h) => now.records.find((r) => r.handle === h)?.id) : [undefined];
          if (!accused || cited.some((id) => id === undefined)) stop = waste(`accused without a person or with a record it does not hold: ${String(reply.person)}`);
          else {
            const done = accuse(c, s, { suspect: accused.id, evidence: cited as string[] });
            s = done.session;
            steps.push({ turn, did: `accused ${reply.person as string} (${accused.id}) citing ${cited.length} record(s)`, used: true });
            return report(done.verdict.outcome, done.verdict);
          }
        } else stop = waste(`unknown action: ${String(reply.action)}`);
      } catch (error) {
        if (!(error instanceof SessionError)) throw error;
        stop = waste(`the game refused the action: ${error.code}`);
      }
    }
    // A suspect's request that did not come back cleanly, or too many wasted turns, ends the game here.
    if (problem || stop) return report("no-accusation");
  }
  steps.push({ turn: maxTurns + 1, did: "ran out of turns without accusing", used: false });
  return report("no-accusation");
}
