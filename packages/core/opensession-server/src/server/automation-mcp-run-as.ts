/**
 * "Run MCP sign-ins as": one automation may borrow ONE teammate's personal
 * MCP OAuth grants for its own runs.
 *
 * Automation runs normally carry no grant identity at all (run-session.ts:
 * "a human's OAuth grants must not ride an automation-owned session's
 * turns"), so a server that only has per-user grants is unusable to them.
 * This setting is the narrow, opt-in exception:
 *
 * - Only the named teammate can set it, and only to themselves: every write
 *   is checked against a verified actor (the signed-in user over HTTP, the
 *   human who sent the turn for the admin MCP tool). Clearing needs no
 *   identity, since it only removes access.
 * - It applies to the servers pinned when it was set, intersected with the
 *   automation's current MCP allowlist. Someone who later widens the
 *   allowlist does not widen whose grants reach the new server. An
 *   automation with no explicit allowlist never uses it.
 * - It feeds the MCP grant lookup ONLY. The allowedUsers visibility gate, the
 *   workspace grant, provider-account routing and AWS policy are unchanged.
 * - It applies to the automation's own turns. Descendant sessions get none,
 *   and a turn sent by a different person gets none.
 */
import { resolveTeammate } from "./shared/user-mappings";
import { AUTO_CONTINUE_USER } from "./auto-continue";
import {
  AUTOMATION_ACTOR_SUFFIX,
  SYSTEM_RESTART_USER,
  scheduledOwner,
} from "./session-actors";

/** Stored on Automation.mcpRunAs. */
export interface AutomationMcpRunAs {
  /** Canonical teammate name: the key personal grants are stored under. */
  person: string;
  /** MCP servers whose personal grant this automation may use. Always a
   *  subset of the allowlist at the time it was set. */
  servers: string[];
  setAt: string;
}

/** What a run carries: whose personal grants, for which servers. */
export interface McpRunAs {
  user: string;
  servers: string[];
}

type FieldError = { error: string };

/** The caller asked to clear the setting. */
export const CLEAR_MCP_RUN_AS = Symbol("clear-mcp-run-as");

/**
 * Accepted input shapes: `""`/`null` clears it; a person reference (name,
 * alias, GitHub login, Slack id) sets it for every allowlisted server; or
 * `{ person, servers }` narrows it to some of them.
 */
export function parseMcpRunAsInput(
  value: unknown,
):
  | typeof CLEAR_MCP_RUN_AS
  | { person: string; servers?: string[] }
  | FieldError {
  if (value === null || value === undefined) return CLEAR_MCP_RUN_AS;
  if (typeof value === "string")
    return value.trim() ? { person: value.trim() } : CLEAR_MCP_RUN_AS;
  if (typeof value === "object" && !Array.isArray(value)) {
    const { person, servers } = value as Record<string, unknown>;
    if (person === undefined || person === null || person === "")
      return CLEAR_MCP_RUN_AS;
    if (typeof person !== "string")
      return { error: "mcpRunAs.person must be a teammate name" };
    if (
      servers !== undefined &&
      (!Array.isArray(servers) || servers.some((s) => typeof s !== "string"))
    )
      return { error: "mcpRunAs.servers must be a list of MCP server names" };
    return {
      person: person.trim(),
      ...(servers
        ? { servers: (servers as string[]).map((s) => s.trim()) }
        : {}),
    };
  }
  return { error: "mcpRunAs must be a teammate name, or empty to clear it" };
}

/**
 * Authorize and build the stored value. `actor` must be a verified identity
 * supplied by the surface (never request input); the requested person must
 * resolve to that same teammate.
 */
export function authorizeMcpRunAs(
  request: { person: string; servers?: string[] },
  actor: string | undefined,
  allowlist: readonly string[] | undefined,
  now: Date = new Date(),
): AutomationMcpRunAs | FieldError {
  const target = resolveTeammate(request.person);
  if (!target)
    return {
      error: `Run MCP sign-ins as: "${request.person}" is not a known teammate`,
    };
  const self = actor ? resolveTeammate(actor) : null;
  if (!self)
    return {
      error:
        "Run MCP sign-ins as can only be set by a signed-in teammate, to themselves",
    };
  if (self.slackId !== target.slackId)
    return {
      error:
        "Run MCP sign-ins as can only name yourself: only that person can let an automation use their sign-ins",
    };
  if (!allowlist)
    return {
      error:
        "Run MCP sign-ins as needs a list of MCPs, so it is clear which ones use your sign-ins",
    };
  const servers = request.servers ?? [...allowlist];
  const outside = servers.filter((s) => !allowlist.includes(s));
  if (outside.length)
    return {
      error: `Run MCP sign-ins as: these MCPs are not in the automation's list: ${outside.join(", ")}`,
    };
  if (!servers.length)
    return {
      error:
        "Run MCP sign-ins as needs at least one MCP from the automation's list",
    };
  return {
    person: target.name,
    servers: [...new Set(servers)],
    setAt: now.toISOString(),
  };
}

/**
 * Whether a turn's raw sender may borrow the named person's grants: no
 * sender (the automation's own run), the session's own machine continuations
 * (auto-continue, restart resume, a report from its own worker, the
 * automation itself), or the named person, including a /loop, scheduled or
 * wait tick they set. Everything else is refused: another person, a tick
 * another person scheduled, an unattributed tick, or another session's
 * `agent <id>` message.
 */
function senderMayUseRunAs(sender: string | undefined, person: string) {
  if (!sender) return true;
  const lower = sender.toLowerCase();
  if (
    lower === AUTO_CONTINUE_USER ||
    lower === SYSTEM_RESTART_USER ||
    lower.startsWith("worker ") ||
    lower.endsWith(AUTOMATION_ACTOR_SUFFIX)
  )
    return true;
  const owner = scheduledOwner(sender);
  if (!owner) return false;
  const who = resolveTeammate(owner);
  const named = resolveTeammate(person);
  return !!who && !!named && who.slackId === named.slackId;
}

/**
 * The grant identity one automation turn may use, or undefined. `sender` is
 * the turn's raw sender, scheduler suffixes included (undefined for the
 * automation's own run); see {@link senderMayUseRunAs}.
 */
export function mcpRunAsForAutomationTurn(
  automation: {
    mcpRunAs?: AutomationMcpRunAs;
    mcpServers?: string[];
  },
  sender?: string | null,
): McpRunAs | undefined {
  const runAs = automation.mcpRunAs;
  if (!runAs?.person || !Array.isArray(automation.mcpServers)) return undefined;
  const servers = runAs.servers.filter((s) =>
    automation.mcpServers!.includes(s),
  );
  if (!servers.length) return undefined;
  if (!senderMayUseRunAs(sender?.trim() || undefined, runAs.person))
    return undefined;
  return { user: runAs.person, servers };
}
