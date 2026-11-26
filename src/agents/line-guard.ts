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
 * statements already say. It also refuses a line that leaves a statement's place, time, object
 * or motive out, puts someone beside or outside a place instead of in it, flips a statement
 * with a "not", names the wrong half of the day ("09:00" for
 * 21:00), claims to have been alone, is in the wrong language, is too long, or steps out of
 * character.
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
  /** Puts someone beside, outside or on the way to a place instead of in it: "outside the foyer", "门厅外". */
  | "displaced"
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

/**
 * The part of a case the word rules read: who and what has a name, and the time slots. A
 * whole `Case` fits, and so does a plot that has not been compiled yet.
 */
export interface Names {
  suspects: readonly { id: string; name: { en: string; zh: string } }[];
  locations: readonly { id: string; name: { en: string; zh: string } }[];
  means: readonly { id: string; name: { en: string; zh: string } }[];
  slots: readonly string[];
}

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
const meansPieces = (c: Names, name: string): string[] => {
  let rest = name;
  for (const l of c.locations) rest = rest.split(l.name.zh).join("\n");
  return rest.split("\n").flatMap(piecesOf);
};

/**
 * How the guard hears each person, place and means of a case: the English words and the
 * Chinese pieces it matches on. A case writer uses this to refuse names the guard would
 * confuse, with the very rules the guard applies.
 */
export function nameForms(c: Names): { kind: "suspect" | "location" | "means"; id: string; name: { en: string; zh: string }; en: string[]; zh: string[] }[] {
  return [
    ...c.suspects.map((s) => ({ kind: "suspect" as const, id: s.id, name: s.name, en: wordsOf(s.name.en), zh: piecesOf(s.name.zh) })),
    ...c.locations.map((l) => ({ kind: "location" as const, id: l.id, name: l.name, en: wordsOf(l.name.en), zh: [l.name.zh] })),
    ...c.means.map((m) => ({ kind: "means" as const, id: m.id, name: m.name, en: wordsOf(m.name.en), zh: meansPieces(c, m.name.zh) })),
  ];
}

interface Vocabulary {
  /** English words, matched whole, in any case, with an optional plural or possessive ending. */
  en: { form: string; pattern: RegExp }[];
  /** Chinese forms, matched anywhere in the text. */
  zh: string[];
}

const cache = new WeakMap<Names, Vocabulary>();

/**
 * Every way the case's people, places, means and non-clock time slots are named, in both
 * languages. Each word of a name counts by itself ("Dining hall" is heard in "the hall"),
 * so an ordinary word that is also part of a name gets a line refused. That errs toward
 * the code-rendered sentence, which is always right. The victim is not in the vocabulary:
 * the victim is public and no statement is about them.
 */
