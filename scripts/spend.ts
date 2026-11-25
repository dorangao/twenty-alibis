/**
 * Manage a spend envelope in Redis. None of these commands calls the model.
 * 管理 Redis 中的额度。以下命令都不会调用模型。
 *
 *   npm run spend -- init [--carried-usd 0.12]   create the envelope with the limit from SPEND_LIMIT_USD
 *   npm run spend -- status                      what is settled, in flight and kept; suspended or not
 *   npm run spend -- attempts [retained]         list attempts, or only those with an unknown outcome
 *   npm run spend -- settle <attemptId> --usd N  record the real cost of an attempt, from the dashboard
 *   npm run spend -- allow-paid "who said so"    let this envelope make requests that spend real money
 *   npm run spend -- revoke-paid                 stop that
 *   npm run spend -- calibrate --tokens-per-byte N --note "measured from ..."
 *                                                record a measured input bound (omit N to clear it)
 *   npm run spend -- suspend "why"               stop admitting requests, from any process
 *   npm run spend -- resume                      admit requests again
 *   npm run spend -- audit                       do the totals equal what the attempts add up to?
 *
 * `init` does nothing if the envelope already exists: a limit, once set, cannot be raised here.
 * `settle` is how a hold kept for an unknown outcome is closed once the dashboard shows its cost.
 */
import { readSpendConfig } from "../src/runtime";
import { nanoToUsd, usdToNano } from "../src/spend/pricing";
import { connectRedis } from "../src/spend/redis-client";
import { RedisSpendStore } from "../src/spend/redis-store";
import { say } from "./say";

const usd = (nano: number) => `$${nanoToUsd(nano).toFixed(6)}`;
const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const fail = (en: string, zh: string): never => {
  say(en, zh);
  process.exit(1);
};
const amount = (name: string, fallback?: string) => {
  const value = Number(flag(name) ?? fallback);
  if (!Number.isFinite(value) || value < 0) fail(`--${name} must be zero or more dollars`, `--${name} 必须是不小于零的美元金额`);
  return usdToNano(value);
};

