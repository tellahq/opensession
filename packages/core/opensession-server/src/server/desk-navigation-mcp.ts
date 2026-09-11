import { z } from "zod";
import { createSdkMcpServer, tool } from "./inprocess-mcp";
import { deskTextNavigation } from "./desk-text-navigation";
import { SHOW_IN_APP_TOOL, showInApp } from "./desk-voice-show";

export function deskNavigationMcp(
  sessionId: string,
  promptEntryId?: string,
): Record<string, unknown> {
  // Grants exist only for validated Desk prompts in an interactive run.
  const navigation = deskTextNavigation.forTurn(sessionId, promptEntryId);
  if (!navigation) return {};
  return {
    "opensession-desk": createSdkMcpServer({
      name: "opensession-desk",
      version: "1.0.0",
      tools: [
        tool(
          SHOW_IN_APP_TOOL.name,
          "Show a session or workspace in the browser that sent this Desk message. Use when the user asks to see, open, or go to it. Accepts an ID, title or distinctive part of the name, never a URL. Ask which one when names are ambiguous.",
          {
            session: z.string().max(256).optional(),
            workspace: z.string().max(256).optional(),
          },
          async (args) => ({
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(await showInApp(navigation, args)),
              },
            ],
          }),
        ),
      ],
    }),
  };
}
