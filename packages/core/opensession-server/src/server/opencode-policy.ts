/**
 * OpenCode run policy — extracted verbatim from opencode-runner.ts so the
 * policy layer can be depended on without pulling in the 6k-line runner
 * (pi-runner imports from here directly; opencode-runner re-exports every
 * public symbol so docs and security notes referencing its old home stay
 * valid). SECURITY-SENSITIVE: this module owns the engine's run gating and
 * tool stripping —
 *  - model-id parsing (`opencode/<provider>/<model>`),
 *  - run kinds: INTERACTIVE_KINDS vs unattended (isUnattendedKind /
 *    baseJournalKind) and the deny-by-default engine gate
 *    (opencodeGateReason),
 *  - the unattended least-privilege policy (opencodeRunPolicy /
 *    opencodeDeniedToolIds): denied/confirm tools stripped from the model's
 *    tool list,
 *  - shared always-warm server eligibility (sharedOpencodeEligible /
 *    SHARED_INPROCESS_SERVERS / sharedServerKey),
 *  - MCP config builders (buildOpencodeMcpConfig and the in-process
 *    proxy/remote shapes) and readLocalInstructions.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { filterMcpServers, type McpScope } from "./runner-shared";
import { userMatchesAny } from "./shared/user-mappings";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { BUN_BIN, MCP_PROXY_ENTRY, mcpHttpUrl, rpcSocketPath } from "./run-rpc-protocol";
import { hasMcpOauthGrantForUsers } from "./mcp-oauth";
import { mcpHttpServerActive } from "./run-rpc";

export const OPENCODE_MODEL_PREFIX = "opencode/";

/** Split `opencode/<provider>/<model>` (model may itself contain slashes). */
export function parseOpencodeModel(
  model: string
): { providerID: string; modelID: string } | null {
  if (!model.startsWith(OPENCODE_MODEL_PREFIX)) return null;
  const rest = model.slice(OPENCODE_MODEL_PREFIX.length);
  const sep = rest.indexOf("/");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { providerID: rest.slice(0, sep), modelID: rest.slice(sep + 1) };
}

// ── Run gate + unattended least-privilege policy ─────────────────────────────

/** Journal kinds minted by trusted interactive paths (opensession.ts:
 *  runSessionPromptInner "prompt", goal wakes "goal", both create paths
 *  "create"; host/sandbox run specs default `journalKind || "prompt"`).
 *  "linear" and "slack" are the team-driven agent loops — trusted humans on
 *  the other end; their runs still pass the Stripe money-movers as
 *  deniedTools, which flips them to the unattended tool-strip policy.
 *  "workflow" is workflow fan-out agents — only launchable from interactive
 *  sessions (the opensession-workflows MCP is interactive-only), so they
 *  inherit interactive trust; ask mode + no MCP servers keeps them read-only
 *  workers, and staying interactive keeps them shared-server eligible (no
 *  per-agent `opencode serve` — the 2026-07-09 SQLite contention trap). */
export const INTERACTIVE_KINDS = new Set(["prompt", "goal", "create", "linear", "slack", "workflow"]);

/** Unattended kinds allowed on this engine — with the least-privilege policy
 *  (opencodeRunPolicy) enforced via stripped tools. "automation" is the
 *  automations engine; "plain" is the Plain support agent (untrusted ticket
 *  text); "action" is the retired Actions feature, kept so an old action
 *  session resumed from the store still passes this gate; "security-scan" the security
 *  sweep; github-* the PR behaviors (review/auto-fix/simplify — headless,
 *  no approval card). Runs with no journal kind at all stay fail-closed
 *  (deny by default). */
const AUTOMATION_KINDS = new Set(["automation", "plain", "action", "security-scan"]);

export function isUnattendedKind(base: string): boolean {
  return AUTOMATION_KINDS.has(base) || base.startsWith("github-");
}

/** Dry-pool queueing budget per run kind. Unattended runs have no human
 *  staring at a spinner, so instead of aborting the instant every account is
 *  at its usage limit (the 2026-07-14 cascade) they wait for the pool to
 *  free. Interactive runs keep failing fast into agent-runner's
 *  model-fallback graph — a queued wait there just looks like a hang. */
