import { useDebugValue } from "react";
import {
  archiveSessionApi,
  archiveWorkspaceApi,
  deleteWorkspaceApi,
  discardWorkspaceDraftApi,
  updateWorkspaceApi,
} from "../lib/api";
import type { Route } from "../lib/app-route";
import { archiveWorkspaceSessions } from "../lib/archive-workspace-sessions";
import type {
  DeleteWorkspaceOptions,
  OpenNextSidebarItem,
} from "../lib/sidebar-types";
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

/**
 * The sidebar receives the rename, archive and delete actions as props, so
 * their identities decide whether an unrelated app render (toggling the
 * sidebar, say) re-renders every row. `useDebugValue` is what makes the React
 * Compiler memoize them: it only compiles a `use*` function whose body calls
 * a React hook itself.
 */
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
  useDebugValue(route.view, (view) => `route ${view}`);
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

  const archiveMembers = (sessions: UnifiedSession[]) =>
    archiveWorkspaceSessions(sessions, {
      patch,
      archiveSession: async (id) => {
        await archiveSessionApi(id, true);
      },
      archiveWorkspace: archiveWorkspaceApi,
      rememberArchived,
      dropStalePins,
      refreshSessions,
    });

  const archiveWorkspaceFromHeader = (members: UnifiedSession[]) => {
    if (!members.length) return;
    confirmRunningCloses(members, () => {
      goBack();
      void archiveMembers(members);
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
      const ok = await archiveMembers(sessions);
      if (!ok && openSessionId)
        navigate({ view: "session", id: openSessionId });
    };
    confirmRunningCloses(sessions, () => void archive());
  };

  const deleteWorkspaceFromHeader = async (workspaceId: string) => {
    await deleteWorkspaceApi(workspaceId);
    refreshWorkspaces();
    refreshSessions();
    if (route.view === "workspace" && route.id === workspaceId) goBack();
  };

  // A draft row may be a workspace whose sessions are all archived, so its
  // delete discards only the draft: deleting the workspace would take the
  // archived sessions with it.
  const deleteWorkspaceFromSidebar = async (
    workspaceId: string,
    options: DeleteWorkspaceOptions = {},
  ) => {
    const wasOpen = route.view === "workspace" && route.id === workspaceId;
    await (async () => {
      if (options.draftOnly) await discardWorkspaceDraftApi(workspaceId);
      else await deleteWorkspaceApi(workspaceId);
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
