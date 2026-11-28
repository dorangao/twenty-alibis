/**
 * A paid trial of gossip: three rounds on the lighthouse case, each speaker's agent picking whom to tell.
 * 付费试验「私下交谈」：在灯塔案上跑三轮，每位说话者的智能体自己选择告诉谁。
 *
 *   npm run trial:gossip -- --plan     say exactly what a run would send now; sends nothing
 *   npm run trial:gossip               run it (needs `npm run spend -- allow-paid "..."` first)
 *
 * What runs and what bounds it is in src/trial/gossip-trial.ts, which is tested without a
 * model. This file connects it to the real spend guard, and saves the report.
 *
 * The requests are "gossip-t1:g<round>:<speaker>": at most 24, each sent once, ever. A trial
 * runs once. The report (who was offered whom, who was picked, tokens, time and cost; no
 * prompt text) is written to traces/, which git ignores.
 *
 * It uses the "local" envelope only. Whether it may run at all is a person's decision, made
 * by authorizing paid requests; nothing in this file grants that.
 */
import { createRuntime } from "../src/runtime";
import { usdToNano } from "../src/spend/pricing";
import { gossipTrialCli, type GossipTrialConfig } from "../src/trial/gossip-trial";
import { lighthouseCase } from "../src/web/released";
import { writeWhole } from "../src/writer/trial";

const config: GossipTrialConfig = { id: "gossip-t1", rounds: 3, capNano: usdToNano(0.02) };

process.exit(
  await gossipTrialCli(process.argv.slice(2), {
    c: lighthouseCase(),
    config,
    envelope: "local",
    runtime: () => createRuntime(process.env),
    print: (line) => console.log(line),
    save: (report) => writeWhole(`traces/${config.id}.report.json`, `${JSON.stringify(report, null, 2)}\n`),
  }),
);
