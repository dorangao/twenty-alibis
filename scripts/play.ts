/**
 * Play the handwritten case in a terminal, from the briefing to the reveal.
 * 在终端里玩手写案件，从案情简报到真相公开。
 *
 *   npm run play               the model is off: nothing is sent and nothing is spent
 *   npm run play -- --zh       the same, in Chinese
 *   npm run play -- --live     use Muse Ember through the spend guard
 *
 * With the model off, a topic picked from the menu still gives the suspect's statement,
 * worded by code. A question in your own words needs the model.
 *
 * `--live` sends real requests only if a person has authorized paid requests on the
 * envelope (`npm run spend -- allow-paid "..."`) before the game starts. If they are closed
 * at launch, this run stays off for good, whatever is authorized later. If they are open at
 * launch, every request still asks the spend guard, so revoking them stops the run.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { archivePass } from "../src/case/fixtures/archive";
import { createGame, pinAtLaunch } from "../src/game/terminal";
import { createRuntime } from "../src/runtime";
import { say } from "./say";

const live = process.argv.includes("--live");
const language = process.argv.includes("--zh") ? "zh" : "en";

const runtime = live ? await createRuntime(process.env) : null;
/** Whether paid requests were open when this game started. */
let paidAllowed = false;
if (runtime) {
  const totals = await runtime.store.totals(runtime.config.envelope);
  paidAllowed = Boolean(totals.paidAllowed);
  if (totals.paidAllowed) say("LIVE: questions are sent to Muse Ember and cost real money.", "实时模式：提问会发送给 Muse Ember，并产生真实费用。");
  else say("Paid requests are not authorized, so nothing will be sent. The game plays as it does with the model off.", "未授权付费请求，因此不会发送任何内容。游戏按模型关闭的方式进行。");
} else {
  say("The model is off. Nothing is sent and nothing is spent.", "模型已关闭。不会发送任何内容，也不产生费用。");
}

// What was true at launch is what this terminal keeps to. If paid requests were closed when
// it started, it stays off even if someone authorizes them later: a game that said "nothing
// will be sent" must not start spending. A run that started live still asks the spend guard
// on every request, so revoking the authorization stops it.
const { metered, modelOff } = pinAtLaunch(runtime?.metered ?? null, paidAllowed);
// A random session id, so no two runs can ever share a request id.
const game = createGame(archivePass, metered, `play-${randomUUID()}`, { language, modelOff });
console.log();
for (const line of game.opening()) console.log(line);

const input = createInterface({ input: process.stdin, output: process.stdout });
// When commands are piped in, the input can end while a command is still being answered.
let ended = false;
input.on("close", () => (ended = true));
input.setPrompt("\n> ");
input.prompt();
for await (const line of input) {
  for (const out of await game.handle(line)) console.log(out);
  if (game.quit) break;
  if (!ended) input.prompt();
}
if (!ended) input.close();
await runtime?.close();
