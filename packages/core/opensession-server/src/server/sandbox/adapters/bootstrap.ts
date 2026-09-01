/**
 * bootstrap — shared runtime for the REMOTE sandbox adapters (Daytona, E2B;
 * docs/self-hosting-sandboxes.md). Everything here is provider-agnostic:
 * the adapters implement the small `RemoteDriver` wire (shell exec, detached
 * exec, file write, wake) and get, in return:
 *
 *  - `bootstrapRemoteSandbox`: remote sandboxes don't run our prebaked
 *    opensession-runner image, so first ensure installs the runner payload
 *    in-sandbox — bun, the opensession repo bundle (config `runnerBundleUrl`
 *    tarball, or a git clone of `runnerRepoUrl`/this checkout's origin at
 *    `runnerSha`), `bun install`, and the Claude Code CLI — all under
 *    /home/ubuntu so the runner's hardcoded absolute paths (claude CLI, repo
 *    bundle, HOST_ENTRY) resolve exactly like they do on the host and in the
 *    docker image (path parity is the contract; see deploy/sandbox/README.md).
 *    COLD-START COST: several minutes on the first ensure of a fresh sandbox
 *    (bun install pulls the full dep tree incl. the ~223MB vendored codex
 *    binary). The fast path — Daytona snapshots / E2B custom templates with
 *    the payload prebaked — is a documented follow-up, not built here; a
 *    `.bks-bootstrapped` marker makes every later ensure a no-op.
 *  - `setupRemoteWorkspace`: remote workspaces are ALWAYS volume-style — the
 *    repo is cloned INSIDE the sandbox from its https origin (never a host
 *    mount). Auth comes from config `cloneCredential` ({type:"none"} public /
 *    {type:"https-token", token} injected into the URL) — host git/ssh creds
 *    are never uploaded. Destroying the sandbox destroys the workspace: push
 *    your work (same contract as docker volume mode).
 *  - `makeRemoteSandbox` / `makeRemoteLauncher`: the Sandbox handle whose
 *    launchRun starts HOST_ENTRY in-sandbox with the WS-transport env — the
 *    sandbox dials back to `callbackBaseUrl`'s /run-ws route (there
 *    is no socket option remotely), and the opensession-* MCP proxies dial
 *    /rpc-ws. Run dirs use the SAME absolute path host-side and
 *    in-sandbox: spec.json is mirrored host-side (so restart-resume can
 *    re-register tokens), while meta/journal/log live only in the sandbox.
 *  - `resumeRemoteSandboxRun`: restart-resume mirroring the docker path —
 *    reattach to a still-alive in-sandbox host via its WS redial, or relaunch
 *    a continuation. One gap vs docker: meta.json isn't host-visible, so a
 *    run that ENDED while opensession was down is resumed as a continuation
 *    (engine session preserved) instead of having its terminal event
 *    consumed.
 *
 * Credential trust note: a SCOPED slice of `~/.opensession-claude-accounts.json`
 * (Claude OAuth pool) is uploaded into the sandbox per LAUNCH (not at
 * bootstrap): only the run's pinned account when spec.accountId is set, else
 * the shared pool accounts plus the run user's own personal accounts — never
 * another user's personal subscription (accountsForRemoteUpload,
 * claude-accounts.ts). That's deliberately narrower than the docker
 * provider's ro mount of the full store, because this is third-party compute;
 * a self-hoster who doesn't accept even the scoped upload runs these adapters
 * against their OWN Daytona/E2B deployment (both are self-hostable).
 * Automation launches use `trustProfile: "automation"`: one hard-pinned model
 * account, an explicit projected MCP allowlist, and no instance-wide config.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "fs";
import { dirname, isAbsolute, relative, resolve } from "path";
import { OPENSESSION_SESSIONS_DIR, homeDir, stateDir } from "../../paths";
import {
  journalSet,
  journalClear,
  journalClearIfLineage,
  journalRecordAbnormalCompletion,
  type ActiveRunRecord,
} from "../../run-journal";
import { shouldPersistModelSwitch, type StreamEvent } from "../../run-events";
import { recoveryKind, restartContinuationPrompt } from "../../agent-runner";
import {
  accountsForRemoteUpload,
  type ClaudeAccount,
} from "../../claude-accounts";
import { audit } from "../../audit";
import { authedRemoteUrl } from "../../codestorage/auth";
import { parseCsRemote } from "../../codestorage/remote";
import { redactUrl } from "../../shared/redact";
import { listCodexAccounts } from "../../codex-accounts";
import { readModelProviderConfig } from "../../model-providers";
import { normalizePiConfig, readPiEngineConfig } from "../../pi-config";
import {
  buildOpenaiRemoteSeedUpload,
  maskOpenaiAccount,
  openaiSeedAuthPath,
} from "../../openai-auth";
import {
  fallbackPlan,
  modelSupportsSteer,
  providerFor,
  toPiModel,
} from "../../models";
import { filterMcpServers } from "../../runner-shared";
import { GITHUB_RUN_AUTH_FILE_ENV, githubAuthEnv } from "../../github-auth";
import {
  appendTranscriptEntries,
  recordEngineSessionOwner,
  transcriptLineUser,
  transcriptLineRunnerNotice,
  transcriptLineAssistantText,
  transcriptLineToolUse,
  transcriptLineToolResult,
} from "../../transcript-persistence";
import { hostSteer, hostInterruptSteer, hostCancel } from "../../host-registry";
import { registerRunToken, unregisterRunToken } from "../../run-rpc";
import {
  registerRunWsHost,
  unregisterRunWsHost,
  runWsConnector,
} from "../../run-ws";
import { writeJsonAtomic } from "../../shared/atomic-write";
import {
  createWorkloadIdentityEnv,
  type WorkloadIdentityContext,
} from "../../workload-identity";
import {
  HostHandle,
  HostLaunchNotDispatchedError,
  reconcileUncertainHostEvents,
  type HandleCallbacks,
  type HostLauncher,
} from "../../host-client";
import {
  HOST_SPEC_NAME,
  HOST_META_NAME,
  HOST_JOURNAL_NAME,
  HOST_ENTRY,
  REPO_ROOT,
  type RunHostMeta,
  type RunHostSpec,
} from "../../../runner-host/protocol";
import { sandboxConfig, remoteSandboxCallbackBaseUrl } from "../config";
import { decideSandboxHostRecovery } from "../recovery";
import type {
  ExecOpts,
  ExecResult,
  PortMap,
  RunHandle,
  RunHandleCallbacks,
  Sandbox,
  SandboxProviderId,
  SandboxSessionSpec,
  SandboxStatus,
} from "../provider";

/** Absolute paths INSIDE the sandbox — kept byte-identical to the host/docker
 *  layout so the runner's hardcoded paths resolve (do not "tidy" these). */
export const REMOTE_HOME = "/home/ubuntu";
const REMOTE_BUN = `${REMOTE_HOME}/.bun/bin/bun`;
const REMOTE_BUNX = `${REMOTE_HOME}/.bun/bin/bunx`;
const REMOTE_MCP_CONFIG = `${REMOTE_HOME}/.opensession-mcp-config.json`;
/** Same pin as deploy/sandbox/Dockerfile's PI_VERSION (host runs this
 *  too) — bump BOTH together. Part of bootstrapSignature, so a bump
 *  invalidates existing sandboxes/prewarms and re-bootstraps them. */
/** Keep these aligned with deploy/sandbox/Dockerfile. The runtime revision is
 * part of bootstrapSignature, so changing this contract invalidates old
 * prewarms and provider templates instead of calling them Ready. */
const REMOTE_NODE_VERSION = "24.18.1";
const REMOTE_NODE_MAJOR = Number(REMOTE_NODE_VERSION.split(".")[0]);
const REMOTE_JUST_VERSION = "1.43.1";
const REMOTE_GH_VERSION = "2.83.1";
const REMOTE_RUNTIME_REVISION = "workspace-runtime-v8";
// This path exists inside every remote sandbox. It must not inherit the host
// service's checkout path (for example a dedicated production release tree).
export const REMOTE_REPO = `${REMOTE_HOME}/projects/opensession`;
export const REMOTE_RUNNER_BINARY = `${REMOTE_HOME}/.local/bin/opensession-runner`;
const BOOTSTRAP_MARKER = `${REMOTE_HOME}/.bks-bootstrapped`;
/** Where per-launch openai seed material lands in-sandbox — threaded to the
 *  run host via the OPENSESSION_OPENAI_SEED_DIR env (openaiRemoteSeedDir()),
 *  never derived independently on the two sides. */
