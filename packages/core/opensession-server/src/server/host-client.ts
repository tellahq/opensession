/**
 * host-client — Open Session's side of detached run hosts
 * (packages/core/opensession-server/src/runner-host/host.ts).
 *
 * Why: the SDK run driver used to live inside the opensession process, so ANY
 * real restart (route changes, runner changes, deploys) killed every in-flight
 * run mid-turn. A run host is a separate bun process in its own transient
 * systemd unit — outside the opensession.service cgroup — so opensession can
 * restart freely while runs keep streaming; on boot we reattach to the live
 * hosts' sockets and pick up exactly where we left off.
 *
 * This module:
 *  - delegates host launch to the executor service, with a rollout fallback to
 *    the fixed systemd-run launcher when no executor accepted the request,
 *  - adapts a host's socket into the same AsyncGenerator<StreamEvent> shape as
 *    runAgent, so call sites don't care where the run lives,
 *  - proxies asks (AskUserQuestion / Stripe confirms) to the caller's handler,
 *  - registers steer/interrupt/cancel controls in host-registry so the normal
 *    steerAgentRun/cancelAgentRun/isAgentSessionBusy paths treat hosted runs
 *    like in-process ones,
 *  - reconnects on socket drops and transparently respawns a crashed host to
 *    resume its engine session.
 *
 * Kill switch: `touch ~/.opensession-sessions/disable-run-hosts` — checked per
 * run. On a systemd host it fails new runs closed instead of moving agent work
 * into the gateway control-plane cgroup; old hosts finish normally.
 */

import type { McpScope } from "./runner-shared";
import { audit } from "./audit";
import { waitForRunHostAdmission } from "./host-admission";
import {
  isRetryableSessionCommandError,
  sessionKernel,
} from "./session-kernel";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import {
  runAgent,
  recoveryKind,
  resumeContinuationPrompt,
  type RunAgentOpts,
  type StreamEvent,
} from "./agent-runner";
import {
  journalClear,
  journalRecordAbnormalCompletion,
  journalSet,
  registerActiveRunProbe,
  type ActiveRunRecord,
} from "./run-journal";
import { shouldPersistModelSwitch, type ImageInput } from "./run-events";
import type { TranscriptEntry } from "./types";
import {
  appendTranscriptEntries,
  applyForwardedTranscriptStrict,
} from "./transcript-persistence";
import { sameProcess } from "./process-identity";
import type { GitIdentity } from "./shared/user-mappings";
import { modelSupportsSteer, providerFor } from "./models";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import {
  registerHostRun,
  addHostRunKey,
  unregisterHostRun,
  hostRunBusy,
  hostRunCount,
  type HostRunControl,
} from "./host-registry";
import { registerRunToken, unregisterRunToken } from "./run-rpc";
import {
  ndjsonReader,
  runHostsDir,
  rpcSocketPath,
  HOST_SOCK_NAME,
  HOST_SPEC_NAME,
  HOST_META_NAME,
  HOST_JOURNAL_NAME,
  type RunHostSpec,
  type RunHostMeta,
  type HostToClientMsg,
  type ClientToHostMsg,
} from "../runner-host/protocol";
import {
  ExecutorProtocolError,
  launchHostViaExecutor,
  noteExecutorFallback,
  waitForLocalHost,
} from "./executor-client";
import {
  hostUnitActive,
  launchHostUnitDirect,
  stopHostUnitDirect,
} from "../executor/host-unit";

const HOSTED_KERNEL_RETRY_ATTEMPTS = 3;
// The actor client's sync breaker stays open for ten seconds after a timeout.
// Wait just beyond it so a retry reaches the recovered lane instead of failing
// immediately against the same open breaker.
const HOSTED_KERNEL_RETRY_DELAY_MS = 10_100;
// Hosts from before the catchup_complete frame resend transcript history
// immediately after an ended hello. Keep that rolling-deploy path open long
// enough to consume the local replay instead of closing on the hello itself.
const ENDED_HELLO_CATCHUP_FALLBACK_MS = 2_000;

export async function retryHostedKernelCall<T>(
  call: () => T | Promise<T>,
  options: {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (error: unknown, attempt: number) => void;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? HOSTED_KERNEL_RETRY_ATTEMPTS;
  const delayMs = options.delayMs ?? HOSTED_KERNEL_RETRY_DELAY_MS;
  const sleep = options.sleep ?? Bun.sleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= attempts || !isRetryableSessionCommandError(error)) {
        throw error;
      }
      options.onRetry?.(error, attempt);
      await sleep(delayMs);
    }
  }
}

function hostedKernelCall<T>(
  spec: RunHostSpec,
  operation: string,
  call: () => T | Promise<T>,
): Promise<T> {
  return retryHostedKernelCall(call, {
    onRetry: (error, attempt) =>
      audit({
        msg: "hosted_kernel_call_retry",
        session_id: spec.osSessionId,
        run_key: spec.hostId,
        operation,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      }),
  });
}

const HOSTS_DIR = runHostsDir(OPENSESSION_SESSIONS_DIR);
const DISABLE_FILE = `${OPENSESSION_SESSIONS_DIR}/disable-run-hosts`;

// A fresh host can be journaled while the boot recovery sweep is still
// starting. Reserve its key before launch so takeInterruptedRuns does not
// attach a second HostHandle to a run this process already drives. HostHandle
// registration takes over once launch completes.
const activeHostedRunKeys: Set<string> = ((
  globalThis as any
).__activeHostedRunKeys ??= new Set());
const pendingRunHostAdmissions: Set<symbol> = ((
  globalThis as any
).__pendingRunHostAdmissions ??= new Set());
registerActiveRunProbe(
  (runKey) => activeHostedRunKeys.has(runKey) || hostRunBusy(runKey),
);

function activeRunHostCount(): number {
  // HostHandle registration includes spawned and reattached runs. Add only keys
  // still in the pre-handle launch window, avoiding double-counting the rest.
  const launchesWithoutHandle = [...activeHostedRunKeys].filter(
    (runKey) => !hostRunBusy(runKey),
  ).length;
  return hostRunCount() + launchesWithoutHandle;
}

export function localRunHostsSupported(
  platform = process.platform,
  systemdBooted = existsSync("/run/systemd/system"),
  commandLookup: (command: string) => string | null = Bun.which,
): boolean {
  // Hermetic end-to-end fixtures have scratch state but no matching privileged
  // run-host installation. They exercise the same runner in-process instead of
  // reaching the live VPS executor or fixed helper.
  if (process.env.OPENSESSION_TEST_IN_PROCESS_RUNS === "1") return false;
  return (
    platform === "linux" &&
    systemdBooted &&
    !!commandLookup("systemctl") &&
    !!commandLookup("sudo")
  );
}

function runHostsEnabled(): boolean {
  return localRunHostsSupported() && !existsSync(DISABLE_FILE);
}

/** Options for a hosted run: RunAgentOpts minus the non-serializable bits,
 *  plus the host/session context. */
export interface HostedRunOpts {
  osSessionId: string;
  prompt: string;
  /** Transcript uuid of the server's already-written user line (see
   *  RunHostSpec.promptEntryId). */
  promptEntryId?: string;
  /** Immutable dispatch identity shared with pending-start cancellation. */
  startToken?: string;
  seedTranscriptEntries?: TranscriptEntry[];
  /** Engine session id to resume (claude session id / codex thread id). */
  sessionId?: string;
  cwd: string;
  mode?: "ask" | "code" | "scratch";
  mcpGrantUser?: string;
  model?: string;
  images?: ImageInput[];
  forkSession?: boolean;
  resumeSessionAt?: string;
  mcpServers?: McpScope;
  /** opensession-* servers to expose through the RPC proxy. Names must
   *  resolve through the run-rpc builder: the interactive set, or the
   *  fail-closed automation-bar set for automation-owned sessions. */
  proxyMcpServers?: string[];
  reposNote?: string;
  deniedTools?: Record<string, string>;
  publicationPolicy?: { repo: string; branch: string; headBranch: string };
  confirmTools?: Record<string, string>;
  aws?: boolean;
  /** Pool credentials for trusted run-spawned CLI tools (deepsec scans). */
  claudeCliEnv?: boolean;
  codexCliEnv?: boolean;
  author?: GitIdentity | null;
  user?: string;
  fallbackModel?: string;
  /** Stable provider-account affinity for internal fan-out workers. */
  accountAffinityKey?: string;
  /** Reasoning effort / service tier / account pinning for the run (see the
   *  matching RunHostSpec fields). */
  effort?: string;
  fastMode?: boolean;
  accountId?: string;
  accountStrict?: boolean;
  usageCredits?: boolean;
  /** Reviewer(s) for PRs the run opens (an automation session's policy). */
  prReviewer?: string;
  /** Trust boundary stamped on the spec + journal record: "automation" for
   *  automation-owned sessions, defaults to interactive. */
  trustProfile?: "interactive" | "automation";
  journalKind?: string;
  firstJournaledAt?: string;
  resumeAttempts?: number;
  lastResumeAt?: string;
  onAskUser?: RunAgentOpts["onAskUser"];
  /** Reports the engine id even when its live init frame preceded attachment. */
  onEngineSession?: (engineSessionId: string) => void;
  /** Fences cancellation admitted while the detached host is still launching. */
  shouldCancel?: () => boolean;
  /** A steer arrived too late at the host — queue it so it isn't dropped. */
  onSteerFailed?: (text: string) => void;
  /** Builds SDK MCP servers only on platforms without detached run hosts. */
  fallbackInProcessMcp?: () => Record<string, unknown> | undefined;
}

