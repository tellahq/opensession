/**
 * Put an archived session's Sandboxes to sleep.
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
 * admitted or running is left alone; its idle timer still applies.
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

/** Why an archived session's Sandbox is left running, or null to sleep it. */
export function archiveSleepSkipReason(input: {
  archived: boolean;
  busy: boolean;
  record?: { provider?: string; sandboxId?: string; lifecycle?: string };
  canPause: boolean;
}): string | null {
  if (!input.archived) return "unarchived";
  if (!input.record?.provider || !input.record.sandboxId) return "no machine";
  if (!isRemoteSandboxProvider(input.record.provider)) return "local";
  if (!input.canPause) return "no sleep support";
  if (input.record.lifecycle === "sleeping") return "asleep";
  if (input.busy) return "turn running";
  return null;
}

export function sleepArchivedSessionSandboxes(
  sessionId: string,
): Promise<void> {
  return withSessionLifecycleLane(sessionId, async () => {
    const session = await findSessionAsync(sessionId);
    if (!session) return;
    const archived = isArchivedId(sessionId);
    const busy = hostRunBusy(sessionId) || isAgentSessionBusy(sessionId);

    const workspace = session.sandbox;
    const workspaceProvider = workspace?.provider
      ? getSandboxProvider(workspace.provider)
      : undefined;
    if (
      workspace?.sandboxId &&
      workspaceProvider?.pause &&
      !archiveSleepSkipReason({
        archived,
        busy,
        record: workspace,
        canPause: true,
      })
    ) {
      const sandboxId = workspace.sandboxId;
      // Only a machine that is already awake is checkpointed; waking one to
      // capture it would spend a start to then stop it again.
      const live = await activeSandboxFor(session).catch(() => null);
      if (live)
        await checkpointSessionWorkspace(session, live).catch((error) =>
          console.warn(
            `[sandbox] ${sessionId}: checkpoint before archive sleep failed:`,
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
      console.log(`[sandbox] ${sessionId}: archived, ${sandboxId} asleep`);
    }

    // A host session's Portal Sandbox holds only its dev server; the host
    // worktree is the source of truth, so nothing needs capturing.
    const portal = session.portalSandbox;
    const portalProvider = portal?.provider
      ? getSandboxProvider(portal.provider)
      : undefined;
    if (
      portal?.sandboxId &&
      portalProvider?.pause &&
      !archiveSleepSkipReason({
        archived,
        busy: false,
        record: portal,
        canPause: true,
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
      console.log(
        `[sandbox] ${sessionId}: archived, Portal Sandbox ${sandboxId} asleep`,
      );
    }
  });
}