export const REMOTE_OPENAI_SEED_DIR = `${REMOTE_HOME}/.opensession-openai-seeds`;
export const REMOTE_PI_CONFIG = `${REMOTE_HOME}/.opensession-pi.json`;
export const REMOTE_MODEL_PROVIDERS_CONFIG = `${REMOTE_HOME}/.opensession-model-providers.json`;
const REMOTE_PATH = `${REMOTE_HOME}/.bun/bin:${REMOTE_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

const RUNS_BASE = `${OPENSESSION_SESSIONS_DIR}/sandbox-runs`;
const STATE_DIR = `${OPENSESSION_SESSIONS_DIR}/sandboxes`;

// ── The wire each adapter implements ─────────────────────────────────────────

export interface RemoteExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Execute through the provider's native detached-process lane. */
  detached?: boolean;
}

export interface RemoteDriver {
  /** One-shot SHELL command (a string — adapters' SDKs take shell strings;
   *  argv callers go through shellQuote). Never throws on non-zero exit. */
  exec(cmd: string, opts?: RemoteExecOpts): Promise<ExecResult>;
  /** Start a detached long-lived process that survives this call AND this
   *  opensession process (provider background/session APIs). */
  execBackground(cmd: string, opts?: RemoteExecOpts): Promise<void>;
  /** Write a file into the sandbox (parent dir must exist). */
  writeFile(path: string, content: string): Promise<void>;
  /** Wake a stopped/paused sandbox — control-plane ops only, never reads. */
  ensureStarted(): Promise<void>;
}

// ── Small shell helpers ───────────────────────────────────────────────────────

/** POSIX-quote one argv word. */
export function shellQuoteWord(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** argv → a shell string with every word quoted (argv semantics preserved
 *  through the providers' shell-string exec APIs). */
export function shellQuote(argv: string[]): string {
  return argv.map(shellQuoteWord).join(" ");
}

function envPrefix(env: Record<string, string>): string {
  const parts = Object.entries(env).map(
    ([k, v]) => `${k}=${shellQuoteWord(v)}`,
  );
  return parts.length ? `env ${parts.join(" ")} ` : "";
}

// Re-exported for the existing importers of this module's URL redaction; the
// implementation moved to the shared util so non-sandbox code can use it too.
export { redactUrl };

// ── Per-launch engine config projection ──────────────────────────────────────

type JsonRecord = Record<string, unknown>;

function jsonRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/** The third-party provider selected by an pi/<provider>/<model> id.
 * Anthropic/OpenAI use subscription material, never native auth. */
export function remoteModelProviderId(
  model: string | undefined,
): string | null {
  const match = String(model || "").match(/^pi\/([^/]+)\//);
  const provider = match?.[1];
  return provider && provider !== "anthropic" && provider !== "openai"
    ? provider
    : null;
}

/** Allowlisted Pi config for a guest. Unknown future host fields must not
 * silently cross the sandbox trust boundary. */
export function projectRemotePiConfig(raw: unknown): string | null {
  const cfg = normalizePiConfig(raw);
  if (!cfg.enabled) return null;
  return (
    JSON.stringify(
      {
        enabled: true,
        pickerModels: cfg.pickerModels,
        ...(cfg.anthropicTransport === "bridge"
          ? { anthropicTransport: "bridge" }
          : {}),
      },
      null,
      2,
    ) + "\n"
  );
}

function remoteReachableModels(
  model: string | undefined,
  fallbackModel?: string,
): string[] {
  const primary = toPiModel(model) || model;
  return [
    primary,
    ...fallbackPlan(primary, fallbackModel).map(
      (hop) => toPiModel(hop.id) || hop.id,
    ),
  ].filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && !!candidate,
  );
}

export function remoteRunNeedsOpenai(
  model: string | undefined,
  fallbackModel?: string,
): boolean {
  return remoteReachableModels(model, fallbackModel).some((candidate) =>
    /^pi\/openai\//.test(candidate),
  );
}

export function remoteRunNeedsAnthropic(
  model: string | undefined,
  fallbackModel?: string,
): boolean {
  return remoteReachableModels(model, fallbackModel).some((candidate) =>
    /^pi\/anthropic\//.test(candidate),
  );
}

function remoteSettingsProviderIds(
  model: string | undefined,
  fallbackModel?: string,
): Set<string> {
  return new Set(
    remoteReachableModels(model, fallbackModel)
      .map(remoteModelProviderId)
      .filter((id): id is string => !!id),
  );
}

/** Strip host-only and unknown account fields before writing Claude tokens to a guest. */
export function projectRemoteClaudeAccounts(
  accounts: ClaudeAccount[],
): ClaudeAccount[] {
  return accounts.map((account) => ({
    id: account.id,
    name: account.name,
    token: account.token,
    createdAt: account.createdAt,
    ...(account.owner ? { owner: account.owner } : {}),
  }));
}

/**
 * Project host Pi settings into fields consumed by an in-guest runner.
 * Third-party API keys are included only for providers reachable by this
 * launch's primary and fallback walk. Unreachable configured keys stay host-side.
 */
export function projectRemoteModelProviderConfig(
  raw: unknown,
  model: string | undefined,
  trustProfile: "interactive" | "automation" = "interactive",
  pinnedAccountId?: string,
  fallbackModel?: string,
): { content: string; settingsProviderIds: string[] } {
  const source = jsonRecord(raw);
  if (!source) throw new Error("Pi config must be a JSON object");

  const out: JsonRecord = {};
  if (typeof source.enabled === "boolean") out.enabled = source.enabled;
  if (typeof source.port === "number") out.port = source.port;
  if (typeof source.turnTimeoutMinutes === "number")
    out.turnTimeoutMinutes = source.turnTimeoutMinutes;
  if (typeof source.bridgeMaxRequestsPerHour === "number")
    out.bridgeMaxRequestsPerHour = source.bridgeMaxRequestsPerHour;
  if (typeof source.orchestrator === "boolean")
    out.orchestrator = source.orchestrator;
  if (Array.isArray(source.pickerModels))
    out.pickerModels = source.pickerModels.filter(
      (value): value is string => typeof value === "string",
    );
  if (trustProfile === "automation" && pinnedAccountId) {
    out.bridgeAccountIds = [pinnedAccountId];
  } else if (Array.isArray(source.bridgeAccountIds)) {
    out.bridgeAccountIds = source.bridgeAccountIds.filter(
      (value): value is string => typeof value === "string",
    );
  }

  const bridge = jsonRecord(source.bridge);
  if (bridge) {
    const projectedBridge: JsonRecord = {};
    if (["meridian", "native", "off"].includes(String(bridge.mode)))
      projectedBridge.mode = bridge.mode;
    if (trustProfile === "automation" && pinnedAccountId) {
      projectedBridge.accounts = [pinnedAccountId];
      projectedBridge.openaiAccounts = [pinnedAccountId];
    } else {
      if (Array.isArray(bridge.accounts))
        projectedBridge.accounts = bridge.accounts.filter(
          (value): value is string => typeof value === "string",
        );
      if (Array.isArray(bridge.openaiAccounts))
        projectedBridge.openaiAccounts = bridge.openaiAccounts.filter(
          (value): value is string => typeof value === "string",
        );
    }
    if (Object.keys(projectedBridge).length) out.bridge = projectedBridge;
  }

  const settingsProviders: JsonRecord = {};
  const reachableSettingsProviders = remoteSettingsProviderIds(
    model,
    fallbackModel,
  );
  if (reachableSettingsProviders.size) {
    for (const [id, value] of Object.entries(
      jsonRecord(source.providers) || {},
    )) {
      if (id === "anthropic" || id === "openai") continue;
      if (!reachableSettingsProviders.has(id)) continue;
      const provider = jsonRecord(value);
      if (!provider) continue;
      const projected: JsonRecord = {};
      if (typeof provider.apiKey === "string" && provider.apiKey)
        projected.apiKey = provider.apiKey;
      if (typeof provider.baseURL === "string" && provider.baseURL)
        projected.baseURL = provider.baseURL;
      if (Object.keys(projected).length) settingsProviders[id] = projected;
    }
  }
  if (Object.keys(settingsProviders).length) out.providers = settingsProviders;

  return {
    content: JSON.stringify(out, null, 2) + "\n",
    settingsProviderIds: Object.keys(settingsProviders).sort(),
  };
}

// ── Provider state files (mirror docker's, namespaced per provider) ──────────

/**
 * The trust policy a sandbox EXISTS under. It belongs to the sandbox, not to
 * the ensure() call that happens to be running: provider.ts's contract is that
 * an automation sandbox fails closed unless the provider installed its
 * credential-minimal profile and outbound network policy, and a call that
 * re-enters ensure() without repeating the policy must not quietly reopen it.
 */
export interface SandboxTrustPolicy {
  trustProfile: "interactive" | "automation";
  /** Hostnames, IPs, CIDRs, or URLs permitted for automation egress. */
  egressAllowlist: string[];
}

export interface RemoteSandboxState extends SandboxTrustPolicy {
  sandboxId: string;
  /** Crash-safe idempotency token while a provider create call is in flight. */
  pendingClientToken?: string;
  provider: SandboxProviderId;
  sessionId: string;
  cwd: string;
  repoId?: string;
  resources?: { cpu?: number; memoryMb?: number; diskGb?: number };
  branch?: string;
  /** Session-private provider image used when ephemeral compute disappears. */
  checkpointArtifactId?: string;
  checkpointCreatedAt?: string;
  createdAt: string;
  lastActivityAt: string;
}

/**
 * The policy an ensure() runs under: the caller's when it declares one, else
 * the one the sandbox was RECORDED with. Every path that re-enters ensure()
 * without a policy (the recreate route, a provider resume, a state-driven
 * get()) inherits it instead of falling back to the open "interactive"
 * default, and a caller that tries to downgrade a recorded automation sandbox
 * is refused: dropping the egress firewall and the credential-minimal
 * projection is exactly the widening the contract exists to prevent.
 */
export function resolveTrustPolicy(
  spec: Pick<SandboxSessionSpec, "trustProfile" | "egressAllowlist">,
  previous?: Partial<SandboxTrustPolicy> | null,
): SandboxTrustPolicy {
  const recorded = previous?.trustProfile;
  if (recorded === "automation" && spec.trustProfile === "interactive") {
    throw new Error(
      "this sandbox was created under the automation trust profile and cannot " +
        "be reopened as interactive. Delete the session's sandbox instead.",
    );
  }
  return {
    trustProfile: spec.trustProfile || recorded || "interactive",
    // Only a caller that states the profile may restate the allowlist; a
    // policy-less re-entry inherits the recorded one rather than widening.
    egressAllowlist:
      (spec.trustProfile ? spec.egressAllowlist : undefined) ||
      previous?.egressAllowlist ||
      [],
  };
}

/**
 * The trust policy recorded for a session's sandbox. For callers that must
 * re-enter ensure() AFTER destroy() has deleted the state file (the recreate
 * route). Null when the provider keeps no state here (local, docker).
 */
export function recordedTrustPolicy(
  provider: string,
  sessionId: string,
): SandboxTrustPolicy | null {
  const state = findRemoteStateBySession(provider, sessionId);
  if (!state) return null;
  return {
    trustProfile: state.trustProfile,
    egressAllowlist: state.egressAllowlist,
  };
}

function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^[^a-zA-Z0-9]+/, "");
}

function statePath(provider: string, sandboxId: string): string {
  return `${STATE_DIR}/${provider}-${sanitizeName(sandboxId)}.json`;
}

export function readRemoteState(
  provider: string,
  sandboxId: string,
): RemoteSandboxState | null {
  try {
    const p = statePath(provider, sandboxId);
    if (!existsSync(p)) return null;
    return withTrustPolicy(JSON.parse(readFileSync(p, "utf-8")));
  } catch {
    return null;
  }
}

/** State files written before the policy was recorded carry none. They can
 *  only be interactive sandboxes: automation ensures have always declared the
 *  profile, and every writer now records what resolveTrustPolicy returned. */
function withTrustPolicy(state: RemoteSandboxState): RemoteSandboxState {
  return { ...state, ...resolveTrustPolicy({}, state) };
}

export function writeRemoteState(state: RemoteSandboxState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeJsonAtomic(statePath(state.provider, state.sandboxId), state);
}

export function removeRemoteState(provider: string, sandboxId: string): void {
  const state = readRemoteState(provider, sandboxId);
  try {
    unlinkSync(statePath(provider, sandboxId));
  } catch {}
  if (state) {
    try {
      rmSync(`${RUNS_BASE}/${sanitizeName(state.sessionId)}`, {
        recursive: true,
        force: true,
      });
    } catch {}
  }
}

export function touchRemoteState(provider: string, sandboxId: string): void {
  const s = readRemoteState(provider, sandboxId);
  if (s) {
    s.lastActivityAt = new Date().toISOString();
    writeRemoteState(s);
  }
}

/** Find a provider's state file by session id (the reverse index ensure needs
 *  when the provider-side label lookup fails). */
export function findRemoteStateBySession(
  provider: string,
  sessionId: string,
): RemoteSandboxState | null {
  return (
    listRemoteStates(provider).find((state) => state.sessionId === sessionId) ||
    null
  );
}

/** Enumerate a provider's persisted sandboxes. Used by provider-side orphan
 * audits (notably local MicroVM prewarms); malformed files fail closed. */
export function listRemoteStates(provider: string): RemoteSandboxState[] {
  const states: RemoteSandboxState[] = [];
  try {
    if (!existsSync(STATE_DIR)) return states;
    for (const f of readdirSync(STATE_DIR)) {
      if (!f.startsWith(`${provider}-`) || !f.endsWith(".json")) continue;
      try {
        const s: RemoteSandboxState = JSON.parse(
          readFileSync(`${STATE_DIR}/${f}`, "utf-8"),
        );
        if (s.provider === provider && s.sandboxId && s.sessionId)
          states.push(withTrustPolicy(s));
      } catch {}
    }
  } catch {}
  return states;
}

/** Serialize ensure() per provider+session — same in-process chain pattern as
 *  docker's withEnsureLock, parked on globalThis for --hot survival. */
export function withRemoteEnsureLock<T>(
  provider: string,
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const g = globalThis as unknown as {
    __remoteSandboxEnsureChains?: Map<string, Promise<unknown>>;
  };
  const chains = (g.__remoteSandboxEnsureChains ??= new Map());
  const key = `${provider}:${sessionId}`;
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  chains.set(key, tail);
  void tail.finally(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

// ── Clone URL resolution ──────────────────────────────────────────────────────

async function hostGit(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return code === 0 ? out.trim() : "";
}

function toHttpsUrl(origin: string): string | null {
  if (/^https:\/\//.test(origin)) return origin;
  // git@github.com:owner/name(.git) → https://github.com/owner/name.git
  const m = origin.match(/^git@([^:]+):(.+?)(\.git)?$/);
  if (m) return `https://${m[1]}/${m[2]}.git`;
  const ssh = origin.match(/^ssh:\/\/git@([^/]+)\/(.+?)(\.git)?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}.git`;
  return null;
}

function credentialFreeHttpsUrl(httpsUrl: string): string {
  const parsed = new URL(httpsUrl);
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

function isGithubHttpsUrl(httpsUrl: string): boolean {
  try {
    const parsed = new URL(httpsUrl);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname.toLowerCase() === "github.com"
    );
  } catch {
    return false;
  }
}

/** GitHub clones receive only a fresh repository-scoped App token. Persisted
 * clone credentials are never valid GitHub authority. */
export async function injectCloneCredential(httpsUrl: string): Promise<string> {
  const cred = sandboxConfig().cloneCredential;
  let parsed: URL;
  try {
    parsed = new URL(httpsUrl);
  } catch {
    return httpsUrl;
  }
  const github =
    parsed.protocol === "https:" &&
    parsed.hostname.toLowerCase() === "github.com";
  let token: string | undefined;

  if (github) {
    // Always discard authority embedded in a persisted GitHub origin before
    // applying the operator-selected credential.
    parsed.username = "";
    parsed.password = "";
    const repository = parsed.pathname.replace(/^\/+|\.git$/g, "");
    const { githubAppRepositoryToken } = await import("../../github-app");
    token = (await githubAppRepositoryToken(repository)) || undefined;
  } else if (cred?.type === "https-token") {
    // Explicit credentials for non-GitHub hosts keep their existing behavior.
    token = cred.token;
  }

  if (!token) return parsed.toString();
  parsed.username = "x-access-token";
  parsed.password = token;
  return parsed.toString();
}

/**
 * The https clone URL a remote sandbox uses for a repo: an https origin (or
 * ssh origin converted), else derived from `ghRepo`. Local-path origins are
 * unreachable remotely — loud error. `cloneCredential` is applied here.
 */
export async function remoteCloneUrl(
  repo: {
    id: string;
    repo: string;
    ghRepo?: string;
    host?: "github" | "codestorage";
    csRepo?: string;
  },
  options: { credential?: "configured" | "none" } = {},
): Promise<string> {
  const origin = await hostGit(["remote", "get-url", "origin"], repo.repo);
  if (repo.host === "codestorage") {
    if (options.credential === "none") {
      throw new Error(
        `repo ${repo.id} does not expose a credential-free code.storage clone`,
      );
    }
    const csRepoId =
      repo.csRepo || (origin ? parseCsRemote(origin)?.repoId : undefined);
    if (!csRepoId) {
      throw new Error(
        `repo ${repo.id} is code.storage-hosted but has neither csRepo nor a code.storage origin`,
      );
    }
    // 30-day TTL: the URL is persisted as the sandbox's origin and nothing
    // re-materializes the remote inside a long-lived sandbox, so the token
    // must outlive the sandbox (mirrors the long-lived-token preference for
    // GitHub below). Tradeoff, accepted deliberately: a write-scoped,
    // repo-scoped JWT sits at rest in the sandbox-side .git/config for its
    // life — code.storage's auth model expects long-lived dev tokens for
    // exactly this. One-shot operations keep short default TTLs.
    return authedRemoteUrl(csRepoId, { ttlSeconds: 30 * 24 * 3600 });
  }
  const https =
    (origin && toHttpsUrl(origin)) ||
    (repo.ghRepo ? `https://github.com/${repo.ghRepo}.git` : null);
  if (!https) {
    throw new Error(
      `repo ${repo.id} has no https-reachable origin (origin="${redactUrl(origin) || "none"}") — remote sandboxes clone over https; set an origin or ghRepo`,
    );
  }
  return options.credential === "none"
    ? credentialFreeHttpsUrl(https)
    : await injectCloneCredential(https);
}

/**
 * Fast dial-back preflight for remote sandboxes: before the multi-second
 * (cold: multi-minute) bootstrap, prove the sandbox can reach the URL runs
 * must dial back to (`remoteSandboxCallbackBaseUrl` — run-ws/rpc-ws live
 * there). Any HTTP response, even a 404, proves reachability; a connect
 * failure/timeout fails the ensure() immediately with the honest, documented
 * error instead of letting the user burn 30s+ into a bootstrap that can never
 * produce a working run. Skips quietly when the image has no curl (bootstrap
 * checks that loudly right after).
 */