const POOL_WAIT_UNATTENDED_MS = Number(
  process.env.OPENSESSION_POOL_WAIT_MS || 10 * 60_000
);

export function poolWaitMsFor(kind?: string): number {
  return isUnattendedKind(baseJournalKind(kind)) ? POOL_WAIT_UNATTENDED_MS : 0;
}

export function baseJournalKind(kind?: string): string {
  return (kind || "").replace(/(-(resume|rerun|fallback))+$/, "");
}

// ── Shared always-warm server eligibility ────────────────────────────────────

/** The in-process (proxy) MCP servers a SHARED server's config lists — the
 *  union of what interactive runs carry (interactiveMcpServers in
 *  opensession.ts, plus the Slack loop's opensession-github). A run whose
 *  inProcessMcp names aren't a subset of this list falls back to a
 *  per-session server (see sharedOpencodeEligible), so adding a new
 *  in-process server elsewhere degrades gracefully (that session just stops
 *  sharing) until the name is added here. opensession-goal-self is deliberately
 *  NOT listed: its tool set exists only for goal sessions, and the MCP tool
 *  list is discovered once per directory instance — a goal session could
 *  cache an empty list. Goal wakes keep per-session servers. */
export const SHARED_INPROCESS_SERVERS = [
  "opensession-sessions",
  "opensession-admin",
  "opensession-goals",
  "opensession-humans",
  "opensession-keychain",
  "opensession-publish",
  "opensession-repos",
  "opensession-memory",
	"opensession-portals",
  "opensession-web",
  "opensession-walkthrough",
  "opensession-slack",
  "opensession-ask",
  "opensession-github",
  "opensession-papercuts",
  "opensession-workflows",
  "opensession-self-deploy",
  "opensession-assets",
  "opensession-search",
  "opensession-todos",
	"opensession-runners",
];

/**
 * May this run multiplex onto a shared always-warm server? Shared servers
 * hold ONE config for many sessions, so everything per-run must ride the
 * per-prompt channels (model/system/agent/tools — all verified live
 * 2026-07-09 on opencode 1.17.15). Runs that need per-server config stay on
 * per-session servers:
 *  - non-interactive kinds (automations & friends): their least-privilege MCP
 *    allowlist is enforced at the CONFIG level and must stay that way for
 *    untrusted-text runs;
 *  - any run carrying an explicit mcpServers ALLOWLIST (e.g. an interactive
 *    resume of an automation session) — same reason. `"all"` is not an
 *    allowlist: it is the wide default every pooled interactive run gets, so
 *    it stays eligible (this check predates McpScope, when "all" was spelled
 *    `undefined` — reading it as a restriction would empty the shared pool);
 *  - runner-host runs whose inProcessMcp arrived as prebuilt stdio proxies
 *    (their rpc token is baked into the proxy env, one per run spec);
 *  - runs carrying an in-process server outside SHARED_INPROCESS_SERVERS
 *    (goal wakes with opensession-goal-self, future additions).
 */
export function sharedOpencodeEligible(opts: {
  journal?: { kind?: string; osSessionId?: string };
  mcpServers?: McpScope;
  /** Session creator whose OAuth grants take precedence for MCP calls. */
  mcpGrantUser?: string;
  /** Current prompter; determines the shared server's user-scoped config. */
  user?: string;
  inProcessMcp?: Record<string, unknown>;
  /** Test-only override (scripts/verify-shared-opencode.ts) for direct
   *  runOpencode calls that pass no journal. Never set from request or
   *  automation data. */
  forceSharedServer?: boolean;
}): boolean {
  const base = baseJournalKind(opts.journal?.kind);
  if (!INTERACTIVE_KINDS.has(base) && opts.forceSharedServer !== true) return false;
  if (opts.mcpServers && opts.mcpServers !== "all") return false;
  // HTTP MCP grants are baked into the engine server config. A session shared
  // by someone else must keep its creator's identity on a per-session server
  // instead of draining the prompter's shared server on every turn.
  if (opts.mcpGrantUser && !userMatchesAny(opts.mcpGrantUser, [opts.user || ""])) return false;
  const inprocNames = Object.keys(opts.inProcessMcp || {});
  if (inprocNames.length && opencodeMcpFromPrebuiltProxies(opts.inProcessMcp) !== null) {
    return false;
  }
  return inprocNames.every((n) => SHARED_INPROCESS_SERVERS.includes(n));
}

