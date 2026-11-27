/**
 * Every word the page itself says, in both languages. The case's own words (titles, records,
 * statements, the rules of proof) come from the server, already in both.
 */
export type Lang = "en" | "zh";
export interface Text {
  en: string;
  zh: string;
}

const s = (en: string, zh: string): Text => ({ en, zh });

export const S = {
  brand: s("Twenty Alibis", "二十条口供"),
  tagline: s("Every suspect is an agent. Code owns the truth.", "每位嫌疑人都是一个智能体。真相由代码掌管。"),
  language: s("中文", "English"),
  languageLabel: s("Switch to Chinese", "切换到英文"),

  library: s("Cases", "案件"),
  libraryHint: s("Pick a case. You get a briefing, a list of people, and a limited number of actions.", "选一个案件。你会拿到案情简报、人物名单，以及有限的行动次数。"),
  open: s("Open the case", "打开案件"),
  people: s("people", "人"),
  rooms: s("rooms", "个房间"),
  actionsCap: s("actions", "次行动"),
  loading: s("Loading…", "加载中…"),
  noCases: s("No case is available.", "暂无可玩的案件。"),
  backToCases: s("All cases", "所有案件"),
  resume: s("Continue the case in progress", "继续进行中的案件"),

  modelOff: s("Model off: answers are worded by code. Nothing is sent, nothing is spent.", "模型已关闭：回答由代码写成。不发送请求，不产生费用。"),
  modelOn: s("Muse Ember answers in each suspect's own words.", "Muse Ember 用每位嫌疑人自己的话回答。"),
  actionsLeft: s("Actions left", "剩余行动"),
  requests: s("requests", "次请求"),
  confirmed: s("confirmed", "已确认"),
  working: s("Working…", "处理中…"),
  caseOver: s("This case is over.", "本案已结束。"),

  briefing: s("Briefing", "案情简报"),
  rules: s("How a case is proven", "怎样才算证明"),
  peopleTitle: s("People", "人物"),
  pickPerson: s("Pick a person to question.", "选一个人来询问。"),
  topics: s("Ask about", "可以问"),
  heard: s("heard", "已听过"),
  ownWords: s("Ask in your own words", "用自己的话提问"),
  ownWordsPlaceholder: s("Type a question for this person…", "输入要问此人的问题…"),
  ownWordsOff: s("A question in your own words needs the model, which is off here. Pick a topic above.", "用自己的话提问需要模型，这里模型是关闭的。请从上面的话题里选。"),
  send: s("Ask", "提问"),
  nothingAsked: s("Nothing asked yet.", "还没有问过。"),
  sourceModel: s("in their own words", "本人原话"),
  sourceRendered: s("worded by code", "由代码写成"),
  sourceDeflection: s("no statement", "没有陈述"),
  noted: s("noted", "条已记入笔记本"),
  againEn: s("again, in English", "再听一遍（英文）"),
  againZh: s("again, in Chinese", "再听一遍（中文）"),

  notebook: s("Notebook", "笔记本"),
  evidence: s("Evidence", "证据"),
  inspect: s("Records to inspect", "可查看的记录"),
  inspected: s("inspected", "已查看"),
  nothingToInspect: s("Nothing more to inspect right now.", "目前没有可查看的记录。"),
  statements: s("Statements heard", "听到的陈述"),
  noStatements: s("No statements yet.", "还没有陈述。"),
  contradictedBy: s("Against", "与之矛盾："),

  accuse: s("Accuse", "指认"),
  accuseTitle: s("Name the culprit", "指认凶手"),
  accuseWarn: s("This ends the case. Your cited evidence is scored by code.", "指认后本案结束。你引用的证据由代码评分。"),
  whom: s("Who did it?", "凶手是谁？"),
  choose: s("Choose a person", "选择一个人"),
  cite: s("Evidence you cite", "你引用的证据"),
  citeAll: s("All", "全选"),
  citeNone: s("None", "全不选"),
  confirmAccuse: s("Accuse and end the case", "指认并结案"),
  cancel: s("Cancel", "取消"),
  noActions: s("You have no actions left. You can still accuse.", "行动次数已用完。仍然可以指认。"),

  verdictSolved: s("Solved. The right person, and your evidence proves it.", "破案。指认正确，证据确凿。"),
  verdictUnproven: s("Right, but unproven. You named the right person, but your evidence leaves a gap.", "说对了，但未证明。人指认对了，证据还有缺口。"),
  verdictWrong: s("Wrong. That is not who did it.", "指认错误。凶手不是此人。"),
  youAccused: s("You accused", "你指认了"),
  notProven: s("Not proven for them", "对此人尚未证明"),
  notRuledOut: s("Not ruled out", "尚未排除"),
  ruledOutByOwn: s("Your own evidence rules that person out.", "你引用的证据本身就排除了这个人。"),
  opportunity: s("opportunity", "机会"),
  means: s("means", "手段"),
  motive: s("motive", "动机"),
  truth: s("The truth", "真相"),
  itWas: s("It was", "凶手是"),
  lies: s("The lies", "谎言"),
  lieCaught: s("you caught it", "被你识破"),
  lieHeard: s("you heard it, but held nothing against it", "你听到了，但手里没有反驳它的证据"),
  lieMissed: s("you never heard it", "你没有听到"),
  whereEveryoneWas: s("Where everyone really was", "每个人真正在哪里"),
  person: s("Person", "人物"),
  playAnother: s("Play another case", "再玩一个案件"),

  networkError: s("The server could not be reached. Check that it is running, then try again.", "无法连接服务器。请确认它在运行，然后重试。"),
  notRefreshed: s("The page could not be brought up to date just now. Nothing more was done. Use Refresh to see where the game stands.", "页面暂时无法更新。没有执行任何其他操作。请点“刷新”查看这一局的进展。"),
  resumeFailed: s("Your game in progress could not be opened just now. It has not been lost.", "暂时无法打开你进行中的那一局。它没有丢失。"),
  refresh: s("Refresh", "刷新"),
  tryAgain: s("Try again", "重试"),
  dismiss: s("Dismiss", "关闭"),
} satisfies Record<string, Text>;

export const pick = (lang: Lang, text: Text): string => text[lang];

/**
 * "Dr. Chen died at 21:00 in the lamp room and was found at 21:20." When the body was found
 * somewhere else, the line says where: "… and was found in the cellar at 21:20."
 */
export function victimLine(lang: Lang, v: { name: Text; died: { slot: string; room: Text }; found: { slot: string; room: Text } }): string {
  const elsewhere = v.found.room.en !== v.died.room.en || v.found.room.zh !== v.died.room.zh;
  if (lang === "en") return `${v.name.en} died at ${v.died.slot} in the ${v.died.room.en.toLowerCase()} and was found ${elsewhere ? `in the ${v.found.room.en.toLowerCase()} ` : ""}at ${v.found.slot}.`;
  return `${v.name.zh}于 ${v.died.slot} 死在${v.died.room.zh}，${v.found.slot} ${elsewhere ? `在${v.found.room.zh}` : ""}被发现。`;
}

/** Nanodollars as dollars: small amounts keep four decimals. */
export const dollars = (nano: number): string => `$${(nano / 1_000_000_000).toFixed(4)}`;