/**
 * Run a prompt in a detached run host, yielding the same StreamEvents as
 * runAgent. A Linux host never falls back into the gateway: launch failure is
 * visible and retryable, while non-systemd platforms retain in-process mode.
 */
export async function* runAgentHosted(
  opts: HostedRunOpts,
): AsyncGenerator<StreamEvent> {
  if (opts.shouldCancel?.()) return;
  if (!runHostsEnabled()) {
    if (localRunHostsSupported()) {
      throw new Error(
        "Detached run hosts are disabled; refusing to run agent work inside the gateway",
      );
    }
    yield* runAgentInProcess(opts);
    return;
  }

  // Machine-capacity admission before the engine process exists. Waits with
  // backoff while the host is full and fails closed after the configured
  // patience. In-process execution would consume the control plane's reserve.
  const admission = Symbol(opts.osSessionId);
  if (
    (await waitForRunHostAdmission({
      sessionId: opts.osSessionId,
      activeHosts: activeRunHostCount,
      pendingHosts: () => pendingRunHostAdmissions.size,
      onAdmit: () => pendingRunHostAdmissions.add(admission),
      shouldCancel: opts.shouldCancel,
    })) === "cancelled"
  )
    return;
  if (opts.shouldCancel?.()) {
    pendingRunHostAdmissions.delete(admission);
    return;
  }

  let spawned: { handle: HostHandle; spec: RunHostSpec };
  try {
    // spawnHostRun reserves activeHostedRunKeys synchronously before its first
    // await. Transfer the admission reservation without opening a race.
    const launch = spawnHostRun(opts);
    pendingRunHostAdmissions.delete(admission);
    spawned = await launch;
  } catch (error) {
    pendingRunHostAdmissions.delete(admission);
    throw error;
  }

  try {
    if (opts.shouldCancel?.()) {
      spawned.handle.requestCancel();
      // Drain through the host's `end`, not merely its terminal event: the
      // source owns cleanup and may still be waiting to close its transport.
      for await (const _event of spawned.handle.events()) {
      }
      return;
    }
    yield* hostedEventsWithJournal(spawned.handle, spawned.spec);
  } finally {
    activeHostedRunKeys.delete(spawned.spec.hostId);
  }
}

export interface AuxiliaryHostedRunOpts extends HostedRunOpts {
  /** Auxiliary workers keep either their standalone engine transcript or, for
   *  session-like background jobs, project onto the parent session. */
  transcriptTarget?: "session" | "engine" | "none";
  signal?: AbortSignal;
}

/**
 * Run internal fan-out work in the same workload-isolated transient units as
 * ordinary turns, without claiming the parent session's authoritative run
 * slot. Linux hosts fail closed if detached execution is deliberately disabled
 * or cannot launch; absorbing workers into the gateway would defeat the
 * control-plane cgroup boundary this API exists to preserve.
 */
export async function* runAuxiliaryAgentHosted(
  opts: AuxiliaryHostedRunOpts,
): AsyncGenerator<StreamEvent> {
  const shouldCancel = () =>
    Boolean(opts.signal?.aborted || opts.shouldCancel?.());
  if (!runHostsEnabled()) {
    if (localRunHostsSupported()) {
      throw new Error(
        "Detached run hosts are disabled; refusing to run auxiliary agent work inside the gateway",
      );
    }
    yield* runAgentInProcess({ ...opts, shouldCancel }, "auxiliary");
    return;
  }
  if (shouldCancel()) return;

  const admission = Symbol(opts.osSessionId);
  if (
    (await waitForRunHostAdmission({
      sessionId: opts.osSessionId,
      activeHosts: activeRunHostCount,
      pendingHosts: () => pendingRunHostAdmissions.size,
      onAdmit: () => pendingRunHostAdmissions.add(admission),
      shouldCancel,
    })) === "cancelled"
  )
    return;
  if (shouldCancel()) {
    pendingRunHostAdmissions.delete(admission);
    return;
  }

  let spawned: { handle: HostHandle; spec: RunHostSpec };
  try {
    const launch = spawnHostRun(
      { ...opts, shouldCancel },
      "auxiliary",
      opts.transcriptTarget ?? "none",
    );
    pendingRunHostAdmissions.delete(admission);
    spawned = await launch;
  } catch (error) {
    pendingRunHostAdmissions.delete(admission);
    throw error;
  }

  const cancel = () => spawned.handle.requestCancel();
  opts.signal?.addEventListener("abort", cancel, { once: true });
  let completed = false;
  try {
    if (shouldCancel()) cancel();
    for await (const event of spawned.handle.events()) yield event;
    completed = true;
  } finally {
    opts.signal?.removeEventListener("abort", cancel);
    if (!completed && !spawned.handle.ended) cancel();
  }
}

/** The in-process execution tail for platforms without local run-host support. */
async function* runAgentInProcess(
  opts: HostedRunOpts,
  lifecycle: "session" | "auxiliary" = "session",
): AsyncGenerator<StreamEvent> {
  yield* runAgent({
    prompt: opts.prompt,
    promptEntryId: opts.promptEntryId,
    startToken: opts.startToken,
    seedTranscriptEntries: opts.seedTranscriptEntries,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    mode: opts.mode,
    mcpGrantUser: opts.mcpGrantUser,
    model: opts.model,
    images: opts.images,
    forkSession: opts.forkSession,
    resumeSessionAt: opts.resumeSessionAt,
    mcpServers: opts.mcpServers ?? "all",
    inProcessMcp: opts.fallbackInProcessMcp?.(),
    reposNote: opts.reposNote,
    deniedTools: opts.deniedTools,
    publicationPolicy: opts.publicationPolicy,
    confirmTools: opts.confirmTools,
    aws: opts.aws,
    claudeCliEnv: opts.claudeCliEnv,
    codexCliEnv: opts.codexCliEnv,
    author: opts.author,
    user: opts.user,
    fallbackModel: opts.fallbackModel,
    accountAffinityKey: opts.accountAffinityKey,
    effort: opts.effort,
    fastMode: opts.fastMode,
    accountId: opts.accountId,
    accountStrict: opts.accountStrict,
    usageCredits: opts.usageCredits,
    prReviewer: opts.prReviewer,
    journal: {
      ...(lifecycle === "auxiliary" ? {} : { osSessionId: opts.osSessionId }),
      kind: opts.journalKind || "prompt",
      firstJournaledAt: opts.firstJournaledAt,
      resumeAttempts: opts.resumeAttempts,
      lastResumeAt: opts.lastResumeAt,
    },
    onAskUser: opts.onAskUser,
    shouldCancel: opts.shouldCancel,
  });
}

/**
 * Server-side journal record for a hosted run, mirroring the sandbox
 * launchers' recordForSpec: the host journals its own run into its PRIVATE
 * per-host file (OPENSESSION_RUN_JOURNAL), so the SHARED journal needs this
 * record for the boot sweep to find the run after a restart. `hostId` marks
 * it as a local detached host (resumeLocalHostRun); cleared only when the
 * host itself ended (terminal or quiet cancel). A consumer teardown mid-run
 * (server restart) keeps the record. That is the reattach affordance.
 */
