/**
 * Row-level session list fan-out.
 *
 * A metadata write used to broadcast `sessions_invalidated` to every socket,
 * and every visible client re-read its whole sidebar projection. That costs
 * O(clients) list rebuilds per write. Here a write publishes one row: the
 * server evaluates the changed session against each subscribed sidebar scope
 * and sends `session_row` (visible) or `session_row_removed` (not visible) to
 * the sockets rendering that scope. Cost is O(distinct scopes) per coalesced
 * write, and a frame is a few hundred bytes.
 *
 * Every session changed inside one window flushes together. The client keeps a slow
 * fallback poll and refetches on reconnect, so a lost frame heals the same
 * way a lost invalidation did.
 */
import { indexedSessionWithVisibilityGroup } from "./session-list-store";
import { sessionMetadata } from "./session-kernel";
import {
  loadSidebarSessionScopeContext,
  scopeSessionsForSidebar,
  sidebarSessionScopeKey,
  type SidebarSessionScope,
  type SidebarSessionScopeContext,
} from "./sidebar-session-scope";
import type { UnifiedSession } from "./types";
import { allClients } from "./ws-hub";

export const SESSION_ROW_COALESCE_MS = 250;

type RowSocket = {
  data: { sidebarScope?: SidebarSessionScope | null };
  send(data: string): unknown;
};

const g = globalThis as typeof globalThis & {
  __osSessionRowBatch?: {
    pending: Set<string>;
    timer?: ReturnType<typeof setTimeout>;
    flushing?: Promise<void>;
  };
};
const batch = (g.__osSessionRowBatch ??= { pending: new Set() });

/**
 * Tell subscribed sidebars that one session's row changed. Coalesced: every
 * session published inside one window flushes together, so the enrichment,
 * each viewer's scope context, and each scope's evaluation of a shared
 * workspace group are computed once per window instead of once per session.
 */
export function publishSessionRow(sessionId: string): void {
  batch.pending.add(sessionId);
  if (batch.timer) return;
  const timer = setTimeout(() => {
    batch.timer = undefined;
    // One flush at a time: a slow flush absorbs the next window instead of
    // running beside it on the gateway thread.
    const previous = batch.flushing ?? Promise.resolve();
    const run = previous.then(() => {
      const ids = [...batch.pending];
      batch.pending.clear();
      return flushSessionRows(ids).catch((error) => {
        console.warn(
          "[session-row] publish failed:",
          error instanceof Error ? error.message : error,
        );
      });
    });
    const tracked: Promise<void> = run.finally(() => {
      if (batch.flushing === tracked) batch.flushing = undefined;
    });
    batch.flushing = tracked;
  }, SESSION_ROW_COALESCE_MS);
  timer.unref?.();
  batch.timer = timer;
}

/** Sockets that asked for row frames, grouped by the scope they render. */
export function sidebarSubscribers(
  clients: Iterable<RowSocket> = allClients as Iterable<RowSocket>,
): Map<string, { scope: SidebarSessionScope | null; sockets: RowSocket[] }> {
  const byScope = new Map<
    string,
    { scope: SidebarSessionScope | null; sockets: RowSocket[] }
  >();
  for (const ws of clients) {
    const scope = ws.data?.sidebarScope;
    if (scope === undefined) continue;
    const key = scope ? sidebarSessionScopeKey(scope) : "";
    const entry = byScope.get(key) ?? { scope, sockets: [] };
    entry.sockets.push(ws);
    byScope.set(key, entry);
  }
  return byScope;
}

/** Whether `sessionId` renders in `scope`. `group` holds the enriched rows
 * the scope rules consult (the session itself, its workspace or worktree
 * siblings, and its parent chain). */
export async function sessionRowVisible(
  sessionId: string,
  group: UnifiedSession[],
  scope: SidebarSessionScope | null,
  providedContext?: SidebarSessionScopeContext,
): Promise<boolean> {
  const row = group.find((session) => session.id === sessionId);
  if (!row || row.archived) return false;
  if (!scope) return true;
  const context =
    providedContext ?? (await loadSidebarSessionScopeContext(scope, group));
  return scopeSessionsForSidebar(group, scope, context).some(
    (session) => session.id === sessionId,
  );
}

