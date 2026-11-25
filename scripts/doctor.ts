/**
 * Checks that a paid run is set up correctly, without making one.
 * It reports whether each setting is present. It never prints a secret.
 * 检查付费运行的各项设置是否就绪。只报告是否存在，不发起任何模型请求，也不打印密钥。
 */
import { API_KEY_NAMES, readSpendConfig, resolveApiKey } from "../src/runtime";
import { nanoToUsd } from "../src/spend/pricing";
import { connectRedis } from "../src/spend/redis-client";
import { EnvelopeCorruptError, EnvelopeNotInitializedError, RedisSpendStore } from "../src/spend/redis-store";
import { both, say } from "./say";

const usd = (nano: number) => `$${nanoToUsd(nano).toFixed(6)}`;
let problems = 0;
const ok = (en: string, zh: string) => console.log(`  ok       ${both(en, zh)}`);
const note = (en: string, zh: string) => console.log(`  note     ${both(en, zh)}`);
const bad = (en: string, zh: string) => {
  problems++;
  console.log(`  MISSING  ${both(en, zh)}`);
};

say("Twenty Alibis: setup check (no model request is made)", "二十条口供：设置检查（不会发起模型请求）");
console.log();

const apiKey = resolveApiKey(process.env);
if (apiKey) ok(`API key: set as ${apiKey.name}`, `密钥：已设置（${apiKey.name}）`);
else bad(`API key: set one of ${API_KEY_NAMES.join(", ")} in .env.local`, `密钥：请在 .env.local 中设置 ${API_KEY_NAMES.join("、")} 之一`);

if (process.env.EMBER_DISABLED === "1") note("kill switch (EMBER_DISABLED) is ON: nothing will be sent", "总开关（EMBER_DISABLED）已打开：不会发送任何请求");
else ok("kill switch (EMBER_DISABLED) is off", "总开关（EMBER_DISABLED）未打开");

try {
  const config = readSpendConfig(process.env);
  ok(`spend settings: envelope "${config.envelope}", limit ${usd(config.limitNano)}`, `额度设置：额度名 "${config.envelope}"，上限 ${usd(config.limitNano)}`);
  try {
    const redis = await connectRedis(config.redisUrl);
    try {
      ok(`Redis: ${await redis.ping()}`, "Redis：连接正常");
      const store = new RedisSpendStore(redis.runner);
      try {
        const [totals, limit, bound] = [await store.totals(config.envelope), await store.limit(config.envelope), await store.inputBound(config.envelope)];
        ok(`envelope: initialized with a fixed limit of ${usd(limit)}`, `额度：已初始化，固定上限 ${usd(limit)}`);
        if (limit !== config.limitNano) {
          note(`SPEND_LIMIT_USD (${usd(config.limitNano)}) differs from the fixed limit; the lower one applies`, `SPEND_LIMIT_USD（${usd(config.limitNano)}）与固定上限不同，以较低者为准`);
        }
        if (totals.suspended) bad(`envelope is SUSPENDED: ${totals.suspended}`, "额度已停用，查明原因后运行 npm run spend -- resume");
        const audit = await store.audit(config.envelope);
        if (audit.consistent) ok("record: the totals equal what the attempt records add up to", "账目：合计与逐笔记录一致");
        else bad("record: the totals do not match the attempt records; run `npm run spend -- audit`", "账目：合计与逐笔记录不一致，请运行 npm run spend -- audit");

        if (totals.paidAllowed) ok(`paid requests: authorized (${totals.paidAllowed})`, "付费请求：已授权");
        else bad("paid requests: not authorized. Real model calls are refused until `npm run spend -- allow-paid \"who said so\"`", "付费请求：未授权。在运行 allow-paid 之前，真实模型调用一律拒绝");
        if (bound) {
          ok(`input bound: ${bound.tokensPerByte} tokens per byte, doubled before use (${bound.note})`, `输入上界：每字节 ${bound.tokensPerByte} 个 token，使用时加倍`);
        } else {
          note("input bound: none measured yet, so each request holds about $0.31 until it settles", "输入上界：尚未测量，每次请求在结算前预留约 $0.31");
        }

        console.log();
        say(
          `settled ${usd(totals.settledNano)}, in flight ${usd(totals.heldNano)}, kept for unknown outcomes ${usd(totals.retainedNano)}`,
          `已结算 ${usd(totals.settledNano)}，进行中 ${usd(totals.heldNano)}，结果不明而保留 ${usd(totals.retainedNano)}`,
        );
        say(
          `committed ${usd(totals.committedNano)} of ${usd(Math.min(limit, config.limitNano))}, requests ${totals.attempts}`,
          `已占用 ${usd(totals.committedNano)} / ${usd(Math.min(limit, config.limitNano))}，请求数 ${totals.attempts}`,
        );
      } catch (error) {
        if (error instanceof EnvelopeCorruptError) bad("envelope: its record in Redis is damaged; reconcile it by hand before anything is sent", "额度：Redis 中的记录已损坏，发送任何请求前须人工核对");
        else if (error instanceof EnvelopeNotInitializedError) bad("envelope: not initialized; run `npm run spend -- init`", "额度：尚未初始化，请运行 npm run spend -- init");
        else throw error;
      }
    } finally {
      await redis.close();
    }
  } catch (error) {
    bad(`Redis: cannot reach it (${(error as Error).message}); run \`npm run redis:up\``, "Redis：无法连接，请运行 npm run redis:up");
  }
} catch (error) {
  bad(`spend settings: ${(error as Error).message}`, "额度设置：缺失或无效（需要 REDIS_URL、SPEND_ENVELOPE、SPEND_LIMIT_USD）");
}

console.log();
if (problems === 0) say("Ready.", "一切就绪。");
else say(`${problems} thing(s) to fix before a paid run.`, `付费运行前还有 ${problems} 项需要处理。`);
process.exit(problems === 0 ? 0 : 1);
