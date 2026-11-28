import type { Lang } from "../agents/render";
import type { Case, Text } from "../case/schema";
import type { Metered } from "../metered";
import { NOTE_MARK, PROOF_RULES } from "./rules";
import type { GossipRound } from "./gossip";
import { accuse, actionsLeft, ask, gossipDue, gossipRound, inspect, inspectionMenu, notebook, reveal, SessionError, startSession, topicMenu, type Session, type Verdict } from "./session";

/**
 * The game as lines of text: one command in, some lines out.
 *
 * This is a thin skin over the session functions. It decides nothing: what is open, what a
 * suspect states, what the notebook shows and how an accusation is scored all come from
 * `session.ts`. It exists so the whole game can be played, and tested, without a browser.
 *
 * With the model off, a topic picked from the menu still works: the suspect's statement is
 * worded by code and nothing is sent. A typed question needs the model.
 *
 * With gossip on, a round runs by itself as soon as it is due, right after the action that
 * made it due, and the game says who spoke with whom. With the model off, code picks who is
 * told and nothing is sent.
 */

export interface Game {
  /** The lines shown before the first command. */
  opening(): string[];
  /** Run one command. */
  handle(line: string): Promise<string[]>;
  /** The session so far. */
  session(): Session;
  /** True once the player has quit. */
  readonly quit: boolean;
}

const HELP: Record<Lang, string[]> = {
  en: [
    "Commands:",
    "  people                 who is here",
    "  topics <person>        what you can ask that person",
    "  ask <person> <n>       ask topic number n",
    "  say <person> <words>   ask in your own words (needs the model)",
    "  records                what you can inspect",
    "  inspect <n>            inspect record number n",
    "  notebook               what you hold: evidence, statements, contradictions",
    "  talk                   who has spoken with whom between your questions",
    "  accuse <person> <n…>   name the culprit and cite the evidence that proves it, by number",
    "  accuse <person> all    the same, citing every numbered item of evidence you hold",
    "  reveal                 the truth, after you have accused",
    "  lang en|zh             change language",
    "  quit",
    "A person is a number from `people`, or the start of a name.",
  ],
  zh: [
    "命令：",
    "  people                 在场的人",
    "  topics <人>            可以问这个人什么",
    "  ask <人> <n>           问第 n 个话题",
    "  say <人> <话>          用自己的话提问（需要模型）",
    "  records                可以查看的记录",
    "  inspect <n>            查看第 n 项",
    "  notebook               笔记本：证据、陈述、矛盾",
    "  talk                   你提问的间隙，谁和谁私下谈过",
    "  accuse <人> <n…>       指认凶手，并按编号引用能证明的证据",
    "  accuse <人> all        同上，引用你手里所有带编号的证据条目",
    "  reveal                 指认之后公开真相",
    "  lang en|zh             切换语言",
    "  quit",
    "“人”可以写 people 里的编号，或名字的开头。",
  ],
};

const SOURCE: Record<string, Text> = {
  model: { en: "in their own words", zh: "本人原话" },
  "model-retry": { en: "in their own words, second try", zh: "本人原话，第二次" },
  rendered: { en: "worded by code", zh: "代码转述" },
  deflection: { en: "nothing to state", zh: "无可陈述" },
};

const OUTCOME: Record<Verdict["outcome"], Text> = {
  solved: { en: "SOLVED. The right person, and your evidence proves it.", zh: "破案。指认正确，证据确凿。" },
  "right-but-unproven": { en: "RIGHT, BUT UNPROVEN. You named the right person, but your evidence leaves a gap.", zh: "说对了，但未证明。人指认对了，证据还有缺口。" },
  wrong: { en: "WRONG. That is not who did it.", zh: "指认错误。凶手不是这个人。" },
};

