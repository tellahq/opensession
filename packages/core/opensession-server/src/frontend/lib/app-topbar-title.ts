import type { Route } from "./app-route";
import { repoLabel } from "./repo-label";
import type { Workspace } from "./types";

// Plain title shown in the top bar for non-session views (session routes let
// the SessionViewer portal its own header in instead). It names the route,
// and the page under it still carries its own title: these are pages, not
// chats. A route left blank here collapses the bar (`.detail-topbar:empty`),
// which is right only for a page that brings a bar of its own: Reports heads
// both of its columns, Analytics its charts. Anywhere else a blank leaves the
// window with no titlebar to drag in the desktop shell.
export function appTopbarTitle(
  route: Route,
  routeWorkspace: Workspace | null,
): string {
  return route.view === "archived"
    ? "Archived"
    : route.view === "tasks"
      ? "Tasks"
      : route.view === "feed"
        ? "Feed"
        : route.view === "prs"
          ? "Pull requests"
          : route.view === "new"
            ? "New session"
            : // A PR opened by number is on its way to a workspace. It brings no
              // bar of its own while it resolves, so name it here instead of
              // leaving the window with nothing to drag by.
              route.view === "pr" && route.number !== undefined
              ? `${repoLabel(route.repo)} #${route.number}`
              : route.view === "workspace"
                ? routeWorkspace
                  ? [
                      routeWorkspace.repo
                        ? repoLabel(routeWorkspace.repo)
                        : null,
                      routeWorkspace.name,
                    ]
                      .filter(Boolean)
                      .join(" › ")
                  : "Workspace"
                : "";
}
