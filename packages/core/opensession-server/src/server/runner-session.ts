/**
 * Runner-backed session turns.
 *
 * A Runner owns only the workspace and detached run-host process. The server
 * remains the transcript, queue, approval, collaboration and RPC authority.
 * This deliberately uses the remote run-ws transport, not the command socket
 * as a second agent-event protocol.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { configuredServer } from "./config";
import {
  HostHandle,
  type HandleCallbacks,
  type HostLauncher,
} from "./host-client";
import {
  HOST_SPEC_NAME,
  runHostsDir,
  type RunHostSpec,
} from "../runner-host/protocol";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { registerRunToken, unregisterRunToken } from "./run-rpc";
import {
  launchRunnerHost,
  RunnerHostLaunchRejectedError,
  runnerHostAlive,
  runnerHostStatus,
} from "./runner-ws";
import { claimRunnerWorkload, getRunner, setRunnerWorkload } from "./runners";
import { registerRunWsHost, runWsConnector } from "./run-ws";
import type { UnifiedSession } from "./types";
import { interactiveMcpServers } from "./interactive-mcp";
import { interactiveFallbackModel } from "./models";
import { STRIPE_CONFIRM_TOOLS } from "./runner-shared";
import { commitAuthorFor } from "./shared/user-mappings";
import { makeAskHandler } from "./asks";
import type { McpScope } from "./runner-shared";
import type { StreamEvent } from "./agent-runner";
import type { ImageInput } from "./run-events";
import { resolveSessionRunInputs } from "./session-run-inputs";
import {
  activeRunRecords,
  journalClear,
  journalClearIfLineage,
  journalQuarantine,
  journalRecordAbnormalCompletion,
  journalSet,
  type ActiveRunRecord,
} from "./run-journal";
import { writeJsonAtomic } from "./shared/atomic-write";

type RunnerLaunchOpts = {
  prompt: string;
  promptEntryId?: string;
  hostId?: string;
  engineSessionId?: string;
  images?: ImageInput[];
  mcpServers?: McpScope;
  user?: string;
  reposNote?: string;
  shouldCancel?: () => boolean;
};

type RunnerEvents = AsyncGenerator<StreamEvent> & { runnerId: string };

type RunnerOpeningLaunchState = {
  version: 1;
  hostId: string;
  sessionId: string;
  promptEntryId?: string;
  phase: "prepared" | "launching" | "started" | "rejected";
};

const RUNNER_OPENING_LAUNCH_STATE = "opening-launch.json";

function serverWsBase(): string {
  return configuredServer().publicBaseUrl.replace(/\/$/, "");
}

/** Start a turn in the session-owned workspace already materialized by this Runner. */
export async function maybeLaunchRunnerRun(
  session: UnifiedSession,
  opts: RunnerLaunchOpts,
): Promise<RunnerEvents | null> {
  const target = session.runner;
  if (!target) return null;
  if (!session.repo || !session.worktreeDir)
    throw new Error("Runner session is missing its repository workspace");
  const registeredRunner = getRunner(target.id);
  if (!registeredRunner)
    throw new Error("This Runner is no longer available for this session");
  if (
    session.automationDescendantPolicy &&
    !registeredRunner.permissions.automationDescendants
  )
    throw new Error(
      "This Runner is not configured with automation descendant OS isolation",
    );
  const runner = claimRunnerWorkload(registeredRunner.id, {
    user: opts.user,
    repo: session.repo,
    sessionId: session.id,
    operation: "full session",
    automationDescendant: !!session.automationDescendantPolicy,
  });
  if (!runner)
    throw new Error("This Runner is no longer available for this session");

  const runInputs = await resolveSessionRunInputs(session, { user: opts.user });
  const automationPolicy = session.automationDescendantPolicy;
  const runUser = runInputs.isAutomationSession ? undefined : opts.user;
  const publicationPolicy = automationPolicy
    ? {
        repo: automationPolicy.publicationRepo,
        branch: automationPolicy.baseBranch,
        headBranch: session.branch || "",
      }
    : undefined;
  const hostId = opts.hostId || `rh-${Bun.randomUUIDv7()}`;
  const hostDir = `${runHostsDir(OPENSESSION_SESSIONS_DIR)}/${hostId}`;
  const specPath = `${hostDir}/${HOST_SPEC_NAME}`;
  const launchStatePath = `${hostDir}/${RUNNER_OPENING_LAUNCH_STATE}`;
  const priorSpec = existsSync(specPath) ? readRunnerHostSpec(specPath) : null;
  if (existsSync(specPath) && !priorSpec)
    throw new Error(
      `Runner host ${hostId} has an unreadable durable specification`,
    );
  if (
    priorSpec &&
    (priorSpec.hostId !== hostId ||
      priorSpec.osSessionId !== session.id ||
      priorSpec.cwd !== session.worktreeDir ||
      priorSpec.promptEntryId !== opts.promptEntryId)
  )
    throw new Error(`Runner host ${hostId} crossed opening ownership`);
  const priorRun = activeRunRecords().find(
    (run) =>
      run.osSessionId === session.id &&
      run.hostId === hostId &&
      run.promptEntryId === opts.promptEntryId,
  );
  const priorLaunchState = existsSync(launchStatePath)
    ? readRunnerOpeningLaunchState(launchStatePath)
    : null;
  if (existsSync(launchStatePath) && !priorLaunchState)
    throw new Error(
      `Runner host ${hostId} has unreadable durable launch state`,
    );
  if (
    priorLaunchState &&
    (priorLaunchState.hostId !== hostId ||
      priorLaunchState.sessionId !== session.id ||
      priorLaunchState.promptEntryId !== opts.promptEntryId)
  )
    throw new Error(`Runner host ${hostId} crossed durable launch ownership`);
  const spec: RunHostSpec = priorSpec ?? {
    hostId,
    osSessionId: session.id,
    prompt: opts.prompt,
    promptEntryId: opts.promptEntryId,
    engineSessionId: opts.engineSessionId,
    cwd: session.worktreeDir,
    mode: session.mode,
    model: session.model,
    effort: session.effort,
    fastMode: session.fastMode,
    accountId: session.accountId,
    images: opts.images,
    mcpServers: runInputs.isAutomationSession
      ? (runInputs.mcpServers ?? [])
      : (opts.mcpServers ?? "all"),
    proxyMcpServers: runInputs.isAutomationSession
      ? []
      : Object.keys(interactiveMcpServers(opts.user, session.id)),
    rpcToken: crypto.randomUUID(),
    wsToken: crypto.randomUUID(),
    reposNote: runInputs.isAutomationSession ? undefined : opts.reposNote,
    deniedTools: runInputs.deniedTools,
    publicationPolicy,
    confirmTools: STRIPE_CONFIRM_TOOLS,
    aws: !runInputs.isAutomationSession,
    author: commitAuthorFor(opts.user, session.startedBy),
    user: runUser,
    mcpGrantUser: runInputs.isAutomationSession
      ? undefined
      : session.startedBy || undefined,
    fallbackModel: interactiveFallbackModel(session.model),
    journalKind: runInputs.isAutomationSession ? "automation" : "prompt",
    trustProfile: runInputs.isAutomationSession ? "automation" : "interactive",
  };
  if (!spec.rpcToken || !spec.wsToken)
    throw new Error(
      `Runner host ${hostId} is missing its durable connection fence`,
    );
  if (!priorSpec) {
    mkdirSync(hostDir, { recursive: true });
    writeJsonAtomic(specPath, spec);
  }
  let launchState: RunnerOpeningLaunchState = priorLaunchState ?? {
    version: 1,
    hostId,
    sessionId: session.id,
    promptEntryId: opts.promptEntryId,
    phase: priorRun?.launchPhase ?? "prepared",
  };
  if (!priorLaunchState) writeJsonAtomic(launchStatePath, launchState);
  const rpcToken = spec.rpcToken;
  const wsToken = spec.wsToken;
  let run: ActiveRunRecord = {
    ...priorRun,
    // Host identity is immutable for one physical dispatch; the session id is
    // a reusable alias and cannot fence delayed cancellation from a successor.
    runKey: hostId,
    osSessionId: session.id,
    prompt: spec.prompt,
    cwd: session.worktreeDir,
    mode: session.mode,
    mcpServers: spec.mcpServers,
    user: runUser,
    model: session.model,
    effort: session.effort,
    fastMode: session.fastMode,
    accountId: session.accountId,
    fallbackModel: interactiveFallbackModel(session.model),
    deniedTools: runInputs.deniedTools,
    publicationPolicy,
    aws: !runInputs.isAutomationSession,
    trustProfile: runInputs.isAutomationSession ? "automation" : "interactive",
    kind: runInputs.isAutomationSession ? "automation" : "prompt",
    runnerId: runner.id,
    hostId,
    promptEntryId: opts.promptEntryId,
    launchPhase:
      launchState.phase === "rejected" ? "prepared" : launchState.phase,
    startedAt: priorRun?.startedAt ?? new Date().toISOString(),
  };
  await journalSet(run);
  registerRunToken(rpcToken, { sessionId: session.id, user: runUser });
  registerRunWsHost(hostId, wsToken);
  const hostSpecs = new Map<string, RunHostSpec>([[hostId, spec]]);

  const launcher: HostLauncher = {
    alive: async (_dir, meta) =>
      runnerHostAlive(meta?.hostId || hostId) &&
      runnerHostStatus(runner.id, {
        sessionId: session.id,
        repo: session.repo!,
        workspacePath: session.worktreeDir!,
        hostId: meta?.hostId || hostId,
        user: opts.user,
      }),
    newRunDir: (nextHostId) =>
      `${runHostsDir(OPENSESSION_SESSIONS_DIR)}/${nextHostId}`,
    connector: (_dir, hostSpec) => runWsConnector(hostSpec.hostId),
    async writeSpec(dir, nextSpec) {
      mkdirSync(dir, { recursive: true });
      writeJsonAtomic(`${dir}/${HOST_SPEC_NAME}`, nextSpec);
      hostSpecs.set(nextSpec.hostId, nextSpec);
      registerRunWsHost(nextSpec.hostId, nextSpec.wsToken!);
    },
    async launch(nextHostId, _dir) {
      const nextSpec = hostSpecs.get(nextHostId);
      if (!nextSpec)
        throw new Error(`Missing Runner host specification for ${nextHostId}`);
      await launchRunnerHost(runner.id, {
        sessionId: session.id,
        repo: session.repo!,
        user: opts.user,
        server: serverWsBase(),
        spec: nextSpec,
      });
    },
  };
  const callbacks: HandleCallbacks = {
    onAskUser: makeAskHandler(session.id),
    onSteerFailed: () => {}, // normal queue handling re-delivers a later prompt
  };
  let handle: HostHandle | undefined;
  try {
    handle = new HostHandle(hostDir, spec, callbacks, launcher);
    if (opts.shouldCancel?.() && run.launchPhase === "prepared")
      throw new RunnerHostLaunchRejectedError(
        `Runner dispatch ${hostId} was cancelled before launch`,
      );
    if (launchState.phase === "rejected")
      throw new RunnerHostLaunchRejectedError(
        `Runner opening ${hostId} was durably rejected before dispatch`,
      );
    if (run.launchPhase === "prepared") {
      // `launching` is durable before the request can reach the Runner. A
      // restart may adopt remote evidence, but may never infer non-execution
      // from an absent connection and launch the same turn again.
      launchState = { ...launchState, phase: "launching" };
      writeJsonAtomic(launchStatePath, launchState);
      run = { ...run, launchPhase: "launching" };
      await journalSet(run);
      await launcher.launch(hostId, hostDir);
      if (opts.shouldCancel?.()) handle.requestCancel();
      launchState = { ...launchState, phase: "started" };
      writeJsonAtomic(launchStatePath, launchState);
      run = { ...run, launchPhase: "started" };
      await journalSet(run);
    } else {
      const alive =
        runnerHostAlive(hostId) &&
        (await runnerHostStatus(runner.id, {
          sessionId: session.id,
          repo: session.repo,
          workspacePath: session.worktreeDir,
          hostId,
          user: opts.user,
        }));
      if (!alive)
        throw new Error(
          `Runner opening ${hostId} was admitted but has no adoptable remote evidence`,
        );
      if (run.launchPhase !== "started") {
        launchState = { ...launchState, phase: "started" };
        writeJsonAtomic(launchStatePath, launchState);
        run = { ...run, launchPhase: "started" };
        await journalSet(run);
      }
    }
    await handle.connectWithWait(20_000);
    if (opts.shouldCancel?.()) handle.requestCancel();
    const events = (async function* (): AsyncGenerator<StreamEvent> {
      let sourceCompleted = false;
      let sawTerminal = false;
      try {
        for await (const event of handle!.events()) {
          if (event.type === "done" || event.type === "error")
            sawTerminal = true;
          yield event;
        }
        sourceCompleted = true;
      } finally {
        if (sourceCompleted && sawTerminal) journalClear(run.runKey);
        else if (sourceCompleted) await journalRecordAbnormalCompletion(run);
        setRunnerWorkload(runner.id, undefined, session.id);
      }
    })() as RunnerEvents;
    events.runnerId = runner.id;
    return events;
  } catch (error) {
    handle?.abandon();
    unregisterRunToken(rpcToken);
    if (
      run.launchPhase === "prepared" ||
      error instanceof RunnerHostLaunchRejectedError
    ) {
      // Server-side preflight rejection proves the launch request was never
      // sent. Fence retries durably before retiring the prepared journal.
      launchState = { ...launchState, phase: "rejected" };
      writeJsonAtomic(launchStatePath, launchState);
      journalClearIfLineage(run);
    } else {
      // Once launch admission may have crossed the Runner connection, absence
      // is not proof of non-execution. Remove the record from boot recovery but
      // retain it for operator inspection beside the actor's terminal failure.
      journalQuarantine([
        { run, reason: "ambiguous_runner_launch", notify: false },
      ]);
    }
    setRunnerWorkload(runner.id, undefined, session.id);
    throw error;
  }
}

