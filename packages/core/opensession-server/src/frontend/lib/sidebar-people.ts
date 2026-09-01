import { AGENT_PERSON_KEY } from "./automation-audience";
import { AGENT_NAME } from "./brand";
import type { Person } from "./people";
import {
  canonicalNames,
  ownerKey,
  ownerKeyOf,
  rosterNameFor,
} from "./session-owner";
import type { UnifiedSession } from "./types";

export const PERSON_RECENT_ACTIVITY_MS = 15 * 60 * 1000;

export interface SidebarPersonSessions {
  key: string;
  label: string;
  activeSessions: UnifiedSession[];
}

/**
 * A session stays in the compact People list while it is running and for the
 * first fifteen minutes after its latest run activity. `ran` keeps a newly
 * created, never-started session from looking active just because it is new.
 */
export function sessionIsRecentlyActive(
  session: UnifiedSession,
  nowMs: number,
): boolean {
  if (session.isRunning) return true;
  if (!session.ran) return false;
  const lastActivityMs = Date.parse(session.lastActivity || "");
  return (
    Number.isFinite(lastActivityMs) &&
    lastActivityMs >= nowMs - PERSON_RECENT_ACTIVITY_MS
  );
}

/**
 * Other people with active work, directory-gated so worker labels, goals,
 * integrations and arbitrary `startedBy` strings never become people. The
 * signed-in person's sessions already live in the workspace lanes above, so
 * this list excludes them instead of rendering every active row twice.
 * Unowned automations file under the Agent person; owned automations file under
 * their configured teammate.
 *
 * Active sessions retain the incoming order. Sessions already kept in personal
 * lanes are omitted so Team remains the place to discover work that is not yet
 * in your sidebar.
 */
export function sidebarPersonSessions(
  sessions: UnifiedSession[],
  roster: Person[],
  currentUser: string,
  nowMs: number,
  automationOwners: ReadonlyMap<string, string | undefined> = new Map(),
  keptSessionIds: ReadonlySet<string> = new Set(),
): SidebarPersonSessions[] {
  const canonical = canonicalNames(roster);
  const currentUserKey = ownerKey(currentUser, canonical);
  const groups = new Map<string, SidebarPersonSessions>();

  for (const session of sessions) {
    if (
      session.archived ||
      session.desk ||
      keptSessionIds.has(session.id) ||
      !sessionIsRecentlyActive(session, nowMs)
    )
      continue;

    let key: string;
    let label: string | null;
    if (session.automation) {
      const automationOwner = automationOwners.get(session.automation)?.trim();
      if (automationOwner) {
        label = rosterNameFor(automationOwner, canonical);
        key = ownerKey(automationOwner, canonical);
      } else {
        label = AGENT_NAME;
        key = AGENT_PERSON_KEY;
      }
    } else {
      if (!session.startedBy) continue;
      label = rosterNameFor(session.startedBy, canonical);
      key = ownerKeyOf(session, canonical);
    }
    if (!label || key === currentUserKey) continue;

    let group = groups.get(key);
    if (!group) {
      group = { key, label, activeSessions: [] };
      groups.set(key, group);
    }
    group.activeSessions.push(session);
  }

  return Array.from(groups.values());
}
