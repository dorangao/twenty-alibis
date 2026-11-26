import { checkCase } from "../case/solver";
import type { Case } from "../case/schema";

type Why = [en: string, zh: string];

/**
 * A case read from a file, for playing.
 *
 * The file may be a bare case or a case writer's report, which holds the case under "case".
 * Nothing in the file is taken at its word: whatever a report says about itself, the case in
 * it goes through the same gate as every case before anyone plays it (the schema, the truth
 * and evidence checks, and the solver). A file that does not pass is not played.
 *
 * What this check covers: the case is well formed, its truth holds together, and a player can
 * prove it. That makes it fair to play. It is NOT the case writer's quality gate
 * (`assessQuality`): a case whose briefing gives too much away, or whose shortlist is too
 * short, loads and plays. So this is an author's preview and a way to play a case, not a way
 * to certify one for release.
 *
 * A refusal says which kind of failure it was and nothing more. The gate's own reasons name
 * the people and facts of the hidden truth ("the hidden truth points at A, but the culprit is
 * B"), and whoever runs this command is a player. The details are for the author, from the
 * gate itself (`checkCase`).
 */
export type Refusal = "not-json" | "not-a-case" | "malformed" | "inconsistent" | "unprovable";

const REFUSALS: Record<Refusal, Why> = {
  "not-json": ["the file is not JSON", "文件不是 JSON"],
  "not-a-case": ["the file does not hold a case", "文件里没有案件"],
  malformed: ["the case in the file is not in the form a case must have", "文件里的案件格式不符合要求"],
  inconsistent: ["the case in the file does not hold together", "文件里的案件自相矛盾"],
  unprovable: ["the case in the file cannot be proven by a player", "文件里的案件无法由玩家证明"],
};

export function loadCase(text: string): { ok: true; c: Case } | { ok: false; refusal: Refusal; why: Why } {
  const refuse = (refusal: Refusal) => ({ ok: false as const, refusal, why: REFUSALS[refusal] });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse("not-json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return refuse("not-a-case");
  const inner = (parsed as { case?: unknown }).case;
  const candidate = inner && typeof inner === "object" ? inner : parsed;
  const gate = checkCase(candidate);
  // Which layer refused it, and no more: see the note above.
  if (!gate.validation.ok) return refuse(gate.validation.issues.some((issue) => issue.layer === "schema") ? "malformed" : "inconsistent");
  if (!gate.accepted) return refuse("unprovable");
  return { ok: true, c: gate.validation.case };
}

export type PlayArgs = { ok: true; language: "en" | "zh"; live: boolean; casePath: string | null } | { ok: false; why: Why };

/**
 * The arguments of the terminal game, read whole. `--live` can spend, so nothing is guessed:
 * an argument this does not know, or one given twice, is refused.
 */
export function parsePlayArgs(argv: readonly string[]): PlayArgs {
  let zh = false;
  let live = false;
  let casePath: string | null = null;
  const refuse = (en: string, zh: string): PlayArgs => ({ ok: false, why: [en, zh] });
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--zh") {
      if (zh) return refuse("--zh was given twice", "--zh 出现了两次");
      zh = true;
    } else if (token === "--live") {
      if (live) return refuse("--live was given twice", "--live 出现了两次");
      live = true;
    } else if (token === "--case" || token.startsWith("--case=")) {
      if (casePath !== null) return refuse("--case was given twice", "--case 出现了两次");
      const value = token === "--case" ? argv[++i] : token.slice("--case=".length);
      if (!value || value.startsWith("--")) return refuse("--case takes the path of a case file", "--case 后面要跟案件文件的路径");
      casePath = value;
    } else return refuse(`unknown argument "${token}"`, `无法识别的参数 "${token}"`);
  }
  return { ok: true, language: zh ? "zh" : "en", live, casePath };
}
