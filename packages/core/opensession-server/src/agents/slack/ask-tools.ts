/**
 * opensession-ask — an in-process MCP server that gives non-Claude engines the
 * AskUserQuestion flow. Claude runs pause on the native AskUserQuestion tool
 * (claude-runner's canUseTool → onAskUser); Codex has no such hook, so this
 * exposes the same handler as a callable tool. A call blocks on the session's
 * question card in the Open Session UI (broadcast + push, Slack escalation after
 * the UI timeout — see makeAskHandler in opensession.ts) and returns the human's
 * answers as the tool result.
 *
 * Wired like the other opensession-* siblings: interactive runs only, never
 * automations. claude-runner strips this server from its MCP set so Claude
 * sessions keep using the native tool instead of a duplicate.
 */

import { productName } from "../../server/config";
import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";

/** Same shape as claude-runner's onAskUser / opensession.ts makeAskHandler. */
export type AskUserHandler = (
  input: Record<string, unknown>,
) => Promise<
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string }
>;

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function createAskUserMcpServer(ctx: { ask: AskUserHandler }) {
  const tools = [
    tool(
      "ask_user",
      "Ask the human watching this session a question and wait for their answer. " +
        `The run pauses on a question card in the ${productName()} UI (escalating to the session ` +
        "owner over Slack if nobody answers there), and this tool returns what they chose " +
        "or typed. Use it only for a genuine fork in the work — a decision you can't make " +
        "from the request, the code, or a sensible default. Offer 2-4 concrete options " +
        "when the choice is enumerable; the human can always answer with free text.",
      {
        questions: z
          .array(
            z.object({
              question: z
                .string()
                .describe(
                  "The complete question to ask, ending with a question mark.",
                ),
              header: z
                .string()
                .optional()
                .describe(
                  "Very short topic chip shown above the question (max ~12 chars).",
                ),
              options: z
                .array(
                  z.object({
                    label: z
                      .string()
                      .describe("Concise choice text (1-5 words)."),
                    description: z
                      .string()
                      .optional()
                      .describe("What picking this option means."),
                  }),
                )
                .optional()
                .describe("Concrete choices; omit for a free-text question."),
              multiSelect: z
                .boolean()
                .optional()
                .describe("Allow picking multiple options."),
            }),
          )
          .min(1)
          .max(4)
          .describe("1-4 questions to ask together on one card."),
      },
      async (args: { questions: unknown[] }) => {
        const result = await ctx.ask({ questions: args.questions });
        if (result.behavior === "deny") {
          return text(result.message);
        }
        const answers =
          (result.updatedInput as { answers?: Record<string, string> })
            .answers || {};
        const lines = Object.entries(answers).map(
          ([q, a]) => `Q: ${q}\nA: ${a}`,
        );
        return text(
          lines.length
            ? `The human answered:\n\n${lines.join("\n\n")}`
            : "The question was acknowledged but no answer text came back — proceed with your best judgment and note the assumption.",
        );
      },
    ),
  ];

  return createSdkMcpServer({
    name: "opensession-ask",
    version: "1.0.0",
    tools,
  });
}
