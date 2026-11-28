/**
 * The gate's reasons, for an author who reads Chinese.
 * 把检查给出的原因用中文说给作者听。
 *
 * The validator and the solver say why a case is refused in English sentences that carry
 * the ids of the people, records and statements involved. Those sentences stay as they are.
 * Beside each one this gives a Chinese line: what kind of fault it is and what to change,
 * followed by the ids the sentence mentions, so an author can find the place in the file.
 *
 * A reason is recognised by its code (the validator's) or by how its sentence begins (the
 * solver's). test/case-author.test.ts reads both source files and fails when a code or a
 * reason has been added there and not here.
 */

/** The validator's faults, by code. */
export const ISSUE_ZH: Record<string, string> = {
  "duplicate-id": "同一个 id 被两类不同的东西共用了。每个 id 只能用一次，请改掉其中一个。",
  "reserved-id": "有话题的 id 以 ~g 开头。这种写法留给游戏自己生成的话题（嫌疑人私下听到的话），请换一个 id。",
  "unknown-id": "引用了一个不存在的 id，或者它不是这里要求的那一类。请检查拼写，或补上被引用的条目。",
  "missing-whereabouts": "有嫌疑人在某个时段没有写所在位置。每个人在每个时段都要有位置（whereabouts）。",
  "impossible-move": "有嫌疑人在相邻两个时段之间，从一个房间到了不相邻的房间。请改位置，或在 locations 里把这两个房间设为相邻。",
  "truth-not-unique": "在隐藏的真相里，同时具备机会、手段和动机的嫌疑人必须恰好一个，现在不是一个。请调整位置、手段或动机。",
  "culprit-mismatch": "隐藏的真相指向的人，和 culprit.suspect 写的不是同一个人。请改 culprit.suspect，或改真相。",
  "culprit-motive": "culprit.motive 不是凶手自己的动机之一。请改 culprit.motive，或给凶手加上这个动机。",
  "false-record": "有一份权威证据（authoritative）证明了一件在隐藏真相里不成立的事。权威记录必须是真的。",
  "undeclared-lie": "某个话题里，嫌疑人说了一句假话，但它没有列在这个人的 lies 里。假话必须在 lies 里声明。",
  "lie-is-true": "有嫌疑人把一句真话列进了 lies。请从 lies 里去掉它。",
  "lie-never-stated": "有嫌疑人的 lies 里有一句话，但这个人的任何话题都不会说出它。请去掉它，或让某个话题说出它。",
};

/** The solver's reasons, and the gate's own, by how the sentence begins or what it contains. */
export const REASON_ZH: readonly [RegExp, string][] = [
  [/both places .+ at the scene and somewhere else/, "玩家拿得到的证据既把这个人放在现场，又把他放在别处：证据互相矛盾。"],
  [/^the proof needs /, "证明所需的行动次数超过了一局允许的次数（sessionCap）。请减少证明需要的步骤，或提高 sessionCap。"],
  [/^no suspect has opportunity, means and motive proven/, "没有任何嫌疑人的机会、手段和动机都能被玩家拿得到的证据证明。括号里是每个人还缺哪一项。"],
  [/^more than one suspect is fully proven/, "不止一个嫌疑人被完全证明。案件必须只指向一个人。"],
  [/all still fit: no reachable evidence rules out/, "这些人都还符合：玩家拿得到的证据排除不了其余的人。需要能排除他们的权威记录，例如把他们放在别处的在场记录。"],
  [/^reachable evidence rules out every suspect/, "玩家拿得到的证据把所有嫌疑人都排除了，包括凶手。"],
  [/^the lie .+ cannot be caught/, "这句假话无法被识破：没有哪一局能同时拿到这句陈述和一份与它矛盾的独立记录。"],
  [/^the solver reached its work limit/, "求解器在得出结论之前达到了工作量上限，所以拒绝此案。请缩小案件的规模。"],
  [/^the reachable evidence proves .+, but the hidden culprit is /, "玩家拿得到的证据证明的是另一个人，不是隐藏真相里的凶手。"],
];

const SCHEMA_ZH = "文件的格式不符合要求。冒号前面是出问题的字段。";
const UNKNOWN_ZH = "（这一条暂时没有中文说明，请看上面的英文原文。）";

/** Every id a case file names, wherever it is: found without trusting the file's shape. */
export function idsIn(file: unknown): Set<string> {
  const found = new Set<string>();
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") {
      for (const [key, value] of Object.entries(x)) {
        if (key === "id" && typeof value === "string") found.add(value);
        else if (key === "slots" && Array.isArray(value)) {
          for (const slot of value) if (typeof slot === "string") found.add(slot);
        } else walk(value);
      }
    }
  };
  walk(file);
  return found;
}

/**
 * The Chinese line for one reason: what kind of fault, then the ids the English sentence
 * mentions. `code` is the validator's, when the reason is one of its issues.
 */
export function reasonZh(reason: string, ids: ReadonlySet<string>, issue?: { layer: string; code: string }): string {
  const kind = issue ? (ISSUE_ZH[issue.code] ?? (issue.layer === "schema" ? SCHEMA_ZH : UNKNOWN_ZH)) : (REASON_ZH.find(([pattern]) => pattern.test(reason))?.[1] ?? UNKNOWN_ZH);
  // The ids, in the order the sentence gives them. An id is a run of letters, digits, hyphens, colons and underscores.
  // A colon can be part of an id and can also end a clause ("topic t-01: ..."), so both readings are tried.
  const words = (reason.match(/[\p{L}\p{N}_:-]+/gu) ?? []).flatMap((word) => [word, word.replace(/^:+|:+$/g, "")]);
  const mentioned = [...new Set(words.filter((word) => ids.has(word)))];
  return mentioned.length > 0 ? `${kind}（涉及：${mentioned.join("、")}）` : kind;
}
