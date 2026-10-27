/**
 * A Sandbox for the dev server alone.
 *
 * A session that lives on this machine keeps its worktree and its agent
 * here; only its Portals run remotely, in a Sandbox provisioned the first
 * time one is started and torn down with the session. That Sandbox's
 * checkout is nobody's work: it is a clone of the session branch landed on
 * the session's checkpoints (sandbox/checkpoint.ts), refreshed after every
 * clean turn and whenever a Portal is started or the Sandbox wakes, so the
 * running app shows what the agent has done without a file-sync channel.
 * The repository opts in per project (`perRepo[repo].portalSandbox`).
 *
 * A session that already runs in a workspace Sandbox, or on a Runner, runs
 * its Portals there and never gets one of these.
 */

import { isAgentSessionBusy } from "./agent-runner";
import { hostRunBusy } from "./host-registry";
import { getSandboxProvider, type Sandbox } from "./sandbox";
import {
  checkpointHostWorkspace,
  landCheckpointInSandbox,
} from "./sandbox/checkpoint";
import {
  isRemoteSandboxProvider,
  repoPortalSandbox,
  sandboxesEnabled,
  sandboxProviderUsability,
} from "./sandbox/config";
import { withSessionLifecycleLane } from "./sandbox/lifecycle-lane";
import { ensureSandboxWaitingForCapacity } from "./sandbox/reliability";
import {
  findSessionAsync,
  touchNativeSession,
  touchNativeSessionStrict,
  updateSessionFile,
} from "./session-cache";
import {
  activePortalSandboxFor,
  activeSandboxFor,
  recordedSandboxGone,
  teardownRecordedSandbox,
  teardownSandbox,
  workspaceSandboxClaimed,
} from "./session-sandbox";
import type { PortalSandboxRecord, UnifiedSession } from "./types";
import { noteSandboxActivity, sandboxSleepsAt } from "./sandbox/idle";

type PortalSandboxGlobals = {
  __osPortalSandboxWakes?: Map<string, InFlightWake>;
};
const globals = globalThis as PortalSandboxGlobals;

type InFlightWake = { task: Promise<Sandbox | null>; provision: boolean };

/**
 * The wake or provision under way for each session, one at a time. A
 * machine takes a minute or more to come up, longer than a Portal tool call
 * may wait, so the start that asked for it answers before it is there and
 * the agent asks again. That second start joins the work in flight. Before
 * this, it checkpointed again and asked the provider for a second machine,
 * serialized behind the first by the provider lock: three tries were six
 * creates, and none of them answered in time.
 */
const wakes: Map<string, InFlightWake> = (globals.__osPortalSandboxWakes ??=
  new Map());

/** Providers key their resources by the spec's session id; the Portal
 * Sandbox is a second resource of the same session, so it gets its own. */
export const PORTAL_SANDBOX_SUFFIX = "--portals";

export function portalSandboxSessionId(sessionId: string): string {
  return `${sessionId}${PORTAL_SANDBOX_SUFFIX}`;
}

type PortalSession = Pick<
  UnifiedSession,
  | "id"
  | "source"
  | "sandbox"
  | "portalSandbox"
  | "runner"
  | "repo"
  | "mode"
  | "branch"
  | "worktreeDir"
  | "automationId"
  | "automation"
>;

/**
 * The provider a Portal Sandbox for `session` would use, or null when its
 * Portals run beside it: in its workspace Sandbox, on its Runner, or on this
 * machine because the project did not ask for one or the provider is not
 * usable right now.
 */
export function portalSandboxProvider(session: PortalSession): string | null {
  if (session.source !== "opensession") return null;
  if (session.runner) return null;
  if (workspaceSandboxClaimed(session)) return null;
  if (session.automationId || session.automation) return null;
  if (session.mode !== "code" || !session.repo || !session.branch) return null;
  if (!session.worktreeDir) return null;
  if (!sandboxesEnabled()) return null;
  const provider = repoPortalSandbox(session.repo);
  if (!provider || sandboxProviderUsability(provider).state !== "usable")
    return null;
  return provider;
}

/** Whether this session's Portals run in a Sandbox at all: its workspace
 * Sandbox, the Portal Sandbox it already has, or the one its project asks
 * for. Decides whether "no live Sandbox" is a refusal or means "on this
 * machine". */
