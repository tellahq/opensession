import { useEffect, useState } from "react";
import { PERSON_RECENT_ACTIVITY_MS } from "../lib/sidebar-people";
import type { UnifiedSession } from "../lib/types";

export function useSidebarPeopleActivityNow(sessions: UnifiedSession[]) {
  const [peopleActivityNow, setPeopleActivityNow] = useState(Date.now);
  useEffect(() => {
    const now = Date.now();
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const session of sessions) {
      if (session.isRunning || !session.ran) continue;
      const lastActivity = Date.parse(session.lastActivity || "");
      if (!Number.isFinite(lastActivity)) continue;
      const expiry = lastActivity + PERSON_RECENT_ACTIVITY_MS;
      if (expiry > now && expiry < nextExpiry) nextExpiry = expiry;
    }
    if (!Number.isFinite(nextExpiry)) return;
    const timer = window.setTimeout(
      () => setPeopleActivityNow(Date.now()),
      Math.min(2_147_483_647, Math.max(0, nextExpiry - now + 50)),
    );
    return () => window.clearTimeout(timer);
  }, [sessions, peopleActivityNow]);
  return peopleActivityNow;
}
