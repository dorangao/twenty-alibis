# Twenty Alibis · 二十条口供

A bilingual (English / 中文) murder mystery where every suspect is a [Muse Ember](https://dev.meta.ai/docs/muse-ember) agent, and code, not the model, owns the truth.

一款中英双语的推理游戏：每个嫌疑人都是一个 Muse Ember 智能体，而真相由代码掌握，不由模型决定。

> **Status: playable on your own machine, with the model off.** You can play a case from the briefing to the reveal in a terminal or in a browser; suspects' statements are then worded by code, and nothing is sent or spent. The parts that use Muse Ember (suspects answering in their own words, the case writer, the self-play detective) exist and are tested with a stand-in provider. The game is not hosted anywhere yet.
>
> **状态：可以在自己的机器上玩，模型关闭。** 可以在终端或浏览器里把一个案件从简报玩到真相公开；此时嫌疑人的陈述由代码写成，不发送任何请求，也不花钱。用到 Muse Ember 的部分（嫌疑人用自己的话回答、案件写作、自我对局的侦探）已经写好，并用替身模型测试过。游戏目前还没有部署到任何网站。

## The idea · 核心思路

**Code owns the truth; Ember only performs it.**

- The hidden truth of a case lives in a JSON file that code validates. A suspect's prompt never contains it.
- A case is released only if a solver can prove, using nothing but actions a player really has, that exactly one suspect fits and everyone else is ruled out.
- Testimony can point you somewhere. Only authenticated records can rule anyone out.
- Every model request passes through one spend guard that reserves its worst-case cost before it is sent.

**真相归代码，Ember 只负责演。**

- 案件的隐藏真相存放在由代码校验的 JSON 文件里，嫌疑人的提示词中永远不包含它。
- 只有当求解器仅凭玩家真正能做的行动，就能证明恰好一人符合、其余人都被排除时，案件才会发布。
- 口供只能指路，只有经过认证的记录才能排除嫌疑。
- 每一次模型请求都要经过同一道额度保护，发送前先按最坏情况预留费用。

## What is here now · 目前已有

| Part | Where | What it does |
|---|---|---|
| Case contract | [`src/case/schema.ts`](src/case/schema.ts) | The shape of a case: hidden truth, testimony, evidence, and the actions a player can take |
| Validator | [`src/case/validate.ts`](src/case/validate.ts) | The truth is physically possible and points at one person; records are true; every false statement is a declared lie |
| Solver | [`src/case/solver.ts`](src/case/solver.ts) | The player proof. It never reads the hidden truth, and "unknown" never rules anyone out |
| A handwritten pair | [`src/case/fixtures/archive.ts`](src/case/fixtures/archive.ts) | One case that passes, and its twin with the same answer key that must be refused |
| Spend guard | [`src/metered.ts`](src/metered.ts), [`src/spend/`](src/spend) | Reserve, send once, settle. A request with an unknown outcome stays fully charged |
| Fake provider | [`src/provider/fake.ts`](src/provider/fake.ts) | Scripted model responses. Tests and CI use only this: no key, no network, no cost |
| Redis spend store | [`src/spend/redis-store.ts`](src/spend/redis-store.ts) | The same guard, durable: one record per budget, each check-and-reserve is one atomic script, the limit is fixed once set, and a damaged record refuses everything |
| Ember provider | [`src/provider/ember.ts`](src/provider/ember.ts) | The only real model client: one stateless request, no retry, no redirect, no streaming. Reached only through the spend guard |
| Suspect prompt | [`src/agents/suspect-prompt.ts`](src/agents/suspect-prompt.ts) | What a suspect is shown: the public briefing and its own voice. It learns what it may say only by calling `recall`, and a topic the player has not unlocked is not served |
| Suspect turn | [`src/agents/suspect-turn.ts`](src/agents/suspect-turn.ts) | One question, start to finish: at most three requests, and a line to show even when every request is refused |
| Line guard | [`src/agents/line-guard.ts`](src/agents/line-guard.ts) | Checks the model's wording against the statements of the turn, in English and Chinese |
| Rules of proof | [`src/case/proof.ts`](src/case/proof.ts) | What proves a suspect and what rules one out. The solver and the accusation scorer use this one object |
| Session | [`src/game/session.ts`](src/game/session.ts) | One player's game as plain data: questions, inspections, the notebook with its contradictions, the accusation and the reveal |
| Terminal game | [`src/game/terminal.ts`](src/game/terminal.ts), [`scripts/play.ts`](scripts/play.ts) | The whole game as lines of text, in English and Chinese. Playable with the model off |
| Detective | [`src/agents/detective.ts`](src/agents/detective.ts) | An agent that plays a case as a player does: it sees the notebook and what is open, picks one action a turn from that list only, and is scored by the same code. A case counts as agent-solved only when it earns a "solved" verdict |
| Pilot | [`src/writer/pilot.ts`](src/writer/pilot.ts) | Writes a case, then lets the detective play it, and keeps four counts apart: attempted, accepted by the gates, played, solved |
| Case writer | [`src/writer/`](src/writer) | Muse Ember writes a plot in two requests; code compiles it into a full case; the validator, the solver and a quality gate decide whether it is kept |

### The pair that defines "solvable" · 定义"可解"的一对案件

*The Archive at Nine* has eight suspects. Two of them hold a key and have a motive, and both say they were in the foyer at 21:00.

- **Pass:** the door log can be inspected. It places Ada in the archive and Ben in the foyer. One action proves the case, and Ada's claim is contradicted by a record.
- **Fail twin:** the same hidden truth and the same log, but the one action that reaches the log is removed. Ada and Ben both still fit, so the solver refuses the case, even though its answer key is perfectly consistent.

《九点的档案室》有八名嫌疑人，其中两人既有钥匙又有动机，都说自己 21:00 在门厅。保留"查看门禁记录"这一行动时案件可解；只删掉这一行动、案底完全不变时，两人都无法排除，求解器必须拒绝。

### What a suspect says, and what counts · 嫌疑人说的话，和算数的话

Muse Ember writes each suspect's line. Code decides what the line is allowed to be, and what goes in the notebook.

- **The statements come from the case file.** When a question lands on a topic, the turn's statements are the ones that topic yields. The model's reply cannot add one, drop one or change one.
- **The notebook is worded by code.** Each statement is rendered from its typed form, the same way every time, in both languages. Only the notebook counts as evidence.
- **The model's line is shown only if it passes the guard.** The guard knows the case's closed vocabulary: people, places, clock times however they are written ("21:00", "nine", "九点"), and the means. It refuses a line that names any of it beyond the turn's statements, leaves a statement's place, time, object or motive out, puts someone beside or outside a place instead of in it, puts a "not" beside a stated fact, names the wrong half of the day ("09:00" for 21:00), claims to have been alone, answers in the wrong language, or steps out of character.
- **One retry, then code speaks.** A refused line gets one retry. After that the player sees the code-rendered sentence.
- **With nothing to state, the model is not asked for a line.** When no topic fits a question, or the topic is still locked, the suspect gives one of a few fixed lines. A line with no statement behind it would have nothing to be checked against. Text the model sends with a tool call, or instead of one, is never shown.

The guard works on words, so it cannot judge meaning: a line could still bend a fact in words the vocabulary does not know. That is why the promise rests on the notebook and the solver, not on the line. Every turn records where its line came from and why any line was refused.

每个嫌疑人的台词由 Muse Ember 来写，但台词能不能用、笔记本里记什么，都由代码决定。一次提问落在哪个话题上，这一轮的陈述就是案件文件里该话题给出的陈述，模型不能增、删或改。笔记本里的句子由代码按固定方式生成，只有笔记本算证据。模型的台词要通过守卫才会显示：守卫认识本案的人名、地点、各种写法的时间和作案手段，凡是多提了、漏提了、把陈述说反了、声称"只有我一个人"、语言不对或者出戏的台词都会被拒绝。被拒绝后重试一次，再不行就显示代码生成的句子。问题对不上任何话题、或者话题还没解锁时，不让模型写台词，嫌疑人只说几句固定的话之一：没有陈述可对照的台词无从检查。守卫只看字词，判断不了含义，所以我们承诺的是笔记本和求解器，不是台词本身。每一轮都会记录台词的来源和被拒绝的原因。

### How an accusation is scored · 指认如何判分

A player names a suspect and cites evidence from the notebook. Code judges the cited evidence with the same rules the solver used to accept the case: it must prove opportunity, means and a motive for the accused, and rule out everyone else. Any set of held evidence that does so is accepted. What a suspect said proves nothing. The right name without the proof is reported as "right but unproven", with what is missing. The hidden truth is given out only after the accusation.

A session costs at most `sessionCap` actions. Hearing a topic again, asking a suspect the very same question again while it has the same topics open, or looking at a record again is free and sends nothing to the model: the saved result is returned. A question in other words is a new question. A topic heard in one language and asked for in the other is shown as code words it, since the model's own line exists in one language only.

玩家点名一名嫌疑人，并从笔记本里引用证据。代码用求解器接受案件时的同一套规则来判定：引用的证据必须证明被指认者有机会、有手段、有动机，并排除其他所有人。任何满足这些条件的证据组合都被接受；嫌疑人说的话不能证明任何事。只说对名字而没有证明，会判为"说对了但未证明"，并指出缺什么。真相只在指认之后公开。重听一个话题、在话题没变的情况下向同一人问一模一样的问题、或再看一份记录，都不耗行动，也不会再调用模型；换一种说法就算新问题。用一种语言听过的话题换另一种语言重听时，显示的是代码生成的句子，因为模型的台词只有一种语言。

### How a new case is written · 新案件怎么写出来

**Muse Ember writes the plot. Code builds the evidence. The solver judges the result.**

1. **The plot, two requests.** First the skeleton: the setting, the rooms and their doors, the victim, what was needed to do it, the possible motives, and the people with their voices. Then what happened: who did it, where each person was in every time slot, who holds the means and who has which motive. The voices are written before the answer exists, and the second request can only choose among ids that code gave to the first.
   A skeleton that is already known to be bad (a room no door leads to, too few people, a name the line guard would confuse, a role that names another person) ends the attempt before the second request is spent.
   Code reorders the people and the list of motives twice, by a private random salt: before the second request and after it. The salt is kept with the saved replies and is never part of the case; a seed made from the case's public id would let anyone who knows the model's habit work the order backwards. A model asked who did it tends to pick the first person on its list, and three real plots in a row did. It also names people in a recognizable order (two rosters ran through the alphabet), so the culprit was first by name as well. Reordering before the second request means the person the model sees first is not the one it named first; reordering after it means a person's place in the finished case says nothing about the plot.
2. **The compiler.** From the plot, code writes everything that is bookkeeping: each suspect's statement about the time of death, with the culprit claiming the room next door; a register of who holds the means and who does not; the victim's papers, saying who had which motive and, for anyone who holds the means, that they had none; one record for every room, occupied or empty, of who was there. The record of the scene opens only after its keeper, named in the briefing, has been heard. Ids say what kind of thing something is and never whether it is true, so the id of a statement tells the model nothing about who is lying.
3. **The gates.** The validator and the solver decide whether the case is fair. A quality gate then asks what they do not: does the briefing leave at least three people to suspect, does the proof need an interview, and can the line guard tell every name apart.

A plot that fails is refused with its reasons. Nothing here calls a model in the test suite; a handwritten twenty-person plot stands in for one.

**剧情由 Muse Ember 写，证据由代码生成，求解器把关。** 模型分两次请求写剧情：先写场景、房间和门、死者、作案所需之物、可能的动机，以及每个人和他们的说话方式；再写发生了什么：谁是凶手、每人每个时段在哪、谁有手段、谁有哪种动机。说话方式写在答案出现之前，第二次请求只能从代码给第一次结果编的编号里选。代码据此生成全部"记账"的部分：每人关于案发时间的陈述（凶手声称在隔壁房间）、手段登记、动机文件（包括"有手段但没有任何动机"的明确记录）、每个房间的在场记录。现场的记录要先听过简报里点名的保管人才能查看。之后由校验器和求解器判断案件是否公平，再由质量关检查三件事：简报是否至少留下三个可怀疑的人、证明是否需要问话、台词守卫能否分清每个名字。

## Run it · 运行

```bash
npm install
```

```bash
npm run check
```

`npm run check` runs the type check and all tests. Nothing in the test suite calls a model.

### Play the handwritten case in a terminal · 在终端里玩手写案件

```bash
npm run play
```

```bash
npm run play -- --zh
```

The model is off in both: nothing is sent and nothing is spent. You get the briefing, question the suspects from their topic menus, inspect records, read the notebook with its contradictions, accuse, and see the truth. With the model off a suspect's statement is worded by code; a question in your own words needs the model (`npm run play -- --live`, which sends a request only if a person authorized paid requests before the game started). An accusation names the records it rests on: `accuse ada 1 2 4`, or `accuse ada all`.

以上两条命令都不调用模型，不发送任何内容，也不花钱。可以看简报、从话题菜单里审问嫌疑人、查看记录、翻笔记本和其中的矛盾、指认、最后看真相。模型关闭时嫌疑人的陈述由代码转述；用自己的话提问需要模型（`npm run play -- --live`，只有在游戏开始前已有人授权付费请求时才会真的发送）。指认时要写明依据哪些记录：`accuse 艾达 1 2 4`，或 `accuse 艾达 all`。

### Play it in a browser · 在浏览器里玩

```bash
npm run dev
```

Then open the address it prints (http://localhost:5173). The model is off here too: nothing is sent and nothing is spent. Pick a case, read the briefing and the rules of proof, question people from their topic menus, inspect records, watch the notebook mark what contradicts what, then accuse with the evidence you tick. The page has a language switch; a topic you have heard can be asked again in the other language at no cost.

The server keeps the case and your session. The page is sent only what you have been given or have found, under its own names (P3, T7, I2, E4), never the case file's. Your browser gets a cookie the page's scripts cannot read; that, not the address, is what lets you back into your game.

然后打开它打印出的地址（http://localhost:5173）。这里模型同样是关闭的：不发送任何内容，也不花钱。选一个案件，读案情简报和证明规则，从话题菜单里询问人物，查看记录，看笔记本标出哪些陈述与证据矛盾，然后勾选证据进行指认。页面可以切换语言；听过的话题可以用另一种语言再问一遍，不消耗行动。

案件和你的进度都保存在服务器上。页面只会收到你已经拿到或查到的内容，并且用的是页面自己的编号（P3、T7、I2、E4），不是案件文件里的编号。浏览器会拿到一个页面脚本读不到的 cookie；让你回到自己那一局的是它，而不是网址。

### The durable spend counter · 持久化的额度计数

The spend guard counts in Redis, so the count survives restarts and is shared by every process. For local work, Docker provides it:

```bash
npm run redis:up
```

```bash
npm run test:redis
```

`npm run test:redis` runs the same suite plus the Redis store tests, in a separate database with its own key prefix.

To prepare a real run, copy `env.example` to `.env.local`, fill it in, then:

```bash
npm run spend -- init
```

```bash
npm run doctor
```

`doctor` reports whether each setting is present and what the counter says. It makes no model request and never prints a secret. If the counter is ever lost (for example `docker compose down -v`) or damaged, the guard refuses every request until a person has dealt with it: a missing number is never treated as zero.

### What the guard does with a request · 一次请求的经过

1. It copies the request and encodes it to the exact text that will be sent. Only that text is used from then on.
2. It reserves the worst case in Redis. If the budget cannot cover that, or the budget is suspended, nothing is sent.
3. It checks the kill switch a second time, then sends the text once. No retry, no redirect.
4. It settles with the real cost from the reply.

**Real model calls are closed by default.** Having a key is not enough: a request that spends money is refused unless a person has authorized paid requests on that budget, and that authorization lives in Redis next to the counter.

```bash
npm run spend -- allow-paid "who said so, and for what"
```

**How much is reserved.** The guard assumes nothing about how many tokens a request becomes. For every request that spends money it reserves the most any request can cost: a full context window at the higher price plus the whole output limit, about $0.31. The difference comes back when the reply is settled. No measured ratio can shrink that reservation: a figure seen on some requests is not a maximum for the next one.

If a reply never arrives, arrives without usable usage figures, or is an HTTP error of any kind, the **full reservation stays charged**. The request reached the API, and nothing on this side proves it was free. Such holds are closed by hand against the dashboard:

```bash
npm run spend -- attempts retained
```

If a reply ever costs more than its reservation, or reports more input than the guard assumed possible, the budget is **suspended on the spot** and stays that way until a person resumes it. `npm run spend -- suspend "why"` does the same from any terminal.

一次请求会先被固定为将要发送的确切文本，再按最坏情况在 Redis 里预留额度，发送前第二次检查总开关，只发送一次，最后按实际费用结算。回复缺失、缺少用量数据或返回任何 HTTP 错误时，预留额全额保留，待人工对照后台核销。实际费用一旦超过预留额，该额度立即停用，直到人工恢复。

额度保护把计数存在 Redis 里，重启后不丢失，所有进程共用。本地用 Docker 启动。`doctor` 只报告各项设置是否存在以及当前计数，不发起任何模型请求，也不打印密钥。计数一旦丢失，在重新初始化之前所有请求都会被拒绝。

## Built during the Muse Ember Hackathon · 关于本项目

All code in this repository was written during the hackathon build window, Nov 23 – Dec 2, 2026. The game's AI runs only on `muse-ember-1.0` through the Meta Model API. Coding assistants (Claude Code and Codex) helped write the code.

本仓库全部代码写于黑客松开发期（2026 年 11 月 23 日至 12 月 2 日）。游戏中的 AI 只使用 Meta Model API 的 `muse-ember-1.0`。编码过程使用了编程助手（Claude Code 和 Codex）。

## License

[MIT](LICENSE) © 2026 Doran Gao
