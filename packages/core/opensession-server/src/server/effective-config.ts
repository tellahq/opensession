/** Explain the configuration that will apply to a session's next Pi turn. */
import type { UnifiedSession } from "./types";
import { resolveSessionRunInputs, type SessionRunInputs } from "./session-run-inputs";
import { filterMcpServers, STRIPE_CONFIRM_TOOLS } from "./runner-shared";
import { readMcpConfig } from "./connections";
import { hasMcpOauthProxyGrantForUsers } from "./mcp-oauth";
import { userMatchesAny, commitAuthorFor } from "./shared/user-mappings";
import { configuredPaths } from "./config";
import { baseJournalKind, isUnattendedKind, deniedToolIds, runGateReason, runToolPolicy, readLocalInstructions, type RunToolPolicy } from "./run-policy";
import { DIAL_ORACLE_AGENTS, ORCHESTRATOR_WORKER_AGENTS, accountProviderForModel, dialPreset, interactiveDefaultModel, interactiveFallbackModel, modelSupportsSteer, orchestratorPreset, orchestratorWorkerForBridge, routeModel, sameBridgeDialOracle } from "./models";
import { resolveWorkspaceModelPreset } from "./workspace-model-presets";
import { getAccountById } from "./claude-accounts";
import { githubUserLoginForRun } from "./github-auth";
import { sessionMemoryScopes } from "./session-memory";
import { sessionRepoIds } from "./session-repos";
import { isRunnableSandboxProvider, sandboxProviderConfigured, sandboxesEnabled } from "./sandbox/config";
import { selfImproveMcpForSession } from "./automations";
import { createGoalSelfMcpServer } from "../agents/slack/goal-tools";

/** One resolved setting plus where it came from. */
export interface ConfigRow<T = unknown> {
  value: T;
  /** File, config key or code path that decided this. */
  source: string;
  /** "static" (same on every turn) vs "load-dependent" (a forecast the
   *  dispatch can re-resolve — account pools, shared-server placement). */
  stability?: "static" | "load-dependent";
  /** Anything a reader needs to not misread the value. */
  note?: string;
}

function row<T>(
  value: T,
  source: string,
  extra?: { stability?: ConfigRow["stability"]; note?: string },
): ConfigRow<T> {
  return { value, source, ...extra };
}

export interface McpServerRow {
  name: string;
  /** The run's model will see this server's tools. */
  included: boolean;
  /** Why it is in or out, in one clause. */
  reason: string;
  source: string;
  transport: "local" | "remote" | "unknown";
  /** Present only when the server carries an allowedUsers gate. */
  allowedUsers?: string[];
  /** The run reaches this server through the fresh-auth OAuth relay. */
  oauthGrant?: boolean;
}

export interface StrippedToolRow {
  /** Claude-style name as written in the deny/confirm catalog. */
  tool: string;
  /** Tool ids disabled before registration. */
  ids: string[];
  source: string;
  reason: string;
}

export interface EffectiveConfig {
  session: Record<string, unknown>;
  /** When this forecast was computed. */
  resolvedAt: string;
  caveat: string;
  execution: Record<string, ConfigRow>;
  gate: Record<string, ConfigRow>;
  model: Record<string, ConfigRow>;
  account: Record<string, ConfigRow>;
  mcp: {
    scope: ConfigRow<string[] | "all">;
    servers: McpServerRow[];
    inProcess: Record<string, ConfigRow>;
  };
  tools: Record<string, ConfigRow>;
  agents: Record<string, ConfigRow>;
  memory: Record<string, ConfigRow>;
  placement: Record<string, ConfigRow>;
  identity: Record<string, ConfigRow>;
  instructions: Record<string, ConfigRow>;
}

/**
 * Attribute each configured MCP server's fate for a run. Pure: the INCLUDED
 * set is handed in (it is always `filterMcpServers`, never re-derived), and
 * this only re-reads the same two inputs that helper reads — the allowlist and
 * each entry's `allowedUsers` — to say WHY. So a server can be explained here
 * but never silently added or dropped.
 */