const config = readSpendConfig(process.env);
const redis = await connectRedis(config.redisUrl);
const store = new RedisSpendStore(redis.runner);
const envelope = config.envelope;
try {
  if (command === "init") {
    const result = await store.init({ envelope, limitNano: config.limitNano, carriedNano: amount("carried-usd", "0") });
    if (result.created) {
      say(
        `Created envelope "${envelope}" with a fixed limit of ${usd(result.limitNano)}, starting at ${usd(result.totals.settledNano)}.`,
        `已创建额度 "${envelope}"，固定上限 ${usd(result.limitNano)}，起始已用 ${usd(result.totals.settledNano)}。`,
      );
    } else {
      say(
        `Envelope "${envelope}" already exists with a fixed limit of ${usd(result.limitNano)}. Nothing changed.`,
        `额度 "${envelope}" 已存在，固定上限 ${usd(result.limitNano)}。未作任何更改。`,
      );
    }
  } else if (command === "status") {
    const [totals, limit, bound] = [await store.totals(envelope), await store.limit(envelope), await store.inputBound(envelope)];
    say(`Envelope "${envelope}": committed ${usd(totals.committedNano)} of ${usd(limit)}`, `额度 "${envelope}"：已占用 ${usd(totals.committedNano)} / ${usd(limit)}`);
    say(
      `  settled ${usd(totals.settledNano)}, in flight ${usd(totals.heldNano)}, kept for unknown outcomes ${usd(totals.retainedNano)}, requests ${totals.attempts}`,
      `已结算 ${usd(totals.settledNano)}，进行中 ${usd(totals.heldNano)}，结果不明而保留 ${usd(totals.retainedNano)}，请求数 ${totals.attempts}`,
    );
    if (totals.suspended) say(`  SUSPENDED: ${totals.suspended}`, "已停用");
    else say("  open", "正常");
    if (totals.paidAllowed) say(`  paid requests: authorized (${totals.paidAllowed})`, "付费请求：已授权");
    else say("  paid requests: not authorized", "付费请求：未授权");
    if (bound) say(`  input bound: ${bound.tokensPerByte} tokens per byte (${bound.note})`, `输入上界：每字节 ${bound.tokensPerByte} 个 token`);
    else say("  input bound: none measured", "输入上界：尚未测量");
  } else if (command === "attempts") {
    const only = rest[0];
    const list = (await store.attempts(envelope)).filter((a) => !only || a.state === only);
    for (const a of list) console.log(`${a.state.padEnd(9)} hold ${usd(a.holdNano)}  charged ${usd(a.chargedNano)}  ${a.attemptId}`);
    say(`${list.length} attempt(s)${only ? ` in state ${only}` : ""}.`, `共 ${list.length} 笔${only ? `（状态 ${only}）` : ""}。`);
  } else if (command === "settle") {
    const attemptId = rest[0];
    if (!attemptId || attemptId.startsWith("--")) fail("usage: settle <attemptId> --usd N", "用法：settle <attemptId> --usd N");
    if (flag("usd") === undefined) fail("settle needs --usd N: the cost the dashboard shows for this request", "settle 需要 --usd N：后台显示的该请求实际费用");
    const actualNano = amount("usd");
    const result = await store.settle({ envelope, attemptId: attemptId!, actualNano });
    if (result.applied) {
      say(`Settled ${attemptId} at ${usd(actualNano)}. Committed is now ${usd(result.totals.committedNano)}.`, `已按 ${usd(actualNano)} 结算 ${attemptId}。当前已占用 ${usd(result.totals.committedNano)}。`);
    } else {
      say(`${attemptId} was already settled. Nothing changed.`, `${attemptId} 此前已结算。未作任何更改。`);
    }
    if (result.overHold) say("That cost is above the attempt's hold, so the envelope is now suspended.", "该费用超过了这笔请求的预留额，额度已停用。");
  } else if (command === "allow-paid") {
    const who = rest[0];
    if (!who || who.startsWith("--")) fail('usage: allow-paid "who authorized it and for what"', "用法：allow-paid \"由谁授权、授权范围\"");
    await store.allowPaid({ envelope, note: who! });
    say(`Envelope "${envelope}" may now make requests that spend real money. Authorized: ${who}`, `额度 "${envelope}" 现在可以发起付费请求。授权说明：${who}`);
  } else if (command === "revoke-paid") {
    await store.revokePaid(envelope);
    say(`Envelope "${envelope}" may no longer make requests that spend real money.`, `额度 "${envelope}" 已不能发起付费请求。`);
  } else if (command === "calibrate") {
    const ratio = flag("tokens-per-byte");
    if (ratio === undefined) {
      await store.clearInputBound(envelope);
      say("Cleared the measured input bound. Each request now holds the most a request can cost.", "已清除输入上界。此后每次请求按单次请求的最高可能费用预留。");
    } else {
      const measuredFrom = flag("note");
      if (!measuredFrom) fail('calibrate needs --note "what it was measured from"', "calibrate 需要 --note \"测量依据\"");
      await store.setInputBound({ envelope, tokensPerByte: Number(ratio), note: measuredFrom! });
      say(`Recorded an input bound of ${Number(ratio)} tokens per byte. The guard doubles it before use.`, `已记录输入上界：每字节 ${Number(ratio)} 个 token。使用时会加倍。`);
    }
  } else if (command === "suspend") {
    const totals = await store.suspend({ envelope, reason: rest[0] ?? "suspended by an operator" });
    say(`Envelope "${envelope}" is suspended: ${totals.suspended}`, `额度 "${envelope}" 已停用。`);
  } else if (command === "resume") {
    await store.resume(envelope);
    say(`Envelope "${envelope}" admits requests again.`, `额度 "${envelope}" 已恢复。`);
  } else if (command === "audit") {
    const audit = await store.audit(envelope);
    if (audit.consistent) {
      say("Consistent: the totals equal what the attempt records add up to.", "一致：合计与逐笔记录相符。");
    } else {
      say("MISMATCH between the totals and the attempt records:", "不一致：合计与逐笔记录不符：");
      console.log(`  totals:        settled ${audit.totals.settledNano}, in flight ${audit.totals.heldNano}, kept ${audit.totals.retainedNano}, requests ${audit.totals.attempts}`);
      console.log(`  from attempts: settled ${audit.fromAttempts.settledNano}, in flight ${audit.fromAttempts.heldNano}, kept ${audit.fromAttempts.retainedNano}, requests ${audit.fromAttempts.attempts}`);
      process.exitCode = 1;
    }
  } else {
    say(
      'usage: npm run spend -- init [--carried-usd N] | status | attempts [retained] | settle <id> --usd N | allow-paid "who" | revoke-paid | calibrate [--tokens-per-byte N --note "..."] | suspend "why" | resume | audit',
      "用法见上：初始化、查看状态、列出请求、人工结算、授权或撤销付费请求、记录输入上界、停用、恢复、核对账目",
    );
    process.exitCode = 1;
  }
} finally {
  await redis.close();
}