async function* hostedEventsWithJournal(
  handle: HostHandle,
  spec: RunHostSpec,
): AsyncGenerator<StreamEvent> {
  const record = hostedRunRecord(spec);
  const owner = await hostedKernelCall(spec, "initial_owner_read", () =>
    sessionKernel(spec.osSessionId).runStateProjection(),
  );
  if (
    owner.currentRunId &&
    owner.currentRunId !== record.runKey &&
    ["running", "ask_blocked", "interrupted", "reattaching"].includes(
      owner.state,
    )
  ) {
    handle.requestCancel();
    audit({
      msg: "stale_host_registration_rejected",
      session_id: spec.osSessionId,
      current_run_id: owner.currentRunId,
      rejected_run_id: record.runKey,
    });
    return;
  }
  handle.setHostChangeHandler(async (hostId) => {
    record.hostId = hostId;
    await hostedKernelCall(spec, "host_change_journal", () =>
      journalSet(record),
    );
  });
  await hostedKernelCall(spec, "initial_journal", () => journalSet(record));
  let sourceCompleted = false;
  let sawTerminal = false;
  try {
    for await (const ev of handle.events()) {
      const isCurrent = await hostedKernelCall(spec, "event_owner_read", () =>
        sessionKernel(spec.osSessionId).isCurrentRunProjection(record.runKey),
      );
      if (!isCurrent) {
        handle.requestCancel();
        audit({
          msg: "stale_executor_event_rejected",
          session_id: spec.osSessionId,
          run_key: record.runKey,
          event_type: ev.type,
        });
        continue;
      }
      if (
        ev.type === "init" &&
        ev.sessionId &&
        ev.sessionId !== record.claudeSessionId
      ) {
        record.claudeSessionId = ev.sessionId;
        await hostedKernelCall(spec, "engine_session_journal", () =>
          journalSet(record),
        );
      }
      if (ev.type === "model_switch" && ev.toModel) {
        record.model = ev.toModel;
        record.transientFallback = ev.temporaryFallback === true;
        if (shouldPersistModelSwitch(ev)) record.selectedModel = ev.toModel;
        await hostedKernelCall(spec, "model_switch_journal", () =>
          journalSet(record),
        );
      }
      if (ev.type === "done" || ev.type === "error") sawTerminal = true;
      yield ev;
    }
    sourceCompleted = true;
  } finally {
    if (handle.ended && sourceCompleted && sawTerminal)
      journalClear(record.runKey);
    else if (handle.ended && sourceCompleted)
      await hostedKernelCall(spec, "abnormal_completion_journal", () =>
        journalRecordAbnormalCompletion(record),
      );
  }
}

function hostedRunRecord(spec: RunHostSpec): ActiveRunRecord {
  return {
    runKey: spec.hostId,
    hostId: spec.hostId,
    osSessionId: spec.osSessionId,
    claudeSessionId: spec.engineSessionId,
    prompt: spec.prompt,
    promptEntryId: spec.promptEntryId,
    cwd: spec.cwd,
    mode: spec.mode,
    mcpServers: spec.mcpServers,
    user: spec.user,
    deniedTools: spec.deniedTools,
    publicationPolicy: spec.publicationPolicy,
    confirmTools: spec.confirmTools,
    aws: spec.aws,
    claudeCliEnv: spec.claudeCliEnv,
    codexCliEnv: spec.codexCliEnv,
    model: spec.model,
    selectedModel: spec.selectedModel ?? spec.model,
    transientFallback: spec.transientFallback,
    effort: spec.effort,
    fastMode: spec.fastMode,
    accountId: spec.accountId,
    accountStrict: spec.accountStrict,
    usageCredits: spec.usageCredits,
    prReviewer: spec.prReviewer,
    trustProfile: spec.trustProfile,
    fallbackModel: spec.fallbackModel,
    kind: spec.journalKind || "prompt",
    firstJournaledAt: spec.firstJournaledAt,
    resumeAttempts: spec.resumeAttempts,
    lastResumeAt: spec.lastResumeAt,
    startedAt: spec.firstJournaledAt || new Date().toISOString(),
  };
}

// ── Spawning ──────────────────────────────────────────────────────────────────

async function spawnHostRun(
  opts: HostedRunOpts,
  lifecycle: "session" | "auxiliary" = "session",
  transcriptTarget: "session" | "engine" | "none" = "session",
): Promise<{ handle: HostHandle; spec: RunHostSpec }> {
  const hostId = opts.startToken || `rh-${Bun.randomUUIDv7()}`;
  const dir = `${HOSTS_DIR}/${hostId}`;
  mkdirSync(dir, { recursive: true });

  const rpcToken = opts.proxyMcpServers?.length
    ? crypto.randomUUID()
    : undefined;
  const spec: RunHostSpec = {
    hostId,
    osSessionId: opts.osSessionId,
    ...(lifecycle === "auxiliary" ? { lifecycle, transcriptTarget } : {}),
    prompt: opts.prompt,
    promptEntryId: opts.promptEntryId,
    seedTranscriptEntries: opts.seedTranscriptEntries,
    engineSessionId: opts.sessionId,
    cwd: opts.cwd,
    mode: opts.mode,
    mcpGrantUser: opts.mcpGrantUser,
    model: opts.model,
    images: opts.images,
    forkSession: opts.forkSession,
    resumeSessionAt: opts.resumeSessionAt,
    mcpServers: opts.mcpServers ?? "all",
    proxyMcpServers: opts.proxyMcpServers,
    rpcToken,
    reposNote: opts.reposNote,
    deniedTools: opts.deniedTools,
    publicationPolicy: opts.publicationPolicy,
    confirmTools: opts.confirmTools,
    aws: opts.aws,
    claudeCliEnv: opts.claudeCliEnv,
    codexCliEnv: opts.codexCliEnv,
    author: opts.author,
    user: opts.user,
    fallbackModel: opts.fallbackModel,
    accountAffinityKey: opts.accountAffinityKey,
    effort: opts.effort,
    fastMode: opts.fastMode,
    accountId: opts.accountId,
    accountStrict: opts.accountStrict,
    usageCredits: opts.usageCredits,
    prReviewer: opts.prReviewer,
    trustProfile: opts.trustProfile,
    journalKind: opts.journalKind,
    firstJournaledAt: opts.firstJournaledAt || new Date().toISOString(),
    resumeAttempts: opts.resumeAttempts,
    lastResumeAt: opts.lastResumeAt,
  };
  writeJsonAtomic(`${dir}/${HOST_SPEC_NAME}`, spec);
  if (rpcToken)
    registerRunToken(rpcToken, {
      sessionId: opts.osSessionId,
      user: opts.user,
    });

  let handle: HostHandle | undefined;
  let launchCompleted = false;
  // Session-owned hosts enter the shared recovery journal. Auxiliary workers
  // are owned by their caller's workflow journal instead: registering them as
  // the parent session's physical run would race its real run generation.
  if (lifecycle === "session") activeHostedRunKeys.add(hostId);
  try {
    if (lifecycle === "session") {
      // Persist before launch. If opensession restarts between systemd-run and
      // socket attachment, the boot sweep can still find the surviving host.
      await journalSet(hostedRunRecord(spec));
    }
    try {
      await launchHostUnit(hostId, dir);
    } catch (error) {
      if (!(error instanceof ExecutorProtocolError && error.ambiguousLaunch)) {
        throw error;
      }
      handle = new HostHandle(dir, spec, {
        onAskUser: opts.onAskUser,
        onEngineSession: opts.onEngineSession,
        onSteerFailed: opts.onSteerFailed,
      });
      try {
        await handle.connectWithWait(120_000);
        return { handle, spec };
      } catch {
        throw error;
      }
    }
    launchCompleted = true;
    handle = new HostHandle(dir, spec, {
      onAskUser: opts.onAskUser,
      onEngineSession: opts.onEngineSession,
      onSteerFailed: opts.onSteerFailed,
    });
    await handle.connectWithWait(20_000);
    return { handle, spec };
  } catch (cause) {
    let error = cause;
    if (launchCompleted) {
      try {
        await stopAndVerifyHostAbsent(hostId, dir);
      } catch (cleanupError) {
        error = cleanupError;
      }
    }
    if (!(error instanceof ExecutorProtocolError && error.ambiguousLaunch)) {
      if (lifecycle === "session") activeHostedRunKeys.delete(hostId);
      // The HostHandle ctor registered its host-registry control. Drop it only
      // after absence is proven; uncertain launches must remain visibly busy.
      handle?.abandon();
      if (lifecycle === "session") journalClear(spec.hostId);
      unregisterRunToken(rpcToken);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    throw error;
  }
}

/**
 * Launch the host as a transient SYSTEM unit (via passwordless sudo — the
 * aws-creds precedent). A user-manager unit won't do: it dies with the user
 * session unless linger is on, and — verified — user units silently ignore
 * IPAddressDeny, which would hand agent children the IMDS endpoint that
 * opensession.service deliberately denies.
 */
async function launchHostUnit(hostId: string, dir: string): Promise<void> {
  const specHash = new Bun.CryptoHasher("sha256")
    .update(readFileSync(`${dir}/${HOST_SPEC_NAME}`))
    .digest("hex");
  if (await launchHostViaExecutor(hostId, dir, { specHash })) return;
  noteExecutorFallback();
  try {
    await launchHostUnitDirect(hostId, dir, specHash);
  } catch (cause) {
    await stopAndVerifyHostAbsent(hostId, dir);
    throw cause;
  }
}

async function stopAndVerifyHostAbsent(
  hostId: string,
  dir: string,
): Promise<void> {
  try {
    await stopHostUnitDirect(hostId);
  } catch {}
  const deadline = Date.now() + 10_000;
  do {
    try {
      const meta = readJsonSafe<RunHostMeta>(`${dir}/${HOST_META_NAME}`);
      let processAlive = false;
      if (meta?.pid) {
        const matches = sameProcess(meta);
        if (matches !== undefined) processAlive = matches;
        else {
          try {
            process.kill(meta.pid, 0);
            processAlive = true;
          } catch {}
        }
      }
      if (
        !(await hostUnitActive(hostId)) &&
        !(await waitForLocalHost(dir, 100)) &&
        !processAlive
      ) {
        return;
      }
    } catch {}
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  throw new ExecutorProtocolError(
    `could not prove run host ${hostId} stopped`,
    true,
  );
}

// ── The handle: socket client + StreamEvent generator ─────────────────────────

/**
 * How a HostHandle's host process is launched/checked — the only part of the
 * handle that differs between backends. The default (systemd transient units)
 * is this module's launchHostUnit; the Docker sandbox provider in
 * `server/sandbox/docker.ts` supplies a `docker exec` launcher and reuses
 * everything else: NDJSON protocol, ask proxying, reconnect, respawn-to-resume,
 * host-registry steer/cancel registration.
 */
export class HostLaunchNotDispatchedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostLaunchNotDispatchedError";
  }
}