export function portalsInSandbox(session: PortalSession): boolean {
  return Boolean(
    session.sandbox?.sandboxId ||
    session.portalSandbox?.sandboxId ||
    portalSandboxProvider(session),
  );
}

/**
 * Where a session's Portals run and how that machine is doing, for an agent
 * that found no live Sandbox: the same record the Portals panel reads, so
 * the tool and the panel tell the same story. `busy` while a wake or a
 * provision is under way in this process, whatever the record says yet.
 */
export type PortalSandboxReport =
  | {
      where: "workspace";
      provider: string;
      lifecycle?: NonNullable<UnifiedSession["sandbox"]>["lifecycle"];
      error?: string;
      busy: boolean;
    }
  | {
      where: "portal";
      provider: string;
      /** `none` until the first start provisions the machine. */
      lifecycle: NonNullable<PortalSandboxRecord["lifecycle"]> | "none";
      /** Whether a machine is recorded: a busy record is then waking, not
       * being created. */
      materialized: boolean;
      error?: string;
      busy: boolean;
      /** When the idle timers would put the machine to sleep. */
      sleepsAt?: string;
      /** Why a start is taking longer. */
      note?: string;
    };

export function describePortalSandbox(
  session: PortalSession,
): PortalSandboxReport | null {
  const busy = wakes.has(session.id);
  if (session.sandbox?.sandboxId)
    return {
      where: "workspace",
      provider: session.sandbox.provider,
      ...(session.sandbox.lifecycle
        ? { lifecycle: session.sandbox.lifecycle }
        : {}),
      ...(session.sandbox.lastLifecycleError
        ? { error: session.sandbox.lastLifecycleError }
        : {}),
      busy,
    };
  const record = session.portalSandbox;
  const provider = record?.provider ?? portalSandboxProvider(session);
  if (!provider) return null;
  const lifecycle = record
    ? (record.lifecycle ?? (record.sandboxId ? "sleeping" : "preparing"))
    : "none";
  const sleepsAt =
    record?.sandboxId && lifecycle === "awake"
      ? sandboxSleepsAt(record.sandboxId)
      : null;
  return {
    where: "portal",
    provider,
    lifecycle,
    materialized: Boolean(record?.sandboxId),
    ...(sleepsAt ? { sleepsAt: new Date(sleepsAt).toISOString() } : {}),
    ...(record?.lastLifecycleError ? { error: record.lastLifecycleError } : {}),
    ...(record?.lifecycleNote ? { note: record.lifecycleNote } : {}),
    busy,
  };
}

/**
 * The Sandbox that runs this session's Portals: its workspace Sandbox, its
 * Portal Sandbox, or, with `provision`, a Portal Sandbox created now for a
 * project that runs Portals remotely. `wake` is an explicit compute action
 * (starting or restarting a Portal): it may wake a sleeping machine and
 * lands the latest host checkpoint in a Portal Sandbox first, so the app
 * that comes up shows the current tree: before the Portals a wake brings
 * back are relaunched, and before the caller starts its own. When that
 * landing fails the wake fails with it, rather than starting the app on
 * whatever the machine had before. A Portal Sandbox the provider has lost
 * is replaced when
 * provisioning is allowed. Throws when provisioning or the landing fails;
 * the reason is recorded on the session as well. Landing captures the
 * worktree, so while a turn is running it is refused, unless the caller is
 * that turn (`ownTurn`: the agent's own Portal tool call, the post-turn
 * refresh), whose worktree is at rest while the call runs.
 */
export function sandboxForPortals(
  session: UnifiedSession,
  options: { wake?: boolean; provision?: boolean; ownTurn?: boolean } = {},
): Promise<Sandbox | null> {
  if (!options.wake && !options.provision)
    return resolveSandboxForPortals(session, options);
  const current = wakes.get(session.id);
  if (current) {
    // A wake that found the machine gone provisions nothing; a caller that
    // may provision then does its own, after it.
    return options.provision && !current.provision
      ? current.task.then((sandbox) =>
          sandbox ? sandbox : sandboxForPortals(session, options),
        )
      : current.task;
  }
  const entry: InFlightWake = {
    task: resolveSandboxForPortals(session, options)
      .then((sandbox) => {
        // Starting or waking Portals is activity on that machine: the
        // agent's own start is agent work, anything else a person's.
        if (sandbox)
          noteSandboxActivity(
            { sandboxId: sandbox.id, sessionId: session.id },
            options.ownTurn ? "agent" : "human",
          );
        return sandbox;
      })
      .finally(() => {
        if (wakes.get(session.id) === entry) wakes.delete(session.id);
      }),
    provision: Boolean(options.provision),
  };
  wakes.set(session.id, entry);
  return entry.task;
}

