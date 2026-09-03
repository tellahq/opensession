/**
 * DaytonaProvider — remote sandbox adapter over the Daytona API
 * (docs/self-hosting-sandboxes.md).
 *
 * LICENSING: the Daytona *platform* is AGPL-3.0, but it is consumed here
 * purely over its HTTP API via the official TypeScript SDK `@daytonaio/sdk`
 * (pinned 0.194.0), which is **Apache-2.0** (verified from the npm `license`
 * field, 2026-07-08). No AGPL code is imported, linked, or vendored; AGPL
 * obligations rest with whoever operates the Daytona deployment (their cloud,
 * or a self-hosted Helm/K8s install).
 *
 * Shape (shared machinery in ./bootstrap.ts):
 *  - ensure(): find the session's sandbox by label `opensession.session=<id>`
 *    (create with the config's resources otherwise), bootstrap the runner
 *    payload, clone the workspace INSIDE the sandbox (always volume-style —
 *    never a host mount; `cloneCredential` does the auth). Idle-stop uses
 *    Daytona's NATIVE autoStopInterval (minutes) — no opensession sweep needed.
 *  - launchRun(): HOST_ENTRY in-sandbox via a Daytona process session
 *    (runAsync — survives this call and this process), WS transport back to
 *    `callbackBaseUrl` (remote sandboxes have no socket option).
 *  - exec(): `process.executeCommand` returns no output for non-zero commands,
 *    so commands run in a subshell and encode stdout, stderr, and the real
 *    exit code into a successful transport response (see daytonaDriver).
 *  - ports(): getPreviewLink(port) URLs + private-preview tokens → PortMap
 *    entries. OpenSession's authenticated Caddy portal adds the token to the
 *    upstream request; it never reaches the browser or workspace.
 *  - get()/destroy(): by sandbox id; destroy deletes the sandbox and with it
 *    the workspace — push your work (volume-mode contract).
 *
 * The SDK is imported lazily inside methods so opensession boot never pays its
 * dependency tree (otel/aws-sdk) unless the provider is actually used.
 * Credentials and provider settings come only from the normalized workspace
 * connection.
 */

import type { Daytona, Sandbox as DaytonaSandbox } from "@daytonaio/sdk";
import { getRepo, worktreePathFor } from "../../worktree";
import { sandboxConfig, remoteSandboxCallbackBaseUrl } from "../config";
import { audit } from "../../audit";
import {
  automationEgressDomains,
  automationEgressProbeBlockedUrl,
  daytonaDomainAllowList,
} from "../automation-egress";
import {
  getSandboxConnection,
  sandboxProviderCredential,
} from "../connections";
import type {
  PortMap,
  Sandbox,
  SandboxProvider,
  SandboxSessionSpec,
  SandboxStatus,
} from "../provider";
import {
  assertDialbackReachable,
  bootstrapRemoteSandbox,
  findRemoteStateBySession,
  makeRemoteSandbox,
  readRemoteState,
  remoteCloneUrl,
  removeRemoteState,
  resolveTrustPolicy,
  setupRemoteWorkspace,
  shellQuoteWord,
  touchRemoteState,
  withRemoteEnsureLock,
  writeRemoteState,
  type RemoteDriver,
  type RemoteExecOpts,
} from "./bootstrap";
import {
  claimPrewarmOrWait,
  discardClaimedPrewarm,
  PREWARM_KEY_LABEL,
  PREWARM_LABEL,
  type PrewarmAdapter,
} from "../prewarm";
import {
  invalidateRemoteRepoTemplate,
  readRemoteRepoTemplate,
  remoteRepoTemplateName,
  sealRemoteRepoTemplate,
  writeRemoteRepoTemplate,
} from "../remote-repo-template";

const SESSION_LABEL = "opensession.session";
const DEFAULT_IDLE_STOP_MINUTES = 30;
/** Automation Executors are destroyed by the launcher after the run; the
 *  provider-side stop/delete intervals only catch a crashed coordinator. */
const AUTOMATION_IDLE_STOP_MINUTES = 60;
/**
 * Prove the domain allowlist is enforced inside the guest: the dial-back host
 * must answer and a host outside the list must not. Qualification confirms the
 * Daytona base image provides curl before automation use is enabled.
 */
