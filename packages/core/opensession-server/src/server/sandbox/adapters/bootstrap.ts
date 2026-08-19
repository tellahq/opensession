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
import { journalSet, journalClear, type ActiveRunRecord } from "../../run-journal";
import { shouldPersistModelSwitch, type StreamEvent } from "../../run-events";
import { recoveryKind, RESUME_CONTINUATION_PROMPT } from "../../agent-runner";
import { accountsForRemoteUpload } from "../../claude-accounts";
import { audit } from "../../audit";
import { authedRemoteUrl } from "../../codestorage/auth";
import { parseCsRemote } from "../../codestorage/remote";
import { redactUrl } from "../../shared/redact";
import { listCodexAccounts } from "../../codex-accounts";
import { readOpencodeBridgeConfig } from "../../opencode-config";
import { normalizePiConfig, readPiEngineConfig } from "../../pi-config";
import {
  buildOpenaiRemoteSeedUpload,
  maskOpenaiAccount,
  openaiSeedAuthPath,
} from "../../opencode-openai-auth";
import { modelSupportsSteer, providerFor } from "../../models";
import { filterMcpServers } from "../../runner-shared";
import { hasMcpOauthGrantForUsers } from "../../mcp-oauth";
import {
  appendOpencodeTranscript,
  ensureOpencodeTranscriptFile,
  getOpencodeTranscriptPath,
  recordBksSessionFor,
  transcriptLineUser,
  transcriptLineRunnerNotice,
  transcriptLineAssistantText,
  transcriptLineToolUse,
  transcriptLineToolResult,
} from "../../opencode-transcript";
import { hostSteer, hostInterruptSteer, hostCancel } from "../../host-registry";
import { registerRunToken, unregisterRunToken } from "../../run-rpc";
import { registerRunWsHost, unregisterRunWsHost, runWsConnector } from "../../run-ws";
import { writeJsonAtomic } from "../../shared/atomic-write";
import { createWorkloadIdentityEnv, type WorkloadIdentityContext } from "../../workload-identity";
import { HostHandle, type HandleCallbacks, type HostLauncher } from "../../host-client";
import {
  HOST_SPEC_NAME,
  HOST_ENTRY,
  REPO_ROOT,
  type RunHostSpec,
} from "../../../runner-host/protocol";
import { sandboxConfig, remoteSandboxCallbackBaseUrl } from "../config";
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
const REMOTE_OPENCODE = `${REMOTE_HOME}/.bun/bin/opencode`;
const REMOTE_MCP_CONFIG = `${REMOTE_HOME}/.opensession-mcp-config.json`;
/** Same pin as deploy/sandbox/Dockerfile's OPENCODE_VERSION (host runs this
 *  too) — bump BOTH together. Part of bootstrapSignature, so a bump
 *  invalidates existing sandboxes/prewarms and re-bootstraps them. */
const REMOTE_OPENCODE_VERSION = "1.18.18";
/** Keep these aligned with deploy/sandbox/Dockerfile. The runtime revision is
 * part of bootstrapSignature, so changing this contract invalidates old
 * prewarms and provider templates instead of calling them Ready. */
const REMOTE_NODE_VERSION = "24.18.1";
const REMOTE_NODE_MAJOR = Number(REMOTE_NODE_VERSION.split(".")[0]);
const REMOTE_JUST_VERSION = "1.43.1";
const REMOTE_RUNTIME_REVISION = "workspace-runtime-v7";
const REMOTE_REPO = REPO_ROOT; // /home/ubuntu/projects/opensession
const BOOTSTRAP_MARKER = `${REMOTE_HOME}/.bks-bootstrapped`;
/** Where per-launch openai seed material lands in-sandbox — threaded to the
 *  run host via the OPENSESSION_OPENAI_SEED_DIR env (openaiRemoteSeedDir()),
 *  never derived independently on the two sides. */
export const REMOTE_OPENAI_SEED_DIR = `${REMOTE_HOME}/.opensession-openai-seeds`;
export const REMOTE_PI_CONFIG = `${REMOTE_HOME}/.opensession-pi.json`;
export const REMOTE_OPENCODE_CONFIG = `${REMOTE_HOME}/.opensession-opencode.json`;
export const REMOTE_OPENCODE_NATIVE_AUTH = `${REMOTE_HOME}/.local/share/opencode/auth.json`;
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
  const parts = Object.entries(env).map(([k, v]) => `${k}=${shellQuoteWord(v)}`);
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

/** The third-party provider selected by an opencode/<provider>/<model> id.
 * Anthropic/OpenAI use subscription material, never native auth. */
