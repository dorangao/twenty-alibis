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
 * envelope (`npm run spend -- allow-paid "..."`). Without that the spend guard refuses
 * every request and the game plays exactly as it does with the model off.
 */
import { createInterface } from "node:readline/promises";
import { archivePass } from "../src/case/fixtures/archive";
import { createGame } from "../src/game/terminal";
import type { Metered } from "../src/metered";
import { createRuntime } from "../src/runtime";
import { say } from "./say";

const live = process.argv.includes("--live");
const language = process.argv.includes("--zh") ? "zh" : "en";

/** The model is off: every request is refused before anything is built or sent. */
const off: Metered = async (request) => ({ ok: false, attemptId: request.attemptId, sent: false, reason: "kill-switch" });

const runtime = live ? await createRuntime(process.env) : null;
/** True when no request can be sent: the model is off, or paid requests are not authorized. */
let modelOff = true;
if (runtime) {
  const totals = await runtime.store.totals(runtime.config.envelope);
  modelOff = !totals.paidAllowed;
  if (totals.paidAllowed) say("LIVE: questions are sent to Muse Ember and cost real money.", "实时模式：提问会发送给 Muse Ember，并产生真实费用。");
  else say("Paid requests are not authorized, so nothing will be sent. The game plays as it does with the model off.", "未授权付费请求，因此不会发送任何内容。游戏按模型关闭的方式进行。");
} else {
  say("The model is off. Nothing is sent and nothing is spent.", "模型已关闭。不会发送任何内容，也不产生费用。");
}

// A session id that is new on every run, so a live run never reuses a request id.
const game = createGame(archivePass, runtime?.metered ?? off, `play-${Date.now().toString(36)}`, { language, modelOff });
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