export async function assertAutomationEgressRestricted(
  driver: RemoteDriver,
  callbackBaseUrl: string,
  blockedUrl: string,
): Promise<void> {
  const httpBase = callbackBaseUrl
    .replace(/\/+$/, "")
    .replace(/^ws(s?):\/\//, "http$1://");
  const probe = await driver.exec(
    `command -v curl >/dev/null 2>&1 || { echo __OPENSESSION_NO_CURL__; exit 0; }; ` +
      `a=$(curl -sS -o /dev/null -m 10 -w '%{http_code}' ${shellQuoteWord(`${httpBase}/`)} 2>/dev/null || true); ` +
      `b=$(curl -sS -o /dev/null -m 10 -w '%{http_code}' ${shellQuoteWord(blockedUrl)} 2>/dev/null || true); ` +
      `echo "allowed=$a blocked=$b"`,
    { timeoutMs: 40_000 },
  );
  if (probe.stdout.includes("__OPENSESSION_NO_CURL__")) {
    throw new Error(
      "automation egress policy cannot be verified: curl is missing in the Executor",
    );
  }
  const match = /allowed=(\d{3}) blocked=(\d{3})/.exec(probe.stdout);
  if (!match) {
    throw new Error(
      `automation egress probe failed: ${(probe.stderr || probe.stdout).trim().slice(0, 300)}`,
    );
  }
  const [, allowed, blocked] = match;
  if (allowed === "000") {
    throw new Error(
      `automation egress policy blocks the dial-back URL ${httpBase}; check callbackBaseUrl and the Daytona org tier`,
    );
  }
  if (blocked !== "000") {
    throw new Error(
      `automation egress policy is not enforced by this Daytona org (unlisted host answered ${blocked}); sandbox automations need a Tier 3+ or self-hosted Daytona`,
    );
  }
}
// Daytona's image keeps the process user + passwordless-sudo contract that
// bootstrapRemoteSandbox needs. A plain Ubuntu image launches correctly but
// cannot create the stable /home/ubuntu layout.
const DEFAULT_DAYTONA_IMAGE = "daytonaio/sandbox:0.8.0";
/** Delimits stdout from stderr inside the merged executeCommand output. */
const ERR_DELIM = "__OS_STDERR_7f3a__";
/** Delimits stderr from the encoded command exit code. */
const EXIT_DELIM = "__OS_EXIT_91c2__";

export function parseDaytonaExecResult(res: {
  exitCode?: number;
  result?: unknown;
}): { exitCode: number; stdout: string; stderr: string } {
  const out = String(res.result ?? "");
  const exitIdx = out.lastIndexOf(EXIT_DELIM);
  const encodedExit =
    exitIdx >= 0 ? Number(out.slice(exitIdx + EXIT_DELIM.length)) : NaN;
  const streams =
    exitIdx >= 0 && Number.isInteger(encodedExit) ? out.slice(0, exitIdx) : out;
  const stderrIdx = streams.indexOf(ERR_DELIM);
  return {
    exitCode: Number.isInteger(encodedExit)
      ? encodedExit
      : Number(res.exitCode ?? 1),
    stdout: stderrIdx >= 0 ? streams.slice(0, stderrIdx) : streams,
    stderr: stderrIdx >= 0 ? streams.slice(stderrIdx + ERR_DELIM.length) : "",
  };
}

function daytonaConfig(): ReturnType<typeof sandboxConfig> {
  const cfg = sandboxConfig();
  const settings = getSandboxConnection("daytona")?.settings || {};
  return {
    ...cfg,
    cpus: settings.cpu,
    memory: settings.memoryMb ? `${settings.memoryMb}m` : undefined,
    daytona: {
      apiUrl: settings.apiUrl,
      target: settings.target,
      snapshot: settings.snapshot,
    },
  };
}

function daytonaMemoryGiB(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d+(?:\.\d+)?)([kmg])b?$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "g") return Math.max(1, Math.ceil(amount));
  if (unit === "m") return Math.max(1, Math.ceil(amount / 1024));
  return Math.max(1, Math.ceil(amount / 1024 / 1024));
}

export function daytonaCreateResources(
  cfg: ReturnType<typeof sandboxConfig>,
  overrides?: { cpu?: number; memoryMb?: number; diskGb?: number },
) {
  const memory = overrides?.memoryMb
    ? Math.max(1, Math.ceil(overrides.memoryMb / 1024))
    : daytonaMemoryGiB(cfg.memory);
  const cpu = overrides?.cpu || cfg.cpus;
  return cpu || memory || overrides?.diskGb
    ? { cpu: cpu || 2, memory: memory || 4, disk: overrides?.diskGb || 10 }
    : undefined;
}

/** Daytona's no-source create overload restores its default snapshot. Custom
 * resources are only valid on the image overload, so make that distinction
 * explicit instead of relying on the SDK to infer it from `resources`. */
export function daytonaCreateSource(
  snapshot?: string,
  resources?: { cpu?: number; memory?: number; disk?: number },
):
  | { snapshot: string }
  | {
      image: string;
      resources: { cpu?: number; memory?: number; disk?: number };
    }
  | Record<string, never> {
  if (snapshot) return { snapshot };
  if (resources) return { image: DEFAULT_DAYTONA_IMAGE, resources };
  return {};
}

export function daytonaSnapshotIsRecoverable(
  snapshot: {
    state?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
  },
  now = Date.now(),
): boolean {
  const completedAt = Date.parse(
    String(snapshot.updatedAt || snapshot.createdAt || ""),
  );
  const age = now - completedAt;
  return (
    String(snapshot.state || "").toLowerCase() === "active" &&
    Number.isFinite(completedAt) &&
    age >= 0 &&
    age < 60 * 60_000
  );
}

function daytonaNotFound(error: unknown): boolean {
  const detail = error as { statusCode?: number; errorCode?: string };
  return (
    detail?.statusCode === 404 || /not.?found/i.test(detail?.errorCode || "")
  );
}

export function daytonaSnapshotIsRecent(
  snapshot: {
    createdAt?: unknown;
    updatedAt?: unknown;
  },
  now = Date.now(),
): boolean {
  const startedAt = Date.parse(
    String(snapshot.updatedAt || snapshot.createdAt || ""),
  );
  const age = now - startedAt;
  return Number.isFinite(startedAt) && age >= 0 && age < 60 * 60_000;
}

