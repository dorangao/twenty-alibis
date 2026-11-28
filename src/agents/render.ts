import type { Assertion, Case } from "../case/schema";

export type Lang = "en" | "zh";

const nameOf = (c: Case, kind: "location" | "suspect" | "means" | "motive", id: string, lang: Lang): string => {
  if (kind === "location") return c.locations.find((l) => l.id === id)?.name[lang] ?? id;
  if (kind === "suspect") return c.suspects.find((s) => s.id === id)?.name[lang] ?? id;
  if (kind === "means") return c.means.find((m) => m.id === id)?.name[lang] ?? id;
  return c.motives.find((m) => m.id === id)?.text[lang] ?? id;
};

/**
 * Turn one typed assertion into a sentence, as said by `speaker`.
 *
 * This is code, not the model: the same assertion always gives the same sentence, in either
 * language, and the sentence says nothing the assertion does not. The notebook is built from
 * these, and they are the fallback line when a suspect's own wording cannot be used.
 */
export function renderAssertion(c: Case, speaker: string, assertion: Assertion, lang: Lang): string {
  const p = assertion.prop;
  const self = p.subject === speaker;
  const who = self ? (lang === "en" ? "I" : "我") : nameOf(c, "suspect", p.subject, lang);

  if (p.kind === "at") {
    const where = nameOf(c, "location", p.location, lang);
    return lang === "en" ? `${who} was in the ${where.toLowerCase()} at ${p.slot}.` : `${p.slot} ${who}在${where}。`;
  }
  if (p.kind === "means") {
    const what = nameOf(c, "means", p.means, lang);
    if (lang === "en") {
      const verb = self ? (p.value ? "have" : "do not have") : p.value ? "has" : "does not have";
      return `${who} ${verb} ${what.charAt(0).toLowerCase()}${what.slice(1)}.`;
    }
    return `${who}${p.value ? "有" : "没有"}${what}。`;
  }
  const why = nameOf(c, "motive", p.motive, lang);
  if (lang === "en") {
    return p.value ? `${who} had a motive: ${why}` : `${who} had no such motive: ${why}`;
  }
  return p.value ? `${who}有动机：${why}` : `${who}没有这个动机：${why}`;
}

/**
 * A statement at second hand: what `source` says, as someone it was told to repeats it. The
 * statement inside the quotation marks is `source`'s own sentence, word for word as code
 * renders it. Nothing is added and nothing is vouched for.
 */
export function renderHearsay(c: Case, source: string, assertion: Assertion, lang: Lang): string {
  const who = nameOf(c, "suspect", source, lang);
  const said = renderAssertion(c, source, assertion, lang);
  return lang === "en" ? `${who} told me: “${said}”` : `${who}跟我说：“${said}”`;
}
