import type { Assertion, Case } from "../case/schema";
import { renderAssertion, type Lang } from "./render";

/**
 * The guard on a suspect's own wording.
 *
 * The model writes the line a player hears. Code does not trust it: a line is shown only if
 * it passes every check here, and otherwise the code-rendered sentence is shown instead.
 *
 * What the guard can do: it works on words. It knows the case's closed vocabulary (people,
 * places, times, the means) and refuses a line that names any of it beyond what the accepted
 * statements already say. It also refuses a line that leaves a statement's place or object
 * out, flips a statement with a "not", claims to have been alone, is in the wrong language,
 * is too long, or steps out of character.
 *
 * What it cannot do: judge meaning. A line can add or bend a fact in words the vocabulary
 * does not know. So the game's promise does not rest on the line: the notebook is rendered
 * by code from the typed statements, and only the notebook counts as evidence.
 */

export type GuardReason =
  /** Nothing to show. */
  | "empty"
  | "too-long"
  /** Not in the language the player asked in. */
  | "wrong-language"
  /** Names a person, place, time or object that the accepted statements do not. */
  | "uncovered"
  /** Does not name the place or object of a statement it is supposed to make. */
  | "omits"
  /** Puts a "not" beside a case fact that the statements assert, or drops the "not" of a denial. */
  | "polarity"
  /** Says something about everyone else: "alone", "nobody else", "就我一个". */
  | "exclusive"
  /** Mentions being an AI, a model or a prompt. */
  | "breaks-character";

export type GuardResult = { ok: true } | { ok: false; reason: GuardReason; detail: string };

/** A line may not be longer than this many characters. Three short sentences fit easily. */
export const MAX_LINE_CHARS = 320;

const HAN = /\p{Script=Han}/u;

/** The language a player wrote in: Chinese if the text has any Chinese character, else English. */
export function languageOf(text: string): Lang {
  return HAN.test(text) ? "zh" : "en";
}

// ---- The case's closed vocabulary ----

const FUNCTION_WORDS = new Set(["the", "and", "for", "with", "from", "into", "onto", "that", "this", "its", "his", "her"]);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The words of an English name that are worth matching on their own: three letters or more, no function words. */
const wordsOf = (name: string): string[] =>
  (name.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length >= 3 && !FUNCTION_WORDS.has(w));

/** Every run of two or more characters in a Chinese name: a three-character name is also heard as its last two. */
const piecesOf = (name: string): string[] => {
  const chars = [...name];
  const out: string[] = [];
  for (let size = 2; size <= chars.length; size++) {
    for (let i = 0; i + size <= chars.length; i++) out.push(chars.slice(i, i + size).join(""));
  }
  return out;
};

/**
 * The Chinese pieces of a means name, with any place name inside it taken out first:
 * "档案室钥匙" (the archive key) is heard as "钥匙", and "档案室" is already a place.
 */
const meansPieces = (c: Case, name: string): string[] => {
  let rest = name;
  for (const l of c.locations) rest = rest.split(l.name.zh).join("\n");
  return rest.split("\n").flatMap(piecesOf);
};

interface Vocabulary {
  /** English words, matched whole, in any case, with an optional plural or possessive ending. */
  en: { form: string; pattern: RegExp }[];
  /** Chinese forms, matched anywhere in the text. */
  zh: string[];
}

const cache = new WeakMap<Case, Vocabulary>();

/**
 * Every way the case's people, places, means and non-clock time slots are named, in both
 * languages. Each word of a name counts by itself ("Dining hall" is heard in "the hall"),
 * so an ordinary word that is also part of a name gets a line refused. That errs toward
 * the code-rendered sentence, which is always right. The victim is not in the vocabulary:
 * the victim is public and no statement is about them.
 */
function vocabulary(c: Case): Vocabulary {
  const known = cache.get(c);
  if (known) return known;
  const en = new Set<string>();
  const zh = new Set<string>();
  for (const s of c.suspects) {
    for (const w of wordsOf(s.name.en)) en.add(w);
    for (const piece of piecesOf(s.name.zh)) zh.add(piece);
  }
  for (const l of c.locations) {
    for (const w of wordsOf(l.name.en)) en.add(w);
    zh.add(l.name.zh);
  }
  for (const m of c.means) {
    for (const w of wordsOf(m.name.en)) en.add(w);
    for (const piece of meansPieces(c, m.name.zh)) zh.add(piece);
  }
  for (const slot of c.slots) {
    if (parseClock(slot)) continue; // clock times are found by the time detector
    (HAN.test(slot) ? zh : en).add(slot.toLowerCase());
  }
  const built: Vocabulary = {
    en: [...en].map((form) => ({
      form,
      pattern: new RegExp(`(?<![a-z])${escapeRegex(form)}(?:s|es|'s|’s)?(?![a-z])`, "i"),
    })),
    zh: [...zh],
  };
  cache.set(c, built);
  return built;
}

// ---- Times ----

const parseClock = (text: string): { h: number; m: number } | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  return match ? { h: Number(match[1]), m: Number(match[2]) } : null;
};

