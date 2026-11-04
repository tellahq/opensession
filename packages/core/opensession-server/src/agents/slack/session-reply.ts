import { markdownToSlack } from "../../server/shared/markdown";
import {
  extractMediaMarkers,
  stripMediaMarkers,
} from "../../server/transcript-media";
import { configuredServer } from "../../server/config";
import { splitSlackMedia } from "./media";
import { SlackStreamer } from "./streamer";
import type { SlackTurnProgress } from "./turn-progress";

/** Transport instructions only. Workspace/publication policy comes from the
 * ordinary session, never a second Slack-specific coding prompt. */
export const SLACK_SESSION_NOTE =
  "This turn came from Slack. Your final reply is delivered to that thread automatically; do not post it yourself. " +
  "Use the same session tools and repository workflow as in Open Session. " +
  "Only the text after your last tool call is posted, so write the complete answer there, after any memory or bookkeeping tool calls. " +
  "Keep the reply concise. For sandbox artifacts, publish with opensession-assets and include the returned links in your reply.";

export async function mirrorSlackSessionReply(
  target: { channel: string; threadTs: string } | undefined,
  result: {
    assistantText: string;
    error?: string | null;
    sessionId: string;
    localMedia?: boolean;
    /** The turn's live card, closed before the reply lands under it. */
    progress?: SlackTurnProgress;
    cancelled?: boolean;
  },
): Promise<void> {
  await result.progress
    ?.finish(result.cancelled ? "stopped" : result.error ? "failed" : "done")
    .catch((error) =>
      console.warn("[slack] Could not close progress card:", error),
    );
  if (!target) return;
  const text = result.error
    ? `Run failed: ${result.error}`
    : result.assistantText.trim();
  if (!text) return;
  try {
    // A sandbox/automation marker is not authority to read a gateway file.
    // Keep those artifacts on the authenticated session surface; only a
    // trusted host run can use the legacy host-file upload transport.
    const shown = result.localMedia
      ? await splitSlackMedia(text)
      : {
          text: extractMediaMarkers(text).length
            ? `${stripMediaMarkers(text).trim()}\n\nView media: ${configuredServer().publicBaseUrl}/session/${encodeURIComponent(result.sessionId)}`
            : text,
          media: [],
        };
    const streamer = new SlackStreamer(target.channel, target.threadTs, "");
    await streamer.stop(markdownToSlack(shown.text).slice(0, 38000), shown);
  } catch (error) {
    console.warn("[slack] Could not mirror session reply:", error);
  }
}
