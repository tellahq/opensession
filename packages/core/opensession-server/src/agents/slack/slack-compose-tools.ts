import { z } from "zod";
import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { wrapContext } from "../../server/prompt-context";
import {
  openSlackComposer,
  type SlackComposeResult,
} from "../../server/slack-compose";

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

/** Hands the person's decision back to the session that opened the draft. */
export type SlackComposeOutcomeDelivery = (
  sessionId: string,
  requestId: string,
  message: string,
) => Promise<void>;

export function slackComposeOutcomeMessage(
  requestId: string,
  result: SlackComposeResult,
): string {
  let outcome: string;
  if (result.status === "cancelled") {
    outcome = `The person cancelled the Slack draft ${requestId}. Nothing was sent.`;
  } else {
    const where = `#${result.channel?.name || result.channel?.id || "channel"}`;
    outcome = result.permalink
      ? `The person sent the Slack draft ${requestId} to ${where}: ${result.permalink}`
      : `The person sent the Slack draft ${requestId} to ${where}.`;
  }
  // The "background-wait" source marks this as model-only context that starts
  // its own turn, the same way a durable agent wait's wake-up does.
  return wrapContext(
    `A Slack draft the assistant opened with compose_message was resolved. ` +
      `This is system context, not a new user message.\n\n${outcome}`,
    "background-wait",
  );
}

const deliverToSession: SlackComposeOutcomeDelivery = async (
  sessionId,
  requestId,
  message,
) => {
  // Loaded on use: session-control pulls in the whole run stack.
  const { getSessionControl } = await import("../../server/session-control");
  const result = await getSessionControl().deliverToSession(
    sessionId,
    message,
    undefined,
    { deliveryId: `slack-composer:${requestId}` },
  );
  if (result.status === "error") throw new Error(result.message);
};

export function createSlackComposeMcpServer(ctx: {
  sessionId: string;
  deliver?: SlackComposeOutcomeDelivery;
}) {
  const deliver = ctx.deliver ?? deliverToSession;
  return createSdkMcpServer({
    name: "opensession-slack",
    version: "1.0.0",
    tools: [
      tool(
        "compose_message",
        "Open an editable Slack composer in this Open Session for the signed-in person to review, then return at once. The draft stays open until the person presses Send or Cancel, however long that takes, and the outcome (with the message link when sent) arrives later in this session as system context. Do not post the same update another way or open a second draft while waiting. Use this when a useful update is ready to share but the human should review the message, channel, and images first. This tool never posts by itself: the person must press Send in the UI. When the person has explicitly said to post without review, use the Slack server's slack_post_message instead: its images option attaches images (a chart PNG) to a direct post.",
        {
          message: z
            .string()
            .max(500)
            .optional()
            .describe("Draft Slack message, editable before sending."),
          channel: z
            .string()
            .optional()
            .describe("Optional configured channel name or id to preselect."),
          images: z
            .array(z.string())
            .max(10)
            .optional()
            .describe(
              "Optional absolute image paths under /tmp or the service home to preview in the composer.",
            ),
        },
        async (args: {
          message?: string;
          channel?: string;
          images?: string[];
        }) => {
          let opened: ReturnType<typeof openSlackComposer>;
          try {
            opened = openSlackComposer(ctx.sessionId, args);
          } catch (error: any) {
            return text(
              `Could not open the Slack composer: ${error?.message || String(error)}`,
            );
          }
          // The call does not wait for the person. Holding it open would put a
          // human's review behind every MCP client's request timeout, and a
          // timed-out call used to take the draft down with it.
          const { request, result } = opened;
          void result
            .then((outcome) =>
              deliver(
                ctx.sessionId,
                request.id,
                slackComposeOutcomeMessage(request.id, outcome),
              ),
            )
            .catch((error) =>
              console.error(
                `[slack-compose] couldn't deliver the outcome of draft ${request.id}:`,
                error,
              ),
            );
          return text(
            `Opened Slack draft ${request.id} in this session's composer. It stays open until the person sends or cancels it, and the outcome will arrive in this session as system context. Nothing has been posted yet.`,
          );
        },
      ),
    ],
  });
}
