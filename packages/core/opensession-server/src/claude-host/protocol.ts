/**
 * Wire protocol between a Claude query client (the pi Anthropic provider) and
 * the Claude host service that runs the Claude Code processes.
 *
 * One WebSocket carries any number of queries; every frame names its query by
 * `id`. A query lives exactly as long as its client keeps the socket open and
 * has not closed it: the host ends the Claude Code process when the client
 * sends `close` or the socket drops. Frames are JSON text messages.
 *
 * The host never needs a real model credential. The spec's `env` may carry a
 * placeholder token and a base URL that points at a proxy holding the real
 * one (server/claude-token-proxy.ts).
 */

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudeQuerySpec,
  ClaudeToolReply,
} from "../server/claude-sdk-query";

export const CLAUDE_HOST_PROTOCOL = 1;
export const CLAUDE_HOST_DEFAULT_PORT = 3847;
export const CLAUDE_HOST_QUERY_PATH = "/v1/queries";

/** Variables a client may set on the Claude Code process. Anything else in a
 *  spec's `env` is dropped by the host. */
export const CLAUDE_HOST_ENV_ALLOWLIST: readonly string[] = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "DISABLE_COMPACT",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
];

export type ClaudeHostClientFrame =
  | { t: "start"; id: string; spec: ClaudeQuerySpec }
  | { t: "input"; id: string; message: SDKUserMessage }
  /** The client's input stream ended; the query finishes its work and ends. */
  | { t: "input_end"; id: string }
  | { t: "tool_result"; id: string; toolUseId: string; reply: ClaudeToolReply }
  | { t: "close"; id: string };

export type ClaudeHostServerFrame =
  /** First frame on every socket. */
  | { t: "ready"; protocol: number }
  | { t: "message"; id: string; message: Record<string, unknown> }
  | { t: "tool_call"; id: string; toolUseId: string }
  /** The query's message stream ended normally. */
  | { t: "end"; id: string }
  /** The query failed; no further frames follow for this id. */
  | { t: "error"; id: string; message: string };

export function filterClaudeHostEnv(
  env: Readonly<Record<string, unknown>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CLAUDE_HOST_ENV_ALLOWLIST) {
    const value = env?.[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Parse a client frame, or null when it is not one this host understands. */
export function parseClaudeHostClientFrame(
  raw: string,
): ClaudeHostClientFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const frame = value as Record<string, unknown>;
  if (typeof frame.id !== "string" || !frame.id) return null;
  switch (frame.t) {
    case "start": {
      const spec = frame.spec as Record<string, unknown> | undefined;
      if (
        !spec ||
        typeof spec !== "object" ||
        typeof spec.accountId !== "string" ||
        typeof spec.model !== "string" ||
        typeof spec.system !== "string" ||
        !Array.isArray(spec.tools)
      )
        return null;
      return frame as unknown as ClaudeHostClientFrame;
    }
    case "input":
      return frame.message && typeof frame.message === "object"
        ? (frame as unknown as ClaudeHostClientFrame)
        : null;
    case "tool_result":
      return typeof frame.toolUseId === "string" &&
        frame.reply &&
        typeof frame.reply === "object"
        ? (frame as unknown as ClaudeHostClientFrame)
        : null;
    case "input_end":
    case "close":
      return frame as unknown as ClaudeHostClientFrame;
    default:
      return null;
  }
}