export interface HostExecutionEvidence {
  started: boolean;
  engineSessionId?: string;
  done?: StreamEvent;
}

export interface HostLauncher {
  /** Is the host process still alive? (`dir` is the host's run dir, `meta` its
   *  meta.json if readable.) Used to decide reconnect vs respawn. */
  alive(dir: string, meta: RunHostMeta | null): boolean | Promise<boolean>;
  /** Run dir for a respawned host id (spec.json is written there before launch). */
  newRunDir(hostId: string): string;
  /** Launch the host entry for the spec already written at `<dir>/spec.json`. */
  launch(
    hostId: string,
    dir: string,
    onDispatching?: () => void,
  ): Promise<void>;
  /** Stop a disconnected host and prove it absent before ownership is cleared. */
  stop?(hostId: string, dir: string): Promise<void>;
  /** Inspect durable host evidence before destructive reconciliation. */
  evidence?(
    dir: string,
  ): Promise<HostExecutionEvidence> | HostExecutionEvidence;
  /**
   * Transport override: how the handle reaches the launched host. Default
   * (undefined return) = the unix socket at `<dir>/host.sock`. The WS
   * transport (`server/run-ws.ts`) returns a connector that waits for the
   * host's dial-back instead — sandboxes that can't share a unix socket.
   * Called per host id (again after a respawn, with the new spec).
   */
  connector?(dir: string, spec: RunHostSpec): HostConnector | undefined;
  /**
   * Write `spec.json` for a respawned host. Default = host-side
   * mkdir + writeJsonAtomic into `dir`; remote sandbox launchers override it
   * to place the spec INSIDE the sandbox (no host filesystem involved).
   */
  writeSpec?(dir: string, spec: RunHostSpec): Promise<void>;
}

// ── Transport seam: socket and WS are two impls of one small interface ───────
// HostHandle used to own a Bun.connect unix socket directly; everything above
// the wire (reconnect policy, respawn, ask proxying, registry bookkeeping)
// was already transport-agnostic. The seam extracts exactly the wire bits:
// one connection attempt, message-in callback, closed callback, message-out.

export interface HostConnectionHandlers {
  onMsg(msg: HostToClientMsg): void;
  /** The connection dropped (any reason). Fired at most once per connection. */
  onClose(): void;
}

export interface HostConnection {
  /** Send one protocol message; false = not deliverable right now. */
  send(msg: ClientToHostMsg): boolean;
  close(): void;
}

export interface HostConnector {
  /** One connection attempt; rejects when the host isn't reachable yet
   *  (caller retries — connectWithWait / the reconnect loop own the cadence). */
  connect(handlers: HostConnectionHandlers): Promise<HostConnection>;
  /** Release connector-owned resources (WS tokens/registrations) at run end. */
  dispose?(): void;
}

/** The default transport: opensession dials the host's unix socket. Behavior is
 *  identical to the pre-seam inline code — the existsSync guard preserves the
 *  old "poll for the socket file" cadence, and open/close/error map 1:1. */
function unixSocketConnector(sockPath: string): HostConnector {
  return {
    connect(handlers: HostConnectionHandlers): Promise<HostConnection> {
      if (!existsSync(sockPath)) {
        return Promise.reject(new Error(`socket ${sockPath} not present yet`));
      }
      return new Promise((resolve, reject) => {
        let settled = false;
        const read = ndjsonReader((m) => handlers.onMsg(m), "host-client");
        Bun.connect({
          unix: sockPath,
          socket: {
            open: (s: any) => {
              if (!settled) {
                settled = true;
                resolve({
                  send: (msg) => {
                    try {
                      s.write(JSON.stringify(msg) + "\n");
                      return true;
                    } catch {
                      return false;
                    }
                  },
                  close: () => {
                    try {
                      s.end();
                    } catch {}
                  },
                });
              }
            },
            data: (_s: any, d: Buffer) => read(d),
            close: () => handlers.onClose(),
            error: (_s: any, e: unknown) => {
              console.warn(`[host-client] socket error (${sockPath}):`, e);
            },
            connectError: (_s: any, e: unknown) => {
              if (!settled) {
                settled = true;
                reject(e);
              }
            },
          },
        }).catch((e) => {
          if (!settled) {
            settled = true;
            reject(e);
          }
        });
      });
    },
  };
}

/** Default launcher: transient systemd units on this host. */
const systemdHostLauncher: HostLauncher = {
  alive(dir) {
    const meta = readJsonSafe<RunHostMeta>(`${dir}/${HOST_META_NAME}`);
    if (!meta?.pid) return false;
    const matches = sameProcess(meta);
    if (matches !== undefined) return matches;
    try {
      process.kill(meta.pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  newRunDir: (hostId) => `${HOSTS_DIR}/${hostId}`,
  launch: launchHostUnit,
  stop: stopAndVerifyHostAbsent,
  evidence(dir) {
    const meta = readJsonSafe<RunHostMeta>(`${dir}/${HOST_META_NAME}`);
    const privateRun = readHostJournal(dir);
    return {
      started: !!meta?.pid || !!privateRun,
      ...(meta?.engineSessionId
        ? { engineSessionId: meta.engineSessionId }
        : {}),
      ...(meta?.done ? { done: meta.done } : {}),
    };
  },
};

/** Unbounded push queue bridging socket callbacks to an async generator. */
class AsyncEventQueue {
  private items: StreamEvent[] = [];
  private waiters: Array<(r: IteratorResult<StreamEvent>) => void> = [];
  private closed = false;

  push(ev: StreamEvent): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: ev, done: false });
    else this.items.push(ev);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0))
      w({ value: undefined as any, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      const r = await new Promise<IteratorResult<StreamEvent>>((res) =>
        this.waiters.push(res),
      );
      if (r.done) return;
      yield r.value;
    }
  }
}

