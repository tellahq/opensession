/**
 * Effective configuration for a session's NEXT TURN — the composed answer to
 * "why did this session (not) get tool X or model Y", assembled by CALLING the
 * real resolution code rather than restating it:
 *
 *   - run inputs (MCP allowlist, denials, run identity)  session-run-inputs.ts
 *   - engine + model routing                             models.ts routeModel
 *   - MCP visibility (allowlist + allowedUsers)          runner-shared.ts filterMcpServers
 *   - run gate, tool stripping, shared-server placement  opencode-policy.ts
 *   - bridge account stickiness                          opencode-runner.ts
 *   - memory scopes                                      session-memory.ts
 *   - sandbox / runner placement                         sandbox/config.ts, runners.ts
 *
 * Every row carries a `source` naming the file, config key or code path that
 * decided it, so a row can be traced without reading five modules.
 *
 * READ-ONLY and BEST-EFFORT. Nothing here mutates: the account row peeks
 * (`recordPick: false`) the same way claudePoolDryReason does. And it is a
 * forecast, not a contract — an account can be re-picked mid-turn on a
 * near-limit steer, a dry pool can make an unattended run wait, and the model
 * fallback graph can move the run off its first choice. Rows that can resolve
 * differently at dispatch are marked `stability: "load-dependent"`.
 */

import type { UnifiedSession } from "./types";
import { resolveSessionRunInputs, type SessionRunInputs } from "./session-run-inputs";
import { filterMcpServers, STRIPE_CONFIRM_TOOLS } from "./runner-shared";
import { readMcpConfig } from "./connections";
import { hasMcpOauthGrantForUsers } from "./mcp-oauth";
import { userMatchesAny, commitAuthorFor } from "./shared/user-mappings";
import { configuredPaths } from "./config";
import {
  SHARED_INPROCESS_SERVERS,
  baseJournalKind,
  isUnattendedKind,
  opencodeDeniedToolIds,
  opencodeGateReason,
  opencodeRunPolicy,
  parseOpencodeModel,
  readLocalInstructions,
  sharedOpencodeEligible,
  sharedServerKey,
} from "./opencode-policy";
import {
  DIAL_ORACLE_AGENTS,
  ORCHESTRATOR_WORKER_AGENTS,
  accountProviderForModel,
  dialPreset,
  interactiveDefaultModel,
  interactiveFallbackModel,
  modelEngineKey,
  modelSupportsSteer,
  orchestratorPreset,
  orchestratorWorkerForBridge,
  routeModel,
  sameBridgeDialOracle,
  explicitEngineFor,
} from "./models";
import { resolveWorkspaceModelPreset } from "./workspace-model-presets";
import { enginesConfigPath, modelEngineDefault } from "./engine/engines-config";
import { readOpencodeBridgeConfig } from "./opencode-config";
import {
  claudePoolDryReason,
  meridianRequiredModels,
  pickMeridianAccount,
  stickyMeridianAccountFor,
} from "./opencode-runner";
import { getAccountById } from "./claude-accounts";
import { githubUserLoginForRun } from "./github-auth";
import { sessionMemoryScopes } from "./session-memory";
import { sessionRepoIds } from "./session-repos";
import { getAutomation } from "./automations";
import {
  isRunnableSandboxProvider,
  sandboxProviderConfigured,
  sandboxesEnabled,
} from "./sandbox/config";
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
  /** OpenCode `tools` ids actually disabled for it. */
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
    hasOauthGrant: (name) => hasMcpOauthGrantForUsers(name, [user]),
  });
}

