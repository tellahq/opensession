/**
 * When a docs-sync PR is merged, tick the Slack announcement it posted in the
 * docs channel. docs-sync's runner posts that announcement via the LLM
 * (free-form, so we never captured its `ts`), so we can't look the message up
 * by a stored id. Instead we find it at merge time by the PR URL it links,
 * then add a ✅ reaction. Best-effort: if the message isn't found we just log
 * and move on.
 */
import { fetchChannelHistory, addReaction } from "../slack/slack-api";
import { docsSyncChannel } from "./constants";

const MERGED_REACTION = "white_check_mark";

/** True when `text` links the given PR (matches the `/pull/<n>` URL, not a
 *  longer number that merely starts with it, e.g. #4433 vs #44330). */
function linksPr(text: string, prNumber: number): boolean {
  return new RegExp(`/pull/${prNumber}(?!\\d)`).test(text);
}

/**
 * Add a ✅ to the docs-sync announcement for a just-merged docs PR. Scans recent
 * history of the docs channel for the message that links this PR and reacts to it.
 */
export async function markDocsSyncPrMerged(prNumber: number): Promise<void> {
  const channel = docsSyncChannel();
  if (!channel) return;

  const history = await fetchChannelHistory(channel, 200);
  const message = history.find((m) => m.isBot && linksPr(m.text, prNumber));
  if (!message) {
    console.log(
      `[github] docs-sync PR #${prNumber} merged, but no announcement found in the docs channel to check off`,
    );
    return;
  }

  await addReaction(channel, message.ts, MERGED_REACTION);
  console.log(
    `[github] Checked off docs-sync announcement for merged PR #${prNumber}`,
  );
}