export interface HandleCallbacks {
  onAskUser?: RunAgentOpts["onAskUser"];
  onEngineSession?: (engineSessionId: string) => void;
  onSteerFailed?: (text: string) => void;
}

export class HostHandle {
  private queue = new AsyncEventQueue();
  private conn: HostConnection | null = null;
  private connector: HostConnector;
  private up = false;
  private endedClean = false;
  private sawTerminal = false;
  private terminalEvent?: StreamEvent;
  private pendingEndedHello = false;
  private endedHelloFallback?: ReturnType<typeof setTimeout>;
  private connectedBefore = false;
  private reportedSelectedModel?: string;
  private effectiveModel?: string;
  private transientFallback = false;
  private handlingAsks = new Set<string>();
  private steerRetractions = new Map<
    string,
    {
      resolve: (retracted: boolean) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** Sent steer ids awaiting their host-forwarded user transcript row. Active
   * hosts from an older release still mint a random uuid for that row; this
   * lets the new gateway rewrite it to the already-visible prompt entry id. */
  private pendingSteerTranscripts: Array<{ id: string; text: string }> = [];
  private respawns = 0;
  private stopRequested = false;
  private projectionTail: Promise<void> | undefined;
  private projectionFailure: unknown;
  private readonly ctl: HostRunControl;
  private onHostChanged?: (hostId: string) => void | Promise<void>;
  engineSessionId?: string;

  constructor(
    private dir: string,
    private spec: RunHostSpec,
    private cb: HandleCallbacks,
    private launcher: HostLauncher = systemdHostLauncher,
    private readonly logicalRunId: string = spec.hostId,
    private readonly cancelGraceMs = 5_000,
  ) {
    this.connector =
      launcher.connector?.(dir, spec) ??
      unixSocketConnector(`${dir}/${HOST_SOCK_NAME}`);
    this.reportedSelectedModel = spec.selectedModel ?? spec.model;
    this.effectiveModel = spec.model;
    this.transientFallback = spec.transientFallback === true;
    this.ctl = {
      hostId: spec.hostId,
      osSessionId: spec.osSessionId,
      steerable: modelSupportsSteer(spec.model),
      connected: () => this.up,
      reconcileTerminal: () => this.reconcileTerminalEvidence(),

      steer: (text, images, steerId) => {
        const sent = this.send({ t: "steer", text, images, steerId });
        if (
          sent &&
          steerId &&
          !this.pendingSteerTranscripts.some(
            (pending) => pending.id === steerId,
          )
        )
          this.pendingSteerTranscripts.push({ id: steerId, text });
        return sent;
      },
      retractSteer: (steerId) => this.retractSteer(steerId),

      interruptSteer: (text, images) =>
        this.send({ t: "interrupt_steer", text, images }),
      cancel: () => this.cancelHost(),
    };
    registerHostRun(
      [
        logicalRunId,
        spec.hostId,
        ...(spec.lifecycle === "auxiliary" ? [] : [spec.osSessionId]),
        spec.engineSessionId,
      ],
      this.ctl,
    );
    if (spec.engineSessionId) this.engineSessionId = spec.engineSessionId;
  }

  events(): AsyncGenerator<StreamEvent> {
    return this.queue[Symbol.asyncIterator]();
  }

  /** True once the run reached its clean end (terminal consumed, or the host
   *  reported a quiet cancel): the journal-clear condition for hosted runs. */
  get ended(): boolean {
    return this.endedClean;
  }

  takeObservedTerminal(): StreamEvent | undefined {
    const terminal = this.terminalEvent;
    this.terminalEvent = undefined;
    return terminal;
  }

  /** Reconcile a terminal receipt that may have landed after the socket was
   * lost. Registry busy/steer checks call this synchronously so a completed
   * detached owner cannot remain steerable until another gateway restart. */
  reconcileTerminalEvidence(): boolean {
    if (this.endedClean) return true;
    const meta = readJsonSafe<RunHostMeta>(`${this.dir}/${HOST_META_NAME}`);
    if (!meta?.done) return false;
    if (!this.sawTerminal) {
      this.sawTerminal = true;
      this.terminalEvent = meta.done;
      this.queue.push(meta.done);
    }
    this.finish();
    return true;
  }

  /** The host id currently serving this run (respawn mints a fresh one). */
  get currentHostId(): string {
    return this.ctl.hostId;
  }

  /** True once cancellation was requested (stop backstop may still be
   *  running) or the handle already finished. Launchers check this right
   *  after dispatch so a cancelled launch never attaches. */
  get cancelled(): boolean {
    return this.stopRequested || this.endedClean;
  }

  setHostChangeHandler(
    handler: (hostId: string) => void | Promise<void>,
  ): void {
    this.onHostChanged = handler;
  }

  private send(msg: ClientToHostMsg): boolean {
    return this.conn ? this.conn.send(msg) : false;
  }

  requestCancel(): boolean {
    return this.ctl.cancel();
  }

  async executionEvidence(): Promise<HostExecutionEvidence> {
    if (this.launcher.evidence) return this.launcher.evidence(this.dir);
    const meta = readJsonSafe<RunHostMeta>(`${this.dir}/${HOST_META_NAME}`);
    return {
      started: !!meta?.pid,
      ...(meta?.engineSessionId
        ? { engineSessionId: meta.engineSessionId }
        : {}),
      ...(meta?.done ? { done: meta.done } : {}),
    };
  }

  async stopAndWait(
    timeoutMs = 10_000,
    preserveEvidence = false,
  ): Promise<boolean> {
    if (this.ended) return true;
    this.send({ t: "cancel" });
    const deadline = Date.now() + timeoutMs;
    while (!this.ended && Date.now() < deadline) await Bun.sleep(50);
    if (this.ended) return true;
    if (!this.launcher.stop) return false;
    try {
      await this.launcher.stop(this.ctl.hostId, this.dir);
      if (preserveEvidence) this.abandon();
      else this.finish();
      return true;
    } catch (error) {
      console.error(`[host-client] could not stop ${this.ctl.hostId}:`, error);
      return false;
    }
  }

  private cancelHost(): boolean {
    if (this.endedClean || this.stopRequested) return true;
    const delivered = this.send({ t: "cancel" });
    if (!this.launcher.stop) return delivered;

    // A cooperative abort can wedge inside an MCP/tool await. Do not leave that
    // detached host as a permanent owner: after a short grace, stop its isolated
    // execution boundary and prove it absent. Without this backstop every server
    // restart reattaches the same cancelled host and makes the session look alive
    // while all of its now-stale frames are rejected.
    this.stopRequested = true;
    void (async () => {
      if (delivered && this.cancelGraceMs > 0)
        await Bun.sleep(this.cancelGraceMs);
      if (this.endedClean) return;
      try {
        await this.launcher.stop!(this.ctl.hostId, this.dir);
        this.finish();
      } catch (error) {
        this.stopRequested = false;
        console.error(
          `[host-client] could not prove cancelled host ${this.ctl.hostId} absent:`,
          error,
        );
      }
    })();
    return true;
  }

  private retractSteer(steerId: string): Promise<boolean> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.steerRetractions.delete(requestId);
        resolve(false);
      }, 3_000);
      this.steerRetractions.set(requestId, { resolve, timer });
      if (!this.send({ t: "retract_steer", requestId, steerId })) {
        clearTimeout(timer);
        this.steerRetractions.delete(requestId);
        resolve(false);
      }
    });
  }

  private settleSteerRetractions(): void {
    for (const pending of this.steerRetractions.values()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.steerRetractions.clear();
  }

  /** Retry-connect until the host is reachable; used for fresh spawns and boot
   *  reattach. (The socket connector rejects while the socket file is absent,
   *  the WS connector while the host's dial-back hasn't arrived — either way
   *  the 300ms poll below preserves the old "wait for the socket" cadence.) */
  async connectWithWait(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown = null;
    let attempts = 0;
    for (;;) {
      attempts++;
      try {
        // BOUNDED attempt: a connector whose promise never settles (a stalled
        // transport/SDK call) must not freeze the whole wait loop silently —
        // treat a >5s attempt as failed and keep polling until the deadline.
        const r = await Promise.race([
          this.connectOnce().then(() => "ok" as const),
          new Promise<"stall">((res) => setTimeout(() => res("stall"), 5_000)),
        ]);
        if (r === "ok") return;
        lastErr = new Error(
          "connect attempt stalled >5s (promise never settled)",
        );
        console.warn(
          `[host-client] ${this.spec.hostId.slice(0, 11)}: connect attempt ${attempts} stalled >5s`,
        );
      } catch (e) {
        lastErr = e;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `run host ${this.spec.hostId} never became connectable after ${attempts} attempt(s): ${lastErr}`,
        );
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  private async connectOnce(): Promise<void> {
    const conn = await this.connector.connect({
      onMsg: (m) => this.handleMsg(m),
      onClose: () => {
        this.up = false;
        this.conn = null;
        void this.onDisconnect();
      },
    });
    this.conn = conn;
    this.up = true;
  }

  private noteEngineId(id: string): void {
    if (!id || id === this.engineSessionId) return;
    this.engineSessionId = id;
    addHostRunKey(id, this.ctl);
    try {
      this.cb.onEngineSession?.(id);
    } catch {}
  }

  private acceptsSideEffectFrame(frameType: string): boolean {
    if (this.spec.lifecycle === "auxiliary") return true;
    const kernel = sessionKernel(this.spec.osSessionId);
    if (kernel.isCurrentRunProjection(this.logicalRunId)) return true;
    // Transcript frames are idempotent uuid-keyed upserts of history the host
    // already durably wrote (transcript-relay replay on every reattach). They
    // must survive the run SETTLING before the replay lands: a restart can
    // mark the run idle between the host's final entries and the reconnect's
    // hello, and rejecting then silently drops the turn's closing summary
    // (2026-08-21 os-01a02469: the model's final message was produced during
    // that window, all 40 replayed frames were rejected as stale, and the user
    // had to ask "pr?"). Reject only while a DIFFERENT live run owns the
    // session — that is the cross-run interleaving the fence exists for; a
    // settled session has no writer to race with.
    if (frameType === "transcript") {
      const current = kernel.runStateProjection();
      const ownedByAnotherLiveRun =
        ["running", "ask_blocked", "interrupted", "reattaching"].includes(
          current.state,
        ) &&
        !!current.currentRunId &&
        current.currentRunId !== this.logicalRunId;
      if (!ownedByAnotherLiveRun) return true;
    }
    this.requestCancel();
    audit({
      msg: "stale_executor_frame_rejected",
      session_id: this.spec.osSessionId,
      run_key: this.logicalRunId,
      frame_type: frameType,
    });
    return false;
  }

  private enqueueProjectionFrame(
    operation: () => void | Promise<void>,
    runAfterFailure = false,
  ): void {
    const prior = this.projectionTail ?? Promise.resolve();
    const current = prior.then(async () => {
      if (this.projectionFailure && !runAfterFailure)
        throw this.projectionFailure;
      await operation();
    });
    const observed = current.catch((error) => {
      if (!this.projectionFailure) {
        this.projectionFailure = error;
        this.queue.push({
          type: "error",
          content: `Run host projection failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });
    this.projectionTail = observed;
    void observed.finally(() => {
      if (this.projectionTail === observed) this.projectionTail = undefined;
    });
  }

  /** Completion fence for transcript frames and every later host frame. */
  async waitForPendingProjections(): Promise<void> {
    await this.projectionTail;
    if (this.projectionFailure) throw this.projectionFailure;
  }

  private alignSteerTranscriptIds(
    lines: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    if (this.pendingSteerTranscripts.length === 0) return lines;
    return lines.map((line) => {
      if (line.type !== "user") return line;
      const content = (line.message as { content?: unknown } | undefined)
        ?.content;
      const text = Array.isArray(content)
        ? content
            .filter(
              (block): block is { type: "text"; text: string } =>
                !!block &&
                typeof block === "object" &&
                (block as { type?: unknown }).type === "text" &&
                typeof (block as { text?: unknown }).text === "string",
            )
            .map((block) => block.text)
            .join("\n")
        : "";
      if (line.uuid === this.spec.promptEntryId || text === this.spec.prompt)
        return line;
      let index = this.pendingSteerTranscripts.findIndex(
        (pending) => pending.text === text,
      );
      // Skill expansion can rewrite the engine text. Pi itself pairs that
      // delivery with the oldest pending steer, so mirror that exact fallback.
      if (index < 0 && text) index = 0;
      if (index < 0) return line;
      const [pending] = this.pendingSteerTranscripts.splice(index, 1);
      return line.uuid === pending.id ? line : { ...line, uuid: pending.id };
    });
  }

  private deferEndedHelloFinish(): void {
    this.pendingEndedHello = true;
    if (this.endedHelloFallback) clearTimeout(this.endedHelloFallback);
    this.endedHelloFallback = setTimeout(() => {
      this.endedHelloFallback = undefined;
      // Older hosts have no catchup_complete marker. Their socket replay is
      // synchronous, so an idle window after the last transcript frame is the
      // compatibility fence. Still serialize cleanup behind every projection
      // received before that window closed. A frame arriving while those
      // projections drain re-arms the timer and cancels this cleanup attempt.
      this.enqueueProjectionFrame(() => {
        if (this.pendingEndedHello && !this.endedHelloFallback) this.finish();
      }, true);
    }, ENDED_HELLO_CATCHUP_FALLBACK_MS);
  }

  private clearEndedHelloFallback(): void {
    if (this.endedHelloFallback) clearTimeout(this.endedHelloFallback);
    this.endedHelloFallback = undefined;
    this.pendingEndedHello = false;
  }

  private handleMsg(msg: HostToClientMsg): void {
    if (msg.t === "transcript" && this.pendingEndedHello) {
      this.deferEndedHelloFinish();
    }
    if (
      msg.t !== "transcript" &&
      (this.projectionTail || this.projectionFailure)
    ) {
      // Terminal frames are cleanup, not another projection. They must close
      // the stream even when the transcript projection ahead of them failed.
      // Every other frame remains fenced after the failed tail settles:
      // projectionFailure is a permanent authority failure for this handle,
      // not just queue state.
      const cleanupFrame = msg.t === "end" || msg.t === "catchup_complete";
      this.enqueueProjectionFrame(() => this.handleMsgNow(msg), cleanupFrame);
      return;
    }
    this.handleMsgNow(msg);
  }

  private handleMsgNow(msg: HostToClientMsg): void {
    switch (msg.t) {
      case "hello": {
        if (!this.acceptsSideEffectFrame("hello")) break;
        if (msg.engineSessionId) this.noteEngineId(msg.engineSessionId);
        if (msg.effectiveModel) {
          this.effectiveModel = msg.effectiveModel;
          this.ctl.steerable = modelSupportsSteer(msg.effectiveModel);
        }
        if (msg.transientFallback !== undefined) {
          this.transientFallback = msg.transientFallback;
        }
        // Unix sockets are live-only, so every reconnect must reconcile from
        // the host snapshot. WS reconnects replay sequenced event frames; only
        // a fresh handle after a opensession restart needs snapshot catch-up.
        if (
          (!this.spec.wsToken || !this.connectedBefore) &&
          msg.selectedModel &&
          msg.selectedModel !== this.reportedSelectedModel
        ) {
          const fromModel = this.reportedSelectedModel;
          this.reportedSelectedModel = msg.selectedModel;
          this.queue.push({
            type: "model_switch",
            fromModel,
            toModel: msg.selectedModel,
            switchReason: "out of credits",
            temporaryFallback: false,
          });
        }
        this.connectedBefore = true;
        if (
          msg.pendingAsks?.length &&
          this.acceptsSideEffectFrame("hello.pendingAsks")
        )
          for (const ask of msg.pendingAsks)
            this.handleAsk(ask.askId, ask.input);
        if (msg.state === "ended") {
          if (msg.done && !this.sawTerminal) {
            this.sawTerminal = true;
            this.terminalEvent = msg.done;
            this.queue.push(msg.done);
          }
          // A detached host sends hello before replaying transcript frames.
          // Finishing here closes the socket and discards summaries produced
          // while the gateway was down. catchup_complete is the exact fence;
          // the timer only supports hosts from before that frame existed.
          this.deferEndedHelloFinish();
        }
        break;
      }
      case "event": {
        const ev = msg.event;
        if (!this.acceptsSideEffectFrame(`event:${ev.type}`)) break;
        if (ev.type === "init" && ev.sessionId) this.noteEngineId(ev.sessionId);
        if (ev.type === "model_switch" && ev.toModel) {
          this.effectiveModel = ev.toModel;
          this.transientFallback = ev.temporaryFallback === true;
          this.ctl.steerable = modelSupportsSteer(ev.toModel);
          if (shouldPersistModelSwitch(ev))
            this.reportedSelectedModel = ev.toModel;
        }
        if (ev.type === "done" || ev.type === "error") {
          this.sawTerminal = true;
          this.terminalEvent = ev;
        }
        this.queue.push(ev);
        break;
      }
      case "ask":
        if (this.acceptsSideEffectFrame("ask"))
          this.handleAsk(msg.askId, msg.input);
        break;
      case "transcript":
        // Transcript frames bypass the StreamEvent queue, so fence them here
        // against the same run generation as ordinary host events.
        if (!this.acceptsSideEffectFrame("transcript")) break;
        this.enqueueProjectionFrame(() => {
          const lines = this.alignSteerTranscriptIds(msg.lines);
          if (this.spec.transcriptTarget === "none") return;
          return this.spec.transcriptTarget === "engine"
            ? appendTranscriptEntries(msg.engineSessionId, lines)
            : applyForwardedTranscriptStrict(
                this.spec.osSessionId,
                msg.engineSessionId,
                lines,
              );
        });
        break;
      case "steer_failed":
        if (this.acceptsSideEffectFrame("steer_failed")) {
          const failed = this.pendingSteerTranscripts.findIndex(
            (pending) => pending.text === msg.text,
          );
          if (failed >= 0) this.pendingSteerTranscripts.splice(failed, 1);
          this.cb.onSteerFailed?.(msg.text);
        }
        break;
      case "steer_retracted": {
        const pending = this.steerRetractions.get(msg.requestId);
        if (!pending) break;
        clearTimeout(pending.timer);
        this.steerRetractions.delete(msg.requestId);
        if (msg.retracted) {
          const index = this.pendingSteerTranscripts.findIndex(
            (pendingSteer) => pendingSteer.id === msg.steerId,
          );
          if (index >= 0) this.pendingSteerTranscripts.splice(index, 1);
        }
        pending.resolve(msg.retracted);
        break;
      }
      case "end": {
        if (msg.done && !this.sawTerminal) {
          this.sawTerminal = true;
          this.terminalEvent = msg.done;
          this.queue.push(msg.done);
        }
        this.finish();
        break;
      }
      case "catchup_complete":
        if (this.pendingEndedHello) this.finish();
        break;
    }
  }

  private handleAsk(askId: string, input: Record<string, unknown>): void {
    // A reconnect re-delivers pending asks in hello — don't double-handle ones
    // this process is already blocking a human on.
    if (this.handlingAsks.has(askId)) return;
    this.handlingAsks.add(askId);
    void (async () => {
      let result:
        | { behavior: "allow"; updatedInput: Record<string, unknown> }
        | { behavior: "deny"; message: string };
      try {
        result = this.cb.onAskUser
          ? await this.cb.onAskUser(input)
          : {
              behavior: "deny" as const,
              message:
                "This run is headless — nobody can answer questions. Use your best judgment and note the assumption.",
            };
      } catch (e: any) {
        result = {
          behavior: "deny" as const,
          message: `Question UI failed (${e?.message || e}) — decide yourself and note the assumption.`,
        };
      }
      this.handlingAsks.delete(askId);
      if (!this.acceptsSideEffectFrame("ask_answer")) return;
      this.send({ t: "ask_answer", askId, result });
    })();
  }

  /**
   * Failed-launch cleanup. The constructor registers this handle's control in
   * the host-registry (and its run token may be registered too), so a connect
   * failure after construction MUST drop both — otherwise hostRunBusy() stays
   * true forever and the session is wedged busy. Mirrors finish() minus the
   * shutdown message and run-dir removal (the failing caller owns the dir).
   */
  abandon(): void {
    if (this.endedClean) return;
    this.endedClean = true;
    this.clearEndedHelloFallback();
    this.queue.end();
    this.settleSteerRetractions();
    unregisterHostRun(this.ctl);
    unregisterRunToken(this.spec.rpcToken);
    this.connector.dispose?.();
  }

  /** Clean end: ack the host, close out the generator, drop registrations + files. */
  private finish(): void {
    if (this.endedClean) return;
    this.endedClean = true;
    this.clearEndedHelloFallback();
    this.send({ t: "shutdown" });
    this.queue.end();
    this.settleSteerRetractions();
    unregisterHostRun(this.ctl);
    unregisterRunToken(this.spec.rpcToken);
    this.connector.dispose?.();
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {}
  }

  private async hostAlive(): Promise<boolean> {
    const meta = readJsonSafe<RunHostMeta>(`${this.dir}/${HOST_META_NAME}`);
    return this.launcher.alive(this.dir, meta);
  }

  /** Socket dropped without a clean end: reconnect while the host lives, else
   *  consume its final state — or respawn a crashed host to resume the run. */
  private async onDisconnect(): Promise<void> {
    while (!this.endedClean) {
      await new Promise((r) => setTimeout(r, 2000));
      if (this.endedClean) return;
      if (!(await this.hostAlive())) break;
      try {
        await this.connectOnce();
        return;
      } catch {}
    }
    if (this.endedClean) return;

    const meta = readJsonSafe<RunHostMeta>(`${this.dir}/${HOST_META_NAME}`);
    if (this.reconcileTerminalEvidence()) return;

    // Crashed mid-run. If the run had an engine session, respawn a fresh host
    // to resume it — transparent to whoever is consuming events().
    const journal = readHostJournal(this.dir);
    const engineId =
      journal?.claudeSessionId ||
      this.engineSessionId ||
      this.spec.engineSessionId;
    if (engineId && this.respawns < 2) {
      this.respawns++;
      console.warn(
        `[host-client] run host ${this.spec.hostId} died mid-run — respawning to resume ${this.spec.osSessionId}`,
      );
      try {
        await this.respawn(engineId, meta);
        return;
      } catch (e) {
        console.error("[host-client] respawn failed:", e);
        if (e instanceof ExecutorProtocolError && e.ambiguousLaunch) {
          try {
            await this.connectWithWait(60_000);
            return;
          } catch (connectError) {
            console.error(
              "[host-client] uncertain replacement host did not become connectable:",
              connectError,
            );
            this.queue.push({
              type: "error",
              content:
                "The replacement run host may still be starting. Recovery state was preserved to avoid running the turn twice.",
            });
            this.queue.end();
            return;
          }
        }
      }
    }
    this.queue.push({
      type: "error",
      content: "Run host process died unexpectedly and could not be resumed.",
    });
    this.finish();
  }

  private async respawn(
    engineId: string,
    meta?: RunHostMeta | null,
  ): Promise<void> {
    const oldDir = this.dir;
    const hostId = `rh-${Bun.randomUUIDv7()}`;
    const dir = this.launcher.newRunDir(hostId);
    const spec: RunHostSpec = {
      ...this.spec,
      hostId,
      prompt: resumeContinuationPrompt(this.spec.prompt),
      engineSessionId: engineId,
      model: meta?.effectiveModel ?? this.effectiveModel ?? this.spec.model,
      selectedModel:
        meta?.selectedModel ??
        this.reportedSelectedModel ??
        this.spec.selectedModel ??
        this.spec.model,
      transientFallback: meta?.transientFallback ?? this.transientFallback,
      images: undefined,
      forkSession: undefined,
      resumeSessionAt: undefined,
      journalKind: recoveryKind(this.spec.journalKind, "resume"),
    };
    if (this.launcher.writeSpec) {
      await this.launcher.writeSpec(dir, spec);
    } else {
      mkdirSync(dir, { recursive: true });
      writeJsonAtomic(`${dir}/${HOST_SPEC_NAME}`, spec);
    }
    this.dir = dir;
    this.spec = spec;
    this.connectedBefore = false;
    this.effectiveModel = spec.model;
    this.transientFallback = spec.transientFallback === true;
    this.ctl.hostId = hostId;
    await this.onHostChanged?.(hostId);
    // The old host id's transport registration (WS token/conn) is dead with
    // the old host — swap in a connector for the new id (same wsToken; the
    // launcher re-registered it under the new host id in launch()).
    this.connector.dispose?.();
    this.connector =
      this.launcher.connector?.(dir, spec) ??
      unixSocketConnector(`${dir}/${HOST_SOCK_NAME}`);
    await this.launcher.launch(hostId, dir);
    try {
      rmSync(oldDir, { recursive: true, force: true });
    } catch {}
    try {
      await this.connectWithWait(20_000);
    } catch (cause) {
      try {
        await stopAndVerifyHostAbsent(hostId, dir);
      } catch (cleanupError) {
        throw cleanupError;
      }
      throw cause;
    }
  }
}

export async function* reconcileUncertainHostEvents(
  handle: HostHandle,
  label: string,
  graceMs = 120_000,
): AsyncGenerator<StreamEvent> {
  let deadline = Date.now() + graceMs;
  let reportedUncertain = false;
  while (!handle.ended) {
    try {
      await handle.connectWithWait(
        Math.min(30_000, Math.max(1_000, deadline - Date.now())),
      );
      yield* handle.events();
      return;
    } catch (error) {
      if (Date.now() < deadline) {
        await Bun.sleep(1_000);
        continue;
      }
      const evidence = await handle.executionEvidence();
      if (evidence.done) {
        yield evidence.done;
        await handle.stopAndWait(1_000, true);
        return;
      }
      if (await handle.stopAndWait(10_000, true)) {
        const observedTerminal = handle.takeObservedTerminal();
        if (observedTerminal) {
          yield observedTerminal;
          return;
        }
        // Terminal evidence may land while cancellation is waiting. Re-read
        // only after absence is proven and before shared ownership is cleared.
        const finalEvidence = await handle.executionEvidence();
        if (finalEvidence.done) {
          yield finalEvidence.done;
          return;
        }
        yield {
          type: "error",
          content:
            evidence.started || finalEvidence.started
              ? `${label} may have executed before it was stopped. Recovery evidence was retained.`
              : `${label} was not observed and its process was stopped.`,
        };
        return;
      }
      if (!reportedUncertain) {
        reportedUncertain = true;
        yield {
          type: "runner_notice",
          text: `${label} launch outcome remains uncertain. Recovery ownership was retained.`,
        };
      }
      console.warn(`[host-client] ${label} remains uncertain:`, error);
      deadline = Date.now() + 60_000;
    }
  }
}

function readJsonSafe<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function readHostJournal(dir: string): ActiveRunRecord | null {
  const j = readJsonSafe<Record<string, ActiveRunRecord>>(
    `${dir}/${HOST_JOURNAL_NAME}`,
  );
  if (!j) return null;
  const records = Object.values(j);
  return records[0] || null;
}

export function resolveInactiveHostRecovery(
  meta: RunHostMeta | null,
  privateJournal: ActiveRunRecord | null,
  sharedEngineSessionId?: string,
):
  | { kind: "resume"; engineSessionId: string }
  | { kind: "uncertain" }
  | { kind: "replay" } {
  const engineSessionId =
    meta?.engineSessionId ||
    privateJournal?.claudeSessionId ||
    sharedEngineSessionId;
  if (engineSessionId) return { kind: "resume", engineSessionId };
  if (meta || privateJournal) return { kind: "uncertain" };
  return { kind: "replay" };
}

/**
 * Boot reattach for a LOCAL detached run host (journal record with `hostId`,
 * no sandbox/runner): the local sibling of resumeDockerSandboxRun /
 * resumeRunnerRun. The host process outlived the restart in its transient
 * systemd unit; reconnect to its socket and re-pump the live stream. A host
 * that FINISHED while the server was down has its terminal consumed from
 * meta.json (mirroring HostHandle's meta.done path). Null is returned only
 * when the host is proven inactive and there is either no execution evidence
 * or an engine session that can be resumed in-process. Execution evidence
 * without an engine id stays uncertain so the original prompt is not replayed.
 */
export async function resumeLocalHostRun(
  run: ActiveRunRecord,
  callbacks: HandleCallbacks,
): Promise<AsyncGenerator<StreamEvent> | "uncertain" | null> {
  if (!run.hostId) return null;
  const dir = `${HOSTS_DIR}/${run.hostId}`;
  let meta = readJsonSafe<RunHostMeta>(`${dir}/${HOST_META_NAME}`);
  const spec = readJsonSafe<RunHostSpec>(`${dir}/${HOST_SPEC_NAME}`);
  if (!spec) {
    try {
      if (await hostUnitActive(run.hostId)) return "uncertain";
    } catch {
      return "uncertain";
    }
    const recovery = resolveInactiveHostRecovery(
      meta,
      readHostJournal(dir),
      run.claudeSessionId,
    );
    if (recovery.kind === "uncertain") return "uncertain";
    if (recovery.kind === "resume") {
      run.claudeSessionId = recovery.engineSessionId;
      await journalSet({ ...run, claimedAt: undefined });
    }
    return null;
  }
  let alive = await systemdHostLauncher.alive(dir, meta);
  if (!alive && !meta?.done) {
    await waitForLocalHost(dir, 30_000);
    meta = readJsonSafe<RunHostMeta>(`${dir}/${HOST_META_NAME}`);
    alive = await systemdHostLauncher.alive(dir, meta);
  }
  if (!alive) {
    if (meta?.done) {
      const done = meta.done;
      unregisterRunToken(spec.rpcToken);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
      return (async function* () {
        yield done;
      })();
    }
    try {
      if (await hostUnitActive(run.hostId)) return "uncertain";
    } catch {
      return "uncertain";
    }
    const recovery = resolveInactiveHostRecovery(
      meta,
      readHostJournal(dir),
      run.claudeSessionId,
    );
    if (recovery.kind === "uncertain") return "uncertain";
    if (recovery.kind === "resume") {
      run.claudeSessionId = recovery.engineSessionId;
      await journalSet({ ...run, claimedAt: undefined });
    }
    return null;
  }
  if (spec.rpcToken) {
    registerRunToken(spec.rpcToken, {
      sessionId: spec.osSessionId,
      user: spec.user,
    });
  }
  const handle = new HostHandle(
    dir,
    spec,
    callbacks,
    systemdHostLauncher,
    run.runKey,
  );
  handle.setHostChangeHandler(async (hostId) => {
    run.hostId = hostId;
    await hostedKernelCall(spec, "reattach_host_change_journal", () =>
      journalSet({ ...run, claimedAt: undefined }),
    );
  });
  try {
    await handle.connectWithWait(20_000);
  } catch (e) {
    console.warn(
      `[host-client] local host reattach failed for ${run.hostId}:`,
      e,
    );
    handle.abandon();
    try {
      if (await hostUnitActive(run.hostId)) return "uncertain";
    } catch {
      return "uncertain";
    }
    meta = readJsonSafe<RunHostMeta>(`${dir}/${HOST_META_NAME}`);
    if (meta?.done) {
      return (async function* () {
        yield meta.done!;
      })();
    }
    const recovery = resolveInactiveHostRecovery(
      meta,
      readHostJournal(dir),
      run.claudeSessionId,
    );
    if (recovery.kind === "uncertain") return "uncertain";
    if (recovery.kind === "resume") {
      run.claudeSessionId = recovery.engineSessionId;
      await journalSet({ ...run, claimedAt: undefined });
    }
    return null;
  }
  return (async function* (): AsyncGenerator<StreamEvent> {
    try {
      for await (const event of handle.events()) {
        let changed = false;
        if (
          event.type === "init" &&
          event.sessionId &&
          event.sessionId !== run.claudeSessionId
        ) {
          run.claudeSessionId = event.sessionId;
          changed = true;
        }
        if (event.type === "model_switch" && event.toModel) {
          run.model = event.toModel;
          run.transientFallback = event.temporaryFallback === true;
          if (shouldPersistModelSwitch(event))
            run.selectedModel = event.toModel;
          changed = true;
        }
        if (changed) await journalSet({ ...run, claimedAt: undefined });
        yield event;
      }
    } finally {
      if (handle.ended) journalClear(run.runKey);
    }
  })();
}
