import type { RefObject } from "react";
import type { useAppRoute } from "../hooks/useAppRoute";
import type { useAppShell } from "../hooks/useAppShell";
import type { useWebSocket } from "../hooks/useWebSocket";
import {
  APP_HEADER_ACTIONS,
  APP_HEADER_ACTIONS_DETAIL,
  appHeader,
  ARCHIVED_SEARCH_HEADER,
  HEADER_TITLE_COL,
  HEADER_TITLE_MODEL,
  HEADER_TITLE_PILL,
  HEADER_TITLE_PILL_CENTERED,
  HEADER_TITLE_PILL_FADE,
  HEADER_TITLE_PILL_TAPPABLE,
  HEADER_TITLE_REPO,
  HEADER_TITLE_ROW,
  HEADER_TITLE_TEXT,
  MOBILE_SEARCH_BTN,
} from "../lib/app-header-classes";
import type { Route } from "../lib/app-route";
import { sessionWasAgentStarted } from "../lib/sidebar-placement";
import type { UnifiedSession, Workspace } from "../lib/types";
import { cn } from "../ui/cn";
import { OverflowFadeText } from "../ui/overflow-fade-text";
import {
  TopBar,
  TopBarActions,
  TopBarBack,
  TopBarLeading,
} from "../ui/top-bar";
import type { CommandMenuHandle } from "./CommandMenuHost";
import { OrganizationSwitcher } from "./OrganizationSwitcher";
import { UpdatePill } from "./UpdatePill";
import { IconRobot, IconSearch } from "./icons";

interface AppMobileHeaderProps {
  route: Route;
  mobileDetail: boolean;
  currentSession: UnifiedSession | null;
  activeWorkspaceId: string | null;
  workspaces: Workspace[];
  connected: boolean;
  addHandler: ReturnType<typeof useWebSocket>["addHandler"];
  navigate: ReturnType<typeof useAppRoute>["navigate"];
  goBack: () => void;
  topbarTitle: string;
  phoneTitleHandedOver: boolean;
  commandMenuRef: RefObject<CommandMenuHandle | null>;
  setAppHeaderEl: ReturnType<
    typeof useAppShell
  >["mobileTopbar"]["setAppHeaderEl"];
  setHeaderRepoEl: ReturnType<
    typeof useAppShell
  >["mobileTopbar"]["setHeaderRepoEl"];
  setHeaderModelEl: ReturnType<
    typeof useAppShell
  >["mobileTopbar"]["setHeaderModelEl"];
  setHeaderActionsEl: ReturnType<
    typeof useAppShell
  >["mobileTopbar"]["setHeaderActionsEl"];
}