export function remoteOpencodeProviderId(model: string | undefined): string | null {
  const match = String(model || "").match(/^opencode\/([^/]+)\//);
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

/**
 * Project host OpenCode settings into fields consumed by an in-guest runner.
 * Third-party API keys are included only for an OpenCode-other launch. They
 * travel as one operator-managed scope because the in-turn fallback walk can
 * change provider without another launch boundary.
 */
export function projectRemoteOpencodeConfig(
  raw: unknown,
  model: string | undefined,
  trustProfile: "interactive" | "automation" = "interactive",
  pinnedAccountId?: string,
): { content: string; settingsProviderIds: string[] } {
  const source = jsonRecord(raw);
  if (!source) throw new Error("OpenCode config must be a JSON object");

  const out: JsonRecord = {};
  if (typeof source.enabled === "boolean") out.enabled = source.enabled;
  if (typeof source.port === "number") out.port = source.port;
  if (typeof source.turnTimeoutMinutes === "number")
    out.turnTimeoutMinutes = source.turnTimeoutMinutes;
  if (typeof source.bridgeMaxRequestsPerHour === "number")
    out.bridgeMaxRequestsPerHour = source.bridgeMaxRequestsPerHour;
  if (typeof source.orchestrator === "boolean") out.orchestrator = source.orchestrator;
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
  const selectedSettingsProvider = remoteOpencodeProviderId(model);
  if (selectedSettingsProvider) {
    for (const [id, value] of Object.entries(jsonRecord(source.providers) || {})) {
      if (id === "anthropic" || id === "openai") continue;
      if (trustProfile === "automation" && id !== selectedSettingsProvider) continue;
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

/** Selected-provider slice of OpenCode's unmanaged native auth store. */
export function projectRemoteOpencodeNativeAuth(
  raw: unknown,
  model: string | undefined,
): { content: string; providerId: string } | null {
  const providerId = remoteOpencodeProviderId(model);
  if (!providerId) return null;
  const source = jsonRecord(raw);
  if (!source || !(providerId in source)) return null;
  const credential = jsonRecord(source[providerId]);
  if (!credential) return null;
  return {
    content: JSON.stringify({ [providerId]: credential }, null, 2) + "\n",
    providerId,
  };
}

function hostOpencodeNativeAuthPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || `${homeDir()}/.local/share`;
  return `${dataHome}/opencode/auth.json`;
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
  return { trustProfile: state.trustProfile, egressAllowlist: state.egressAllowlist };
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
      rmSync(`${RUNS_BASE}/${sanitizeName(state.sessionId)}`, { recursive: true, force: true });
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
  return listRemoteStates(provider).find((state) => state.sessionId === sessionId) || null;
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
        const s: RemoteSandboxState = JSON.parse(readFileSync(`${STATE_DIR}/${f}`, "utf-8"));
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
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
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

function injectToken(httpsUrl: string): string {
  const cred = sandboxConfig().cloneCredential;
  if (cred?.type === "https-token") {
    // Hosted Open Session keeps a long-lived, tellahq-scoped bot credential in
    // GITHUB_API_TOKEN. Prefer it for GitHub clones over the config's token:
    // GitHub App user tokens expire in ~8h, so persisting one in sandbox.json
    // makes every fresh Daytona/Modal bootstrap fail days later. Self-hosters
    // without the env keep the explicit cloneCredential.token behavior, and
    // non-GitHub origins never receive our GitHub-specific credential.
    const liveGithubToken = /^https:\/\/github\.com\//i.test(httpsUrl)
      ? process.env.GITHUB_API_TOKEN
      : undefined;
    const token = liveGithubToken || cred.token;
    if (token) {
      return httpsUrl.replace(/^https:\/\//, `https://x-access-token:${token}@`);
    }
  }
  return httpsUrl;
}

/**
 * The https clone URL a remote sandbox uses for a repo: an https origin (or
 * ssh origin converted), else derived from `ghRepo`. Local-path origins are
 * unreachable remotely — loud error. `cloneCredential` is applied here.
 */
export async function remoteCloneUrl(repo: {
  id: string;
  repo: string;
  ghRepo?: string;
  host?: "github" | "codestorage";
  csRepo?: string;
}): Promise<string> {
  const origin = await hostGit(["remote", "get-url", "origin"], repo.repo);
  if (repo.host === "codestorage") {
    const csRepoId = repo.csRepo || (origin ? parseCsRemote(origin)?.repoId : undefined);
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
  const https = (origin && toHttpsUrl(origin)) || (repo.ghRepo ? `https://github.com/${repo.ghRepo}.git` : null);
  if (!https) {
    throw new Error(
      `repo ${repo.id} has no https-reachable origin (origin="${redactUrl(origin) || "none"}") — remote sandboxes clone over https; set an origin or ghRepo`,
    );
  }
  return injectToken(https);
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
 *  The opencode pin is part of it so sandboxes bootstrapped before opencode
 *  was in the payload (or on an older pin) re-bootstrap instead of failing
 *  every opencode/* run with a missing binary. */
export function bootstrapSignature(): string {
  const cfg = sandboxConfig();
  const base = cfg.runnerSha || cfg.runnerBundleUrl || "unpinned";
  return (
    `${base}+opencode@${REMOTE_OPENCODE_VERSION}` +
    `+node@${REMOTE_NODE_VERSION}+just@${REMOTE_JUST_VERSION}` +
    `+${REMOTE_RUNTIME_REVISION}`
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
    "for c in git curl unzip rg sed nl wc base64 python3 make g++ direnv lsof; do command -v \"$c\" >/dev/null 2>&1 || echo \"$c\"; done",
  );
  if (tools.stdout.trim()) {
    log(`installing workspace tools (${tools.stdout.trim().replaceAll("\n", ", ")})…`);
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
      "for c in git curl unzip rg sed nl wc base64 python3 make g++ direnv lsof; do command -v \"$c\" >/dev/null 2>&1 || { echo \"missing $c\" >&2; exit 1; }; done",
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
  // commonly invokes that name directly (tella-fusion's ReScript watcher).
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
  if (marker.exitCode === 0 && marker.stdout.trim() === signature) return;
  const log = (msg: string) => console.log(`[sandbox:${label}] bootstrap: ${msg}`);

  await bootstrapRemoteBaseRuntime(driver, label);

  // Runner bundle: tarball if configured, else git clone at the pinned sha.
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
      const opensessionRepo = { id: "opensession", repo: REPO_ROOT, ghRepo: undefined };
      const url =
        cfg.runnerRepoUrl && toHttpsUrl(cfg.runnerRepoUrl)
          ? injectToken(toHttpsUrl(cfg.runnerRepoUrl)!)
          : await remoteCloneUrl(opensessionRepo);
      log(`cloning runner repo ${redactUrl(url)}…`);
      need(
        await driver.exec(
          `mkdir -p ${dirname(REMOTE_REPO)} && git clone -- ${shellQuoteWord(url)} ${REMOTE_REPO}`,
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
      log(`runnerSha ${cfg.runnerSha} pinned but ${REMOTE_REPO} is not a git checkout — skipping reconcile`);
    } else {
      const head = async () =>
        (await driver.exec(`git -C ${REMOTE_REPO} rev-parse HEAD`)).stdout.trim();
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
            `git -C ${REMOTE_REPO} fetch --depth 1 origin ${shellQuoteWord(cfg.runnerSha)} 2>/dev/null; git -C ${REMOTE_REPO} checkout --detach ${shellQuoteWord(cfg.runnerSha)}`,
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

  log("bun install (this is the slow part — several minutes cold)…");
  need(
    await driver.exec(`cd ${REMOTE_REPO} && HOME=${REMOTE_HOME} ${REMOTE_BUN} install`, {
      timeoutMs: 900_000,
    }),
    "bun install of the runner bundle",
  );
  need(
    await driver.exec(
      `ln -sf ${REMOTE_REPO}/deploy/sandbox/opensession ${REMOTE_HOME}/.local/bin/opensession && ` +
        `chmod 755 ${REMOTE_REPO}/deploy/sandbox/opensession ${REMOTE_HOME}/.local/bin/opensession`,
    ),
    "workload identity client install",
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

  // opencode: the third engine (opencode/<provider>/<model> runs) — without it
  // resolveOpencodeBin finds nothing in-sandbox and every opencode run dies
  // instantly (bks-019f46bd, 2026-07-09). bun's global install puts the
  // platform binary at REMOTE_OPENCODE (~/.bun/bin, already first on
  // REMOTE_PATH); BUN_INSTALL pins the global dir to the payload HOME.
  log("installing opencode…");
  need(
    await driver.exec(
      `test -x ${REMOTE_OPENCODE} || HOME=${REMOTE_HOME} BUN_INSTALL=${REMOTE_HOME}/.bun ${REMOTE_BUN} add -g opencode-ai@${REMOTE_OPENCODE_VERSION}`,
      { timeoutMs: 300_000 },
    ),
    "opencode install",
  );
  need(
    await driver.exec(
      `v=$(HOME=${REMOTE_HOME} ${REMOTE_OPENCODE} --version) && { [ "$v" = "${REMOTE_OPENCODE_VERSION}" ] || { echo "opencode version mismatch: got '$v', want ${REMOTE_OPENCODE_VERSION}"; exit 1; }; }`,
      { timeoutMs: 60_000 },
    ),
    "opencode version check",
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
    await driver.exec(`printf '%s' ${shellQuoteWord(signature)} > ${BOOTSTRAP_MARKER}`),
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
      cmd: ["git", "-C", repo.repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
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
  if (!Array.isArray(seedFiles) || !seedFiles.every((file) => typeof file === "string")) {
    throw new Error(`${repo.id} ${REMOTE_SEED_MANIFEST} must contain a string[] seedFiles`);
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
      throw new Error(`${repo.id} ${REMOTE_SEED_MANIFEST} has unsafe path ${JSON.stringify(path)}`);
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
      throw new Error(`${repo.id} seed file must be a regular file, not a symlink: ${path}`);
    }
    const ignored = Bun.spawnSync({
      cmd: ["git", "-C", repo.repo, "check-ignore", "-q", "--", path],
      stdout: "ignore",
      stderr: "ignore",
    });
    if (ignored.exitCode !== 0) {
      throw new Error(`${repo.id} seed file must be gitignored before upload: ${path}`);
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
      throw new Error(`could not secure remote seed file ${repoId}:${file.path}`);
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
  repo: { id: string; repo: string; ghRepo?: string; defaultBranch: string; depsInstall?: string },
  label: string,
  opts?: { installDeps?: boolean; runSetup?: boolean; identity?: Omit<WorkloadIdentityContext, "lifecycle"> },
): Promise<boolean> {
  const dir = remoteWarmWorkspaceDir(repo.id);
  const log = (msg: string) => console.log(`[sandbox:${label}] warm workspace: ${msg}`);
  const has = await driver.exec(`test -d ${shellQuoteWord(dir)}/.git`);
  if (has.exitCode !== 0) {
    const url = await remoteCloneUrl(repo);
    log(`cloning ${redactUrl(url)} at ${repo.defaultBranch}…`);
    const clone = await driver.exec(
      `mkdir -p ${shellQuoteWord(dirname(dir))} && git clone --filter=blob:none -- ${shellQuoteWord(url)} ${shellQuoteWord(dir)}`,
      { timeoutMs: 600_000 },
    );
    if (clone.exitCode !== 0) {
      log(`clone failed (adoption will set up cold): ${redactUrl(clone.stderr.trim().slice(0, 300))}`);
      return false;
    }
  }
  if (opts?.runSetup) {
    await runRemoteLifecycleHook(driver, dir, "setup", "fresh", repo.id, opts.identity);
  }
  if (opts?.installDeps === false) {
    await scrubRemoteWarmWorkspaceAuthority(driver, repo, dir);
    log(opts.runSetup ? "ready (post-setup)" : "ready (clone only)");
    return true;
  }
  // Deps: same convention as worktree.ts's installWorktreeDeps, expressed
  // in-sandbox (config depsInstall → root install when package.json exists).
  const bunEnv = `HOME=${REMOTE_HOME} PATH=${shellQuoteWord(REMOTE_PATH)}`;
  const deps = repo.depsInstall
    ? `cd ${shellQuoteWord(dir)} && ${bunEnv} sh -c ${shellQuoteWord(repo.depsInstall)}`
    : `cd ${shellQuoteWord(dir)} && ${bunEnv} sh -c 'if [ -f package.json ]; then ${REMOTE_BUN} install; fi'`;
  log("installing deps…");
  const r = await driver.exec(deps, { timeoutMs: 900_000 });
  if (r.exitCode !== 0) {
    log(`deps install failed (non-fatal): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  } else {
    log("ready");
  }
  await scrubRemoteWarmWorkspaceAuthority(driver, repo, dir);
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
  const scrubbed = await driver.exec(
    `git remote set-url origin ${shellQuoteWord(safeOrigin)}`,
    { cwd: dir },
  );
  if (scrubbed.exitCode !== 0) {
    throw new Error(
      `could not scrub clone authority from ${repo.id} repo template: ${scrubbed.stderr.trim().slice(0, 200)}`,
    );
  }
}

export async function setupRemoteWorkspace(
  driver: RemoteDriver,
  cwd: string,
  cloneUrl: string,
  branch: string,
  defaultBranch: string,
  repoId?: string,
  identity?: Omit<WorkloadIdentityContext, "lifecycle">,
): Promise<void> {
  let cloned = await driver.exec(`test -d ${shellQuoteWord(cwd)}/.git`);
  if (cloned.exitCode !== 0 && repoId) {
    // Adopt a prewarmed clone (warmRemoteWorkspace) when one is waiting —
    // the mv is instant and carries node_modules with it.
    const warmDir = remoteWarmWorkspaceDir(repoId);
    const adopted = await driver.exec(
      `test -d ${shellQuoteWord(warmDir)}/.git && mkdir -p ${shellQuoteWord(dirname(cwd))} && mv ${shellQuoteWord(warmDir)} ${shellQuoteWord(cwd)}`,
    );
    if (adopted.exitCode === 0) {
      console.log(`[sandbox-remote] adopted warm workspace clone for ${repoId} → ${cwd}`);
      // Repo templates are credential-free at rest. Restore the current
      // short-lived clone authority only on the session-owned copy.
      await driver.exec(
        `git remote set-url origin ${shellQuoteWord(cloneUrl)}`,
        { cwd },
      );
      // The warm clone's refs may be hours old and the session branches off
      // the default branch — freshen before the checkout below.
      await driver.exec(`git fetch origin --quiet`, { cwd, timeoutMs: 180_000 });
      cloned = await driver.exec(`test -d ${shellQuoteWord(cwd)}/.git`);
    }
  }
  if (cloned.exitCode !== 0) {
    console.log(`[sandbox-remote] cloning ${redactUrl(cloneUrl)} into ${cwd}`);
    // Blobless partial clone: full history/refs but blobs fetched lazily via
    // the persisted (tokenized) origin URL. tella-fusion's full .git is
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
  const cur = await driver.exec("git branch --show-current", { cwd });
  if (cur.exitCode !== 0 || cur.stdout.trim() !== branch) {
    const hasRemote = await driver.exec(
      `git rev-parse --verify --quiet origin/${shellQuoteWord(branch)}`,
      { cwd },
    );
    const startPoint = hasRemote.exitCode === 0 ? `origin/${branch}` : `origin/${defaultBranch}`;
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
  // Per-session only: warm/template preparation never calls this path, so
  // private files are injected after restore and can never land in a shared
  // provider snapshot.
  await materializeRemoteWorkspaceSeedFiles(driver, cwd, repoId);
  await runRemoteLifecycleHook(driver, cwd, "setup", "fresh", repoId, identity);
}

const REMOTE_LIFECYCLE_DIR = `${REMOTE_HOME}/.opensession/lifecycle`;

function remoteLifecycleKey(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(-120);
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
   * stamp after it is moved into the adopting session's final cwd. */
  scopeKey?: string,
  identity?: Omit<WorkloadIdentityContext, "lifecycle">,
): Promise<{ ran: boolean; log: string }> {
  const script = `${cwd}/.agents/${hook}`;
  const key = remoteLifecycleKey(scopeKey || cwd) || "workspace";
  const log = `${REMOTE_LIFECYCLE_DIR}/${key}-${hook}.log`;
  const stamp = `${REMOTE_LIFECYCLE_DIR}/${key}-setup.done`;
  const inspectCommand = hook === "setup"
    ? `if [ -f ${shellQuoteWord(stamp)} ]; then echo stamped; elif [ -e ${shellQuoteWord(script)} ]; then echo present; else echo absent; fi`
    : `if [ -e ${shellQuoteWord(script)} ]; then echo present; else echo absent; fi`;
  const readProbe = async (command: string) => {
    let result = await driver.exec(command);
    const detail = `${result.stderr} ${result.stdout}`;
    if (
      result.exitCode !== 0 &&
      /(?:operation )?timed? ?out|timeout|temporar|connection|socket|transport/i.test(detail)
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
    throw new Error(`could not inspect .agents/${hook}: ${probe.stderr.trim()}`);
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
  const command =
    `mkdir -p ${shellQuoteWord(REMOTE_LIFECYCLE_DIR)} && ` +
    `: > ${shellQuoteWord(log)} && ` +
    `env HOME=${REMOTE_HOME} PATH=${shellQuoteWord(REMOTE_PATH)} ${identityArgs} ` +
    `OPENSESSION_BOOT_MODE=${shellQuoteWord(bootMode)} ${shellQuoteWord(script)} ` +
    `>> ${shellQuoteWord(log)} 2>&1` +
    (hook === "setup" ? ` && touch ${shellQuoteWord(stamp)}` : "");
  const result = await driver.exec(command, { cwd, timeoutMs: 20 * 60_000 });
  if (result.exitCode !== 0) {
    const tail = await driver.exec(`tail -80 ${shellQuoteWord(log)} 2>/dev/null || true`);
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
      const meta = await driver.exec(`cat ${shellQuoteWord(`${dir}/meta.json`)} 2>/dev/null`);
      if (meta.exitCode !== 0) return false;
      let pid = 0;
      try {
        pid = Number(JSON.parse(meta.stdout)?.pid) || 0;
      } catch {}
      if (!pid) return false;
      return (await driver.exec(`kill -0 ${pid}`)).exitCode === 0;
    },
    newRunDir: (hostId) => `${sessionRunsDir(sessionId)}/${sanitizeName(hostId)}`,
    connector: (_dir, spec) => (spec.wsToken ? runWsConnector(spec.hostId) : undefined),
    async writeSpec(dir, spec) {
      mkdirSync(dir, { recursive: true });
      writeJsonAtomic(`${dir}/${HOST_SPEC_NAME}`, spec); // host mirror (resume)
      const mk = await driver.exec(`mkdir -p ${shellQuoteWord(dir)}`);
      if (mk.exitCode !== 0) {
        throw new Error(`remote run dir create failed: ${mk.stderr.trim().slice(0, 300)}`);
      }
      await driver.writeFile(`${dir}/${HOST_SPEC_NAME}`, JSON.stringify(spec));
    },
    async launch(hostId, dir) {
      const spec = readJsonSafe<RunHostSpec>(`${dir}/${HOST_SPEC_NAME}`);
      if (!spec?.wsToken) {
        throw new Error(`remote launch of ${hostId}: spec.json (with wsToken) missing from ${dir}`);
      }
      // Per-step timing marks: when a provider SDK call stalls (see the
      // bounded execBackground below), the last mark names the culprit.
      const t0 = Date.now();
      const mark = (step: string) =>
        console.log(`[sandbox-remote] launch ${hostId.slice(0, 11)}: ${step} (+${Date.now() - t0}ms)`);
      await driver.ensureStarted();
      mark("sandbox started");
      const automationProfile = spec.trustProfile === "automation";
      if (automationProfile && !spec.accountId) {
        throw new Error("automation sandbox runs require a pinned model account");
      }
      // Scoped Claude account upload — only what THIS run may use (pinned
      // account, else pool + the run user's own personal accounts; see the
      // module header). Rewritten every launch so pin/user changes apply and
      // a previously-uploaded wider file never lingers.
      const accounts = accountsForRemoteUpload(spec.user, spec.accountId);
      if (automationProfile && !accounts.some((account) => account.id === spec.accountId)) {
        const model = String(spec.model || "");
        if (/^(?:claude-|opencode\/anthropic\/|pi\/anthropic\/)/.test(model)) {
          throw new Error("the pinned automation account is not an eligible Claude account");
        }
      }
      // Resolve the run's MCP allowlist and dynamic credentials on the trusted
      // host, then project only those entries. Remote guests never receive the
      // instance-wide mcp-config.json. Automation specs are required to carry
      // an explicit array (including [] for no external connectors).
      if (automationProfile && spec.mcpServers === "all") {
        throw new Error("automation sandbox runs require an explicit MCP allowlist");
      }
      const projectedMcp = filterMcpServers(
        spec.mcpServers ?? "all",
        spec.user,
        [spec.user],
      ) as Record<string, unknown>;
      for (const name of Object.keys(projectedMcp)) {
        if (hasMcpOauthGrantForUsers(name, [spec.user])) {
          delete projectedMcp[name];
        }
      }
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
      await driver.exec(
        `chmod 600 ${shellQuoteWord(claudeAccountsPath)} ${shellQuoteWord(REMOTE_MCP_CONFIG)}`,
      );
      // OpenCode policy + provider config, projected at the sandbox boundary.
      // The source CAN contain third-party API keys under providers.*.apiKey;
      // never copy it wholesale. Anthropic/OpenAI/Pi launches receive only the
      // bridge/runtime fields. OpenCode-other receives the configured
      // third-party provider scope because its fallback walk can switch within
      // one runner-host launch. Rewritten/removed every launch so stale wider
      // authority cannot linger on a reused sandbox.
      const ocCfgSrc =
        process.env.OPENSESSION_OPENCODE_CONFIG ||
        // Dual-read the host path (a new-name-only host has no
        // ~/.opensession-opencode.json); the remote destination below stays the
        // legacy name the in-sandbox build dual-reads.
        stateDir("opencode.json");
      let settingsProviderIds: string[] = [];
      if (existsSync(ocCfgSrc)) {
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(ocCfgSrc, "utf-8"));
        } catch (error) {
          throw new Error(`Cannot project sandbox OpenCode config ${ocCfgSrc}: ${error}`);
        }
        const projected = projectRemoteOpencodeConfig(
          raw,
          spec.model,
          spec.trustProfile,
          spec.accountId,
        );
        settingsProviderIds = projected.settingsProviderIds;
        await driver.writeFile(REMOTE_OPENCODE_CONFIG, projected.content);
        await driver.exec(`chmod 600 ${shellQuoteWord(REMOTE_OPENCODE_CONFIG)}`);
      } else {
        await driver.exec(`rm -f ${shellQuoteWord(REMOTE_OPENCODE_CONFIG)}`);
      }

      // Pi stays architecturally in-process: the guest runner-host imports the
      // normal runAgent/runPi path. Materialize only the current Pi gate and
      // transport policy; its credentials are the scoped Claude/Codex stores
      // uploaded alongside this file.
      const piContent = projectRemotePiConfig(readPiEngineConfig());
      if (piContent) {
        await driver.writeFile(REMOTE_PI_CONFIG, piContent);
        await driver.exec(`chmod 600 ${shellQuoteWord(REMOTE_PI_CONFIG)}`);
      } else {
        await driver.exec(`rm -f ${shellQuoteWord(REMOTE_PI_CONFIG)}`);
      }

      // OpenCode's unmanaged `auth login` store is a fallback for a selected
      // third-party provider only. Project exactly that entry to OpenCode's
      // normal guest path; never upload the Anthropic/OpenAI OAuth entries or
      // the full host store.
      const selectedProviderId = remoteOpencodeProviderId(spec.model);
      let nativeAuth: ReturnType<typeof projectRemoteOpencodeNativeAuth> = null;
      const nativeAuthSrc = hostOpencodeNativeAuthPath();
      if (
        selectedProviderId &&
        !settingsProviderIds.includes(selectedProviderId) &&
        existsSync(nativeAuthSrc)
      ) {
        try {
          nativeAuth = projectRemoteOpencodeNativeAuth(
            JSON.parse(readFileSync(nativeAuthSrc, "utf-8")),
            spec.model,
          );
        } catch (error) {
          throw new Error(`Cannot project sandbox OpenCode auth ${nativeAuthSrc}: ${error}`);
        }
      }
      if (nativeAuth) {
        await driver.exec(
          `mkdir -p ${shellQuoteWord(dirname(REMOTE_OPENCODE_NATIVE_AUTH))} && chmod 700 ${shellQuoteWord(dirname(REMOTE_OPENCODE_NATIVE_AUTH))}`,
        );
        await driver.writeFile(REMOTE_OPENCODE_NATIVE_AUTH, nativeAuth.content);
        await driver.exec(`chmod 600 ${shellQuoteWord(REMOTE_OPENCODE_NATIVE_AUTH)}`);
      } else {
        await driver.exec(`rm -f ${shellQuoteWord(REMOTE_OPENCODE_NATIVE_AUTH)}`);
      }
      if (
        selectedProviderId &&
        !settingsProviderIds.includes(selectedProviderId) &&
        !nativeAuth
      ) {
        throw new Error(
          `opencode/${selectedProviderId} cannot launch in a sandbox: configure provider ` +
            `"${selectedProviderId}" in Settings → Model providers or run ` +
            `\`opencode auth login\` for that provider on the Open Session host`,
        );
      }
      if (selectedProviderId) {
        audit({
          msg: "sandbox_opencode_provider_upload",
          host_id: spec.hostId,
          session_id: spec.osSessionId,
          provider: selectedProviderId,
          mechanism: nativeAuth ? "native-auth" : "settings",
          settings_providers: settingsProviderIds,
        });
      }
      // OpenAI/ChatGPT-subscription material for opencode/openai/* dispatched
      // IN-SANDBOX. The raw CODEX_HOME/auth.json is NEVER uploaded — its
      // refresh token is the one rotating family shared with the host codex
      // CLI, and an in-sandbox refresh would rotate (= kill) the host copy.
      // Instead: (a) a scoped codex-accounts store so pickOpenaiAccount
      // in-sandbox applies the same pool/openaiAccounts rules, and (b) the
      // rotation-proof SEEDED artifact per home account (access-token-only +
      // invalid placeholder refresh — buildOpenaiRemoteSeedUpload). Upload it
      // only for an OpenAI run: every turn gets a fresh host launch with its
      // selected model, and projecting unrelated account families adds both
      // authority and remote startup latency for no benefit.
      // Rewritten (or removed) per launch so restriction changes apply and a
      // previously-uploaded wider set never lingers. Destination filenames
      // stay the legacy .opensession-* names the (dual-reading) in-sandbox
      // build resolves — same convention as the bridge config above.
      const usesOpenai = /^(?:opencode\/openai\/|pi\/openai\/)/.test(
        String(spec.model || ""),
      );
      const openaiUpload: ReturnType<typeof buildOpenaiRemoteSeedUpload> = usesOpenai
        ? buildOpenaiRemoteSeedUpload(
            listCodexAccounts(),
            automationProfile && spec.accountId
              ? [spec.accountId]
              : readOpencodeBridgeConfig()?.openaiAccounts,
            spec.user,
          )
        : { accounts: [], seeds: [], skipped: [] };
      if (
        automationProfile &&
        usesOpenai &&
        !openaiUpload.accounts.some((account) => account.id === spec.accountId)
      ) {
        throw new Error("the pinned automation account is not an eligible OpenAI account");
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
        // Fresh seed dir per launch — stale per-account seeds never linger.
        await driver.exec(
          `chmod 600 ${codexStorePath} && rm -rf ${shellQuoteWord(REMOTE_OPENAI_SEED_DIR)}`,
        );
        for (const seed of openaiUpload.seeds) {
          const seedPath = openaiSeedAuthPath(REMOTE_OPENAI_SEED_DIR, seed.accountId);
          await driver.exec(
            `mkdir -p ${shellQuoteWord(dirname(seedPath))} && chmod 700 ${shellQuoteWord(REMOTE_OPENAI_SEED_DIR)} ${shellQuoteWord(dirname(seedPath))}`,
          );
          await driver.writeFile(seedPath, seed.content);
          await driver.exec(`chmod 600 ${shellQuoteWord(seedPath)}`);
        }
        audit({
          msg: "sandbox_openai_seed_upload",
          host_id: spec.hostId,
          session_id: spec.osSessionId,
          mechanism: "oauth-subscription-seeded-remote",
          accounts: openaiUpload.accounts.map((a) => maskOpenaiAccount(a)),
          seeds: openaiUpload.seeds.length,
          skipped: openaiUpload.skipped.map(
            (s) => `${maskOpenaiAccount(s.account)}: ${s.reason}`,
          ),
        });
      } else {
        await driver.exec(
          `rm -f ${codexStorePath} && rm -rf ${shellQuoteWord(REMOTE_OPENAI_SEED_DIR)}`,
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
          // Deterministic opencode resolution (bootstrap installed it here) —
          // don't depend on PATH probing inside the run host.
          OPENSESSION_OPENCODE_BIN: REMOTE_OPENCODE,
          OPENSESSION_MCP_CONFIG: REMOTE_MCP_CONFIG,
          OPENSESSION_RUN_JOURNAL: `${dir}/journal.json`,
          // Where bindOpenaiAccount finds the uploaded rotation-proof openai
          // seeds (only set when something was uploaded this launch).
          ...(openaiUpload.accounts.length
            ? {
                OPENSESSION_OPENAI_SEED_DIR: REMOTE_OPENAI_SEED_DIR,
              }
            : {}),
          // Dial-back on the primary prefix — the ingress/main serve accept
          // both, and URLs already baked into live sandboxes stay valid.
          OPENSESSION_RUN_WS_URL: `${base}/run-ws/${hostId}`,
          OPENSESSION_RUN_WS_TOKEN: spec.wsToken,
          OPENSESSION_RPC_WS_URL: `${base}/rpc-ws`,
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
        const bg = driver.execBackground(
          `${envPrefix(env)}${REMOTE_BUN} run ${HOST_ENTRY} ${dir}/${HOST_SPEC_NAME} >> ${dir}/host.log 2>&1`,
        );
        const bgTimeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 30_000));
        const raced = await Promise.race([bg.then(() => "ok" as const), bgTimeout]);
        if (raced === "timeout") {
          console.warn(
            `[sandbox-remote] execBackground for ${hostId.slice(0, 11)} still pending after 30s — ` +
              "proceeding to the dial-back wait (the launch command may have been delivered anyway)",
          );
          bg.catch(() => {}); // don't let the eventual settle become an unhandled rejection
        }
        mark("host exec dispatched");
      } catch (e) {
        unregisterRunWsHost(hostId);
        throw e;
      }
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
    trustProfile: spec.trustProfile,
    kind: spec.journalKind || "prompt",
    firstJournaledAt: spec.firstJournaledAt,
    resumeAttempts: spec.resumeAttempts,
    lastResumeAt: spec.lastResumeAt,
    startedAt: new Date().toISOString(),
  };
}

/** Mutable engine-session ref shared between the transcript mirror and the
 *  RunHandle's steer wrappers, so a delivered steer can be mirrored into the
 *  file the run is CURRENTLY writing (rotation can change it mid-run). */
export interface OcSessionRef {
  id: string;
}

/**
 * Host-side mirror of the persisted opencode transcript for REMOTE runs.
 * The in-sandbox runner writes its JSONL inside the sandbox, where nothing
 * host-side can read it back (docker bind-mounts OPENCODE_TRANSCRIPTS_DIR;
 * remote sandboxes have no mount), so a daytona/e2b opencode session would
 * render "No transcript available" after a reload. Open Session already receives
 * every stream event over the dial-back — rebuild the same claude-shape lines
 * from them here. Applied ONLY on the remote adapters (this module): docker's
 * bind mount already lands the in-sandbox writes on the host, and mirroring
 * there would double every line.
 *
 * User-entry rules (bks-019f46d2 postmortem):
 *  - The prompt is written from the SPEC (the host knows every prompt it
 *    dispatches), never parsed back out of dial-back frames.
 *  - It is written AT DISPATCH when the engine session is already known
 *    (every turn after the first) — the viewer's optimistic "Sending…"
 *    bubble reconciles on this append, and remote engine boot is 10-30s,
 *    so waiting for init would hang the bubble that long (or forever if
 *    the turn dies first).
 *  - It is (re)written on every init that lands on a NEW engine session id:
 *    an account rotation mid-turn starts a fresh opencode session, and the
 *    turn's prompt must exist in the file the session ends up pointing at
 *    (the original bug: the prompt only ever landed in attempt 1's file).
 *  - A deterministic uuid (`<hostId>-prompt`) makes re-writes upsert-safe
 *    for the jsonl parser instead of duplicating.
 *  - The synthetic restart-resume continuation prompt is NOT a user entry.
 */
export async function* withOpencodeTranscriptMirror(
  events: AsyncGenerator<StreamEvent>,
  spec: RunHostSpec,
  ocRef?: OcSessionRef,
): AsyncGenerator<StreamEvent> {
  if (providerFor(spec.model) !== "opencode") {
    yield* events;
    return;
  }
  let oc = spec.engineSessionId || "";
  if (ocRef) ocRef.id = oc;
  // Transcript v2: record the oc→unified mapping BEFORE any mirror write so
  // the flag-gated store path in opencode-transcript.ts can resolve it (the
  // sandbox host is the recording site here — the spec carries both ids).
  if (oc && spec.osSessionId) recordBksSessionFor(oc, spec.osSessionId);
  const syntheticContinuation = spec.prompt === RESUME_CONTINUATION_PROMPT;
  const promptUuid = `${spec.hostId}-prompt`;
  const promptWrittenTo = new Set<string>();
  const writePrompt = (id: string) => {
    if (!id || !spec.prompt || syntheticContinuation || promptWrittenTo.has(id)) return;
    ensureOpencodeTranscriptFile(id);
    // Idempotent across re-deliveries (post-restart reattach replays the same
    // spec): the deterministic uuid is checked in-file, since the jsonl
    // parser renders duplicate lines as duplicate entries.
    try {
      const path = getOpencodeTranscriptPath(id);
      if (existsSync(path) && readFileSync(path, "utf-8").includes(`"${promptUuid}"`)) {
        promptWrittenTo.add(id);
        return;
      }
    } catch {}
    appendOpencodeTranscript(id, [transcriptLineUser(spec.prompt, promptUuid)]);
    promptWrittenTo.add(id);
  };
  const mirror = (lines: Parameters<typeof appendOpencodeTranscript>[1]) => {
    if (oc) appendOpencodeTranscript(oc, lines);
  };
  try {
    writePrompt(oc); // dispatch-time (known session = resumed turns)
  } catch {}
  for await (const ev of events) {
    try {
      if (ev.type === "init" && ev.sessionId) {
        oc = ev.sessionId;
        if (ocRef) ocRef.id = oc;
        // Rotation-safe: every init that lands on a NEW engine session id
        // re-records the mapping before the mirror/store writes below.
        if (spec.osSessionId) recordBksSessionFor(oc, spec.osSessionId);
        ensureOpencodeTranscriptFile(oc);
        writePrompt(oc);
      } else if (ev.type === "text_chunk" && ev.text) {
        mirror([transcriptLineAssistantText(ev.text)]);
      } else if (ev.type === "runner_notice" && ev.text) {
        // In-sandbox rotation/retry notices: the sandbox runner persisted them
        // to ITS transcript file, which nothing on the host reads — mirror
        // them into the host-side file as the same durable system line.
        mirror([transcriptLineRunnerNotice(ev.text)]);
      } else if (ev.type === "tool_use" && ev.toolUseId) {
        mirror([transcriptLineToolUse(ev.toolUseId, ev.toolName || "tool", ev.toolInput)]);
      } else if (ev.type === "tool_result" && ev.toolUseId) {
        // Carry ev.images through. For a remote run the in-sandbox runner is
        // the only thing that ever sees the Read attachment's bytes, and it
        // sends them inline precisely because the host cannot serve a path
        // inside the sandbox — dropping them here (as this did) left every
        // sandboxed Read image blank in the transcript.
        mirror([
          transcriptLineToolResult(ev.toolUseId, ev.content || "", false, undefined, ev.images),
        ]);
      }
    } catch {
      // Mirroring must never break the run stream.
    }
    yield ev;
  }
}

async function* withRunJournal(
  events: AsyncGenerator<StreamEvent>,
  record: ActiveRunRecord,
  touch: () => void,
): AsyncGenerator<StreamEvent> {
  journalSet(record);
  touch();
  try {
    for await (const ev of events) {
      if (ev.type === "init" && ev.sessionId && ev.sessionId !== record.claudeSessionId) {
        record.claudeSessionId = ev.sessionId;
        journalSet(record);
      }
      if (ev.type === "model_switch" && ev.toModel) {
        record.model = ev.toModel;
        record.transientFallback = ev.temporaryFallback === true;
        if (shouldPersistModelSwitch(ev)) record.selectedModel = ev.toModel;
        journalSet(record);
      }
      yield ev;
    }
  } finally {
    journalClear(record.runKey);
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
const remoteParts = new WeakMap<object, { driver: RemoteDriver; launcher: HostLauncher }>();

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
      const result = await parts.driver.exec(shellQuote(cmd), {
        cwd: parts.cwd,
        env: {
          ...createWorkloadIdentityEnv({
            sandboxId: parts.sandboxId,
            provider: parts.providerId,
            lifecycle: "run",
            sessionId: parts.sessionId,
          }),
          ...opts?.env,
        },
        detached: opts?.background,
      });
      touch();
      return result;
    },

    async launchRunEager(spec: RunHostSpec, cb?: RunHandleCallbacks): Promise<RunHandle> {
      const dir = launcher.newRunDir(spec.hostId);
      const callbacks: HandleCallbacks = {
        onAskUser: cb?.onAskUser,
        onSteerFailed: cb?.onSteerFailed,
      };
      spec.wsToken ??= crypto.randomUUID(); // remote runs are always WS
      const record = recordForSpec(spec, parts.sandboxId, parts.providerId);
      let handle: HostHandle | undefined;
      const t0 = Date.now();
      const mark = (step: string) =>
        console.log(`[sandbox-remote] launch ${spec.hostId.slice(0, 11)}: ${step} (+${Date.now() - t0}ms)`);
      try {
        await launcher.writeSpec!(dir, spec);
        mark("spec written");
        await launcher.launch(spec.hostId, dir);
        handle = new HostHandle(dir, spec, callbacks, launcher);
        await handle.connectWithWait(45_000);
        mark("host attached");
      } catch (e) {
        handle?.abandon();
        unregisterRunToken(spec.rpcToken);
        unregisterRunWsHost(spec.hostId);
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
        throw e;
      }
      const ocRef: OcSessionRef = { id: spec.engineSessionId || "" };
      const gen = withRunJournal(
        withOpencodeTranscriptMirror(handle.events(), spec, ocRef),
        record,
        touch,
      );
      // Steers fold into the running turn in-sandbox, so they never come back
      // as dial-back user frames — mirror DELIVERED steers into the current
      // engine-session file (same reconcile contract as the dispatch prompt).
      const mirrorSteer = (text: string, delivered: boolean) => {
        if (delivered && ocRef.id && providerFor(spec.model) === "opencode" && text) {
          try {
            appendOpencodeTranscript(ocRef.id, [transcriptLineUser(text)]);
          } catch {}
        }
        return delivered;
      };
      return {
        events: () => gen,
        steerable: modelSupportsSteer(spec.model),
        steer: (text) => mirrorSteer(text, hostSteer(spec.osSessionId, text)),
        interruptSteer: (text) =>
          mirrorSteer(text, hostInterruptSteer(spec.osSessionId, text)),
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
        steer: (text) => hostSteer(spec.osSessionId, text),
        interruptSteer: (text) => hostInterruptSteer(spec.osSessionId, text),
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
    console.warn(`[sandbox-remote] resume: provider.get(${run.sandboxId}) failed:`, e);
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
  if (oldSpec?.wsToken) {
    // Ended while we were down? meta.json lives in-sandbox only.
    const meta = await driver.exec(`cat ${shellQuoteWord(`${oldDir}/meta.json`)} 2>/dev/null`);
    let done: StreamEvent | undefined;
    let selectedModel: string | undefined;
    try {
      const parsed = meta.exitCode === 0 ? JSON.parse(meta.stdout) : undefined;
      done = parsed?.done;
      selectedModel = parsed?.selectedModel;
    } catch {}
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
        registerRunToken(oldSpec.rpcToken, { sessionId: oldSpec.osSessionId, user: oldSpec.user });
      }
      registerRunWsHost(oldSpec.hostId, oldSpec.wsToken);
      console.log(`[sandbox-remote] reattaching to live run ${run.runKey} in ${run.sandboxId}`);
      const handle = new HostHandle(oldDir, oldSpec, cb, launcher);
      try {
        // The host redials with ≤5s backoff once its token is re-registered.
        await handle.connectWithWait(20_000);
      } catch (e) {
        handle.abandon();
        throw e;
      }
      return withRunJournal(
        withOpencodeTranscriptMirror(handle.events(), oldSpec),
        { ...run, startedAt: run.startedAt },
        () => {},
      );
    }
  }

  // Host died with (or before) the restart — relaunch a continuation in the
  // same sandbox so the engine session's in-sandbox state is reused.
  const prompt = run.claudeSessionId ? RESUME_CONTINUATION_PROMPT : run.prompt;
  if (!prompt) return null;
  const rpcToken = oldSpec?.proxyMcpServers?.length ? crypto.randomUUID() : undefined;
  if (rpcToken) registerRunToken(rpcToken, { sessionId: run.osSessionId, user: run.user });
  const spec: RunHostSpec = {
    hostId: `rh-${Bun.randomUUIDv7()}`,
    osSessionId: run.osSessionId,
    prompt,
    engineSessionId: run.claudeSessionId,
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
  try {
    if (oldDir && existsSync(oldDir)) rmSync(oldDir, { recursive: true, force: true });
  } catch {}
  console.log(`[sandbox-remote] relaunching interrupted run ${run.runKey} in ${run.sandboxId} as ${spec.hostId}`);
  return sandbox.launchRun(spec, { onAskUser: cb.onAskUser }).events();
}