/** Pool key for a shared server: the (bridge account × user × GitHub auth) tuple that is
 *  baked into the server's spawn env/config and therefore cannot vary
 *  per-prompt. bridgeTag pins the provider auth (meridian account /
 *  seeded-openai account / native bridge / plain API-key providers); the user
 *  pins the per-user external-MCP view (allowedUsers via filterMcpServers)
 *  and the git identity env. Runs using the service GitHub credential keep the
 *  legacy key; an authenticated user's token gets its own pool. */
export function sharedServerKey(
  bridgeTag: string,
  user?: string,
  githubLogin?: string | null,
): string {
  const u = (user || "anon").toLowerCase().replace(/[^a-z0-9@._-]/g, "_");
  const gh = githubLogin
    ? `:github-${githubLogin.toLowerCase().replace(/[^a-z0-9._-]/g, "_")}`
    : "";
  return `shared:${bridgeTag}:${u}${gh}`;
}

/** Non-null = the reason this run may not use the opencode engine. */
export function opencodeGateReason(opts: {
  deniedTools?: Record<string, string>;
  journal?: { kind?: string };
  /** Explicit trusted-caller marker (scripts/verify-opencode.ts) for direct
   *  runOpencode calls that deliberately pass no journal. Never set this from
   *  request/automation data. */
  allowOpencode?: boolean;
}): string | null {
  if (opts.allowOpencode === true) return null;
  const base = baseJournalKind(opts.journal?.kind);
  if (INTERACTIVE_KINDS.has(base) || isUnattendedKind(base)) return null;
  return base
    ? `The opencode engine is not available to "${base}" runs — interactive sessions and automations only.`
    : "The opencode engine requires an explicit run kind (journal.kind) — " +
        "deny by default; interactive sessions and automations only.";
}

/** How a run's deniedTools/confirmTools are enforced on this engine. */
export interface OpencodeRunPolicy {
  /** Unattended least-privilege run: automation kind, or any run carrying
   *  deniedTools (interactive resumes of automation sessions included). */
  unattended: boolean;
  /** OpenCode `tools` config entries stripping every denied tool (and, on
   *  unattended runs, every confirm tool) from the model's tool list. */
  disables: Record<string, false>;
  /** Denied-tool guidance for the instructions file, grouped by message. */
  noteGroups: Array<{ message: string; tools: string[] }>;
}

/** Built-ins that resolve against the `opencode serve` process's local cwd.
 * Engine-outside-sandbox runs must never see them: their real workspace is
 * reachable only through opensession-workspace. Keep aliases in the strip set
 * as OpenCode's edit surface has used both patch/apply_patch across versions. */
export const LOCAL_WORKSPACE_TOOL_IDS = [
  "bash",
  "read",
  "write",
  "edit",
  "patch",
  "apply_patch",
  "grep",
  "glob",
] as const;

/** Claude-style tool name (mcp__<server>__<tool>) → the ids OpenCode's `tools`
 *  config must disable. `<server>_<tool>` is OpenCode's MCP tool naming
 *  (verified live 2026-07-09, opencode 1.17.15 + the stripe MCP →
 *  `stripe_create_refund`). The `*_<tool>` wildcard and bare `<tool>` forms
 *  guard a future naming-scheme change, but they also strip SAME-NAMED tools
 *  of other servers (2026-07-26: `*_reply_to_thread` from the Plain deny-set
 *  silently removed slack_reply_to_thread from every automation run, breaking
 *  threaded Slack reporting) — so they're reserved for `broad` entries (the
 *  money-moving confirm tools), where over-blocking is the right trade.
 *  Server-scoped denies rely on the exact id, the pinned engine version, and
 *  the auto-reject permission backstop. Non-MCP names pass through verbatim. */
