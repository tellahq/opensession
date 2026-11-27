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

/** True for a route whose view decides its place whatever came before. */
export function routeNamesPlace(route: Route): boolean {
  return PLACE_OF_VIEW[route.view] !== undefined;
}

/** The place `route` shows in, given the place you were in before it. */
export function placeOfRoute(route: Route, last: Place): Place {
  return PLACE_OF_VIEW[route.view] ?? (last === "activity" ? last : "sessions");
}

/** A conversation: the kind of route the Sessions place returns to. */
export function isConversationRoute(route: Route): boolean {
  return route.view === "session" || route.view === "workspace";
}
