import React from "react";
import { SupportRow } from "../components/sidebar/FeedRows";
import { fetchFeedItems, setPlainThreadStatusApi } from "./api";
import type { NavigationActions } from "./navigation";
import type { Props } from "./sidebar-types";
import type {
  FeedItem,
  SupportThread,
  UnifiedSession,
  Workspace,
} from "./types";

interface SupportRendererOptions {
  currentUser: string;
  selectedWorkspaceId: string | null;
  selectedId: string | null;
  workspaces: Workspace[];
  supportSessionByThread: Map<string, UnifiedSession>;
  pins: string[];
  navigation: NavigationActions;
  setFeedItems: React.Dispatch<
    React.SetStateAction<Record<string, FeedItem[]>>
  >;
  onTogglePin: (key: string) => void;
  onSetStatus: Props["onSetStatus"];
}

export function createSupportRenderer({
  currentUser,
  selectedWorkspaceId,
  selectedId,
  workspaces,
  supportSessionByThread,
  pins,
  navigation,
  setFeedItems,
  onTogglePin: togglePinKey,
  onSetStatus,
}: SupportRendererOptions) {
  // Quick "mark done" straight from a Support row — optimistic removal (the
  // ticket leaves Plain's Todo queue), restored by a refetch if Plain says no.
  async function markSupportRowDone(threadId: string) {
    setFeedItems((prev) => ({
      ...prev,
      plain: (prev.plain || []).filter((x) => x.id !== threadId),
    }));
    try {
      await setPlainThreadStatusApi(threadId, "done", { user: currentUser });
    } catch {
      try {
        const items = await fetchFeedItems("plain");
        setFeedItems((prev) => ({ ...prev, plain: items }));
      } catch {
        // The scheduled feed refresh will reconcile the optimistic removal.
      }
    }
  }

  // A Support row: one TODO Plain ticket. The dot wears the linked session's
  // status (faint when no session exists yet); click opens the session, or the
  // session-less ticket preview when there isn't one. Hovering reveals the
  // one-click "mark done" button at the row's right edge.
  function supportThreadActive(t: SupportThread) {
    // The ticket's workspace is open (session-less route or one of its sessions)…
    if (selectedWorkspaceId) {
      const ws = workspaces.find((p) => p.id === selectedWorkspaceId);
      if (ws?.plainThreadId === t.id) return true;
    }
    // …or its linked session is the open session (pre-workspace sessions).
    const session = supportSessionByThread.get(t.id);
    return !!session && session.id === selectedId;
  }

  // A Support row in the workspace rows' shape — see SupportRow for the
  // markup; this binds it to the sidebar's state and handlers.
  function renderSupportRow(t: SupportThread) {
    const pinKey = `support:${t.id}`;
    const linked = supportSessionByThread.get(t.id) || null;
    return (
      <SupportRow
        key={pinKey}
        thread={t}
        session={linked}
        active={supportThreadActive(t)}
        pinned={pins.includes(pinKey)}
        onTogglePin={() => togglePinKey(pinKey)}
        onOpen={() => navigation.openTicket(t)}
        onMarkDone={() => markSupportRowDone(t.id)}
        onSetStatus={
          linked ? (status) => onSetStatus([linked], status) : undefined
        }
      />
    );
  }
  return { renderSupportRow, supportThreadActive };
}
