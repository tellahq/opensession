import { useLayoutEffect, useRef, useState } from "react";
import { archiveSessionApi } from "../lib/api";
import type { Route } from "../lib/app-route";
import type { UnifiedSession } from "../lib/types";

type ArchiveUndoParams = {
  sessions: UnifiedSession[];
  patch: (id: string, patch: Partial<UnifiedSession>) => void;
  refresh: () => void;
  navigate: (next: Route, opts?: { replace?: boolean }) => void;
  showToast: (message: string) => void;
  forgetLastSession: (expected?: string | readonly string[]) => void;
};

export function useArchiveUndo({
  sessions,
  patch,
  refresh,
  navigate,
  showToast,
  forgetLastSession,
}: ArchiveUndoParams) {
  const [archiveUndo, setArchiveUndo] = useState<string[][]>([]);
  const rememberArchived = (ids: string[]) => {
    if (!ids.length) return;
    // Do not let a successful archive remain the PWA's cold-launch target if
    // iOS suspends it before the route change paints. A navigation to another
    // session writes that newer id back through App's route effect.
    forgetLastSession(ids);
    setArchiveUndo((prev) =>
      [
        // An id lives in one entry only: archiving a session again moves it to
        // the top instead of leaving a stale entry underneath.
        ...prev
          .map((entry) => entry.filter((id) => !ids.includes(id)))
          .filter((entry) => entry.length),
        ids,
      ]
        // An undo affordance, not a history.
        .slice(-10),
    );
  };

  // Bring archived sessions back. Optimistic like the archive paths: the local
  // list flips first so it feels instant, and rolls back if the server refuses.
  const unarchiveSessions = async (
    sessions: UnifiedSession[],
  ): Promise<boolean> => {
    if (!sessions.length) return false;
    const reasons = new Map(sessions.map((c) => [c.id, c.archivedReason]));
    for (const c of sessions) {
      patch(c.id, { archived: false, archivedReason: undefined });
    }
    try {
      await Promise.all(sessions.map((c) => archiveSessionApi(c.id, false)));
    } catch (e) {
      console.error("Unarchive failed:", e);
      for (const c of sessions) {
        patch(c.id, { archived: true, archivedReason: reasons.get(c.id) });
      }
      return false;
    }
    refresh();
    return true;
  };
  const unarchiveSession = (session: UnifiedSession) =>
    unarchiveSessions([session]);

  // Archiving stays quiet. The row disappearing confirms the action, and the
  // app-wide undo shortcut restores the latest archived session or workspace.

  // The newest undo entry that's still restorable, resolved against the live
  // list: an entry whose sessions were unarchived elsewhere (or deleted) falls
  // through to the one below it, so ⌘Z never no-ops on a ghost.
  const restorableArchived: UnifiedSession[] = (() => {
    if (!archiveUndo.length) return [];
    const wanted = new Set(archiveUndo.flat());
    const byId = new Map<string, UnifiedSession>();
    for (const s of sessions) {
      if (s.archived && wanted.has(s.id)) byId.set(s.id, s);
    }
    for (let i = archiveUndo.length - 1; i >= 0; i--) {
      const sessions = archiveUndo[i]
        .map((id) => byId.get(id))
        .filter((s): s is UnifiedSession => !!s);
      if (sessions.length) return sessions;
    }
    return [];
  })();
  const restorableArchivedRef = useRef(restorableArchived);
  useLayoutEffect(() => {
    restorableArchivedRef.current = restorableArchived;
  });

  // ⌘Z (and the palette's "Reopen closed session"): undo the last archive and
  // land on what came back. The entry is only dropped once the server agrees,
  // so a failed restore stays retryable.
  const reopenLastArchived = async () => {
    const sessions = restorableArchivedRef.current;
    if (!sessions.length) {
      showToast("Nothing to reopen");
      return;
    }
    if (!(await unarchiveSessions(sessions))) return;
    const ids = new Set(sessions.map((c) => c.id));
    setArchiveUndo((prev) =>
      prev
        .map((entry) => entry.filter((id) => !ids.has(id)))
        .filter((entry) => entry.length),
    );
    navigate({ view: "session", id: sessions[0].id });
  };
  const reopenLastArchivedRef = useRef(reopenLastArchived);
  useLayoutEffect(() => {
    reopenLastArchivedRef.current = reopenLastArchived;
  });

  return {
    rememberArchived,
    unarchiveSession,
    restorableArchived,
    reopenLastArchived,
    reopenLastArchivedRef,
  };
}
