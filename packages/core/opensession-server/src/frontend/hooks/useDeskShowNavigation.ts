import { useEffect, useEffectEvent } from "react";
import { saveActiveViewTab } from "../lib/active-view-tab";
import type { Route } from "../lib/app-route";
import { onDeskShow, type DeskShowTarget } from "../lib/desk-show";
import type { UnifiedSession } from "../lib/types";
import type { useAppViewState } from "./useAppViewState";
import type { useWorkspacePanes } from "./useWorkspacePanes";

type ViewState = ReturnType<typeof useAppViewState>;
type WorkspacePanes = ReturnType<typeof useWorkspacePanes>;

export function useDeskShowNavigation({
  sessions,
  wsKeyFor,
  openReviewForSession,
  setActiveViewTabState,
  navigate,
  isPhone,
  setDeskOverlay,
}: {
  sessions: UnifiedSession[];
  wsKeyFor: WorkspacePanes["wsKeyFor"];
  openReviewForSession: WorkspacePanes["openReviewForSession"];
  setActiveViewTabState: ViewState["setActiveViewTabState"];
  navigate: (route: Route) => void;
  isPhone: boolean;
  setDeskOverlay: ViewState["setDeskOverlay"];
}) {
  // Desk's show_in_app landed here (lib/desk-show). A workspace pane is part
  // of the route; a session's tab is applied the way the sidebar does it: Review
  // through the pending-open pulse that survives the workspace-change reset,
  // chat by clearing the workspace's remembered pane before the route lands.
  const voiceShow = useEffectEvent((target: DeskShowTarget, route: Route) => {
    const shownSession =
      target.kind === "session" && target.tab
        ? sessions.find(
            (session) =>
              session.id === target.id || session.aliasIds?.includes(target.id),
          )
        : undefined;
    const sessionKey = wsKeyFor(shownSession);
    if (shownSession && target.tab === "review") {
      openReviewForSession(shownSession);
    } else if (shownSession && sessionKey && target.tab === "chat") {
      saveActiveViewTab(sessionKey, null);
      setActiveViewTabState(null);
      navigate(route);
    } else if (
      shownSession?.workspaceId &&
      (target.tab === "conversation" || target.tab === "video")
    ) {
      navigate({
        view: "workspace",
        id: shownSession.workspaceId,
        tab: target.tab,
      });
    } else {
      navigate(route);
    }
    // The phone sheet covers the page; minimise it so what was asked for is
    // visible. The call keeps running in the mounted body.
    if (isPhone) setDeskOverlay((desk) => ({ ...desk, open: false }));
  });
  useEffect(() => onDeskShow(voiceShow), []);
}
