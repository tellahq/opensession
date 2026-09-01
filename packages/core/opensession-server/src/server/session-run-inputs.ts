/**
 * What a session's NEXT TURN is scoped to, engine-neutral: the MCP allowlist,
 * the tool denials, the identity the `allowedUsers` gate runs against, and
 * which in-process opensession-* server set the run carries.
 *
 * Extracted verbatim from `runSessionPromptInner` (run-session.ts) so that the
 * introspection endpoint (`GET /api/sessions/:id/effective-config`) and the
 * real turn cannot disagree: one decision, two readers. Every branch here is
 * security-relevant — resuming an automation-owned session must keep that
 * automation's scoping, and automation runs must pass no user so a
 * user-restricted MCP server stays invisible to them.
 *
 * Deliberately free of the in-process MCP builders: importing
 * interactive-mcp.ts starts the run-rpc listener as a module side effect, and
 * this module is read by a plain GET route and by tests. It names the BRANCH;
 * each caller constructs the servers it needs.
 */

import type { UnifiedSession } from "./types";
import {
  automationDeniedTools,
  automationMcpServersByName,
} from "./automations";

/** Which config decided the run's MCP allowlist. */
export type McpScopeSource =
  /** The owning automation's `mcpServers` allowlist (automations store). */
  | "automation"
  /** The session file's own `mcpServers` (stamped at create time). */
  | "session"
  /** The feed project(s) this session's external refs belong to. */
  | "feed"
  /** No allowlist: every configured server the user may see. */
  | "all";

/** Which in-process opensession-* server set the run carries. */
export type InProcessMcpBranch =
  /** Automation-owned: nothing, unless the automation is `selfImprove`. */
  | "automation-self-improve"
  /** Goal-driven session: the interactive set plus opensession-goal-self. */
  | "interactive+goal-self"
  /** The normal interactive self-management set. */
  | "interactive";

export interface SessionRunInputs {
  /** The session is owned by an automation — an interactive resume of one
   *  keeps the automation's scoping (allowlist + denials + no user). */
  isAutomationSession: boolean;
  /** MCP allowlist for the run; undefined means "all" (no allowlist). Kept as
   *  undefined rather than [] on purpose: an empty array is truthy, and
   *  `sharedPiEligible` reads any allowlist as "not shared", which once
   *  kicked every follow-up prompt onto a dedicated server whose empty shard
   *  DB could not resume the engine session (bks-019f818d, 2026-07-20). */
  mcpServers: string[] | undefined;
  mcpServersSource: McpScopeSource;
  /** Tool-permission denials, or undefined when the run carries none. */
  deniedTools: Record<string, string> | undefined;
  /** The prompter, or undefined for automation-owned sessions (which must
   *  never clear a server's `allowedUsers` gate). */
  user: string | undefined;
  /** Session creator, whose OAuth grants take precedence for MCP calls. */
  mcpGrantUser: string | undefined;
  inProcessMcpBranch: InProcessMcpBranch;
  /** Whether the run gets the repos/memory/personal-prompt note. Automation
   *  runs get none: their prompts are untrusted text. */
  sessionNote: boolean;
}

/** The session fields this module reads. Structural so callers (and tests)
 *  need not build a whole UnifiedSession. */
export type RunInputsSession = Pick<
  UnifiedSession,
  | "automation"
  | "automationDescendantPolicy"
  | "mcpServers"
  | "externalRefs"
  | "goalId"
  | "startedBy"
>;

/** Which in-process server set the next turn carries. Pure — mirrors the
 *  `inProcessMcp` ternary at the runAgent call site. */
export function sessionInProcessMcpBranch(
  session: RunInputsSession,
): InProcessMcpBranch {
  if (session.automation || session.automationDescendantPolicy)
    return "automation-self-improve";
  return session.goalId ? "interactive+goal-self" : "interactive";
}

/** Which config supplies the MCP allowlist. Pure; the `feed` branch still has
 *  to be resolved asynchronously to learn the server NAMES. */
export function sessionMcpScopeSource(
  session: RunInputsSession,
): McpScopeSource {
  if (session.automation || session.automationDescendantPolicy)
    return "automation";
  if (session.mcpServers && session.mcpServers.length) return "session";
  if (session.externalRefs?.length) return "feed";
  return "all";
}

/**
 * The per-turn run inputs for a session. `user` is the prompter (the WS/HTTP
 * caller); it is dropped for automation-owned sessions.
 *
 * Async because a feed-workspace session's allowlist comes from its feed
 * providers' descriptors (`feedMcpServersForRefs`), which registers feeds on
 * first call.
 */
export async function resolveSessionRunInputs(
  session: RunInputsSession,
  opts: { user?: string } = {},
): Promise<SessionRunInputs> {
  const isAutomationSession = !!(
    session.automation || session.automationDescendantPolicy
  );
  const source = sessionMcpScopeSource(session);
  const mcpServers = session.automationDescendantPolicy
    ? [...session.automationDescendantPolicy.mcpServers]
    : isAutomationSession
      ? automationMcpServersByName(session.automation!)
      : source === "session"
        ? session.mcpServers
        : source === "feed"
          ? // Feed-workspace sessions are scoped to their feed's declared MCP
            // servers even when the session file predates the stamping (least
            // privilege — the feeds design).
            await (
              await import("./feeds")
            ).feedMcpServersForRefs(session.externalRefs!)
          : undefined;
  return {
    isAutomationSession,
    mcpServers,
    // An automation whose record is gone (or that names no allowlist) resolves
    // to undefined, i.e. no allowlist — report the source honestly.
    mcpServersSource: mcpServers === undefined ? "all" : source,
    deniedTools: isAutomationSession ? automationDeniedTools() : undefined,
    user: isAutomationSession ? undefined : opts.user,
    mcpGrantUser: session.startedBy || undefined,
    inProcessMcpBranch: sessionInProcessMcpBranch(session),
    sessionNote: !isAutomationSession,
  };
}