async function getDaytonaSnapshot(
  client: Daytona,
  name: string,
): Promise<any | null> {
  try {
    return await client.snapshot.get(name);
  } catch (error) {
    if (daytonaNotFound(error)) return null;
    throw error;
  }
}

async function recoverDaytonaRepoTemplate(client: Daytona, repoId: string) {
  const stored = readRemoteRepoTemplate("daytona", repoId);
  if (stored) return stored;
  const name = remoteRepoTemplateName("daytona", repoId);
  let snapshot = await getDaytonaSnapshot(client, name);
  if (
    snapshot &&
    daytonaSnapshotIsRecent(snapshot) &&
    !daytonaSnapshotIsRecoverable(snapshot)
  ) {
    // Snapshot publication continues provider-side across a coordinator
    // restart. Wait for that current-signature artifact instead of launching
    // a second cold workspace beside it.
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline && daytonaSnapshotIsRecent(snapshot)) {
      const state = String(snapshot.state || "").toLowerCase();
      if (/fail|error/.test(state)) break;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      snapshot = await getDaytonaSnapshot(client, name);
      if (!snapshot || daytonaSnapshotIsRecoverable(snapshot)) break;
    }
  }
  if (!snapshot || !daytonaSnapshotIsRecoverable(snapshot)) return null;
  writeRemoteRepoTemplate("daytona", repoId, name);
  console.log(`[sandbox:daytona] recovered completed repo template ${name}`);
  return readRemoteRepoTemplate("daytona", repoId);
}

async function waitForDaytonaSnapshotGone(
  client: Daytona,
  name: string,
  timeoutMs = 2 * 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await getDaytonaSnapshot(client, name))) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `Daytona snapshot ${name} was not deleted after ${timeoutMs}ms`,
  );
}

async function daytonaClient(): Promise<Daytona> {
  const cfg = daytonaConfig().daytona || {};
  const apiKey = (
    sandboxProviderCredential("daytona") as { apiKey: string } | undefined
  )?.apiKey;
  if (!apiKey) {
    throw new Error("Daytona workspace credentials are not configured");
  }
  const { Daytona } = await import("@daytonaio/sdk");
  return new Daytona({ apiKey, apiUrl: cfg.apiUrl, target: cfg.target as any });
}

// ── Driver ────────────────────────────────────────────────────────────────────

