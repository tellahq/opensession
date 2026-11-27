import type { Route } from "../lib/app-route";
import { Automations, Goals, Security } from "./DeferredPanes";

/**
 * Automations, Goals and Security: the pages with a route of their own.
 * Settings hosts them in its content column. The new layout shows them as
 * pages of the app instead (Library lists them), where `pane` gives them the
 * centred, scrolling box Settings' column otherwise is.
 */
export function ToolPage({
  route,
  navigate,
  pane = false,
}: {
  route: Route;
  navigate: (next: Route) => void;
  pane?: boolean;
}) {
  const openSession = (id: string) => navigate({ view: "session", id });
  const page =
    route.view === "automations" ? (
      <Automations
        onOpenSession={openSession}
        selectedId={route.id}
        onSelect={(id) =>
          navigate({ view: "automations", id: id || undefined })
        }
      />
    ) : route.view === "security" ? (
      <Security onOpenSession={openSession} />
    ) : route.view === "goals" ? (
      <Goals
        onOpenSession={openSession}
        selectedId={route.id}
        onSelect={(id) => navigate({ view: "goals", id: id || undefined })}
      />
    ) : null;
  if (!pane || !page) return page;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 justify-center overflow-y-auto">
      {page}
    </div>
  );
}
