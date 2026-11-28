/**
 * Write the handwritten lighthouse case to cases/released/lighthouse.json.
 * 把手写的灯塔案写入 cases/released/lighthouse.json。
 *
 *   npm run release:lighthouse
 *
 * The file is the plot in src/writer/fixtures/lighthouse.ts, put together by the case
 * writer's own code. Run this after changing the plot or that code; a test fails while the
 * file and the plot differ. It writes this one file and nothing else.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkCase } from "../src/case/solver";
import { lighthouseCase, lighthouseFileText, RELEASED_LIGHTHOUSE } from "../src/web/released";
import { say } from "./say";

const out = resolve(import.meta.dirname, "..", RELEASED_LIGHTHOUSE);
const checked = checkCase(lighthouseCase());
if (!checked.accepted) {
  say("The lighthouse case does not pass the gate. Nothing was written.", "灯塔案没有通过检查。没有写入任何内容。");
  process.exit(1);
}
writeFileSync(out, lighthouseFileText());
say(`Wrote ${out}.`, `已写入 ${out}。`);
