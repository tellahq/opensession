import { useEffect } from "react";
import {
  PERSON_RECENT_ACTIVITY_MS,
  type SidebarPersonSessions,
} from "../lib/sidebar-people";

/**
 * Advances the People list's clock when a session it shows leaves its recent
 * window. Only listed sessions are timed: a session left out for any other
 * reason (yours, kept in your lanes, archived, already stale) stays out as
 * time passes, so its expiry cannot change the list and must not re-render
 * the whole sidebar. A listed session already past its window refreshes the
 * clock at once.
 */
export function useSidebarPeopleActivityExpiry(
  groups: SidebarPersonSessions[],
  now: number,
  setNow: (now: number) => void,
) {
  useEffect(() => {
    const current = Date.now();
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const group of groups) {
      for (const session of group.activeSessions) {
        if (session.isRunning) continue;
        const lastActivity = Date.parse(session.lastActivity || "");
        if (!Number.isFinite(lastActivity)) continue;
        nextExpiry = Math.min(
          nextExpiry,
          lastActivity + PERSON_RECENT_ACTIVITY_MS,
        );
      }
    }
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(2_147_483_647, Math.max(0, nextExpiry - current) + 50),
    );
    return () => window.clearTimeout(timer);
  }, [groups, now, setNow]);
}
