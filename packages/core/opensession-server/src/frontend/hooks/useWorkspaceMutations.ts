import {
  archiveSessionApi,
  deleteWorkspaceApi,
  updateWorkspaceApi,
} from "../lib/api";
import type { Route } from "../lib/app-route";
import type { OpenNextSidebarItem } from "../lib/sidebar-types";
import type { UnifiedSession } from "../lib/types";

type WorkspaceMutationsParams = {
  route: Route;
  navigate: (next: Route, opts?: { replace?: boolean }) => void;
  goBack: () => void;
  patch: (id: string, patch: Partial<UnifiedSession>) => void;
  refreshSessions: () => void;
  refreshWorkspaces: () => void;
  confirmRunningCloses: (
    sessions: UnifiedSession[],
    onConfirm: () => void,
  ) => void;
  rememberArchived: (ids: string[]) => void;
  dropStalePins: (sessions: UnifiedSession[]) => void;
};

export function useWorkspaceMutations({
  route,
  navigate,
  goBack,
  patch,
  refreshSessions,
  refreshWorkspaces,
  confirmRunningCloses,
  rememberArchived,
  dropStalePins,
}: WorkspaceMutationsParams) {
  const renameWorkspace = async (id: string, name: string) => {
    await (async () => {
      await updateWorkspaceApi(id, { name });
    })().catch(async (error) => {
      console.error("Rename workspace failed:", error);
    });
    refreshWorkspaces();
  };

  const renameWorkspaceFromSidebar = async (id: string, name: string) => {
    await (async () => {
      await updateWorkspaceApi(id, { name });
      refreshWorkspaces();
    })().catch(async (error) => {
      console.error("Rename workspace failed:", error);
    });
  };

  const archiveWorkspaceFromHeader = (members: UnifiedSession[]) => {
    if (!members.length) return;
    confirmRunningCloses(members, () => {
      void (async () => {
        goBack();
        for (const member of members) {
          patch(member.id, { archived: true, archivedReason: "manual" });
        }
        try {
          await Promise.all(
            members.map((member) => archiveSessionApi(member.id, true)),
          );
          rememberArchived(members.map((member) => member.id));
          dropStalePins(members);
          refreshSessions();
        } catch (error) {
          console.error("Archive workspace failed:", error);
          for (const member of members) {
            patch(member.id, {
              archived: false,
              archivedReason: undefined,
            });
          }
        }
      })();
    });
  };

  const archiveWorkspaceFromSidebar = (
    sessions: UnifiedSession[],
    openNext: OpenNextSidebarItem | null,
  ) => {
    const archive = async () => {
      const openSessionId =
        route.view === "session" &&
        sessions.some((session) => session.id === route.id)
          ? route.id
          : null;
      if (openSessionId && !openNext?.()) goBack();
      // The archive registry is per-session; the workspace row disappears once
      // no live sessions remain.
      for (const session of sessions) {
        patch(session.id, {
          archived: true,
          archivedReason: "manual",
        });
      }
      try {
        await Promise.all(
          sessions.map((session) => archiveSessionApi(session.id, true)),
        );
        // One entry for the whole row, so ⌘Z restores the workspace in one press.
        rememberArchived(sessions.map((session) => session.id));
      } catch (error) {
        console.error("Archive workspace failed:", error);
        for (const session of sessions) {
          patch(session.id, {
            archived: false,
            archivedReason: undefined,
          });
        }
        if (openSessionId) navigate({ view: "session", id: openSessionId });
        return;
      }
      dropStalePins(sessions);
      refreshSessions();
    };
    confirmRunningCloses(sessions, () => void archive());
  };

  const deleteWorkspaceFromHeader = async (workspaceId: string) => {
    await deleteWorkspaceApi(workspaceId);
    refreshWorkspaces();
    refreshSessions();
    if (route.view === "workspace" && route.id === workspaceId) goBack();
  };

  const deleteWorkspaceFromSidebar = async (workspaceId: string) => {
    const wasOpen = route.view === "workspace" && route.id === workspaceId;
    await (async () => {
      await deleteWorkspaceApi(workspaceId);
    })().catch(async (error) => {
      console.error("Delete workspace failed:", error);
      throw error;
    });
    refreshWorkspaces();
    refreshSessions();
    if (wasOpen) navigate({ view: "prs" });
  };

  return {
    renameWorkspace,
    renameWorkspaceFromSidebar,
    archiveWorkspaceFromHeader,
    archiveWorkspaceFromSidebar,
    deleteWorkspaceFromHeader,
    deleteWorkspaceFromSidebar,
  };
}