type StoredRow = { session: UnifiedSession; group: UnifiedSession[] };

async function flushSessionRows(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  const subscribers = sidebarSubscribers();
  if (subscribers.size === 0) return;
  // Missing index rows can mean "private", not "removed". Never broadcast a
  // hidden id in a removal event or trust a stale shared row over the catalog.
  const allowed = await Promise.all(
    sessionIds.map((sessionId) =>
      sessionMetadata({ op: "catalog_read", sessionId }).then(
        (access) => access.status !== "denied",
        () => false,
      ),
    ),
  );
  sessionIds = sessionIds.filter((_, index) => allowed[index]);
  if (sessionIds.length === 0) return;
  const removedFrame = (id: string) =>
    JSON.stringify({ type: "session_row_removed", id });
  const broadcast = (payload: string) => {
    for (const { sockets } of subscribers.values())
      for (const ws of sockets) send(ws, payload);
  };

  // The rows and the rows their visibility depends on, one worker round trip
  // per session, issued together.
  const stored = await Promise.all(
    sessionIds.map((id) =>
      indexedSessionWithVisibilityGroup(id).then(
        (row): StoredRow | null | undefined => row,
        (error) => {
          console.warn(
            `[session-row] publish failed for ${id}:`,
            error instanceof Error ? error.message : error,
          );
          return undefined;
        },
      ),
    ),
  );

  // Sessions of one workspace share one visibility group. Evaluate it once,
  // with every changed member's freshest copy swapped in.
  const groups = new Map<
    string,
    { members: Map<string, UnifiedSession>; changed: string[] }
  >();
  sessionIds.forEach((id, index) => {
    const entry = stored[index];
    if (entry === undefined) return;
    if (entry === null) {
      broadcast(removedFrame(id));
      return;
    }
    const key = entry.group
      .map((member) => member.id)
      .sort()
      .join("\u0000");
    let group = groups.get(key);
    if (!group) {
      group = {
        members: new Map(entry.group.map((member) => [member.id, member])),
        changed: [],
      };
      groups.set(key, group);
    }
    group.members.set(entry.session.id, entry.session);
    group.changed.push(entry.session.id);
  });
  if (groups.size === 0) return;

  // routes/sessions imports this module's callers; load it on demand so the
  // row projection is shared with the list route without an import cycle.
  const { sidebarRowsProjection } = await import("./routes/sessions");
  const projected = [];
  for (const { members, changed } of groups.values())
    projected.push(await sidebarRowsProjection(changed, [...members.values()]));
  // One scope context per viewer for the whole window. It must know every
  // workspace the window's groups belong to.
  const everyRow = projected.flatMap(({ group }) => group);
  const contexts = new Map<string, Promise<SidebarSessionScopeContext>>();
  for (const { rows, group } of projected) {
    const frames = rows.map((row) => ({
      id: row.id,
      shown: JSON.stringify({ type: "session_row", row }),
      removed: removedFrame(row.id),
    }));
    for (const { scope, sockets } of subscribers.values()) {
      let visible: Set<string>;
      if (!scope) {
        visible = new Set(
          group.filter((row) => !row.archived).map((row) => row.id),
        );
      } else {
        let context = contexts.get(scope.user);
        if (!context) {
          context = loadSidebarSessionScopeContext(scope, everyRow);
          contexts.set(scope.user, context);
        }
        visible = new Set(
          scopeSessionsForSidebar(group, scope, await context)
            .filter((row) => !row.archived)
            .map((row) => row.id),
        );
      }
      for (const frame of frames) {
        const payload = visible.has(frame.id) ? frame.shown : frame.removed;
        for (const ws of sockets) send(ws, payload);
      }
    }
  }
}

function send(ws: RowSocket, payload: string): void {
  try {
    ws.send(payload);
  } catch {}
}

/** Session ids with a publish pending, in scheduling order. */
export function __scheduledSessionRowsForTest(): string[] {
  return [...batch.pending];
}

export function __resetSessionRowPublishesForTest(): void {
  if (batch.timer) clearTimeout(batch.timer);
  batch.timer = undefined;
  batch.pending.clear();
}
