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

export type Place = "sessions" | "activity" | "support" | "library";

const PLACE_OF_VIEW: Partial<Record<Route["view"], Place>> = {
  archived: "sessions",
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

/**
 * Whether a remembered conversation can still be opened: its session is not
 * archived, or its workspace still exists. The Sessions button asks before it
 * returns to one, so a conversation deleted or archived since (here, in
 * another tab, or by a teammate) is not reopened.
 *
 * A session missing from the loaded list is not taken as gone: the list is
 * scoped by the sidebar's lens and by recent activity, so it can leave out a
 * live one. `lookUp` asks the server instead (null for an unknown id).
 */
export function conversationExists(
  route: Route,
  sessions: readonly SessionState[],
  workspaces: readonly { id: string }[],
  lookUp?: (id: string) => Promise<Omit<SessionState, "id"> | null>,
): boolean | Promise<boolean> {
  if (route.view === "session") {
    const listed = sessions.find((session) => session.id === route.id);
    if (listed) return !listed.archived;
    if (!lookUp) return false;
    return lookUp(route.id).then((session) => !!session && !session.archived);
  }
  if (route.view === "workspace")
    return workspaces.some((workspace) => workspace.id === route.id);
  return false;
}