export async function assertDialbackReachable(
  driver: RemoteDriver,
  label: string,
  callbackBaseUrl = remoteSandboxCallbackBaseUrl(),
): Promise<void> {
  const wsBase = callbackBaseUrl.replace(/\/+$/, "");
  const httpBase = wsBase.replace(/^ws(s?):\/\//, "http$1://");
  const probe = await driver.exec(
    `command -v curl >/dev/null 2>&1 || { echo __OPENSESSION_NO_CURL__; exit 0; }; ` +
      `curl -sS -o /dev/null -m 5 -w '%{http_code}' ${shellQuoteWord(`${httpBase}/`)}`,
    { timeoutMs: 20_000 },
  );
  if (probe.stdout.includes("__OPENSESSION_NO_CURL__")) return;
  if (probe.exitCode !== 0) {
    const detail = (probe.stderr || probe.stdout).trim().slice(0, 200);
    throw new Error(
      `${label} sandboxes can't reach this Open Session server yet — ` +
        `${redactUrl(httpBase)} is unreachable from inside the sandbox` +
        `${detail ? ` (${detail})` : ""}. Remote sandboxes must dial back to ` +
        `callbackBaseUrl/publicIngress, which needs the provider org's egress tier ` +
        `plus a publicly reachable ingress — see docs/self-hosting-sandboxes.md.`,
    );
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function need(r: ExecResult, what: string): void {
  if (r.exitCode !== 0) {
    throw new Error(
      `remote sandbox bootstrap failed (${what}): ${redactUrl((r.stderr || r.stdout).trim().slice(0, 500))}`,
    );
  }
}

/** What the bootstrap marker records — a prewarmed sandbox is only adoptable
 *  while its recorded signature still matches this (prewarm.ts claim check).
 *  The pi pin is part of it so sandboxes bootstrapped before pi
 *  was in the payload (or on an older pin) re-bootstrap instead of failing
 *  every pi/* run with a missing binary. */
export function bootstrapSignature(): string {
  const cfg = sandboxConfig();
  const base = cfg.runnerSha || cfg.runnerBundleUrl || "unpinned";
  return (
    `${base}+node@${REMOTE_NODE_VERSION}+just@${REMOTE_JUST_VERSION}` +
    `+gh@${REMOTE_GH_VERSION}+${REMOTE_RUNTIME_REVISION}`
  );
}

/** Toolchain identity for DURABLE repo templates: everything bootstrap
 * installs that a restored sandbox cannot cheaply reconcile in place.
 * Deliberately excludes the runnerSha commit pin itself: on adoption,
 * bootstrapRemoteSandbox already reconciles a stale checkout with a shallow
 * fetch + detached checkout of the pin, an incremental frozen-lockfile
 * install, and a forced runner recompile — seconds to a minute inside the
 * restored filesystem. Keying templates on the pin instead threw away every
 * provider artifact (full re-clone + project setup + re-snapshot) on every
 * deploy. The runner repo's committed lockfile stands in for the dependency
 * payload: templates survive code-only runner bumps and still rotate when
 * the dependency set actually moves. */
export function runnerToolchainSignature(): string {
  const cfg = sandboxConfig();
  const base = cfg.runnerSha
    ? runnerLockfileOid(cfg.runnerSha)
    : cfg.runnerBundleUrl || "unpinned";
  return (
    `${base}+node@${REMOTE_NODE_VERSION}+just@${REMOTE_JUST_VERSION}` +
    `+gh@${REMOTE_GH_VERSION}+${REMOTE_RUNTIME_REVISION}`
  );
}

/** bun.lock blob oid at the pinned runner commit — falling back to the local
 * checkout's HEAD when the pin isn't resolvable here, then to the pin itself
 * so an unreadable repo degrades to per-deploy invalidation, never to silent
 * reuse across an unknown dependency change. */
function runnerLockfileOid(runnerSha: string): string {
  for (const rev of [runnerSha, "HEAD"]) {
    const proc = Bun.spawnSync({
      cmd: [
        "git",
        "-C",
        REPO_ROOT,
        "rev-parse",
        "--verify",
        "--quiet",
        `${rev}:bun.lock`,
      ],
      stdout: "pipe",
      stderr: "ignore",
    });
    const oid = proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
    if (oid) return `lock:${oid}`;
  }
  return runnerSha;
}

function remoteRunnerInstallCommand(force = false): string {
  const temporary = `${REMOTE_RUNNER_BINARY}.tmp`;
  return (
    `${force ? `rm -f ${shellQuoteWord(REMOTE_RUNNER_BINARY)} && ` : ""}` +
    `test -x ${shellQuoteWord(REMOTE_RUNNER_BINARY)} || { ` +
    `cd ${shellQuoteWord(REMOTE_REPO)} && rm -f ${shellQuoteWord(temporary)} && ` +
    `HOME=${REMOTE_HOME} ${REMOTE_BUN} build --compile ` +
    `packages/core/opensession-server/src/main.ts --outfile ${shellQuoteWord(temporary)} ` +
    `--external sharp --external ${shellQuoteWord("@img/*")} && ` +
    `chmod 755 ${shellQuoteWord(temporary)} && mv ${shellQuoteWord(temporary)} ${shellQuoteWord(REMOTE_RUNNER_BINARY)}; }`
  );
}

export function remoteRunnerHostCommand(specPath: string): string {
  return (
    `if [ -x ${shellQuoteWord(REMOTE_RUNNER_BINARY)} ]; then ` +
    `exec ${shellQuoteWord(REMOTE_RUNNER_BINARY)} runner-host ${shellQuoteWord(specPath)}; ` +
    `else exec ${REMOTE_BUN} run ${shellQuoteWord(HOST_ENTRY)} ${shellQuoteWord(specPath)}; fi`
  );
}

/** Install the portable base tools needed before the full runner payload. */
async function bootstrapRemoteBaseRuntime(
  driver: RemoteDriver,
  label: string,
): Promise<void> {
  const log = (msg: string) =>
    console.log(`[sandbox:${label}] base runtime: ${msg}`);

  need(
    await driver.exec(
      `test -w ${REMOTE_HOME} || (sudo -n mkdir -p ${REMOTE_HOME} && sudo -n chown $(id -u):$(id -g) ${REMOTE_HOME})`,
    ),
    `writable ${REMOTE_HOME} (image needs passwordless sudo or a prebaked /home/ubuntu)`,
  );

  // Provider base images vary. Install the same workspace/preview contract as
  // deploy/sandbox/Dockerfile: native build tools for dependency installs,
  // direnv/lsof for lifecycle scripts, and the generic runner utilities.
  const tools = await driver.exec(
    'for c in git curl unzip rg sed nl wc base64 python3 make g++ direnv lsof; do command -v "$c" >/dev/null 2>&1 || echo "$c"; done',
  );
  if (tools.stdout.trim()) {
    log(
      `installing workspace tools (${tools.stdout.trim().replaceAll("\n", ", ")})…`,
    );
    need(
      await driver.exec(
        `run_root() { if [ "$(id -u)" = 0 ]; then "$@"; ` +
          `elif command -v sudo >/dev/null 2>&1; then sudo -n "$@"; ` +
          `else echo "root privileges are required to install workspace tools" >&2; return 1; fi; }; ` +
          `if command -v apt-get >/dev/null 2>&1; then ` +
          `run_root apt-get update -qq && run_root apt-get install -y -qq ca-certificates git curl unzip xz-utils ripgrep coreutils sed python3 build-essential direnv lsof; ` +
          `elif command -v apk >/dev/null 2>&1; then ` +
          `run_root apk add --no-cache ca-certificates git curl unzip xz ripgrep coreutils sed python3 build-base direnv lsof; ` +
          `elif command -v dnf >/dev/null 2>&1; then ` +
          `run_root dnf install -y ca-certificates git curl unzip xz ripgrep coreutils sed python3 gcc-c++ make direnv lsof; ` +
          `elif command -v yum >/dev/null 2>&1; then ` +
          `run_root yum install -y ca-certificates git curl unzip xz ripgrep coreutils sed python3 gcc-c++ make direnv lsof; ` +
          `else echo "no supported package manager" >&2; exit 1; fi`,
        { timeoutMs: 300_000 },
      ),
      "workspace tools install",
    );
  }
  need(
    await driver.exec(
      'for c in git curl unzip rg sed nl wc base64 python3 make g++ direnv lsof; do command -v "$c" >/dev/null 2>&1 || { echo "missing $c" >&2; exit 1; }; done',
    ),
    "workspace tools check",
  );

  // Provider images can already carry an older /usr/local/bin/node that wins
  // over distro packages (Daytona ships Node 20 this way). Install the pinned
  // official release into /usr/local so the binary agents actually resolve is
  // deterministic. Verify against Node's published SHASUMS before extracting.
  const node = await driver.exec(
    `node -p 'process.versions.node' 2>/dev/null || true`,
  );
  if (node.stdout.trim() !== REMOTE_NODE_VERSION) {
    log(`installing Node ${REMOTE_NODE_VERSION}…`);
    need(
      await driver.exec(
        `case "$(uname -m)" in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; ` +
          `*) echo "unsupported Node architecture: $(uname -m)" >&2; exit 1;; esac; ` +
          `version=${REMOTE_NODE_VERSION}; archive=node-v$version-linux-$arch.tar.xz; tmp=$(mktemp -d); ` +
          `trap 'rm -rf "$tmp"' EXIT; ` +
          `curl -fsSL https://nodejs.org/download/release/v$version/$archive -o "$tmp/$archive" && ` +
          `curl -fsSL https://nodejs.org/download/release/v$version/SHASUMS256.txt -o "$tmp/SHASUMS256.txt" && ` +
          `(cd "$tmp" && grep "  $archive$" SHASUMS256.txt | sha256sum -c -) && ` +
          `if [ "$(id -u)" = 0 ]; then tar -xJf "$tmp/$archive" --strip-components=1 -C /usr/local; ` +
          `elif command -v sudo >/dev/null 2>&1; then sudo -n tar -xJf "$tmp/$archive" --strip-components=1 -C /usr/local; ` +
          `else echo "root privileges are required to install Node $version" >&2; exit 1; fi`,
        { timeoutMs: 300_000 },
      ),
      `Node ${REMOTE_NODE_VERSION} install`,
    );
  }
  need(
    await driver.exec(
      `explicit=$(/usr/local/bin/node -p 'process.versions.node' 2>/dev/null || true); ` +
        `resolved=$(env PATH=${shellQuoteWord(REMOTE_PATH)} node -p 'process.versions.node' 2>/dev/null || true); ` +
        `[ "$explicit" = "${REMOTE_NODE_VERSION}" ] && [ "$resolved" = "${REMOTE_NODE_VERSION}" ] || ` +
        `{ echo "explicit=$explicit resolved=$resolved expected=${REMOTE_NODE_VERSION}" >&2; exit 1; }`,
    ),
    `Node ${REMOTE_NODE_VERSION} check`,
  );

  const remoteJust = "/usr/local/bin/just";
  log(`ensuring just ${REMOTE_JUST_VERSION}…`);
  need(
    await driver.exec(
      `test -x ${remoteJust} && test "$(${remoteJust} --version | awk '{print $2}')" = "${REMOTE_JUST_VERSION}" || ` +
        `{ if [ "$(id -u)" = 0 ]; then ` +
        `curl -fsSL https://just.systems/install.sh | bash -s -- --tag ${REMOTE_JUST_VERSION} --to ${dirname(remoteJust)}; ` +
        `elif command -v sudo >/dev/null 2>&1; then ` +
        `curl -fsSL https://just.systems/install.sh | sudo -n bash -s -- --tag ${REMOTE_JUST_VERSION} --to ${dirname(remoteJust)}; ` +
        `else echo "root privileges are required to install just ${REMOTE_JUST_VERSION}" >&2; exit 1; fi; }`,
      { timeoutMs: 120_000 },
    ),
    `just ${REMOTE_JUST_VERSION} install`,
  );
  need(
    await driver.exec(
      `test "$(${remoteJust} --version | awk '{print $2}')" = "${REMOTE_JUST_VERSION}"`,
    ),
    `just ${REMOTE_JUST_VERSION} check`,
  );

  // gh: the Docker sandbox image (deploy/sandbox/Dockerfile) ships it, and
  // agent runs rely on it for GitHub interactions such as PRs, checks, and API calls.
  // Remote provider base images (Daytona and friends) don't carry it, so
  // install the pinned official release, checksum-verified, into /usr/local/bin.
  const remoteGh = "/usr/local/bin/gh";
  log(`ensuring gh ${REMOTE_GH_VERSION}…`);
  need(
    await driver.exec(
      `test -x ${remoteGh} && test "$(${remoteGh} --version | head -n1 | awk '{print $3}')" = "${REMOTE_GH_VERSION}" || ` +
        `{ case "$(uname -m)" in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; ` +
        `*) echo "unsupported gh architecture: $(uname -m)" >&2; exit 1;; esac; ` +
        `dist=gh_${REMOTE_GH_VERSION}_linux_$arch; tmp=$(mktemp -d); ` +
        `trap 'rm -rf "$tmp"' EXIT; ` +
        `curl -fsSL https://github.com/cli/cli/releases/download/v${REMOTE_GH_VERSION}/$dist.tar.gz -o "$tmp/$dist.tar.gz" && ` +
        `curl -fsSL https://github.com/cli/cli/releases/download/v${REMOTE_GH_VERSION}/gh_${REMOTE_GH_VERSION}_checksums.txt -o "$tmp/checksums.txt" && ` +
        `expected=$(grep "  $dist.tar.gz$" "$tmp/checksums.txt") && test -n "$expected" && ` +
        `printf '%s\\n' "$expected" | (cd "$tmp" && sha256sum -c -) && ` +
        `tar -xzf "$tmp/$dist.tar.gz" -C "$tmp" && ` +
        `if [ "$(id -u)" = 0 ]; then install -m 0755 "$tmp/$dist/bin/gh" ${remoteGh}; ` +
        `elif command -v sudo >/dev/null 2>&1; then sudo -n install -m 0755 "$tmp/$dist/bin/gh" ${remoteGh}; ` +
        `else echo "root privileges are required to install gh ${REMOTE_GH_VERSION}" >&2; exit 1; fi; }`,
      { timeoutMs: 120_000 },
    ),
    `gh ${REMOTE_GH_VERSION} install`,
  );
  need(
    await driver.exec(
      `test "$(${remoteGh} --version | head -n1 | awk '{print $3}')" = "${REMOTE_GH_VERSION}"`,
    ),
    `gh ${REMOTE_GH_VERSION} check`,
  );

  log("ensuring bun…");
  need(
    await driver.exec(
      `test -x ${REMOTE_BUN} || curl -fsSL https://bun.sh/install | HOME=${REMOTE_HOME} bash`,
      { timeoutMs: 300_000 },
    ),
    "bun install",
  );
  // Some provider images prebake only the `bun` binary. Bun's standard
  // installer also exposes `bunx` as a same-binary shim, and repo tooling
  // commonly invokes that name directly (a repo's own watcher scripts).
  need(
    await driver.exec(
      `test -x ${REMOTE_BUNX} || ln -sf ${REMOTE_BUN} ${REMOTE_BUNX}`,
    ),
    "bunx shim",
  );
  log("ready");
}

/**
 * Install the runner payload in a fresh remote sandbox (idempotent — a marker
 * file short-circuits every later call). See the module header for what/why
 * and the cold-start cost.
 */
export async function bootstrapRemoteSandbox(
  driver: RemoteDriver,
  label: string,
): Promise<void> {
  const cfg = sandboxConfig();
  const signature = bootstrapSignature();
  const marker = await driver.exec(`cat ${BOOTSTRAP_MARKER} 2>/dev/null`);
  if (marker.exitCode === 0 && marker.stdout.trim() === signature) {
    // Box archive/resume reconstructs parts of the filesystem from Git and can
    // drop an operator-applied executable bit even though the durable bootstrap
    // marker survives. Repair the tiny workload-identity entrypoint on every
    // adoption instead of rerunning the full runtime install.
    need(
      await driver.exec(
        `mkdir -p ${REMOTE_HOME}/.local/bin && ` +
          `chmod 755 ${REMOTE_REPO}/deploy/sandbox/opensession && ` +
          `ln -sf ${REMOTE_REPO}/deploy/sandbox/opensession ${REMOTE_HOME}/.local/bin/opensession && ` +
          `test -x ${REMOTE_HOME}/.local/bin/opensession && ` +
          `(${remoteRunnerInstallCommand()})`,
      ),
      "workload identity client repair",
    );
    return;
  }
  const log = (msg: string) =>
    console.log(`[sandbox:${label}] bootstrap: ${msg}`);

  await bootstrapRemoteBaseRuntime(driver, label);

  // Runner bundle: tarball if configured, else git clone at the pinned sha.
  // Resolve the authenticated runner URL per bootstrap, use it only for the
  // bounded clone/fetch commands, then leave a credential-free origin behind.
  const runnerRepo = { id: "opensession", repo: REPO_ROOT, ghRepo: undefined };
  const runnerCloneUrl = cfg.runnerBundleUrl
    ? undefined
    : cfg.runnerRepoUrl && toHttpsUrl(cfg.runnerRepoUrl)
      ? await injectCloneCredential(toHttpsUrl(cfg.runnerRepoUrl)!)
      : await remoteCloneUrl(runnerRepo);
  const hasRepo = await driver.exec(`test -f ${REMOTE_REPO}/package.json`);
  if (hasRepo.exitCode !== 0) {
    if (cfg.runnerBundleUrl) {
      log(`fetching runner bundle from ${redactUrl(cfg.runnerBundleUrl)}…`);
      need(
        await driver.exec(
          `mkdir -p ${REMOTE_REPO} && curl -fsSL ${shellQuoteWord(cfg.runnerBundleUrl)} | tar -xz --strip-components=1 -C ${REMOTE_REPO}`,
          { timeoutMs: 600_000 },
        ),
        "runner bundle download",
      );
    } else {
      log(`cloning runner repo ${redactUrl(runnerCloneUrl!)}…`);
      need(
        await driver.exec(
          `mkdir -p ${dirname(REMOTE_REPO)} && git clone -- ${shellQuoteWord(runnerCloneUrl!)} ${REMOTE_REPO}`,
          { timeoutMs: 600_000 },
        ),
        "runner repo clone",
      );
    }
  }

  // Reconcile the checkout with the pinned runnerSha — OUTSIDE the clone block,
  // so it also runs when the repo already exists. (A runnerSha bump used to be
  // silently skipped on an already-bootstrapped sandbox: the `test -f
  // package.json` guard short-circuited the fetch/checkout, yet the signature
  // marker below was rewritten, freezing the old code forever.) The marker is
  // only written after the checkout verifiably matches the pin.
  if (cfg.runnerSha) {
    const isGit = await driver.exec(`test -d ${REMOTE_REPO}/.git`);
    if (isGit.exitCode !== 0) {
      // Tarball payload (runnerBundleUrl) — no git history to reconcile; the
      // signature marker keys on the sha, so a bump with a stale bundle keeps
      // re-running bootstrap loudly instead of pretending it applied.
      log(
        `runnerSha ${cfg.runnerSha} pinned but ${REMOTE_REPO} is not a git checkout — skipping reconcile`,
      );
    } else {
      const head = async () =>
        (
          await driver.exec(`git -C ${REMOTE_REPO} rev-parse HEAD`)
        ).stdout.trim();
      const resolvePin = async () =>
        (
          await driver.exec(
            `git -C ${REMOTE_REPO} rev-parse --verify --quiet ${shellQuoteWord(`${cfg.runnerSha}^{commit}`)}`,
          )
        ).stdout.trim();
      let pin = await resolvePin();
      if (!pin || (await head()) !== pin) {
        log(`checking out pinned runnerSha ${cfg.runnerSha}…`);
        need(
          await driver.exec(
            `git -C ${REMOTE_REPO} fetch --depth 1 ${shellQuoteWord(runnerCloneUrl!)} ${shellQuoteWord(cfg.runnerSha)} 2>/dev/null; git -C ${REMOTE_REPO} checkout --detach ${shellQuoteWord(cfg.runnerSha)}`,
            { timeoutMs: 300_000 },
          ),
          `checkout of pinned runnerSha ${cfg.runnerSha}`,
        );
        pin = await resolvePin();
        const now = await head();
        if (!pin || now !== pin) {
          throw new Error(
            `remote sandbox bootstrap failed: checkout landed on ${now || "unknown"}, not pinned runnerSha ${cfg.runnerSha}`,
          );
        }
      }
    }
  }

  if (runnerCloneUrl) {
    need(
      await driver.exec(
        `git -C ${REMOTE_REPO} remote set-url origin ${shellQuoteWord(credentialFreeHttpsUrl(runnerCloneUrl))}`,
      ),
      "runner repo credential scrub",
    );
  }

  log("bun install (this is the slow part — several minutes cold)…");
  need(
    await driver.exec(
      `cd ${REMOTE_REPO} && HOME=${REMOTE_HOME} ${REMOTE_BUN} install --frozen-lockfile`,
      {
        timeoutMs: 900_000,
      },
    ),
    "bun install of the runner bundle",
  );
  need(
    await driver.exec(
      `mkdir -p ${REMOTE_HOME}/.local/bin && ` +
        `ln -sf ${REMOTE_REPO}/deploy/sandbox/opensession ${REMOTE_HOME}/.local/bin/opensession && ` +
        `chmod 755 ${REMOTE_REPO}/deploy/sandbox/opensession ${REMOTE_HOME}/.local/bin/opensession`,
    ),
    "workload identity client install",
  );
  log("compiling the single-file runner host…");
  need(
    await driver.exec(remoteRunnerInstallCommand(true), { timeoutMs: 600_000 }),
    "compiled runner host install",
  );

  log("ensuring claude CLI…");
  need(
    await driver.exec(
      `env PATH=${shellQuoteWord(REMOTE_PATH)} sh -c 'command -v claude >/dev/null 2>&1' || ` +
        `HOME=${REMOTE_HOME} BUN_INSTALL=${REMOTE_HOME}/.bun ${REMOTE_BUN} add -g @anthropic-ai/claude-code`,
      { timeoutMs: 300_000 },
    ),
    "claude CLI install",
  );

  need(
    await driver.exec(
      `mkdir -p ${REMOTE_HOME}/.claude && { test -s ${REMOTE_HOME}/.claude/settings.json || printf '{}' > ${REMOTE_HOME}/.claude/settings.json; }`,
    ),
    "~/.claude seed",
  );

  // NOTE: the Claude account pool is NOT uploaded here. Bootstrap is per
  // sandbox and knows nothing about the run, so it used to ship the FULL
  // store — including other users' personal subscriptions — to third-party
  // compute. The scoped upload now happens per launch in makeRemoteLauncher
  // (see the module header's credential note).

  need(
    await driver.exec(
      `printf '%s' ${shellQuoteWord(signature)} > ${BOOTSTRAP_MARKER}`,
    ),
    "bootstrap marker",
  );
  log("done");
}

// ── Workspace (always volume-style: cloned inside the sandbox) ───────────────

/** Where prewarmed workspace clones live in-sandbox until a session adopts
 *  them (warmRemoteWorkspace → setupRemoteWorkspace's mv). */
const REMOTE_WARM_BASE = `${REMOTE_HOME}/.bks-warm`;

const REMOTE_SEED_MANIFEST = ".agents/environment.json";
const MAX_REMOTE_SEED_FILE_BYTES = 1024 * 1024;
const MAX_REMOTE_SEED_TOTAL_BYTES = 4 * 1024 * 1024;

export interface RemoteWorkspaceSeedFile {
  path: string;
  content: string;
}

/**
 * Load the repo-owned list of private workspace files that should accompany a
 * remote clone. The manifest is read from the registered, operator-controlled
 * checkout (not the agent's branch), and every source must be a regular,
 * gitignored file below that checkout. This prevents a branch from requesting
 * arbitrary host files while keeping the zero-copy-path convention simple:
 *
 *   { "seedFiles": ["packages/web/.env.local"] }
 */
export function loadRemoteWorkspaceSeedFiles(repo: {
  id: string;
  repo: string;
  defaultBranch?: string;
}): RemoteWorkspaceSeedFile[] {
  // Registered checkouts can legitimately be parked on another session's
  // branch. Prefer the trusted remote-tracking default branch so a freshly
  // merged environment manifest applies immediately and an old branch cannot
  // keep requesting seed files that default has removed.
  let manifestText: string | null = null;
  if (repo.defaultBranch) {
    const ref = `refs/remotes/origin/${repo.defaultBranch}`;
    const refExists = Bun.spawnSync({
      cmd: [
        "git",
        "-C",
        repo.repo,
        "rev-parse",
        "--verify",
        "--quiet",
        `${ref}^{commit}`,
      ],
      stdout: "ignore",
      stderr: "ignore",
    });
    if (refExists.exitCode === 0) {
      const shown = Bun.spawnSync({
        cmd: ["git", "-C", repo.repo, "show", `${ref}:${REMOTE_SEED_MANIFEST}`],
        stdout: "pipe",
        stderr: "ignore",
      });
      if (shown.exitCode !== 0) return [];
      manifestText = shown.stdout.toString("utf-8");
    }
  }
  if (manifestText == null) {
    const manifestPath = resolve(repo.repo, REMOTE_SEED_MANIFEST);
    if (!existsSync(manifestPath)) return [];
    manifestText = readFileSync(manifestPath, "utf-8");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(
      `${repo.id} ${REMOTE_SEED_MANIFEST} is invalid JSON: ${(error as Error).message}`,
    );
  }
  const seedFiles = (raw as { seedFiles?: unknown })?.seedFiles;
  if (
    !Array.isArray(seedFiles) ||
    !seedFiles.every((file) => typeof file === "string")
  ) {
    throw new Error(
      `${repo.id} ${REMOTE_SEED_MANIFEST} must contain a string[] seedFiles`,
    );
  }

  const seen = new Set<string>();
  const loaded: RemoteWorkspaceSeedFile[] = [];
  let total = 0;
  for (const path of seedFiles) {
    if (
      !path ||
      isAbsolute(path) ||
      path.includes("\\") ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(
        `${repo.id} ${REMOTE_SEED_MANIFEST} has unsafe path ${JSON.stringify(path)}`,
      );
    }
    if (seen.has(path)) continue;
    seen.add(path);
    const source = resolve(repo.repo, path);
    const within = relative(repo.repo, source);
    if (!within || within.startsWith("..") || isAbsolute(within)) {
      throw new Error(`${repo.id} seed file escapes the checkout: ${path}`);
    }
    if (!existsSync(source)) {
      throw new Error(
        `${repo.id} requires local seed file ${path}; create it in ${repo.repo} before preparing a sandbox`,
      );
    }
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(
        `${repo.id} seed file must be a regular file, not a symlink: ${path}`,
      );
    }
    const ignored = Bun.spawnSync({
      cmd: ["git", "-C", repo.repo, "check-ignore", "-q", "--", path],
      stdout: "ignore",
      stderr: "ignore",
    });
    if (ignored.exitCode !== 0) {
      throw new Error(
        `${repo.id} seed file must be gitignored before upload: ${path}`,
      );
    }
    if (stat.size > MAX_REMOTE_SEED_FILE_BYTES) {
      throw new Error(`${repo.id} seed file exceeds 1 MiB: ${path}`);
    }
    total += stat.size;
    if (total > MAX_REMOTE_SEED_TOTAL_BYTES) {
      throw new Error(`${repo.id} seed files exceed the 4 MiB workspace limit`);
    }
    const content = readFileSync(source, "utf-8");
    if (content.includes("\0")) {
      throw new Error(`${repo.id} seed file must be text: ${path}`);
    }
    loaded.push({ path, content });
  }
  return loaded;
}

async function materializeRemoteWorkspaceSeedFiles(
  driver: RemoteDriver,
  cwd: string,
  repoId?: string,
): Promise<void> {
  if (!repoId) return;
  const { configuredRepos } = await import("../../config");
  const repo = configuredRepos()[repoId];
  if (!repo) throw new Error(`Unknown repo ${repoId}`);
  const files = loadRemoteWorkspaceSeedFiles(repo);
  for (const file of files) {
    const target = `${cwd}/${file.path}`;
    await driver.exec(`mkdir -p ${shellQuoteWord(dirname(target))}`);
    await driver.writeFile(target, file.content);
    const secured = await driver.exec(`chmod 600 ${shellQuoteWord(target)}`);
    if (secured.exitCode !== 0) {
      throw new Error(
        `could not secure remote seed file ${repoId}:${file.path}`,
      );
    }
  }
  if (files.length) {
    console.log(
      `[sandbox-remote] seeded ${files.length} private workspace file(s) for ${repoId}`,
    );
  }
}

export function remoteWarmWorkspaceDir(repoId: string): string {
  return `${REMOTE_WARM_BASE}/${sanitizeName(repoId)}`;
}

/**
 * Pre-clone a repo at its default branch (+ deps install) inside a PREWARM
 * sandbox, so the session that later adopts it skips the clone and most of
 * the bun install — the remote cousin of warm-template.ts's host seeding.
 * Runs only when the repo's warm-previews toggle is on (same Settings switch
 * as the host template); failures are non-fatal — the prewarm is still
 * adoptable, the workspace just sets up cold like today.
 */
export async function warmRemoteWorkspace(
  driver: RemoteDriver,
  repo: {
    id: string;
    repo: string;
    ghRepo?: string;
    defaultBranch: string;
    depsInstall?: string;
  },
  label: string,
  opts?: {
    installDeps?: boolean;
    runSetup?: boolean;
    identity?: Omit<WorkloadIdentityContext, "lifecycle">;
  },
): Promise<boolean> {
  const dir = remoteWarmWorkspaceDir(repo.id);
  const log = (msg: string) =>
    console.log(`[sandbox:${label}] warm workspace: ${msg}`);
  const has = await driver.exec(`test -d ${shellQuoteWord(dir)}/.git`);
  if (has.exitCode !== 0) {
    const url = await remoteCloneUrl(repo);
    log(`cloning ${redactUrl(url)} at ${repo.defaultBranch}…`);
    const clone = await driver.exec(
      `mkdir -p ${shellQuoteWord(dirname(dir))} && git clone --filter=blob:none -- ${shellQuoteWord(url)} ${shellQuoteWord(dir)}`,
      { timeoutMs: 600_000 },
    );
    if (clone.exitCode !== 0) {
      log(
        `clone failed (adoption will set up cold): ${redactUrl(clone.stderr.trim().slice(0, 300))}`,
      );
      return false;
    }
  }
  // Repository code must never observe the short-lived clone token through
  // remote.origin.url. Scrub before setup hooks or dependency installers run,
  // including when adopting an existing partially prepared warm checkout.
  await scrubRemoteWarmWorkspaceAuthority(driver, repo, dir);
  if (opts?.runSetup) {
    await runRemoteLifecycleHook(
      driver,
      dir,
      "setup",
      "fresh",
      repo.id,
      opts.identity,
    );
  }
  if (opts?.installDeps === false) {
    log(opts.runSetup ? "ready (post-setup)" : "ready (clone only)");
    return true;
  }
  // Deps: same convention as worktree.ts's installWorktreeDeps, expressed
  // in-sandbox (config depsInstall → root install when package.json exists).
  const bunEnv = `HOME=${REMOTE_HOME} PATH=${shellQuoteWord(REMOTE_PATH)}`;
  const deps = repo.depsInstall
    ? `cd ${shellQuoteWord(dir)} && ${bunEnv} sh -c ${shellQuoteWord(repo.depsInstall)}`
    : `cd ${shellQuoteWord(dir)} && ${bunEnv} sh -c 'if [ -f package.json ]; then ${REMOTE_BUN} install --frozen-lockfile; fi'`;
  log("installing deps…");
  const r = await driver.exec(deps, { timeoutMs: 900_000 });
  if (r.exitCode !== 0) {
    log(
      `deps install failed (non-fatal): ${(r.stderr || r.stdout).trim().slice(0, 300)}`,
    );
  } else {
    log("ready");
  }
  return true;
}

/** A provider snapshot is shared by future sessions, so it may never retain
 * the short-lived token used to clone a private repo. Adoption restores the
 * current scoped URL before fetching. Keep an inert origin (rather than
 * deleting it) so `git remote set-url origin …` stays deterministic. */
export async function scrubRemoteWarmWorkspaceAuthority(
  driver: RemoteDriver,
  repo: { id: string; ghRepo?: string },
  dir = remoteWarmWorkspaceDir(repo.id),
): Promise<void> {
  const safeOrigin = repo.ghRepo
    ? `https://github.com/${repo.ghRepo}.git`
    : "https://invalid.invalid/opensession-credential-scrubbed.git";
  // Also drop any stale git lock files so a snapshot published after an
  // interrupted git operation cannot poison every sandbox restored from it
  // ("index.lock: File exists" on the next refresh).
  const scrubbed = await driver.exec(
    `find .git -name "*.lock" -type f -delete 2>/dev/null; ` +
      `rm -f .git/opensession-adopted-by; ` +
      `git remote set-url origin ${shellQuoteWord(safeOrigin)}`,
    { cwd: dir },
  );
  if (scrubbed.exitCode !== 0) {
    throw new Error(
      `could not scrub clone authority from ${repo.id} repo template: ${scrubbed.stderr.trim().slice(0, 200)}`,
    );
  }
}

function warmWorkspaceAttachCommand(warmDir: string, cwd: string): string {
  // A symlink is durable across every provider's command namespace and keeps
  // realpath-sensitive build caches (notably ReScript's compiler-info) on the
  // exact path where the project image prepared them. Bind-mounting Daytona's
  // warm tree under a new real path invalidated all 3,165 compiled modules.
  return (
    `mkdir -p ${shellQuoteWord(dirname(cwd))} && ` +
    `rmdir ${shellQuoteWord(cwd)} 2>/dev/null || true; ` +
    `test ! -e ${shellQuoteWord(cwd)} && ` +
    `ln -s ${shellQuoteWord(warmDir)} ${shellQuoteWord(cwd)}`
  );
}

export async function setupRemoteWorkspace(
  driver: RemoteDriver,
  cwd: string,
  cloneUrl: string,
  branch: string,
  defaultBranch: string,
  repoId?: string,
  identity?: Omit<WorkloadIdentityContext, "lifecycle">,
  options: { seedPrivateFiles?: boolean; runLifecycleHooks?: boolean } = {},
): Promise<void> {
  const startedAt = Date.now();
  const mark = (stage: string) =>
    console.log(
      `[sandbox-remote] workspace ${repoId || cwd}: ${stage} (+${Date.now() - startedAt}ms)`,
    );
  const warmDir = repoId ? remoteWarmWorkspaceDir(repoId) : undefined;
  const probe = warmDir
    ? `if test -d ${shellQuoteWord(cwd)}/.git; then echo cwd; ` +
      `elif test -d ${shellQuoteWord(warmDir)}/.git; then echo warm; else echo none; fi`
    : `if test -d ${shellQuoteWord(cwd)}/.git; then echo cwd; else echo none; fi`;
  const workspaceState = (await driver.exec(probe)).stdout.trim();
  let adoptedBranchPrepared = false;
  let cloned = workspaceState === "cwd";
  if (!cloned && workspaceState === "warm" && warmDir && repoId) {
    // Adopt the snapshot's warm clone without moving its multi-gigabyte lazy
    // filesystem. Moving it hydrates every node_modules file (measured at
    // 155s for tella-fusion); a symlink also preserves prepared cache paths.
    const attach = warmWorkspaceAttachCommand(warmDir, cwd);
    const owner = `${warmDir}/.git/opensession-adopted-by`;
    const fetchRef = (ref: string) =>
      `git -C ${shellQuoteWord(cwd)} -c protocol.version=2 fetch --no-tags origin ` +
      `${shellQuoteWord(`+refs/heads/${ref}:refs/remotes/origin/${ref}`)} --quiet`;
    const cleanup =
      `sudo -n umount ${shellQuoteWord(cwd)} 2>/dev/null || true; ` +
      `if [ -L ${shellQuoteWord(cwd)} ]; then rm -f ${shellQuoteWord(cwd)}; ` +
      `else rmdir ${shellQuoteWord(cwd)} 2>/dev/null || true; fi`;
    // Attach, scoped credential restoration, and narrow branch sync remain one
    // provider round trip. If anything after attach fails, remove the mount or
    // symlink before the cold-clone fallback. Otherwise a transient warm fetch
    // failure poisons the fallback with an already-existing destination.
    const prepare =
      `{ if [ -f ${shellQuoteWord(owner)} ] && [ "$(cat ${shellQuoteWord(owner)})" != ${shellQuoteWord(cwd)} ]; then exit 73; fi; } && ` +
      `__rc=0; { (${attach}) && ` +
      `git -C ${shellQuoteWord(cwd)} remote set-url origin ${shellQuoteWord(cloneUrl)} && ` +
      `(if ${fetchRef(branch)}; then __start=${shellQuoteWord(`origin/${branch}`)}; else ` +
      `${fetchRef(defaultBranch)} && __start=${shellQuoteWord(`origin/${defaultBranch}`)}; fi; ` +
      `if [ "$(git -C ${shellQuoteWord(cwd)} rev-parse HEAD)" = "$(git -C ${shellQuoteWord(cwd)} rev-parse "$__start")" ]; then ` +
      `git -C ${shellQuoteWord(cwd)} update-ref ${shellQuoteWord(`refs/heads/${branch}`)} "$__start" && ` +
      `git -C ${shellQuoteWord(cwd)} symbolic-ref HEAD ${shellQuoteWord(`refs/heads/${branch}`)}; else ` +
      `git -C ${shellQuoteWord(cwd)} checkout -B ${shellQuoteWord(branch)} "$__start"; fi) && ` +
      `printf '%s\\n' ${shellQuoteWord(cwd)} > ${shellQuoteWord(owner)}; } || __rc=$?; ` +
      `if [ "$__rc" -ne 0 ]; then ${cleanup}; fi; exit "$__rc"`;
    const adopted = await driver.exec(prepare, { timeoutMs: 180_000 });
    if (adopted.exitCode === 0) {
      adoptedBranchPrepared = true;
      cloned = true;
      console.log(
        `[sandbox-remote] mounted warm workspace clone for ${repoId} at ${cwd}`,
      );
      mark("warm clone fetched");
    } else if (adopted.exitCode !== 73) {
      console.warn(
        `[sandbox-remote] warm workspace sync failed for ${repoId}; falling back to a clean clone: ` +
          `${(adopted.stderr || adopted.stdout).trim().slice(0, 300)}`,
      );
    }
  }
  if (!cloned) {
    console.log(`[sandbox-remote] cloning ${redactUrl(cloneUrl)} into ${cwd}`);
    // Blobless partial clone: full history/refs, with later blobs fetched via
    // a fresh run-scoped credential helper. A large repo's full .git can be
    // ~2.4GB vs ~450MB blobless — on a 10GiB sandbox disk that headroom is
    // the difference between working and ENOSPC (verified live 2026-07-09:
    // full clone died on the default 3GiB disk with an EMPTY git error,
    // because the fatal line itself couldn't be written to the full disk).
    const clone = await driver.exec(
      `mkdir -p ${shellQuoteWord(dirname(cwd))} && git clone --filter=blob:none -- ${shellQuoteWord(cloneUrl)} ${shellQuoteWord(cwd)}`,
      { timeoutMs: 600_000 },
    );
    if (clone.exitCode !== 0) {
      // A disk-full death is near-silent (git gets ENOSPC/SIGKILL and stderr
      // writes fail too) — check df and say so, instead of the bare
      // "Cloning into …" that sent us chasing credentials.
      const df = await driver.exec("df -h / | tail -1");
      const full = /\s(9[0-9]|100)%\s/.test(df.stdout);
      const detail = redactUrl(clone.stderr.trim().slice(0, 500));
      throw new Error(
        full
          ? `remote workspace clone failed: sandbox disk is full (${df.stdout.trim()}). ` +
              `The sandbox is too small for this repo — configure a bigger snapshot ` +
              `(daytona.snapshot in ~/.opensession-sandbox.json) and recreate the session.` +
              (detail ? ` git: ${detail}` : "")
          : `remote workspace clone failed: ${detail || "(no stderr)"}`,
      );
    }
  }
  const cur = adoptedBranchPrepared
    ? { exitCode: 0, stdout: branch, stderr: "" }
    : await driver.exec("git branch --show-current", { cwd });
  if (
    !adoptedBranchPrepared &&
    (cur.exitCode !== 0 || cur.stdout.trim() !== branch)
  ) {
    const hasRemote = await driver.exec(
      `git rev-parse --verify --quiet origin/${shellQuoteWord(branch)}`,
      { cwd },
    );
    const startPoint =
      hasRemote.exitCode === 0 ? `origin/${branch}` : `origin/${defaultBranch}`;
    const co = await driver.exec(
      `git checkout -B ${shellQuoteWord(branch)} ${shellQuoteWord(startPoint)}`,
      { cwd },
    );
    if (co.exitCode !== 0) {
      throw new Error(
        `remote workspace checkout -B ${branch} ${startPoint} failed: ${co.stderr.trim().slice(0, 300)}`,
      );
    }
  }
  mark("branch ready");
  // Installation tokens expire in about an hour. Keep them only for this
  // bounded clone/fetch, then leave a credential-free GitHub origin. Every run
  // projects a fresh token through the process-local credential helper below,
  // so lazy blob fetches and pushes never depend on a token at rest.
  if (isGithubHttpsUrl(cloneUrl)) {
    const safeOrigin = credentialFreeHttpsUrl(cloneUrl);
    const scrubbed = await driver.exec(
      `git remote set-url origin ${shellQuoteWord(safeOrigin)}`,
      { cwd },
    );
    if (scrubbed.exitCode !== 0)
      throw new Error(
        `could not scrub GitHub clone credential: ${scrubbed.stderr.trim().slice(0, 300)}`,
      );
  }
  // Per-session only: warm/template preparation never calls this path, so
  // private files are injected after restore and can never land in a shared
  // provider snapshot. Source-verification guests explicitly skip both seed
  // files and repository-controlled lifecycle hooks.
  if (options.seedPrivateFiles !== false) {
    await materializeRemoteWorkspaceSeedFiles(driver, cwd, repoId);
    mark("private files seeded");
  }
  if (options.runLifecycleHooks !== false) {
    await runRemoteLifecycleHook(
      driver,
      cwd,
      "setup",
      "fresh",
      repoId,
      identity,
    );
    mark("lifecycle ready");
  }
}

const REMOTE_LIFECYCLE_DIR = `${REMOTE_HOME}/.opensession/lifecycle`;

function remoteLifecycleKey(cwd: string): string {
  return cwd
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-120);
}

/** A source-image refresh changes the checked-out project after the original
 * setup stamp was captured. Clear that one stamp so the refreshed artifact
 * rebuilds generated output and dependency state before publication. */
export async function resetRemoteSetupLifecycleStamp(
  driver: RemoteDriver,
  scopeKey: string,
): Promise<void> {
  const key = remoteLifecycleKey(scopeKey) || "workspace";
  const stamp = `${REMOTE_LIFECYCLE_DIR}/${key}-setup.done`;
  const cleared = await driver.exec(`rm -f ${shellQuoteWord(stamp)}`);
  if (cleared.exitCode !== 0) {
    throw new Error(
      `could not reset ${scopeKey} setup stamp: ${cleared.stderr.trim()}`,
    );
  }
}

/** Run repo-owned lifecycle hooks inside a volume-only remote workspace.
 * `setup` is one-shot per durable sandbox disk; `resume` runs on every real
 * wake. Logs stay outside the repo so they never pollute git status. */
export async function runRemoteLifecycleHook(
  driver: RemoteDriver,
  cwd: string,
  hook: "setup" | "resume",
  bootMode: "fresh" | "resume",
  /** Stable repo identity lets a prewarmed workspace keep its one-shot setup
   * stamp after it is mounted at the adopting session's final cwd. */
  scopeKey?: string,
  identity?: Omit<WorkloadIdentityContext, "lifecycle">,
): Promise<{ ran: boolean; log: string }> {
  const script = `${cwd}/.agents/${hook}`;
  const key = remoteLifecycleKey(scopeKey || cwd) || "workspace";
  const log = `${REMOTE_LIFECYCLE_DIR}/${key}-${hook}.log`;
  const stamp = `${REMOTE_LIFECYCLE_DIR}/${key}-setup.done`;
  const inspectCommand =
    hook === "setup"
      ? `if [ -f ${shellQuoteWord(stamp)} ]; then echo stamped; elif [ -e ${shellQuoteWord(script)} ]; then echo present; else echo absent; fi`
      : `if [ -e ${shellQuoteWord(script)} ]; then echo present; else echo absent; fi`;
  const readProbe = async (command: string) => {
    let result = await driver.exec(command);
    const detail = `${result.stderr} ${result.stdout}`;
    if (
      result.exitCode !== 0 &&
      /(?:operation )?timed? ?out|timeout|temporar|connection|socket|transport/i.test(
        detail,
      )
    ) {
      // Provider command transports can transiently stall immediately after a
      // snapshot wake. These probes are read-only and therefore safe to retry;
      // the lifecycle hook itself is deliberately never retried here.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await driver.ensureStarted();
      result = await driver.exec(command);
    }
    return result;
  };
  const probe = await readProbe(inspectCommand);
  if (probe.exitCode !== 0)
    throw new Error(
      `could not inspect .agents/${hook}: ${probe.stderr.trim()}`,
    );
  const state = probe.stdout.trim();
  if (state === "stamped" || state === "absent") return { ran: false, log };
  const executable = await readProbe(`test -x ${shellQuoteWord(script)}`);
  if (executable.exitCode !== 0)
    throw new Error(`.agents/${hook} exists but is not executable`);
  const identityEnv = identity
    ? createWorkloadIdentityEnv({ ...identity, lifecycle: hook })
    : {};
  const identityArgs = Object.entries(identityEnv)
    .map(([key, value]) => `${key}=${shellQuoteWord(value)}`)
    .join(" ");
  // Setup hooks prepare immutable shared images. A repository-owned `bun
  // install` must therefore resolve dependencies without rewriting bun.lock.
  // Keep this guard scoped to setup so ordinary agent/developer Bun behavior
  // is unchanged, and use a PATH shim rather than requiring every repository
  // to learn an Open Session-specific flag.
  const setupBin = `${REMOTE_LIFECYCLE_DIR}/setup-bin`;
  const bunShim = `#!/bin/sh\nif [ "$1" = install ]; then shift; exec ${REMOTE_BUN} install --frozen-lockfile "$@"; fi\nexec ${REMOTE_BUN} "$@"\n`;
  const setupGuard =
    hook === "setup"
      ? `mkdir -p ${shellQuoteWord(setupBin)} && printf %s ${shellQuoteWord(bunShim)} > ${shellQuoteWord(`${setupBin}/bun`)} && chmod 755 ${shellQuoteWord(`${setupBin}/bun`)} && `
      : "";
  const lifecyclePath =
    hook === "setup" ? `${setupBin}:${REMOTE_PATH}` : REMOTE_PATH;
  const command =
    `mkdir -p ${shellQuoteWord(REMOTE_LIFECYCLE_DIR)} && ` +
    setupGuard +
    `: > ${shellQuoteWord(log)} && ` +
    `env HOME=${REMOTE_HOME} PATH=${shellQuoteWord(lifecyclePath)} ${identityArgs} ` +
    `OPENSESSION_BOOT_MODE=${shellQuoteWord(bootMode)} ${shellQuoteWord(script)} ` +
    `>> ${shellQuoteWord(log)} 2>&1` +
    (hook === "setup" ? ` && touch ${shellQuoteWord(stamp)}` : "");
  const result = await driver.exec(command, { cwd, timeoutMs: 20 * 60_000 });
  if (result.exitCode !== 0) {
    const tail = await driver.exec(
      `tail -80 ${shellQuoteWord(log)} 2>/dev/null || true`,
    );
    const detail = (tail.stdout || tail.stderr).trim().slice(-4_000);
    throw new Error(
      `.agents/${hook} failed with exit ${result.exitCode}; see ${log}` +
        (detail ? `\n${detail}` : ""),
    );
  }
  return { ran: true, log };
}

// ── Run launching (WS transport only — there is no socket option remotely) ───

function sessionRunsDir(sessionId: string): string {
  return `${RUNS_BASE}/${sanitizeName(sessionId)}`;
}

function readJsonSafe<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * HostLauncher over a RemoteDriver. Run-dir paths are identical host-side and
 * in-sandbox: spec.json exists in BOTH (host mirror feeds restart-resume;
 * the in-sandbox copy feeds HOST_ENTRY), meta/journal/log are sandbox-only.
 */
function makeRemoteLauncher(
  driver: RemoteDriver,
  sessionId: string,
  sandboxId: string,
  provider: SandboxProviderId,
  callbackBaseUrl = remoteSandboxCallbackBaseUrl(),
): HostLauncher {
  return {
    async alive(dir) {
      const meta = await driver.exec(
        `cat ${shellQuoteWord(`${dir}/meta.json`)} 2>/dev/null`,
      );
      if (meta.exitCode !== 0) return false;
      let pid = 0;
      try {
        pid = Number(JSON.parse(meta.stdout)?.pid) || 0;
      } catch {}
      if (!pid) return false;
      return (await driver.exec(`kill -0 ${pid}`)).exitCode === 0;
    },
    newRunDir: (hostId) =>
      `${sessionRunsDir(sessionId)}/${sanitizeName(hostId)}`,
    connector: (_dir, spec) =>
      spec.wsToken ? runWsConnector(spec.hostId) : undefined,
    async writeSpec(dir, spec) {
      mkdirSync(dir, { recursive: true });
      writeJsonAtomic(`${dir}/${HOST_SPEC_NAME}`, spec, true, 0o600); // host mirror (resume)
      const mk = await driver.exec(`mkdir -p ${shellQuoteWord(dir)}`);
      if (mk.exitCode !== 0) {
        throw new Error(
          `remote run dir create failed: ${mk.stderr.trim().slice(0, 300)}`,
        );
      }
      const guestSpecPath = `${dir}/${HOST_SPEC_NAME}`;
      await driver.writeFile(guestSpecPath, JSON.stringify(spec));
      const secured = await driver.exec(
        `chmod 600 ${shellQuoteWord(guestSpecPath)}`,
      );
      if (secured.exitCode !== 0) {
        throw new Error(
          `remote run spec chmod failed: ${secured.stderr.trim().slice(0, 300)}`,
        );
      }
    },
    async launch(hostId, dir, onDispatching) {
      let dispatchAttempted = false;
      const spec = readJsonSafe<RunHostSpec>(`${dir}/${HOST_SPEC_NAME}`);
      if (!spec?.wsToken) {
        throw new Error(
          `remote launch of ${hostId}: spec.json (with wsToken) missing from ${dir}`,
        );
      }
      // Per-step timing marks: when a provider SDK call stalls (see the
      // bounded execBackground below), the last mark names the culprit.
      const t0 = Date.now();
      const mark = (step: string) =>
        console.log(
          `[sandbox-remote] launch ${hostId.slice(0, 11)}: ${step} (+${Date.now() - t0}ms)`,
        );
      await driver.ensureStarted();
      mark("sandbox started");
      const secureFiles: string[] = [];
      const secureDirectories: string[] = [];
      const automationProfile = spec.trustProfile === "automation";
      if (automationProfile && !spec.accountId) {
        throw new Error(
          "automation sandbox runs require a pinned model account",
        );
      }
      // Scoped Claude account upload. A run whose reachable model walk never
      // enters Anthropic receives no Claude token. Otherwise an explicit pin
      // narrows every trust profile, and the guest record drops host-only and
      // unknown fields before serialization.
      const usesAnthropic = remoteRunNeedsAnthropic(
        spec.model,
        spec.fallbackModel,
      );
      const accounts = usesAnthropic
        ? projectRemoteClaudeAccounts(
            accountsForRemoteUpload(spec.user, spec.accountId),
          )
        : [];
      if (
        automationProfile &&
        usesAnthropic &&
        !accounts.some((account) => account.id === spec.accountId)
      ) {
        throw new Error(
          "the pinned automation account is not an eligible Claude account",
        );
      }
      // Resolve the run's MCP allowlist and dynamic credentials on the trusted
      // host, then project only those entries. Remote guests never receive the
      // instance-wide mcp-config.json. Automation specs are required to carry
      // an explicit array (including [] for no external connectors).
      if (automationProfile && spec.mcpServers === "all") {
        throw new Error(
          "automation sandbox runs require an explicit MCP allowlist",
        );
      }
      const projectedMcp = filterMcpServers(
        spec.mcpServers ?? "all",
        spec.user,
        [spec.mcpGrantUser, spec.user],
      );
      const claudeAccountsPath = `${REMOTE_HOME}/.opensession-claude-accounts.json`;
      await Promise.all([
        driver.writeFile(
          claudeAccountsPath,
          JSON.stringify({ accounts }, null, 2) + "\n",
        ),
        driver.writeFile(
          REMOTE_MCP_CONFIG,
          JSON.stringify({ mcpServers: projectedMcp }, null, 2) + "\n",
        ),
      ]);
      secureFiles.push(claudeAccountsPath, REMOTE_MCP_CONFIG);

      // GitHub credentials are projected through a private, run-scoped file,
      // never spec.json, argv, or the persisted origin. Interactive runs prefer
      // their user's token. GitHub code automations and user-less interactive
      // runs receive a freshly resolved service credential for this one repo;
      // every other automation stays credential-free.
      let githubAuth = automationProfile
        ? {}
        : githubAuthEnv(spec.user || spec.author?.name);
      const githubCodeAutomation =
        automationProfile &&
        spec.mode === "code" &&
        (spec.journalKind || "").startsWith("github-");
      if (
        !githubAuth.GH_TOKEN &&
        (!automationProfile || githubCodeAutomation)
      ) {
        // The sandbox origin is mutable by repository setup code. Bind service
        // authority only to the server-owned repo id recorded at ensure time.
        const repoId = readRemoteState(provider, sandboxId)?.repoId;
        const registeredRepo = repoId
          ? (await import("../../worktree")).getRepo(repoId)
          : undefined;
        if (registeredRepo?.host !== "codestorage" && registeredRepo?.ghRepo) {
          const { githubServiceCredentialEnv } =
            await import("../../github-app");
          githubAuth = await githubServiceCredentialEnv(registeredRepo.ghRepo);
        }
      }
      const githubAuthPath = `${dir}/github-auth.json`;
      if (githubAuth.GH_TOKEN) {
        await driver.writeFile(githubAuthPath, JSON.stringify(githubAuth));
        secureFiles.push(githubAuthPath);
      } else {
        await driver.exec(`rm -f ${shellQuoteWord(githubAuthPath)}`);
      }
      // Pi policy + provider config, projected at the sandbox boundary.
      // The source CAN contain third-party API keys under providers.*.apiKey;
      // never copy it wholesale. Anthropic/OpenAI/Pi launches receive only the
      // bridge/runtime fields. Pi-other receives the configured
      // third-party provider scope because its fallback walk can switch within
      // one runner-host launch. Rewritten/removed every launch so stale wider
      // authority cannot linger on a reused sandbox.
      const ocCfgSrc =
        process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG ||
        // Dual-read the host path (a new-name-only host has no
        // ~/.opensession-pi.json); the remote destination below stays the
        // legacy name the in-sandbox build dual-reads.
        stateDir("model-providers.json");
      let settingsProviderIds: string[] = [];
      if (existsSync(ocCfgSrc)) {
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(ocCfgSrc, "utf-8"));
        } catch (error) {
          throw new Error(
            `Cannot project sandbox Pi config ${ocCfgSrc}: ${error}`,
          );
        }
        const projected = projectRemoteModelProviderConfig(
          raw,
          spec.model,
          spec.trustProfile,
          spec.accountId,
          spec.fallbackModel,
        );
        settingsProviderIds = projected.settingsProviderIds;
        await driver.writeFile(
          REMOTE_MODEL_PROVIDERS_CONFIG,
          projected.content,
        );
        secureFiles.push(REMOTE_MODEL_PROVIDERS_CONFIG);
      } else {
        await driver.exec(
          `rm -f ${shellQuoteWord(REMOTE_MODEL_PROVIDERS_CONFIG)}`,
        );
      }

      // Pi stays architecturally in-process: the guest runner-host imports the
      // normal runAgent/runPi path. Materialize only the current Pi gate and
      // transport policy; its credentials are the scoped Claude/Codex stores
      // uploaded alongside this file.
      const piContent = projectRemotePiConfig(readPiEngineConfig());
      if (piContent) {
        await driver.writeFile(REMOTE_PI_CONFIG, piContent);
        secureFiles.push(REMOTE_PI_CONFIG);
      } else {
        await driver.exec(`rm -f ${shellQuoteWord(REMOTE_PI_CONFIG)}`);
      }

      // OpenAI/ChatGPT-subscription material for pi/openai/* dispatched
      // IN-SANDBOX. The raw CODEX_HOME/auth.json is NEVER uploaded — its
      // refresh token is the one rotating family shared with the host codex
      // CLI, and an in-sandbox refresh would rotate (= kill) the host copy.
      // Instead: (a) a scoped codex-accounts store so pickOpenaiAccount
      // in-sandbox applies the same pool/openaiAccounts rules, and (b) a raw
      // key only for a selected API-key account, or the rotation-proof SEEDED
      // artifact per home account (access-token-only plus an invalid placeholder
      // refresh, built by buildOpenaiRemoteSeedUpload). Upload it
      // only when the selected model or its configured fallback can use
      // OpenAI. The fallback walk runs inside this same host, so waiting until
      // that hop would leave it without credentials.
      // Rewritten (or removed) per launch so restriction changes apply and a
      // previously-uploaded wider set never lingers. Destination filenames
      // stay the legacy .opensession-* names the (dual-reading) in-sandbox
      // build resolves — same convention as the bridge config above.
      const usesOpenai = remoteRunNeedsOpenai(spec.model, spec.fallbackModel);
      const openaiUpload: ReturnType<typeof buildOpenaiRemoteSeedUpload> =
        usesOpenai
          ? buildOpenaiRemoteSeedUpload(
              listCodexAccounts(),
              spec.accountId
                ? [spec.accountId]
                : readModelProviderConfig()?.openaiAccounts,
              spec.user,
            )
          : { accounts: [], seeds: [], skipped: [] };
      if (
        automationProfile &&
        usesOpenai &&
        !openaiUpload.accounts.some((account) => account.id === spec.accountId)
      ) {
        throw new Error(
          "the pinned automation account is not an eligible OpenAI account",
        );
      }
      for (const { account, reason } of openaiUpload.skipped) {
        console.warn(
          `[sandbox-remote] openai seed for ${maskOpenaiAccount(account)} skipped: ${reason}`,
        );
      }
      const codexStorePath = `${REMOTE_HOME}/.opensession-codex-accounts.json`;
      if (openaiUpload.accounts.length) {
        await driver.writeFile(
          codexStorePath,
          JSON.stringify({ accounts: openaiUpload.accounts }, null, 2) + "\n",
        );
        secureFiles.push(codexStorePath);
        // Fresh seed dir per launch. Create every parent in one command, then
        // use providers' native file lanes concurrently and secure all launch
        // material in one final chmod. This avoids serial command admission on
        // Box without ever launching the host before permissions settle.
        const seeds = openaiUpload.seeds.map((seed) => ({
          path: openaiSeedAuthPath(REMOTE_OPENAI_SEED_DIR, seed.accountId),
          content: seed.content,
        }));
        const seedDirectories = [
          REMOTE_OPENAI_SEED_DIR,
          ...seeds.map((seed) => dirname(seed.path)),
        ];
        await driver.exec(
          `rm -rf ${shellQuoteWord(REMOTE_OPENAI_SEED_DIR)} && mkdir -p ${seedDirectories.map(shellQuoteWord).join(" ")}`,
        );
        await Promise.all(
          seeds.map((seed) => driver.writeFile(seed.path, seed.content)),
        );
        secureFiles.push(...seeds.map((seed) => seed.path));
        secureDirectories.push(...seedDirectories);
        audit({
          msg: "sandbox_openai_seed_upload",
          host_id: spec.hostId,
          session_id: spec.osSessionId,
          mechanism: "scoped-openai-account-remote",
          accounts: openaiUpload.accounts.map((a) => maskOpenaiAccount(a)),
          oauth_seeds: openaiUpload.seeds.length,
          api_key_accounts: openaiUpload.accounts.filter(
            (a) => a.kind === "api_key",
          ).length,
          skipped: openaiUpload.skipped.map(
            (s) => `${maskOpenaiAccount(s.account)}: ${s.reason}`,
          ),
        });
      } else {
        await driver.exec(
          `rm -f ${codexStorePath} && rm -rf ${shellQuoteWord(REMOTE_OPENAI_SEED_DIR)}`,
        );
      }
      const secured = await driver.exec(
        [
          secureDirectories.length
            ? `chmod 700 ${[...new Set(secureDirectories)].map(shellQuoteWord).join(" ")}`
            : "",
          secureFiles.length
            ? `chmod 600 ${[...new Set(secureFiles)].map(shellQuoteWord).join(" ")}`
            : "",
        ]
          .filter(Boolean)
          .join(" && "),
      );
      if (secured.exitCode !== 0) {
        throw new Error(
          `could not secure remote launch material: ${secured.stderr.trim().slice(0, 300)}`,
        );
      }
      mark("accounts uploaded");
      // Remote sandboxes default to the public ingress when it is enabled.
      // Local providers can override this with their internal/tailnet base so
      // runs do not hairpin through the internet-facing ingress.
      const base = callbackBaseUrl.replace(/\/+$/, "");
      registerRunWsHost(hostId, spec.wsToken);
      try {
        const env: Record<string, string> = {
          HOME: REMOTE_HOME,
          PATH: REMOTE_PATH,
          NODE_ENV: "production",
          OPENSESSION_MCP_CONFIG: REMOTE_MCP_CONFIG,
          OPENSESSION_RUN_JOURNAL: `${dir}/journal.json`,
          // Where bindOpenaiAccount finds the uploaded rotation-proof openai
          // seeds (only set when something was uploaded this launch).
          ...(openaiUpload.seeds.length
            ? {
                OPENSESSION_OPENAI_SEED_DIR: REMOTE_OPENAI_SEED_DIR,
              }
            : {}),
          // Dial-back on the primary prefix — the ingress/main serve accept
          // both, and URLs already baked into live sandboxes stay valid.
          OPENSESSION_RUN_WS_URL: `${base}/run-ws/${hostId}`,
          OPENSESSION_RUN_WS_TOKEN: spec.wsToken,
          OPENSESSION_RPC_WS_URL: `${base}/rpc-ws`,
          ...(githubAuth.GH_TOKEN
            ? { [GITHUB_RUN_AUTH_FILE_ENV]: githubAuthPath }
            : {}),
          ...createWorkloadIdentityEnv({
            sandboxId,
            provider,
            lifecycle: "run",
            sessionId: spec.osSessionId,
            trustProfile: spec.trustProfile,
          }),
          ...(process.env.OPENSESSION_MODEL
            ? { OPENSESSION_MODEL: process.env.OPENSESSION_MODEL! }
            : {}),
        };
        // BOUNDED await: provider SDK calls have stalled indefinitely here in
        // the wild (2026-07-09: a Daytona executeSessionCommand response never
        // resolved even though the command RAN — the host started, dialed
        // back, streamed its whole run, and every frame sat parked because
        // this await never returned, so connectWithWait never started). The
        // detached command's delivery is verified by the dial-back
        // (connectWithWait) anyway — after the bound, proceed and let that
        // decide.
        dispatchAttempted = true;
        onDispatching?.();
        const bg = driver.execBackground(
          `${envPrefix(env)}sh -c ${shellQuoteWord(remoteRunnerHostCommand(`${dir}/${HOST_SPEC_NAME}`))} >> ${dir}/host.log 2>&1`,
        );
        const bgTimeout = new Promise<"timeout">((r) =>
          setTimeout(() => r("timeout"), 30_000),
        );
        const raced = await Promise.race([
          bg.then(() => "ok" as const),
          bgTimeout,
        ]);
        if (raced === "timeout") {
          console.warn(
            `[sandbox-remote] execBackground for ${hostId.slice(0, 11)} still pending after 30s — ` +
              "proceeding to the dial-back wait (the launch command may have been delivered anyway)",
          );
          bg.catch(() => {}); // don't let the eventual settle become an unhandled rejection
        }
        mark("host exec dispatched");
      } catch (e) {
        if (!dispatchAttempted) unregisterRunWsHost(hostId);
        throw e;
      }
    },
    async evidence(dir) {
      const [metaResult, journalResult] = await Promise.all([
        driver.exec(
          `cat ${shellQuoteWord(`${dir}/${HOST_META_NAME}`)} 2>/dev/null`,
        ),
        driver.exec(
          `cat ${shellQuoteWord(`${dir}/${HOST_JOURNAL_NAME}`)} 2>/dev/null`,
        ),
      ]);
      let meta: RunHostMeta | undefined;
      let journal: Record<string, ActiveRunRecord> | undefined;
      try {
        if (metaResult.exitCode === 0) meta = JSON.parse(metaResult.stdout);
      } catch {}
      try {
        if (journalResult.exitCode === 0)
          journal = JSON.parse(journalResult.stdout);
      } catch {}
      return {
        started: !!meta?.pid || !!journal,
        ...(meta?.engineSessionId
          ? { engineSessionId: meta.engineSessionId }
          : {}),
        ...(meta?.done ? { done: meta.done } : {}),
      };
    },
    async stop(hostId, dir) {
      await driver.writeFile(`${dir}/cancelled`, "cancelled\n");
      const [metaResult, startupResult] = await Promise.all([
        driver.exec(
          `cat ${shellQuoteWord(`${dir}/${HOST_META_NAME}`)} 2>/dev/null`,
        ),
        driver.exec(`cat ${shellQuoteWord(`${dir}/startup.json`)} 2>/dev/null`),
      ]);
      let pid = 0;
      try {
        if (metaResult.exitCode === 0)
          pid = Number(JSON.parse(metaResult.stdout)?.pid) || 0;
      } catch {}
      try {
        if (!pid && startupResult.exitCode === 0)
          pid = Number(JSON.parse(startupResult.stdout)?.pid) || 0;
      } catch {}
      if (pid) {
        const specPath = `${dir}/${HOST_SPEC_NAME}`;
        const quotedSpec = shellQuoteWord(specPath);
        const script =
          `is_host() { [ -r /proc/${pid}/cmdline ] && ` +
          `tr '\\0' '\\n' < /proc/${pid}/cmdline | grep -Fqx -- ${quotedSpec}; }; ` +
          `is_host && kill -TERM ${pid} 2>/dev/null || true; sleep 1; ` +
          `is_host && kill -KILL ${pid} 2>/dev/null || true; sleep 0.2; ! is_host`;
        const result = await driver.exec(script);
        if (result.exitCode !== 0)
          throw new Error(
            `Could not prove remote sandbox host ${hostId} absent`,
          );
      }
      unregisterRunWsHost(hostId);
    },
  };
}

