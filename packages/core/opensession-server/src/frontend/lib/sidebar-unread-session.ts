import type { UnifiedSession } from "./types";
import { isUnread } from "./reads";

/** Unread activity earns bold emphasis once the agent has stopped producing it. */
export function shouldEmphasizeUnread(
  unread: boolean,
  isRunning: boolean,
): boolean {
  return unread && !isRunning;
}

/**
 * Pick the tab that makes an aggregated workspace row unread.
 *
 * Parent sessions are the tabs a person can open. Spawned workers stay out when
 * a parent exists, matching the sidebar row's unread calculation. If several
 * tabs are unread, the newest activity is the best answer to a click on the
 * aggregate row.
 */
export function pickUnreadWorkspaceSession(
  sessions: UnifiedSession[],
  selectedId: string | null,
  reads: Record<string, string>,
): UnifiedSession | undefined {
  const live = sessions.filter((session) => !session.archived);
  const parents = live.filter((session) => !session.parentSessionId);
  const candidates = parents.length > 0 ? parents : live;

  return candidates
    .filter(
      (session) =>
        session.id !== selectedId &&
        isUnread(session.id, session.lastActivity, reads),
    )
    .sort((a, b) =>
      (b.lastActivity || "").localeCompare(a.lastActivity || ""),
    )[0];
}
