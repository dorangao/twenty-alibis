import type { Case } from "../case/schema";
import { checkCase } from "../case/solver";
import type { Metered, MeteredRequest } from "../metered";
import { compilePlot } from "./compile";
import { peopleMessages, peopleRequestSchema, PeopleSchema, plotIds, skeletonMessages, skeletonRequestSchema, SkeletonSchema, type SkeletonBrief } from "./plot";
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
export const SKELETON_OUTPUT_TOKENS = 6_000;
export const PEOPLE_OUTPUT_TOKENS = 6_000;

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

export interface WriteReport {
  /** True only when the case passed every stage. */
  accepted: boolean;
  /** Where the attempt stopped. Absent when it was accepted. */
  failedAt?: WriteStage;
  reasons: string[];
  /** The case, present from the compile stage on, accepted or not. */
  case?: Case;
  quality?: Quality;
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
}

export async function writeCase(args: WriteArgs): Promise<WriteReport> {
  const report: WriteReport = { accepted: false, reasons: [], requests: 0, costNano: 0, usage: [] };
  const stop = (failedAt: WriteStage, reasons: string[]): WriteReport => ({ ...report, failedAt, reasons });

  /** Send one request and read its reply as JSON. Null when the attempt must stop; the reason is already recorded. */
  const ask = async (stage: "skeleton" | "people", request: Omit<MeteredRequest, "attemptId" | "promptId" | "step">): Promise<unknown | null> => {
    const result = await args.metered({ ...request, step: `writer.${stage}`, promptId: WRITER_PROMPT_ID, attemptId: `${args.attemptId}:${stage}` });
    if (!result.ok) {
      if (result.sent) report.requests++;
      report.problem = result.sent ? "failed:outcome-unknown" : `refused:${result.reason}`;
      report.reasons = [`the ${stage} request did not come back: ${report.problem}`];
      return null;
    }
    report.requests++;
    if (result.settled) report.costNano += result.costNano;
    if (result.breached) report.problem = "envelope-suspended";
    else if (!result.settled) report.problem = "unconfirmed:not-settled";
    const u = result.response.usage;
    report.usage.push({ step: `writer.${stage}`, inputTokens: u?.inputTokens ?? 0, cachedTokens: u?.cachedTokens ?? 0, outputTokens: u?.outputTokens ?? 0, reasoningTokens: u?.reasoningTokens, finishReason: result.response.finishReason });
    if (result.response.finishReason === "length") {
      report.reasons = [`the ${stage} reply was cut off at the output limit`];
      return null;
    }
    try {
      return JSON.parse(result.response.text ?? "") as unknown;
    } catch {
      report.reasons = [`the ${stage} reply is not JSON`];
      return null;
    }
  };

  // ---- Stage 1: the skeleton. ----
  const rawSkeleton = await ask("skeleton", { messages: skeletonMessages(args.brief), responseSchema: skeletonRequestSchema, maxOutputTokens: SKELETON_OUTPUT_TOKENS });
  if (rawSkeleton === null) return stop("skeleton", report.reasons);
  const skeleton = SkeletonSchema.safeParse(rawSkeleton);
  if (!skeleton.success) return stop("skeleton", skeleton.error.issues.slice(0, 8).map((i) => `skeleton: ${i.path.join(".")}: ${i.message}`));
  // Everything that can be known to be wrong with the skeleton is checked before the second request is spent on it.
  const flaws = skeletonProblems(skeleton.data, args.brief);
  if (flaws.length > 0) return stop("skeleton", flaws);
  // The cost of the first request is not confirmed, or the envelope is suspended: send nothing more.
  if (report.problem) return stop("skeleton", [`stopped after the skeleton: ${report.problem}`]);

  // ---- Stage 2: the people. The schema offers only the ids code gave to the skeleton. ----
  const ids = plotIds(skeleton.data);
  const rawPeople = await ask("people", { messages: peopleMessages(skeleton.data, ids), responseSchema: peopleRequestSchema(ids), maxOutputTokens: PEOPLE_OUTPUT_TOKENS });
  if (rawPeople === null) return stop("people", report.reasons);
  const people = PeopleSchema.safeParse(rawPeople);
  if (!people.success) return stop("people", people.error.issues.slice(0, 8).map((i) => `people: ${i.path.join(".")}: ${i.message}`));
  // The reply is here, but its cost is not confirmed or the envelope is suspended. Until
  // that is reconciled the attempt is not counted as anything: not accepted, not judged.
  if (report.problem) return stop("people", [`the people reply came back, but the attempt is not judged: ${report.problem}`]);

  // ---- Code from here on. ----
  const compiled = compilePlot(args.attemptId, skeleton.data, people.data);
  if (!compiled.ok) return stop("compile", compiled.problems);
  report.case = compiled.case;
  const checked = checkCase(compiled.case);
  if (!checked.accepted) return stop("gate", checked.reasons);
  const quality = assessQuality(compiled.case);
  report.quality = quality;
  if (quality.problems.length > 0) return stop("quality", quality.problems);
  return { ...report, accepted: true };
}
