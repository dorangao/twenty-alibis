/**
 * The arguments of a script that can send paid requests.
 *
 * Such a script must never guess. A flag it does not know, a flag given twice, a value it
 * cannot read: each is refused before anything is connected, planned or sent. A mistyped
 * "--plans" must not turn a dry run into a real one, and "--game=2" must not quietly mean
 * game 1.
 */
export type RunArgs = { ok: true; plan: boolean; game: number } | { ok: false; why: [en: string, zh: string] };

/** `allowGame`: whether this script takes "--game N" (or "--game=N") at all. */
export function parseRunArgs(argv: readonly string[], options: { allowGame: boolean }): RunArgs {
  let plan = false;
  let game: number | undefined;
  const refuse = (en: string, zh: string): RunArgs => ({ ok: false, why: [en, zh] });
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--plan") {
      if (plan) return refuse("--plan was given twice", "--plan 出现了两次");
      plan = true;
      continue;
    }
    if (options.allowGame && (token === "--game" || token.startsWith("--game="))) {
      if (game !== undefined) return refuse("--game was given twice", "--game 出现了两次");
      const value = token === "--game" ? argv[++i] : token.slice("--game=".length);
      // Digits only, no sign, no leading zero, nothing a number parser would be generous about.
      if (value === undefined || !/^[1-9]\d{0,5}$/.test(value)) return refuse(`--game takes a whole number from 1 up, not "${value ?? ""}"`, `--game 后面要跟一个从 1 起的整数，而不是 "${value ?? ""}"`);
      game = Number(value);
      continue;
    }
    return refuse(`unknown argument "${token}"`, `无法识别的参数 "${token}"`);
  }
  return { ok: true, plan, game: game ?? 1 };
}