async function resolveSandboxForPortals(
  session: UnifiedSession,
  options: { wake?: boolean; provision?: boolean; ownTurn?: boolean },
): Promise<Sandbox | null> {
  if (session.sandbox?.sandboxId)
    return activeSandboxFor(session, { wake: options.wake });
  if (workspaceSandboxClaimed(session)) {
    // Moving into a workspace Sandbox that has no machine yet: the Portals
    // will run there. Nothing to wake or provision on this side.
    if (options.wake || options.provision)
      throw new Error(
        "This session is moving into a Sandbox; start the Portal there once it is ready.",
      );
    return null;
  }
  const record = session.portalSandbox;
  if (record?.sandboxId) {
    let synced = false;
    const sandbox = await activePortalSandboxFor(session, {
      wake: options.wake,
      // A wake relaunches the Portals the machine was running: land the
      // checkpoint first, or they would come back public on the older tree
      // even though the start itself then fails.
      beforeRestore: async (woken) => {
        await landForWake(session, woken, options.ownTurn);
        synced = true;
      },
    });
    if (sandbox) {
      if (options.wake && !synced)
        await landForWake(session, sandbox, options.ownTurn);
      return sandbox;
    }
    if (
      !options.provision ||
      !(await recordedSandboxGone({ ...record, sandboxId: record.sandboxId }))
    )
      return null;
    console.warn(
      `[sandbox] ${session.id}: Portal Sandbox ${record.sandboxId} is gone; replacing it`,
    );
  }
  if (!options.provision) return null;
  const provider = portalSandboxProvider(session);
  if (!provider) return null;
  return provisionPortalSandbox(session, provider, options.ownTurn);
}

/**
 * The landing a wake requires. `skipped` means the session's record no
 * longer names this machine (a move or a release took it away while the
 * wake was under way): the machine is nobody's to start an app on, so
 * that is the wake's failure too, not a Sandbox to hand back.
 */
async function landForWake(
  session: UnifiedSession,
  sandbox: Sandbox,
  ownTurn: boolean | undefined,
): Promise<void> {
  if ((await syncPortalSandbox(session, sandbox, { ownTurn })) === "skipped")
    throw new Error("the session no longer runs its Portals on this machine");
}

/**
 * The refusal the lifecycle routes make, checked on the lifecycle lane after
 * claiming it: run admission waits for the lane before it reserves the
 * session, so a reservation seen here belongs to a turn that is running (or
 * starts the moment the lane is free), and the worktree is that turn's to
 * change. Capturing it now would checkpoint a tree mid-edit.
 */
function refuseWhileTurnRuns(sessionId: string): void {
  if (hostRunBusy(sessionId) || isAgentSessionBusy(sessionId))
    throw new Error(
      "Wait for the agent to finish before starting its Portal in a Sandbox.",
    );
}

/**
 * Create the Portal Sandbox: checkpoint the host worktree so uncommitted
 * work travels too, then materialize a workspace on the checkpoint. The
 * provisioning itself is not on the lifecycle lane (the checkpoint claims it
 * for itself): a machine can take a minute to come up and turns need not
 * wait for it. Taking ownership is: the final owner check and the record
 * write happen on the lane, where deletion and moves also run, so the
 * machine is either recorded on a session that still wants it (and goes
 * with that session) or torn down here; a session deleted or moved into a
 * Sandbox meanwhile gets no Portal Sandbox. Turns that finished while the
 * machine came up are caught up on that same lane step, so the machine is
 * handed back on the worktree as it is now, not as it was a minute ago.
 */