const HOUR_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, noon: 12, midnight: 12 };
const MINUTE_WORDS: Record<string, number> = { thirty: 30, fifteen: 15, "forty-five": 45, "forty five": 45, twenty: 20, forty: 40, ten: 10 };
const ZH_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** "九" → 9, "十二" → 12, "二十一" → 21, "21" → 21. */
const zhNumber = (text: string): number | null => {
  if (/^\d+$/.test(text)) return Number(text);
  const ten = text.indexOf("十");
  if (ten === -1) return text.length === 1 && text in ZH_DIGITS ? ZH_DIGITS[text]! : null;
  const tens = ten === 0 ? 1 : ZH_DIGITS[text.slice(0, ten)];
  const ones = ten === text.length - 1 ? 0 : ZH_DIGITS[text.slice(ten + 1)];
  return tens === undefined || ones === undefined ? null : tens * 10 + ones;
};

const HOUR_WORD = Object.keys(HOUR_WORDS).join("|");
const MINUTE_WORD = "thirty|fifteen|forty[- ]five|twenty|forty|ten";
const ZH_NUM = "(?:\\d{1,2}|[零〇一二两三四五六七八九十]{1,3})";
const TIME_PATTERNS: { pattern: RegExp; read(m: RegExpExecArray): [number, number] | null }[] = [
  // 21:00, 9：30, 9.30
  { pattern: /(?<!\d)(\d{1,2})[:：.](\d{2})(?!\d)/g, read: (m) => [Number(m[1]), Number(m[2])] },
  // 9 pm, 9 o'clock
  { pattern: /(?<![\d:：.])(\d{1,2})\s*(?:a\.?m\b|p\.?m\b|o['’]?clock)/gi, read: (m) => [Number(m[1]), 0] },
  // at 9, around 9
  { pattern: /\b(?:at|around|about|by|before|after|until|till)\s+(\d{1,2})\b(?![:：.]\d)/gi, read: (m) => [Number(m[1]), 0] },
  // half past nine
  { pattern: new RegExp(`\\bhalf\\s+past\\s+(${HOUR_WORD}|\\d{1,2})\\b`, "gi"), read: (m) => [HOUR_WORDS[m[1]!.toLowerCase()] ?? Number(m[1]), 30] },
  // nine thirty, nine o'clock, nine pm
  {
    pattern: new RegExp(`\\b(${HOUR_WORD})[\\s-]+(${MINUTE_WORD}|o['’]?clock|a\\.?m\\b|p\\.?m\\b)`, "gi"),
    read: (m) => [HOUR_WORDS[m[1]!.toLowerCase()]!, MINUTE_WORDS[m[2]!.toLowerCase().replace("-", " ")] ?? MINUTE_WORDS[m[2]!.toLowerCase()] ?? 0],
  },
  // at nine, around noon. Not "at one": "one" after these words is rarely a time ("at one point").
  {
    pattern: new RegExp(`\\b(?:at|around|about|by|before|after|until|till)\\s+(?!one\\b)(${HOUR_WORD})\\b(?![\\s-]+(?:${MINUTE_WORD})\\b)`, "gi"),
    read: (m) => [HOUR_WORDS[m[1]!.toLowerCase()]!, 0],
  },
  // noon, midnight, 中午, 午夜
  { pattern: /\b(?:noon|midday|midnight)\b|正午|中午|午夜|半夜/gi, read: () => [12, 0] },
  // 九点, 9点半, 九点二十, 21时. A bare "一点" is skipped: it usually means "a little".
  {
    pattern: new RegExp(`(${ZH_NUM})\\s*(点|點|时(?=[^候间期代刻]|$))(半|一刻|三刻|${ZH_NUM})?(钟|整|分)?`, "g"),
    read: (m) => {
      const hour = zhNumber(m[1]!);
      if (hour === null) return null;
      if (m[2] === "时" && !/^\d/.test(m[1]!)) return null;
      if (m[1] === "一" && !m[3] && !m[4]) return null;
      const tail = m[3];
      const minute = !tail ? 0 : tail === "半" ? 30 : tail === "一刻" ? 15 : tail === "三刻" ? 45 : zhNumber(tail);
      return minute === null ? null : [hour, minute];
    },
  },
];

/** Every clock time a text mentions, on a twelve-hour face: "21:00", "nine" and "九点" are the same time. */
function timesIn(text: string): string[] {
  const found = new Set<string>();
  for (const { pattern, read } of TIME_PATTERNS) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
      const time = read(m);
      if (time && time[0] <= 24 && time[1] < 60) found.add(`time ${time[0] % 12}:${String(time[1]).padStart(2, "0")}`);
    }
  }
  return [...found];
}

/** Every piece of the case's vocabulary, and every clock time, that a text mentions. */
export function mentions(c: Case, text: string): string[] {
  const v = vocabulary(c);
  return [...v.en.filter((e) => e.pattern.test(text)).map((e) => e.form), ...v.zh.filter((form) => text.includes(form)), ...timesIn(text)];
}

// ---- The other word lists ----

const NEGATION_EN = /\b(?:no|not|never|nor|neither|nobody|nowhere|none|nothing|without|cannot)\b|n['’]t\b/i;
const NEGATION_ZH = /不|没|未|无|別|别(?![人的处])/;
const hasNegation = (text: string) => NEGATION_EN.test(text) || NEGATION_ZH.test(text);

const EXCLUSIVE = /\b(?:alone|by myself|on my own|only me|just me|(?:nobody|no one|no-one) else)\b|独自|一个人|就我|只有我|没有别人|没别人|没有其他人|没其他人|没有旁人/i;
const OUT_OF_CHARACTER = /\bAI\b|\b[Ll]anguage model\b|\b[Ss]ystem prompt\b|\b[Tt]ool call\b|人工智能|语言模型|提示词|工具调用/;

/** Split a line where a speaker would pause: sentence ends, commas, dashes. A colon inside "21:00" is not a pause. */
const clauses = (line: string): string[] =>
  line
    .split(/(?<=[!?;。！？；，、…])|(?<=[.,])(?=\s|$)|\s[-–—]+\s|[–—]+|\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const isNegative = (a: Assertion) => a.prop.kind !== "at" && !a.prop.value;

/** What the suspect may be taken to have named: its own statements as code words them, its own name and its role. */
function coveredText(c: Case, speaker: string, accepted: readonly Assertion[]): string {
  const self = c.suspects.find((s) => s.id === speaker);
  return [
    ...accepted.flatMap((a) => [renderAssertion(c, speaker, a, "en"), renderAssertion(c, speaker, a, "zh")]),
    self ? `${self.name.en} ${self.name.zh} ${self.role.en} ${self.role.zh}` : "",
  ].join("\n");
}

/**
 * What a line must name to count as making a statement: its place or its object, and its
 * subject when the statement is about someone else. Each group needs one name heard.
 */
function requiredNames(c: Case, speaker: string, a: Assertion): string[][] {
  const groups: string[][] = [];
  const prop = a.prop;
  if (prop.subject !== speaker) {
    const subject = c.suspects.find((s) => s.id === prop.subject);
    if (subject) groups.push([...wordsOf(subject.name.en), ...piecesOf(subject.name.zh)]);
  }
  if (prop.kind === "at") {
    const location = c.locations.find((l) => l.id === prop.location);
    if (location) groups.push([...wordsOf(location.name.en), location.name.zh]);
  }
  if (prop.kind === "means") {
    const means = c.means.find((m) => m.id === prop.means);
    if (means) {
      // A word the means shares with a place ("a key to the archive") does not name the means.
      const placeWords = new Set(c.locations.flatMap((l) => wordsOf(l.name.en)));
      const own = wordsOf(means.name.en).filter((w) => !placeWords.has(w));
      groups.push([...(own.length > 0 ? own : wordsOf(means.name.en)), ...meansPieces(c, means.name.zh)]);
    }
  }
  return groups.filter((g) => g.length > 0);
}

/**
 * Check one line against the statements it is supposed to make.
 *
 * `accepted` are the typed statements this turn puts in the notebook. With none, the line
 * must be a plain deflection: it may name nothing from the case at all.
 */
export function guardLine(c: Case, speaker: string, accepted: readonly Assertion[], line: string, lang: Lang): GuardResult {
  const text = line.trim();
  const fail = (reason: GuardReason, detail: string): GuardResult => ({ ok: false, reason, detail });

  if (text === "") return fail("empty", "the line is blank");
  if ([...text].length > MAX_LINE_CHARS) return fail("too-long", `${[...text].length} characters, limit ${MAX_LINE_CHARS}`);
  if (languageOf(text) !== lang) return fail("wrong-language", `expected ${lang}`);

  const out = OUT_OF_CHARACTER.exec(text);
  if (out) return fail("breaks-character", out[0]);

  const allowed = new Set(mentions(c, coveredText(c, speaker, accepted)));
  const extra = mentions(c, text).filter((m) => !allowed.has(m));
  if (extra.length > 0) return fail("uncovered", extra.join(", "));

  const english = new Map(vocabulary(c).en.map((e) => [e.form, e.pattern]));
  const heard = (name: string) => (HAN.test(name) ? text.includes(name) : (english.get(name)?.test(text) ?? false));
  for (const a of accepted) {
    if (!requiredNames(c, speaker, a).every((group) => group.some(heard))) return fail("omits", a.id);
  }

  const alone = EXCLUSIVE.exec(text);
  if (alone) return fail("exclusive", alone[0]);

  const denials = accepted.filter(isNegative).length;
  if (denials === 0) {
    // Every statement is a plain assertion, so no clause may deny a case fact.
    const flipped = clauses(text).find((clause) => hasNegation(clause) && mentions(c, clause).length > 0);
    if (flipped) return fail("polarity", flipped);
  } else if (denials === accepted.length && !hasNegation(text)) {
    // Every statement is a denial, so the line must deny something.
    return fail("polarity", "a denial was stated without a negative");
  }

  return { ok: true };
}
