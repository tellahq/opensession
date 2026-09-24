/**
 * bootstrap — shared runtime for the remote Sandbox adapters (Daytona, Boat,
 * Mac VM, use.computer; docs/self-hosting-sandboxes.md). Everything here is
 * provider-agnostic: the adapters implement the small `RemoteDriver` wire
 * (shell exec, detached exec, file write, wake) and get, in return:
 *
 *  - `bootstrapRemoteSandbox`: the base runtime every Sandbox carries (the
 *    workspace tools, pinned Node, just, gh and bun, and the `opensession`
 *    identity command). The agent loop runs on this server, so nothing else
 *    is installed, and nothing in it names an Open Session commit: a deploy
 *    never makes a Sandbox reinstall anything. A marker makes every later
 *    call one command.
 *  - `setupRemoteWorkspace`: remote workspaces are volume-style: the repo is
 *    cloned INSIDE the sandbox from its https origin (never a host mount),
 *    with the clone credential used for the bounded clone/fetch only and a
 *    credential-free origin left behind. Destroying the sandbox destroys the
 *    workspace; checkpoints (checkpoint.ts) are the durable copy.
 *  - `makeRemoteSandbox`: the Sandbox handle. `exec` is the one primitive
 *    Portals, checkpoints, lifecycle hooks and a run's file and shell tools
 *    (remote-workspace.ts via sandbox/workspace-rpc.ts) all use.
 *
 * Nothing here uploads a model credential: the agent loop never runs in a
 * Sandbox. What enters one is the clone credential during the clone, a run's
 * GitHub token inside each of its shell commands' environment, and
 * short-lived workload identity leases.
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
import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "path";
import { OPENSESSION_SESSIONS_DIR } from "../../paths";
import { authedRemoteUrl } from "../../codestorage/auth";
import { parseCsRemote } from "../../codestorage/remote";
import { redactUrl } from "../../shared/redact";
import { writeJsonAtomic } from "../../shared/atomic-write";
import {
  createWorkloadIdentityEnv,
  type WorkloadIdentityContext,
} from "../../workload-identity";
import { REPO_ROOT } from "../../../runner-host/protocol";
import { sandboxConfig, remoteSandboxCallbackBaseUrl } from "../config";
import type {
  ExecOpts,
  ExecResult,
  PortMap,
  Sandbox,
  SandboxProviderId,
  SandboxSessionSpec,
  SandboxStatus,
} from "../provider";

/** The Linux guest user's home. Workspaces keep the host's worktree layout
 *  under it, so a session's checkout path is the same string everywhere. */
export const REMOTE_HOME = "/home/ubuntu";
/** The base runtime's pins (deploy/sandbox/README.md). They and the runtime
 * revision are part of baseRuntimeSignature, so changing this contract
 * invalidates old prewarms and provider templates instead of calling them
 * Ready. */