// ── Journal bookkeeping (opensession side; mirrors docker's) ────────────────────

function recordForSpec(
  spec: RunHostSpec,
  sandboxId: string,
  provider: SandboxProviderId,
): ActiveRunRecord {
  return {
    runKey: spec.hostId,
    osSessionId: spec.osSessionId,
    claudeSessionId: spec.engineSessionId,
    prompt: spec.prompt,
    promptEntryId: spec.promptEntryId,
    cwd: spec.cwd,
    mode: spec.mode,
    mcpServers: spec.mcpServers,
    user: spec.user,
    deniedTools: spec.deniedTools,
    confirmTools: spec.confirmTools,
    aws: spec.aws,
    model: spec.model,
    selectedModel: spec.selectedModel ?? spec.model,
    transientFallback: spec.transientFallback,
    effort: spec.effort,
    fastMode: spec.fastMode,
    accountId: spec.accountId,
    accountStrict: spec.accountStrict,
    usageCredits: spec.usageCredits,
    fallbackModel: spec.fallbackModel,
    sandboxId,
    sandboxProvider: provider,
    launchPhase: "prepared",
    trustProfile: spec.trustProfile,
    kind: spec.journalKind || "prompt",
    firstJournaledAt: spec.firstJournaledAt,
    resumeAttempts: spec.resumeAttempts,
    lastResumeAt: spec.lastResumeAt,
    startedAt: new Date().toISOString(),
  };
}

