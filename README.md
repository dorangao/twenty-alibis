# Twenty Alibis · 二十条口供

A bilingual (English / 中文) murder mystery where every suspect is a [Muse Ember](https://dev.meta.ai/docs/muse-ember) agent, and code, not the model, owns the truth.

一款中英双语的推理游戏：每个嫌疑人都是一个 Muse Ember 智能体，而真相由代码掌握，不由模型决定。

> **Status: early build.** The case format, the solver, the spend guard and the model client exist and are tested. The game itself is not playable yet.
>
> **状态：开发初期。** 案件格式、求解器和额度保护已完成并有测试，游戏本身尚不可玩。

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

### The pair that defines "solvable" · 定义"可解"的一对案件

*The Archive at Nine* has eight suspects. Two of them hold a key and have a motive, and both say they were in the foyer at 21:00.

- **Pass:** the door log can be inspected. It places Ada in the archive and Ben in the foyer. One action proves the case, and Ada's claim is contradicted by a record.
- **Fail twin:** the same hidden truth and the same log, but the one action that reaches the log is removed. Ada and Ben both still fit, so the solver refuses the case, even though its answer key is perfectly consistent.

《九点的档案室》有八名嫌疑人，其中两人既有钥匙又有动机，都说自己 21:00 在门厅。保留"查看门禁记录"这一行动时案件可解；只删掉这一行动、案底完全不变时，两人都无法排除，求解器必须拒绝。

## Run it · 运行

```bash
npm install
```

```bash
npm run check
```

`npm run check` runs the type check and all tests. Nothing in the test suite calls a model.

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