const REMOTE_NODE_VERSION = "24.18.1";
const REMOTE_JUST_VERSION = "1.43.1";
const REMOTE_GH_VERSION = "2.83.1";
const REMOTE_RUNTIME_REVISION = "workspace-runtime-v8";
const REMOTE_PATH = `${REMOTE_HOME}/.bun/bin:${REMOTE_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

/** Where the retired in-Sandbox runner kept its host-side run mirrors; only
 *  cleaned up now. */
const RUNS_BASE = `${OPENSESSION_SESSIONS_DIR}/sandbox-runs`;
const STATE_DIR = `${OPENSESSION_SESSIONS_DIR}/sandboxes`;

// ── Guest layout ─────────────────────────────────────────────────────────────
//
// A macOS guest (Mac VM, use.computer) cannot host /home at all (autofs owns
// it), so the layout is a value chosen by the driver's guest OS. Every guest
// path a bootstrap, lifecycle hook, Portal, or workspace command touches goes
// through it.

export type RemoteGuestOs = "linux" | "darwin";

export interface RemoteLayout {
  os: RemoteGuestOs;
  /** The guest user's home. */
  home: string;
  bun: string;
  bunx: string;
  /** PATH every guest command receives. */
  path: string;
  warmBase: string;
  lifecycleDir: string;
  /** Per-session scratch root as the guest's `$OPENSESSION_SCRATCH` sees it. */
  sessionScratchRoot: string;
}

function buildLayout(
  os: RemoteGuestOs,
  home: string,
  path: string,
): RemoteLayout {
  return {
    os,
    home,
    bun: `${home}/.bun/bin/bun`,
    bunx: `${home}/.bun/bin/bunx`,
    path,
    warmBase: `${home}/.bks-warm`,
    lifecycleDir: `${home}/.opensession/lifecycle`,
    sessionScratchRoot: `${home}/.opensession/session-scratch`,
  };
}

const LINUX_LAYOUT: RemoteLayout = buildLayout(
  "linux",
  REMOTE_HOME,
  REMOTE_PATH,
);

/** macOS guests: the image's user (tart's `admin`, use.computer's `lume`)
 *  and Homebrew on the PATH. */
export const DARWIN_GUEST_HOME = "/Users/admin";
export const USE_COMPUTER_GUEST_HOME = "/Users/lume";
const darwinLayouts = new Map<string, RemoteLayout>();

function darwinLayout(home: string): RemoteLayout {
  let layout = darwinLayouts.get(home);
  if (!layout) {
    // Pinned tools land in /usr/local/bin and must shadow whatever the
    // image's Homebrew ships (its `node` is newer than the pinned one).
    layout = buildLayout(
      "darwin",
      home,
      `${home}/.bun/bin:${home}/.local/bin:` +
        "/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin",
    );
    darwinLayouts.set(home, layout);
  }
  return layout;
}

/** The layout for a guest OS; a darwin guest may name its user's home
 *  (default: the tart image's `admin`). */
export function remoteLayout(
  os: RemoteGuestOs = "linux",
  home?: string,
): RemoteLayout {
  return os === "darwin"
    ? darwinLayout(home || DARWIN_GUEST_HOME)
    : LINUX_LAYOUT;
}

/** The guest OS a provider's sandboxes run. tart and use.computer host
 *  macOS guests. */
export function remoteGuestOsForProvider(
  provider: string | undefined | null,
): RemoteGuestOs {
  return provider === "tart" || provider === "usecomputer" ? "darwin" : "linux";
}

/** The guest user's home for a provider's sandboxes. */
export function remoteGuestHomeForProvider(
  provider: string | undefined | null,
): string {
  if (provider === "usecomputer") return USE_COMPUTER_GUEST_HOME;
  if (provider === "tart") return DARWIN_GUEST_HOME;
  return REMOTE_HOME;
}

export function remoteLayoutForProvider(
  provider: string | undefined | null,
): RemoteLayout {
  return remoteLayout(
    remoteGuestOsForProvider(provider),
    remoteGuestHomeForProvider(provider),
  );
}

function layoutFor(driver: {
  os?: RemoteGuestOs;
  home?: string;
}): RemoteLayout {
  return remoteLayout(driver.os, driver.home);
}

/** The self-contained workload identity client every Sandbox carries. It is
 *  uploaded as one file, so the base runtime never depends on the runner
 *  payload (and a deploy never invalidates it). */
const WORKLOAD_IDENTITY_CLIENT_SOURCE = `${REPO_ROOT}/scripts/workload-identity-client.ts`;

function workloadIdentityClientPath(L: RemoteLayout): string {
  return `${L.home}/.local/share/opensession/workload-identity-client.ts`;
}

/** Shell that installs the sandbox-only `opensession` command surface
 *  (workload identity minting) under ~/.local/bin, as a wrapper around the
 *  uploaded client. Idempotent. */
export function workloadIdentityClientInstallCommand(L: RemoteLayout): string {
  const target = `${L.home}/.local/bin/opensession`;
  const wrapper =
    "#!/bin/sh\n" +
    "# Sandbox-only Open Session command surface: workload identity minting.\n" +
    `exec ${L.bun} ${workloadIdentityClientPath(L)} "$@"\n`;
  return (
    `mkdir -p ${L.home}/.local/bin && ` +
    `rm -f ${shellQuoteWord(target)} && ` +
    `printf %s ${shellQuoteWord(wrapper)} > ${shellQuoteWord(target)} && ` +
    `chmod 755 ${shellQuoteWord(target)} && test -x ${shellQuoteWord(target)} && ` +
    `test -s ${shellQuoteWord(workloadIdentityClientPath(L))}`
  );
}

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
  /** Guest operating system; absent = linux (the legacy layout). */
  os?: RemoteGuestOs;
  /** The guest user's home when it is not the layout's default for `os`
   *  (use.computer's `lume`). */
  home?: string;
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

// Re-exported for the existing importers of this module's URL redaction; the
// implementation moved to the shared util so non-sandbox code can use it too.
export { redactUrl };

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
  /** Which of a provider's hosts holds the sandbox, when the provider spans
   *  several (tart: the Runner id of the Mac). Sleep, wake, desktop, and
   *  terminals go back to that host. */
  host?: string;
  /** The provider's own id for the sandbox when it names sandboxes itself
   *  and that name can change over the session's life (use.computer: the
   *  VM currently holding the session; absent while asleep). */
  remoteId?: string;
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

/** Lifecycle callers must also find machines whose setup failed before the
 * session acquired a sandboxId. Read only provider mappings, never actor DBs,
 * and keep this recovery lookup off synchronous gateway I/O. */
export async function findRemoteStateBySessionAsync(
  provider: string,
  sessionId: string,
): Promise<RemoteSandboxState | null> {
  let files: string[];
  try {
    files = await readdir(STATE_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  for (const file of files) {
    if (!file.startsWith(`${provider}-`) || !file.endsWith(".json")) continue;
    let raw: string;
    try {
      raw = await readFile(`${STATE_DIR}/${file}`, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let state: RemoteSandboxState;
    try {
      state = JSON.parse(raw);
    } catch {
      continue;
    }
    if (state?.provider === provider && state.sessionId === sessionId)
      return withTrustPolicy(state);
  }
  return null;
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
      `remote sandbox bootstrap failed (${what}, exit ${r.exitCode}): ${redactUrl((r.stderr.trim() || r.stdout.trim() || "no command output").slice(0, 500))}`,
    );
  }
}

/**
 * macOS guest (tart) counterpart of the Linux base runtime: the image ships
 * Xcode's command line tools and Homebrew, so only the pinned Node, just, gh,
 * and bun releases plus the two Homebrew utilities the lifecycle contract
 * needs are installed. The same versions as Linux, so bootstrapSignature
 * stays one string for every guest.
 */
async function bootstrapDarwinBaseRuntime(
  driver: RemoteDriver,
  L: RemoteLayout,
  log: (msg: string) => void,
): Promise<void> {
  need(
    await driver.exec(`test -w ${L.home} && test "$(uname -s)" = Darwin`),
    `writable ${L.home} on a Darwin guest`,
  );
  need(
    await driver.exec("sudo -n true"),
    "passwordless sudo for the guest admin user (the tart image contract)",
  );
  const tools = await driver.exec(
    `env PATH=${shellQuoteWord(L.path)} sh -c 'for c in git curl unzip rg sed nl wc base64 python3 make g++ direnv lsof; do command -v "$c" >/dev/null 2>&1 || echo "$c"; done'`,
  );
  const missing = tools.stdout.trim().split(/\s+/).filter(Boolean);
  const brewable: Record<string, string> = { rg: "ripgrep", direnv: "direnv" };
  const formulae = [
    ...new Set(missing.map((c) => brewable[c]).filter(Boolean)),
  ];
  if (formulae.length) {
    log(`installing workspace tools (${formulae.join(", ")})…`);
    need(
      await driver.exec(
        `env PATH=${shellQuoteWord(L.path)} HOMEBREW_NO_AUTO_UPDATE=1 brew install ${formulae.map(shellQuoteWord).join(" ")}`,
        { timeoutMs: 600_000 },
      ),
      "workspace tools install (brew)",
    );
  }
  need(
    await driver.exec(
      `env PATH=${shellQuoteWord(L.path)} sh -c 'for c in git curl unzip rg sed nl wc base64 python3 make g++ direnv lsof; do command -v "$c" >/dev/null 2>&1 || { echo "missing $c" >&2; exit 1; }; done'`,
    ),
    "workspace tools check",
  );

  const node = await driver.exec(
    `/usr/local/bin/node -p 'process.versions.node' 2>/dev/null || true`,
  );
  if (node.stdout.trim() !== REMOTE_NODE_VERSION) {
    log(`installing Node ${REMOTE_NODE_VERSION}…`);
    need(
      await driver.exec(
        `version=${REMOTE_NODE_VERSION}; archive=node-v$version-darwin-arm64.tar.gz; tmp=$(mktemp -d); ` +
          `trap 'rm -rf "$tmp"' EXIT; ` +
          `curl -fsSL https://nodejs.org/download/release/v$version/$archive -o "$tmp/$archive" && ` +
          `curl -fsSL https://nodejs.org/download/release/v$version/SHASUMS256.txt -o "$tmp/SHASUMS256.txt" && ` +
          `(cd "$tmp" && grep "  $archive$" SHASUMS256.txt | shasum -a 256 -c -) && ` +
          `sudo -n mkdir -p /usr/local && sudo -n tar -xzf "$tmp/$archive" --strip-components=1 -C /usr/local`,
        { timeoutMs: 300_000 },
      ),
      `Node ${REMOTE_NODE_VERSION} install`,
    );
  }
  need(
    await driver.exec(
      `explicit=$(/usr/local/bin/node -p 'process.versions.node' 2>/dev/null || true); ` +
        `resolved=$(env PATH=${shellQuoteWord(L.path)} node -p 'process.versions.node' 2>/dev/null || true); ` +
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
        `{ curl -fsSL https://just.systems/install.sh | sudo -n bash -s -- --tag ${REMOTE_JUST_VERSION} --to ${dirname(remoteJust)}; }`,
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

  const remoteGh = "/usr/local/bin/gh";
  log(`ensuring gh ${REMOTE_GH_VERSION}…`);
  need(
    await driver.exec(
      `test -x ${remoteGh} && test "$(${remoteGh} --version | head -n1 | awk '{print $3}')" = "${REMOTE_GH_VERSION}" || ` +
        `{ dist=gh_${REMOTE_GH_VERSION}_macOS_arm64; tmp=$(mktemp -d); ` +
        `trap 'rm -rf "$tmp"' EXIT; ` +
        `curl -fsSL https://github.com/cli/cli/releases/download/v${REMOTE_GH_VERSION}/$dist.zip -o "$tmp/$dist.zip" && ` +
        `curl -fsSL https://github.com/cli/cli/releases/download/v${REMOTE_GH_VERSION}/gh_${REMOTE_GH_VERSION}_checksums.txt -o "$tmp/checksums.txt" && ` +
        `expected=$(grep "  $dist.zip$" "$tmp/checksums.txt") && test -n "$expected" && ` +
        `printf '%s\\n' "$expected" | (cd "$tmp" && shasum -a 256 -c -) && ` +
        `unzip -q "$tmp/$dist.zip" -d "$tmp" && ` +
        `sudo -n install -m 0755 "$tmp/$dist/bin/gh" ${remoteGh}; }`,
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
      `test -x ${L.bun} || curl -fsSL https://bun.sh/install | HOME=${L.home} bash`,
      { timeoutMs: 300_000 },
    ),
    "bun install",
  );
  await ensureRemoteBunxShim(driver, L, log);
}

/** Install the portable base tools needed before the full runner payload. */
async function bootstrapRemoteBaseRuntime(
  driver: RemoteDriver,
  label: string,
): Promise<void> {
  const L = layoutFor(driver);
  const log = (msg: string) =>
    console.log(`[sandbox:${label}] base runtime: ${msg}`);
  if (L.os === "darwin") {
    await bootstrapDarwinBaseRuntime(driver, L, log);
    return;
  }

  need(
    await driver.exec(
      `test -w ${L.home} || (sudo -n mkdir -p ${L.home} && sudo -n chown $(id -u):$(id -g) ${L.home})`,
    ),
    `writable ${L.home} (image needs passwordless sudo or a prebaked /home/ubuntu)`,
  );

  // Provider base images vary. Install the same workspace contract on each:
  // native build tools for dependency installs, direnv/lsof for lifecycle
  // scripts, and the generic shell utilities the workspace tools use.
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
        `resolved=$(env PATH=${shellQuoteWord(L.path)} node -p 'process.versions.node' 2>/dev/null || true); ` +
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

  // gh: agent shell commands rely on it for GitHub work such as PRs, checks,
  // and API calls. Provider base images don't carry it, so install the pinned
  // official release, checksum-verified, into /usr/local/bin.
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
      `test -x ${L.bun} || curl -fsSL https://bun.sh/install | HOME=${L.home} bash`,
      { timeoutMs: 300_000 },
    ),
    "bun install",
  );
  // Some provider images prebake only the `bun` binary. Bun's standard
  // installer also exposes `bunx` as a same-binary shim, and repo tooling
  // commonly invokes that name directly (a repo's own watcher scripts).
  await ensureRemoteBunxShim(driver, L, log);
}