function daytonaDriver(sbx: DaytonaSandbox): RemoteDriver {
  return {
    async exec(cmd: string, opts?: RemoteExecOpts) {
      // Daytona omits `result` when the transported shell exits non-zero. Run
      // the caller's command in a subshell (so `exit` cannot skip our trailer),
      // encode its real exit code, and keep the outer transport successful.
      const wrapped =
        `__o=$(mktemp); __e=$(mktemp); ( ${cmd}\n) >"$__o" 2>"$__e"; __c=$?; ` +
        `cat "$__o"; printf '%s' ${shellQuoteWord(ERR_DELIM)}; cat "$__e"; ` +
        `printf '%s%s' ${shellQuoteWord(EXIT_DELIM)} "$__c"; rm -f "$__o" "$__e"; exit 0`;
      try {
        const res = await sbx.process.executeCommand(
          wrapped,
          opts?.cwd,
          opts?.env,
          Math.ceil((opts?.timeoutMs ?? 120_000) / 1000),
        );
        return parseDaytonaExecResult(res);
      } catch (e: any) {
        return { exitCode: 1, stdout: "", stderr: String(e?.message || e) };
      }
    },

    async execBackground(cmd: string, opts?: RemoteExecOpts) {
      // Process sessions are Daytona's documented long-lived exec surface;
      // runAsync detaches from this call (and this process) entirely.
      const sid = `bks-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      await sbx.process.createSession(sid);
      const cd = opts?.cwd ? `cd ${shellQuoteWord(opts.cwd)} && ` : "";
      const env =
        opts?.env && Object.keys(opts.env).length
          ? `env ${Object.entries(opts.env)
              .map(([key, value]) => `${key}=${shellQuoteWord(value)}`)
              .join(" ")} `
          : "";
      await sbx.process.executeSessionCommand(sid, {
        command: `${cd}${env}${cmd}`,
        runAsync: true,
      } as any);
    },

    async writeFile(path: string, content: string) {
      await sbx.fs.uploadFile(Buffer.from(content, "utf-8"), path);
    },

    async ensureStarted() {
      try {
        await (sbx as any).refreshData?.();
      } catch {}
      if ((sbx as any).state !== "started") {
        await sbx.start();
      }
    },
  };
}

/** IO wiring the Shell tab hands a remote PTY (see src/server/terminals.ts). */
export interface RemotePtyIo {
  cols: number;
  rows: number;
  onData: (chunk: Uint8Array) => void;
  /** Fired once when the remote shell exits (undefined = unknown code). */
  onExit: (code: number | undefined) => void;
}

/** Live remote-PTY handle: input, resize (real SIGWINCH), teardown. */
export interface RemotePtyHandle {
  write: (data: Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
}

/**
 * Interactive shell inside a Daytona sandbox (the session viewer's Shell tab
 * — see src/server/terminals.ts): wake the sandbox and open the SDK's native
 * PTY (`process.createPty`, a WebSocket to the sandbox's toolbox API) in the
 * session's workspace.
 *
 * Why not ssh: the previous transport (`ssh <token>@ssh.app.daytona.io` with
 * a remote command) never got a remote tty — the gateway ignores pty-req on
 * exec channels — so the shell had no prompt/echo and the tab looked dead
 * (2026-07-09). The SDK PTY is a real tty: prompt, echo, and resize all work,
 * and there's no per-shell token to mint/revoke. The socket terminates at
 * opensession; the browser still only speaks the tailnet-gated session WS.
 */
export async function daytonaPtySession(
  sandboxId: string,
  cwd: string,
  io: RemotePtyIo,
): Promise<RemotePtyHandle> {
  const client = await daytonaClient();
  const sbx = await client.get(sandboxId);
  if (!sbx || stateOf(sbx) === "gone") {
    throw new Error(`daytona sandbox ${sandboxId} is gone`);
  }
  await daytonaDriver(sbx).ensureStarted();
  const pty = await sbx.process.createPty({
    id: `shell-${crypto.randomUUID().slice(0, 8)}`,
    cwd,
    envs: { TERM: "xterm-256color" },
    cols: io.cols,
    rows: io.rows,
    onData: io.onData,
  });
  await pty.waitForConnection();
  void pty.wait().then(
    (r) => io.onExit(r?.exitCode),
    () => io.onExit(undefined),
  );
  return {
    write: (data) => void pty.sendInput(data).catch(() => {}),
    resize: (cols, rows) => void pty.resize(cols, rows).catch(() => {}),
    close: () => {
      void pty
        .kill()
        .catch(() => {})
        .finally(() => void pty.disconnect().catch(() => {}));
    },
  };
}

function stateOf(sbx: DaytonaSandbox): SandboxStatus {
  const s = String((sbx as any).state || "");
  if (s === "started") return "running";
  if (["stopped", "archived", "paused", "stopping", "starting"].includes(s))
    return "stopped";
  if (!s) return "stopped";
  return s === "destroyed" || s === "destroying" || s === "error"
    ? "gone"
    : "stopped";
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class DaytonaProvider implements SandboxProvider {
  readonly id = "daytona" as const;

  ensure(spec: SandboxSessionSpec): Promise<Sandbox> {
    return withRemoteEnsureLock(this.id, spec.sessionId, () =>
      this.ensureInner(spec),
    );
  }

  private async ensureInner(spec: SandboxSessionSpec): Promise<Sandbox> {
    const startedAt = Date.now();
    const mark = (stage: string) =>
      console.log(
        `[sandbox:daytona] ${spec.sessionId}: ${stage} (+${Date.now() - startedAt}ms)`,
      );
    if (spec.attachedDirs?.length) {
      throw new Error(
        "attached repos are not supported in remote sandboxes — detach them or use docker/local",
      );
    }
    const cfg = daytonaConfig();
    const client = await daytonaClient();
    const prevState = findRemoteStateBySession(this.id, spec.sessionId);
    const trust = resolveTrustPolicy(spec, prevState);
    const sourceVerification = spec.sourceVerification === true;
    if (
      sourceVerification &&
      (trust.trustProfile !== "automation" || spec.cloneCredential !== "none")
    ) {
      throw new Error(
        "source verification requires the automation trust profile and a credential-free clone",
      );
    }
    // Unattended runs (public review and sandboxed automations) get a fresh
    // disposable Executor: no prewarm or repo-template adoption, short
    // provider-side auto-delete backstops, and strict disposal on failure.
    const disposable =
      sourceVerification || trust.trustProfile === "automation";
    const repo = getRepo(spec.repo || prevState?.repoId);
    const branch = spec.branch || prevState?.branch || repo.defaultBranch;
    const cloneUrl = await remoteCloneUrl(repo, {
      credential: spec.cloneCredential,
    });
    const automationDomains =
      trust.trustProfile === "automation" && !sourceVerification
        ? automationEgressDomains({
            callbackBaseUrl: remoteSandboxCallbackBaseUrl(),
            cloneUrl,
            extra: [
              ...trust.egressAllowlist,
              ...(cfg.runnerBundleUrl ? [cfg.runnerBundleUrl] : []),
              ...(cfg.runnerRepoUrl ? [cfg.runnerRepoUrl] : []),
            ],
          })
        : undefined;
    const verificationKey = spec.sessionId.replace(/[^A-Za-z0-9_.-]+/g, "-");
    const cwd =
      spec.cwd ||
      prevState?.cwd ||
      (sourceVerification
        ? `/tmp/opensession-public-review/${verificationKey}`
        : worktreePathFor(branch, repo.id, { isolated: true }));

    // Find by label (authoritative), else create.
    let sbx: DaytonaSandbox | null = null;
    let newlyCreated = false;
    let preparedWorkspace = false;
    // The durable local mapping is written immediately after provider create,
    // before workspace setup. Prefer its O(1) id lookup: Daytona's filtered
    // account-wide list took 20–21s even when no matching sandbox existed.
    if (prevState) {
      try {
        sbx = await client.get(prevState.sandboxId);
      } catch {}
    }
    if (sbx && stateOf(sbx) === "gone") sbx = null;
    if (!sbx && !disposable) {
      // Warm-on-typing adoption (src/server/sandbox/prewarm.ts): a ready
      // prewarm for (daytona, repo) whose runner pin + snapshot still match
      // is claimed atomically and relabeled to this session — the expensive
      // bootstrap below becomes a marker no-op and only the workspace clone
      // remains. When the prewarm is still MID-BOOTSTRAP (the common case:
      // typing→send is seconds, bootstrap ~20-60s) this WAITS for it instead
      // of cold-creating a racing sibling next to the warming sandbox. Any
      // hiccup falls through to the cold create; the claimed sandbox is
      // discarded so paid compute never dangles.
      const claim = await claimPrewarmOrWait(this.id, repo.id, spec.sessionId);
      if (claim) {
        try {
          const cand = await client.get(claim.sandboxId);
          if (cand && stateOf(cand) !== "gone") {
            // setLabels REPLACES the label map — the prewarm labels vanish
            // here, which is what retires it from the pool's orphan audit.
            await cand.setLabels({
              [SESSION_LABEL]: spec.sessionId,
              "opensession.sandbox": "1",
            });
            // Swap the pool's short-TTL backstops for the session lifecycle.
            await cand.setAutostopInterval(
              cfg.idleStopMinutes || DEFAULT_IDLE_STOP_MINUTES,
            );
            await cand.setAutoDeleteInterval(-1);
            sbx = cand;
            preparedWorkspace = true;
            console.log(
              `[sandbox:daytona] adopted prewarmed sandbox ${cand.id} for ${spec.sessionId}`,
            );
          } else {
            discardClaimedPrewarm(this.id, claim.sandboxId);
          }
        } catch (e) {
          console.warn(
            `[sandbox:daytona] prewarm adoption failed (cold-creating):`,
            e,
          );
          sbx = null;
          discardClaimedPrewarm(this.id, claim.sandboxId);
        }
      }
    }
    if (!sbx) {
      console.log(`[sandbox:daytona] creating sandbox for ${spec.sessionId}`);
      // Sizing comes from the configured org snapshot — custom `resources`
      // are rejected when creating from a snapshot (live-API behavior
      // 2026-07). Unset = Daytona's default snapshot (1 vCPU/1GB/3GiB disk),
      // too small for real repo workspaces: the runner payload alone is ~2GB
      // and a large repo's clone died on ENOSPC. See SandboxDaytonaConfig.
      const template = disposable
        ? undefined
        : await recoverDaytonaRepoTemplate(client, repo.id);
      // A prepared repo template already carries its machine shape. When the
      // template is absent/stale (first launch after a merge), the cold
      // fallback must use the same per-project profile; Daytona's default
      // 3 GiB disk cannot even install the OpenSession runner for real repos.
      const { sandboxEnvironmentSettings } = await import("../environments");
      const projectResources = sandboxEnvironmentSettings(repo.id, "daytona");
      const create = (snapshot?: string) => {
        const resources = daytonaCreateResources(cfg, projectResources);
        return client.create(
          {
            ...daytonaCreateSource(snapshot, resources),
            labels: {
              [SESSION_LABEL]: spec.sessionId,
              "opensession.sandbox": "1",
              ...(sourceVerification
                ? { "opensession.public-review": "1" }
                : {}),
              ...(trust.trustProfile === "automation" && !sourceVerification
                ? { "opensession.automation": "1" }
                : {}),
            },
            autoStopInterval: sourceVerification
              ? 10
              : disposable
                ? AUTOMATION_IDLE_STOP_MINUTES
                : cfg.idleStopMinutes || DEFAULT_IDLE_STOP_MINUTES,
            ...(automationDomains
              ? { domainAllowList: daytonaDomainAllowList(automationDomains) }
              : {}),
            ...(disposable ? { autoDeleteInterval: 30 } : {}),
          } as any,
          { timeout: 300 },
        );
      };
      try {
        sbx = await create(
          disposable
            ? undefined
            : template?.artifactId || cfg.daytona?.snapshot,
        );
        preparedWorkspace = Boolean(template);
      } catch (error) {
        if (!template || !daytonaNotFound(error)) throw error;
        // Provider artifacts can be deleted independently of the local index.
        // Drop only a confirmed-missing mapping. A timeout, conflict, or rate
        // limit must not destroy a valid fleet-wide fast path.
        invalidateRemoteRepoTemplate("daytona", repo.id);
        console.warn(
          `[sandbox:daytona] repo template ${template.artifactId} is unavailable; retrying cold`,
        );
        sbx = await create(cfg.daytona?.snapshot);
        preparedWorkspace = false;
      }
      newlyCreated = true;
      mark("sandbox created");
    }

    // Persist the provider id before any optional setup. A coordinator restart
    // can now recover directly instead of scanning provider labels or creating
    // a duplicate sandbox after a partially completed launch.
    writeRemoteState({
      sandboxId: sbx.id,
      provider: this.id,
      sessionId: spec.sessionId,
      cwd,
      repoId: repo.id,
      branch,
      createdAt: prevState?.createdAt || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      ...trust,
    });

    try {
      const driver = daytonaDriver(sbx);
      // client.create resolves only after Daytona reports the sandbox started.
      // A second refresh/start round trip added 2–3s to every snapshot restore.
      if (!newlyCreated) await driver.ensureStarted();
      mark("sandbox started");
      if (automationDomains) {
        // Enforce before bootstrap, repository setup hooks, private workspace
        // seeds, or model credentials can enter the guest. Reapplying also
        // closes a crash-recovery path where the provider created the sandbox
        // but had not yet persisted its network policy.
        await sbx.updateNetworkSettings({
          domainAllowList: daytonaDomainAllowList(automationDomains),
        });
        await assertAutomationEgressRestricted(
          driver,
          remoteSandboxCallbackBaseUrl(),
          automationEgressProbeBlockedUrl(automationDomains),
        );
        audit({
          kind: "sandbox_automation_egress",
          session_id: spec.sessionId,
          provider: this.id,
          sandbox_id: sbx.id,
          resolved_targets: automationDomains,
          outcome: "ok",
        });
        mark("egress restricted");
      }
      const prepareRunner = async () => {
        if (sourceVerification) return;
        // A sandbox that cannot reach our callback URL can never run anything.
        await assertDialbackReachable(driver, "daytona");
        mark("dial-back verified");
        await bootstrapRemoteSandbox(driver, "daytona");
        mark("runner ready");
      };
      const prepareWorkspace = async () => {
        await setupRemoteWorkspace(
          driver,
          cwd,
          cloneUrl,
          branch,
          repo.defaultBranch,
          repo.id,
          {
            sandboxId: sbx.id,
            provider: this.id,
            sessionId: spec.sessionId,
            repoId: repo.id,
            trustProfile: trust.trustProfile,
          },
          {
            seedPrivateFiles:
              trust.trustProfile !== "automation" && !sourceVerification,
            runLifecycleHooks: !sourceVerification,
          },
        );
        mark("workspace ready");
      };
      // Repo snapshots and adopted prewarms already contain both the runner and
      // lifecycle stamp, so these independent command lanes can overlap. A cold
      // workspace remains sequential because .agents/setup may need the runner's
      // workload-identity client.
      if (preparedWorkspace)
        await Promise.all([prepareRunner(), prepareWorkspace()]);
      else {
        await prepareRunner();
        await prepareWorkspace();
      }
      writeRemoteState({
        sandboxId: sbx.id,
        provider: this.id,
        sessionId: spec.sessionId,
        cwd,
        repoId: repo.id,
        branch,
        createdAt: prevState?.createdAt || new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        ...trust,
      });
      return this.makeHandle(sbx, spec.sessionId, cwd);
    } catch (error) {
      if (disposable) {
        try {
          await this.destroy(sbx.id, { strict: true });
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "disposable Executor setup failed and strict disposal also failed",
          );
        }
      }
      throw error;
    }
  }

  private makeHandle(
    sbx: DaytonaSandbox,
    sessionId: string,
    cwd: string,
  ): Sandbox {
    const providerId = this.id;
    return makeRemoteSandbox({
      providerId,
      sandboxId: sbx.id,
      sessionId,
      cwd,
      driver: daytonaDriver(sbx),
      async ports(requestedPorts = []): Promise<PortMap> {
        const map: PortMap = {};
        const ports = new Set([
          ...(sandboxConfig().previewPorts || []),
          ...requestedPorts.filter(
            (port) => Number.isInteger(port) && port > 0 && port <= 65_535,
          ),
        ]);
        for (const port of ports) {
          try {
            const link = await sbx.getPreviewLink(port);
            if (link?.url) {
              map[port] = {
                url: link.url,
                requestHeaders: {
                  ...(link.token
                    ? { "X-Daytona-Preview-Token": link.token }
                    : {}),
                  "X-Daytona-Skip-Preview-Warning": "true",
                },
              };
            }
          } catch (e) {
            console.warn(
              `[sandbox:daytona] getPreviewLink(${port}) failed:`,
              e,
            );
          }
        }
        return map;
      },
      async status(): Promise<SandboxStatus> {
        try {
          await (sbx as any).refreshData?.();
          return stateOf(sbx);
        } catch {
          return "gone";
        }
      },
      touchActivity: () => touchRemoteState(providerId, sbx.id),
    });
  }

  async get(sandboxId: string): Promise<Sandbox | null> {
    const state = readRemoteState(this.id, sandboxId);
    if (!state) return null;
    try {
      const client = await daytonaClient();
      const sbx = await client.get(sandboxId);
      if (!sbx || stateOf(sbx) === "gone") return null;
      return this.makeHandle(sbx, state.sessionId, state.cwd);
    } catch (e) {
      console.warn(`[sandbox:daytona] get(${sandboxId}) failed:`, e);
      return null;
    }
  }

  /** Release compute while retaining the session's exact volume workspace. */
  async pause(sandboxId: string): Promise<void> {
    const client = await daytonaClient();
    const sbx = await client.get(sandboxId);
    if (sbx && stateOf(sbx) === "running") await sbx.stop(120);
  }

  async resume(sandboxId: string): Promise<Sandbox | null> {
    const state = readRemoteState(this.id, sandboxId);
    if (!state) return null;
    const client = await daytonaClient();
    const sbx = await client.get(sandboxId);
    if (!sbx || stateOf(sbx) === "gone") return null;
    if (stateOf(sbx) !== "running") await sbx.start(120);
    await daytonaDriver(sbx).ensureStarted();
    return this.makeHandle(sbx, state.sessionId, state.cwd);
  }

  /** Deletes the sandbox — and with it the volume-style workspace (documented
   *  data loss: push your work). */
  async destroy(
    sandboxId: string,
    options: { strict?: boolean } = {},
  ): Promise<void> {
    try {
      const client = await daytonaClient();
      const sbx = await client.get(sandboxId);
      if (sbx) await client.delete(sbx, 120);
      if (options.strict) {
        let remaining: DaytonaSandbox | undefined;
        try {
          remaining = await client.get(sandboxId);
        } catch (error) {
          if (!daytonaNotFound(error)) throw error;
        }
        if (remaining && stateOf(remaining) !== "gone") {
          throw new Error(
            `Daytona sandbox ${sandboxId} still exists after deletion`,
          );
        }
      }
      removeRemoteState(this.id, sandboxId);
    } catch (error) {
      if (options.strict) throw error;
      console.warn(`[sandbox:daytona] destroy(${sandboxId}):`, error);
      removeRemoteState(this.id, sandboxId);
    }
  }
}

// ── Warm-on-typing prewarm hooks (src/server/sandbox/prewarm.ts) ─────────────

/**
 * The pool's provider hooks. Prewarm creates mirror the session create shape
 * (same org snapshot — sizing is create-time, so an adopted sandbox must
 * already be the right size) but carry the PREWARM labels instead of a
 * session label, plus provider-side autoStop/autoDelete backstops so a
 * crashed opensession can't leak paid compute. Loaded lazily by prewarm.ts —
 * this module statically imports claimPrewarm from there, so the reverse
 * edge must stay dynamic.
 */
export const daytonaPrewarmAdapter: PrewarmAdapter = {
  async create(labels, opts) {
    const cfg = daytonaConfig();
    const key = labels[PREWARM_KEY_LABEL] || "";
    const repoId = key.startsWith("daytona:")
      ? key.slice("daytona:".length)
      : "";
    if (!repoId)
      throw new Error(`invalid Daytona prewarm key: ${key || "(missing)"}`);
    const client = await daytonaClient();
    const template = await recoverDaytonaRepoTemplate(client, repoId);
    const create = (snapshot?: string) => {
      const resources = daytonaCreateResources(cfg, opts.resources);
      return client.create(
        {
          ...daytonaCreateSource(snapshot, resources),
          labels,
          autoStopInterval: opts.autoStopMinutes,
          autoDeleteInterval: opts.autoDeleteMinutes,
        } as any,
        { timeout: 300 },
      );
    };
    let sbx: DaytonaSandbox;
    let restoredFromTemplate = Boolean(template);
    try {
      sbx = await create(template?.artifactId || cfg.daytona?.snapshot);
    } catch (error) {
      if (!template || !daytonaNotFound(error)) throw error;
      invalidateRemoteRepoTemplate("daytona", repoId);
      restoredFromTemplate = false;
      sbx = await create(cfg.daytona?.snapshot);
    }
    return {
      sandboxId: sbx.id,
      driver: daytonaDriver(sbx),
      restoredFromTemplate,
    };
  },

  async publishTemplate(sandboxId, repo, _label, options) {
    const client = await daytonaClient();
    const name = remoteRepoTemplateName("daytona", repo.id);
    const sbx = await client.get(sandboxId);
    await sealRemoteRepoTemplate(daytonaDriver(sbx), "daytona", repo);
    const recovered = options?.replace
      ? null
      : await recoverDaytonaRepoTemplate(client, repo.id);
    if (recovered) return;
    const existing = await getDaytonaSnapshot(client, name);
    if (existing) {
      await client.snapshot.delete(existing);
      await waitForDaytonaSnapshotGone(client, name);
    }
    // Full repository templates are materially larger than Daytona's base
    // images; the live Open Session template takes about six minutes to seal.
    await sbx._experimental_createSnapshot(name, 900);
    const { previous } = writeRemoteRepoTemplate("daytona", repo.id, name);
    if (previous?.artifactId && previous.artifactId !== name) {
      try {
        const stale = await client.snapshot.get(previous.artifactId);
        await client.snapshot.delete(stale);
      } catch {}
    }
    console.log(`[sandbox:daytona] published post-setup repo template ${name}`);
  },

  async park(sandboxId) {
    const client = await daytonaClient();
    const sbx = await client.get(sandboxId);
    if (sbx && stateOf(sbx) === "running") await sbx.stop();
  },

  async destroy(sandboxId) {
    try {
      const client = await daytonaClient();
      const sbx = await client.get(sandboxId);
      if (sbx) await client.delete(sbx, 120);
    } catch (e) {
      console.warn(`[sandbox:daytona] prewarm destroy(${sandboxId}):`, e);
    }
  },

  async keepAlive(sandboxId, opts) {
    const client = await daytonaClient();
    const sbx = await client.get(sandboxId);
    await sbx.setAutostopInterval(opts.autoStopMinutes);
    await sbx.setAutoDeleteInterval(opts.autoDeleteMinutes);
  },

  async listPrewarmed() {
    const client = await daytonaClient();
    const out: Array<{ id: string; key: string }> = [];
    for await (const s of client.list({
      labels: { [PREWARM_LABEL]: "1" },
    } as any)) {
      // Mid-teardown sandboxes still list with their labels for a few
      // seconds — same guard as the conformance leftovers audit.
      const state = String((s as any).state || "");
      if (/destroy|delet/i.test(state)) continue;
      out.push({
        id: (s as any).id,
        key: String((s as any).labels?.[PREWARM_KEY_LABEL] || ""),
      });
    }
    return out;
  },
};

/** Bounded account + native snapshot qualification used by Settings. Every
 * resource has provider-side auto-delete and is also cleaned in finally. */
export async function qualifyDaytonaConnection(): Promise<void> {
  const cfg = daytonaConfig();
  const client = await daytonaClient();
  const suffix = crypto.randomUUID().slice(0, 12);
  const snapshotName = `opensession-qualification-${suffix}`;
  let source: DaytonaSandbox | undefined;
  let restored: DaytonaSandbox | undefined;
  try {
    const resources = daytonaCreateResources(cfg);
    source = await client.create(
      {
        ...daytonaCreateSource(cfg.daytona?.snapshot, resources),
        labels: { "opensession.qualification": suffix },
        autoStopInterval: 10,
        autoDeleteInterval: 30,
      } as any,
      { timeout: 300 },
    );
    const sourceDriver = daytonaDriver(source);
    const probe = await sourceDriver.exec(
      "set -eu; uname -s; printf opensession-qualified > /tmp/opensession-qualification",
      { timeoutMs: 60_000 },
    );
    if (probe.exitCode !== 0)
      throw new Error("Daytona qualification command failed");
    const semantics = await sourceDriver.exec(
      "printf qualification-out; printf qualification-err >&2; exit 7",
      { timeoutMs: 60_000 },
    );
    if (
      semantics.exitCode !== 7 ||
      !semantics.stdout.includes("qualification-out") ||
      !semantics.stderr.includes("qualification-err")
    ) {
      throw new Error(
        "Daytona exec stream or exit-code semantics are incompatible",
      );
    }
    await sourceDriver.writeFile("/tmp/opensession-upload", "uploaded");
    const upload = await sourceDriver.exec(
      'test "$(cat /tmp/opensession-upload)" = uploaded',
    );
    if (upload.exitCode !== 0)
      throw new Error("Daytona file upload check failed");
    const preview = await source.getPreviewLink(8765);
    if (!preview?.url)
      throw new Error("Daytona encrypted preview link check failed");
    await source.stop(120);
    await source.start(120);
    const lifecycle = await sourceDriver.exec(
      'test "$(cat /tmp/opensession-qualification)" = opensession-qualified',
    );
    if (lifecycle.exitCode !== 0)
      throw new Error("Daytona stop/start lost filesystem state");
    await source.updateNetworkSettings({ domainAllowList: "example.com" });
    const egress = await sourceDriver.exec(
      "a=$(curl -sS -o /dev/null -m 10 -w '%{http_code}' https://example.com/ 2>/dev/null || true); " +
        "b=$(curl -sS -o /dev/null -m 10 -w '%{http_code}' https://www.iana.org/ 2>/dev/null || true); " +
        'echo "allowed=$a blocked=$b"',
      { timeoutMs: 40_000 },
    );
    if (!/allowed=(?!000)\d{3} blocked=000/.test(egress.stdout)) {
      throw new Error(
        "Daytona runner did not enforce the sandbox domain allowlist",
      );
    }
    await source.updateNetworkSettings({ networkBlockAll: false });
    // Even a nearly-empty Daytona sandbox can take 8–10 minutes to seal when
    // the provider is busy. Keep this aligned with repository templates: a
    // shorter client wait reports a false SNAPSHOT_FAILED while Daytona keeps
    // snapshotting successfully in the background.
    await source._experimental_createSnapshot(snapshotName, 900);
    restored = await client.create(
      {
        snapshot: snapshotName,
        labels: { "opensession.qualification": `${suffix}-restore` },
        autoStopInterval: 10,
        autoDeleteInterval: 30,
      } as any,
      { timeout: 300 },
    );
    if (restored.id === source.id)
      throw new Error("Daytona snapshot restore was not distinct");
    const restoreProbe = await daytonaDriver(restored).exec(
      'test "$(cat /tmp/opensession-qualification)" = opensession-qualified',
      { timeoutMs: 60_000 },
    );
    if (restoreProbe.exitCode !== 0) {
      throw new Error(
        "Daytona qualification snapshot did not restore filesystem state",
      );
    }
  } finally {
    for (const sandbox of [restored, source]) {
      if (!sandbox) continue;
      await client.delete(sandbox, 120).catch(() => {});
    }
    try {
      const snapshot = await client.snapshot.get(snapshotName);
      await client.snapshot.delete(snapshot);
    } catch {}
  }
  // Daytona's delete call can return before the list index reflects teardown.
  // Give that eventually-consistent view a short bounded window to converge.
  for (let attempt = 0; attempt < 15; attempt++) {
    let liveSandbox = false;
    for await (const sandbox of client.list({
      labels: { "opensession.qualification": suffix },
    } as any)) {
      if (!/destroy|delet/i.test(String((sandbox as any).state || ""))) {
        liveSandbox = true;
      }
    }
    if (!liveSandbox) return;
    if (attempt < 14) await Bun.sleep(2_000);
  }
  throw new Error("Daytona qualification cleanup left a sandbox behind");
}

export async function deleteDaytonaTemplateArtifact(
  artifactId: string,
): Promise<void> {
  const client = await daytonaClient();
  try {
    const snapshot = await client.snapshot.get(artifactId);
    await client.snapshot.delete(snapshot);
  } catch {}
}
