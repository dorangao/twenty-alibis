import type { Case } from "../case/schema";
import { checkCase } from "../case/solver";
import type { Metered, MeteredRequest } from "../metered";
import type { Usage } from "../spend/pricing";
import { compilePlot } from "./compile";
import { peopleMessages, peopleRequestSchema, PeopleSchema, plotIds, skeletonMessages, skeletonRequestSchema, SkeletonSchema, type Skeleton, type SkeletonBrief } from "./plot";
import { assessQuality, type Quality } from "./quality";
import { skeletonProblems } from "./skeleton";

/**
 * One attempt at a new case: two requests to the model, then code.
 *
 *   skeleton request -> parse -> people request -> parse -> compile -> checkCase -> quality gate
 *
 * The attempt stops at the first stage that fails and says which one, so a run of attempts
 * can report where plots go wrong. There is no repair here: a failed attempt is a failed
 * attempt. A request that is refused, fails, or comes back with its cost unconfirmed ends
 * the attempt, and the caller should end its run. An attempt with such a problem is never
 * reported as accepted, even when both replies arrived.
 */

export const WRITER_PROMPT_ID = "writer-v1";
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
}

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
}

/**
 * Everything code can tell about a skeleton before the second request: it has the right
 * shape, the right number of people and rooms, rooms that connect, and names the line guard
 * can tell apart. Surplus suspects are dropped here, where no answer exists yet; too few is
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

export async function writeCase(args: WriteArgs): Promise<WriteReport> {
  const report: WriteReport = { accepted: false, reasons: [], notes: [], requests: 0, costNano: 0, usage: [] };
  const stop = (failedAt: WriteStage, reasons: string[]): WriteReport => ({ ...report, failedAt, reasons });

  /** Send one request and read its reply as JSON. Null when the attempt must stop; the reason is then in `report.reasons`. */
  const ask = async (stage: "skeleton" | "people", request: Omit<MeteredRequest, "attemptId" | "promptId" | "step">): Promise<{ value: unknown } | null> => {
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
    args.onReply?.({ attemptId, stage, text: result.response.text, finishReason: result.response.finishReason, usage: result.response.usage, settled: result.settled, breached: result.breached });
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
  const ids = plotIds(checked.skeleton);
  const second = await ask("people", { messages: peopleMessages(checked.skeleton, ids), responseSchema: peopleRequestSchema(ids), maxOutputTokens: PEOPLE_OUTPUT_TOKENS });
  if (second === null) return stop("people", report.reasons);
  const people = PeopleSchema.safeParse(second.value);
  if (!people.success) return stop("people", people.error.issues.slice(0, 8).map((i) => `people: ${i.path.join(".") || "(the whole reply)"}: ${i.message}`));
  // The reply is here, but its cost is not confirmed or the envelope is suspended. Until
  // that is reconciled the attempt is not counted as anything: not accepted, not judged.
  if (report.problem) return stop("people", [`the people reply came back, but the attempt is not judged: ${report.problem}`]);

  // ---- Code from here on. ----
  const compiled = compilePlot(args.attemptId, checked.skeleton, people.data);
  if (!compiled.ok) return stop("compile", compiled.problems);
  report.case = compiled.case;
  const gate = checkCase(compiled.case);
  if (!gate.accepted) return stop("gate", gate.reasons);
  const quality = assessQuality(compiled.case);
  report.quality = quality;
  report.notes.push(...quality.notes);
  if (quality.problems.length > 0) return stop("quality", quality.problems);
  return { ...report, accepted: true };
}
