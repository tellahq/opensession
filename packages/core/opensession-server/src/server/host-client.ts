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
import {
  createHostedRunLifetime,
  attachHostedRunLifetime,
  type HostedLifetimeControl,
} from "./host-run-lifetime";
export { finalizeHostedRun } from "./host-run-lifetime";
import {
  tagHostedEvent,
  hostedEventPublication,
  withHostedEventPublication,
  type HostedEventPublication,
} from "./host-event-publication";
import {
  createPersonalHostTransitions,
  sharedPersonalHostTransitions,
} from "./personal-host-transitions";
import { stopPersonalPhysicalHost } from "./personal-host-physical";
import { assertPersonalHostMcpNone } from "./personal-repo-runtime-mcp";
import { assertPersonalHostLineage } from "./personal-repo-runtime-host";
import {
  personalRunRetired,
  personalRunRetirementConfirmed,
  requestPersonalRunRetirement,
  assertPersonalRunConsumerEnrolled,
  confirmPersonalRunPhysicalCompletion,
  retirePersonalRunConsumer,
  registerPersonalRunConsumer,
  type PersonalRunConsumer,
} from "./personal-run-consumers";
import { sessionPublicationAllowed } from "./session-audience";
import {
  bindHostPublication,
  bindHostPublicationSuccessor,
  hostPublicationContext,
  type HostPublication,
  type HostPublicationSource,
} from "./personal-repo-runtime-publication";
import { samePersonalRepoBinding } from "./personal-repo-runtime";
import { waitForRunHostAdmission } from "./host-admission";
import {
  isRetryableSessionCommandError,
  sessionKernel,
} from "./session-kernel";
import { existsSync, readFileSync } from "fs";
import { access, mkdir, readFile, rm } from "fs/promises";
import {
  runAgent,
  recoveryKind,
  resumeContinuationPrompt,
  type RunAgentOpts,
  type StreamEvent,
} from "./agent-runner";
import {
  journalClearIfLineageAsync,
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
import { OPENSESSION_SESSIONS_DIR, stateContext } from "./paths";
import { writeJsonAtomicAsync } from "./shared/atomic-write";
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
  verifyPersonalRunHostHelper,
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
// Disconnected handles poll the host at this cadence: one metadata read, one
// liveness check, one reconnect attempt per iteration.
const HOST_RECONNECT_DELAY_MS = 2_000;
// A single connect attempt is abandoned after this long: a transport whose
// connect promise never settles must not wedge the reconnect loops. A late
// success is closed, never adopted.
const CONNECT_ATTEMPT_TIMEOUT_MS = 5_000;

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
// A process-local fact minted only after exclusive creation, never metadata.
const freshPersonalSpecs = new WeakSet<RunHostSpec>();
const personalHostState = Object.freeze({
  ...stateContext(),
  sessionsDir: OPENSESSION_SESSIONS_DIR,
  explicitSessionsDir: process.env.OPENSESSION_SESSIONS_DIR ?? null,
});
function assertPersonalHostState(): void {
  const current = {
    ...stateContext(),
    sessionsDir: OPENSESSION_SESSIONS_DIR,
    explicitSessionsDir: process.env.OPENSESSION_SESSIONS_DIR ?? null,
  };
  if (JSON.stringify(current) !== JSON.stringify(personalHostState))
    throw new Error(
      "Personal host state changed; reinitialize this runtime before use",
    );
  if (
    personalHostState.explicitSessionsDir &&
    runHostsDir(personalHostState.explicitSessionsDir) !== HOSTS_DIR
  )
    throw new Error("Personal host sessions path changed");
  if (
    !personalHostState.explicitSessionsDir &&
    personalHostState.stateRoot &&
    !HOSTS_DIR.startsWith(`${personalHostState.stateRoot.replace(/\/$/, "")}/`)
  )
    throw new Error("Personal host path belongs to another state context");
}
function personalHostTransitions() {
  assertPersonalHostState();
  return sharedPersonalHostTransitions(
    { ...personalHostState, hostsDir: HOSTS_DIR },
    () =>
      createPersonalHostTransitions({
        retired: (c) => {
          assertPersonalHostState();
          return personalRunRetired(c);
        },
        enrolled: (c) => {
          assertPersonalHostState();
          return assertPersonalRunConsumerEnrolled(c);
        },
        requestRetirement: (c) => {
          assertPersonalHostState();
          return requestPersonalRunRetirement(c);
        },
        async spec(c) {
          assertPersonalHostState();
          const bytes = await readFile(
            `${HOSTS_DIR}/${c.hostId}/${HOST_SPEC_NAME}`,
          );
          return {
            spec: JSON.parse(bytes.toString("utf8")),
            hash: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
          };
        },
        stopPhysical: (c, hash, dispatch) => {
          assertPersonalHostState();
          return stopPersonalPhysicalHost(
            c,
            `${HOSTS_DIR}/${c.hostId}`,
            hash,
            dispatch,
          );
        },
      }),
  );
}
export function stopPersonalHostAndConfirm(consumer: PersonalRunConsumer) {
  return personalHostTransitions().stop(consumer);
}
function privateLifetime(
  original:
    | {
        runKey: string;
        sessionId: string;
        binding: import("./personal-repo-runtime").PersonalRepoBinding;
      }
    | undefined,
) {
  return createHostedRunLifetime(original, {
    stop: stopPersonalHostAndConfirm,
    confirmed: (c) => {
      assertPersonalHostState();
      return personalRunRetirementConfirmed(c);
    },
    async retire(c) {
      assertPersonalHostState();
      await retirePersonalRunConsumer(c);
      personalHostTransitions().forget(c);
      await personalHostTransitions().cleanupEvidence(c, () =>
        rm(`${HOSTS_DIR}/${c.hostId}`, { recursive: true, force: true }),
      );
    },
  });
}
function hostedLifetimeOptions<T extends HostedRunOpts>(
  input: T,
): { opts: T; lifetime: HostedLifetimeControl } {
  const opts = input.personalRepo
    ? {
        ...input,
        startToken: input.startToken || `rh-${Bun.randomUUIDv7()}`,
        personalRepo: structuredClone(input.personalRepo),
      }
    : input;
  const lifetime = privateLifetime(
    opts.personalRepo
      ? {
          runKey: opts.startToken!,
          sessionId: opts.osSessionId,
          binding: opts.personalRepo,
        }
      : undefined,
  );
  return {
    lifetime,
    opts: opts.personalRepo
      ? {
          ...opts,
          shouldCancel: () => lifetime.closed || !!input.shouldCancel?.(),
        }
      : opts,
  };
}

function consumerForSpec(spec: RunHostSpec): PersonalRunConsumer {
  assertPersonalHostLineage(spec);
  if (!spec.personalRepo) throw new Error("Personal host binding unavailable");
  return {
    runKey: spec.logicalRunId!,
    hostId: spec.hostId,
    sessionId: spec.osSessionId,
    binding: spec.personalRepo,
  };
}

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
  personalRepo?: import("./personal-repo-runtime").PersonalRepoBinding;
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
  accountUser?: string;
  fallbackModel?: string;
  /** Stable provider-account affinity for internal fan-out workers. */
  accountAffinityKey?: string;
  /** Reasoning effort / service tier / account pinning for the run (see the
   *  matching RunHostSpec fields). */
  effort?: string;
  fastMode?: boolean;
  pstackMode?: boolean;
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
  fallbackInProcessMcp?: () =>
    | Record<string, unknown>
    | Promise<Record<string, unknown> | undefined>
    | undefined;
}

/**
 * Run a prompt in a detached run host, yielding the same StreamEvents as
 * runAgent. A Linux host never falls back into the gateway: launch failure is
 * visible and retryable, while non-systemd platforms retain in-process mode.
 */