const ERRORS: Record<string, Text> = {
  over: { en: "The session has ended with your accusation. Type `reveal` to see the truth.", zh: "你已经指认，本局结束。输入 reveal 查看真相。" },
  cap: { en: "You have no actions left. You can still look at your notebook and accuse.", zh: "行动次数已用完。仍可查看笔记本和指认。" },
  "not-available": { en: "There is nothing by that name open to you.", zh: "没有这一项，或者它还没有对你开放。" },
  "bad-question": { en: "A question needs some words, and at most 300 characters.", zh: "提问不能为空，且不超过 300 个字符。" },
  "not-held": { en: "You can only cite evidence that is in your notebook.", zh: "只能引用笔记本里已有的证据。" },
  "gossip-due": { en: "The people in the house are talking among themselves. Try again in a moment.", zh: "在场的人正在私下交谈。请稍后再试。" },
};

/** The model switched off: every request is refused before anything is built or sent. */
export const noModel: Metered = async (request) => ({ ok: false, attemptId: request.attemptId, sent: false, reason: "kill-switch" });

/**
 * Decide once, at launch, whether a game may use the model, and keep to it.
 *
 * If paid requests are closed when the game starts, it gets `noModel` for good: a game that
 * told its player "nothing will be sent" must not start spending because someone authorized
 * paid requests later. If they are open, the game gets the real wrapper, which still asks
 * the spend guard on every request, so revoking the authorization stops it.
 */
export function pinAtLaunch(live: Metered | null, paidAllowedAtLaunch: boolean): { metered: Metered; modelOff: boolean } {
  return live && paidAllowedAtLaunch ? { metered: live, modelOff: false } : { metered: noModel, modelOff: true };
}

export interface GameOptions {
  language?: Lang;
  /** True when the caller knows no request can be sent. The game then says so once per question instead of reporting a refusal. */
  modelOff?: boolean;
  /** True for a game with gossip rounds. */
  gossip?: boolean;
}