async function* withRunJournal(
  events: AsyncGenerator<StreamEvent>,
  record: ActiveRunRecord,
  touch: () => void,
): AsyncGenerator<StreamEvent> {
  await journalSet(record);
  touch();
  let sourceCompleted = false;
  let sawTerminal = false;
  try {
    for await (const ev of events) {
      if (
        ev.type === "init" &&
        ev.sessionId &&
        ev.sessionId !== record.claudeSessionId
      ) {
        record.claudeSessionId = ev.sessionId;
        await journalSet(record);
      }
      if (ev.type === "model_switch" && ev.toModel) {
        record.model = ev.toModel;
        record.transientFallback = ev.temporaryFallback === true;
        if (shouldPersistModelSwitch(ev)) record.selectedModel = ev.toModel;
        await journalSet(record);
      }
      if (ev.type === "done" || ev.type === "error") sawTerminal = true;
      yield ev;
    }
    sourceCompleted = true;
  } finally {
    if (sourceCompleted && sawTerminal) journalClear(record.runKey);
    else if (sourceCompleted) await journalRecordAbnormalCompletion(record);
    touch();
  }
}

// ── The Sandbox handle ────────────────────────────────────────────────────────

export interface RemoteSandboxParts {
  providerId: SandboxProviderId;
  sandboxId: string;
  sessionId: string;
  cwd: string;
  driver: RemoteDriver;
  /** Override the public-ingress default for providers that can reach the
   *  server over a private/local route (notably local Firecracker). */
  callbackBaseUrl?: string;
  ports(requestedPorts?: number[]): Promise<PortMap>;
  status(): Promise<SandboxStatus>;
  /** Activity ping (state file + provider-native keepalive, e.g. E2B's
   *  countdown extension). Called at run start/end. */
  touchActivity(): void | Promise<void>;
}