export function AppMobileHeader({
  route,
  mobileDetail,
  currentSession,
  activeWorkspaceId,
  workspaces,
  connected,
  addHandler,
  navigate,
  goBack,
  topbarTitle,
  phoneTitleHandedOver,
  commandMenuRef,
  setAppHeaderEl,
  setHeaderRepoEl,
  setHeaderModelEl,
  setHeaderActionsEl,
}: AppMobileHeaderProps) {
  return (
    <>
      {/* Mobile-only top bar. On the sidebar-root page the organization icon
				    opens the same switcher as the full sidebar row; on a pushed page a Back
				    chevron pops back to the root, iOS-style. On desktop this bar is hidden.
				    The catch-up deck renders its own header (back + "N Left" + new-workspace), so we
				    suppress this one there to avoid a duplicate back bar. */}
      {route.view !== "catchup" && (
        <TopBar
          as="header"
          ref={setAppHeaderEl}
          className={cn(
            appHeader({
              detail: mobileDetail,
              floating:
                route.view === "prs" ||
                route.view === "feed" ||
                route.view === "session",
            }),
            route.view === "archived" && ARCHIVED_SEARCH_HEADER,
          )}
        >
          <TopBarLeading className="shrink-0">
            {mobileDetail ? (
              <TopBarBack
                floating
                onClick={goBack}
                aria-label={
                  route.view === "session" && currentSession?.parentSessionId
                    ? "Back to the session that started this one"
                    : "Back to sidebar"
                }
              />
            ) : (
              <>
                <OrganizationSwitcher
                  variant="topbar"
                  connected={connected}
                  onOpenSettings={(section) =>
                    navigate({ view: "settings", section })
                  }
                />
                <UpdatePill addHandler={addHandler} variant="pill" />
              </>
            )}
          </TopBarLeading>
          {/* Centered page title on pushed pages, iOS-sheet style. Sessions
					    show the workspace name (per-session titles live on the tabs) plus a
					    working dot while the engine runs; other views show their plain
					    title. Desktop hides the whole bar.
					    A page that heads itself and leaves `topbarTitle` blank (Analytics,
					    Reports) gets no pill at all: an empty one is a white lozenge with
					    nothing in it.
					    A page that heads itself and DOES have a title here keeps the pill
					    but not its ink: it fades in once its own heading has scrolled
					    under this bar, which is the large-title move on the platform it
					    was borrowed from. A session names a thing rather than a page, so
					    its pill is always up. */}
          {mobileDetail && (route.view === "session" || topbarTitle) && (
            <span
              data-shown={
                route.view === "session" || phoneTitleHandedOver || undefined
              }
              className={cn(
                route.view === "session" && currentSession
                  ? `${HEADER_TITLE_PILL_TAPPABLE} session-settings-trigger`
                  : HEADER_TITLE_PILL,
                route.view !== "session" && HEADER_TITLE_PILL_FADE,
                route.view === "archived" && HEADER_TITLE_PILL_CENTERED,
              )}
              {...(route.view === "session" && currentSession
                ? {
                    role: "button",
                    tabIndex: 0,
                    onClick: () =>
                      window.dispatchEvent(
                        new Event("opensession:toggle-session-settings"),
                      ),
                  }
                : {})}
            >
              {/* Slack-header layout: the repo tile leads the pill (portaled in
							    by SessionViewer), or the archive mark replaces it for archived
							    sessions. The name sits over model · cost. The whole pill is one
							    tap target that opens the session's deeper info page. */}
              {route.view === "session" && currentSession && (
                <span className={HEADER_TITLE_REPO} ref={setHeaderRepoEl} />
              )}
              <span className={HEADER_TITLE_COL}>
                <span className={HEADER_TITLE_ROW}>
                  <OverflowFadeText className={HEADER_TITLE_TEXT}>
                    {route.view === "session"
                      ? // A worker names ITSELF here. The workspace name is what
                        // its parent shows, so borrowing it would leave the two
                        // reading identically with nothing to say you had gone a
                        // level down. Desktop says the same thing as a crumb.
                        currentSession?.parentSessionId
                        ? currentSession.title
                        : (activeWorkspaceId
                            ? workspaces.find((p) => p.id === activeWorkspaceId)
                                ?.name
                            : undefined) ||
                          currentSession?.title ||
                          ""
                      : topbarTitle}
                  </OverflowFadeText>
                  {currentSession && sessionWasAgentStarted(currentSession) && (
                    <IconRobot
                      size={16}
                      className="shrink-0 text-faint"
                      aria-label="Started by an agent"
                    />
                  )}
                </span>
                {route.view === "session" &&
                  currentSession && (
                    // Filled by SessionViewer's portal (compact model selector).
                    <span
                      className={HEADER_TITLE_MODEL}
                      ref={setHeaderModelEl}
                    />
                  )}
              </span>
            </span>
          )}
          <TopBarActions
            className={
              mobileDetail ? APP_HEADER_ACTIONS_DETAIL : APP_HEADER_ACTIONS
            }
            ref={setHeaderActionsEl}
          >
            {/* On the root page the actions slot is otherwise empty (session
						    actions only portal in on pushed pages) — it carries Search,
						    which lives in the top bar on phones instead of the sidebar.
						    The Desk rides the bottom-right FAB cluster instead. */}
            {!mobileDetail && (
              <button
                className={MOBILE_SEARCH_BTN}
                onClick={() => commandMenuRef.current?.open()}
                aria-label="Open command menu"
              >
                <IconSearch size={22} />
              </button>
            )}
          </TopBarActions>
        </TopBar>
      )}
    </>
  );
}
