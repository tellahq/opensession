import { parseMcpTool } from "@tellahq/opensession-protocol/tool-presentation";

const PLAN_TOOL = /^apple_release_plan_[a-z_]+$/;
const PLAN_ID =
  /"plan"\s*:\s*\{\s*"schemaVersion"\s*:\s*1\s*,\s*"id"\s*:\s*"([0-9a-f-]{36})"/;

/** Whether a tool call (already unwrapped from any MCP dispatcher) created an
 *  Apple release plan, so its row stays out of folded runs and carries the
 *  approval card. */
export function isAppleReleasePlanTool(toolName: string): boolean {
  const mcp = parseMcpTool(toolName);
  return Boolean(mcp && PLAN_TOOL.test(mcp.tool));
}

/** The plan ID from a planning tool's JSON result. The card shows only what
 *  the server's signed approval request says, so this is just a lookup key. */
export function appleReleasePlanId(content: string): string | null {
  return content.match(PLAN_ID)?.[1] ?? null;
}
