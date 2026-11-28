import { randomUUID } from "node:crypto";
import type { Case } from "../case/schema";
import { checkCase } from "../case/solver";
import type { Metered, MeteredRequest } from "../metered";
import type { Usage } from "../spend/pricing";
import { compilePlot } from "./compile";
import { peopleMessages, peopleRequestSchema, PeopleSchema, plotIds, skeletonMessages, skeletonRequestSchema, SkeletonSchema, type Skeleton, type SkeletonBrief } from "./plot";
import { assessQuality, type Quality } from "./quality";
import { shufflePlot, shuffleRoster } from "./shuffle";
import { skeletonProblems } from "./skeleton";

/**
 * One attempt at a new case: two requests to the model, then code.
 *
 *   skeleton request -> parse -> reorder the roster -> people request -> parse -> reorder again -> compile -> checkCase -> quality gate
 *
 * The attempt stops at the first stage that fails and says which one, so a run of attempts
 * can report where plots go wrong. There is no repair here: a failed attempt is a failed
 * attempt. A request that is refused, fails, or comes back with its cost unconfirmed ends
 * the attempt, and the caller should end its run. An attempt with such a problem is never
 * reported as accepted, even when both replies arrived.
 */

/** v2: the skeleton must say why nobody saw the act (`victim.unseen`). A skeleton saved under v1 has no such sentence and is refused. */
export const WRITER_PROMPT_ID = "writer-v2";
/** Output limits per request, reasoning included. */
// A twenty-person skeleton measured 3,900 to 5,100 output tokens, more than half of it reasoning.
export const SKELETON_OUTPUT_TOKENS = 8_000;
export const PEOPLE_OUTPUT_TOKENS = 8_000;

export type WriteStage =
  /** The skeleton request, or reading its reply. */
  | "skeleton"
  /** The people request, or reading its reply. */
  | "people"
  /** The plot could not be turned into a case. */
  | "compile"
  /** The validator or the solver refused the case. */
  | "gate"
  /** The case is solvable but not worth releasing. */
  | "quality";

/**
 * One reply exactly as it arrived: the text before anyone parsed it, how it ended, what it
 * used, and whether its cost was confirmed. A caller that pays for replies saves these.
 */
export interface ReplyRecord {
  attemptId: string;
  stage: "skeleton" | "people";
  /** The reply's text, untouched. Null when the model sent none. */
  text: string | null;
  /** "length" means it was cut off at the output limit. */
  finishReason: string | undefined;
  usage: Usage | undefined;
  /** False when the store did not confirm the cost. */
  settled: boolean;
  /** True when the reply suspended the envelope. */
  breached: boolean;
  /** The attempt's private salt. Saved with the reply so the case can be rebuilt; never part of the case. */
  salt: string;
  /**
   * For a people reply: the English names in the order the request showed them, so its
   * "s-01", "s-02" can be read later without redoing the reordering. A people reply saved
   * without this was written against the skeleton's own order.
   */
  shown?: string[];
}

/** The reordering rule in use. Saved with replies so a later change of rule cannot misread an old one. */
export const SHUFFLE_VERSION = 1;

export interface WriteReport {
  /** True only when the case passed every stage. */
  accepted: boolean;
  /** Where the attempt stopped. Absent when it was accepted. */
  failedAt?: WriteStage;
  reasons: string[];
  /** The case, present from the compile stage on, accepted or not. */
  case?: Case;
  quality?: Quality;
  /** Things worth knowing that did not refuse the attempt, e.g. surplus suspects that were dropped. */
  notes: string[];
  requests: number;
  /** The confirmed cost of the requests that came back. */
  costNano: number;
  /** Per request: which one, and what it used. */
  usage: { step: string; inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number | undefined; finishReason: string | undefined }[];
  /** Set when a request was refused, failed, or came back unconfirmed. The caller should stop its run. */
  problem?: string;
  /**
   * The private salt that seeded both reorderings. Keep it with the saved replies: the
   * people reply names people by their place in the order the salt gave. It is not in the
   * case and must not be published with it.
   */
  salt: string;
}

export interface WriteArgs {
  metered: Metered;
  /** A stable id for this attempt. Its requests are "<attemptId>:skeleton" and "<attemptId>:people". */
  attemptId: string;
  brief: SkeletonBrief;
  /**
   * A skeleton saved from an earlier run, already read as JSON. When given, stage 1 is
   * skipped and nothing is sent for it: the attempt spends only the people request. It is
   * checked again, exactly as a new one would be.
   */
  skeleton?: unknown;
  /**
   * Called with every reply the moment it arrives, before it is parsed or judged: complete
   * or cut off, JSON or not. A reply that fails a gate today may pass tomorrow's, and stage 2
   * can be run later from a saved skeleton.
   */
  onReply?: (reply: ReplyRecord) => void;
  /**
   * The private salt for the two reorderings. Random when not given. Pass the saved one to
   * rebuild a case from saved replies. It is deliberately not derived from the attempt id:
   * that id becomes the case's public id, and a seed anyone can compute hides nothing.
   */
  salt?: string;
}