export function opencodeDeniedToolIds(name: string, opts?: { broad?: boolean }): string[] {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return [name];
  if (opts?.broad) return [`${m[1]}_${m[2]}`, `*_${m[2]}`, m[2]];
  return [`${m[1]}_${m[2]}`];
}

/**
 * The engine-level enforcement of a run's deny/confirm tool sets — the same
 * lists claude-runner enforces in canUseTool, mapped onto OpenCode's `tools`
 * config (stripped tools never reach the model's tool list; a misconfigured
 * name additionally lands on the auto-reject permission backstop).
 *
 * Confirm tools fold into the strip-set on EVERY run — there is no per-call
 * approval bridge on this engine, so the money-movers are simply never in the
 * model's tool list, while the server's read tools stay available (the Stripe
 * restricted key enforces the write ceiling server-side regardless). Only the
 * guidance differs: unattended runs get claude-runner's `confirm_unattended`
 * wording ("post the proposed action in the internal note"), interactive runs
 * are told to ask the human in the session. Until 2026-07-26 interactive runs
 * instead dropped the whole server fail-closed — which blanked Stripe READS
 * in every interactive dispute-investigation run for no security gain.
 */
export function opencodeRunPolicy(opts: {
  deniedTools?: Record<string, string>;
  confirmTools?: Record<string, string>;
  journalKind?: string;
  disableLocalWorkspaceTools?: boolean;
}): OpencodeRunPolicy {
  // OpenCode's native `question` tool waits for its own TUI to answer. Our
  // engine runs headlessly and exposes opensession-ask instead, which routes
  // through the session question card. Leaving both visible lets the model
  // choose the native tool and wedge the turn with raw JSON in the transcript.
  const disables: Record<string, false> = { question: false };
  if (opts.disableLocalWorkspaceTools) {
    for (const name of LOCAL_WORKSPACE_TOOL_IDS) disables[name] = false;
  }
  const denied = opts.deniedTools || {};
  const unattended =
    Object.keys(denied).length > 0 || isUnattendedKind(baseJournalKind(opts.journalKind));
  const merged: Record<string, string> = { ...denied };
  // Money-movers get the broad (wildcard) strip even when a deniedTools
  // message wins the wording for the same name.
  const broadNames = new Set(Object.keys(opts.confirmTools || {}));
  for (const [name, label] of Object.entries(opts.confirmTools || {})) {
    if (!(name in merged)) {
      merged[name] = unattended
        ? `"${label}" requires per-call human approval, and this run is unattended. ` +
          "This tool is not available; post the exact action you want taken (tool name and " +
          "full parameters, including amounts and IDs) in your internal note and ask a human " +
          "to review and execute it."
        : `"${label}" requires per-call human approval, which this engine cannot collect. ` +
          "This tool is not available; state the exact action you want taken (tool name and " +
          "full parameters, including amounts and IDs) in your reply and ask the human in " +
          "this session to execute it themselves.";
    }
  }
  const byMessage = new Map<string, string[]>();
  for (const [name, message] of Object.entries(merged)) {
    for (const id of opencodeDeniedToolIds(name, { broad: broadNames.has(name) }))
      disables[id] = false;
    const group = byMessage.get(message);
    if (group) group.push(name);
    else byMessage.set(message, [name]);
  }
  return {
    unattended,
    disables,
    noteGroups: [...byMessage.entries()].map(([message, tools]) => ({ message, tools })),
  };
}

/**
 * Map our mcp-config.json (filtered by the per-automation allowlist AND the
 * per-user allowedUsers gate — both via filterMcpServers, the same helper the
 * Claude runner enforces with) onto OpenCode's `mcp` config shape. Servers
 * carrying confirm-listed (money-moving) tools stay mounted — those tools are
 * stripped from the model's tool list via opencodeRunPolicy instead.
 */