function vocabulary(c: Names): Vocabulary {
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
/** Which half of the day a time was said to be in, when the text says so. */
type Half = "am" | "pm" | undefined;
type Read = [hour: number, minute: number, half?: Half];

const suffixHalf = (text: string | undefined): Half => (!text ? undefined : /^a/i.test(text) ? "am" : /^p/i.test(text) ? "pm" : undefined);
/** "21:00" is the evening and "09:00" the morning. A bare "9:00" does not say. */
const clockHalf = (digits: string): Half => {
  const hour = Number(digits);
  if (hour >= 12) return "pm";
  return hour === 0 || digits.length === 2 ? "am" : undefined;
};

const TIME_PATTERNS: { pattern: RegExp; read(m: RegExpExecArray): Read | null }[] = [
  // 21:00, 9：30, 9.30
  { pattern: /(?<!\d)(\d{1,2})[:：.](\d{2})(?!\d)/g, read: (m) => [Number(m[1]), Number(m[2]), clockHalf(m[1]!)] },
  // 9 pm, 9 o'clock
  { pattern: /(?<![\d:：.])(\d{1,2})\s*(a\.?m\b|p\.?m\b|o['’]?clock)/gi, read: (m) => [Number(m[1]), 0, Number(m[1]) > 12 ? "pm" : suffixHalf(m[2])] },
  // at 9, around 9
  {
    pattern: /\b(?:at|around|about|by|before|after|until|till)\s+(\d{1,2})\b(?![:：.]\d)/gi,
    read: (m) => [Number(m[1]), 0, Number(m[1]) > 12 ? "pm" : undefined],
  },
  // half past nine
  { pattern: new RegExp(`\\bhalf\\s+past\\s+(${HOUR_WORD}|\\d{1,2})\\b`, "gi"), read: (m) => [HOUR_WORDS[m[1]!.toLowerCase()] ?? Number(m[1]), 30] },
  // nine thirty, nine o'clock, nine pm
  {
    pattern: new RegExp(`\\b(${HOUR_WORD})[\\s-]+(${MINUTE_WORD}|o['’]?clock|a\\.?m\\b|p\\.?m\\b)`, "gi"),
    read: (m) => {
      const tail = m[2]!.toLowerCase();
      return [HOUR_WORDS[m[1]!.toLowerCase()]!, MINUTE_WORDS[tail.replace("-", " ")] ?? MINUTE_WORDS[tail] ?? 0, /^[ap]\.?m/.test(tail) ? suffixHalf(tail) : undefined];
    },
  },
  // at nine, around noon. Not "at one": "one" after these words is rarely a time ("at one point").
  {
    pattern: new RegExp(`\\b(?:at|around|about|by|before|after|until|till)\\s+(?!one\\b)(${HOUR_WORD})\\b(?![\\s-]+(?:${MINUTE_WORD})\\b)`, "gi"),
    read: (m) => [HOUR_WORDS[m[1]!.toLowerCase()]!, 0],
  },
  // noon, 中午: twelve in the day. midnight, 午夜: twelve at night.
  { pattern: /\b(?:noon|midday)\b|正午|中午/gi, read: () => [12, 0, "pm"] },
  { pattern: /\bmidnight\b|午夜|半夜/gi, read: () => [0, 0, "am"] },
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
      return minute === null ? null : [hour, minute, hour > 12 ? "pm" : undefined];
    },
  },
];

const MORNING = /上午|早上|早晨|清晨|凌晨|\bmorning\b|\ba\.?m\b/i;
const EVENING = /下午|晚上|傍晚|夜里|夜晚|今晚|当晚|晚间|\bafternoon\b|\bevening\b|\bnight\b|\btonight\b|\bp\.?m\b/i;
/** The half of the day named just before or just after a time: "上午九点", "nine in the morning". */
const nearbyHalf = (text: string, start: number, end: number): Half => {
  for (const near of [text.slice(Math.max(0, start - 16), start), text.slice(end, end + 24)]) {
    const morning = MORNING.test(near);
    const evening = EVENING.test(near);
    if (morning !== evening) return morning ? "am" : "pm";
  }
  return undefined;
};

/**
 * Every clock time a text mentions. "21:00", "nine" and "九点" name the same hour. When the
 * text says which half of the day it means ("09:00", "9 a.m.", "上午九点", "21:00"), that is
 * kept: `time 9:00 am` and `time 9:00 pm` are different times, and a bare `time 9:00` fits either.
 */
function timesIn(text: string): string[] {
  const found = new Set<string>();
  for (const { pattern, read } of TIME_PATTERNS) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
      const time = read(m);
      if (!time || time[0] > 24 || time[1] >= 60) continue;
      const half = time[2] ?? nearbyHalf(text, m.index, m.index + m[0].length);
      found.add(`time ${time[0] % 12}:${String(time[1]).padStart(2, "0")}${half ? ` ${half}` : ""}`);
    }
  }
  return [...found];
}

/** Is a mention in a line covered by what the statements name? A time with no half of the day fits either half. */
function isCovered(mention: string, allowed: ReadonlySet<string>): boolean {
  if (allowed.has(mention)) return true;
  if (!mention.startsWith("time ")) return false;
  const [, clock, half] = mention.split(" ");
  return half ? allowed.has(`time ${clock}`) : allowed.has(`time ${clock} am`) || allowed.has(`time ${clock} pm`);
}