async function ensureRemoteBunxShim(
  driver: RemoteDriver,
  L: RemoteLayout,
  log: (msg: string) => void,
): Promise<void> {
  need(
    await driver.exec(`test -x ${L.bunx} || ln -sf ${L.bun} ${L.bunx}`),
    "bunx shim",
  );
  log("ready");
}

/** What the base runtime marker records: the toolchain every Sandbox gets
 *  (workspace tools, Node, just, gh, bun, the workload identity client). It
 *  names no runner commit, so a deploy leaves prepared Sandboxes alone. */
export function baseRuntimeSignature(): string {
  return (
    `base+node@${REMOTE_NODE_VERSION}+just@${REMOTE_JUST_VERSION}` +
    `+gh@${REMOTE_GH_VERSION}+${REMOTE_RUNTIME_REVISION}+${BASE_RUNTIME_REVISION}`
  );
}

/** Bump when the base runtime contract (not a pinned version) changes. */
const BASE_RUNTIME_REVISION = "base-runtime-v1";

function baseRuntimeMarker(L: RemoteLayout): string {
  return `${L.home}/.opensession-base-runtime`;
}

async function installWorkloadIdentityClient(
  driver: RemoteDriver,
  L: RemoteLayout,
): Promise<void> {
  const source = await readFile(WORKLOAD_IDENTITY_CLIENT_SOURCE, "utf8");
  need(
    await driver.exec(
      `mkdir -p ${shellQuoteWord(dirname(workloadIdentityClientPath(L)))}`,
    ),
    "workload identity client directory",
  );
  await driver.writeFile(workloadIdentityClientPath(L), source);
  need(
    await driver.exec(workloadIdentityClientInstallCommand(L)),
    "workload identity client install",
  );
}

