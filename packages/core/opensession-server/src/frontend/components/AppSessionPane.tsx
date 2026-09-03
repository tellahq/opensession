import type { RefObject } from "react";
import type { useAppViewState } from "../hooks/useAppViewState";
import type { useSessionTabs } from "../hooks/useSessionTabs";
import type { useSessions } from "../hooks/useSessions";
import type { useWebSocket } from "../hooks/useWebSocket";
import type { useWorkspacePanes } from "../hooks/useWorkspacePanes";
import { renameSessionApi } from "../lib/api";
import type { Route } from "../lib/app-route";
import type { UnifiedSession, Workspace } from "../lib/types";
import { viewTabKind } from "../lib/workspace-pane-tabs";
import { SessionPaneProviders } from "./SessionPaneProviders";
import { SessionViewer } from "./SessionViewer";
import type { SidebarHandle } from "./Sidebar";
import type { useAuthStatus } from "./UserPicker";

interface AppSessionPaneProps {
  surface: {
    viewerSession: UnifiedSession;
    socket: ReturnType<typeof useWebSocket>;
    focused: boolean;
    splitMode: boolean;
    requestedSurfaceId?: string;
  };
  pending: {
    route: Route;
    auth: ReturnType<typeof useAuthStatus>;
    nextChatAvailable: boolean;
    pendingSessionId: string | null;
    pendingNewWorkspace: boolean;
  };
  data: {
    pendingInitialPrompts: Record<
      string,
      {
        content: string;
        user: string;
        sentAt: number;
        images?: string[];
        pastedTexts?: string[];
      }
    >;
    sidebarRef: RefObject<SidebarHandle | null>;
    sessions: UnifiedSession[];
    workspaces: Workspace[];
    patch: ReturnType<typeof useSessions>["patch"];
    refresh: ReturnType<typeof useSessions>["refresh"];
  };
  portals: {
    topbarEl: HTMLElement | null;
    headerActionsEl: HTMLElement | null;
    headerModelEl: HTMLElement | null;
    headerRepoEl: HTMLElement | null;
    rightPanelEl: HTMLElement | null;
  };
  composer: Pick<
    ReturnType<typeof useAppViewState>,
    | "newSessionSeq"
    | "focusComposerOnOpen"
    | "sessionComposerPrefills"
    | "setSessionComposerPrefills"
  >;
  visibility: Pick<
    ReturnType<typeof useAppViewState>,
    | "reviewActive"
    | "conversationActive"
    | "videoActive"
    | "stagingActive"
    | "assetsActive"
    | "terminalActive"
    | "previewLiveActive"
    | "portalActive"
    | "reviewFocusPr"
  >;
  subagents: Pick<
    ReturnType<typeof useAppViewState>,
    "openSubagent" | "popSubagent" | "nameSubagent" | "stackFor"
  >;
  panes: Pick<
    ReturnType<typeof useWorkspacePanes>,
    | "wsKey"
    | "conversationThreadId"
    | "videoPanel"
    | "videoRef"
    | "currentPortalTarget"
    | "subagentActive"
    | "terminalOpen"
    | "closeStagingTab"
    | "closePreviewTab"
    | "closeAssetsTab"
    | "closeTerminalTab"
  >;
  tabs: {
    context: Pick<
      ReturnType<typeof useSessionTabs>["context"],
      "activeWorkspaceId" | "workspaceSessions" | "emptyWorkspaceSession"
    >;
    archive: Pick<
      ReturnType<typeof useSessionTabs>["archive"],
      "archivedSessions" | "restoreSession" | "rememberArchived"
    >;
    sessions: Pick<
      ReturnType<typeof useSessionTabs>["sessionActions"],
      "setSessionLanes" | "closeSession" | "handleSessionRunningChange"
    >;
    workspaces: Pick<
      ReturnType<typeof useSessionTabs>["workspaceActions"],
      | "renameWorkspace"
      | "archiveWorkspaceFromHeader"
      | "deleteWorkspaceFromHeader"
    >;
    tabStripVisible: ReturnType<
      typeof useSessionTabs
    >["strip"]["tabStripVisible"];
  };
}