/**
 * Everything code can tell about a skeleton before the second request: it has the right
 * shape, the right number of people and rooms, rooms that connect, names the line guard
 * can tell apart, and a reason why nobody saw the act that names no person, room or time.
 * Surplus suspects are dropped here, where no answer exists yet; too few is
 * a refusal. A new reply and a saved one go through this same check.
 */
export function checkSkeleton(raw: unknown, brief: SkeletonBrief): { ok: true; skeleton: Skeleton; notes: string[] } | { ok: false; reasons: string[] } {
  const notes: string[] = [];
  let value = raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const suspects = (raw as { suspects?: unknown }).suspects;
    if (Array.isArray(suspects) && suspects.length > brief.suspects) {
      notes.push(`the skeleton had ${suspects.length} suspects; the last ${suspects.length - brief.suspects} were dropped`);
      value = { ...raw, suspects: suspects.slice(0, brief.suspects) };
    }
  }
  const parsed = SkeletonSchema.safeParse(value);
  if (!parsed.success) return { ok: false, reasons: parsed.error.issues.slice(0, 8).map((i) => `skeleton: ${i.path.join(".") || "(the whole reply)"}: ${i.message}`) };
  const flaws = skeletonProblems(parsed.data, brief);
  return flaws.length > 0 ? { ok: false, reasons: flaws } : { ok: true, skeleton: parsed.data, notes };
}

/** The skeleton as the people request is shown it: people and motives in the order the private salt gives. */
export function presentSkeleton(salt: string, skeleton: Skeleton): Skeleton {
  return shuffleRoster(`${salt}:before`, skeleton);
}

const peopleIssues = (issues: readonly { path: PropertyKey[]; message: string }[]): string[] => issues.slice(0, 8).map((i) => `people: ${i.path.join(".") || "(the whole reply)"}: ${i.message}`);

/** What code makes of a plot once both replies are in. */
export interface Judged {
  /** Where it was refused. Absent when the case passed every gate. */
  failedAt?: WriteStage;
  reasons: string[];
  notes: string[];
  case?: Case;
  quality?: Quality;
}

/**
 * Everything after the second reply, and none of it uses a model: read the people reply,
 * reorder once more, compile, and put the case through the gates. `presented` is the
 * skeleton exactly as the people request was shown it.
 */
export function finishCase(attemptId: string, presented: Skeleton, peopleValue: unknown, salt: string): Judged {
  const people = PeopleSchema.safeParse(peopleValue);
  if (!people.success) return { failedAt: "people", reasons: peopleIssues(people.error.issues), notes: [] };
  // Reorder the people and the motives once more, so a place in the finished case says
  // nothing about the plot either. The private salt seeds both reorderings.
  const plot = shufflePlot(`${salt}:after`, presented, people.data);
  const compiled = compilePlot(attemptId, plot.skeleton, plot.people);
  if (!compiled.ok) return { failedAt: "compile", reasons: compiled.problems, notes: [] };
  const gate = checkCase(compiled.case);
  if (!gate.accepted) return { failedAt: "gate", reasons: gate.reasons, notes: [], case: compiled.case };
  const quality = assessQuality(compiled.case);
  if (quality.problems.length > 0) return { failedAt: "quality", reasons: quality.problems, notes: quality.notes, case: compiled.case, quality };
  return { reasons: [], notes: quality.notes, case: compiled.case, quality };
}

/**
 * Build a case from two saved replies, sending nothing. It runs exactly what `writeCase`
 * runs after each reply, with the same salt, so it gives the same case. This is how a saved
 * case is trusted: not by reading a file that says "accepted", but by making it again from
 * what the model actually wrote.
 */
export function rebuildCase(args: { attemptId: string; brief: SkeletonBrief; skeleton: unknown; people: unknown; salt: string }): Judged & { shown?: string[] } {
  const checked = checkSkeleton(args.skeleton, args.brief);
  if (!checked.ok) return { failedAt: "skeleton", reasons: checked.reasons, notes: [] };
  const presented = presentSkeleton(args.salt, checked.skeleton);
  const judged = finishCase(args.attemptId, presented, args.people, args.salt);
  return { ...judged, notes: [...checked.notes, ...judged.notes], shown: presented.suspects.map((x) => x.name.en) };
}