/** Every piece of the case's vocabulary, and every clock time, that a text mentions. */
export function mentions(c: Names, text: string): string[] {
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

const BESIDE_EN = "outside|near|nearby|beside|behind|above|below|opposite|toward|towards|leaving|left|entering|next to|close to|across from|out of|away from|just off|on (?:my|the|his|her) way (?:to|from|into)|heading (?:to|for|into)";
const BEFORE_ZH = "离开|前往|走向|走出|出了|赶往|去往|去|往";
const AFTER_ZH = "外|旁|附近|对面|隔壁|门口|楼上|楼下|后面|前面|上面|下面";

/** A phrase that names a place of the case but puts the person beside it, outside it or on the way to it. Null when there is none. */
function displacedPhrase(c: Case, text: string): string | null {
  for (const l of c.locations) {
    for (const word of wordsOf(l.name.en)) {
      const found = new RegExp(`\\b(?:${BESIDE_EN})\\s+(?:of\\s+)?(?:(?:the|that|this|a|an)\\s+)?(?:[a-z]+\\s+)?${escapeRegex(word)}(?![a-z])`, "i").exec(text);
      if (found) return found[0];
    }
    const name = escapeRegex(l.name.zh);
    const found = new RegExp(`(?:${BEFORE_ZH})${name}|${name}(?:${AFTER_ZH})`).exec(text);
    if (found) return found[0];
  }
  return null;
}

/** Does the line say the time of this slot? A slot that is not a clock time must appear as written. */
function slotHeard(text: string, slot: string): boolean {
  const wanted = new Set(timesIn(slot));
  if (wanted.size === 0) return text.toLowerCase().includes(slot.toLowerCase());
  return timesIn(text).some((time) => isCovered(time, wanted));
}

const MOTIVE_STOP = new Set(["that", "this", "with", "from", "have", "been", "were", "about", "would", "could", "their", "there", "which", "will", "into", "they", "them", "what", "when", "your", "victim"]);
const ZH_COMMON = new Set([..."的一是了我他她你被将即不没有这那个在和与也就都而及着过吗呢啊死者"]);

/**
 * Does a text touch the subject of a motive? A motive has no name, only a sentence, so this
 * is a loose test: an English word of the motive's sentence (four letters or more, compared
 * on its first four), or two of its Chinese characters, common ones aside. It catches a line
 * that changes the subject. It cannot tell a faithful paraphrase from a bent one.
 */
function motiveHeard(c: Case, motiveId: string, text: string): boolean {
  const motive = c.motives.find((m) => m.id === motiveId);
  if (!motive) return false;
  const stems = (motive.text.en.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length >= 4 && !MOTIVE_STOP.has(w)).map((w) => w.slice(0, 4));
  const said = new Set((text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length >= 4).map((w) => w.slice(0, 4)));
  if (stems.some((stem) => said.has(stem))) return true;
  const chars = new Set([...motive.text.zh].filter((ch) => HAN.test(ch) && !ZH_COMMON.has(ch)));
  return new Set([...text].filter((ch) => chars.has(ch))).size >= 2;
}

/**
 * What the suspect may be taken to have named: its own statements as code words them, and
 * its own name. Not its role: a role such as "Assistant to Cormac" would let a line name
 * Cormac for free.
 */
function coveredText(c: Case, speaker: string, accepted: readonly Assertion[]): string {
  const self = c.suspects.find((s) => s.id === speaker);
  return [...accepted.flatMap((a) => [renderAssertion(c, speaker, a, "en"), renderAssertion(c, speaker, a, "zh")]), self ? `${self.name.en} ${self.name.zh}` : ""].join("\n");
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
  const extra = mentions(c, text).filter((m) => !isCovered(m, allowed));
  if (extra.length > 0) return fail("uncovered", extra.join(", "));

  const english = new Map(vocabulary(c).en.map((e) => [e.form, e.pattern]));
  const heard = (name: string) => (HAN.test(name) ? text.includes(name) : (english.get(name)?.test(text) ?? false));
  for (const a of accepted) {
    if (!requiredNames(c, speaker, a).every((group) => group.some(heard))) return fail("omits", a.id);
    if (a.prop.kind === "motive" && !motiveHeard(c, a.prop.motive, text)) return fail("omits", a.id);
    // A statement about where someone was is about one time. A line that leaves the time out
    // can be heard as an answer about another.
    if (a.prop.kind === "at" && !slotHeard(text, a.prop.slot)) return fail("omits", `${a.id} (time)`);
  }
  const beside = displacedPhrase(c, text);
  if (beside) return fail("displaced", beside);
  const motives = accepted.flatMap((a) => (a.prop.kind === "motive" ? [a.prop.motive] : []));
  const namesCase = (clause: string) => mentions(c, clause).length > 0 || motives.some((id) => motiveHeard(c, id, clause));

  const alone = EXCLUSIVE.exec(text);
  if (alone) return fail("exclusive", alone[0]);

  const denials = accepted.filter(isNegative).length;
  if (denials === 0) {
    // Every statement is a plain assertion, so no clause may deny a case fact.
    const flipped = clauses(text).find((clause) => hasNegation(clause) && namesCase(clause));
    if (flipped) return fail("polarity", flipped);
  } else if (denials === accepted.length && !hasNegation(text)) {
    // Every statement is a denial, so the line must deny something.
    return fail("polarity", "a denial was stated without a negative");
  }

  return { ok: true };
}
