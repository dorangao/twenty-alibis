import type { Case } from "../case/schema";
import { compilePlot } from "../writer/compile";
import { lighthousePeople, lighthouseSkeleton } from "../writer/fixtures/lighthouse";

/**
 * The lighthouse case as a file in `cases/released/`: the handwritten 20-person plot, put
 * together by the same code that puts a generated plot together.
 *
 * It is released as a file, like any case that is added to the deployed game, so the path a
 * released case takes (a file beside the function, read and put through the gate when the
 * server starts) is the path this one takes too. A test checks that the file in the
 * repository is exactly this text, so the file cannot drift from the plot it is made of.
 *
 * Its answer is public already: the replay that ships with the page plays it to the end.
 */
export const RELEASED_LIGHTHOUSE = "cases/released/lighthouse.json";

export function lighthouseCase(): Case {
  const built = compilePlot("lighthouse", lighthouseSkeleton, lighthousePeople);
  if (!built.ok) throw new Error(`the lighthouse plot does not compile: ${built.problems.join("; ")}`);
  return built.case;
}

/** The text of the released file. */
export const lighthouseFileText = (): string => `${JSON.stringify(lighthouseCase(), null, 2)}\n`;
