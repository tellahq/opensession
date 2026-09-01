import type { Dispatch, RefObject, SetStateAction } from "react";
import { flushSync } from "react-dom";
import type { NewSessionCreateDraft } from "../components/NewSession";
import { getCurrentUser } from "../components/UserPicker";
import { saveActiveViewTab, type ActiveViewTab } from "../lib/active-view-tab";
import { routePath } from "../lib/app-route";
import type { PendingCreateDraft } from "../lib/app-types";
import { stripBasePath } from "../lib/base";
import type { UnifiedSession } from "../lib/types";
import type { useAppRoute } from "./useAppRoute";
import type { useNewSessionPalette } from "./useNewSessionPalette";
import type { useSessions } from "./useSessions";

interface UseNewSessionCreateStartOptions {
  getCurrentRoute: ReturnType<typeof useAppRoute>["getCurrentRoute"];
  navigate: ReturnType<typeof useAppRoute>["navigate"];
  goBack: () => void;
  hidePalette: ReturnType<typeof useNewSessionPalette>["hidePalette"];
  inject: ReturnType<typeof useSessions>["inject"];
  unstick: ReturnType<typeof useSessions>["unstick"];
  pendingCreateDraftRef: RefObject<PendingCreateDraft | null>;
  pendingTimer: RefObject<ReturnType<typeof setTimeout> | undefined>;
  setActiveViewTabState: Dispatch<SetStateAction<ActiveViewTab>>;
  setOptimisticSession: Dispatch<SetStateAction<UnifiedSession | null>>;
  setPendingInitialPrompts: Dispatch<
    SetStateAction<
      Record<
        string,
        { content: string; user: string; sentAt: number; images?: string[] }
      >
    >
  >;
  setPendingNewWorkspace: Dispatch<SetStateAction<boolean>>;
  setPendingSessionId: Dispatch<SetStateAction<string | null>>;
}

export function useNewSessionCreateStart({
  getCurrentRoute,
  navigate,
  goBack,
  hidePalette,
  inject,
  unstick,
  pendingCreateDraftRef,
  pendingTimer,
  setActiveViewTabState,
  setOptimisticSession,
  setPendingInitialPrompts,
  setPendingNewWorkspace,
  setPendingSessionId,
}: UseNewSessionCreateStartOptions) {
  const closePalette = () => {
    hidePalette();
    // A deep link left the URL on <base>/new — return home on close.
    if (stripBasePath(location.pathname) === "/new") goBack();
  };

  const startNewSessionCreate = (started: NewSessionCreateDraft) => {
    const startedAt = new Date().toISOString();
    const user = getCurrentUser();
    const draft: PendingCreateDraft = {
      ...started,
      startedAt,
      user,
      originPath: routePath(getCurrentRoute()),
    };
    pendingCreateDraftRef.current = draft;

    const shell: UnifiedSession = {
      id: started.id,
      claudeSessionId: null,
      source: "opensession",
      branch: started.branch,
      worktreeDir: null,
      startedBy: user,
      title: started.workspaceId ? "New session" : "New workspace",
      lastActivity: startedAt,
      createdAt: startedAt,
      isRunning: true,
      runStartedAt: startedAt,
      transcriptPath: null,
      mode: started.mode,
      repo: started.repo,
      workspaceId: started.workspaceId || null,
      model: started.model,
      archived: false,
      // The server replaces this conservative starting state as soon as
      // session_created confirms whether environment setup is needed.
      workspacePreparing: true,
    };
    flushSync(() => {
      // Every create appears in the sidebar at send time. Background and
      // "Create more" used to wait for session_created even though the open
      // action already had this complete deterministic shell.
      inject(shell, { sticky: true });
      if (started.openImmediately) {
        setOptimisticSession(shell);
        hidePalette();
      }
    });
    if (!started.openImmediately) return;
    // "Open" means the new session's conversation, even when the create
    // adopts the PR workspace whose Review pane is currently foregrounded.
    // Leaving Review selected mounts PrPanel against the client-minted id
    // before the server has persisted it, briefly reporting "Session not
    // found" until the person opens the tab again. Clear both the live pane
    // and the target workspace's remembered selection before navigating.
    setActiveViewTabState(null);
    if (started.workspaceId) saveActiveViewTab(started.workspaceId, null);
    if (started.prompt || started.images?.length) {
      setPendingInitialPrompts((current) => ({
        ...current,
        [started.id]: {
          content: started.prompt,
          user,
          sentAt: new Date(startedAt).getTime(),
          ...(started.images?.length ? { images: started.images } : {}),
        },
      }));
    }
    setPendingSessionId(started.id);
    setPendingNewWorkspace(!started.workspaceId);
    clearTimeout(pendingTimer.current);
    pendingTimer.current = setTimeout(() => {
      setPendingSessionId((pending) =>
        pending === started.id ? null : pending,
      );
      setOptimisticSession((pending) =>
        pending?.id === started.id ? null : pending,
      );
      unstick(started.id);
    }, 120_000);
    navigate({ view: "session", id: started.id });
  };

  return { closePalette, startNewSessionCreate };
}