export async function writeCase(args: WriteArgs): Promise<WriteReport> {
  const salt = args.salt ?? randomUUID();
  const report: WriteReport = { accepted: false, reasons: [], notes: [], requests: 0, costNano: 0, usage: [], salt };
  const stop = (failedAt: WriteStage, reasons: string[]): WriteReport => ({ ...report, failedAt, reasons });

  /** Send one request and read its reply as JSON. Null when the attempt must stop; the reason is then in `report.reasons`. */
  const ask = async (stage: "skeleton" | "people", request: Omit<MeteredRequest, "attemptId" | "promptId" | "step">, shown?: string[]): Promise<{ value: unknown } | null> => {
    const attemptId = `${args.attemptId}:${stage}`;
    const result = await args.metered({ ...request, step: `writer.${stage}`, promptId: WRITER_PROMPT_ID, attemptId });
    if (!result.ok) {
      if (result.sent) report.requests++;
      report.problem = result.sent ? "failed:outcome-unknown" : `refused:${result.reason}`;
      report.reasons = [`the ${stage} request did not come back: ${report.problem}`];
      return null;
    }
    report.requests++;
    // First of all, hand the reply over as it is. Nothing below can lose it.
    args.onReply?.({ attemptId, stage, text: result.response.text, finishReason: result.response.finishReason, usage: result.response.usage, settled: result.settled, breached: result.breached, salt, ...(shown ? { shown } : {}) });
    if (result.settled) report.costNano += result.costNano;
    if (result.breached) report.problem = "envelope-suspended";
    else if (!result.settled) report.problem = "unconfirmed:not-settled";
    const u = result.response.usage;
    report.usage.push({ step: `writer.${stage}`, inputTokens: u?.inputTokens ?? 0, cachedTokens: u?.cachedTokens ?? 0, outputTokens: u?.outputTokens ?? 0, reasoningTokens: u?.reasoningTokens, finishReason: result.response.finishReason });
    if (result.response.finishReason === "length") {
      report.reasons = [`the ${stage} reply was cut off at the output limit`];
      return null;
    }
    // Only a reply the model says it finished is read. Anything else (a filter, a tool call,
    // no reason given) is kept by the caller and not used, however complete its text looks.
    if (result.response.finishReason !== "stop") {
      report.reasons = [`the ${stage} reply did not end normally (finish: ${result.response.finishReason ?? "not given"})`];
      return null;
    }
    try {
      return { value: JSON.parse(result.response.text ?? "") as unknown };
    } catch {
      report.reasons = [`the ${stage} reply is not JSON`];
      return null;
    }
  };

  // ---- Stage 1: the skeleton, written now or saved from an earlier run. ----
  const first = args.skeleton !== undefined ? { value: args.skeleton } : await ask("skeleton", { messages: skeletonMessages(args.brief), responseSchema: skeletonRequestSchema, maxOutputTokens: SKELETON_OUTPUT_TOKENS });
  if (first === null) return stop("skeleton", report.reasons);
  // Everything that can be known to be wrong with the skeleton is checked before the second request is spent on it.
  const checked = checkSkeleton(first.value, args.brief);
  if (!checked.ok) return stop("skeleton", checked.reasons);
  report.notes.push(...checked.notes);
  // The cost of the first request is not confirmed, or the envelope is suspended: send nothing more.
  if (report.problem) return stop("skeleton", [`stopped after the skeleton: ${report.problem}`]);

  // ---- Stage 2: the people. The schema offers only the ids code gave to the skeleton. ----
  // The model is shown the people in a seeded order, not the order it named them in: it
  // tends to pick the first one it sees, and the first it named is recognizable by name.
  const presented = presentSkeleton(salt, checked.skeleton);
  const ids = plotIds(presented);
  const second = await ask(
    "people",
    { messages: peopleMessages(presented, ids), responseSchema: peopleRequestSchema(ids), maxOutputTokens: PEOPLE_OUTPUT_TOKENS },
    presented.suspects.map((s) => s.name.en),
  );
  if (second === null) return stop("people", report.reasons);
  // The reply is here, but its cost is not confirmed or the envelope is suspended. Until
  // that is reconciled the attempt is not counted as anything: not accepted, not judged.
  if (report.problem) {
    const shape = PeopleSchema.safeParse(second.value);
    return stop("people", shape.success ? [`the people reply came back, but the attempt is not judged: ${report.problem}`] : peopleIssues(shape.error.issues));
  }

  // ---- Code from here on. ----
  const judged = finishCase(args.attemptId, presented, second.value, salt);
  if (judged.case) report.case = judged.case;
  if (judged.quality) report.quality = judged.quality;
  report.notes.push(...judged.notes);
  if (judged.failedAt) return stop(judged.failedAt, judged.reasons);
  return { ...report, accepted: true };
}
