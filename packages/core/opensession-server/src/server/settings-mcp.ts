import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type InProcessMcpServer,
} from "./inprocess-mcp";
import {
  getPersonalPrompt,
  MAX_PERSONAL_PROMPT_LENGTH,
  updatePersonalPrompt,
} from "./personal-prompts";
import {
  getPersonalOutputStyle,
  setPersonalOutputStyle,
} from "./personal-output-style";
import { isMachineActor } from "./session-actors";

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

const promptChange = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("append"),
      text: z.string().trim().min(1).max(MAX_PERSONAL_PROMPT_LENGTH),
    })
    .strict(),
  z
    .object({
      operation: z.literal("replace"),
      text: z.string().trim().max(MAX_PERSONAL_PROMPT_LENGTH),
      expected: z
        .string()
        .max(MAX_PERSONAL_PROMPT_LENGTH)
        .describe(
          "The exact personalPrompt returned by get_settings. A stale value refuses the edit. Use empty text to clear the prompt.",
        ),
    })
    .strict(),
]);

/** Identity comes from the trusted turn context, never a tool argument or
 * session-owner fallback. Even an auto-continue cannot edit personal settings. */
export function personalSettingsMcpServers(
  user?: string,
): Record<string, InProcessMcpServer> {
  const who = user?.trim();
  if (!who || isMachineActor(who)) return {};
  return { "opensession-settings": createSettingsMcpServer(who) };
}

export function createSettingsMcpServer(user: string) {
  if (!user.trim() || isMachineActor(user)) {
    throw new Error("Personal settings require a human prompting user.");
  }
  const settings = async () => ({
    personalPrompt: await getPersonalPrompt(user),
    outputStyle: await getPersonalOutputStyle(user),
    maxPersonalPromptLength: MAX_PERSONAL_PROMPT_LENGTH,
  });
  return createSdkMcpServer({
    name: "opensession-settings",
    tools: [
      tool(
        "get_settings",
        "Read the current prompting user's personal system prompt and output style from Open Session Settings. These are the same preferences used by the web and native apps. No other user's settings or credentials are accessible.",
        {},
        async () => text(await settings()),
      ),
      tool(
        "update_personal_prompt",
        "Change the current prompting user's personal system prompt when they ask. Append preserves existing instructions; replace requires the exact current prompt from get_settings and can clear it with empty text. Repeating an append already at the end is a no-op. Changes apply to subsequent interactive turns, not the current turn or automations.",
        { change: promptChange },
        async ({ change }) => {
          await updatePersonalPrompt(user, (current) => {
            if (change.operation === "replace" && current !== change.expected) {
              throw new Error(
                "The personal prompt changed. Read get_settings and reapply your edit.",
              );
            }
            const next =
              change.operation === "replace"
                ? change.text
                : current === change.text ||
                    current.endsWith(`\n\n${change.text}`)
                  ? current
                  : [current, change.text].filter(Boolean).join("\n\n");
            if (next.length > MAX_PERSONAL_PROMPT_LENGTH) {
              throw new Error(
                `The combined prompt exceeds ${MAX_PERSONAL_PROMPT_LENGTH} characters. Nothing changed.`,
              );
            }
            return next;
          });
          return text(await settings());
        },
      ),
      tool(
        "set_output_style",
        "Set the current prompting user's Open Session output style when they ask. Concise shortens reports without reducing engineering thoroughness; default restores the normal style. Applies to subsequent interactive turns and leaves the personal prompt unchanged.",
        { outputStyle: z.enum(["default", "concise"]) },
        async ({ outputStyle }) => {
          await setPersonalOutputStyle(user, outputStyle);
          return text(await settings());
        },
      ),
    ],
  });
}