export function buildOpencodeMcpConfig(
  scope: McpScope,
  user: string | undefined,
  /** Identities consulted only to decide whether a server is already supplied
   *  by a coordinator-side proxy. It never selects a personal credential and
   *  never widens `allowedUsers`: both of those are the prompter's alone, so
   *  prompting someone else's session can never spend their token. */
  grantUsers?: Array<string | undefined>,
): { mcp: Record<string, Record<string, unknown>> } {
  const filtered = filterMcpServers(scope, user, grantUsers) as Record<string, any>;
  const mcp: Record<string, Record<string, unknown>> = {};
  for (const [name, cfg] of Object.entries(filtered)) {
    // Granted HTTP and stdio servers are both supplied by the coordinator-side
    // proxy. Never double-mount the workspace-configured connection.
    if (hasMcpOauthGrantForUsers(name, grantUsers ?? [user])) continue;
    if (cfg.type === "http" || cfg.type === "sse" || cfg.url) {
      // OAuth-granted servers are mounted through run-rpc as server-side
      // proxies (mcp-oauth-proxy.ts). Never put provider credentials or a
      // durable relay bearer into the engine's model-visible config.
      mcp[name] = {
        type: "remote",
        url: cfg.url,
        ...(cfg.headers ? { headers: cfg.headers } : {}),
        // Our headers carry the auth; don't let OAuth auto-detection interfere.
        oauth: false,
        enabled: true,
        timeout: 30_000,
      };
    } else if (cfg.command) {
      mcp[name] = {
        type: "local",
        command: [cfg.command, ...((cfg.args as string[]) || [])],
        ...(cfg.env ? { environment: cfg.env } : {}),
        enabled: true,
        timeout: 30_000,
      };
    }
  }
  return { mcp };
}

/** OpenCode applies `mcp.<name>.timeout` to tool CALLS, not just the tools
 *  fetch its doc comment mentions. Blocking tools on the opensession proxies
 *  (ask_human mode=block, ask_user) legitimately wait up to run-rpc.ts's
 *  30-minute per-call ceiling, and mcp-proxy retries to 32 — at the previous
 *  60s a blocking ask on an opencode-engine session was GUARANTEED to die
 *  with MCP -32001 while the teammate's answer landed on a dead request
 *  (seen live: a human answered an SSO-approval ask and the session never
 *  saw it). Sit just above the whole chain. */
const PROXY_MCP_TIMEOUT_MS = 33 * 60_000;

/** In-process opensession-* servers, exposed as stdio proxies that forward to the
 *  opensession process over the run-rpc socket — the exact pattern Codex uses
 *  (codex-runner proxyMcpConfigs), in OpenCode's config shape. */
export function proxyOpencodeMcpConfigs(
  inProcessMcp: Record<string, unknown> | undefined,
  rpcToken: string | undefined
): Record<string, Record<string, unknown>> {
  if (!inProcessMcp || !rpcToken) return {};
  // This participates in the OpenCode server config hash. Adding a proxy must
  // replace shared servers whose per-directory tool catalog is already cached.
  const catalog = Object.keys(inProcessMcp).sort().join(",");
  const out: Record<string, Record<string, unknown>> = {};
  for (const name of Object.keys(inProcessMcp)) {
    out[name] = {
      type: "local",
      // --smol: the proxy is a pure stdio↔RPC pipe; Bun's low-memory heap
      // profile roughly halves its RSS, and hundreds of these run at once
      // (16 opensession-* servers × every session instance — 664 processes /
      // 42GB RSS on 2026-07-27).
      command: [BUN_BIN, "--smol", "run", MCP_PROXY_ENTRY],
      environment: {
        OPENSESSION_RPC_SOCKET: rpcSocketPath(OPENSESSION_SESSIONS_DIR),
        OPENSESSION_RPC_TOKEN: rpcToken,
        OPENSESSION_MCP_SERVER: name,
        OPENSESSION_MCP_CATALOG: catalog,
      },
      enabled: true,
      timeout: PROXY_MCP_TIMEOUT_MS,
    };
  }
  return out;
}

