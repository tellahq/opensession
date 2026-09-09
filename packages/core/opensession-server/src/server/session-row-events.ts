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
 * A single bounded batch shares catalog reads across changed rows and never
 * overlaps the next batch. Bursts coalesce per session. The client keeps a slow
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

type ProjectedRow = Awaited<
  ReturnType<typeof import("./routes/sessions").sidebarRowProjection>
>;
const SESSION_ROW_BATCH_SIZE = 64;

/** One publisher for all rows, not one async flush per session. A slow catalog
 * read holds this batch while later writes coalesce into the next one. */
export function createSessionRowPublisher(options: {
  loadRow: (sessionId: string) => Promise<ProjectedRow | null>;
  subscribers: typeof sidebarSubscribers;
  loadContext: typeof loadSidebarSessionScopeContext;
  onError: (error: unknown) => void;
}) {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushing: Promise<void> | undefined;

  function schedule(): void {
    if (timer || flushing || pending.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush().catch(options.onError);
    }, SESSION_ROW_COALESCE_MS);
    timer.unref?.();
  }

  async function publishBatch(ids: string[]): Promise<void> {
    const subscribers = options.subscribers();
    if (subscribers.size === 0) return;
    const rows = new Map<string, ProjectedRow | null>();
    const group = new Map<string, UnifiedSession>();
    // Keep index/projection calls bounded too, rather than turning a batch
    // into another Promise.all burst against a worker mailbox.
    for (const id of ids) {
      try {
        const projected = await options.loadRow(id);
        rows.set(id, projected);
        for (const member of projected?.group ?? [])
          group.set(member.id, member);
      } catch (error) {
        options.onError(error);
      }
    }
    const contexts = new Map<string, SidebarSessionScopeContext>();
    const needsContext = [...rows.values()].some((row) => row !== null);
    for (const { scope, sockets } of subscribers.values()) {
      try {
        let context = scope ? contexts.get(scope.user) : undefined;
        if (scope && !context && needsContext) {
          // The union includes every row's workspace and parent dependencies.
          // Reusing a context loaded for just the first row hides other rows.
          context = await options.loadContext(scope, [...group.values()]);
          contexts.set(scope.user, context);
        }
        for (const [id, projected] of rows) {
          const rowId = projected?.row.id ?? id;
          const visible =
            projected &&
            (await sessionRowVisible(rowId, projected.group, scope, context));
          const payload = JSON.stringify(
            visible
              ? { type: "session_row", row: projected.row }
              : { type: "session_row_removed", id: rowId },
          );
          for (const ws of sockets) send(ws, payload);
        }
      } catch (error) {
        // A failed scope read must neither hide its rows nor starve other users.
        options.onError(error);
      }
    }
  }

  function flush(): Promise<void> {
    if (flushing) return flushing;
    if (timer) clearTimeout(timer);
    timer = undefined;
    const ids = [...pending].slice(0, SESSION_ROW_BATCH_SIZE);
    for (const id of ids) pending.delete(id);
    flushing = publishBatch(ids).finally(() => {
      flushing = undefined;
      schedule();
    });
    return flushing;
  }

  return {
    publish(sessionId: string) {
      pending.add(sessionId);
      schedule();
    },
    flush,
    pending: () => [...pending],
    reset() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
}

const g = globalThis as typeof globalThis & {
  __osSessionRowPublisher?: ReturnType<typeof createSessionRowPublisher>;
};
function publisher() {
  return (g.__osSessionRowPublisher ??= createSessionRowPublisher({
    async loadRow(sessionId) {
      const stored = await indexedSessionWithVisibilityGroup(sessionId);
      if (!stored) return null;
      // routes/sessions imports callers of this module.
      const { sidebarRowProjection } = await import("./routes/sessions");
      return sidebarRowProjection(stored.session, stored.group);
    },
    subscribers: sidebarSubscribers,
    loadContext: loadSidebarSessionScopeContext,
    onError(error) {
      console.warn(
        "[session-row] publish failed:",
        error instanceof Error ? error.message : error,
      );
    },
  }));
}

/** Tell subscribed sidebars that one session's row changed. Coalesced. */
export function publishSessionRow(sessionId: string): void {
  publisher().publish(sessionId);
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

function send(ws: RowSocket, payload: string): void {
  try {
    ws.send(payload);
  } catch {}
}

/** Session ids with a publish pending, in scheduling order. */
export function __scheduledSessionRowsForTest(): string[] {
  return g.__osSessionRowPublisher?.pending() ?? [];
}

export function __resetSessionRowPublishesForTest(): void {
  g.__osSessionRowPublisher?.reset();
}
