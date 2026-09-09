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
 * Bursts inside one turn coalesce per session. The client keeps a slow
 * fallback poll and refetches on reconnect, so a lost frame heals the same
 * way a lost invalidation did.
 */
import { indexedSessionWithVisibilityGroup } from "./session-list-store";
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
  __osSessionRowPublishes?: Map<string, ReturnType<typeof setTimeout>>;
};
const scheduled = (g.__osSessionRowPublishes ??= new Map());

/** Tell subscribed sidebars that one session's row changed. Coalesced. */
export function publishSessionRow(sessionId: string): void {
  if (scheduled.has(sessionId)) return;
  const timer = setTimeout(() => {
    scheduled.delete(sessionId);
    void flushSessionRow(sessionId).catch((error) => {
      console.warn(
        `[session-row] publish failed for ${sessionId}:`,
        error instanceof Error ? error.message : error,
      );
    });
  }, SESSION_ROW_COALESCE_MS);
  timer.unref?.();
  scheduled.set(sessionId, timer);
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

async function flushSessionRow(sessionId: string): Promise<void> {
  const subscribers = sidebarSubscribers();
  if (subscribers.size === 0) return;
  // One worker round trip: the row and the rows its visibility depends on.
  const stored = await indexedSessionWithVisibilityGroup(sessionId);
  if (!stored) {
    const payload = JSON.stringify({
      type: "session_row_removed",
      id: sessionId,
    });
    for (const { sockets } of subscribers.values())
      for (const ws of sockets) send(ws, payload);
    return;
  }
  // routes/sessions imports this module's callers; load it on demand so the
  // row projection is shared with the list route without an import cycle.
  const { sidebarRowProjection } = await import("./routes/sessions");
  const { row, group } = await sidebarRowProjection(
    stored.session,
    stored.group,
  );
  const shown = JSON.stringify({ type: "session_row", row });
  const removed = JSON.stringify({
    type: "session_row_removed",
    id: sessionId,
  });
  const contexts = new Map<string, SidebarSessionScopeContext>();
  for (const { scope, sockets } of subscribers.values()) {
    let context = scope ? contexts.get(scope.user) : undefined;
    if (scope && !context) {
      context = await loadSidebarSessionScopeContext(scope, group);
      contexts.set(scope.user, context);
    }
    const payload = (await sessionRowVisible(row.id, group, scope, context))
      ? shown
      : removed;
    for (const ws of sockets) send(ws, payload);
  }
}

function send(ws: RowSocket, payload: string): void {
  try {
    ws.send(payload);
  } catch {}
}

/** Session ids with a publish pending, in scheduling order. */
export function __scheduledSessionRowsForTest(): string[] {
  return [...scheduled.keys()];
}

export function __resetSessionRowPublishesForTest(): void {
  for (const timer of scheduled.values()) clearTimeout(timer);
  scheduled.clear();
}
