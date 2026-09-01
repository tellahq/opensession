import type { UnifiedSession } from "./types";

/** The unscoped live list, kept as a compatibility fallback. */
export const LIVE_QUERY = "?archived=exclude";
/** The archived index: the narrow row the Archived surfaces render. */
export const ARCHIVED_QUERY = "?archived=only&slim=1";
/** Slow ETagged fallback for archives changed on another device. */
export const ARCHIVED_POLL_MS = 30_000;
/** WebSocket invalidations are primary; this repairs missed frames. */
export const LIVE_POLL_FALLBACK_MS = 60_000;

export interface SidebarSessionsQueryOptions {
  user: string;
  person: string;
  repo: string;
  autoCreated: "show" | "hide";
  selectedSessionId?: string;
  selectedWorkspaceId?: string;
}

/** Build the opt-in server-side projection used by the left sidebar. */
export function sidebarSessionsQuery(
  options: SidebarSessionsQueryOptions,
): string {
  const params = new URLSearchParams({
    archived: "exclude",
    view: "sidebar",
    user: options.user,
    person: options.person,
    repo: options.repo,
    autoCreated: options.autoCreated,
  });
  if (options.selectedSessionId)
    params.set("session", options.selectedSessionId);
  if (options.selectedWorkspaceId)
    params.set("workspace", options.selectedWorkspaceId);
  return `?${params.toString()}`;
}

export function sessionPatchNeedsAcknowledgement(
  patch: Partial<UnifiedSession>,
): boolean {
  // Runtime state can arrive over the socket before the indexed list sees it.
  return "archived" in patch || "isRunning" in patch;
}

/** Fence responses to the selected-session projection that requested them. */
export function liveSnapshotMatchesQuery(
  requestQuery: string,
  currentQuery: string,
): boolean {
  return requestQuery === currentQuery;
}

export function detachPendingRequest<T>(
  requestRef: { current: T | null },
  abortRef: { current: AbortController | null },
): void {
  const controller = abortRef.current;
  requestRef.current = null;
  abortRef.current = null;
  controller?.abort();
}

export interface PendingSessionPatch {
  values: Partial<UnifiedSession>;
  /** Runtime revision when a WebSocket status frame was applied. */
  runtimeRevision?: number;
}

export interface StickySession {
  session: UnifiedSession;
  /** The selected-session projection has returned an authoritative copy. */
  serverSeen: boolean;
}

/** Keep a just-created row available while its session remains selected. */
export function reconcileStickySessions(
  sessions: UnifiedSession[],
  sticky: Map<string, StickySession>,
  selectedSessionId?: string,
): UnifiedSession[] {
  if (sticky.size === 0) return sessions;
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const extras: UnifiedSession[] = [];
  for (const [id, pending] of sticky) {
    const serverSession = byId.get(id);
    if (serverSession) {
      if (selectedSessionId === id) {
        pending.session = serverSession;
        pending.serverSeen = true;
      } else {
        sticky.delete(id);
      }
      continue;
    }
    if (pending.serverSeen && selectedSessionId !== id) {
      sticky.delete(id);
      continue;
    }
    extras.push(pending.session);
  }
  return extras.length ? [...sessions, ...extras] : sessions;
}

export function reconcilePendingSessionPatches(
  sessions: UnifiedSession[],
  pendingPatches: Map<string, PendingSessionPatch>,
  snapshotRuntimeRevision = -1,
): UnifiedSession[] {
  if (pendingPatches.size) {
    const present = new Set(sessions.map((session) => session.id));
    for (const [id, pending] of pendingPatches)
      if (pending.values.archived === true && !present.has(id))
        pendingPatches.delete(id);
  }
  return sessions.map((session) => {
    const pending = pendingPatches.get(session.id);
    if (!pending) return session;
    if (
      pending.runtimeRevision !== undefined &&
      snapshotRuntimeRevision >= pending.runtimeRevision
    ) {
      delete pending.values.isRunning;
      delete pending.values.runStartedAt;
      delete pending.runtimeRevision;
    }
    if (Object.keys(pending.values).length === 0) {
      pendingPatches.delete(session.id);
      return session;
    }
    const acknowledged = Object.entries(pending.values).every(
      ([key, value]) => session[key as keyof UnifiedSession] === value,
    );
    if (acknowledged) {
      pendingPatches.delete(session.id);
      return session;
    }
    return { ...session, ...pending.values };
  });
}
