# Twenty Alibis · 二十条口供

A bilingual (English / 中文) murder mystery where every suspect is a [Muse Ember](https://dev.meta.ai/docs/muse-ember) agent, and code, not the model, owns the truth.

一款中英双语的推理游戏：每个嫌疑人都是一个 Muse Ember 智能体，而真相由代码掌握，不由模型决定。

> **Status: playable on your own machine, with the model off.** You can play a case from the briefing to the reveal in a terminal or in a browser, watch a replay of a solved game, and bring a case of your own; suspects' statements are then worded by code, and nothing is sent or spent. The parts that use Muse Ember (suspects answering in their own words, the case writer, the self-play detective) exist, are tested with a stand-in provider, and have been run against the real model in small measured batches. The game is not hosted anywhere yet.
>
> **状态：可以在自己的机器上玩，模型关闭。** 可以在终端或浏览器里把一个案件从简报玩到真相公开，可以观看一局已破解游戏的回放，也可以带上你自己的案件；此时嫌疑人的陈述由代码写成，不发送任何请求，也不花钱。用到 Muse Ember 的部分（嫌疑人用自己的话回答、案件写作、自我对局的侦探）已经写好，用替身模型测试过，也用真实模型做过小批量的实测。游戏目前还没有部署到任何网站。

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

## What Muse Ember does here, and what we measured · Muse Ember 在这里做什么，实测如何

Every model call in this project is `muse-ember-1.0`. It does three jobs, and code checks each one.

| Job | What the model does | What code does with it |
|---|---|---|
| **Suspect** | Picks which topic a question is about by calling a `recall` tool, then says the statements that topic yields in its own voice | Serves only that suspect's own knowledge. The turn's statements come from the case file and the notebook is worded by code, so the model's sentence is never evidence. A guard compares the sentence with the case's known people, places, times and means and refuses one that strays; it works on words and cannot judge every change of meaning |
| **Case writer** | Writes a 20-person plot in two requests: the setting and people, then what happened | Builds all the evidence, then lets the validator, the solver and a quality gate decide whether the case is kept |
| **Detective** | Plays a case as a player would: one action a turn, chosen from what is open, in a strict schema | Runs the same game and the same scorer a player gets; a case counts as agent-solved only on a "solved" verdict |

What the runs so far showed. Each line is a measurement from a small batch, on Nov 25 and 26, 2026; none of them is a rate.

| What | Measured |
|---|---|
| One typed question: two requests, choose the topic, then answer | $0.00031 and about 1.7 seconds in the first batch; $0.00032 to $0.00045, average $0.00040, in the later batch with the in-character prompt |
| Writing one 20-suspect case that every gate accepted: two requests | $0.0031 to $0.0040; 11 to 14 seconds for the three that were timed |
| The detective's own requests for one game played to a solved verdict | $0.0022, $0.0039 and $0.0057, in 6, 7 and 9 turns. The suspects' model was off in these games, and the cases had been written earlier: neither is in these figures |
| The same three model-written cases, one detective game each under the final rules | 3 of 3 solved |
| Lines told to "say it your way, add no fact" | of seven lines read, seven were in character with no added time, place, object or person |
| Reasoning effort "minimal" against "low", on two pairs of gossip prompts | 195 reasoning tokens against 606: about a third |
| Second of two labelled requests sharing a long prefix | 7,796 of its 7,836 input tokens were cached (99.5%); it cost $0.000175 where the first cost $0.000824 |

Why this matters for the game: at these prices every suspect, the author and the detective can each be an agent. A typed question, a written case and the detective's side of a solved game each cost a fraction of a cent. What a whole live game costs a player who types every question has not been measured: by the question prices above it is the number of questions times about $0.0004. And the model follows tools and schemas closely enough that code can decide what counts as evidence without ever taking the model's sentence for it.

What these runs do not show, and what the design does about it:

- **A schema is not a guarantee.** One retry came back as text repeated to the output limit, not the object asked for. The turn loop treats any such reply as refused and falls back to a sentence worded by code.
- **Reasoning counts against the output limit.** With a limit that was too low, replies were cut off with no answer in them. Every request now sets its effort and a limit with room for the reasoning.
- **The writer has habits.** In six of six plots it made the first person it was shown the culprit. Code reorders the people and motives by a private random salt before and after that request, so a person's place in a finished case says nothing about the plot.
- **The line guard reads words, not meaning.** A line could still bend a fact in words the case's vocabulary does not hold. The promise rests on the notebook and the scorer, which never read the model's sentence.
- **The detective depends on how it is asked.** On the same three cases it solved none in the first setting, where two games ended on replies cut off at the output limit and one accused the right person too early; two after the limit was raised and the rules reworded, both at once; and all three once the rules of proof said plainly what a room's record does and does not show. Which change did what was not separated. It also asks more than it needs to: one to three questions a game that open nothing.
- **Generated Chinese reads like a translation** in places. The game's own words, the rules and the notebook are written by hand in both languages.
- These are a handful of runs. They say what happened, not how often it will.

本项目里每一次模型调用都是 `muse-ember-1.0`。它做三件事，每一件都由代码检查。

| 角色 | 模型做什么 | 代码怎么处理 |
|---|---|---|
| **嫌疑人** | 调用 `recall` 工具选出问题对应的话题，再用自己的口吻说出该话题给出的陈述 | 只提供这名嫌疑人自己知道的内容。这一轮的陈述来自案件文件，笔记本由代码写成，所以模型说的那句话永远不算证据。守卫把这句话和本案已知的人名、地点、时间和手段对照，越界的就拒绝；它只看字词，判断不了每一种含义上的变化 |
| **案件作者** | 用两次请求写出一个 20 人的剧情：先写场景和人物，再写发生了什么 | 生成全部证据，再由校验器、求解器和质量关决定是否保留 |
| **侦探** | 像玩家一样玩一个案件：每回合一个行动，只能从当前开放的选项里选，按严格的格式回答 | 走的是玩家的同一套游戏和同一个判分器；只有判为"已破解"才算智能体破案 |

目前的实测结果。每一行都来自 2026 年 11 月 25、26 日的小批量运行，都不是比率。

| 项目 | 实测 |
|---|---|
| 用自己的话问一个问题：两次请求，先选话题，再回答 | 第一批：$0.00031，约 1.7 秒；之后用带角色口吻的提示词那一批：$0.00032 到 $0.00045，平均 $0.00040 |
| 写出一个通过所有检查的 20 人案件：两次请求 | $0.0031 到 $0.0040；其中计了时的三个用了 11 到 14 秒 |
| 侦探把一局玩到"已破解"，只算侦探自己的请求 | $0.0022、$0.0039 和 $0.0057，分别用了 6、7、9 回合。这几局里嫌疑人的模型是关闭的，案件也是之前写好的：这两项都不在这些数字里 |
| 同样三个模型写的案件，按最终规则各由侦探玩一局 | 3 个全部破解 |
| 要求"用你的方式说，不要添加事实"的台词 | 读过的七句里，七句都符合角色，没有多出时间、地点、物品或人物 |
| 推理强度"minimal"对比"low"，两组成对的传话提示词 | 推理 token 195 对 606，约三分之一 |
| 两次共用长前缀且带缓存标签的请求中，第二次 | 它的 7,836 个输入 token 中有 7,796 个命中缓存（99.5%）；这次花费 $0.000175，第一次是 $0.000824 |

这对游戏意味着：按这样的价格，每个嫌疑人、作者和侦探都可以各是一个智能体。一个自己提的问题、写一个案件、侦探破一局所用的请求，各自都只要一美分的零头。玩家每个问题都自己打字的一整局要花多少，还没有实测过：按上面的单价，就是问题数乘以约 $0.0004。而且模型对工具和格式遵守得足够好，什么算证据可以完全由代码决定，从不以模型说的那句话为准。

这些运行没有说明的事，以及设计上的应对：

- **格式约束不是保证。** 有一次重试返回的是重复到输出上限的文字，而不是要求的对象。回合逻辑把这样的回复一律视为被拒绝，改用代码生成的句子。
- **推理占用输出上限。** 上限太低时，回复被截断，里面没有答案。现在每个请求都设定推理强度，并给推理留出余量。
- **作者有习惯。** 六个剧情里有六个把它看到的第一个人写成凶手。代码在那次请求前后各用一个不公开的随机盐把人物和动机重新排序，所以一个人在成品案件里的位置说明不了任何事。
- **台词守卫看的是字词，不是含义。** 一句台词仍然可能用案件词表里没有的说法把事实说歪。我们承诺的是笔记本和判分器，它们从不读模型说的那句话。
- **侦探的表现取决于怎么问它。** 同样三个案件：第一种设置下一个都没破，其中两局是回复在输出上限处被截断，一局是过早指认了正确的人；同时提高上限并改写规则之后破了两个；把证明规则里“房间记录说明什么、不说明什么”写清楚之后三个全破。哪一项改动起了什么作用，没有分开测。它问得也比需要的多：每局有一到三个问题没有打开任何新东西。
- **生成的中文有些地方读起来像翻译。** 游戏自己的文字、规则和笔记本是用两种语言手写的。
- 这只是少量运行，说明的是发生过什么，不是会有多经常发生。

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

### Gossip between questions · 提问之间的私下交谈

In a game with gossip, every four actions the people in the house talk among themselves, up to three times (every two in a case with fewer than eight topics and inspections, such as the handwritten one). The truth does not move and nobody's own statement changes. What changes is who can repeat whose statement.

- **Code decides who speaks, what they pass on, and who they could tell.** Up to eight suspects speak in a round, in the case's order. Each passes on one statement of its own, and only one whose topic is open to the player at that moment. Each is offered up to four people who have not heard it from them.
- **The speaker's agent picks one of them, and that is all it does.** With the model on, each speaker is one Muse Ember request at minimal effort, at most four in flight at once, and the reply must be one letter. It is shown the public case, its own voice, its own claim and the candidates' names: nothing of the hidden truth. A reply that is not one of the letters, or was cut off, tells nobody, and so does a request the spend guard refuses: in a game that began with the model on, code never steps in to pick for free. In a game that began with the model off, code tells the first candidate and nothing is sent.
- **The player is told who spoke with whom, not what was said.** The listener then has one more topic, "What did Ada tell you?". Asking it costs one action, sends nothing, and gives Ada's statement, attributed to her and worded by code.
- **Hearsay is a statement, so it proves nothing.** It can open what the statement opens, a record can contradict it, and a lie that reached the player this way counts as heard. An accusation still rests on records only.

Gossip only adds ways to reach statements the player could already reach, each for the one action it would have cost to ask the speaker. So any proof the solver found still works, and the shortest proof gets no shorter; what a player gains is a second person to ask. A test plays the solver's proof with rounds running, whoever is told. So far it is in the terminal game (`--gossip`) and has run only against a scripted stand-in for the model: how often a real reply is usable, and what a round costs, are not measured yet. The self-play detective plays without it.

开启"私下交谈"的一局里，每用掉四次行动，在场的人就会私下谈一轮，最多三轮（案件自带的话题和可查看项不到八个时，比如手写案件，改为每两次行动一轮）。真相不变，每个人自己的说法也不变；变的只是谁能转述谁的话。谁开口、转述哪一句、可以告诉哪几个人，都由代码决定：每轮最多八人依次开口，各转述自己的一句陈述，而且只能是此刻玩家本来就问得到的那一句；每人有至多四个还没听过这句话的人可选。模型开启时，由开口者的智能体从中选一个人，它只做这一件事：每人一次最低推理强度的 Muse Ember 请求，同时最多四个，回复必须是一个字母；它看到的是公开案情、自己的口吻、自己的说法和候选人的名字，看不到任何隐藏的真相。回复不是候选字母、被截断，或者请求被额度守卫拒绝，就谁也不告诉：开局时模型是开着的一局里，代码不会替它免费选人。开局时模型就关着的一局里，由代码告诉第一个候选人，不发送任何请求。玩家只会被告知谁找谁谈过，不会被告知谈了什么；听的人会多出一个话题"某某跟你说了什么？"，问它要用一次行动，不发送请求，得到的是那个人的陈述，注明出处，由代码写成。转述也只是陈述，不能证明任何事：它能打开那句陈述能打开的东西，记录可以与它矛盾，经由转述传到玩家耳中的谎言也算"听到了"，但指认仍然只凭记录。

私下交谈只会增加拿到陈述的途径，这些陈述玩家原本就拿得到，而且同样要用一次行动。所以求解器找到的证明依然有效，最短的证明也不会变得更短；玩家多出来的，是另一个可以问的人。有一项测试带着交谈轮次把求解器的证明走了一遍，不论话传给了谁。目前它只在终端游戏里（`--gossip`），而且只对着脚本化的模型替身跑过：真实回复有多少可用、一轮要花多少，都还没有测。自我对弈的侦探不带私下交谈。

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

The model is off in both: nothing is sent and nothing is spent. You get the briefing, question the suspects from their topic menus, inspect records, read the notebook with its contradictions, accuse, and see the truth. With the model off a suspect's statement is worded by code; a question in your own words needs the model (`npm run play -- --live`, which sends a request only if a person authorized paid requests before the game started). An accusation names the records it rests on: `accuse ada 1 2 4`, or `accuse ada all`. Add `--gossip` for a game with gossip rounds (see above): in the handwritten case the first comes after two actions, and `talk` shows who has spoken with whom.

以上两条命令都不调用模型，不发送任何内容，也不花钱。可以看简报、从话题菜单里审问嫌疑人、查看记录、翻笔记本和其中的矛盾、指认、最后看真相。模型关闭时嫌疑人的陈述由代码转述；用自己的话提问需要模型（`npm run play -- --live`，只有在游戏开始前已有人授权付费请求时才会真的发送）。指认时要写明依据哪些记录：`accuse 艾达 1 2 4`，或 `accuse 艾达 all`。加上 `--gossip` 就是带私下交谈的一局（见上文）：手写案件里用掉两次行动后就有第一轮，`talk` 可以看谁找谁谈过。

### Play it in a browser · 在浏览器里玩

```bash
npm run dev
```

Then open the address it prints (http://localhost:5173). The model is off here too: nothing is sent and nothing is spent. Pick a case, read the briefing and the rules of proof, question people from their topic menus, inspect records, watch the notebook mark what contradicts what, then accuse with the evidence you tick. The page has a language switch; a topic you have heard can be asked again in the other language at no cost.

The server keeps the case and your session. The page is sent only what you have been given or have found, under its own names (P3, T7, I2, E4), never the case file's. Your browser gets a cookie the page's scripts cannot read; that, not the address, is what lets you back into your game.

然后打开它打印出的地址（http://localhost:5173）。这里模型同样是关闭的：不发送任何内容，也不花钱。选一个案件，读案情简报和证明规则，从话题菜单里询问人物，查看记录，看笔记本标出哪些陈述与证据矛盾，然后勾选证据进行指认。页面可以切换语言；听过的话题可以用另一种语言再问一遍，不消耗行动。

案件和你的进度都保存在服务器上。页面只会收到你已经拿到或查到的内容，并且用的是页面自己的编号（P3、T7、I2、E4），不是案件文件里的编号。浏览器会拿到一个页面脚本读不到的 cookie；让你回到自己那一局的是它，而不是网址。

### Bring your own case · 带上你自己的案件

A case is one JSON file: the hidden truth, the people, what each will say, the records, and the actions a player has ([`src/case/schema.ts`](src/case/schema.ts)). To try one of your own:

```bash
npm run case -- example --id my-case
```

That writes the handwritten eight-suspect case to `cases/generated/my-case.json` under your name, to edit. It never writes over a file. Change the people, the rooms, who did it and the records, then put it through the gate:

```bash
npm run case -- check cases/generated/my-case.json
```

The gate is the same one every case passes: the file is well formed, its hidden truth holds together, and a player can prove it with the actions the case really offers. If it does not pass, the command says why: each reason in the gate's own English, then in Chinese with the ids to look for. Those reasons name the answer, so they are for you as the author; a player is only ever told that a file was refused. One name is taken: `index` is the list of replays, so a case cannot be called that.

A case that passes can be played three ways, all with the model off:

```bash
npm run play -- --case cases/generated/my-case.json
```

```bash
npm run dev
```

```bash
npm run replay:make -- --case cases/generated/my-case.json --solver --id my-case --out cases/generated/replays
```

The first plays it in the terminal (add `--zh` for Chinese). The second lists every case file in `cases/generated/` that passes the gate, beside the built-in case, in the browser. The third makes a replay of it along the proof its own solver found, which the dev server then lists under Replays. `cases/generated/` is ignored by git: a case file holds its own answer.

Passing the gate means a case is fair to play. It is not the case writer's quality check, which also asks whether the briefing leaves enough people to suspect. And there is no upload on a hosted game: a case reaches a server only as a file its operator put there.

案件就是一个 JSON 文件：隐藏的真相、人物、每个人会说什么、各项记录，以及玩家能做的行动（[`src/case/schema.ts`](src/case/schema.ts)）。想试试自己的案件，按上面的命令依次来：

第一条命令把手写的八人案件以你起的名字写到 `cases/generated/my-case.json`，供你修改；它从不覆盖已有文件。改掉人物、房间、凶手和记录之后，用第二条命令过一遍检查。这道检查和所有案件要过的是同一道：文件格式正确、隐藏的真相自洽、玩家用案件真正提供的行动能够证明。没通过时命令会逐条说明原因：先是检查给出的英文原文，再是中文说明和要找的 id。原因里会提到答案，所以是给作者看的，玩家只会被告知文件未通过。有一个名字不能用：`index` 是回放列表的名称，案件不能叫这个。

通过的案件有三种玩法，都不需要模型：第三条命令在终端里玩（加 `--zh` 用中文）；第四条在浏览器里把 `cases/generated/` 中所有通过检查的案件文件和内置案件一起列出来；第五条按案件自己的求解器找到的证明生成一个回放，之后开发服务器会把它列在"回放"里。git 忽略 `cases/generated/`：案件文件包含它自己的答案。

通过检查说明案件玩起来是公平的，但这不等于案件写作的质量检查（后者还会看简报是否留下足够多的可怀疑对象）。部署后的游戏没有上传功能：案件只能由运营者作为文件放到服务器上。

### Watch a replay · 观看回放

The page also lists replays: a solved game played back step by step. A replay is a plain file beside the page, so watching one asks nothing of the server, sends nothing and spends nothing, and it is there when the server is not. Each frame is the view a player would have been sent at that step, made by the same code that makes it for a live game; the answer is in the last frame only. A replay does give its case away.

The repository ships one: the handwritten 20-person lighthouse plot, played along the proof its own solver found (`web/public/replays/`). A test checks that this file is what the maker makes today.

```bash
npm run replay:make -- --builtin
npm run replay:make -- --case <case.json> --solver --id <name> --out <folder>
npm run replay:make -- --case <case.json> --detective <saved-replies.json> --id <name> --out <folder>
```

The third form replays a game the detective agent played: its saved replies are run through the detective's own code again, with no model, and the moves it made are played back. A replay is only made of a game the scorer calls solved. To look at one before publishing it, write it to `cases/generated/replays/`, which git ignores and no build contains; `npm run dev` lists what is there.

页面还会列出回放：一局已破解的游戏，一步一步重放。回放只是页面旁边的一个普通文件，所以观看时不向服务器要任何东西，不发送请求，也不花钱；服务器不在时它照样能看。每一帧都是玩家在那一步会收到的视图，由生成实时游戏视图的同一段代码生成；答案只在最后一帧。回放会揭示它那个案件的答案。

仓库自带一个回放：手写的 20 人灯塔案，按它自己的求解器找到的证明来走（`web/public/replays/`）。有一项测试检查这个文件与今天生成器的产出一致。

上面第三种用法回放侦探智能体玩过的一局：把它保存下来的回复重新交给侦探自己的代码（不用模型），再把它走过的每一步重放出来。只有判分为"已破解"的一局才会生成回放。想在发布前先看看，就写到 `cases/generated/replays/`：git 忽略这个目录，任何构建都不包含它；`npm run dev` 会列出其中的回放。

### Build it for a host · 为托管平台构建

```bash
npm run build:vercel
```

This writes `.vercel/output/` in the layout Vercel reads: the page as static files, the game API as one bundled function, and a routes file that sends `/api/*` to it. It uploads and deploys nothing. The function is the same `handleRequest` the dev server uses, with its sessions, its visitor allowance and its usage trace kept in Redis, because a host runs many short-lived workers that share nothing else.

The deployed server reads its settings from the environment: `PUBLIC_ORIGIN` (the site's https origin; a request that changes something must come from exactly there), `REDIS_URL`, `SPEND_ENVELOPE`, `SPEND_LIMIT_USD`, and optionally `VISITOR_GAMES_PER_DAY`, `VISITOR_REQUESTS_PER_DAY`, `GAMES_PER_HOUR` and the model's key. It fails closed. Without its settings it answers every request with one fixed error. Without a key, or while paid requests are not authorized on the envelope, the model is off: games are played from the topic menus, worded by code, and nothing is sent. If a worker is lost in the middle of a question, the game stands where it was, the page says so, and the question's requests are never sent twice.

The tests copy the built function out of the repository, run it with plain Node and play a game against it (`test/deployed.test.ts`).

这条命令按 Vercel 读取的目录结构写出 `.vercel/output/`：页面是静态文件，游戏接口是一个打包好的函数，另有一个路由文件把 `/api/*` 交给它。它不上传也不部署任何东西。函数用的就是开发服务器的那个 `handleRequest`，只是会话、访客额度和用量记录都保存在 Redis 里，因为托管平台上是许多彼此不共享内存的短命进程。

部署后的服务器从环境变量读取设置：`PUBLIC_ORIGIN`（站点的 https 源；会改动数据的请求必须正好来自这里）、`REDIS_URL`、`SPEND_ENVELOPE`、`SPEND_LIMIT_USD`，以及可选的 `VISITOR_GAMES_PER_DAY`、`VISITOR_REQUESTS_PER_DAY`、`GAMES_PER_HOUR` 和模型密钥。它默认拒绝：没有设置时，对每个请求都只回一个固定的错误。没有密钥，或者该额度上尚未授权付费请求时，模型是关闭的：游戏靠话题菜单进行，回答由代码写成，不发送任何请求。如果进程在一个提问中途丢失，这一局停在原处，页面会说明，这个提问的请求绝不会发送第二次。

测试会把构建出的函数复制到仓库之外，用普通的 Node 运行，并对它玩一局（`test/deployed.test.ts`）。

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