export function AppSessionPane({
  surface: { viewerSession, socket, focused, splitMode, requestedSurfaceId },
  pending: {
    route,
    auth,
    nextChatAvailable,
    pendingSessionId,
    pendingNewWorkspace,
  },
  data: {
    pendingInitialPrompts,
    sidebarRef,
    sessions,
    workspaces,
    patch,
    refresh,
  },
  portals: {
    topbarEl,
    headerActionsEl,
    headerModelEl,
    headerRepoEl,
    rightPanelEl,
  },
  composer: {
    newSessionSeq,
    focusComposerOnOpen,
    sessionComposerPrefills,
    setSessionComposerPrefills,
  },
  visibility: {
    reviewActive,
    conversationActive,
    videoActive,
    stagingActive,
    assetsActive,
    terminalActive,
    previewLiveActive,
    portalActive,
    reviewFocusPr,
  },
  subagents: { openSubagent, popSubagent, nameSubagent, stackFor },
  panes: {
    wsKey,
    conversationThreadId,
    videoPanel,
    videoRef,
    currentPortalTarget,
    subagentActive,
    terminalOpen,
    closeStagingTab,
    closePreviewTab,
    closeAssetsTab,
    closeTerminalTab,
  },
  tabs: {
    context: { activeWorkspaceId, workspaceSessions, emptyWorkspaceSession },
    archive: { archivedSessions, restoreSession, rememberArchived },
    sessions: { setSessionLanes, closeSession, handleSessionRunningChange },
    workspaces: {
      renameWorkspace,
      archiveWorkspaceFromHeader,
      deleteWorkspaceFromHeader,
    },
    tabStripVisible,
  },
}: AppSessionPaneProps) {
  const surfaceId = requestedSurfaceId ?? viewerSession.id;
  const pendingSocket = surfaceId === pendingSessionId;
  const sessionSocket = pendingSocket
    ? socket.sessionSocketIgnoringMessages
    : socket.sessionSocket;
  return (
    // A `#5528` written anywhere in this pane's transcript means a PR in the
    // pane's OWN repo — which is why the context is per pane rather than
    // app-wide: a split view can hold two sessions on two different repos.
    <SessionPaneProviders
      key={viewerSession.id}
      repo={viewerSession.repo}
      socket={sessionSocket}
    >
      <SessionViewer
        key={viewerSession.id}
        session={viewerSession}
        composer={{
          setTyping: socket.setTyping,
          resetSeq: focused ? newSessionSeq : 0,
          autoFocus: focused && focusComposerOnOpen,
          prefill: sessionComposerPrefills[viewerSession.id] ?? null,
          onPrefillConsumed: (seq) =>
            setSessionComposerPrefills((prev) => {
              const cur = prev[viewerSession.id];
              if (!cur || cur.seq !== seq) return prev;
              const next = { ...prev };
              delete next[viewerSession.id];
              return next;
            }),
        }}
        availability={{
          canRepairSafety: auth?.admin === true,
          canOpenPr: true,
          canOpenNextChat: focused && nextChatAvailable,
          canStartNewSession: !viewerSession.desk && !emptyWorkspaceSession,
          canOpenNewWorkspace: true,
          canOpenSession: true,
          canOpenReview: true,
          canOpenAssets: true,
          canOpenPortal: true,
          canOpenWorkspace: true,
        }}
        lifecycle={{
          connected: socket.connected && !pendingSocket,
          pendingCreation:
            focused &&
            route.view === "session" &&
            route.id === pendingSessionId,
          optimisticEmpty:
            !pendingNewWorkspace &&
            focused &&
            route.view === "session" &&
            route.id === pendingSessionId,
          initialPending: pendingInitialPrompts[viewerSession.id],
          onArchive: () => {
            if (focused) sidebarRef.current?.archiveSelected();
            else closeSession(viewerSession);
          },
          onArchived: () => {
            // Only fires when the viewer archived on its own — with onArchive
            // passed (a focused pane) it defers to the sidebar path instead, so
            // this can't double-record.
            rememberArchived([viewerSession.id]);
          },
          onRunningChange: handleSessionRunningChange,
          onReviewChange: (id, request) =>
            patch(id, { reviewRequest: request ?? undefined }),
          onRename: async (id, title) => {
            await (async () => {
              await renameSessionApi(id, title);
            })().catch(async (error) => {
              console.error("Rename failed:", error);
            });
            refresh();
          },
        }}
        chrome={{
          focused,
          hideHeader: splitMode && !focused,
          hideRightPanel: splitMode && !focused,
          topbarEl: focused ? topbarEl : null,
          headerActionsEl: focused ? headerActionsEl : null,
          headerModelEl: focused ? headerModelEl : null,
          headerRepoEl: focused ? headerRepoEl : null,
          rightPanelEl: focused ? rightPanelEl : null,
        }}
        workspace={{
          workspaceSessions,
          onSetStatus: setSessionLanes,
          allSessions: sessions,
          // Mirrors SessionTabs' own "render nothing" rule so the header's
          // lone-tab + never doubles up with the strip's — and, just as
          // important, so it APPEARS whenever the strip doesn't. Closed
          // sessions are not part of the rule: they live in the strip's
          // history button when there is a strip and in the header's ⋯ menu
          // when there isn't, so counting them here would leave a lone
          // session with neither + .
          tabStripVisible,
          archivedSessions,
          onRestoreSession: restoreSession,
          workspaceName: activeWorkspaceId
            ? (workspaces.find((project) => project.id === activeWorkspaceId)
                ?.name ?? viewerSession.workspaceName)
            : undefined,
          onRenameWorkspace: activeWorkspaceId
            ? (name) => renameWorkspace(activeWorkspaceId, name)
            : undefined,
          onArchiveWorkspace: activeWorkspaceId
            ? () => archiveWorkspaceFromHeader(workspaceSessions)
            : undefined,
          onDeleteWorkspace: activeWorkspaceId
            ? () => deleteWorkspaceFromHeader(activeWorkspaceId)
            : undefined,
        }}
        viewTabs={{
          showReview: splitMode
            ? viewTabKind(surfaceId) === "review"
            : focused && reviewActive,
          showConversation: splitMode
            ? viewTabKind(surfaceId) === "conversation"
            : focused && conversationActive,
          conversationThreadId,
          showVideo: splitMode
            ? viewTabKind(surfaceId) === "video"
            : focused && videoActive,
          videoPanel,
          videoTitle: videoRef?.title || null,
          showStaging: splitMode
            ? viewTabKind(surfaceId) === "staging"
            : focused && stagingActive,
          showAssets: splitMode
            ? viewTabKind(surfaceId) === "assets"
            : focused && assetsActive,
          showTerminal: splitMode
            ? viewTabKind(surfaceId) === "terminal"
            : focused && terminalActive,
          // Presence, not foreground: the shells stay mounted behind whatever
          // else is in front, and only unmount when the tab is closed.
          terminalTabOpen: !!wsKey && terminalOpen.has(wsKey),
          showPreviewTab: splitMode
            ? viewTabKind(surfaceId) === "preview"
            : focused && previewLiveActive,
          showPortal: splitMode
            ? viewTabKind(surfaceId) === "portal"
            : focused && portalActive,
          portalTarget: currentPortalTarget,
          reviewFocusPr,
          onCloseStaging: closeStagingTab,
          onClosePreviewTab: closePreviewTab,
          onCloseAssets: closeAssetsTab,
          onCloseTerminal: closeTerminalTab,
        }}
        subagents={{
          // The sub-agent drill-in, opened from this pane's own transcript.
          showSubagent: splitMode
            ? viewTabKind(surfaceId) === "subagent"
            : focused && subagentActive,
          subagentStack: stackFor(viewerSession.id),
          onOpenSubagent: openSubagent,
          onSubagentBack: popSubagent,
          onSubagentLabel: nameSubagent,
          parentSession: viewerSession.parentSessionId
            ? (() => {
                const parent = sessions.find(
                  (session) => session.id === viewerSession.parentSessionId,
                );
                return parent
                  ? {
                      id: parent.id,
                      title: parent.title,
                      model: parent.model,
                    }
                  : null;
              })()
            : null,
          workerSessions: sessions
            .filter((session) => session.parentSessionId === viewerSession.id)
            .map((session) => ({
              id: session.id,
              title: session.title,
              model: session.model,
              isRunning: session.isRunning,
            })),
        }}
      />
    </SessionPaneProviders>
  );
}
