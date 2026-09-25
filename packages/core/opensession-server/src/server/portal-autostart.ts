/**
 * Start a new session's Portal as soon as its workspace exists.
 *
 * Chosen in the New session composer ("Boot a Sandbox for <Portal>"). A dev server
 * can take minutes to come up and warm, and until now that clock only
 * started when someone opened the Portals panel. Started with the session,
 * it comes up while the agent reads code and makes its first changes.
 *
 * Runs detached from the create: it waits for the workspace (the worktree,
 * or the session's Sandbox) to be ready, then starts the repository's first
 * Portal recipe exactly as the panel's start button does. A failure is only
 * logged; the Portals panel still offers a manual start.
 */
import { findSessionAsync } from "./session-cache";
import { preparingWorkspaces } from "./ws-hub";
import type { UnifiedSession } from "./types";

const WORKSPACE_WAIT_MS = 20 * 60_000;
const POLL_MS = 2_000;

const starting = new Set<string>();

/** Whether the session's workspace can take a Portal now. */
export function portalWorkspaceReady(
  session: Pick<UnifiedSession, "worktreeDir" | "sandbox" | "runner">,
  preparing: boolean,
): boolean {
  if (preparing || !session.worktreeDir) return false;
  // A workspace Sandbox has a machine once the opening run brought it up.
  if (session.sandbox?.provider && !session.sandbox.sandboxId) return false;
  return true;
}

/** Whether this process is starting the session's Portal with it. */
export function portalAutostarting(sessionId: string): boolean {
  return starting.has(sessionId);
}

/**
 * What the agent needs to know about its Portals before its first tool
 * call, or null when nothing differs from a Portal run beside it. Without
 * it an agent reads the repo's local dev-server instructions, probes
 * localhost and port files, and starts a Portal the session is already
 * starting.
 */
export function portalsContextNote(input: {
  inPortalSandbox: boolean;
  autostarting: boolean;
}): string | null {
  const lines: string[] = [];
  if (input.autostarting)
    lines.push(
      "This session's Portal is already starting (it was requested with the session). Do not start it again: list_portals shows when it is up and whether its first pages are still compiling.",
    );
  if (input.inPortalSandbox)
    lines.push(
      "This repo's Portals run on their own Sandbox machine, not in this shell. localhost, port files, and repo scripts that start or expect a local dev server do not reach them. Use the Portal tools and the URL they report; that URL needs the person's sign-in, so a curl from this shell gets 401.",
    );
  return lines.length ? lines.join("\n") : null;
}

export function autostartSessionPortal(
  sessionId: string,
  options: { waitMs?: number; pollMs?: number } = {},
): void {
  if (starting.has(sessionId)) return;
  starting.add(sessionId);
  void (async () => {
    const deadline = Date.now() + (options.waitMs ?? WORKSPACE_WAIT_MS);
    let session: UnifiedSession | undefined;
    for (;;) {
      session = await findSessionAsync(sessionId);
      if (!session) return;
      if (portalWorkspaceReady(session, preparingWorkspaces.has(sessionId)))
        break;
      if (Date.now() > deadline) {
        console.warn(
          `[portals] ${sessionId}: workspace not ready; Portal not started`,
        );
        return;
      }
      await Bun.sleep(options.pollMs ?? POLL_MS);
    }
    const { startSessionPortal } = await import("./routes/preview");
    const started = Date.now();
    // The opening turn is usually running by now. A Portal Sandbox captures
    // the worktree when it is provisioned, which a running turn normally
    // blocks: the capture could catch a file mid-edit. Here the worktree was
    // created moments ago, and the Portal Sandbox receives the finished
    // tree after every turn (portal-sandbox.ts), so an early capture only
    // means the app starts on the tree as the session began.
    const status = await startSessionPortal(session, undefined, {
      ownTurn: true,
    });
    const portal = status.services.find((service) => service.managed);
    console.log(
      `[portals] ${sessionId}: started ${portal?.name ?? "Portal"} with the session (${Math.round((Date.now() - started) / 1000)}s)`,
    );
  })()
    .catch((error) =>
      console.warn(
        `[portals] ${sessionId}: could not start the Portal with the session:`,
        error instanceof Error ? error.message : String(error),
      ),
    )
    .finally(() => starting.delete(sessionId));
}
