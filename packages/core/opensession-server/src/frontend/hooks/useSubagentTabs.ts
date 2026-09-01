import { useEffect, useEffectEvent, useState } from "react";
import type React from "react";
import type { SubagentRef } from "../components/SubagentPane";
import type { ActiveViewTab } from "../lib/active-view-tab";
import type { Route } from "../lib/app-route";
import { subagentSuffix } from "../lib/share-link";

// Stable empty stack, so a session with no sub-agent open hands the same array
// identity down every render (the transcript memo compares props by identity).
const NO_SUBAGENTS: SubagentRef[] = [];

// A link into a sub-agent carries agent ids, never their labels. The pane reads
// the real one off the sub-agent's own transcript and reports it back, so the
// tab only wears this until that lands.
const SUBAGENT_LINK_LABEL = "Sub-agent";

/** The sub-agent breadcrumb a URL opens with, as the tab state keyed by session. */
function routeSubagentTabs(route: Route): Record<string, SubagentRef[]> {
  if (route.view !== "session" || !route.subagent?.length) return {};
  return {
    [route.id]: route.subagent.map((agentId) => ({
      agentId,
      label: SUBAGENT_LINK_LABEL,
    })),
  };
}

export function useSubagentTabs({
  route,
  subagentSelected,
  setActiveViewTab: setActiveViewTabState,
}: {
  route: Route;
  subagentSelected: boolean;
  setActiveViewTab: React.Dispatch<React.SetStateAction<ActiveViewTab>>;
}) {
  // Sub-agent drill-ins, keyed by the session they were opened from (a sub-agent
  // belongs to one session's run). The value is a breadcrumb stack — a Task call
  // inside a sub-agent pushes another entry. In-memory only, like the tab
  // itself: the transcript is re-fetched whenever it's reopened. A link that
  // names a sub-agent seeds the stack here, so the pane is open before the
  // session has even finished loading.
  const [subagentTabs, setSubagentTabs] = useState<
    Record<string, SubagentRef[]>
  >(() => routeSubagentTabs(route));
  const stackFor = (sessionId: string | undefined): SubagentRef[] =>
    sessionId === undefined
      ? NO_SUBAGENTS
      : (subagentTabs[sessionId] ?? NO_SUBAGENTS);
  // The stack the ROUTE's session has drilled into — which is the same as
  // `subagentStack` below once that session hydrates, but is already there
  // while a linked session is still loading. It decides both what the URL says
  // and whether a workspace-level tab restore may take the pane away.
  const routeSubagentStack =
    route.view === "session" ? stackFor(route.id) : NO_SUBAGENTS;
  const openSubagentPath = subagentSuffix(
    subagentSelected ? routeSubagentStack.map((s) => s.agentId) : [],
  );

  // Open (or foreground) a session's sub-agent tab — the transcript's "Watch"
  // drill-in on a Task call. A Task call inside the sub-agent pushes onto the
  // same tab's breadcrumb instead of opening a second one. Stable identity:
  // it reaches the memoized transcript as a prop, and the tab is never
  // persisted, so it needs nothing from the render scope.
  const openSubagent = (sessionId: string, agentId: string, label: string) => {
    setSubagentTabs((prev) => {
      const stack = prev[sessionId] ?? NO_SUBAGENTS;
      if (stack.some((s) => s.agentId === agentId)) return prev;
      return { ...prev, [sessionId]: [...stack, { agentId, label }] };
    });
    setActiveViewTabState("subagent");
  };
  const popSubagent = (sessionId: string) => {
    setSubagentTabs((prev) => {
      const stack = prev[sessionId];
      if (!stack?.length) return prev;
      const next = { ...prev };
      if (stack.length === 1) delete next[sessionId];
      else next[sessionId] = stack.slice(0, -1);
      return next;
    });
  };
  const closeSubagentTab = (sessionId: string) => {
    setSubagentTabs((prev) => {
      if (!prev[sessionId]) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    // Same commit as the close, like every other closeXTab — the effect
    // below only has to catch the session-switch case.
    setActiveViewTabState((cur) => (cur === "subagent" ? null : cur));
  };
  // The pane read the sub-agent's own name off its transcript — a link carries
  // ids only, so this is what turns "Sub-agent" into a real label. It fills in
  // the placeholder and nothing else: a drill-in arrives already named by the
  // Task call it came from, and that name shouldn't change under the reader a
  // second after they opened it.
  const nameSubagent = (sessionId: string, agentId: string, label: string) => {
    setSubagentTabs((prev) => {
      const stack = prev[sessionId];
      const at = stack?.findIndex((s) => s.agentId === agentId) ?? -1;
      if (!stack || at === -1 || stack[at].label !== SUBAGENT_LINK_LABEL)
        return prev;
      const next = stack.slice();
      next[at] = { agentId, label };
      return { ...prev, [sessionId]: next };
    });
  };
  // A sub-agent named in the URL after the first load — a Back/Forward across a
  // drill-in, or an in-app link into one. The initial load is seeded with the
  // state itself, so this only has to catch the later arrivals.
  const routeSubagentKey =
    route.view === "session" && route.subagent?.length
      ? `${route.id}${subagentSuffix(route.subagent)}`
      : null;
  // The sync reads the live route through an effect event, so the trigger
  // stays the derived sub-agent key rather than every route field.
  const syncRouteSubagents = useEffectEvent(() => {
    if (route.view !== "session" || !route.subagent?.length) return;
    const ids = route.subagent;
    setSubagentTabs((prev) => {
      const stack = prev[route.id] ?? NO_SUBAGENTS;
      if (
        stack.length === ids.length &&
        stack.every((s, i) => s.agentId === ids[i])
      )
        return prev;
      // Keep the labels of any level the reader already had open; the pane
      // names the rest once it has read them.
      return {
        ...prev,
        [route.id]: ids.map((agentId, i) =>
          stack[i]?.agentId === agentId
            ? stack[i]
            : { agentId, label: SUBAGENT_LINK_LABEL },
        ),
      };
    });
    setActiveViewTabState("subagent");
  });
  useEffect(() => {
    if (!routeSubagentKey) return;
    syncRouteSubagents();
  }, [routeSubagentKey]);
  // Dropping the last breadcrumb (or switching to a session with no sub-agent
  // open) leaves nothing to show — fall back to the session itself. Read from
  // the route's own stack, not the open session's: a linked sub-agent is chosen
  // before its session has loaded, and measuring the hydrated session here
  // threw that selection away in the first commit after landing.
  const clearMissingSubagent = useEffectEvent(() => {
    setActiveViewTabState(null);
  });
  useEffect(() => {
    if (subagentSelected && routeSubagentStack.length === 0)
      clearMissingSubagent();
  }, [subagentSelected, routeSubagentStack.length]);

  return {
    routeSubagentStack,
    openSubagentPath,
    stackFor,
    openSubagent,
    popSubagent,
    closeSubagentTab,
    nameSubagent,
  };
}