function readRunnerHostSpec(path: string): RunHostSpec | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RunHostSpec;
  } catch {
    return null;
  }
}

function readRunnerOpeningLaunchState(
  path: string,
): RunnerOpeningLaunchState | null {
  try {
    const value = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<RunnerOpeningLaunchState>;
    if (
      value.version !== 1 ||
      typeof value.hostId !== "string" ||
      typeof value.sessionId !== "string" ||
      (value.promptEntryId !== undefined &&
        typeof value.promptEntryId !== "string") ||
      !["prepared", "launching", "started", "rejected"].includes(
        String(value.phase),
      )
    )
      return null;
    return value as RunnerOpeningLaunchState;
  } catch {
    return null;
  }
}

/** Reattach a still-running Runner host after an Open Session restart. A
 * missing remote host fails recovery explicitly instead of falling back to the
 * server machine and crossing the selected execution boundary. */
export async function resumeRunnerRun(
  run: ActiveRunRecord,
  callbacks: HandleCallbacks,
): Promise<AsyncGenerator<StreamEvent> | null> {
  if (!run.osSessionId || !run.runnerId) return null;
  const { findSession } = await import("./session-cache");
  const session = findSession(run.osSessionId);
  if (
    !session?.runner ||
    session.runner.id !== run.runnerId ||
    !session.repo ||
    !session.worktreeDir
  )
    return null;
  const hostsRoot = runHostsDir(OPENSESSION_SESSIONS_DIR);
  if (!existsSync(hostsRoot)) return null;
  const candidates = readdirSync(hostsRoot)
    .map((name) => {
      const dir = `${hostsRoot}/${name}`;
      return { dir, spec: readRunnerHostSpec(`${dir}/${HOST_SPEC_NAME}`) };
    })
    .filter((entry): entry is { dir: string; spec: RunHostSpec } => {
      const candidate = entry.spec;
      return Boolean(
        candidate &&
        candidate.osSessionId === session.id &&
        candidate.cwd === session.worktreeDir &&
        (!run.hostId || candidate.hostId === run.hostId) &&
        (!run.promptEntryId || candidate.promptEntryId === run.promptEntryId) &&
        candidate.wsToken &&
        candidate.rpcToken,
      );
    });
  const candidate =
    run.hostId || run.promptEntryId
      ? candidates.length === 1
        ? candidates[0]
        : undefined
      : candidates.at(-1);
  if (!candidate) return null;
  const spec = candidate.spec;
  registerRunToken(spec.rpcToken!, { sessionId: session.id, user: spec.user });
  registerRunWsHost(spec.hostId, spec.wsToken!);
  const alive = await runnerHostStatus(run.runnerId, {
    sessionId: session.id,
    repo: session.repo,
    workspacePath: session.worktreeDir,
    hostId: spec.hostId,
    user: spec.user,
  });
  if (!alive) {
    unregisterRunToken(spec.rpcToken);
    return null;
  }
  const hostSpecs = new Map<string, RunHostSpec>([[spec.hostId, spec]]);
  const launcher: HostLauncher = {
    alive: async (_dir, meta) =>
      runnerHostAlive(meta?.hostId || spec.hostId) &&
      runnerHostStatus(run.runnerId!, {
        sessionId: session.id,
        repo: session.repo!,
        workspacePath: session.worktreeDir!,
        hostId: meta?.hostId || spec.hostId,
        user: spec.user,
      }),
    newRunDir: (hostId) => `${runHostsDir(OPENSESSION_SESSIONS_DIR)}/${hostId}`,
    connector: (_dir, hostSpec) => runWsConnector(hostSpec.hostId),
    async writeSpec(dir, nextSpec) {
      mkdirSync(dir, { recursive: true });
      writeJsonAtomic(`${dir}/${HOST_SPEC_NAME}`, nextSpec);
      hostSpecs.set(nextSpec.hostId, nextSpec);
      registerRunWsHost(nextSpec.hostId, nextSpec.wsToken!);
    },
    async launch(hostId) {
      const nextSpec = hostSpecs.get(hostId);
      if (!nextSpec)
        throw new Error(`Missing Runner host specification for ${hostId}`);
      await launchRunnerHost(run.runnerId!, {
        sessionId: session.id,
        repo: session.repo!,
        user: spec.user,
        server: serverWsBase(),
        spec: nextSpec,
      });
    },
  };
  setRunnerWorkload(run.runnerId, {
    sessionId: session.id,
    operation: "full session",
    startedAt: run.startedAt,
  });
  const handle = new HostHandle(
    candidate.dir,
    spec,
    callbacks,
    launcher,
    run.runKey,
  );
  try {
    await handle.connectWithWait(20_000);
    return (async function* (): AsyncGenerator<StreamEvent> {
      try {
        yield* handle.events();
      } finally {
        setRunnerWorkload(run.runnerId!, undefined, session.id);
      }
    })();
  } catch (error) {
    handle.abandon();
    setRunnerWorkload(run.runnerId, undefined, session.id);
    throw error;
  }
}