/** The tools stripped from the model's list, each with the catalog it came
 *  from. Ids come from opencodeRunPolicy — this only attributes them. */
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
      ids: opencodeDeniedToolIds(tool, { broad: tool in confirmTools }),
      source: "automations.ts AUTOMATION_DENIED_TOOLS (automation-owned session)",
      reason: message,
    });
  }
  for (const [tool, label] of Object.entries(confirmTools)) {
    if (seen.has(tool)) continue;
    rows.push({
      tool,
      ids: opencodeDeniedToolIds(tool, { broad: true }),
      source: "runner-shared.ts STRIPE_CONFIRM_TOOLS (every run)",
      reason: `${label} — no per-call approval bridge on this engine, so the tool is never in the model's list`,
    });
  }
  // Anything opencodeRunPolicy disabled that neither catalog explains: the
  // engine's own natives (question, and the local-workspace tools when the
  // engine runs outside the workspace).
  for (const id of Object.keys(policy.disables)) {
    if (rows.some((r) => r.ids.includes(id))) continue;
    rows.push({
      tool: id,
      ids: [id],
      source: "opencode-policy.ts opencodeRunPolicy",
      reason:
        id === "question"
          ? "opencode's native question tool waits for its own TUI — this engine exposes opensession-ask instead"
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

/**
 * Compose the whole document. `user` is who is asking (the prompter a next
 * turn would be attributed to) — pass the request's identity, because the
 * `allowedUsers` gate and the shared-server key both key off it.
 */
export async function buildSessionEffectiveConfig(
  session: UnifiedSession,
  opts: { user?: string; verbose?: boolean } = {},
): Promise<EffectiveConfig> {
  const inputs = await resolveSessionRunInputs(session, { user: opts.user });
  const journalKind = "prompt";
  const requestedModel = session.model || interactiveDefaultModel();
  const routed = routeModel(requestedModel, { interactive: true });
  const parsed = parseOpencodeModel(routed.model);
  const providerID = parsed?.providerID;

  // ── Where the turn executes ────────────────────────────────────────────────
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
    target: row(target, "run-session.ts maybeLaunchRunnerRun → maybeLaunchSandboxedRun → host", {
      note:
        target === "runner"
          ? `runner "${session.runner!.name}" (${session.runner!.workspacePath})`
          : target === "sandbox"
            ? `sandbox provider "${sandboxProvider}"`
            : "in-process on this host",
    }),
    cwd: row(session.worktreeDir || null, "session file worktreeDir"),
    branch: row(session.branch || null, "session file branch"),
    mode: row(session.mode || "code", "session file mode", {
      note:
        session.mode === "ask"
          ? "read-only: edit denied, bash limited to ASK_BASH_PERMISSIONS (runner-shared.ts)"
          : session.mode === "scratch"
            ? "no repo — a working directory only"
            : "write tools available in this session's worktree",
    }),
    sandbox: row(
      session.sandbox
        ? { provider: sandboxProvider, sandboxId: session.sandbox.sandboxId, blocked: sandboxBlocked }
        : null,
      "session file sandbox + sandbox/config.ts (sandboxesEnabled, sandboxProviderConfigured)",
    ),
  };

  // ── Run gate ───────────────────────────────────────────────────────────────
  const gateReason = opencodeGateReason({
    deniedTools: inputs.deniedTools,
    journal: { kind: journalKind },
  });
  const gate: Record<string, ConfigRow> = {
    journalKind: row(journalKind, "run-session.ts journal.kind (a UI/API prompt)"),
    unattendedKind: row(
      isUnattendedKind(baseJournalKind(journalKind)),
      "opencode-policy.ts isUnattendedKind",
      {
        note:
          "the run KIND only. An interactive resume of an automation-owned session is " +
          "kind \"prompt\" yet runs under the unattended tool policy — see tools.unattended",
      },
    ),
    allowed: row(gateReason === null, "opencode-policy.ts opencodeGateReason (deny by default)"),
    reason: row(gateReason, "opencode-policy.ts opencodeGateReason"),
  };

  // ── Engine + model ─────────────────────────────────────────────────────────
  const explicit = explicitEngineFor(requestedModel);
  const engineKey = modelEngineKey(requestedModel);
  const perModelDefault = modelEngineDefault(engineKey);
  const preset =
    dialPreset(requestedModel) ??
    orchestratorPreset(requestedModel) ??
    resolveWorkspaceModelPreset(requestedModel, session.workspaceId);
  const engineSource =
    explicit && explicit !== "opencode"
      ? `explicit "${explicit}/" prefix on the session's model id`
      : perModelDefault && perModelDefault !== "opencode"
        ? `${enginesConfigPath()} modelEngines["${engineKey}"]`
        : "default engine (opencode)";

  const model: Record<string, ConfigRow> = {
    requested: row(requestedModel, session.model ? "session file model" : "instance interactive default (models.ts interactiveDefaultModel)"),
    engine: row(routed.engine, `models.ts routeModel — ${engineSource}`),
    dispatchModel: row(routed.model, "models.ts routeModel"),
    provider: row(providerID ?? null, "opencode-policy.ts parseOpencodeModel"),
    preset: row(
      preset ? { id: requestedModel, label: (preset as { label?: string }).label, mainModel: preset.model } : null,
      "models.ts dialPreset / orchestratorPreset / workspace-model-presets.ts",
    ),
    effort: row(session.effort ?? null, "session file effort (composer pill)"),
    fastMode: row(session.fastMode ?? false, "session file fastMode"),
    fallbackModel: row(
      interactiveFallbackModel(session.model) ?? null,
      "models.ts interactiveFallbackModel",
      { note: "used only when the primary model runs out of usage" },
    ),
    supportsSteer: row(modelSupportsSteer(requestedModel), "models.ts modelSupportsSteer"),
    accountPool: row(accountProviderForModel(requestedModel) ?? null, "models.ts accountProviderForModel"),
  };

  // ── Bridge account ─────────────────────────────────────────────────────────
  const bridgeCfg = readOpencodeBridgeConfig();
  const bridgeMode = providerID === "anthropic" ? (bridgeCfg?.enabled ? bridgeCfg.bridgeMode : "off") : null;
  const account: Record<string, ConfigRow> = {
    bridgeMode: row(bridgeMode, "~/.opensession-opencode.json (opencode-config.ts readOpencodeBridgeConfig)"),
    pinned: row(
      session.accountId ? { id: session.accountId, name: getAccountById(session.accountId)?.name ?? null } : null,
      "session file accountId (soft pin — an unusable pin falls back to the pool)",
    ),
  };
  if (bridgeMode === "meridian" && parsed) {
    const sessionKey = session.id;
    const sticky = stickyMeridianAccountFor(sessionKey, session.opencodeSessionId);
    const out: { reason?: string } = {};
    const picked = pickMeridianAccount(
      inputs.user,
      meridianRequiredModels(parsed.modelID, dialPreset(requestedModel)?.oracleAgent),
      bridgeCfg?.bridgeAccountIds,
      session.accountId,
      undefined,
      sticky,
      out,
      false, // peek: never record the pick from a GET
    );
    account.sticky = row(
      sticky ? { id: sticky, name: getAccountById(sticky)?.name ?? null } : null,
      "opencode-runner.ts stickyMeridianAccounts → db-map.json (survives a restart)",
      { stability: "load-dependent" },
    );
    account.predicted = row(
      "error" in picked
        ? { error: picked.error }
        : { id: picked.id, name: picked.name, reason: out.reason },
      "opencode-runner.ts pickMeridianAccount (peeked, recordPick: false)",
      {
        stability: "load-dependent",
        note:
          "resolved against every model the turn may need (a dial preset's oracle included). " +
          "A near-limit steer or a dry pool can still move the real turn to another account.",
      },
    );
    account.requiredModels = row(
      meridianRequiredModels(parsed.modelID, dialPreset(requestedModel)?.oracleAgent),
      "opencode-runner.ts meridianRequiredModels",
      { note: "an account must have allowance for all of these to be picked" },
    );
    account.poolDryReason = row(
      claudePoolDryReason(
        { user: inputs.user, accountId: session.accountId, journal: { kind: journalKind } },
        routed.model,
      ),
      "opencode-runner.ts claudePoolDryReason",
      {
        stability: "load-dependent",
        note:
          "the dispatch-time circuit, which considers the MAIN model only — a preset whose " +
          "oracle model is exhausted fails in `predicted` while this stays null",
      },
    );
    account.bridgeTag = row(
      "error" in picked ? null : `anthropic-${picked.id}`,
      "opencode-runner.ts bridgeTag (part of the shared-server pool key)",
      { stability: "load-dependent" },
    );
  }

  // ── MCP ────────────────────────────────────────────────────────────────────
  const grantUsers = [inputs.mcpGrantUser, inputs.user];
  const scopeSourceText =
    inputs.mcpServersSource === "automation"
      ? `automation "${session.automation}" recipe allowlist (automations.ts automationMcpServersByName)`
      : inputs.mcpServersSource === "session"
        ? "session file mcpServers (stamped at create time)"
        : inputs.mcpServersSource === "feed"
          ? "feed project descriptor (feeds.ts feedMcpServersForRefs)"
          : "no allowlist — every configured server this user may see";
  const inProcess = await inProcessServerNames(session, inputs);
  const mcp = {
    scope: row<string[] | "all">(inputs.mcpServers ?? "all", `session-run-inputs.ts — ${scopeSourceText}`),
    servers: describeMcpServers(inputs.mcpServers, inputs.user, grantUsers),
    inProcess: {
      branch: row(
        inputs.inProcessMcpBranch,
        "session-run-inputs.ts sessionInProcessMcpBranch (interactive-mcp.ts is withheld from automation-owned sessions)",
      ),
      servers: row(inProcess, "interactive-mcp.ts interactiveMcpServers / automations.ts selfImproveMcpForSession"),
      sharedEligibleServers: row(
        inProcess.filter((n) => SHARED_INPROCESS_SERVERS.includes(n)),
        "opencode-policy.ts SHARED_INPROCESS_SERVERS",
        {
          note: "an in-process server outside this list forces a per-session engine server",
        },
      ),
    },
  };

  // ── Tool policy ────────────────────────────────────────────────────────────
  const policy = opencodeRunPolicy({
    deniedTools: inputs.deniedTools,
    confirmTools: STRIPE_CONFIRM_TOOLS,
    journalKind,
  });
  const tools: Record<string, ConfigRow> = {
    unattended: row(
      policy.unattended,
      "opencode-policy.ts opencodeRunPolicy (an automation kind, or any run carrying deniedTools)",
    ),
    stripped: row(
      describeStrippedTools(policy, inputs.deniedTools, STRIPE_CONFIRM_TOOLS),
      "opencode-policy.ts opencodeRunPolicy.disables",
      { note: "stripped from the model's tool list, not merely refused at call time" },
    ),
    disabledIds: row(Object.keys(policy.disables).sort(), "opencode-policy.ts opencodeRunPolicy.disables"),
    bashPolicy: row(
      session.mode === "ask"
        ? "ASK_BASH_PERMISSIONS (read-only allowlist)"
        : isUnattendedKind(baseJournalKind(journalKind))
          ? "every command asks, answered by the org-floor command policy"
          : "unrestricted",
      "runner-shared.ts ASK_BASH_PERMISSIONS / command-policy.ts (unattended code runs)",
      { stability: "static" },
    ),
  };

  // ── Oracle / worker agents ─────────────────────────────────────────────────
  const bridgeProvider = providerID || "anthropic";
  const agents: Record<string, ConfigRow> = {
    oracles: row(
      Object.keys(DIAL_ORACLE_AGENTS).map((name) => {
        const effective = sameBridgeDialOracle(name, bridgeProvider);
        return {
          agent: name,
          resolvesTo: effective,
          model: DIAL_ORACLE_AGENTS[effective]?.model,
        };
      }),
      "models.ts DIAL_ORACLE_AGENTS + sameBridgeDialOracle (opencode-runner.ts dialOracleAgentConfigs)",
      {
        stability: "static",
        note: "registered on every engine server, whatever the session's preset — a cross-bridge oracle resolves to its same-bridge alternate",
      },
    ),
    orchestratorWorkers: row(
      Object.keys(ORCHESTRATOR_WORKER_AGENTS)
        .map((name) => ({ agent: name, model: orchestratorWorkerForBridge(name, bridgeProvider)?.model }))
        .filter((w) => !!w.model),
      "models.ts ORCHESTRATOR_WORKER_AGENTS + orchestratorWorkerForBridge",
      { stability: "static" },
    ),
    activePreset: row(
      dialPreset(requestedModel)
        ? { kind: "dial", oracle: sameBridgeDialOracle(dialPreset(requestedModel)!.oracleAgent, bridgeProvider) }
        : orchestratorPreset(requestedModel)
          ? { kind: "orchestrator", workers: orchestratorPreset(requestedModel)!.workerAgents }
          : null,
      "models.ts dialPreset / orchestratorPreset",
    ),
  };

  // ── Memory ─────────────────────────────────────────────────────────────────
  const memoryScopes = sessionMemoryScopes({ user: inputs.user, repos: sessionRepoIds(session) });
  const memory: Record<string, ConfigRow> = {
    injected: row(
      inputs.sessionNote,
      "run-session.ts reposNote (buildSessionNote → memoryNoteFor)",
      {
        note: inputs.sessionNote
          ? "read into the system prompt; the write tools ride opensession-memory"
          : "automation-owned session: no memory note, and no memory write tools",
      },
    ),
    scopes: row(
      inputs.sessionNote ? memoryScopes.map((s) => ({ key: s.key, kind: s.kind, label: s.label })) : [],
      "session-memory.ts sessionMemoryScopes (~/.opensession-memory/<key>.json)",
    ),
  };

  // ── Engine server placement ────────────────────────────────────────────────
  const inProcessMap = Object.fromEntries(inProcess.map((n) => [n, true]));
  const eligible = sharedOpencodeEligible({
    journal: { kind: journalKind, osSessionId: session.id },
    mcpServers: inputs.mcpServers ?? "all",
    mcpGrantUser: inputs.mcpGrantUser,
    user: inputs.user,
    inProcessMcp: inProcessMap,
  });
  const compactCerebras = providerID === "cerebras";
  const shared = eligible && !compactCerebras;
  const githubLogin =
    !policy.unattended ? githubUserLoginForRun(inputs.user || commitAuthorFor(inputs.user, session.startedBy)?.name) : null;
  const nonSharedReason = compactCerebras
    ? "cerebras runs stay on a compact per-session server (30k input tokens/minute tier limit)"
    : inputs.mcpServers
      ? "the run carries an explicit MCP allowlist, which is enforced at engine-config level"
      : inputs.mcpGrantUser && !userMatchesAny(inputs.mcpGrantUser, [inputs.user || ""])
        ? "the session's creator differs from the prompter, so its OAuth grants stay on a private server"
        : inProcess.some((n) => !SHARED_INPROCESS_SERVERS.includes(n))
          ? `in-process server(s) outside SHARED_INPROCESS_SERVERS: ${inProcess.filter((n) => !SHARED_INPROCESS_SERVERS.includes(n)).join(", ")}`
          : "not an interactive run kind";
  // The pool key bakes in the bridge account, so it is only knowable once the
  // account is. "plain" is the runner's own tag for a provider with no
  // subscription bridge (a plain API key); an anthropic run whose account did
  // not resolve has no key to predict, and saying "plain" there would be a lie.
  const bridgeTag = "bridgeTag" in account ? (account.bridgeTag!.value as string | null) : "plain";
  const placement: Record<string, ConfigRow> = {
    shared: row(shared, "opencode-policy.ts sharedOpencodeEligible", {
      stability: "load-dependent",
      note: shared
        ? "multiplexes onto the always-warm (bridge account × user) server"
        : nonSharedReason,
    }),
    serverKey: row(
      !shared
        ? session.id
        : bridgeTag
          ? sharedServerKey(bridgeTag, inputs.user, githubLogin)
          : null,
      "opencode-policy.ts sharedServerKey (shared) / session id (per-session)",
      {
        stability: "load-dependent",
        ...(shared && !bridgeTag
          ? { note: "unresolved — the bridge account this key is built from did not resolve" }
          : {}),
      },
    ),
    externalMcpAtConfigLevel: row(
      shared ? "all" : (inputs.mcpServers ?? "all"),
      "opencode-runner.ts buildOpencodeMcpConfig(shared ? \"all\" : mcpServers)",
      {
        note: shared
          ? "a shared server's config carries every server this user may see; the run's own narrowing rides the per-prompt tools list"
          : "the allowlist is enforced in this server's own config",
      },
    ),
    engineSessionId: row(
      session.opencodeSessionId || session.claudeSessionId || session.codexThreadId || session.piSessionId || null,
      "session file engine session id — what the next turn resumes",
    ),
  };

  // ── Identity ───────────────────────────────────────────────────────────────
  const author = commitAuthorFor(inputs.user, session.startedBy);
  const identity: Record<string, ConfigRow> = {
    runUser: row(
      inputs.user ?? null,
      "session-run-inputs.ts (automation-owned sessions pass no user, so allowedUsers servers stay invisible)",
    ),
    mcpGrantUser: row(inputs.mcpGrantUser ?? null, "session file startedBy — whose OAuth grants MCP calls use"),
    githubLogin: row(
      githubLogin,
      "github-auth.ts githubUserLoginForRun",
      { note: githubLogin ? "the run carries this person's GitHub token" : "the run uses the instance's bot credential" },
    ),
    commitAuthor: row(author ?? null, "shared/user-mappings.ts commitAuthorFor"),
    prReviewer: row(
      inputs.isAutomationSession && session.automationId
        ? (getAutomation(session.automationId)?.prReviewer ?? null)
        : null,
      "automations.ts automation.prReviewer",
    ),
  };

  // ── Instructions ───────────────────────────────────────────────────────────
  const localInstructions = readLocalInstructions(session.worktreeDir || undefined);
  const instructions: Record<string, ConfigRow> = {
    channel: row(
      shared ? "per-prompt system parameter" : "per-session instructions file",
      "opencode-runner.ts (a shared server's config is multi-session)",
    ),
    sources: row(
      [
        "run-instructions.ts buildRunInstructions",
        ...(inputs.sessionNote ? ["session-repos.ts buildSessionNote (repos + branch + memory + personal prompt)"] : []),
        ...(session.presetNote ? ["session file presetNote (workspace model preset)"] : []),
        ...(localInstructions ? [`${session.worktreeDir}/AGENTS.local.md or CLAUDE.local.md`] : []),
      ],
      "opencode-runner.ts instructions composition",
      { note: "contents are deliberately not returned — instance-local files are private" },
    ),
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
    caveat:
      "A forecast of the next turn, not a contract: rows marked load-dependent " +
      "(account pick, shared-server placement) are re-resolved at dispatch, and " +
      "the model fallback graph can move a run off its first choice mid-turn.",
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
  if (!opts.verbose) {
    // The full ask-bash table is static and long; only a verbose read wants it.
    return doc;
  }
  const { ASK_BASH_PERMISSIONS } = await import("./runner-shared");
  doc.tools.bashPolicyRules = row(
    session.mode === "ask" ? ASK_BASH_PERMISSIONS : null,
    "runner-shared.ts ASK_BASH_PERMISSIONS",
    { stability: "static" },
  );
  return doc;
}
