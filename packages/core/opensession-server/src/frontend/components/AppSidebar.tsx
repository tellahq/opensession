import type { CSSProperties, ReactNode } from "react";
import type { useAppDocumentInteractions } from "../hooks/useAppDocumentInteractions";
import type { useAppShell } from "../hooks/useAppShell";
import type { useAppViewState } from "../hooks/useAppViewState";
import type { useGithubConnectionState } from "../hooks/useGithubConnectionState";
import type { useSessionTabs } from "../hooks/useSessionTabs";
import type { useSessions } from "../hooks/useSessions";
import type { RepoInfo } from "../lib/api";
import { renameSessionApi } from "../lib/api";
import type { Route } from "../lib/app-route";
import { SIDEBAR_CHROME_BTN } from "../lib/sidebar-classes";
import type { UnifiedSession, Workspace } from "../lib/types";
import { cn } from "../ui/cn";
import { Tooltip } from "../ui/tooltip";
import { Sidebar } from "./Sidebar";
import { TitleBar } from "./TitleBar";

interface AppSidebarProps {
  data: {
    route: Route;
    sessions: UnifiedSession[];
    registeredRepoInfo: RepoInfo[];
    sessionsError: ReturnType<typeof useSessions>["error"];
    loading: boolean;
    refresh: ReturnType<typeof useSessions>["refresh"];
    workspacesLoaded: boolean;
    workspaces: Workspace[];
    teamViewing: Array<{ user: string; sessionId: string }>;
    listedSession: UnifiedSession | null;
    connected: boolean;
    productEmpty: boolean;
    githubConnectionState: ReturnType<typeof useGithubConnectionState>;
  };
  appearance: {
    mobileDetail: boolean;
    showToast: (message: string) => void;
    panelIcon: ReactNode;
    sidebarToggleKeys: string[] | null;
  };
  shell: Pick<
    ReturnType<typeof useAppShell>["sidebar"],
    | "sidebarCollapsed"
    | "toggleSidebarCollapsed"
    | "sidebarWidth"
    | "sidebarColRef"
    | "startSidebarResize"
  > & {
    headerActionsEl: ReturnType<
      typeof useAppShell
    >["mobileTopbar"]["headerActionsEl"];
  };
  interactions: Pick<
    ReturnType<typeof useAppDocumentInteractions>,
    "isPhone" | "sidebarRef" | "setNextChatAvailable"
  >;
  navigation: {
    taskCount: ReturnType<typeof useAppViewState>["taskCount"];
    commandMenuRef: ReturnType<typeof useAppViewState>["commandMenuRef"];
    sidebarWorkspaceId: ReturnType<
      typeof useSessionTabs
    >["context"]["sidebarWorkspaceId"];
    renameWorkspaceFromSidebar: ReturnType<
      typeof useSessionTabs
    >["workspaceActions"]["renameWorkspaceFromSidebar"];
    deleteWorkspaceFromSidebar: ReturnType<
      typeof useSessionTabs
    >["workspaceActions"]["deleteWorkspaceFromSidebar"];
    archiveWorkspaceFromSidebar: ReturnType<
      typeof useSessionTabs
    >["workspaceActions"]["archiveWorkspaceFromSidebar"];
    archiveSessionFromSidebar: ReturnType<
      typeof useSessionTabs
    >["sessionActions"]["archiveSessionFromSidebar"];
    setSessionLanes: ReturnType<
      typeof useSessionTabs
    >["sessionActions"]["setSessionLanes"];
  };
}