/**
 * The runtime every Sandbox needs, whatever runs in it: workspace tools,
 * pinned Node/just/gh, bun (lifecycle hooks and the Portal relay), and the
 * `opensession` identity command. Idempotent: a matching marker costs one
 * command, which also repairs the identity command (Box archive/resume can
 * drop an executable bit even though the marker survives).
 */
export async function ensureRemoteBaseRuntime(
  driver: RemoteDriver,
  label: string,
): Promise<void> {
  const L = layoutFor(driver);
  const signature = baseRuntimeSignature();
  const marker = await driver.exec(
    `cat ${shellQuoteWord(baseRuntimeMarker(L))} 2>/dev/null`,
  );
  if (marker.exitCode === 0 && marker.stdout.trim() === signature) {
    const repaired = await driver.exec(workloadIdentityClientInstallCommand(L));
    if (repaired.exitCode === 0) return;
    await installWorkloadIdentityClient(driver, L);
    return;
  }
  await bootstrapRemoteBaseRuntime(driver, label);
  await installWorkloadIdentityClient(driver, L);
  need(
    await driver.exec(
      `printf '%s' ${shellQuoteWord(signature)} > ${shellQuoteWord(baseRuntimeMarker(L))}`,
    ),
    "base runtime marker",
  );
}

/**
 * Prepare a remote sandbox for a session: the base runtime (idempotent; a
 * marker short-circuits every later call). The agent loop runs on this
 * server, so nothing else is installed.
 */
