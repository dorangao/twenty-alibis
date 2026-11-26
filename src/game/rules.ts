/**
 * The rules of proof, as every player is told them: a person at the terminal, in either
 * language, and the detective that plays the same game.
 *
 * They describe how an accusation is scored (src/case/proof.ts). They are the same for every
 * case and say nothing about any case's answer. One text, so the person and the detective
 * cannot be told different things.
 */
export interface Rule {
  en: string;
  zh: string;
}

export const PROOF_RULES: readonly Rule[] = [
  {
    en: "Only records prove anything. What a suspect says proves nothing by itself, but hearing someone can open a record that was closed.",
    zh: "只有记录能证明事情。嫌疑人说的话本身不能证明任何事，但听某人说话，可能打开一项原本查不了的记录。",
  },
  {
    en: "To solve the case, accuse one person and cite records that together show three things about them: they were at the scene at the time of death, they held what was needed, and they had a motive.",
    zh: "要破案，须指认一个人，并引用记录，合起来证明三件事：死亡时刻此人在现场，此人持有作案所需之物，此人有动机。",
  },
  {
    en: "The records you cite must also rule out everyone else. A person is ruled out by a record that places them somewhere else at that time, or by a record that shows they did not hold what was needed, or by records that show they had none of the motives.",
    zh: "你引用的记录还必须排除其他所有人。排除一个人，要有记录证明此人当时在别处，或证明此人没有持有所需之物，或证明此人没有任何一种动机。",
  },
  {
    // Decided on Nov 26, 2026 after two games in which the right person was accused as soon as
    // the scene's record showed one person who fitted. The record names who was seen. It is
    // not a roll call, and the score has never treated it as one.
    en: "A room's record lists the people who were seen there. It does not show that nobody else was. So being absent from the scene's record does not rule a person out.",
    zh: "房间记录只列出在那里被看到的人，并不表示当时没有别人。所以，一个人不在现场记录上，并不算被排除。",
  },
];