export function AppSidebar({
  data: {
    route,
    sessions,
    registeredRepoInfo,
    sessionsError,
    loading,
    refresh,
    workspacesLoaded,
    workspaces,
    teamViewing,
    listedSession,
    connected,
    productEmpty,
    githubConnectionState,
  },
  appearance: { mobileDetail, showToast, panelIcon, sidebarToggleKeys },
  shell: {
    sidebarCollapsed,
    toggleSidebarCollapsed,
    sidebarWidth,
    sidebarColRef,
    startSidebarResize,
    headerActionsEl,
  },
  interactions: { isPhone, sidebarRef, setNextChatAvailable },
  navigation: {
    taskCount,
    commandMenuRef,
    sidebarWorkspaceId,
    renameWorkspaceFromSidebar,
    deleteWorkspaceFromSidebar,
    archiveSessionFromSidebar,
    archiveWorkspaceFromSidebar,
    setSessionLanes,
  },
}: AppSidebarProps) {
  const sidebarStyle: CSSProperties & { "--sidebar-w": string } = {
    "--sidebar-w": `${sidebarWidth}px`,
  };
  return (
    <>
      {/* `sidebar-container` stays on the markup as a hook: base.css's
					    platform chrome (html.material-backdrop, the reduced-transparency
					    fallback) paints this surface by name. */}
      <div
        ref={sidebarColRef}
        className={cn(
          "sidebar-container flex min-h-0 shrink-0 flex-col bg-sidebar [--sidebar-icon-left:16px]",
          // Desktop and the exposed workspace gutter share one chrome
          // material, so opaque sticky headers scroll over the exact same
          // surface instead of revealing a gradient seam. No
          // backdrop-filter: since the shell went opaque the blur sampled
          // nothing but our own flat background while forcing the
          // compositor to re-rasterize the whole sidebar on any repaint
          // behind it (a scroll-flash amplifier).
          "desktop:[background:linear-gradient(var(--sidebar-material),var(--sidebar-material)),var(--sidebar-bg)]",
          // On phones the sidebar is the root PAGE of the iOS-style
          // stack — full bleed under the pushed detail pane — rather than
          // a fixed-width column.
          isPhone
            ? "absolute inset-0 z-[1] w-full"
            : "relative w-[var(--sidebar-w,280px)]",
          // Collapsed hides the whole left column; on phones the page
          // stack owns the sidebar and the class is inert.
          sidebarCollapsed && "desktop:hidden",
        )}
        style={sidebarStyle}
      >
        {/* Desktop chrome row — identical on web and in the desktop shell
						    (the shell additionally insets it past the traffic lights and
						    makes it a drag region): collapse toggle on the left,
						    back/forward + search at the right edge. Organization identity
						    now leads the sidebar itself, above Feed. Hidden on mobile,
						    where navigation uses the floating top bar instead. */}
        {/* `sidebar-brand` / `sidebar-brand-actions` stay as hooks: base.css
						    drives the WCO/desktop-shell chrome off them (traffic-light
						    inset). `wco-chrome` is what makes the row a window drag
						    region there.
						    The brand trigger carries its own 8px of left padding, so the
						    row pulls its own in to keep the logo on the list icons'
						    --sidebar-icon-left column. */}
        <div
          className={cn(
            "sidebar-brand wco-chrome h-[var(--desktop-header-h)] min-w-0 shrink-0 items-center justify-start gap-2 py-0 pr-3 pl-[calc(var(--sidebar-icon-left)-8px)]",
            // No scroll hairline: the tools sit fixed below this row and
            // only the workspace list scrolls, so nothing passes under it.
            // The brand row (and its account menu) is a desktop
            // affordance; on phones the top bar carries the brand
            // instead. Gated in JS rather than at `phone:` because
            // Tailwind's max-* is `width < 720`, one pixel short of the
            // `max-width: 720px` the rest of the app means by "phone".
            isPhone ? "hidden" : "flex",
          )}
        >
          <div className="sidebar-brand-actions flex shrink-0 items-center gap-2">
            <Tooltip
              label="Hide sidebar"
              side="bottom"
              shortcut={sidebarToggleKeys ?? undefined}
            >
              {/* Padding box, matching .viewer-code-icon exactly, so the
									    sidebar's chrome row and the session header's icon
									    cluster read as one system. */}
              <button
                className={cn(
                  SIDEBAR_CHROME_BTN,
                  "inline-flex px-[5px] py-[3px]",
                )}
                onClick={toggleSidebarCollapsed}
                aria-label="Hide sidebar"
              >
                {panelIcon}
              </button>
            </Tooltip>
          </div>
          <TitleBar onSearch={() => commandMenuRef.current?.open()} />
        </div>
        <Sidebar
          ref={sidebarRef}
          sessions={sessions}
          registeredRepos={registeredRepoInfo.map((repo) => repo.id)}
          directToMainBranches={Object.fromEntries(
            registeredRepoInfo
              .filter((repo) => repo.sharedCheckout)
              .map((repo) => [repo.id, repo.defaultBranch]),
          )}
          sessionsError={sessionsError}
          sessionsLoading={loading}
          onRetrySessions={() => void refresh()}
          workspaceDataReady={!loading && workspacesLoaded}
          workspaces={workspaces}
          teamViewing={teamViewing}
          // Selection is navigation state, not hydrated session data. The
          // route changes synchronously when a row opens; waiting for detail
          // hydration makes the old row look selected while the new session
          // is already loading.
          selectedId={
            route.view === "session" ? (listedSession?.id ?? route.id) : null
          }
          prsActive={route.view === "prs"}
          feedActive={route.view === "feed"}
          connected={connected}
          tasksActive={route.view === "tasks"}
          taskCount={taskCount}
          selectedWorkspaceId={sidebarWorkspaceId}
          plainActive={route.view === "plain"}
          supportTinderActive={route.view === "supporttinder"}
          reportsActive={route.view === "reports"}
          analyticsActive={route.view === "analytics"}
          showDraftRow={productEmpty && githubConnectionState !== "loading"}
          draftRowActive={productEmpty && route.view === "prs"}
          onRenameWorkspace={renameWorkspaceFromSidebar}
          onDeleteWorkspace={deleteWorkspaceFromSidebar}
          onToast={showToast}
          // Only hand the sidebar the top-bar actions slot on the root
          // page — on a pushed page (session, etc.) the sidebar is still
          // mounted underneath and would portal its filter button into
          // the session's top bar.
          headerActionsEl={mobileDetail ? null : headerActionsEl}
          catchUpActive={route.view === "catchup"}
          onNextChatAvailableChange={setNextChatAvailable}
          archivedActive={route.view === "archived"}
          onArchive={archiveSessionFromSidebar}
          onArchiveWorkspace={archiveWorkspaceFromSidebar}
          onRename={async (s, title) => {
            await (async () => {
              await renameSessionApi(s.id, title);
            })().catch(async (e) => {
              console.error("Rename failed:", e);
            });
            refresh();
          }}
          onSetStatus={setSessionLanes}
        />
        {/* Drag the right edge to resize: a hover/active hairline over a
						    wider invisible grab strip. Hidden on mobile, where the drawer
						    is a fixed width. It sits above both primary (20) and nested
						    (15) sticky headers so the hairline stays one uninterrupted
						    edge while the list scrolls. */}
        <div
          className={cn(
            "absolute top-0 right-[-3px] z-30 h-full w-[7px] cursor-col-resize after:absolute after:top-0 after:right-[3px] after:h-full after:w-[2px] after:bg-transparent after:transition-[background] after:content-[''] hover:after:bg-line-strong [body.resizing-sidebar_&]:after:bg-faint",
            isPhone && "hidden",
          )}
          onMouseDown={startSidebarResize}
          aria-hidden="true"
        />
      </div>
    </>
  );
}
