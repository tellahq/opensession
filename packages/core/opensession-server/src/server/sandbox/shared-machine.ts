/**
 * Tabs of one workspace that share a remote Sandbox machine.
 *
 * A remote Sandbox keeps its workspace on its own disk, so a new tab in that
 * workspace has no host checkout to join. It joins the machine instead: both
 * records carry `sandboxHost`, the session id the provider keys the machine
 * by (the first tab names itself), and the new tab records the same
 * `sandboxId`. A record without `sandboxHost` was never shared and keeps the
 * one-session-one-machine behavior everywhere.
 *
 * Every tab on a machine is a peer. The machine is destroyed only with the
 * last tab, an archived tab does not put it to sleep while another is live,
 * no tab sleeps it during another tab's turn, and moves and rebuilds, which
 * replace the machine, are refused while it is shared. Peers are found
 * through the workspace's catalog rows and confirmed one known session at a
 * time, never by scanning sessions.
 */
import { isArchivedId } from "../archive";
import { findSessionAsync, updateSessionFile } from "../session-cache";
import { indexedWorkspaceMembers } from "../session-list-store";
import type { UnifiedSession } from "../types";
import { isRemoteSandboxProvider } from "./config";

type MachineSession = Pick<
  UnifiedSession,
  "id" | "sandbox" | "sandboxHost" | "workspaceId"
>;

/** The session id the provider keys this session's machine by. */
export function sandboxHostSessionId(
  session: Pick<UnifiedSession, "id" | "sandboxHost">,
): string {
  return session.sandboxHost || session.id;
}

/** Whether this session's machine was ever shared with another tab. */
export function sandboxShared(session: Pick<UnifiedSession, "sandboxHost">) {
  return Boolean(session.sandboxHost);
}

/**
 * Where a new tab of `source` works. A share tab of a remote Sandbox session
 * joins its machine, since the workspace exists only there. A stack would
 * need a second checkout inside the machine, and a Runner's workspace and an
 * automation's disposable Sandbox are not shared: those refuse, as does any
 * other workspace that is not on this host. Ask tabs read the repository's
 * own checkout and never need the source's workspace.
 */
export function newTabWorkspace(
  source: Pick<
    UnifiedSession,
    "source" | "sandbox" | "runner" | "automation" | "automationId"
  >,
  mode: "share" | "stack" | "ask",
  remoteWorkspace: boolean,
): "host" | "join" | { error: string } {
  if (!remoteWorkspace || mode === "ask") return "host";
  if (
    mode === "share" &&
    source.source === "opensession" &&
    source.sandbox?.workspace === "volume" &&
    isRemoteSandboxProvider(source.sandbox.provider) &&
    !source.runner &&
    !source.automation &&
    !source.automationId
  )
    return "join";
  return {
    error:
      mode === "stack" && !source.runner
        ? "Stacked tabs aren't supported in a Sandbox yet. Open a normal tab to share this Sandbox."
        : "This session's workspace can't be shared with a new tab. Open an Ask tab instead.",
  };
}

/** Whether two sessions run on the same machine. */
export function sameSandboxMachine(
  a: MachineSession,
  b: MachineSession,
): boolean {
  if (!a.sandboxHost || !b.sandboxHost) return false;
  if (!a.sandbox?.provider || a.sandbox.provider !== b.sandbox?.provider)
    return false;
  return a.sandboxHost === b.sandboxHost;
}

/**
 * The other sessions that still exist on this session's machine, archived
 * ones included unless `liveOnly`. Empty for a machine never shared. Throws
 * when the catalog cannot answer; callers keep the machine in that case.
 */
export async function sandboxPeers(
  session: MachineSession,
  options: { liveOnly?: boolean } = {},
): Promise<UnifiedSession[]> {
  if (!sandboxShared(session) || !session.workspaceId) return [];
  if (!isRemoteSandboxProvider(session.sandbox?.provider)) return [];
  const peers: UnifiedSession[] = [];
  for (const member of await indexedWorkspaceMembers(session.workspaceId)) {
    if (member.id === session.id || !sameSandboxMachine(session, member))
      continue;
    // A deleted session's catalog row can outlive it for a moment. Counting
    // it would keep the machine alive after its last real tab is gone.
    const current = await findSessionAsync(member.id);
    if (!current || !sameSandboxMachine(session, current)) continue;
    if (options.liveOnly && (current.archived || isArchivedId(current.id)))
      continue;
    peers.push(current);
  }
  return peers;
}

/** Whether a turn is admitted or running in any other tab on the machine.
 * A catalog failure reads as busy: a sleep then waits for the next sweep. */
export async function sandboxPeerBusy(
  session: MachineSession,
  busy: (sessionId: string) => boolean,
): Promise<boolean> {
  if (!sandboxShared(session)) return false;
  try {
    return (await sandboxPeers(session)).some((peer) => busy(peer.id));
  } catch {
    return true;
  }
}

/** Refusal for an operation that replaces or releases the machine. */
export async function sharedSandboxRefusal(
  session: MachineSession,
): Promise<string | null> {
  if (!sandboxShared(session)) return null;
  let peers: UnifiedSession[];
  try {
    peers = await sandboxPeers(session);
  } catch {
    return "Could not check the other tabs on this Sandbox. Try again.";
  }
  if (!peers.length) return null;
  return "Other tabs in this workspace run in this Sandbox. Archive or delete them first.";
}

type LifecyclePatch = Partial<
  Pick<
    NonNullable<UnifiedSession["sandbox"]>,
    "sandboxId" | "workspace" | "lifecycle" | "lastLifecycleError"
  >
>;

/**
 * Mirror one tab's machine state onto every other tab on the machine, so
 * each shows the same Sandbox state and reaches the same machine. Each
 * record is rewritten from its current copy and only while it still names
 * this machine. Best effort: a tab that misses a write reconciles on its next
 * turn.
 */
export async function mirrorSandboxToPeers(
  session: MachineSession,
  patch: LifecyclePatch,
): Promise<void> {
  if (!sandboxShared(session)) return;
  let peers: UnifiedSession[];
  try {
    peers = await sandboxPeers(session);
  } catch (error) {
    console.warn(
      `[sandbox] ${session.id}: could not mirror the Sandbox state to its other tabs:`,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  for (const peer of peers)
    await updateSessionFile(peer.id, (data) =>
      data.sandbox &&
      data.sandboxHost === session.sandboxHost &&
      data.sandbox.provider === session.sandbox?.provider
        ? { ...data, sandbox: { ...data.sandbox, ...patch } }
        : data,
    ).catch((error) =>
      console.warn(
        `[sandbox] ${peer.id}: could not mirror the Sandbox state:`,
        error instanceof Error ? error.message : String(error),
      ),
    );
}
