import type { Route } from "./app-route";

/**
 * The session a person was reading when they followed a link out of it to a
 * pull request, ticket or workspace. Back returns there rather than to the
 * sidebar: on a phone the PR's workspace can be session-less, so its pages
 * otherwise offer no way back to the conversation the link was in.
 */
export type SessionReturn = {
  path: string;
  depth: number | null;
  /** History entries pushed since leaving the session. */
  steps: number;
};

const DRILL_IN_VIEWS: ReadonlySet<Route["view"]> = new Set([
  "pr",
  "workspace",
  "reviews",
  "support",
]);

/**
 * Carry the return across the redirects a PR link resolves through (pr, then
 * workspace, then a session in it): those replace the entry, so the return
 * rides along. Opening another session or going home ends the trip.
 */
export function sessionReturnForNavigation({
  current,
  next,
  currentReturn,
  currentPath,
  currentDepth,
  logicalReplace,
  pushed,
}: {
  current: Route;
  next: Route;
  currentReturn?: SessionReturn;
  /** Where Back should land for the current route. */
  currentPath: string;
  currentDepth: number | null;
  /** The caller asked to refine or redirect the current entry. */
  logicalReplace: boolean;
  /** A history entry is actually added (false in single-entry history). */
  pushed: boolean;
}): SessionReturn | undefined {
  if (next.view === "prs") return undefined;
  if (logicalReplace) return currentReturn;
  if (!DRILL_IN_VIEWS.has(next.view)) return undefined;
  if (current.view === "session")
    return { path: currentPath, depth: currentDepth, steps: pushed ? 1 : 0 };
  return currentReturn
    ? { ...currentReturn, steps: currentReturn.steps + (pushed ? 1 : 0) }
    : undefined;
}