async function provisionPortalSandbox(
  session: UnifiedSession,
  provider: string,
  ownTurn: boolean | undefined,
): Promise<Sandbox> {
  const dir = session.worktreeDir!;
  // The machine mirrors this worktree, and the checkpoint just taken is the
  // only faithful copy of it. Captured before anything is recorded: a
  // session at work is refused outright, which is nobody's failure to show.
  // The preparing record is written on that same lane step, after the
  // session is seen to still want a Portal Sandbox: a move queued behind
  // it then finds the record and releases it, instead of the record landing
  // beside the workspace Sandbox the move recorded meanwhile.
  const outcome = await withSessionLifecycleLane(session.id, async () => {
    if (!ownTurn) refuseWhileTurnRuns(session.id);
    const current = await findSessionAsync(session.id);
    if (!current) throw new Error("the session was deleted");
    if (workspaceSandboxClaimed(current))
      throw new Error("the session is moving into a Sandbox");
    const captured = await checkpointHostWorkspace(current, dir);
    if (captured.state === "skipped") return captured;
    await touchNativeSessionStrict(session.id, {
      portalSandbox: { provider, lifecycle: "preparing" },
    });
    return captured;
  });
  // What the failure path may write: the preparing record until the machine
  // is recorded on the session; nothing once it is recorded (the record then
  // carries the machine, and a refresh failure is noted on it by the
  // refresh itself). Once the session stopped wanting a Portal Sandbox, only
  // the removal of a preparing record this attempt left behind.
  // (Assigned inside the lane callback, which the narrowing does not see.)
  let phase = "preparing" as "preparing" | "recorded" | "disowned";
  try {
    // A worktree that cannot be checkpointed (not on GitHub, on the default
    // branch, no credential) gets no Portal Sandbox rather than one built
    // from origin that shows older code.
    if (outcome.state === "skipped")
      throw new Error(
        `this worktree cannot be checkpointed (${outcome.reason}), and the Portal Sandbox would show older code`,
      );
    const checkpoint = outcome.checkpoint;
    const current = await findSessionAsync(session.id);
    if (!current) throw new Error("the session was deleted");
    const sandbox = await ensureSandboxWaitingForCapacity(
      getSandboxProvider(provider),
      {
        sessionId: portalSandboxSessionId(session.id),
        repo: current.repo,
        branch: checkpoint.branch,
        mode: "code",
        restoreCheckpoint: {
          ref: checkpoint.ref,
          commit: checkpoint.commit,
          branch: checkpoint.branch,
        },
      },
      {
        onWaiting(error) {
          touchNativeSession(session.id, {
            portalSandbox: {
              provider,
              lifecycle: "preparing",
              lifecycleNote: `Waiting for room: ${error instanceof Error ? error.message : String(error)}`,
            },
          });
        },
      },
    );
    try {
      await withSessionLifecycleLane(session.id, async () => {
        const owner = await findSessionAsync(session.id);
        if (
          !owner ||
          workspaceSandboxClaimed(owner) ||
          owner.portalSandbox?.provider !== provider
        )
          throw new Error(
            owner
              ? "the session moved while its Portal Sandbox was being prepared"
              : "the session was deleted",
          );
        await touchNativeSessionStrict(session.id, {
          portalSandbox: {
            provider,
            sandboxId: sandbox.id,
            lifecycle: "awake",
            lastLifecycleError: undefined,
            syncedCommit: checkpoint.commit,
          },
        });
        phase = "recorded";
        // A turn that finished while the machine came up moved the worktree
        // past `checkpoint` (its post-turn refresh saw a preparing record and
        // returned). Capture and land that now, still on the lane, so the
        // start waiting on this machine never sees the older tree. A failure
        // here fails the start, with the machine kept and recorded: the next
        // wake retries the landing.
        await landForWake(owner, sandbox, ownTurn);
      });
    } catch (error) {
      if (phase === "recorded") throw error;
      // Not recorded on any session (gone, moved, or the write itself was
      // refused): nothing else will ever tear this machine down.
      phase = "disowned";
      await teardownSandbox(provider, sandbox.id).catch((teardownError) =>
        console.warn(
          `[sandbox] ${session.id}: unowned Portal Sandbox ${sandbox.id} not destroyed:`,
          teardownError instanceof Error
            ? teardownError.message
            : String(teardownError),
        ),
      );
      // The preparing record this attempt wrote, if it survived the move
      // that disowned the machine, would show the Portals panel a Portal
      // Sandbox preparing that never comes. Only that record, nothing a
      // later attempt or the move wrote.
      await updateSessionFile(session.id, (data) =>
        data.portalSandbox?.provider === provider &&
        !data.portalSandbox.sandboxId &&
        data.portalSandbox.lifecycle === "preparing"
          ? { ...data, portalSandbox: undefined }
          : data,
      ).catch(() => {});
      throw error;
    }
    console.log(
      `[sandbox] ${session.id}: Portal Sandbox ${sandbox.id} ready on checkpoint ${checkpoint.commit.slice(0, 12)}`,
    );
    return sandbox;
  } catch (error) {
    if (phase === "recorded") throw error;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[sandbox] ${session.id}: Portal Sandbox not prepared (${provider}): ${message}`,
    );
    if (phase === "preparing")
      touchNativeSession(session.id, {
        portalSandbox: {
          provider,
          lifecycle: "needs_attention",
          lastLifecycleError: message.slice(0, 240),
        },
      });
    throw new Error(`Could not prepare the Portal Sandbox: ${message}`);
  }
}

/**
 * Bring the Portal Sandbox's checkout up to the host worktree: checkpoint
 * the worktree and land the checkpoint there, on the session's lifecycle
 * lane so the capture and the landing see one consistent record. `current`
 * when the Sandbox already sits on the latest checkpoint; `skipped` only
 * when the machine is not this session's Portal Sandbox any more. A failed
 * capture or landing throws, and so does a capture the worktree does not
 * allow (no branch, the default branch, no credential), with the reason
 * recorded on the session for the Portals panel: the machine then holds an
 * older tree, and a wake that went on regardless would report the app
 * ready on stale code.
 */
export function syncPortalSandbox(
  session: UnifiedSession,
  sandbox: Sandbox,
  options: { ownTurn?: boolean } = {},
): Promise<"landed" | "current" | "skipped"> {
  return withSessionLifecycleLane(session.id, async () => {
    const current = await findSessionAsync(session.id);
    const record = current?.portalSandbox;
    if (
      !current?.worktreeDir ||
      record?.sandboxId !== sandbox.id ||
      workspaceSandboxClaimed(current)
    )
      return "skipped";
    if (!options.ownTurn) refuseWhileTurnRuns(current.id);
    try {
      const outcome = await checkpointHostWorkspace(
        current,
        current.worktreeDir,
      );
      if (outcome.state === "skipped")
        throw new Error(
          `this worktree cannot be checkpointed (${outcome.reason}), and the Portal Sandbox holds older code`,
        );
      if (outcome.checkpoint.commit === record.syncedCommit) return "current";
      await landCheckpointInSandbox(current.repo, sandbox, outcome.checkpoint);
      await touchNativeSessionStrict(current.id, {
        portalSandbox: {
          ...record,
          lastLifecycleError: undefined,
          syncedCommit: outcome.checkpoint.commit,
        },
      });
      console.log(
        `[sandbox] ${current.id}: Portal Sandbox on checkpoint ${outcome.checkpoint.commit.slice(0, 12)}`,
      );
      return "landed";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[sandbox] ${current.id}: Portal Sandbox ${sandbox.id} not refreshed: ${message}`,
      );
      touchNativeSession(current.id, {
        portalSandbox: { ...record, lastLifecycleError: message.slice(0, 240) },
      });
      throw new Error(`Could not refresh the Portal Sandbox: ${message}`);
    }
  });
}