export function explainMcpServers(input: {
  /** The raw mcp-config.json catalog. */
  all: Record<string, Record<string, unknown> | undefined>;
  /** filterMcpServers' output for this run. */
  included: Record<string, unknown>;
  /** The run's allowlist, or undefined for "all". */
  scope: string[] | undefined;
  /** Identities the allowedUsers gate is evaluated against. */
  gateUsers: string[];
  configPath: string;
  /** Whether this server's calls ride an OAuth grant relay. */
  hasOauthGrant?: (name: string) => boolean;
}): McpServerRow[] {
  const { all, included, scope, gateUsers, configPath } = input;
  const source = `${configPath} (mcpServers)`;
  const names = [...new Set([...Object.keys(all), ...(scope ?? [])])].sort();
  return names.map((name) => {
    const cfg = all[name];
    const allowedUsers = Array.isArray(cfg?.allowedUsers)
      ? (cfg!.allowedUsers as string[])
      : undefined;
    const inAllowlist = !scope || scope.includes(name);
    const isIncluded = name in included;
    const oauthGrant = !!cfg && !!input.hasOauthGrant?.(name);
    const reason = !cfg
      ? `not configured — the allowlist names a server ${configPath} does not define`
      : !inAllowlist
        ? "outside this run's MCP allowlist"
        : allowedUsers?.length && !isIncluded
          ? `allowedUsers gate: none of [${gateUsers.join(", ") || "no user"}] matches [${allowedUsers.join(", ")}]`
          : allowedUsers?.length
            ? `allowedUsers gate cleared by [${gateUsers.join(", ")}]`
            : scope
              ? "named by this run's MCP allowlist"
              : "no allowlist — every configured server this user may see";
    return {
      name,
      included: isIncluded,
      reason,
      source: !cfg
        ? "run MCP allowlist"
        : allowedUsers?.length
          ? `${source} → allowedUsers (runner-shared.ts filterMcpServers)`
          : source,
      transport:
        cfg?.type === "http" || cfg?.type === "sse" || cfg?.url
          ? "remote"
          : cfg?.command
            ? "local"
            : "unknown",
      ...(allowedUsers?.length ? { allowedUsers } : {}),
      ...(oauthGrant ? { oauthGrant } : {}),
    };
  });
}

/** explainMcpServers over the live config, with filterMcpServers deciding
 *  membership. No logic of its own — just the real sources. */
export function describeMcpServers(
  scope: string[] | undefined,
  user: string | undefined,
  grantUsers: Array<string | undefined>,
): McpServerRow[] {
  return explainMcpServers({
    all: readMcpConfig().mcpServers || {},
    included: filterMcpServers(scope ?? "all", user, grantUsers),
    scope,
    gateUsers: user ? [user] : [],
    configPath: configuredPaths().mcpConfig,
    hasOauthGrant: (name) => hasMcpOauthProxyGrantForUsers(name, [user]),
  });
}

/** The tools stripped from the model's list, each with the catalog it came
 *  from. Ids come from runToolPolicy — this only attributes them. */
export function describeStrippedTools(
  policy: { disables: Record<string, false> },
  deniedTools: Record<string, string> | undefined,
  confirmTools: Record<string, string>,
): StrippedToolRow[] {
  const rows: StrippedToolRow[] = [];
  const seen = new Set<string>();
  for (const [tool, message] of Object.entries(deniedTools || {})) {
    seen.add(tool);
    rows.push({
      tool,
      ids: deniedToolIds(tool, { broad: tool in confirmTools }),
      source: "automations.ts AUTOMATION_DENIED_TOOLS (automation-owned session)",
      reason: message,
    });
  }
  for (const [tool, label] of Object.entries(confirmTools)) {
    if (seen.has(tool)) continue;
    rows.push({
      tool,
      ids: deniedToolIds(tool, { broad: true }),
      source: "runner-shared.ts STRIPE_CONFIRM_TOOLS (every run)",
      reason: `${label} — no per-call approval bridge on this engine, so the tool is never in the model's list`,
    });
  }
  // Anything runToolPolicy disabled that neither catalog explains: the
  // engine's own natives (question, and the local-workspace tools when the
  // engine runs outside the workspace).
  for (const id of Object.keys(policy.disables)) {
    if (rows.some((r) => r.ids.includes(id))) continue;
    rows.push({
      tool: id,
      ids: [id],
      source: "run-policy.ts runToolPolicy",
      reason:
        id === "question"
          ? "the built-in question tool has no Open Session answer channel; use opensession-ask"
          : "engine built-in disabled for this run",
    });
  }
  return rows;
}

/**
 * Names only: the in-process opensession-* servers this session's next turn
 * would carry, built from the REAL builders (construction is pure — see
 * inprocess-mcp.ts createSdkMcpServer) so the list cannot drift.
 *
 * interactive-mcp.ts is imported LAZILY on purpose: it binds the run-rpc
 * socket as a module side effect, so a static import would make merely
 * importing this module (from a test, a script, a doc tool) unlink the live
 * server's socket. Inside the server it is already loaded and this is a no-op.
 */