/** Internal accessor resume uses to reach a handle's driver/launcher. */
const remoteParts = new WeakMap<
  object,
  { driver: RemoteDriver; launcher: HostLauncher }
>();

export function makeRemoteSandbox(parts: RemoteSandboxParts): Sandbox {
  const launcher = makeRemoteLauncher(
    parts.driver,
    parts.sessionId,
    parts.sandboxId,
    parts.providerId,
    parts.callbackBaseUrl,
  );
  const touch = () => {
    try {
      void parts.touchActivity();
    } catch {}
  };
  const sandboxHandle: Sandbox = {
    id: parts.sandboxId,
    provider: parts.providerId,
    cwd: parts.cwd,
    workspace: "volume",

    async exec(cmd: string[], opts?: ExecOpts): Promise<ExecResult> {
      await parts.driver.ensureStarted();
      touch();
      const remoteOptions = {
        cwd: parts.cwd,
        env: {
          ...createWorkloadIdentityEnv({
            sandboxId: parts.sandboxId,
            provider: parts.providerId,
            lifecycle: "run" as const,
            sessionId: parts.sessionId,
          }),
          ...opts?.env,
        },
        timeoutMs: opts?.timeoutMs,
      };
      if (opts?.background) {
        try {
          await parts.driver.execBackground(shellQuote(cmd), remoteOptions);
          touch();
          return { exitCode: 0, stdout: "", stderr: "" };
        } catch (error) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
          };
        }
      }
      const result = await parts.driver.exec(shellQuote(cmd), remoteOptions);
      touch();
      return result;
    },

    async launchRunEager(
      spec: RunHostSpec,
      cb?: RunHandleCallbacks,
    ): Promise<RunHandle> {
      const dir = launcher.newRunDir(spec.hostId);
      const callbacks: HandleCallbacks = {
        onAskUser: cb?.onAskUser,
        onSteerFailed: cb?.onSteerFailed,
      };
      spec.wsToken ??= crypto.randomUUID(); // remote runs are always WS
      const record = recordForSpec(spec, parts.sandboxId, parts.providerId);
      let handle: HostHandle | undefined;
      let uncertainLaunch = false;
      const t0 = Date.now();
      const mark = (step: string) =>
        console.log(
          `[sandbox-remote] launch ${spec.hostId.slice(0, 11)}: ${step} (+${Date.now() - t0}ms)`,
        );
      try {
        await launcher.writeSpec!(dir, spec);
        mark("spec written");
        // A crash after journal admission must recover from the full spec.
        await journalSet(record);
        // Construct (and register) the control BEFORE dispatch so exact-token
        // Stop reaches the launching host: cancelAgentRunTokenAndWait sees
        // hostRunBusy(token) during the launch await, and cancelHost's stop
        // backstop plus the cancelled startup marker fence the dispatch race.
        handle = new HostHandle(dir, spec, callbacks, launcher);
        await launcher.launch(spec.hostId, dir, async () => {
          record.launchPhase = "launching";
          await journalSet(record);
        });
        record.launchPhase = "started";
        await journalSet(record);
        if (handle.cancelled)
          throw new HostLaunchNotDispatchedError(
            `${spec.hostId} was cancelled while launching`,
          );
        await handle.connectWithWait(45_000);
        mark("host attached");
      } catch (error) {
        // A cancelled launch is provably absent (startup marker or stop
        // backstop), exactly like a never-dispatched one: retire it instead
        // of handing an ended handle to uncertain-launch reconciliation.
        if (
          record.launchPhase === "prepared" ||
          error instanceof HostLaunchNotDispatchedError ||
          // A stop backstop that proved absence during the launch/connect
          // await already finished this handle: retire it like a
          // never-dispatched launch instead of reconciling an ended owner.
          handle?.ended === true
        ) {
          journalClearIfLineage(record);
          handle?.abandon();
          unregisterRunToken(spec.rpcToken);
          unregisterRunWsHost(spec.hostId);
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {}
          throw error;
        }
        // execBackground may have delivered the command. Transfer the
        // retained artifacts to a live owner that keeps reconciling now.
        uncertainLaunch = true;
        handle ??= new HostHandle(dir, spec, callbacks, launcher);
        console.warn(
          `[sandbox-remote] ${spec.hostId}: launch outcome uncertain; waiting for host attachment`,
          error,
        );
      }
      const ownedHandle = handle!;
      const rawEvents = uncertainLaunch
        ? reconcileUncertainHostEvents(ownedHandle, "Remote sandbox host")
        : ownedHandle.events();
      const gen = withRunJournal(rawEvents, record, touch);
      // Steers fold into the running turn in-sandbox, so they never come back
      // as dial-back user frames — mirror DELIVERED steers into the current
      // engine-session file (same reconcile contract as the dispatch prompt).
      return {
        events: () => gen,
        steerable: modelSupportsSteer(spec.model),
        steer: (text, images) => hostSteer(spec.osSessionId, text, images),
        interruptSteer: (text, images) =>
          hostInterruptSteer(spec.osSessionId, text, images),
        cancel: () => hostCancel(spec.osSessionId),
      };
    },

    launchRun(spec: RunHostSpec, cb?: RunHandleCallbacks): RunHandle {
      const gen = (async function* (): AsyncGenerator<StreamEvent> {
        let eager: RunHandle;
        try {
          eager = await sandboxHandle.launchRunEager!(spec, cb);
        } catch (e: any) {
          yield {
            type: "error",
            content: `Sandbox run failed to start: ${e?.message || e}`,
          };
          return;
        }
        yield* eager.events();
      })();
      return {
        events: () => gen,
        steerable: modelSupportsSteer(spec.model),
        steer: (text, images) => hostSteer(spec.osSessionId, text, images),
        interruptSteer: (text, images) =>
          hostInterruptSteer(spec.osSessionId, text, images),
        cancel: () => hostCancel(spec.osSessionId),
      };
    },

    ports: (requestedPorts) => parts.ports(requestedPorts),
    status: () => parts.status(),
  };
  remoteParts.set(sandboxHandle, { driver: parts.driver, launcher });
  return sandboxHandle;
}

