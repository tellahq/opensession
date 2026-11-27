// The new layout's places (components/shell/Minibar.tsx): which one a route
// belongs to, and the one you were last in.
//
// Most routes name their place. A session does not, because the same session
// can be reached from your own list or from Activity, and Activity has to keep
// its list beside the session you opened from it or you could not read through
// a teammate's work without the list changing under you. So a session keeps
// Activity when that is where you were, and otherwise belongs to Sessions.

import { useEffect, useSyncExternalStore } from "react";
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

let lastPlace: Place = "sessions";
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Record the place you are in. The Sessions button calls it to leave
 *  Activity without leaving the session on screen. */
export function setLastPlace(place: Place) {
  if (place === lastPlace) return;
  lastPlace = place;
  for (const listener of listeners) listener();
}

export function placeOfRoute(route: Route, last: Place): Place {
  return PLACE_OF_VIEW[route.view] ?? (last === "activity" ? last : "sessions");
}

/** The place this route shows in, remembered for the routes that name none. */
export function usePlace(route: Route): Place {
  const last = useSyncExternalStore(
    subscribe,
    () => lastPlace,
    () => lastPlace,
  );
  // Only a route that names its place is recorded, and only when that name
  // changes. A session never writes, so `setLastPlace("sessions")` from the
  // Sessions button survives the renders between the click and the route.
  const named = PLACE_OF_VIEW[route.view];
  useEffect(() => {
    if (named) setLastPlace(named);
  }, [named]);
  return placeOfRoute(route, last);
}
