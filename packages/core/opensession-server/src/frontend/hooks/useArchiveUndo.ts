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
  /** Close the new-session palette, which archiving a workspace's last chat opens. */
  hideNewSession: () => void;
};

type ArchiveUndoEntry = { ids: string[]; at: number };

export function useArchiveUndo({
  sessions,
  patch,
  refresh,
  navigate,
  showToast,
  forgetLastSession,
  hideNewSession,
}: ArchiveUndoParams) {
  // Each entry is one archive action: the sessions it tucked away and when.
  const [archiveUndo, setArchiveUndo] = useState<ArchiveUndoEntry[]>([]);
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
          .map((entry) => ({
            ...entry,
            ids: entry.ids.filter((id) => !ids.includes(id)),
          }))
          .filter((entry) => entry.ids.length),
        { ids, at: Date.now() },
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
  const restorable: { sessions: UnifiedSession[]; at: number } = (() => {
    const none = { sessions: [], at: 0 };
    if (!archiveUndo.length) return none;
    const wanted = new Set(archiveUndo.flatMap((entry) => entry.ids));
    const byId = new Map<string, UnifiedSession>();
    for (const s of sessions) {
      if (s.archived && wanted.has(s.id)) byId.set(s.id, s);
    }
    for (let i = archiveUndo.length - 1; i >= 0; i--) {
      const sessions = archiveUndo[i].ids
        .map((id) => byId.get(id))
        .filter((s): s is UnifiedSession => !!s);
      if (sessions.length) return { sessions, at: archiveUndo[i].at };
    }
    return none;
  })();
  const restorableArchived = restorable.sessions;
  const restorableArchivedRef = useRef(restorable);
  useLayoutEffect(() => {
    restorableArchivedRef.current = restorable;
  });

  // ⌘Z (and the palette's "Reopen closed session"): undo the last archive and
  // land on what came back. The entry is only dropped once the server agrees,
  // so a failed restore stays retryable.
  const reopenLastArchived = async () => {
    const { sessions } = restorableArchivedRef.current;
    if (!sessions.length) {
      showToast("Nothing to reopen");
      return;
    }
    if (!(await unarchiveSessions(sessions))) return;
    const ids = new Set(sessions.map((c) => c.id));
    setArchiveUndo((prev) =>
      prev
        .map((entry) => ({
          ...entry,
          ids: entry.ids.filter((id) => !ids.has(id)),
        }))
        .filter((entry) => entry.ids.length),
    );
    // The palette overlays every view, so it would hide what came back.
    hideNewSession();
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
    restorableArchivedRef,
    reopenLastArchived,
    reopenLastArchivedRef,
  };
}