/** The same in-process servers as `type:"remote"` streamable-HTTP entries
 *  against run-rpc's loopback listener — zero subprocesses instead of one
 *  ~64MB bun per server per instance. Same token, same dispatch core, and the
 *  session-tag plugin's arg injection is transport-agnostic, so shared-server
 *  routing is unchanged. Sandbox/runner-host runs never reach this (their
 *  prebuilt stdio proxies pass through above — inside a container
 *  127.0.0.1 isn't opensession). */
export function remoteOpencodeMcpConfigs(
  inProcessMcp: Record<string, unknown> | undefined,
  rpcToken: string | undefined
): Record<string, Record<string, unknown>> {
  if (!inProcessMcp || !rpcToken) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const name of Object.keys(inProcessMcp)) {
    out[name] = {
      type: "remote",
      url: mcpHttpUrl(name),
      headers: { authorization: `Bearer ${rpcToken}` },
      oauth: false,
      enabled: true,
      timeout: PROXY_MCP_TIMEOUT_MS,
    };
  }
  return out;
}

/** Host-local in-process MCP shape chooser. Remote/HTTP is the default; the
 *  stdio proxy fleet remains as kill switch (OPENSESSION_MCP_REMOTE=0) and as
 *  automatic fallback when the loopback listener failed to bind. Either
 *  direction changes the server config hash → shared servers drain-respawn
 *  onto the new shape gracefully. */
export function inProcessOpencodeMcpConfigs(
  inProcessMcp: Record<string, unknown> | undefined,
  rpcToken: string | undefined
): Record<string, Record<string, unknown>> {
  if (process.env.OPENSESSION_MCP_REMOTE !== "0" && mcpHttpServerActive()) {
    return remoteOpencodeMcpConfigs(inProcessMcp, rpcToken);
  }
  return proxyOpencodeMcpConfigs(inProcessMcp, rpcToken);
}

/** Runner-host context (sandboxed and systemd-hosted runs): `inProcessMcp`
 *  arrives as ALREADY-BUILT stdio proxy configs (host.ts proxyMcpConfigs —
 *  command/args/env carrying the spec's HOST-registered rpc token and the
 *  right transport env, unix socket or rpc-ws). Pass those through verbatim:
 *  rebuilding them here would mint a fresh token the opensession process never
 *  registered (run-rpc auth lives there, not in this process) and point at
 *  BUN_BIN, a host path that doesn't exist inside a sandbox container.
 *  Returns null when the values are in-process SDK server instances (the
 *  backstage-process path) — the caller then builds its own proxies via
 *  proxyOpencodeMcpConfigs. */
export function opencodeMcpFromPrebuiltProxies(
  inProcessMcp: Record<string, unknown> | undefined
): Record<string, Record<string, unknown>> | null {
  const entries = Object.entries(inProcessMcp || {});
  if (!entries.length) return null;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, raw] of entries) {
    const cfg = raw as { command?: unknown; args?: unknown; env?: unknown };
    if (typeof cfg?.command !== "string") return null; // SDK instance → not prebuilt
    out[name] = {
      type: "local",
      command: [cfg.command, ...((Array.isArray(cfg.args) ? cfg.args : []) as string[])],
      ...(cfg.env ? { environment: cfg.env } : {}),
      enabled: true,
      timeout: PROXY_MCP_TIMEOUT_MS,
    };
  }
  return out;
}

/** Untracked instance-local instructions: `AGENTS.local.md` / `CLAUDE.local.md`
 *  at the session's working-directory root. OpenCode natively loads only the
 *  tracked AGENTS.md (findUp), so operator-private guidance — deployment
 *  hostnames, org access grants, incident history — would otherwise have to
 *  live in the tracked file. Both names are read (in that order) so either
 *  convention works; content is appended verbatim to the run's instructions. */
export function readLocalInstructions(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  const parts: string[] = [];
  for (const name of ["AGENTS.local.md", "CLAUDE.local.md"]) {
    const path = join(dir, name);
    try {
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf8").trim();
      if (text) parts.push(text);
    } catch {
      // Unreadable local file — never fail the run over optional instructions.
    }
  }
  return parts.length ? parts.join("\n\n") : undefined;
}