export async function inProcessServerNames(
  session: UnifiedSession,
  inputs: SessionRunInputs,
): Promise<string[]> {
  if (inputs.inProcessMcpBranch === "automation-self-improve") {
    return Object.keys(selfImproveMcpForSession(session, session.id) || {});
  }
  const { interactiveMcpServers } = await import("./interactive-mcp");
  const servers: Record<string, unknown> = {
    ...interactiveMcpServers(inputs.user, session.id, inputs.mcpServers ?? "all"),
  };
  if (inputs.inProcessMcpBranch === "interactive+goal-self" && session.goalId) {
    servers["opensession-goal-self"] = createGoalSelfMcpServer(session.goalId);
  }
  return Object.keys(servers);
}


/** Compose the next-turn configuration from the same resolvers dispatch uses. */
export async function buildSessionEffectiveConfig(
  session: UnifiedSession,
  opts: { user?: string; verbose?: boolean } = {},
): Promise<EffectiveConfig> {
  const inputs = await resolveSessionRunInputs(session, { user: opts.user });
  const journalKind = "prompt";
  const requestedModel = session.model || interactiveDefaultModel();
  const routed = routeModel(requestedModel, { interactive: true });
  const providerID = routed.model.match(/^pi\/([^/]+)\//)?.[1];
  const sandboxProvider = session.sandbox?.provider;
  const sandboxRunnable = isRunnableSandboxProvider(sandboxProvider);
  const sandboxBlocked = !sandboxesEnabled()
    ? "sandboxes are disabled instance-wide"
    : sandboxRunnable && !sandboxProviderConfigured(sandboxProvider as any)
      ? `provider "${sandboxProvider}" is not configured`
      : inputs.isAutomationSession && sandboxRunnable
        ? "automation-owned sessions may not open an interactive sandbox connection"
        : null;
  const target = session.runner
    ? "runner"
    : sandboxRunnable && !sandboxBlocked
      ? "sandbox"
      : "host";
  const execution: Record<string, ConfigRow> = {
    target: row(target, "run-session.ts execution placement"),
    cwd: row(session.worktreeDir || null, "session file worktreeDir"),
    branch: row(session.branch || null, "session file branch"),
    mode: row(session.mode || "code", "session file mode"),
    sandbox: row(session.sandbox || null, "session file sandbox"),
  };

  const gateReason = runGateReason({ journal: { kind: journalKind } });
  const gate: Record<string, ConfigRow> = {
    journalKind: row(journalKind, "run-session.ts journal.kind"),
    unattendedKind: row(isUnattendedKind(baseJournalKind(journalKind)), "run-policy.ts isUnattendedKind"),
    allowed: row(gateReason === null, "run-policy.ts runGateReason"),
    reason: row(gateReason, "run-policy.ts runGateReason"),
  };

  const preset = dialPreset(requestedModel) ?? orchestratorPreset(requestedModel) ??
    resolveWorkspaceModelPreset(requestedModel, session.workspaceId);
  const model: Record<string, ConfigRow> = {
    requested: row(requestedModel, session.model ? "session file model" : "instance interactive default"),
    engine: row("pi", "models.ts routeModel"),
    dispatchModel: row(routed.model, "models.ts routeModel"),
    provider: row(providerID ?? null, "Pi model id provider segment"),
    preset: row(preset ? { id: requestedModel, label: (preset as { label?: string }).label, mainModel: preset.model } : null, "model preset registry"),
    effort: row(session.effort ?? null, "session file effort"),
    fastMode: row(session.fastMode ?? false, "session file fastMode"),
    fallbackModel: row(interactiveFallbackModel(session.model) ?? null, "models.ts interactiveFallbackModel"),
    supportsSteer: row(modelSupportsSteer(requestedModel), "models.ts modelSupportsSteer"),
    accountPool: row(accountProviderForModel(requestedModel) ?? null, "models.ts accountProviderForModel"),
  };

  const account: Record<string, ConfigRow> = {
    pinned: row(
      session.accountId ? { id: session.accountId, name: getAccountById(session.accountId)?.name ?? null } : null,
      "session file accountId",
      { stability: "load-dependent" },
    ),
  };

  const grantUsers = [inputs.mcpGrantUser, inputs.user];
  const inProcess = await inProcessServerNames(session, inputs);
  const mcp = {
    scope: row<string[] | "all">(inputs.mcpServers ?? "all", "session-run-inputs.ts MCP scope"),
    servers: describeMcpServers(inputs.mcpServers, inputs.user, grantUsers),
    inProcess: {
      branch: row(inputs.inProcessMcpBranch, "session-run-inputs.ts in-process branch"),
      servers: row(inProcess, "interactive-mcp.ts / automations.ts"),
    },
  };

  const policy = runToolPolicy({
    deniedTools: inputs.deniedTools,
    confirmTools: STRIPE_CONFIRM_TOOLS,
    journalKind,
  });
  const tools: Record<string, ConfigRow> = {
    unattended: row(policy.unattended, "run-policy.ts runToolPolicy"),
    stripped: row(describeStrippedTools(policy, inputs.deniedTools, STRIPE_CONFIRM_TOOLS), "run-policy.ts runToolPolicy"),
    disabledIds: row(Object.keys(policy.disables).sort(), "run-policy.ts runToolPolicy"),
    bashPolicy: row(session.mode === "ask" ? "read-only allowlist" : policy.unattended ? "org command policy" : "unrestricted", "runner-shared.ts / command-policy.ts"),
  };

  const bridgeProvider = providerID || "anthropic";
  const agents: Record<string, ConfigRow> = {
    oracles: row(Object.keys(DIAL_ORACLE_AGENTS).map((name) => {
      const effective = sameBridgeDialOracle(name, bridgeProvider);
      return { agent: name, resolvesTo: effective, model: DIAL_ORACLE_AGENTS[effective]?.model };
    }), "models.ts dial oracle registry"),
    orchestratorWorkers: row(Object.keys(ORCHESTRATOR_WORKER_AGENTS)
      .map((name) => ({ agent: name, model: orchestratorWorkerForBridge(name, bridgeProvider)?.model }))
      .filter((worker) => !!worker.model), "models.ts worker registry"),
    activePreset: row(preset ? { id: requestedModel } : null, "model preset registry"),
  };

  const scopes = sessionMemoryScopes({ user: inputs.user, repos: sessionRepoIds(session) });
  const memory: Record<string, ConfigRow> = {
    injected: row(inputs.sessionNote, "run-session.ts session note"),
    scopes: row(inputs.sessionNote ? scopes.map((scope) => ({ key: scope.key, kind: scope.kind, label: scope.label })) : [], "session-memory.ts"),
  };
  const placement: Record<string, ConfigRow> = {
    mode: row(target === "host" ? "detached run host" : target, "run-session.ts"),
    restartSafe: row(target !== "runner" || true, "host-client.ts / sandbox provider"),
  };
  const git = commitAuthorFor(inputs.user, session.startedBy);
  const identity: Record<string, ConfigRow> = {
    user: row(inputs.user ?? null, "request identity"),
    git: row(git ?? null, "shared/user-mappings.ts"),
    github: row(githubUserLoginForRun(inputs.user || git?.name) ?? null, "github-auth.ts"),
    paths: row(configuredPaths(), "config.ts configuredPaths"),
  };
  const localInstructions = readLocalInstructions(session.worktreeDir || undefined);
  const instructions: Record<string, ConfigRow> = {
    channel: row("Pi system prompt", "pi-runner.ts"),
    sources: row([
      "run-instructions.ts buildRunInstructions",
      ...(inputs.sessionNote ? ["session note"] : []),
      ...(session.presetNote ? ["workspace model preset"] : []),
      ...(localInstructions ? ["workspace-local instructions"] : []),
    ], "pi-runner.ts instruction composition"),
  };

  const doc: EffectiveConfig = {
    session: {
      id: session.id,
      title: session.title,
      source: session.source,
      workspaceId: session.workspaceId ?? null,
      repo: session.repo ?? null,
      automation: session.automation ?? null,
      goalId: session.goalId ?? null,
      archived: !!session.archived,
    },
    resolvedAt: new Date().toISOString(),
    caveat: "A forecast of the next turn. Account selection and fallback routing are resolved again at dispatch.",
    execution,
    gate,
    model,
    account,
    mcp,
    tools,
    agents,
    memory,
    placement,
    identity,
    instructions,
  };
  if (opts.verbose) {
    const { ASK_BASH_PERMISSIONS } = await import("./runner-shared");
    doc.tools.bashPolicyRules = row(ASK_BASH_PERMISSIONS, "runner-shared.ts ASK_BASH_PERMISSIONS");
  }
  return doc;
}
