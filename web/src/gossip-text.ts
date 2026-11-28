// What the page says about one gossip round. Kept apart from the components so it can be
// checked by itself: it must never credit an agent with a choice that was not made.
import type { View } from "../../src/web/view";
import type { Lang } from "./strings";

export type Round = NonNullable<View["gossip"]>["rounds"][number];

/** How long the page waits between looks at a round that someone else's request is running. */
export const GOSSIP_LOOK_MS = 2_000;
/** How many times it looks by itself: a little longer than a lost server's hold on the game lasts. After that there is a button. */
export const GOSSIP_LOOKS = 20;

/**
 * Who told whom in this round, in words: how many listeners code picked, how many the
 * speakers' agents picked, how many speakers were to ask their agent and told nobody, and
 * how many requests went out with their cost unconfirmed. Every number is read from the
 * round; a line is there only when its number is above zero.
 */
export function roundSummary(lang: Lang, round: Round): string[] {
  const zh = lang === "zh";
  const byModel = round.talks.filter((t) => t.by === "model").length;
  const byCode = round.talks.length - byModel;
  const silent = Math.max(0, round.asked - byModel);
  const lines: string[] = [];
  if (round.chosenBy === "code") {
    if (byCode > 0) lines.push(zh ? "由代码决定告诉谁。没有发送请求。" : "Code chose who was told. Nothing was sent.");
    return lines;
  }
  if (byModel > 0) lines.push(zh ? `${byModel} 位说话者的智能体自己决定了告诉谁。` : `${byModel} ${byModel === 1 ? "speaker's agent" : "speakers' agents"} chose whom to tell.`);
  if (byCode > 0) lines.push(zh ? `${byCode} 位只剩一个人可告诉，由代码告诉了那个人。` : `${byCode} had one person left to tell, and code told them.`);
  if (silent > 0) {
    lines.push(
      zh
        ? `${silent} 位本该由智能体来选，但没能选成（模型用不了，或回复不可用），所以谁也没告诉。代码不会替它们选。`
        : `${silent} ${silent === 1 ? "was" : "were"} to ask ${silent === 1 ? "its" : "their"} agent and told nobody: the model could not be used, or its answer could not be. Code does not pick for them.`,
    );
  }
  if (round.unconfirmed > 0) {
    lines.push(
      zh
        ? `有 ${round.unconfirmed} 次请求已经发出，但费用未确认。它们如果产生了费用，由服务器计入，不在页面的合计里。`
        : `${round.unconfirmed} ${round.unconfirmed === 1 ? "request" : "requests"} went out with ${round.unconfirmed === 1 ? "its" : "their"} cost unconfirmed. What ${round.unconfirmed === 1 ? "it" : "they"} cost, if anything, is counted on the server and is not in the page's total.`,
    );
  }
  return lines;
}

/** Requests of this game's gossip rounds that went out with their cost unconfirmed. */
export const unconfirmedSends = (view: View): number => (view.gossip?.rounds ?? []).reduce((sum, r) => sum + r.unconfirmed, 0);
