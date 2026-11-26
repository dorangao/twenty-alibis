/**
 * The rules of proof, as every player is told them: a person at the terminal, in either
 * language, and the detective that plays the same game.
 *
 * They describe how an accusation is scored (src/case/proof.ts). They are the same for every
 * case and say nothing about any case's answer. One text, so the person and the detective
 * cannot be told different things.
 *
 * The word is "evidence", not "records". What proves a fact is any item of evidence that is
 * authoritative, whether it is a record or an object; an item that is not authoritative
 * proves nothing, whatever its kind. The notebook marks such an item with NOTE_MARK.
 */
export interface Rule {
  en: string;
  zh: string;
}

export const PROOF_RULES: readonly Rule[] = [
  {
    en: "Evidence is what proves something: the records and objects in your notebook. An item marked as a note is not evidence and proves nothing. What a suspect says proves nothing by itself, but hearing someone can open evidence that was closed.",
    zh: "能证明事情的是证据：你笔记本里的记录和物证。标为“备注”的条目不算证据，不能证明任何事。嫌疑人说的话本身也不能证明任何事，但听某人说话，可能让你查到原本查不了的证据。",
  },
  {
    en: "To solve the case, accuse one person and cite evidence that together shows three things about them: they were at the scene at the time of death, they held what was needed, and they had a motive.",
    zh: "要破案，须指认一个人，并引用证据，合起来证明三件事：死亡时刻此人在现场，此人持有作案所需之物，此人有动机。",
  },
  {
    en: "The evidence you cite must also rule out everyone else. A person is ruled out by evidence that places them somewhere else at that time, or that shows they did not hold what was needed, or that shows they had none of the motives listed in this case.",
    zh: "你引用的证据还必须排除其他所有人。排除一个人，要有证据证明此人当时在别处，或证明此人没有持有所需之物，或证明本案列出的每一种动机此人都没有。",
  },
  {
    // Decided on Nov 26, 2026 after two games in which the right person was accused as soon as
    // the scene's record showed one person who fitted. The record names who was seen. It is
    // not a roll call, and the score has never treated it as one.
    en: "A room's record lists the people who were seen there. It does not show that nobody else was. So being absent from the scene's record does not rule a person out.",
    zh: "房间记录只列出在那里被看到的人，并不表示当时没有别人。所以，一个人不在现场记录上，并不算被排除。",
  },
];

/** How the notebook marks an item that is not authoritative: it is shown, and it proves nothing. */
export const NOTE_MARK: Rule = { en: "(a note, not evidence)", zh: "（备注，不算证据）" };
