/**
 * A paid pilot: write a few cases, then let the detective play each one.
 * 付费试跑：先写几份案件，再让侦探逐个去破。
 *
 *   npm run pilot -- --plan            say exactly what a run would send now; sends nothing
 *   npm run pilot                      run it (needs `npm run spend -- allow-paid "..."` first)
 *   npm run pilot -- --game 2 [--plan] play the saved cases again as game 2: detective turns
 *                                      only, under their own request ids, into their own files
 *
 * What runs, what is saved and what may be picked up again is decided in src/writer/pilot.ts
 * and src/writer/trial.ts, which are tested without a model. This file connects them to the
 * real spend guard and prints.
 *
 * The cap is in the request ids. An attempt's are "<id>:skeleton", "<id>:people" and
 * "<id>:d1" to "<id>:d<maxTurns>", and the spend store sends an id once, ever. What has gone
 * out is read from the store's durable records. Every reply is saved as it arrives. A game
 * that has been started is never started again. The run stops at the first request that is
 * refused, fails, or comes back unconfirmed.
 *
 * A later game ("--game 2") plays cases that are already written and saved, and writes none.
 * Its requests are "<id>:g2:d1" to "<id>:g2:d<maxTurns>": a cap of its own, also once, ever.
 * Game 1's records and files are left as they are.
 *
 * It uses the "local" envelope only. Whether it may run at all is a person's decision, made
 * by authorizing paid requests; nothing in this file grants that.
 */
import { createRuntime } from "../src/runtime";
import type { PilotConfig } from "../src/writer/pilot";
import { pilotCli } from "../src/writer/pilot-cli";

const config: Omit<PilotConfig, "game"> = {
  attempts: [
    { id: "pilot-a-1", theme: "a vineyard house on the last night of harvest" },
    { id: "pilot-a-2", theme: "a mountain railway hotel during an avalanche warning" },
    { id: "pilot-a-3", theme: "a glassworks on the evening of a royal commission" },
  ],
  suspects: 20,
  rooms: 6,
  dir: "cases/generated",
  // A careful player needs about eight turns: hear the keeper, read the rooms, accuse. Sixteen leaves room to wander.
  maxTurns: 16,
};

// Everything else, the reading of the arguments included, is in src/writer/pilot-cli.ts, where it is tested.
process.exit(await pilotCli(process.argv.slice(2), { config, envelope: "local", runtime: () => createRuntime(process.env), print: (line) => console.log(line) }));
