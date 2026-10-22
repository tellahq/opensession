/**
 * The Slack thread a session started from, as a "Send to Slack" target.
 *
 * A session someone started from a Slack thread reports back where it was
 * asked, so both Slack composers offer that thread first and preselect it.
 * The picker carries it as one more option with the reserved value
 * `SLACK_THREAD_TARGET`; the send routes map that value back to the thread.
 */

import { slackApiGet } from "../agents/slack/slack-api";
import type { SlackChannelOption } from "../agents/slack/channel-directory";
import type { UnifiedSession } from "./types";

export const SLACK_THREAD_TARGET = "thread";

export interface SlackThreadTarget {
  channel: SlackChannelOption;
  threadTs: string;
}

const CONVERSATION_ID = /^[CGD][A-Z0-9]{6,}$/;

/** The thread this session was started from, when it came from Slack. */
export function sessionSlackThread(
  session: Pick<UnifiedSession, "slackOrigin" | "slackThread"> | undefined,
): { channel: string; threadTs: string } | undefined {
  const origin = session?.slackOrigin ?? session?.slackThread;
  if (!origin?.threadTs || !CONVERSATION_ID.test(origin.channel || ""))
    return undefined;
  return { channel: origin.channel, threadTs: origin.threadTs };
}

/** Resolve the thread's channel name from `known`, else ask Slack. */
export async function slackThreadTarget(
  session: Pick<UnifiedSession, "slackOrigin" | "slackThread"> | undefined,
  known: SlackChannelOption[] = [],
): Promise<SlackThreadTarget | undefined> {
  const thread = sessionSlackThread(session);
  if (!thread) return undefined;
  let name = known.find((channel) => channel.id === thread.channel)?.name;
  if (!name && thread.channel.startsWith("D")) name = "DM";
  if (!name) {
    const info = await slackApiGet("conversations.info", {
      channel: thread.channel,
    }).catch(() => null);
    name = typeof info?.channel?.name === "string" ? info.channel.name : "";
  }
  return {
    channel: { id: thread.channel, name: name || "Slack" },
    threadTs: thread.threadTs,
  };
}

/** The thread as a channel option: the picker lists it as "#general thread",
 *  and the receipt reads "Sent to #general thread". */
export function slackThreadOption(
  target: SlackThreadTarget,
): SlackChannelOption {
  return { id: SLACK_THREAD_TARGET, name: threadName(target) };
}

/** Where a thread reply landed, for the receipt. */
export function slackThreadReceipt(
  target: SlackThreadTarget,
): SlackChannelOption {
  return { id: target.channel.id, name: threadName(target) };
}

function threadName(target: SlackThreadTarget): string {
  return `${target.channel.name} thread`;
}