/**
 * After a clean turn on this machine: refresh the Portal Sandbox if it is
 * awake (a sleeping one lands the checkpoint when a Portal wakes it). Claims
 * the lane synchronously, like the Sandbox session's own post-turn
 * checkpoint, so the next turn waits for the capture.
 */
export function syncPortalSandboxAfterTurn(
  session: UnifiedSession,
): Promise<void> {
  return withSessionLifecycleLane(session.id, async () => {
    const current = await findSessionAsync(session.id);
    if (!current?.portalSandbox?.sandboxId) return;
    const sandbox = await activePortalSandboxFor(current);
    if (!sandbox) return;
    await syncPortalSandbox(current, sandbox, { ownTurn: true });
  });
}

/** Retire a session's Portal Sandbox (a move into a workspace Sandbox, whose
 * Portals run there). Preserve the record if retirement fails so it can retry. */
export async function releasePortalSandbox(
  session: UnifiedSession,
  why: string,
): Promise<void> {
  const record = session.portalSandbox;
  if (!record) return;
  const id = await teardownRecordedSandbox(`${session.id}--portals`, record);
  console.log(
    `[sandbox] ${session.id}: Portal Sandbox ${id || "unmaterialized"} retired (${why})`,
  );
  await touchNativeSessionStrict(session.id, { portalSandbox: undefined });
}