// ── Restart-resume (mirrors resumeDockerSandboxRun; see module header for
//    the meta.json gap) ────────────────────────────────────────────────────────

export async function resumeRemoteSandboxRun(
  run: ActiveRunRecord,
  cb: HandleCallbacks,
): Promise<AsyncGenerator<StreamEvent> | null> {
  if (!run.sandboxId || !run.osSessionId || !run.sandboxProvider) return null;
  // Lazy to avoid a static import cycle (index → adapters → bootstrap).
  const { getSandboxProvider } = await import("../index");
  let sandbox: Sandbox | null = null;
  try {
    sandbox = await getSandboxProvider(run.sandboxProvider).get(run.sandboxId);
  } catch (e) {
    console.warn(
      `[sandbox-remote] resume: provider.get(${run.sandboxId}) failed:`,
      e,
    );
  }
  if (!sandbox) return null;
  const parts = remoteParts.get(sandbox);
  if (!parts) return null;
  const { driver, launcher } = parts;
  // Remote providers may preserve processes while suspended. Wake the sandbox
  // before checking meta/aliveness so restart recovery never duplicates a run.
  await driver.ensureStarted();

  const oldDir = launcher.newRunDir(run.runKey);
  const oldSpec = readJsonSafe<RunHostSpec>(`${oldDir}/${HOST_SPEC_NAME}`);
  const metaResult = await driver.exec(
    `cat ${shellQuoteWord(`${oldDir}/${HOST_META_NAME}`)} 2>/dev/null`,
  );
  const journalResult = await driver.exec(
    `cat ${shellQuoteWord(`${oldDir}/${HOST_JOURNAL_NAME}`)} 2>/dev/null`,
  );
  let remoteMeta: RunHostMeta | undefined;
  let privateRun: ActiveRunRecord | undefined;
  try {
    if (metaResult.exitCode === 0) remoteMeta = JSON.parse(metaResult.stdout);
  } catch {}
  try {
    if (journalResult.exitCode === 0) {
      const journal = JSON.parse(journalResult.stdout) as Record<
        string,
        ActiveRunRecord
      >;
      privateRun = Object.values(journal)[0];
    }
  } catch {}
  if (oldSpec?.wsToken) {
    let done: StreamEvent | undefined = remoteMeta?.done;
    let selectedModel: string | undefined = remoteMeta?.selectedModel;
    if (done) {
      try {
        rmSync(oldDir, { recursive: true, force: true });
      } catch {}
      const terminal = done;
      const initialModel = oldSpec.selectedModel ?? oldSpec.model;
      return (async function* () {
        if (selectedModel && selectedModel !== initialModel) {
          yield {
            type: "model_switch",
            fromModel: initialModel,
            toModel: selectedModel,
            switchReason: "out of credits",
            temporaryFallback: false,
          } satisfies StreamEvent;
        }
        yield terminal;
      })();
    }
    if (await launcher.alive(oldDir, null)) {
      if (oldSpec.rpcToken) {
        registerRunToken(oldSpec.rpcToken, {
          sessionId: oldSpec.osSessionId,
          user: oldSpec.user,
        });
      }
      registerRunWsHost(oldSpec.hostId, oldSpec.wsToken);
      console.log(
        `[sandbox-remote] reattaching to live run ${run.runKey} in ${run.sandboxId}`,
      );
      const handle = new HostHandle(oldDir, oldSpec, cb, launcher, run.runKey);
      try {
        // The host redials with ≤5s backoff once its token is re-registered.
        await handle.connectWithWait(20_000);
      } catch (e) {
        handle.abandon();
        throw e;
      }
      return withRunJournal(
        handle.events(),
        { ...run, startedAt: run.startedAt },
        () => {},
      );
    }
  }

  // Host died with (or before) the restart — relaunch a continuation in the
  // same sandbox so the engine session's in-sandbox state is reused.
  const recovery = decideSandboxHostRecovery({
    run,
    meta: remoteMeta,
    privateRun,
    hasCompleteSpec: !!oldSpec,
  });
  if (recovery.kind === "uncertain")
    throw new Error(
      `Remote sandbox run ${run.runKey} has execution evidence but no resumable engine session`,
    );
  const effectiveEngineSessionId =
    recovery.kind === "resume" ? recovery.engineSessionId : undefined;
  const prompt = effectiveEngineSessionId
    ? restartContinuationPrompt(run.prompt)
    : run.prompt;
  if (!prompt) return null;
  const rpcToken = oldSpec?.proxyMcpServers?.length
    ? crypto.randomUUID()
    : undefined;
  if (rpcToken)
    registerRunToken(rpcToken, { sessionId: run.osSessionId, user: run.user });
  const hostId = `rh-${Bun.randomUUIDv7()}`;
  const spec: RunHostSpec =
    recovery.kind === "replay"
      ? {
          ...(oldSpec as RunHostSpec),
          hostId,
          rpcToken,
          ...((oldSpec as RunHostSpec).wsToken
            ? { wsToken: crypto.randomUUID() }
            : {}),
          journalKind: recoveryKind(run.kind, "resume"),
          firstJournaledAt: run.firstJournaledAt,
          resumeAttempts: run.resumeAttempts,
          lastResumeAt: run.lastResumeAt,
        }
      : {
          hostId,
          osSessionId: run.osSessionId,
          prompt,
          promptEntryId: effectiveEngineSessionId
            ? undefined
            : run.promptEntryId,
          engineSessionId: effectiveEngineSessionId,
          cwd: run.cwd,
          mode: run.mode,
          model: run.model,
          selectedModel: run.selectedModel ?? run.model,
          transientFallback: run.transientFallback,
          mcpServers: run.mcpServers,
          proxyMcpServers: oldSpec?.proxyMcpServers,
          rpcToken,
          reposNote: oldSpec?.reposNote,
          deniedTools: run.deniedTools,
          confirmTools: run.confirmTools,
          aws: run.aws,
          author: oldSpec?.author,
          user: run.user,
          fallbackModel: run.fallbackModel,
          effort: run.effort,
          fastMode: run.fastMode,
          accountId: run.accountId,
          accountStrict: run.accountStrict,
          usageCredits: run.usageCredits,
          trustProfile: oldSpec?.trustProfile ?? run.trustProfile,
          journalKind: recoveryKind(run.kind, "resume"),
          firstJournaledAt: run.firstJournaledAt,
          resumeAttempts: run.resumeAttempts,
          lastResumeAt: run.lastResumeAt,
        };
  console.log(
    `[sandbox-remote] relaunching interrupted run ${run.runKey} in ${run.sandboxId} as ${spec.hostId}`,
  );
  const replacement = sandbox.launchRunEager
    ? await sandbox.launchRunEager(spec, { onAskUser: cb.onAskUser })
    : sandbox.launchRun(spec, { onAskUser: cb.onAskUser });
  try {
    if (oldDir && existsSync(oldDir))
      rmSync(oldDir, { recursive: true, force: true });
  } catch {}
  return replacement.events();
}