export function createGame(c: Case, metered: Metered, sessionId: string, options: GameOptions = {}): Game {
  let s = startSession(c, sessionId, { gossip: options.gossip === true });
  let lang: Lang = options.language ?? "en";
  let quit = false;

  const t = (text: Text) => text[lang];
  const nameOf = (id: string) => t(c.suspects.find((x) => x.id === id)?.name ?? { en: id, zh: id });
  const say = (en: string, zh: string) => (lang === "en" ? en : zh);
  const left = () => say(`Actions left: ${actionsLeft(c, s)} of ${c.sessionCap}.`, `剩余行动：${actionsLeft(c, s)} / ${c.sessionCap}。`);

  /** A person by number, by id, by the start of an English name or by part of a Chinese one. Null when none or more than one fits. */
  const person = (word: string | undefined): string | null => {
    if (!word) return null;
    const n = Number(word);
    if (Number.isInteger(n) && n >= 1 && n <= c.suspects.length) return c.suspects[n - 1]!.id;
    const w = word.toLowerCase();
    // A Chinese name is also known by part of it: 马艾达 is 艾达.
    const fits = c.suspects.filter((x) => x.id === w || x.id === `s-${w}` || x.name.en.toLowerCase().startsWith(w) || ([...word].length >= 2 && x.name.zh.includes(word)));
    return fits.length === 1 ? fits[0]!.id : null;
  };
  const noSuchPerson = () => [say("Which person? Type `people` for the list.", "哪一位？输入 people 查看名单。")];

  /**
   * An item of evidence as the player reads it, wherever it is shown: at the briefing, when it
   * is found, and in the notebook. One that proves nothing carries the mark the rules name.
   */
  const asEvidence = (e: { text: Text; authoritative: boolean }): string => `${t(e.text)}${e.authoritative ? "" : `  ${t(NOTE_MARK)}`}`;

  const opening = (): string[] => {
    const scene = c.locations.find((l) => l.id === c.victim.death.location);
    return [
      `${c.title.en} · ${c.title.zh}`,
      t(c.setting),
      say(
        `${c.victim.name.en} died at ${c.victim.death.slot} in the ${scene?.name.en.toLowerCase() ?? "?"} and was found at ${c.victim.found.slot}.`,
        `${c.victim.name.zh}于 ${c.victim.death.slot} 死在${scene?.name.zh ?? "?"}，${c.victim.found.slot} 被发现。`,
      ),
      t(c.victim.cause),
      say("You have been given:", "你手里已有："),
      ...notebook(c, s).evidence.map((e, i) => `  ${i + 1}. ${asEvidence(e)}`),
      say("How a case is proven:", "怎样才算证明："),
      ...PROOF_RULES.map((rule, i) => `  ${i + 1}. ${t(rule)}`),
      left(),
      say("Type `help` for the commands.", "输入 help 查看命令。"),
    ];
  };

  const people = () => c.suspects.map((x, i) => `  ${i + 1}. ${t(x.name)} — ${t(x.role)}`);
  const topics = (id: string) => {
    const menu = topicMenu(c, s, id);
    if (menu.length === 0) return [say(`${nameOf(id)} has no topic to offer right now.`, `${nameOf(id)}现在没有可问的话题。`)];
    return menu.map((m, i) => `  ${i + 1}. ${t(m.label)}${m.gossip !== undefined && !m.heard ? say("  (new, from gossip)", "（新，来自私下交谈）") : ""}${m.heard ? say("  (heard)", "（已听过）") : ""}`);
  };

  /** One gossip round, as the player is told of it: who spoke with whom, never what was said. */
  const talkOf = (round: GossipRound): string[] => {
    const head = say(`Round ${round.n}, after ${round.at} actions:`, `第 ${round.n} 轮，在第 ${round.at} 次行动之后：`);
    if (round.events.length === 0) return [head, say("  nobody passed anything on", "  没有人传话")];
    return [head, ...round.events.map((e) => say(`  ${nameOf(e.from)} spoke with ${nameOf(e.to)}`, `  ${nameOf(e.from)}找${nameOf(e.to)}谈过`))];
  };
  const talk = (): string[] => {
    if (!s.gossip) return [say("This game has no gossip rounds.", "这一局没有私下交谈。")];
    if (s.gossip.rounds.length === 0) return [say("Nobody has spoken with anybody yet.", "还没有人私下交谈。")];
    return s.gossip.rounds.flatMap(talkOf);
  };
  /** Run every round that is due, and say what happened. */
  const rounds = async (): Promise<string[]> => {
    const lines: string[] = [];
    while (gossipDue(c, s)) {
      const done = await gossipRound(metered, c, s, { model: options.modelOff !== true, cacheKey: `gossip:${c.id}` });
      s = done.session;
      lines.push(
        say("While you were busy, the people in the house talked among themselves.", "你忙着查案的时候，在场的人私下谈了谈。"),
        ...talkOf(done.round).slice(1),
        say(
          `  ${done.round.chosenBy === "model" ? "Where there was a choice, the speaker's agent chose whom to tell." : "Code chose who was told; nothing was sent."} Ask a listener what they were told with \`topics\`.`,
          `  ${done.round.chosenBy === "model" ? "有不止一个人可选时，由说话者的智能体决定告诉谁。" : "由代码决定告诉谁，没有发送请求。"}用 topics 可以问听的人听到了什么。`,
        ),
      );
      if (done.round.problem && options.modelOff !== true) lines.push(say(`  (the model could not be used for some of them: ${done.round.problem})`, `  （其中一些无法使用模型：${done.round.problem}）`));
    }
    return lines;
  };
  const records = () => {
    const menu = inspectionMenu(c, s);
    if (menu.length === 0) return [say("There is nothing to inspect right now.", "现在没有可查看的东西。")];
    return menu.map((m, i) => `  ${i + 1}. ${t(m.label)}${m.done ? say("  (done)", "（已查看）") : ""}`);
  };
  const book = () => {
    const b = notebook(c, s);
    const lines = [say("Evidence:", "证据："), ...b.evidence.map((e, i) => `  ${i + 1}. ${asEvidence(e)}`)];
    lines.push(say("Statements:", "陈述："));
    if (b.statements.length === 0) lines.push(say("  none yet", "  暂无"));
    for (const st of b.statements) lines.push(`  ${nameOf(st.suspect)}: “${st[lang]}”`);
    if (b.contradictions.length > 0) {
      lines.push(say("Contradictions:", "矛盾："));
      for (const x of b.contradictions) {
        const st = b.statements.find((y) => y.suspect === x.suspect && y.assertion === x.assertion && y.source === x.source)!;
        const n = b.evidence.findIndex((e) => e.id === x.evidence) + 1;
        lines.push(say(`  ${nameOf(x.suspect)} said “${st.en}” Record ${n} says otherwise.`, `  ${nameOf(x.suspect)}说“${st.zh}”，与第 ${n} 项记录不符。`));
      }
    }
    lines.push(left());
    return lines;
  };

  const shown = (turn: Awaited<ReturnType<typeof ask>>): string[] => {
    const { turn: said, replayed, recorded } = turn;
    // Nothing reached the suspect and nothing was used up: there is no line to show.
    if (!recorded) {
      return [
        options.modelOff
          ? say("The model is off, and a question in your own words needs it. Pick a topic with `topics` and `ask`. Nothing was used up.", "模型已关闭，用自己的话提问需要模型。请用 topics 和 ask 从菜单选话题。没有消耗行动。")
          : say(`The model could not be reached (${said.problem}). Nothing was used up. You can pick a topic from the menu instead.`, `无法调用模型（${said.problem}）。没有消耗行动。可以改从菜单选话题。`),
      ];
    }
    const lines = [`${nameOf(said.suspect)}: “${said.line}”  [${t(SOURCE[said.source]!)}${replayed ? say(", heard before", "，重听") : ""}]`];
    for (const st of said.statements) lines.push(say(`  noted: “${st.en}”`, `  已记入笔记本：“${st.zh}”`));
    if (said.problem && !replayed && !options.modelOff) lines.push(say(`  (the model could not be used: ${said.problem})`, `  （模型不可用：${said.problem}）`));
    if (!replayed) lines.push(left());
    return lines;
  };

  const run = async (line: string): Promise<string[]> => {
    const words = line.trim().split(/\s+/).filter(Boolean);
    const command = (words[0] ?? "").toLowerCase();
    switch (command) {
      case "":
        return [];
      case "help":
      case "帮助":
        return HELP[lang];
      case "lang": {
        if (words[1] !== "en" && words[1] !== "zh") return [say("Use `lang en` or `lang zh`.", "请输入 lang en 或 lang zh。")];
        lang = words[1];
        return [say("English.", "中文。")];
      }
      case "people":
      case "who":
      case "人物":
        return people();
      case "topics": {
        const id = person(words[1]);
        return id ? topics(id) : noSuchPerson();
      }
      case "ask": {
        const id = person(words[1]);
        if (!id) return noSuchPerson();
        const topic = topicMenu(c, s, id)[Number(words[2]) - 1];
        if (!topic) return [say("Which topic? Type `topics <person>` for the list.", "哪个话题？输入 topics <人> 查看。")];
        const result = await ask(metered, c, s, { suspect: id, topic: topic.id, language: lang, cacheKey: `case:${c.id}` });
        s = result.session;
        return shown(result);
      }
      case "say": {
        const id = person(words[1]);
        if (!id) return noSuchPerson();
        const question = line.trim().split(/\s+/).slice(2).join(" ");
        const result = await ask(metered, c, s, { suspect: id, question, cacheKey: `case:${c.id}` });
        s = result.session;
        return shown(result);
      }
      case "records":
      case "look":
        return records();
      case "inspect": {
        const item = inspectionMenu(c, s)[Number(words[1]) - 1];
        if (!item) return [say("Which record? Type `records` for the list.", "哪一项？输入 records 查看。")];
        const result = inspect(c, s, item.id);
        s = result.session;
        return [...result.evidence.map((e) => `  ${asEvidence(e)}`), ...(result.repeated ? [] : [left()])];
      }
      case "notebook":
      case "笔记":
        return book();
      case "talk":
      case "交谈":
        return talk();
      case "accuse": {
        const id = person(words[1]);
        if (!id) return noSuchPerson();
        const held = notebook(c, s).evidence;
        const numbers = words.slice(2);
        // An accusation ends the game, and the evidence is the player's to choose. With none
        // named, nothing happens yet: the player is asked to cite.
        if (numbers.length === 0) {
          return [say("Cite the evidence that proves it, by number (see `notebook`), or `all`. For example: accuse ada 1 2 4", "请按编号引用能证明的证据（见 notebook），或写 all。例如：accuse 艾达 1 2 4")];
        }
        const all = numbers.length === 1 && ["all", "全部"].includes(numbers[0]!.toLowerCase());
        const cited = all ? held.map((e) => e.id) : numbers.map((n) => held[Number(n) - 1]?.id);
        if (cited.some((e) => e === undefined)) return [t(ERRORS["not-held"]!)];
        const result = accuse(c, s, { suspect: id, evidence: cited as string[] });
        s = result.session;
        const v = result.verdict;
        const lines = [say(`You accuse ${nameOf(id)}.`, `你指认${nameOf(id)}。`), t(OUTCOME[v.outcome])];
        if (v.accusedRuledOut) lines.push(say("  Your own evidence rules that person out.", "  你引用的证据本身就排除了这个人。"));
        if (v.missing.length > 0) lines.push(say(`  Not proven for ${nameOf(id)}: ${v.missing.join(", ")}.`, `  对${nameOf(id)}尚未证明：${v.missing.map((m) => ({ opportunity: "机会", means: "手段", motive: "动机" })[m]).join("、")}。`));
        if (v.open.length > 0) lines.push(say(`  Not ruled out: ${v.open.map(nameOf).join(", ")}.`, `  尚未排除：${v.open.map(nameOf).join("、")}。`));
        lines.push(say("Type `reveal` to see the truth.", "输入 reveal 查看真相。"));
        return lines;
      }
      case "reveal": {
        if (!s.verdict) return [say("The truth is revealed only after you accuse someone.", "要先指认，才能公开真相。")];
        const truth = reveal(c, s);
        const motive = c.motives.find((m) => m.id === truth.motive);
        const place = (id: string) => t(c.locations.find((l) => l.id === id)?.name ?? { en: id, zh: id });
        const lines = [say(`It was ${nameOf(truth.culprit)}.`, `凶手是${nameOf(truth.culprit)}。`), ...(motive ? [`  ${t(motive.text)}`] : [])];
        lines.push(say("Where everyone really was:", "每个人真正在哪里："));
        for (const row of truth.timeline) lines.push(`  ${nameOf(row.suspect)}: ${c.slots.map((slot) => `${slot} ${place(row.whereabouts[slot] ?? "?")}`).join(", ")}`);
        if (truth.lies.length > 0) lines.push(say("The lies:", "谎言："));
        for (const lie of truth.lies) {
          const state = lie.caught ? say("you caught it", "被你识破") : lie.heard ? say("you heard it but held no record against it", "你听到了，但手里没有反驳它的记录") : say("you never heard it", "你没有听到");
          lines.push(`  ${nameOf(lie.suspect)} (${lie.assertion}): ${state}`);
        }
        return lines;
      }
      case "quit":
      case "exit":
        quit = true;
        return [say("Goodbye.", "再见。")];
      default:
        return [say("I don't know that command. Type `help`.", "不认识这个命令。输入 help。")];
    }
  };

  return {
    opening,
    handle: async (line) => {
      try {
        const lines = await run(line);
        // A round that this command made due runs now, so the next command never finds one waiting.
        return [...lines, ...(await rounds())];
      } catch (error) {
        if (error instanceof SessionError) return [t(ERRORS[error.code] ?? { en: error.message, zh: error.message })];
        throw error;
      }
    },
    session: () => s,
    get quit() {
      return quit;
    },
  };
}