export function runAgentHosted(
  opts: HostedRunOpts,
): AsyncGenerator<StreamEvent> {
  const prepared = hostedLifetimeOptions(opts);
  return attachHostedRunLifetime(
    runAgentHostedInner(prepared.opts, prepared.lifetime),
    prepared.lifetime.api,
  );
}
async function* runAgentHostedInner(
  opts: HostedRunOpts,
  lifetime: HostedLifetimeControl,
): AsyncGenerator<StreamEvent> {
  if (opts.personalRepo) lifetime.assertOpen();
  assertPersonalHostMcpNone(opts);
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
    const launch = spawnHostRun(opts, "session", "session", lifetime);
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
export function runAuxiliaryAgentHosted(
  opts: AuxiliaryHostedRunOpts,
): AsyncGenerator<StreamEvent> {
  const prepared = hostedLifetimeOptions(opts);
  return attachHostedRunLifetime(
    runAuxiliaryAgentHostedInner(prepared.opts, prepared.lifetime),
    prepared.lifetime.api,
  );
}
async function* runAuxiliaryAgentHostedInner(
  opts: AuxiliaryHostedRunOpts,
  lifetime: HostedLifetimeControl,
): AsyncGenerator<StreamEvent> {
  if (opts.personalRepo) lifetime.assertOpen();
  assertPersonalHostMcpNone(opts);
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
      lifetime,
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
  if (opts.personalRepo)
    throw new Error(
      "Personal repositories require the compatible detached runtime",
    );
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
    inProcessMcp: await opts.fallbackInProcessMcp?.(),
    reposNote: opts.reposNote,
    deniedTools: opts.deniedTools,
    publicationPolicy: opts.publicationPolicy,
    confirmTools: opts.confirmTools,
    aws: opts.aws,
    claudeCliEnv: opts.claudeCliEnv,
    codexCliEnv: opts.codexCliEnv,
    author: opts.author,
    user: opts.user,
    accountUser: opts.accountUser,
    fallbackModel: opts.fallbackModel,
    accountAffinityKey: opts.accountAffinityKey,
    effort: opts.effort,
    fastMode: opts.fastMode,
    pstackMode: opts.pstackMode,
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
export async function* hostedEventsWithJournal(
  handle: HostHandle,
  spec: RunHostSpec,
): AsyncGenerator<StreamEvent> {
  await handle.bindPublication();
  const call = <T>(
    operation: string,
    work: () => T | Promise<T>,
    context = handle.eventContext(),
  ) =>
    context.run(() =>
      hostedKernelCall(spec, operation, () => {
        if (!context.alive())
          throw new Error("Run host publication unavailable");
        return work();
      }),
    );
  const record = hostedRunRecord(spec);
  const owner = await call("initial_owner_read", () =>
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
    const replaces =
      record.personalRepo && record.hostId && record.osSessionId
        ? {
            runKey: record.runKey,
            hostId: record.hostId,
            sessionId: record.osSessionId,
            binding: record.personalRepo,
          }
        : undefined;
    record.hostId = hostId;
    const successor = { ...record };
    await call("host_change_journal", () =>
      journalSet(successor, undefined, { replaces }),
    );
  });
  await call("initial_journal", () => journalSet(record));
  let sourceCompleted = false;
  let sawTerminal = false;
  try {
    for await (const ev of handle.events()) {
      const context = hostedEventPublication(ev) ?? handle.eventContext();
      if (context.consumer && context.consumer.hostId !== record.hostId)
        continue;
      const eventRecord = { ...record };
      let deliver = false;
      try {
        deliver =
          (await withHostedEventPublication(
            ev,
            async () => {
              const isCurrent = await call(
                "event_owner_read",
                () =>
                  sessionKernel(spec.osSessionId).isCurrentRunProjection(
                    record.runKey,
                  ),
                context,
              );
              if (
                !isCurrent ||
                !context.alive() ||
                record.hostId !== eventRecord.hostId
              ) {
                if (context.alive()) handle.requestCancel();
                audit({
                  msg: "stale_executor_event_rejected",
                  session_id: spec.osSessionId,
                  run_key: record.runKey,
                  event_type: ev.type,
                });
                return false;
              }
              if (
                ev.type === "init" &&
                ev.sessionId &&
                ev.sessionId !== record.claudeSessionId
              ) {
                eventRecord.claudeSessionId = ev.sessionId;
                await call(
                  "engine_session_journal",
                  () => journalSet(eventRecord),
                  context,
                );
              }
              if (ev.type === "model_switch" && ev.toModel) {
                eventRecord.model = ev.toModel;
                eventRecord.transientFallback = ev.temporaryFallback === true;
                if (shouldPersistModelSwitch(ev))
                  eventRecord.selectedModel = ev.toModel;
                await call(
                  "model_switch_journal",
                  () => journalSet(eventRecord),
                  context,
                );
              }
              if (record.hostId !== eventRecord.hostId || !context.alive())
                return false;
              Object.assign(record, eventRecord);
              if (ev.type === "done" || ev.type === "error") sawTerminal = true;
              return true;
            },
            !!spec.personalRepo,
          )) === true;
      } catch (error) {
        if (context.alive()) throw error;
      }
      if (deliver) yield ev;
    }
    sourceCompleted = true;
  } finally {
    if (
      handle.ended &&
      sourceCompleted &&
      (sawTerminal || handle.endedAfterCancellation)
    )
      await journalClearIfLineageAsync({ ...record });
    else if (handle.ended && sourceCompleted && handle.publicationCurrent())
      await call("abnormal_completion_journal", () =>
        journalRecordAbnormalCompletion(record),
      );
  }
}

function hostedRunRecord(spec: RunHostSpec): ActiveRunRecord {
  return {
    runKey: spec.personalRepo ? spec.logicalRunId! : spec.hostId,
    hostId: spec.hostId,
    osSessionId: spec.osSessionId,
    personalRepo: spec.personalRepo,
    claudeSessionId: spec.engineSessionId,
    prompt: spec.prompt,
    promptEntryId: spec.promptEntryId,
    cwd: spec.cwd,
    mode: spec.mode,
    mcpServers: spec.mcpServers,
    user: spec.user,
    accountUser: spec.accountUser,
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
    pstackMode: spec.pstackMode,
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
  lifetime?: HostedLifetimeControl,
): Promise<{ handle: HostHandle; spec: RunHostSpec }> {
  const hostId = opts.startToken || `rh-${Bun.randomUUIDv7()}`;
  const dir = `${HOSTS_DIR}/${hostId}`;
  // Reserve the run key before the first await (see activeHostedRunKeys).
  if (lifecycle === "session") activeHostedRunKeys.add(hostId);
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    if (lifecycle === "session") activeHostedRunKeys.delete(hostId);
    throw error;
  }

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
    personalRepo: opts.personalRepo,
    ...(opts.personalRepo ? { logicalRunId: hostId } : {}),
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
    accountUser: opts.accountUser,
    fallbackModel: opts.fallbackModel,
    accountAffinityKey: opts.accountAffinityKey,
    effort: opts.effort,
    fastMode: opts.fastMode,
    pstackMode: opts.pstackMode,
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
  try {
    if (spec.personalRepo) {
      await personalHostTransitions().publishSpec(consumerForSpec(spec), () =>
        import("node:fs/promises").then(({ writeFile }) =>
          writeFile(`${dir}/${HOST_SPEC_NAME}`, JSON.stringify(spec), {
            flag: "wx",
            mode: 0o600,
          }),
        ),
      );
      freshPersonalSpecs.add(spec);
      const c = consumerForSpec(spec);
      lifetime?.track(c);
      personalHostTransitions().remember(
        c,
        () => {},
        false,
        undefined,
        () => lifetime?.assertOpen(),
      );
    } else await writeJsonAtomicAsync(`${dir}/${HOST_SPEC_NAME}`, spec);
  } catch (error) {
    if (lifecycle === "session") activeHostedRunKeys.delete(hostId);
    throw error;
  }
  if (rpcToken)
    registerRunToken(rpcToken, {
      sessionId: opts.osSessionId,
      user: opts.user,
      humanPrompter: opts.accountUser,
      promptEntryId: opts.promptEntryId,
    });

  let handle: HostHandle | undefined;
  let launchCompleted = false;
  // Session-owned hosts enter the shared recovery journal (the key was
  // reserved above). Auxiliary workers are owned by their caller's workflow
  // journal instead: registering them as the parent session's physical run
  // would race its real run generation.
  try {
    if (spec.personalRepo)
      await registerPersonalRunConsumer(consumerForSpec(spec));
    if (lifecycle === "session") {
      // Persist before launch. If opensession restarts between systemd-run and
      // socket attachment, the boot sweep can still find the surviving host.
      await journalSet(hostedRunRecord(spec));
    }
    handle = new HostHandle(
      dir,
      spec,
      {
        onAskUser: opts.onAskUser,
        onEngineSession: opts.onEngineSession,
        onSteerFailed: opts.onSteerFailed,
      },
      systemdHostLauncher,
      spec.logicalRunId ?? spec.hostId,
      undefined,
      undefined,
      undefined,
      undefined,
      lifetime,
    );
    await handle.bindPublication();
    try {
      await launchHostUnit(hostId, dir);
    } catch (error) {
      if (!(error instanceof ExecutorProtocolError && error.ambiguousLaunch)) {
        throw error;
      }
      try {
        await handle.connectWithWait(120_000);
        return { handle, spec };
      } catch {
        throw error;
      }
    }
    launchCompleted = true;
    await handle.connectWithWait(20_000);
    return { handle, spec };
  } catch (cause) {
    let error = cause;
    if (launchCompleted) {
      try {
        if (spec.personalRepo)
          await personalHostTransitions().finishPhysical(
            consumerForSpec(spec),
            true,
          );
        else await stopAndVerifyHostAbsent(hostId, dir);
      } catch (cleanupError) {
        error = cleanupError;
      }
    }
    if (
      spec.personalRepo &&
      !(error instanceof ExecutorProtocolError && error.ambiguousLaunch)
    ) {
      try {
        const c = consumerForSpec(spec);
        await stopPersonalHostAndConfirm(c);
        await retirePersonalRunConsumer(c);
      } catch {
        error = new ExecutorProtocolError(
          "Personal failed launch cleanup remains uncertain",
          true,
        );
      }
    }
    if (!(error instanceof ExecutorProtocolError && error.ambiguousLaunch)) {
      if (lifecycle === "session") activeHostedRunKeys.delete(hostId);
      // The HostHandle ctor registered its host-registry control. Drop it only
      // after absence is proven; uncertain launches must remain visibly busy.
      handle?.abandon();
      if (lifecycle === "session")
        await journalClearIfLineageAsync(hostedRunRecord(spec));
      unregisterRunToken(rpcToken);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
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
  const specBytes = await readFile(`${dir}/${HOST_SPEC_NAME}`);
  const specHash = new Bun.CryptoHasher("sha256")
    .update(specBytes)
    .digest("hex");
  const spec = JSON.parse(specBytes.toString("utf8")) as RunHostSpec;
  if (Object.hasOwn(spec, "personalRepo")) {
    const {
      preparePersonalHostProjection,
      launchPersonalWithCleanup,
      PersonalLaunchUncertainError,
    } = await import("./personal-repo-runtime-host");
    try {
      const consumer = consumerForSpec(spec);
      await launchPersonalWithCleanup(spec, dir, specHash, {
        prepare: async () => {
          await personalHostTransitions().assertMayExecute(consumer);
          await verifyPersonalRunHostHelper();
          await preparePersonalHostProjection(spec, dir, specHash);
        },
        launch: () =>
          personalHostTransitions().dispatch(
            consumer,
            async () => {},
            async (finalHash) => {
              if (finalHash !== specHash)
                throw new Error("Personal spec changed during preparation");
              if (await launchHostViaExecutor(hostId, dir, { specHash }))
                return;
              noteExecutorFallback();
              await launchHostUnitDirect(hostId, dir, specHash);
            },
            process.env.OPENSESSION_EXECUTOR === "0",
          ),
        proveAbsent: async () => {
          if (!(await personalRunRetirementConfirmed(consumer)))
            await personalHostTransitions().finishPhysical(consumer, true);
        },
        ambiguous: (error) =>
          error instanceof ExecutorProtocolError && error.ambiguousLaunch,
      });
    } catch (error) {
      if (error instanceof PersonalLaunchUncertainError)
        throw new ExecutorProtocolError(error.message, true);
      throw error;
    }
    return;
  }
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
      const meta = await readJsonSafe<RunHostMeta>(`${dir}/${HOST_META_NAME}`);
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
 *  identical to the pre-seam inline code — the socket-presence guard preserves
 *  the old "poll for the socket file" cadence, and open/close/error map 1:1. */
function unixSocketConnector(sockPath: string): HostConnector {
  return {
    async connect(handlers: HostConnectionHandlers): Promise<HostConnection> {
      try {
        await access(sockPath);
      } catch {
        throw new Error(`socket ${sockPath} not present yet`);
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
export const systemdHostLauncher: HostLauncher = {
  async alive(dir, meta) {
    meta ??= await readJsonSafe<RunHostMeta>(`${dir}/${HOST_META_NAME}`);
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
  async evidence(dir) {
    const meta = await readJsonSafe<RunHostMeta>(`${dir}/${HOST_META_NAME}`);
    const privateRun = await readHostJournal(dir);
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

interface HostObservation {
  /** The handle ended (from this observation or any earlier path). */
  ended: boolean;
  /** The host still lives (or a live connection owns the fence). */
  alive: boolean;
  /** For an absent host: its identity-checked metadata, if any. */
  meta: RunHostMeta | null;
}

export interface HandleCallbacks {
  onAskUser?: RunAgentOpts["onAskUser"];
  onEngineSession?: (engineSessionId: string) => void;
  onSteerFailed?: (text: string) => void;
}

export class HostHandle {
  private queue = new AsyncEventQueue();
  private publicationSetup?: Promise<void>;
  private readonly publicationRejections = new WeakSet<HostPublication>();
  private readonly publications = new Map<string, HostPublication>();
  private readonly eventContexts = new WeakMap<
    HostPublication,
    HostedEventPublication
  >();
  private readonly publicationSource: HostPublicationSource;
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
  /** Bumped by every respawn. Evidence read against an older generation is
   *  about a host this handle no longer owns and is rejected. */
  private hostGeneration = 0;
  /** Latest connect attempt; older attempts that settle late are obsolete. */
  private connectAttempt = 0;
  private terminalObservation?: Promise<HostObservation>;
  private readonly finalized = Promise.withResolvers<void>();
  private stopRequested = false;
  /** A stopAndWait is proving the host absent; no successor may be launched. */
  private stopping = false;
  /** A respawn's `launcher.launch` that has started and not yet settled. A
   *  stop must not report the host absent while this can still create it. */
  private dispatching?: Promise<void>;
  private cancelledCompletion = false;
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
    private readonly logicalRunId: string = spec.personalRepo
      ? (spec.logicalRunId ?? spec.hostId)
      : spec.hostId,
    private readonly cancelGraceMs = 5_000,
    private readonly reconnectDelayMs = HOST_RECONNECT_DELAY_MS,
    private readonly connectAttemptTimeoutMs = CONNECT_ATTEMPT_TIMEOUT_MS,
    private publication?: HostPublication,
    private readonly lifetime?: HostedLifetimeControl,
  ) {
    assertPersonalHostLineage(spec);
    assertPersonalHostMcpNone(spec);
    if (spec.personalRepo && spec.logicalRunId !== logicalRunId)
      throw new Error("Personal logical lineage mismatch");
    this.publicationSource = {
      osSessionId: spec.osSessionId,
      cwd: spec.cwd,
      hostId: spec.hostId,
      logicalRunId: spec.logicalRunId,
      personalRepo: spec.personalRepo && structuredClone(spec.personalRepo),
    };
    if (publication) this.publications.set(spec.hostId, publication);
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
      ended: () => this.endedClean,

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
    if (spec.personalRepo && launcher === systemdHostLauncher) {
      const c = consumerForSpec(spec);
      personalHostTransitions().remember(
        c,
        () => this.retireStoppedConsumer(c),
        !freshPersonalSpecs.delete(spec),
        () => this.invalidatePublications(),
        () => this.lifetime?.assertOpen(),
      );
    }
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

  private currentPersonalConsumer(): PersonalRunConsumer | undefined {
    if (!this.publicationSource.personalRepo) return;
    return {
      runKey: this.logicalRunId,
      hostId: this.ctl.hostId,
      sessionId: this.publicationSource.osSessionId,
      binding: this.publicationSource.personalRepo,
    };
  }
  private invalidatePublications(): void {
    for (const publication of this.publications.values()) publication.abort();
  }
  private retireStoppedConsumer(c: PersonalRunConsumer): void {
    if (
      this.logicalRunId === c.runKey &&
      this.publicationSource.osSessionId === c.sessionId &&
      this.publicationSource.personalRepo &&
      samePersonalRepoBinding(this.publicationSource.personalRepo, c.binding)
    ) {
      for (const publication of this.publications.values()) publication.abort();
    }
    if (
      this.ctl.hostId !== c.hostId ||
      this.logicalRunId !== c.runKey ||
      this.publicationSource.osSessionId !== c.sessionId ||
      !this.publicationSource.personalRepo ||
      !samePersonalRepoBinding(this.publicationSource.personalRepo, c.binding)
    )
      return;
    this.stopRequested = true;
    this.stopping = true;
    this.cancelledCompletion = true;
    this.abandon(); // no model/source callbacks and no broker work
  }
  private async assertNotRetired(): Promise<void> {
    if (this.publicationSource.personalRepo) {
      this.lifetime?.assertOpen();
      if (this.launcher === systemdHostLauncher) assertPersonalHostState();
    }
    const c = this.currentPersonalConsumer();
    if (c && (await this.withPublication(() => personalRunRetired(c))))
      throw new Error("Personal logical run retired");
  }

  /** One admission for this producer, never renewed by reconnect or respawn. */
  async bindPublication(): Promise<void> {
    if (this.publication) return;
    this.publicationSetup ??= this.assertNotRetired()
      .then(() => bindHostPublication(this.publicationSource))
      .then((publish) => {
        this.publication = publish;
        this.publications.set(publish.source.hostId, publish);
      });
    await this.publicationSetup;
  }

  withPublication<T>(work: () => T, publication = this.publication): T {
    if (!publication) return work(); // legacy shared callers only
    let result!: T;
    publication(() => {
      result = work();
    });
    return result;
  }

  /** Synchronous original-source fence, including queued consumer work. */
  publicationCurrent(publication = this.publication): boolean {
    if (
      (!publication && this.publicationSource.personalRepo) ||
      publication?.signal.aborted
    )
      return false;
    let allowed = false;
    this.withPublication(() => {
      allowed = sessionPublicationAllowed(this.publicationSource.osSessionId);
    }, publication);
    return allowed;
  }

  eventContext(publication = this.publication): HostedEventPublication {
    const existing = publication && this.eventContexts.get(publication);
    if (existing) return existing;
    const context = publication
      ? hostPublicationContext(publication)
      : Object.freeze({
          personal: !!this.publicationSource.personalRepo,
          alive: () => this.publicationCurrent(publication),
          run: <T>(work: () => T) => this.withPublication(work, publication),
        });
    if (publication) this.eventContexts.set(publication, context);
    return context;
  }
  tagEvent(event: StreamEvent, publication = this.publication): StreamEvent {
    if (!this.publicationSource.personalRepo || hostedEventPublication(event))
      return event;
    return tagHostedEvent(event, this.eventContext(publication));
  }
  private pushEvent(event: StreamEvent, publication = this.publication): void {
    const context = this.eventContext(publication);
    if (context.alive())
      this.queue.push(
        context.personal ? tagHostedEvent(event, context) : event,
      );
  }

  async *events(): AsyncGenerator<StreamEvent> {
    for await (const event of this.queue) {
      if (
        !this.publicationSource.personalRepo ||
        hostedEventPublication(event)?.alive()
      )
        yield event;
    }
  }

  /** True once the run reached its clean end (terminal consumed, or the host
   *  reported a quiet cancel): the journal-clear condition for hosted runs. */
  get ended(): boolean {
    return this.endedClean;
  }

  takeObservedTerminal(): StreamEvent | undefined {
    const terminal = this.terminalEvent;
    this.terminalEvent = undefined;
    return terminal &&
      (!this.publicationSource.personalRepo ||
        hostedEventPublication(terminal)?.alive())
      ? terminal
      : undefined;
  }

  /** Resolves once the handle finished or was abandoned and its run-dir
   *  cleanup (if any) settled. */
  whenFinalized(): Promise<void> {
    return this.finalized.promise;
  }

  /**
   * Observe a terminal receipt the host left in meta.json after the live
   * socket was lost, and finish the handle from it. Resolves true once the
   * handle has ended (from this receipt or any earlier path). This is the
   * same observation the disconnect loop runs each iteration, so a host that
   * finishes while detached is noticed without any caller asking; there is no
   * second, differently-authorized completion path. Registry busy/steer
   * checks never call this: they read cached state only.
   */
  async observeOfflineTerminal(): Promise<boolean> {
    return (await this.observeHost()).ended;
  }

  /**
   * One fenced observation of the owned host: a metadata read feeding the
   * liveness check, and only for a positively absent host a fresh read of the
   * receipt it may have written while exiting, accepted through the
   * projection-serialized finalization. A live host is never completed from
   * disk (its connected catch-up is the only fence) and a live connection
   * owns the terminal fence outright. Deduped: concurrent callers share one
   * in-flight observation.
   */
  private observeHost(): Promise<HostObservation> {
    if (this.endedClean)
      return Promise.resolve({ ended: true, alive: false, meta: null });
    if (!this.terminalObservation) {
      const owned = this.captureOwnership();
      const moved = () => this.endedClean || this.ownershipMoved(owned);
      const observation: Promise<HostObservation> = (async () => {
        await this.bindPublication();
        const publication = this.publication;
        const standDown = (): HostObservation => ({
          ended: this.endedClean,
          alive: true,
          meta: null,
        });
        if (this.up) return standDown();
        const probe = await this.readMeta();
        if (moved()) return standDown();
        const alive = await this.launcher.alive(this.dir, probe);
        if (moved()) return standDown();
        if (alive) return { ended: false, alive: true, meta: null };
        // Positively absent. Re-read: the receipt may have landed between the
        // probe and the liveness check. Metadata about another host id is not
        // evidence about this one.
        let meta = await this.readMeta();
        if (moved()) return standDown();
        if (meta?.hostId && meta.hostId !== owned.hostId) meta = null;
        const ended = await this.acceptOfflineTerminal(
          meta,
          owned,
          publication,
        );
        return { ended, alive: false, meta };
      })().finally(() => {
        if (this.terminalObservation === observation)
          this.terminalObservation = undefined;
      });
      this.terminalObservation = observation;
    }
    return this.terminalObservation;
  }

  private captureOwnership(): { hostId: string; generation: number } {
    return { hostId: this.ctl.hostId, generation: this.hostGeneration };
  }

  /** True when evidence captured under `owned` no longer describes the host
   *  this handle drives, or a live connection took over meanwhile. */
  private ownershipMoved(owned: { hostId: string; generation: number }) {
    return (
      this.up ||
      this.hostGeneration !== owned.generation ||
      this.ctl.hostId !== owned.hostId
    );
  }

  private async readMeta(): Promise<RunHostMeta | null> {
    const hostId = this.ctl.hostId;
    const meta = await readJsonSafe<RunHostMeta>(
      `${this.dir}/${HOST_META_NAME}`,
    );
    if (
      this.publicationSource.personalRepo &&
      meta &&
      (meta.hostId !== hostId ||
        meta.osSessionId !== this.publicationSource.osSessionId)
    )
      return null;
    return meta;
  }

  private acceptTerminal(
    done: StreamEvent,
    publication = this.publication,
  ): void {
    if (this.sawTerminal || !this.publicationCurrent(publication)) return;
    this.sawTerminal = true;
    this.terminalEvent = this.publicationSource.personalRepo
      ? tagHostedEvent(done, this.eventContext(publication))
      : done;
    this.pushEvent(done, publication);
  }

  /**
   * Finish from an offline terminal receipt. Terminal metadata proves the host
   * finished, not that every projection it forwarded landed: finalization is
   * serialized behind the transcript frames already accepted, and still runs
   * after a projection failure so the stream closes (the failure was already
   * reported as an error event). Evidence about a replaced host or one whose
   * connection came back meanwhile is rejected.
   */
  private async acceptOfflineTerminal(
    meta: RunHostMeta | null,
    owned: { hostId: string; generation: number },
    publication = this.publication,
  ): Promise<boolean> {
    if (this.endedClean) return true;
    const done = meta?.done;
    if (!done) return false;
    if (this.ownershipMoved(owned)) return false;
    if (meta.hostId && meta.hostId !== owned.hostId) return false;
    await new Promise<void>((resolve) =>
      this.enqueueProjectionFrame(
        () => {
          if (!this.endedClean && !this.ownershipMoved(owned)) {
            if (!this.publicationCurrent(publication))
              this.cancelledCompletion = true;
            this.acceptTerminal(done, publication);
            this.finish();
          }
          resolve();
        },
        true,
        publication,
      ),
    );
    return this.endedClean;
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

  /** Whether this host ended quietly in response to Stop. */
  get endedAfterCancellation(): boolean {
    return this.cancelledCompletion;
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
    await this.bindPublication();
    const publication = this.publication;
    if (this.launcher.evidence) {
      const evidence = await this.launcher.evidence(this.dir);
      return this.publicationCurrent(publication)
        ? {
            ...evidence,
            ...(evidence.done
              ? { done: this.tagEvent(evidence.done, publication) }
              : {}),
          }
        : { started: evidence.started };
    }
    const meta = await this.readMeta();
    if (!this.publicationCurrent(publication)) return { started: !!meta?.pid };
    return {
      started: !!meta?.pid,
      ...(meta?.engineSessionId
        ? { engineSessionId: meta.engineSessionId }
        : {}),
      ...(meta?.done ? { done: this.tagEvent(meta.done, publication) } : {}),
    };
  }

  /**
   * Cooperative cancel, then prove the host absent. From the first line no
   * successor may be launched (`stopping` blocks respawn), and the stop is
   * fenced on the exact host and generation it targeted: finalization only
   * follows a stop that proved the host this handle still owns absent.
   */
  async stopAndWait(
    timeoutMs = 10_000,
    preserveEvidence = false,
  ): Promise<boolean> {
    if (this.ended) return true;
    const personal = this.currentPersonalConsumer();
    if (personal && this.launcher === systemdHostLauncher) {
      try {
        await stopPersonalHostAndConfirm(personal);
        await retirePersonalRunConsumer(personal);
        if (!preserveEvidence)
          await rm(`${HOSTS_DIR}/${personal.hostId}`, {
            recursive: true,
            force: true,
          });
        return true;
      } catch {
        return false;
      }
    }
    this.stopping = true;
    this.send({ t: "cancel" });
    const deadline = Date.now() + timeoutMs;
    while (!this.ended && Date.now() < deadline) await Bun.sleep(50);
    if (this.ended) return true;
    if (!this.launcher.stop) return false;
    try {
      if (await this.stopOwnedHost()) return true;
      if (preserveEvidence) this.abandon();
      else this.finish();
      return true;
    } catch (error) {
      console.error(`[host-client] could not stop ${this.ctl.hostId}:`, error);
      return false;
    }
  }

  /**
   * Stop the host this handle owns right now and prove it absent. Returns true
   * when the handle ended meanwhile (nothing left to finalize). If ownership
   * moved to a successor while the stop was in flight, the successor is the
   * live host and is stopped too; respawn refuses to start once a stop is
   * requested, so this settles after at most one extra round. Throws when a
   * stop could not prove absence.
   */
  private async stopOwnedHost(): Promise<boolean> {
    for (;;) {
      if (this.endedClean) return true;
      // A launch already dispatched for the owned host may still materialize
      // it: proving absence before that settles would finalize a handle whose
      // host then appears with no owner.
      while (this.dispatching) {
        await this.dispatching;
        if (this.endedClean) return true;
      }
      const owned = this.captureOwnership();
      const dir = this.dir;
      await this.launcher.stop!(owned.hostId, dir);
      if (this.endedClean) return true;
      if (
        this.hostGeneration === owned.generation &&
        this.ctl.hostId === owned.hostId
      )
        return false;
      console.warn(
        `[host-client] ${owned.hostId} stopped but ownership moved to ${this.ctl.hostId}; stopping the successor too`,
      );
    }
  }

  private cancelHost(): boolean {
    if (this.endedClean || this.stopRequested) return true;
    const personal = this.currentPersonalConsumer();
    if (personal && this.launcher === systemdHostLauncher) {
      this.stopRequested = true;
      this.send({ t: "cancel" });
      void stopPersonalHostAndConfirm(personal)
        .then(async () => {
          await retirePersonalRunConsumer(personal);
          await rm(`${HOSTS_DIR}/${personal.hostId}`, {
            recursive: true,
            force: true,
          });
        })
        .catch(() => {
          this.stopRequested = false;
        });
      return true;
    }
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
        if (await this.stopOwnedHost()) return;
        this.cancelledCompletion = true;
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
    await this.bindPublication();
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown = null;
    let attempts = 0;
    for (;;) {
      attempts++;
      try {
        // Every attempt is bounded (see connectOnce): a connector whose
        // promise never settles must not freeze the whole wait loop silently.
        await this.connectOnce();
        return;
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

  /**
   * One bounded connect attempt against the host this handle owns now. The
   * attempt is fenced by its sequence number and the captured host identity:
   * a connection that settles after the deadline, after a newer attempt, after
   * a respawn, or after the handle ended is closed instead of adopted, and its
   * callbacks are ignored. Frames delivered while the connector is still
   * establishing (an ended hello sent before the promise resolves) belong to
   * the current attempt and are handled as before.
   */
  private async connectOnce(): Promise<void> {
    await this.assertNotRetired();
    await this.bindPublication();
    await this.assertNotRetired();
    if (!this.publicationCurrent())
      throw new Error("Run host publication unavailable");
    const attempt = ++this.connectAttempt;
    const owned = this.captureOwnership();
    const connector = this.connector;
    let adopted: HostConnection | null = null;
    let obsolete = false;
    const stale = () =>
      obsolete ||
      this.endedClean ||
      this.hostGeneration !== owned.generation ||
      this.ctl.hostId !== owned.hostId ||
      (adopted ? this.conn !== adopted : this.connectAttempt !== attempt);
    const publication = this.publication;
    const connecting = connector.connect({
      onMsg: (m) => {
        if (stale()) return;
        this.handleMsg(m, publication);
      },
      onClose: () => {
        if (stale()) return;
        if (!adopted) {
          // Closed while still establishing: whatever this attempt resolves
          // to is already dead and must never be adopted. The attempt fails
          // and its caller's loop keeps observing and reconnecting.
          obsolete = true;
          return;
        }
        this.up = false;
        this.conn = null;
        this.withPublication(() => {
          void this.onDisconnect();
        }, publication);
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(
        () => resolve("timeout"),
        this.connectAttemptTimeoutMs,
      );
    });
    const closeLate = () => {
      obsolete = true;
      void connecting.then((conn) => conn.close()).catch(() => {});
    };
    let conn: HostConnection;
    try {
      const result = await Promise.race([connecting, timedOut]);
      if (result === "timeout") {
        closeLate();
        console.warn(
          `[host-client] ${owned.hostId.slice(0, 11)}: connect attempt ${attempt} stalled >${this.connectAttemptTimeoutMs}ms`,
        );
        throw new Error(
          `connect attempt stalled >${this.connectAttemptTimeoutMs}ms (promise never settled)`,
        );
      }
      conn = result;
    } catch (e) {
      // A rejected attempt owns nothing: its late callbacks are ignored.
      obsolete = true;
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (this.endedClean) {
      // The host finished while the transport was still establishing (an
      // `end` frame delivered before the connect promise settled): nothing
      // left to attach to.
      obsolete = true;
      conn.close();
      return;
    }
    if (stale()) {
      obsolete = true;
      conn.close();
      throw new Error(
        "connect attempt superseded or closed before it was adopted",
      );
    }
    adopted = conn;
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

  private rejectPublication(publication = this.publication): void {
    if (publication) {
      if (
        publication.source.personalRepo &&
        publication.source.hostId !== this.ctl.hostId
      )
        return;
      if (this.publicationRejections.has(publication)) return;
      this.publicationRejections.add(publication);
    }
    this.requestCancel();
  }

  private acceptsSideEffectFrame(
    frameType: string,
    publication = this.publication,
  ): boolean {
    if (!this.publicationCurrent(publication)) {
      this.rejectPublication(publication);
      return false;
    }
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
    publication = this.publication,
  ): void {
    const prior = this.projectionTail ?? Promise.resolve();
    const current = prior.then(async () => {
      if (this.projectionFailure && !runAfterFailure)
        throw this.projectionFailure;
      let result: void | Promise<void> = undefined;
      this.withPublication(() => {
        result = operation();
      }, publication);
      await result;
    });
    const observed = current.catch((error) => {
      if (!this.projectionFailure) {
        this.projectionFailure = error;
        this.pushEvent(
          {
            type: "error",
            content: `Run host projection failed: ${error instanceof Error ? error.message : String(error)}`,
          },
          publication,
        );
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

  private deferEndedHelloFinish(publication = this.publication): void {
    this.pendingEndedHello = true;
    if (this.endedHelloFallback) clearTimeout(this.endedHelloFallback);
    this.endedHelloFallback = setTimeout(() => {
      this.endedHelloFallback = undefined;
      // Older hosts have no catchup_complete marker. Their socket replay is
      // synchronous, so an idle window after the last transcript frame is the
      // compatibility fence. Still serialize cleanup behind every projection
      // received before that window closed. A frame arriving while those
      // projections drain re-arms the timer and cancels this cleanup attempt.
      this.enqueueProjectionFrame(
        () => {
          if (
            publication?.source.personalRepo &&
            publication.source.hostId !== this.ctl.hostId
          )
            return;
          if (this.pendingEndedHello && !this.endedHelloFallback) {
            if (!this.publicationCurrent(publication))
              this.cancelledCompletion = true;
            this.finish();
          }
        },
        true,
        publication,
      );
    }, ENDED_HELLO_CATCHUP_FALLBACK_MS);
  }

  private clearEndedHelloFallback(): void {
    if (this.endedHelloFallback) clearTimeout(this.endedHelloFallback);
    this.endedHelloFallback = undefined;
    this.pendingEndedHello = false;
  }

  /** Revocation fences data, not positively proven physical completion.
   * A live replay's catchup_complete is NOT an ended-host receipt. */
  private discardUnpublishedFrame(
    msg: HostToClientMsg,
    publication = this.publication,
  ): boolean {
    if (this.publicationCurrent(publication)) return false;
    this.rejectPublication(publication);
    if (
      publication?.source.personalRepo &&
      publication.source.hostId !== this.ctl.hostId
    )
      return true;
    if (msg.t === "hello" && msg.state === "ended") {
      this.deferEndedHelloFinish(publication);
    } else if (
      msg.t === "end" ||
      (msg.t === "catchup_complete" && this.pendingEndedHello)
    ) {
      this.cancelledCompletion = true;
      this.finish();
    }
    return true;
  }

  private handleMsg(
    msg: HostToClientMsg,
    publication = this.publication,
  ): void {
    this.withPublication(
      () => this.handlePublishedMsg(msg, publication),
      publication,
    );
  }

  private handlePublishedMsg(
    msg: HostToClientMsg,
    publication = this.publication,
  ): void {
    if (this.discardUnpublishedFrame(msg, publication)) return;
    if (msg.t === "transcript" && this.pendingEndedHello) {
      this.deferEndedHelloFinish(publication);
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
      this.enqueueProjectionFrame(
        () => this.handleMsgNow(msg, publication),
        cleanupFrame,
        publication,
      );
      return;
    }
    this.handleMsgNow(msg, publication);
  }

  private handleMsgNow(
    msg: HostToClientMsg,
    publication = this.publication,
  ): void {
    if (this.discardUnpublishedFrame(msg, publication)) return;
    if (
      msg.t !== "transcript" &&
      publication?.source.personalRepo &&
      publication.source.hostId !== this.ctl.hostId
    )
      return;
    switch (msg.t) {
      case "hello": {
        if (!this.acceptsSideEffectFrame("hello", publication)) break;
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
          this.pushEvent(
            {
              type: "model_switch",
              fromModel,
              toModel: msg.selectedModel,
              switchReason: "out of credits",
              temporaryFallback: false,
            },
            publication,
          );
        }
        this.connectedBefore = true;
        if (
          msg.pendingAsks?.length &&
          this.acceptsSideEffectFrame("hello.pendingAsks", publication)
        )
          for (const ask of msg.pendingAsks)
            this.handleAsk(ask.askId, ask.input, publication);
        if (msg.state === "ended") {
          if (msg.done) this.acceptTerminal(msg.done, publication);
          // A detached host sends hello before replaying transcript frames.
          // Finishing here closes the socket and discards summaries produced
          // while the gateway was down. catchup_complete is the exact fence;
          // the timer only supports hosts from before that frame existed.
          this.deferEndedHelloFinish(publication);
        }
        break;
      }
      case "event": {
        const ev = msg.event;
        if (!this.acceptsSideEffectFrame(`event:${ev.type}`, publication))
          break;
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
          this.terminalEvent = this.publicationSource.personalRepo
            ? tagHostedEvent(ev, this.eventContext(publication))
            : ev;
        }
        this.pushEvent(ev, publication);
        break;
      }
      case "ask":
        if (this.acceptsSideEffectFrame("ask", publication))
          this.handleAsk(msg.askId, msg.input, publication);
        break;
      case "transcript":
        // Transcript frames bypass the StreamEvent queue, so fence them here
        // against the same run generation as ordinary host events.
        if (!this.acceptsSideEffectFrame("transcript", publication)) break;
        this.enqueueProjectionFrame(
          () => {
            if (!this.acceptsSideEffectFrame("transcript", publication)) return;
            const lines = this.alignSteerTranscriptIds(msg.lines);
            if (this.spec.transcriptTarget === "none") return;
            return this.spec.transcriptTarget === "engine"
              ? appendTranscriptEntries(msg.engineSessionId, lines)
              : applyForwardedTranscriptStrict(
                  this.spec.osSessionId,
                  msg.engineSessionId,
                  lines,
                );
          },
          false,
          publication,
        );
        break;
      case "steer_failed":
        if (this.acceptsSideEffectFrame("steer_failed", publication)) {
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
        if (!msg.done && this.stopRequested) this.cancelledCompletion = true;
        if (msg.done) this.acceptTerminal(msg.done, publication);
        this.finish();
        break;
      }
      case "catchup_complete":
        if (this.pendingEndedHello) this.finish();
        break;
    }
  }

  private handleAsk(
    askId: string,
    input: Record<string, unknown>,
    publication = this.publication,
  ): void {
    // A reconnect re-delivers pending asks in hello — don't double-handle ones
    // this process is already blocking a human on.
    const key = publication?.source.personalRepo
      ? `${publication.source.hostId}:${askId}`
      : askId;
    if (this.handlingAsks.has(key)) return;
    this.handlingAsks.add(key);
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
      this.handlingAsks.delete(key);
      if (
        !this.acceptsSideEffectFrame("ask_answer", publication) ||
        (publication?.source.personalRepo &&
          publication.source.hostId !== this.ctl.hostId)
      )
        return;
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
    if (this.publicationSource.personalRepo) this.publication?.abort();
    if (this.endedClean) return;
    this.endedClean = true;
    this.clearEndedHelloFallback();
    this.queue.end();
    this.settleSteerRetractions();
    unregisterHostRun(this.ctl);
    unregisterRunToken(this.spec.rpcToken);
    this.connector.dispose?.();
    this.finalized.resolve();
  }

  /** Clean end: ack the host, close out the generator, drop registrations +
   *  files. The registry sees `ended()` synchronously; the run-dir removal is
   *  asynchronous and idempotent (`whenFinalized` settles after it). */
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
    if (this.publicationSource.personalRepo) {
      // Caller-owned completion acknowledgement follows all post-loop writes.
      this.finalized.resolve();
      return;
    }
    void rm(this.dir, { recursive: true, force: true })
      .catch(() => {})
      .finally(() => this.finalized.resolve());
  }

  /**
   * Socket dropped without a clean end. Each bounded iteration runs one host
   * observation (see observeHost) and, while the host lives, one bounded
   * reconnect attempt: a live host's ended hello plus transcript catch-up is
   * the only completion fence, and an unreachable live host stays busy with
   * its receipt unread (a broken transport is not proof that the catch-up is
   * undrainable; it can recover, or the host exits). Once the host is
   * positively absent the observation has already consumed any receipt it
   * left; otherwise a crashed host is respawned to resume the run, or the
   * failure is reported. Nothing else has to ask for a finished detached host
   * to be noticed. Every await re-checks the ownership this loop holds (its
   * own reserved replacement after a respawn) so an external finish,
   * reconnect, or takeover makes it stand down.
   */
  private async onDisconnect(): Promise<void> {
    let owned = this.captureOwnership();
    const standDown = () => this.endedClean || this.ownershipMoved(owned);
    let meta: RunHostMeta | null = null;
    for (;;) {
      await Bun.sleep(this.reconnectDelayMs);
      if (standDown()) return;
      const observed = await this.observeHost();
      if (observed.ended || standDown()) return;
      if (!observed.alive) {
        meta = observed.meta;
        break;
      }
      try {
        await this.connectOnce();
        return;
      } catch {}
      if (standDown()) return;
    }
    // A stop is proving this host absent and owns finalization (finish or
    // evidence-preserving abandon); a crashed host must not be resumed under
    // its feet.
    if (this.stopping) return;

    // Crashed mid-run. If the run had an engine session, respawn a fresh host
    // to resume it — transparent to whoever is consuming events().
    const journal = await readHostJournal(this.dir);
    if (standDown() || this.stopping) return;
    const engineId =
      journal?.claudeSessionId ||
      this.engineSessionId ||
      this.spec.engineSessionId;
    if (engineId && this.respawns < 2 && !this.stopRequested) {
      this.respawns++;
      console.warn(
        `[host-client] run host ${this.spec.hostId} died mid-run — respawning to resume ${this.spec.osSessionId}`,
      );
      try {
        // The replacement this loop reserves is its own ownership from then
        // on: a failed launch must still reach the ambiguity/error handling
        // below instead of looking like an external takeover.
        await this.respawn(engineId, meta, (reserved) => {
          owned = reserved;
        });
        return;
      } catch (e) {
        if (standDown() || this.stopping) return;
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
            this.pushEvent({
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
    this.pushEvent({
      type: "error",
      content: "Run host process died unexpectedly and could not be resumed.",
    });
    this.finish();
  }

  /**
   * Replace a dead host with a fresh one resuming the same engine session.
   * Ownership of the replacement (host id, run dir, generation) is reserved
   * synchronously before the first await, so a cancel or stop that lands while
   * the spec is being exported or the host launched targets the successor and
   * finishes the handle exactly once. Every awaited step re-checks that the
   * handle still owns the replacement and is not ending; otherwise the
   * replacement is torn down (proved absent when already launched) and the
   * respawn fails instead of leaving an unregistered host running.
   */
  private async respawn(
    engineId: string,
    meta?: RunHostMeta | null,
    onReserved?: (owned: { hostId: string; generation: number }) => void,
  ): Promise<void> {
    if (
      this.endedClean ||
      this.stopRequested ||
      this.stopping ||
      !this.publicationCurrent()
    )
      throw new Error(
        "respawn refused: handle is ending or publication expired",
      );
    await this.assertNotRetired();
    if (this.endedClean || this.stopRequested || this.stopping)
      throw new Error("Personal respawn superseded");
    const oldConsumer = this.currentPersonalConsumer();
    const oldPublication = this.publication;
    const oldProjections = this.projectionTail;
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
    // Reserve the replacement before the first await. Evidence captured
    // against the old host is stale from here on, and a concurrent stop
    // targets the successor.
    this.hostGeneration++;
    const generation = this.hostGeneration;
    this.dir = dir;
    this.spec = spec;
    this.connectedBefore = false;
    this.effectiveModel = spec.model;
    this.transientFallback = spec.transientFallback === true;
    this.ctl.hostId = hostId;
    onReserved?.({ hostId, generation });
    const lost = () =>
      !this.publicationCurrent() ||
      this.endedClean ||
      this.stopRequested ||
      this.stopping ||
      this.hostGeneration !== generation ||
      this.ctl.hostId !== hostId;
    const refuse = async (stage: string, launched: boolean) => {
      if (launched) {
        // Whoever is stopping this handle targets this host id too; proving
        // absence twice is idempotent.
        if (spec.personalRepo && this.launcher === systemdHostLauncher)
          await personalHostTransitions().finishPhysical(
            consumerForSpec(spec),
            true,
          );
        else await (this.launcher.stop ?? stopAndVerifyHostAbsent)(hostId, dir);
      } else {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      throw new Error(`respawn abandoned after ${stage}: handle is ending`);
    };

    if (this.launcher.writeSpec) {
      await this.launcher.writeSpec(dir, spec);
    } else {
      await mkdir(dir, { recursive: true });
      if (spec.personalRepo && this.launcher === systemdHostLauncher)
        await personalHostTransitions().publishSpec(consumerForSpec(spec), () =>
          import("node:fs/promises").then(({ writeFile }) =>
            writeFile(`${dir}/${HOST_SPEC_NAME}`, JSON.stringify(spec), {
              flag: "wx",
              mode: 0o600,
            }),
          ),
        );
      else await writeJsonAtomicAsync(`${dir}/${HOST_SPEC_NAME}`, spec);
    }
    if (oldConsumer && this.launcher === systemdHostLauncher) {
      const next = this.currentPersonalConsumer()!;
      personalHostTransitions().remember(
        next,
        () => this.retireStoppedConsumer(next),
        false,
        () => this.invalidatePublications(),
        () => this.lifetime?.assertOpen(),
      );
    }
    if (lost()) await refuse("spec export", false);
    const nextConsumer = this.currentPersonalConsumer();
    if (nextConsumer) {
      this.lifetime?.track(nextConsumer);
      if (this.launcher === systemdHostLauncher)
        await this.withPublication(() =>
          registerPersonalRunConsumer(nextConsumer),
        );
    }
    await this.withPublication(() => this.onHostChanged?.(hostId));
    if (
      oldConsumer &&
      oldPublication &&
      this.launcher === systemdHostLauncher
    ) {
      await oldProjections;
      const successor = await bindHostPublicationSuccessor(
        oldPublication,
        spec,
      );
      this.publication = successor;
      this.publications.set(hostId, successor);
      oldPublication.abort();
      await personalHostTransitions().finishPhysical(oldConsumer);
      await confirmPersonalRunPhysicalCompletion(oldConsumer);
      personalHostTransitions().forget(oldConsumer);
    }
    await this.assertNotRetired();
    if (lost()) await refuse("host change", false);
    // The old host id's transport registration (WS token/conn) is dead with
    // the old host — swap in a connector for the new id (same wsToken; the
    // launcher re-registered it under the new host id in launch()).
    this.connector.dispose?.();
    this.connector =
      this.launcher.connector?.(dir, spec) ??
      unixSocketConnector(`${dir}/${HOST_SOCK_NAME}`);
    // Expose the dispatch so a concurrent stop waits for it to settle before
    // proving this host absent (see stopOwnedHost).
    if (this.publicationSource.personalRepo) this.lifetime?.assertOpen();
    const dispatch = this.withPublication(() =>
      this.launcher.launch(hostId, dir),
    );
    const settled = dispatch.then(
      () => {},
      () => {},
    );
    this.dispatching = settled;
    try {
      await dispatch;
    } finally {
      if (this.dispatching === settled) this.dispatching = undefined;
    }
    if (lost()) await refuse("launch", true);
    await rm(oldDir, { recursive: true, force: true }).catch(() => {});
    try {
      await this.connectWithWait(20_000);
    } catch (cause) {
      try {
        if (spec.personalRepo && this.launcher === systemdHostLauncher)
          await personalHostTransitions().finishPhysical(
            consumerForSpec(spec),
            true,
          );
        else await (this.launcher.stop ?? stopAndVerifyHostAbsent)(hostId, dir);
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
        yield handle.tagEvent({
          type: "error",
          content:
            evidence.started || finalEvidence.started
              ? `${label} may have executed before it was stopped. Recovery evidence was retained.`
              : `${label} was not observed and its process was stopped.`,
        });
        return;
      }
      if (!reportedUncertain) {
        reportedUncertain = true;
        yield handle.tagEvent({
          type: "runner_notice",
          text: `${label} launch outcome remains uncertain. Recovery ownership was retained.`,
        });
      }
      console.warn(`[host-client] ${label} remains uncertain:`, error);
      deadline = Date.now() + 60_000;
    }
  }
}

async function readJsonSafe<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function readHostJournal(dir: string): Promise<ActiveRunRecord | null> {
  const j = await readJsonSafe<Record<string, ActiveRunRecord>>(
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
export function resumeLocalHostRun(
  run: ActiveRunRecord,
  callbacks: HandleCallbacks,
): Promise<AsyncGenerator<StreamEvent> | "uncertain" | null> {
  const lifetime = privateLifetime(
    run.personalRepo
      ? {
          runKey: run.runKey,
          sessionId: run.osSessionId!,
          binding: run.personalRepo,
        }
      : undefined,
  );
  if (run.personalRepo && run.hostId)
    lifetime.track({
      runKey: run.runKey,
      hostId: run.hostId,
      sessionId: run.osSessionId!,
      binding: run.personalRepo,
    });
  const pending = resumeLocalHostRunInner(run, callbacks, lifetime).then(
    (result) => {
      if (result && typeof result === "object")
        attachHostedRunLifetime(result, lifetime.api);
      return result;
    },
  );
  return attachHostedRunLifetime(pending, lifetime.api);
}
async function resumeLocalHostRunInner(
  run: ActiveRunRecord,
  callbacks: HandleCallbacks,
  lifetime: HostedLifetimeControl,
): Promise<AsyncGenerator<StreamEvent> | "uncertain" | null> {
  if (run.personalRepo) lifetime.assertOpen();
  if (!run.hostId) return null;
  if (
    run.personalRepo &&
    (await personalRunRetired({
      runKey: run.runKey,
      hostId: run.hostId,
      sessionId: run.osSessionId!,
      binding: run.personalRepo,
    }))
  )
    return "uncertain";
  const dir = `${HOSTS_DIR}/${run.hostId}`;
  let meta = await readJsonSafe<RunHostMeta>(`${dir}/${HOST_META_NAME}`);
  const spec = await readJsonSafe<RunHostSpec>(`${dir}/${HOST_SPEC_NAME}`);
  const matchingMeta = (value: RunHostMeta | null) =>
    !run.personalRepo ||
    !value ||
    (value.hostId === run.hostId && value.osSessionId === run.osSessionId);
  if (!matchingMeta(meta)) return "uncertain";
  if (!spec) {
    if (run.personalRepo) return "uncertain";
    try {
      if (await hostUnitActive(run.hostId)) return "uncertain";
    } catch {
      return "uncertain";
    }
    const recovery = resolveInactiveHostRecovery(
      meta,
      await readHostJournal(dir),
      run.claudeSessionId,
    );
    if (recovery.kind === "uncertain") return "uncertain";
    if (recovery.kind === "resume") {
      run.claudeSessionId = recovery.engineSessionId;
      await journalSet({ ...run, claimedAt: undefined });
    }
    return null;
  }
  if (
    spec.hostId !== run.hostId ||
    spec.osSessionId !== run.osSessionId ||
    (run.personalRepo && spec.logicalRunId !== run.runKey) ||
    !!spec.personalRepo !== !!run.personalRepo ||
    (run.personalRepo &&
      (!spec.personalRepo ||
        !samePersonalRepoBinding(run.personalRepo, spec.personalRepo)))
  )
    return "uncertain";
  assertPersonalHostMcpNone(spec);
  const publication = await bindHostPublication(spec);
  const publicationCurrent = () => {
    let allowed = false;
    publication(() => {
      allowed = sessionPublicationAllowed(spec.osSessionId);
    });
    return allowed;
  };
  let alive = await systemdHostLauncher.alive(dir, meta);
  if (!alive && !meta?.done) {
    await waitForLocalHost(dir, 30_000);
    meta = await readJsonSafe<RunHostMeta>(`${dir}/${HOST_META_NAME}`);
    if (!matchingMeta(meta)) return "uncertain";
    alive = await systemdHostLauncher.alive(dir, meta);
  }
  if (!alive) {
    if (meta?.done) {
      const done = meta.done;
      unregisterRunToken(spec.rpcToken);
      if (!spec.personalRepo)
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      return (async function* () {
        if (publicationCurrent())
          yield spec.personalRepo
            ? tagHostedEvent(done, hostPublicationContext(publication))
            : done;
      })();
    }
    try {
      if (await hostUnitActive(run.hostId)) return "uncertain";
    } catch {
      return "uncertain";
    }
    const recovery = resolveInactiveHostRecovery(
      meta,
      await readHostJournal(dir),
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
      humanPrompter: spec.accountUser,
      promptEntryId: spec.promptEntryId,
    });
  }
  const handle = new HostHandle(
    dir,
    spec,
    callbacks,
    systemdHostLauncher,
    run.runKey,
    undefined,
    undefined,
    undefined,
    publication,
    lifetime,
  );
  handle.setHostChangeHandler(async (hostId) => {
    const replaces =
      run.personalRepo && run.hostId && run.osSessionId
        ? {
            runKey: run.runKey,
            hostId: run.hostId,
            sessionId: run.osSessionId,
            binding: run.personalRepo,
          }
        : undefined;
    run.hostId = hostId;
    const successor = { ...run, claimedAt: undefined };
    await hostedKernelCall(spec, "reattach_host_change_journal", () => {
      if (!handle.publicationCurrent())
        throw new Error("Run host publication unavailable");
      return journalSet(successor, undefined, { replaces });
    });
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
    meta = await readJsonSafe<RunHostMeta>(`${dir}/${HOST_META_NAME}`);
    if (!matchingMeta(meta)) return "uncertain";
    if (meta?.done) {
      return (async function* () {
        if (publicationCurrent())
          yield spec.personalRepo
            ? tagHostedEvent(meta.done!, hostPublicationContext(publication))
            : meta.done!;
      })();
    }
    const recovery = resolveInactiveHostRecovery(
      meta,
      await readHostJournal(dir),
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
        const context = hostedEventPublication(event) ?? handle.eventContext();
        if (context.consumer && context.consumer.hostId !== run.hostId)
          continue;
        const eventRecord = { ...run };
        let deliver = false;
        try {
          deliver =
            (await withHostedEventPublication(
              event,
              async () => {
                let changed = false;
                if (
                  event.type === "init" &&
                  event.sessionId &&
                  event.sessionId !== run.claudeSessionId
                ) {
                  eventRecord.claudeSessionId = event.sessionId;
                  changed = true;
                }
                if (event.type === "model_switch" && event.toModel) {
                  eventRecord.model = event.toModel;
                  eventRecord.transientFallback =
                    event.temporaryFallback === true;
                  if (shouldPersistModelSwitch(event))
                    eventRecord.selectedModel = event.toModel;
                  changed = true;
                }
                if (changed)
                  await journalSet({ ...eventRecord, claimedAt: undefined });
                if (!context.alive() || run.hostId !== eventRecord.hostId)
                  return false;
                Object.assign(run, eventRecord);
                return true;
              },
              !!spec.personalRepo,
            )) === true;
        } catch (error) {
          if (context.alive()) throw error;
        }
        if (deliver) yield event;
      }
    } finally {
      if (handle.ended) await journalClearIfLineageAsync({ ...run });
    }
  })();
}
