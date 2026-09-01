import { z } from "zod";
import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { openSlackComposer } from "../../server/slack-compose";

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

export function createSlackComposeMcpServer(ctx: { sessionId: string }) {
  return createSdkMcpServer({
    name: "opensession-slack",
    version: "1.0.0",
    tools: [
      tool(
        "compose_message",
        "Open an editable Slack composer in this Open Session and wait for the signed-in person to send or cancel it. Use this when a useful update is ready to share but the human should review the message, channel, and images first. This tool never posts by itself: the person must press Send in the UI.",
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
        async (
          args: { message?: string; channel?: string; images?: string[] },
          extra: any,
        ) => {
          try {
            const result = await openSlackComposer(
              ctx.sessionId,
              args,
              extra?.signal,
            );
            if (result.status === "cancelled")
              return text(
                "The person cancelled the Slack message. Nothing was sent.",
              );
            const where = `#${result.channel?.name || result.channel?.id || "channel"}`;
            return text(
              result.permalink
                ? `The person sent the Slack message to ${where}: ${result.permalink}`
                : `The person sent the Slack message to ${where}.`,
            );
          } catch (error: any) {
            return text(
              `Could not open the Slack composer: ${error?.message || String(error)}`,
            );
          }
        },
      ),
    ],
  });
}