export async function bootstrapRemoteSandbox(
  driver: RemoteDriver,
  label: string,
): Promise<void> {
  await ensureRemoteBaseRuntime(driver, label);
}

// ── Workspace (always volume-style: cloned inside the sandbox) ───────────────

// Prewarmed workspace clones live under the layout's warmBase in-sandbox
// until a session adopts them (warmRemoteWorkspace → setupRemoteWorkspace).

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

/** The warm workspace clone for a repo, under a guest layout (a guest OS
 *  names that OS's default layout). */
export function remoteWarmWorkspaceDir(
  repoId: string,
  layout: RemoteGuestOs | RemoteLayout = "linux",
): string {
  const L = typeof layout === "string" ? remoteLayout(layout) : layout;
  return `${L.warmBase}/${sanitizeName(repoId)}`;
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
  const L = layoutFor(driver);
  const dir = remoteWarmWorkspaceDir(repo.id, L);
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
  const bunEnv = `HOME=${L.home} PATH=${shellQuoteWord(L.path)}`;
  const deps = repo.depsInstall
    ? `cd ${shellQuoteWord(dir)} && ${bunEnv} sh -c ${shellQuoteWord(repo.depsInstall)}`
    : `cd ${shellQuoteWord(dir)} && ${bunEnv} sh -c 'if [ -f package.json ]; then ${L.bun} install --frozen-lockfile; fi'`;
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
  dir = remoteWarmWorkspaceDir(repo.id, layoutFor(driver)),
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
  options: {
    seedPrivateFiles?: boolean;
    runLifecycleHooks?: boolean;
    /** Checkpoint to restore into a FRESHLY materialized workspace (see
     * sandbox/checkpoint.ts). A workspace already on disk keeps its disk.
     * Refused, loudly, unless it was taken on `branch`. */
    restoreCheckpoint?: { ref: string; commit: string; branch: string };
  } = {},
): Promise<void> {
  const L = layoutFor(driver);
  const startedAt = Date.now();
  const mark = (stage: string) =>
    console.log(
      `[sandbox-remote] workspace ${repoId || cwd}: ${stage} (+${Date.now() - startedAt}ms)`,
    );
  const warmDir = repoId ? remoteWarmWorkspaceDir(repoId, L) : undefined;
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
    // A checkpoint restore right after needs only the branch name: it
    // fetches the checkpoint (which carries its own history) and moves the
    // branch onto it. Fetching the branch and the default branch first costs
    // two negotiations over a freshly restored, lazily loaded disk (about 40s
    // on a large repository) for refs the restore then replaces.
    const restoresCheckpoint =
      options.restoreCheckpoint?.branch === branch &&
      !!options.restoreCheckpoint;
    const branchStep = restoresCheckpoint
      ? `git -C ${shellQuoteWord(cwd)} update-ref ${shellQuoteWord(`refs/heads/${branch}`)} HEAD && ` +
        `git -C ${shellQuoteWord(cwd)} symbolic-ref HEAD ${shellQuoteWord(`refs/heads/${branch}`)}`
      : `(if ${fetchRef(branch)}; then __start=${shellQuoteWord(`origin/${branch}`)}; else ` +
        `${fetchRef(defaultBranch)} && __start=${shellQuoteWord(`origin/${defaultBranch}`)}; fi; ` +
        `if [ "$(git -C ${shellQuoteWord(cwd)} rev-parse HEAD)" = "$(git -C ${shellQuoteWord(cwd)} rev-parse "$__start")" ]; then ` +
        `git -C ${shellQuoteWord(cwd)} update-ref ${shellQuoteWord(`refs/heads/${branch}`)} "$__start" && ` +
        `git -C ${shellQuoteWord(cwd)} symbolic-ref HEAD ${shellQuoteWord(`refs/heads/${branch}`)}; else ` +
        `git -C ${shellQuoteWord(cwd)} checkout -B ${shellQuoteWord(branch)} "$__start"; fi)`;
    const prepare =
      `{ if [ -f ${shellQuoteWord(owner)} ] && [ "$(cat ${shellQuoteWord(owner)})" != ${shellQuoteWord(cwd)} ]; then exit 73; fi; } && ` +
      `__rc=0; { (${attach}) && ` +
      `git -C ${shellQuoteWord(cwd)} remote set-url origin ${shellQuoteWord(cloneUrl)} && ` +
      `${branchStep} && ` +
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
  try {
    // A fresh workspace (cold clone or adopted warm clone) continues from the
    // session's last checkpoint while origin still carries the clone
    // credential: the branch lands on the checkpoint head with its uncommitted
    // changes. A failure here is loud, because silently starting from origin's
    // branch tip is exactly the data loss the checkpoint exists to prevent.
    if (options.restoreCheckpoint && workspaceState !== "cwd") {
      const { ref, commit, branch: taken } = options.restoreCheckpoint;
      if (taken !== branch)
        throw new Error(
          `checkpoint ${commit.slice(0, 12)} was taken on branch ${taken}, but this session is on ${branch}; rebuild the Sandbox to continue from origin`,
        );
      const restored = await driver.exec(
        checkpointRestoreScript(ref, commit, { branch }),
        { cwd, timeoutMs: 300_000 },
      );
      if (restored.exitCode !== 0) {
        throw new Error(
          `could not restore checkpoint ${commit.slice(0, 12)} from ${ref}: ` +
            `${redactUrl((restored.stderr || restored.stdout).trim().slice(0, 300))}`,
        );
      }
      mark(`checkpoint ${commit.slice(0, 12)} restored`);
    }
  } finally {
    // Installation tokens expire in about an hour. Keep them only for this
    // bounded clone/fetch/restore, then leave a credential-free GitHub origin,
    // also when the restore just failed and the Sandbox is about to be parked
    // as needs-attention. Every run projects a fresh token through the
    // process-local credential helper below, so lazy blob fetches and pushes
    // never depend on a token at rest.
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

/** Shell that restores a checkpoint into the checkout at the current
 * directory: fetch the hidden ref, verify it is the recorded commit, land the
 * branch on the checkpoint's parent, and leave the checkpointed tree as
 * uncommitted changes (sandbox/checkpoint.ts explains the commit shape).
 * `branch` refuses unless that is the checkout's current branch, so a
 * checkpoint never lands on a branch other than the one it was taken from.
 * `onlyForward` additionally refuses unless the current HEAD is an ancestor
 * of the checkpoint, so a checkout that is reused rather than fresh can lose
 * no commit. Nothing is touched before every check has passed. */
export function checkpointRestoreScript(
  ref: string,
  commit: string,
  options: { branch?: string; onlyForward?: boolean } = {},
): string {
  return [
    ...(options.branch
      ? [
          `test "$(git branch --show-current)" = ${shellQuoteWord(options.branch)}`,
        ]
      : []),
    `git fetch --no-tags --quiet origin ${shellQuoteWord(`+${ref}:refs/opensession/checkpoint`)}`,
    `test "$(git rev-parse --verify 'refs/opensession/checkpoint^{commit}')" = ${shellQuoteWord(commit)}`,
    ...(options.onlyForward
      ? [
          // merge-base says nothing on failure; the caller relays stderr.
          "{ git merge-base --is-ancestor HEAD refs/opensession/checkpoint || { echo 'this checkout has commits the checkpoint does not include; restoring would drop them' >&2; false; }; }",
        ]
      : []),
    "git -c advice.detachedHead=false reset --hard --quiet refs/opensession/checkpoint",
    "git reset --mixed --quiet 'refs/opensession/checkpoint^'",
    "git update-ref -d refs/opensession/checkpoint",
  ].join(" && ");
}

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
  const L = layoutFor(driver);
  const key = remoteLifecycleKey(scopeKey) || "workspace";
  const stamp = `${L.lifecycleDir}/${key}-setup.done`;
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
  const L = layoutFor(driver);
  const script = `${cwd}/.agents/${hook}`;
  const key = remoteLifecycleKey(scopeKey || cwd) || "workspace";
  const log = `${L.lifecycleDir}/${key}-${hook}.log`;
  const stamp = `${L.lifecycleDir}/${key}-setup.done`;
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
  const setupBin = `${L.lifecycleDir}/setup-bin`;
  const bunShim = `#!/bin/sh\nif [ "$1" = install ]; then shift; exec ${L.bun} install --frozen-lockfile "$@"; fi\nexec ${L.bun} "$@"\n`;
  const setupGuard =
    hook === "setup"
      ? `mkdir -p ${shellQuoteWord(setupBin)} && printf %s ${shellQuoteWord(bunShim)} > ${shellQuoteWord(`${setupBin}/bun`)} && chmod 755 ${shellQuoteWord(`${setupBin}/bun`)} && `
      : "";
  const lifecyclePath = hook === "setup" ? `${setupBin}:${L.path}` : L.path;
  const command =
    `mkdir -p ${shellQuoteWord(L.lifecycleDir)} && ` +
    setupGuard +
    `: > ${shellQuoteWord(log)} && ` +
    `env HOME=${L.home} PATH=${shellQuoteWord(lifecyclePath)} ${identityArgs} ` +
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

/** A setup failure that comes from a damaged Bun package cache (entries
 *  whose files are gone after a lazily restored disk was sealed into an
 *  image) rather than from the repository. */
export function bunCacheDamaged(message: string): boolean {
  return /downloaded package was not found in the cache|failed copying files from cache/i.test(
    message,
  );
}

/** Drop the guest's Bun package cache and a workspace's installed packages,
 *  so the next install downloads and extracts everything again. */
export async function clearRemoteBunInstall(
  driver: RemoteDriver,
  workspace: string,
): Promise<void> {
  const L = layoutFor(driver);
  need(
    await driver.exec(
      `rm -rf ${shellQuoteWord(`${L.home}/.bun/install/cache`)} ${shellQuoteWord(`${workspace}/node_modules`)}`,
      { timeoutMs: 10 * 60_000 },
    ),
    "clear Bun install cache",
  );
}

/**
 * `.agents/resume` on every real wake. A sandbox that slept keeps its disk but
 * loses every process, so the repository gets one idempotent chance to repair
 * what a fresh boot needs (caches, daemons, generated files) before the agent
 * or a Portal restart runs. Never fails the wake: the log is surfaced in the
 * Sandbox badge instead.
 */
export async function runResumeHook(
  driver: RemoteDriver,
  providerId: SandboxProviderId,
  sandboxId: string,
  state: {
    cwd: string;
    sessionId: string;
    repoId?: string;
    trustProfile?: "interactive" | "automation";
  },
): Promise<void> {
  try {
    await runRemoteLifecycleHook(
      driver,
      state.cwd,
      "resume",
      "resume",
      state.repoId,
      {
        sandboxId,
        provider: providerId,
        sessionId: state.sessionId,
        repoId: state.repoId || "",
        trustProfile: state.trustProfile || "interactive",
      },
    );
  } catch (error) {
    console.warn(
      `[sandbox:${providerId}] ${sandboxId}: .agents/resume failed:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

// ── The Sandbox handle ────────────────────────────────────────────────────────

export interface RemoteSandboxParts {
  providerId: SandboxProviderId;
  sandboxId: string;
  sessionId: string;
  cwd: string;
  driver: RemoteDriver;
  ports(requestedPorts?: number[]): Promise<PortMap>;
  status(): Promise<SandboxStatus>;
  /** Activity ping (state file + provider-native keepalive). */
  touchActivity(): void | Promise<void>;
}

/** stderr of a provider exec whose machine or command plane is not there. */
const TRANSPORT_FAILURE =
  /not running|not started|stopped|archived|timed out|ECONN|socket|HTTP 5\d\d|did not accept commands|machine_not_running/i;

export function makeRemoteSandbox(parts: RemoteSandboxParts): Sandbox {
  let touchedAt = 0;
  let startedAt = 0;
  const touch = () => {
    touchedAt = Date.now();
    try {
      void parts.touchActivity();
    } catch {}
  };
  /** A burst caller (assumeStarted) re-checks the machine and refreshes its
   *  keepalive at most once a minute; everyone else on every call. */
  const RECHECK_MS = 60_000;
  const sandboxHandle: Sandbox = {
    id: parts.sandboxId,
    provider: parts.providerId,
    cwd: parts.cwd,
    workspace: "volume",

    async exec(cmd: string[], opts?: ExecOpts): Promise<ExecResult> {
      const burst = opts?.assumeStarted === true;
      if (!burst || Date.now() - startedAt > RECHECK_MS) {
        await parts.driver.ensureStarted();
        startedAt = Date.now();
      }
      if (!burst || Date.now() - touchedAt > RECHECK_MS) touch();
      const remoteOptions = {
        cwd: parts.cwd,
        env: {
          ...(opts?.workloadIdentity === false
            ? {}
            : createWorkloadIdentityEnv({
                sandboxId: parts.sandboxId,
                provider: parts.providerId,
                lifecycle: "run" as const,
                sessionId: parts.sessionId,
              })),
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
      if (!burst) touch();
      // A burst skips the wake check; after an answer that looks like the
      // machine or its command plane went away, the next call makes it.
      else if (result.exitCode !== 0 && TRANSPORT_FAILURE.test(result.stderr))
        startedAt = 0;
      return result;
    },

    ports: (requestedPorts) => parts.ports(requestedPorts),
    status: () => parts.status(),
  };
  return sandboxHandle;
}
