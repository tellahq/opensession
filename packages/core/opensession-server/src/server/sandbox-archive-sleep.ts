/**
 * Put a session's Sandboxes to sleep: when it is archived, and when it has
 * gone idle (sandbox/idle.ts).
 *
 * Archiving used to leave a Sandbox session's machine, and a host session's
 * Portal Sandbox, running until the provider's idle timer stopped it (30
 * minutes by default), dev server and all. Sleep keeps the disk, so
 * unarchiving and opening the session wakes it where it was. Deleting a
 * session is still what destroys a Sandbox.
 *
 * Runs on the session's lifecycle lane, like the manual sleep action: the
 * workspace is checkpointed first (without waking a machine that already
 * sleeps), Portal routes are suspended so opening one wakes the machine, and
 * the record says `sleeping` before the provider stop. A session with a turn
 * admitted or running is left alone.
 */
import { isAgentSessionBusy } from "./agent-runner";
import { isArchivedId } from "./archive";
import { hostRunBusy } from "./host-registry";
import { suspendSandboxPreviewRoutes } from "./preview";
import { getSandboxProvider } from "./sandbox";
import { checkpointSessionWorkspace } from "./sandbox/checkpoint";
import { isRemoteSandboxProvider } from "./sandbox/config";
import { withSessionLifecycleLane } from "./sandbox/lifecycle-lane";
import { findSessionAsync, touchNativeSession } from "./session-cache";
import { activePortalSandboxFor, activeSandboxFor } from "./session-sandbox";

export type SandboxSleepReason = "archived" | "idle";

/** Why a session's Sandbox is left running, or null to sleep it. */
export function sandboxSleepSkipReason(input: {
  reason: SandboxSleepReason;
  archived: boolean;
  busy: boolean;
  record?: { provider?: string; sandboxId?: string; lifecycle?: string };
  canPause: boolean;
  /** Idle sleep only: whether the idle timers still say so on the lane. */
  stillIdle?: boolean;
}): string | null {
  if (input.reason === "archived" && !input.archived) return "unarchived";
  if (!input.record?.provider || !input.record.sandboxId) return "no machine";
  if (!isRemoteSandboxProvider(input.record.provider)) return "local";
  if (!input.canPause) return "no sleep support";
  if (input.record.lifecycle === "sleeping") return "asleep";
  if (input.busy) return "turn running";
  if (input.reason === "idle" && input.stillIdle === false) return "active";
  return null;
}

/** Why an archived session's Sandbox is left running, or null to sleep it. */
export function archiveSleepSkipReason(input: {
  archived: boolean;
  busy: boolean;
  record?: { provider?: string; sandboxId?: string; lifecycle?: string };
  canPause: boolean;
}): string | null {
  return sandboxSleepSkipReason({ ...input, reason: "archived" });
}

export function sleepArchivedSessionSandboxes(
  sessionId: string,
): Promise<void> {
  return sleepSessionSandboxes(sessionId, { reason: "archived" }).then(
    async () => {
      // The GPU machine its GPU jobs ran on (gpu-jobs.ts).
      const gpu = await import("./gpu-jobs");
      if (gpu.sessionHasGpuMachine(sessionId))
        await gpu
          .sleepGpuMachine(sessionId)
          .catch((error) =>
            console.warn(
              `[sandbox] ${sessionId}: GPU machine not put to sleep:`,
              error instanceof Error ? error.message : String(error),
            ),
          );
    },
  );
}

export type SleptSandbox = { kind: "workspace" | "portal"; sandboxId: string };

/**
 * Sleep the session's workspace Sandbox and/or Portal Sandbox. `stillIdle`
 * is asked on the lane, after any operation queued ahead, so activity that
 * arrived while this waited keeps the machine awake. Resolves the machines
 * it put to sleep.
 */
export function sleepSessionSandboxes(
  sessionId: string,
  options: {
    reason: SandboxSleepReason;
    /** Only this machine (the workspace or the Portal Sandbox). */
    sandboxId?: string;
    stillIdle?: (sandboxId: string) => boolean;
  },
): Promise<SleptSandbox[]> {
  return withSessionLifecycleLane(sessionId, async () => {
    const slept: SleptSandbox[] = [];
    const session = await findSessionAsync(sessionId);
    if (!session) return slept;
    const archived = isArchivedId(sessionId);
    const busy = hostRunBusy(sessionId) || isAgentSessionBusy(sessionId);
    const label = options.reason === "archived" ? "archived" : "idle";

    const workspace = session.sandbox;
    const workspaceProvider = workspace?.provider
      ? getSandboxProvider(workspace.provider)
      : undefined;
    if (
      workspace?.sandboxId &&
      (!options.sandboxId || options.sandboxId === workspace.sandboxId) &&
      workspaceProvider?.pause &&
      !sandboxSleepSkipReason({
        reason: options.reason,
        archived,
        busy,
        record: workspace,
        canPause: true,
        stillIdle: options.stillIdle?.(workspace.sandboxId),
      })
    ) {
      const sandboxId = workspace.sandboxId;
      // Only a machine that is already awake is checkpointed; waking one to
      // capture it would spend a start to then stop it again.
      const live = await activeSandboxFor(session).catch(() => null);
      if (live)
        await checkpointSessionWorkspace(session, live).catch((error) =>
          console.warn(
            `[sandbox] ${sessionId}: checkpoint before ${label} sleep failed:`,
            error instanceof Error ? error.message : String(error),
          ),
        );
      suspendSandboxPreviewRoutes(sandboxId);
      touchNativeSession(sessionId, {
        sandbox: {
          ...workspace,
          lifecycle: "sleeping",
          lastLifecycleError: undefined,
        },
      });
      await workspaceProvider.pause(sandboxId);
      slept.push({ kind: "workspace", sandboxId });
      console.log(`[sandbox] ${sessionId}: ${label}, ${sandboxId} asleep`);
    }

    // A host session's Portal Sandbox holds only its dev server; the host
    // worktree is the source of truth, so nothing needs capturing.
    const portal = session.portalSandbox;
    const portalProvider = portal?.provider
      ? getSandboxProvider(portal.provider)
      : undefined;
    if (
      portal?.sandboxId &&
      (!options.sandboxId || options.sandboxId === portal.sandboxId) &&
      portalProvider?.pause &&
      !sandboxSleepSkipReason({
        reason: options.reason,
        archived,
        // An archived session's turn never uses its Portal Sandbox; an idle
        // one may be driving the app right now.
        busy: options.reason === "idle" ? busy : false,
        record: portal,
        canPause: true,
        stillIdle: options.stillIdle?.(portal.sandboxId),
      }) &&
      (await activePortalSandboxFor(session).catch(() => null))
    ) {
      const sandboxId = portal.sandboxId;
      suspendSandboxPreviewRoutes(sandboxId);
      touchNativeSession(sessionId, {
        portalSandbox: {
          ...portal,
          lifecycle: "sleeping",
          lastLifecycleError: undefined,
        },
      });
      await portalProvider.pause(sandboxId);
      slept.push({ kind: "portal", sandboxId });
      console.log(
        `[sandbox] ${sessionId}: ${label}, Portal Sandbox ${sandboxId} asleep`,
      );
    }
    return slept;
  });
}
