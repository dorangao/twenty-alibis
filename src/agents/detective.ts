import type { Case } from "../case/schema";
import { accuse, actionsLeft, ask, inspect, inspectionMenu, notebook, SessionError, startSession, topicMenu, type Session, type Verdict } from "../game/session";
import { noModel } from "../game/terminal";
import type { Metered } from "../metered";
import type { ChatMessage } from "../provider/types";

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

export const DETECTIVE_PROMPT_ID = "detective-v1";
/** Output limit per turn, reasoning included. */
export const DETECTIVE_OUTPUT_TOKENS = 800;
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
  /** The confirmed cost of the detective's own requests that came back. */
  costNano: number;
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
}

const object = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const NONE = "none";

/** The part every turn of a game shares: the rules and the public case. */
export function detectiveBriefing(c: Case): string {
  const scene = c.locations.find((l) => l.id === c.victim.death.location);
  return [
    "You are the detective in a murder-mystery game. Each turn you take exactly one action.",
    "",
    "RULES",
    "1. Only records prove anything. What a suspect says proves nothing by itself, but hearing someone can open a record that was closed.",
    "2. To solve the case you must accuse one person and cite records that together show three things about them: they were at the scene at the time of death, they held what was needed, and they had a motive. The records you cite must also rule out everyone else: by placing them somewhere else at that time, by showing they did not hold what was needed, or by showing they had no motive.",
    "3. You have a limited number of actions. Asking a topic or inspecting a record costs one. Accusing ends the game.",
    "4. Do not accuse until your records do all of rule 2. If you are out of actions, accuse with what you have.",
    "",
    "THE CASE",
    `${c.title.en}. ${c.setting.en}`,
    `${c.victim.name.en} died at ${c.victim.death.slot} in the ${scene?.name.en.toLowerCase() ?? "?"} and was found at ${c.victim.found.slot}.`,
    c.victim.cause.en,
    "People:",
    ...c.suspects.map((s, i) => `- P${i + 1}: ${s.name.en}, ${s.role.en}`),
  ].join("\n");
}

/** What the detective is shown this turn, and the handles it may answer with. */
function view(c: Case, s: Session) {
  const book = notebook(c, s);
  const name = (id: string) => c.suspects.find((x) => x.id === id)?.name.en ?? id;
  // Handles are positions in lists that only grow or never change, so a handle means the same thing every turn.
  const records = book.evidence.map((e, i) => ({ handle: `R${i + 1}`, id: e.id, text: e.text.en, authoritative: e.authoritative }));
  const topics = c.actions.topics.flatMap((t, i) => {
    const open = topicMenu(c, s, t.suspect).find((m) => m.id === t.id);
    return open && !open.heard ? [{ handle: `T${i + 1}`, id: t.id, suspect: t.suspect, label: t.label.en }] : [];
  });
  const inspections = c.actions.inspections.flatMap((x, i) => {
    const open = inspectionMenu(c, s).find((m) => m.id === x.id);
    return open && !open.done ? [{ handle: `I${i + 1}`, id: x.id, label: x.label.en }] : [];
  });
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

  const report = (outcome: DetectiveReport["outcome"], verdict?: Verdict): DetectiveReport => ({
    outcome,
    ...(verdict ? { verdict } : {}),
    turns: taken,
    actions: s.actions,
    requests: requests + s.turns.reduce((sum, t) => sum + t.turn.requests, 0),
    costNano,
    steps,
    session: s,
    ...(problem ? { problem } : {}),
  });
  const system: ChatMessage = { role: "system", content: detectiveBriefing(c) };

  for (let turn = 1; turn <= maxTurns; turn++) {
    taken = turn;
    const now = view(c, s);
    const canAct = now.left > 0;
    const schema = {
      name: "detective_action",
      schema: object({
        action: { type: "string", enum: canAct ? ["ask", "inspect", "accuse"] : ["accuse"] },
        topic: { type: "string", enum: [...(canAct ? now.topics.map((t) => t.handle) : []), NONE] },
        inspection: { type: "string", enum: [...(canAct ? now.inspections.map((x) => x.handle) : []), NONE] },
        person: { type: "string", enum: [...c.suspects.map((_x, i) => `P${i + 1}`), NONE] },
        cite: { type: "array", items: { type: "string", enum: now.records.map((r) => r.handle) } },
      }),
    };
    const result = await args.metered({
      step: "detective.turn",
      promptId: DETECTIVE_PROMPT_ID,
      attemptId: `${args.gameId}:d${turn}`,
      messages: [system, { role: "user", content: now.text }],
      responseSchema: schema,
      maxOutputTokens: DETECTIVE_OUTPUT_TOKENS,
      ...(args.cacheKey ? { cacheKey: args.cacheKey } : {}),
    });
    if (!result.ok) {
      if (result.sent) requests++;
      problem = result.sent ? "failed:outcome-unknown" : `refused:${result.reason}`;
      steps.push({ turn, did: `the request did not come back: ${problem}`, used: false });
      return report("no-accusation");
    }
    requests++;
    if (result.settled) costNano += result.costNano;
    if (result.breached) problem = "envelope-suspended";
    else if (!result.settled) problem = "unconfirmed:not-settled";

    // Read the reply. Anything that is not a legal action right now is a wasted turn.
    const waste = (why: string): boolean => {
      steps.push({ turn, did: why, used: false });
      return ++wasted >= MAX_WASTED_IN_A_ROW;
    };
    type Reply = { action?: unknown; topic?: unknown; inspection?: unknown; person?: unknown; cite?: unknown };
    const read = (): Reply | null => {
      if (result.response.finishReason === "length") return null;
      try {
        const parsed = JSON.parse(result.response.text ?? "") as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Reply) : null;
      } catch {
        return null;
      }
    };
    const reply = read();
    let stop = false;
    if (!reply) stop = waste(result.response.finishReason === "length" ? "the reply was cut off at the output limit" : "the reply was not the object asked for");
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
            if (asked.turn.problem && asked.turn.requests > 0) problem = asked.turn.problem;
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
    // A request whose cost is unconfirmed, or a suspended envelope, ends the game here.
    if (problem || stop) return report("no-accusation");
  }
  steps.push({ turn: maxTurns + 1, did: "ran out of turns without accusing", used: false });
  return report("no-accusation");
}
