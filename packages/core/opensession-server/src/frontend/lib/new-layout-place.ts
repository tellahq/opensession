// The new layout's places (components/shell/Minibar.tsx) and which one a
// route belongs to.
//
// Most routes name their place. A session does not, because the same session
// can be reached from your own list or from Activity, and Activity has to keep
// its list beside the session you opened from it or you could not read through
// a teammate's work without the list changing under you. So a session keeps
// Activity when that is where you were, and otherwise belongs to Sessions.
//
// The route controller (hooks/useAppRoute.ts) owns the current place: it
// applies this rule on every route it commits, and keeps the answer on the
// history entry so Back and a reload restore it.

import type { Route } from "./app-route";

export type Place =
  | "sessions"
  | "channels"
  | "activity"
  | "support"
  | "library";

const PLACE_OF_VIEW: Partial<Record<Route["view"], Place>> = {
  archived: "sessions",
  channels: "channels",
  new: "sessions",
  feed: "activity",
  inbox: "activity",
  tasks: "activity",
  catchup: "activity",
  plain: "support",
  support: "support",
  supporttinder: "support",
  prs: "library",
  issues: "library",
  reports: "library",
  databases: "library",
  analytics: "library",
  automations: "library",
  goals: "library",
  security: "library",
};

/**
 * A place the route alone does not give, which its history entry therefore
 * has to record: a conversation opened from Activity, or a page you chose to
 * see your own list beside (the Sessions button, with no conversation to
 * return to).
 */
export type PlaceOverride = "activity" | "sessions";

/** The place `route` shows in when nothing says otherwise. */
export function defaultPlaceOf(route: Route): Place {
  return PLACE_OF_VIEW[route.view] ?? "sessions";
}

/** What an entry showing `route` in `place` has to record, if anything. */
export function placeOverride(
  route: Route,
  place: Place,
): PlaceOverride | undefined {
  if (place === defaultPlaceOf(route)) return undefined;
  return place === "activity" || place === "sessions" ? place : undefined;
}

/** The place `route` shows in, given the place you were in before it. */
export function placeOfRoute(route: Route, last: Place): Place {
  return PLACE_OF_VIEW[route.view] ?? (last === "activity" ? last : "sessions");
}

/** A conversation: the kind of route the Sessions place returns to. */
export function isConversationRoute(route: Route): boolean {
  return route.view === "session" || route.view === "workspace";
}

type SessionState = { id: string; archived?: boolean };

type WorkspaceState = {
  exists: boolean;
  liveSessions: number;
  archivedSessions: number;
};

/** Asks the server about a conversation. */
export type ConversationLookUp = {
  /** The session, or null for an unknown id. */
  session: (id: string) => Promise<Omit<SessionState, "id"> | null>;
  /** The workspace's record and member sessions. */
  workspace: (id: string) => Promise<WorkspaceState>;
};

/**
 * Whether a workspace is still somewhere to go back to. A deleted one is
 * not, and neither is an archived one: archiving archives every session and
 * keeps the record, so it shows as sessions that are all archived. One with
 * no sessions at all is only empty (a ticket nobody has started on) and
 * reopens.
 *
 * Nothing else counts. A draft parked on an archived workspace keeps its row
 * in the list, but the workspace was still archived, and not going back to it
 * costs one click on that row where going back would undo the archive on
 * screen.
 */
export function workspaceReopens(state: WorkspaceState): boolean {
  if (!state.exists) return false;
  return state.liveSessions > 0 || state.archivedSessions === 0;
}

/**
 * Whether a remembered conversation can still be opened: its session is not
 * archived, or its workspace still exists. The Sessions button asks before it
 * returns to one, so a conversation deleted or archived since (here, in
 * another tab, or by a teammate) is not reopened.
 *
 * A session missing from the loaded list is not taken as gone: the list is
 * scoped by the sidebar's lens and by recent activity, so it can leave out a
 * live one. A workspace is always asked about, listed or not: the list drops
 * a quiet one that still opens, and keeps one that another tab archived.
 * `lookUp` asks the server, and a failed request rejects: unknown is not gone.
 */
export function conversationExists(
  route: Route,
  sessions: readonly SessionState[],
  workspaces: readonly { id: string }[],
  lookUp?: ConversationLookUp,
): boolean | Promise<boolean> {
  if (route.view === "session") {
    const listed = sessions.find((session) => session.id === route.id);
    if (listed) return !listed.archived;
    if (!lookUp) return false;
    return lookUp
      .session(route.id)
      .then((session) => !!session && !session.archived);
  }
  if (route.view === "workspace") {
    if (lookUp) return lookUp.workspace(route.id).then(workspaceReopens);
    return workspaces.some((workspace) => workspace.id === route.id);
  }
  return false;
}
