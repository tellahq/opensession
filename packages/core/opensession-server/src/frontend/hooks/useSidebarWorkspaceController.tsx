import React, {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { RowCardPopup } from "../components/SidebarRowCards";
import { WsCardBody, WsMobileSheet } from "../components/sidebar/HoverCards";
import { SubagentRows } from "../components/sidebar/SubagentRows";
import { WorkspaceRow } from "../components/sidebar/WorkspaceRow";
import { blockingOverlayOpen } from "../lib/blocking-overlay";
import { setHide } from "../lib/hides";
import type { NavigationActions } from "../lib/navigation";
import { pointerCanHover } from "../lib/pointer";
import { markRead, markUnread } from "../lib/reads";
import { sessionHasPr } from "../lib/session-prs";
import { sessionHasWorkspace } from "../lib/session-workspace";
import { absoluteLink, copyToClipboard, sessionPath } from "../lib/share-link";
import { matchesShortcut } from "../lib/shortcuts";
import { isClaimed, ownedBy } from "../lib/sidebar-lanes";
import {
  nextRenderedSidebarChat,
  nextUnreadRenderedWorkspaceItem,
} from "../lib/sidebar-next";
import { previewSidebarSelection } from "../lib/sidebar-selection";
import type { SwipeAction, SwipeState } from "../lib/sidebar-swipe";
import {
  LONG_PRESS_MS,
  LONG_PRESS_SLOP,
  SWIPE_AXIS_LOCK_PX,
  SWIPE_COMMIT_MS,
  SWIPE_OPEN_THRESHOLD,
  SWIPE_REVEAL_PX,
  clampSwipe,
  editableOwnsCaretChord,
  editableSwallowsArchiveChord,
  fullSwipeThreshold,
  swipeActionForOffset,
  swipeCommitOffset,
} from "../lib/sidebar-swipe";
import type { Props, SidebarHandle, WsRow } from "../lib/sidebar-types";
import { pickUnreadWorkspaceSession } from "../lib/sidebar-unread-session";
import type { WorkspaceSubagent } from "../lib/sidebar-workspaces";
import {
  subagentsForSelectedWorkspace,
  workspaceMainSession,
} from "../lib/sidebar-workspaces";
import { SNOOZE_SOMEDAY, clearSnooze, setSnooze } from "../lib/snoozes";
import type { UnifiedSession, Workspace } from "../lib/types";
import { useConfirm } from "../ui/confirm";
import { Popover } from "../ui/popover";
import { useShortcutKeys } from "./useShortcutBindings";

interface WorkspaceControllerIdentity {
  currentUser: string;
  mePersonKey: string;
  teamViewing: Array<{ user: string; sessionId: string }>;
}

interface WorkspaceControllerData {
  sessions: UnifiedSession[];
  workspaces: Workspace[];
  wsRows: WsRow[];
  wsRowOrder: WsRow[];
  reads: Record<string, string>;
  activeSnoozeKeys: Set<string>;
  snoozes: Record<string, string>;
  subagentsByWorkspaceId: ReadonlyMap<string, WorkspaceSubagent[]>;
}

interface WorkspaceControllerState {
  selectedId: string | null;
  selectedWorkspaceId: string | null;
  isPhone: boolean;
  showSubagents: boolean;
  groupsByRepo: boolean;
  runStartSeen: Map<string, number>;
  wsTimePref: "off" | "always" | "hover";
  workspaceDraft: string;
  sessionDraft: string;
  pins: string[];
}

interface WorkspaceControllerRefs {
  sidebarScrollRef: React.RefObject<HTMLDivElement | null>;
  ref: React.ForwardedRef<SidebarHandle>;
}

interface WorkspaceControllerNavigation {
  navigation: NavigationActions;
  openSidebarSession: (session: UnifiedSession) => void;
  openNextSidebarItem: (
    currentKey: string,
    current?: HTMLButtonElement | null,
  ) => () => boolean;
}

interface WorkspaceControllerEditing {
  rowRenameEditing: (row: WsRow) => boolean;
  setWorkspaceDraft: React.Dispatch<React.SetStateAction<string>>;
  setSessionDraft: React.Dispatch<React.SetStateAction<string>>;
  setEditingWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>;
  setEditingSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setWorkspaceMenu: React.Dispatch<
    React.SetStateAction<{
      id: string;
      x: number;
      y: number;
      source: HTMLButtonElement;
    } | null>
  >;
  commitWorkspaceRename: () => void;
  commitSessionRename: (session: UnifiedSession) => void;
  startSessionRename: (session: { id: string; title: string }) => void;
}

interface WorkspaceControllerRows {
  rowOwnsSelection: (row: WsRow) => boolean;
  wsRowRepo: (row: WsRow) => string;
  rowIsScratch: (row: WsRow) => boolean;
  rowShipsDirectlyToMain: (row: WsRow) => boolean;
  workspacePinState: (row: WsRow) => { pinned: boolean; toggle: () => void };
  togglePinnedKeys: (keys: string[]) => void;
  togglePinKey: (key: string) => void;
}

interface WorkspaceControllerActions {
  confirmDeleteDraft: (onConfirm: () => void) => void;
  onDeleteWorkspace: Props["onDeleteWorkspace"];
  onArchiveWorkspace: Props["onArchiveWorkspace"];
  onArchive: Props["onArchive"];
  onSetStatus: Props["onSetStatus"];
  onNextChatAvailableChange: Props["onNextChatAvailableChange"];
  onToast: Props["onToast"];
  confirm: ReturnType<typeof useConfirm>[0];
}

interface WorkspaceControllerOptions {
  identity: WorkspaceControllerIdentity;
  data: WorkspaceControllerData;
  state: WorkspaceControllerState;
  refs: WorkspaceControllerRefs;
  navigation: WorkspaceControllerNavigation;
  editing: WorkspaceControllerEditing;
  rows: WorkspaceControllerRows;
  actions: WorkspaceControllerActions;
}

export function useSidebarWorkspaceController({
  identity: { currentUser, mePersonKey, teamViewing },
  data: {
    sessions,
    workspaces,
    wsRows,
    wsRowOrder,
    reads,
    activeSnoozeKeys,
    snoozes,
    subagentsByWorkspaceId,
  },
  state: {
    selectedId,
    selectedWorkspaceId,
    isPhone,
    showSubagents,
    groupsByRepo,
    runStartSeen,
    wsTimePref,
    workspaceDraft,
    sessionDraft,
    pins,
  },
  refs: { sidebarScrollRef, ref },
  navigation: { navigation, openSidebarSession, openNextSidebarItem },
  editing: {
    rowRenameEditing,
    setWorkspaceDraft,
    setSessionDraft,
    setEditingWorkspaceId,
    setEditingSessionId,
    setWorkspaceMenu,
    commitWorkspaceRename,
    commitSessionRename,
    startSessionRename,
  },
  rows: {
    rowOwnsSelection,
    wsRowRepo,
    rowIsScratch,
    rowShipsDirectlyToMain,
    workspacePinState,
    togglePinnedKeys,
    togglePinKey,
  },
  actions: {
    confirmDeleteDraft,
    onDeleteWorkspace,
    onArchiveWorkspace,
    onArchive,
    onSetStatus,
    onNextChatAvailableChange,
    onToast,
    confirm,
  },
}: WorkspaceControllerOptions) {
  // A draft workspace row (the composer sitting there prefilled, no session
  // yet) has nothing to archive: see mkRow's draft loop above, the only
  // place a sessionless row is ever pushed. Its removal action is delete,
  // not archive.
  function isDraftWsRow(row: WsRow): boolean {
    return !!row.workspace?.draft && row.sessions.length === 0;
  }

  const wsSwipeOffset = useRef(0);

  function deleteDraftWsRow(row: WsRow) {
    const ws = row.workspace;
    if (!ws) return;
    Promise.resolve(onDeleteWorkspace(ws.id)).catch(() => {
      // Delete failed: bring the row back instead of leaving it slid
      // off-screen and pointing at a workspace that is still there.
      setWsSwipe(null);
      wsSwipeOffset.current = 0;
    });
  }

  function rowIsSnoozed(row: WsRow): boolean {
    return activeSnoozeKeys.has(row.key);
  }

  function toggleWorkspaceSnooze(row: WsRow) {
    if (rowIsSnoozed(row)) clearSnooze(row.key);
    else setSnooze(row.key, SNOOZE_SOMEDAY);
  }

  function archiveWorkspaceWithNext(
    row: WsRow,
    current: HTMLButtonElement | null = null,
  ) {
    onArchiveWorkspace(
      row.sessions,
      openNextSidebarItem(`workspace:${row.key}`, current),
    );
  }

  /**
   * Hide a row from THIS user's sidebar, leaving the sessions untouched for
   * everyone else (the point of the feature — see `hiddenRowKeys`). Drops the
   * row's pins and any snooze first: a pinned-but-hidden row would snap to the
   * top of Pinned the moment it resurfaced, and a snooze wake would resurface
   * a row the user just hid. Lane membership is deliberately kept, so a
   * restored row returns to where it was.
   */
  function hideRow(row: WsRow) {
    const pinnedKeys = [
      row.key,
      ...row.sessions.flatMap((c) => [c.id, ...(c.aliasIds || [])]),
    ].filter((k, i, a) => pins.includes(k) && a.indexOf(k) === i);
    if (pinnedKeys.length) togglePinnedKeys(pinnedKeys);
    clearSnooze(row.key);
    // Keep something open if the row being hidden owns the active session.
    if (row.sessions.some((c) => c.id === selectedId)) {
      const candidates = wsRowOrder.filter((r) => r.sessions.length > 0);
      const idx = candidates.findIndex((r) => r.key === row.key);
      const rest = candidates.filter((r) => r.key !== row.key);
      const next =
        idx >= 0
          ? (rest[Math.min(idx, rest.length - 1)] ?? null)
          : (rest[0] ?? null);
      if (next) openSidebarSession(next.sessions[0]);
    }
    setHide(row.key);
  }

  // Archive just the open session and pick what becomes active. A workspace
  // with another tab stays on that workspace. When its last tab goes away, the
  // rendered list decides what opens next.
  function archiveOpenSessionWithNext() {
    const row = wsRowOrder.find((candidate) =>
      candidate.sessions.some((session) => session.id === selectedId),
    );
    if (!row) {
      // The open session can be hidden by the current person/repo/search lens.
      // Archiving the active session must not depend on it being rendered.
      const session = sessions.find((s) => s.id === selectedId && !s.archived);
      if (session)
        onArchive(session, openNextSidebarItem(`session:${session.id}`));
      return;
    }
    const session = row.sessions.find(
      (candidate) => candidate.id === selectedId,
    );
    if (!session) return;
    const siblings = row.sessions.filter(
      (candidate) => candidate.id !== selectedId,
    );
    if (siblings.length > 0) {
      const sessionIdx = row.sessions.findIndex(
        (candidate) => candidate.id === selectedId,
      );
      const sibling =
        siblings[Math.min(sessionIdx, siblings.length - 1)] ?? null;
      onArchive(
        session,
        sibling
          ? () => {
              openSidebarSession(sibling);
              return true;
            }
          : null,
      );
      return;
    }
    onArchive(session, openNextSidebarItem(`workspace:${row.key}`));
  }

  React.useImperativeHandle(ref, () => ({
    archiveSelected: archiveOpenSessionWithNext,
  }));

  const reportedNextChatAvailable = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const sidebar = sidebarScrollRef.current?.querySelector(
      "[data-sidebar-list]",
    );
    const workspaceItems = Array.from(
      sidebar?.querySelectorAll<HTMLButtonElement>("button[data-ws-row]") ?? [],
    );
    const renderedItems = Array.from(
      sidebar?.querySelectorAll<HTMLButtonElement>(
        "button[data-sidebar-row]",
      ) ?? [],
    );
    const available = !!(
      nextUnreadRenderedWorkspaceItem(workspaceItems) ??
      nextRenderedSidebarChat(renderedItems)
    );
    if (reportedNextChatAvailable.current === available) return;
    reportedNextChatAvailable.current = available;
    onNextChatAvailableChange?.(available);
  });

  // Advertised keycaps, read through the registry so a rebind in Settings
  // repaints the hints instead of leaving them describing the old chord.
  const newSessionKeys = useShortcutKeys("session-new");
  const pinShortcutKeys = useShortcutKeys("session-pin");
  const archiveShortcutKeys = useShortcutKeys("session-archive");

  // ── Workspace hover card ────────────────────────────────────────────────
  // The same card every WorkspaceRow raises, driven by the shared controller:
  // one card serves the whole list (only one row can be dwelled on at a time),
  // and the hovered row supplies its content and anchor. The hovered
  // row is its anchor. The card carries actions (Archive, PR link,
  // thumbnails), so leaving the row schedules the close with a short grace
  // period and entering the card cancels it — the pointer can travel the 8px
  // gap without the card vanishing under it.
  const wsHoverOpenT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsHoverCloseT = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The row element itself is the anchor — the popover tracks it, so a
  // scrolling list repositions the card instead of dropping it.
  const [wsHover, setWsHover] = useState<{
    row: WsRow;
    el: HTMLElement;
  } | null>(null);
  // Mobile long-press sheet (the touch stand-in for the hover card).
  const [wsSheet, setWsSheet] = useState<{
    row: WsRow;
    source: HTMLButtonElement;
  } | null>(null);

  const cancelWsHoverTimers = () => {
    if (wsHoverOpenT.current) clearTimeout(wsHoverOpenT.current);
    if (wsHoverCloseT.current) clearTimeout(wsHoverCloseT.current);
    wsHoverOpenT.current = null;
    wsHoverCloseT.current = null;
  };
  function wsRowHoverEnter(row: WsRow, el: HTMLElement) {
    if (rowRenameEditing(row) || !pointerCanHover()) return;
    cancelWsHoverTimers();
    if (wsHover) {
      setWsHover({ row, el });
      return;
    }
    wsHoverOpenT.current = setTimeout(() => {
      setWsHover({ row, el });
    }, 380);
  }
  function scheduleWsHoverClose() {
    if (wsHoverOpenT.current) clearTimeout(wsHoverOpenT.current);
    wsHoverOpenT.current = null;
    if (wsHoverCloseT.current) clearTimeout(wsHoverCloseT.current);
    wsHoverCloseT.current = setTimeout(() => setWsHover(null), 140);
  }
  function closeWsHover() {
    cancelWsHoverTimers();
    setWsHover(null);
  }
  useEffect(() => cancelWsHoverTimers, []);

  // ⌘E (or the legacy ⌘⇧A) archives the open session and lands on the next entry
  // in the sidebar, rather than dropping back to Home. This lives here (not in
  // the viewer) because the sidebar owns the row ordering that defines "next".
  // The viewer keeps the same chord only for the unarchive toggle on an
  // already-archived session — that session isn't in this list, so this
  // handler no-ops on it and the two never both fire. ⌘⌥⇧A below escalates to
  // the whole workspace.
  const handleArchiveSessionKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented || !matchesShortcut(e, "session-archive")) return;
    if (blockingOverlayOpen()) return;
    if (editableSwallowsArchiveChord(e.target)) return;
    const canArchive = sessions.some((s) => s.id === selectedId && !s.archived);
    if (!canArchive) return;
    e.preventDefault();
    closeWsHover();
    archiveOpenSessionWithNext();
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => handleArchiveSessionKey(e);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ⌘⌥⇧A escalates the session archive (⌘E/⌘⇧A) to the whole active workspace.
  // The Alt modifier is the only thing that separates the two handlers, so
  // exactly one fires. Targets the workspace holding the open session.
  const handleArchiveWorkspaceKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented || !matchesShortcut(e, "workspace-archive")) return;
    if (editableSwallowsArchiveChord(e.target)) return;
    const row = wsRowOrder.find(
      (r) =>
        r.sessions.length > 0 && r.sessions.some((c) => c.id === selectedId),
    );
    if (!row) return;
    e.preventDefault();
    closeWsHover();
    archiveWorkspaceWithNext(row);
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => handleArchiveWorkspaceKey(e);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ⌘P pins the open session's workspace ROW, so the chord and the row's own
  // pin button move the same pin. They used to move different ones: the button
  // pins the workspace key (plus any legacy member-session pins), the viewer's
  // chord pins the session id, so a row pinned by click and then unpinned by
  // chord stayed pinned and the keypress looked dead.
  // The viewer keeps the chord for sessions this list doesn't render — an
  // archived one, or one the current lens filters out. Capture phase, so this
  // runs before the viewer's window listener whatever order they mounted in,
  // and `preventDefault` is what tells it we took the key.
  const handlePinWorkspaceKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented || !matchesShortcut(e, "session-pin")) return;
    if (blockingOverlayOpen()) return;
    // Decline inside a text field rather than swallowing the key: the
    // viewer's own handler still sees it, so this only ever adds row
    // semantics, never removes the chord from where it worked before.
    if (editableSwallowsArchiveChord(e.target)) return;
    const row = wsRowOrder.find(rowOwnsSelection);
    if (!row) return;
    e.preventDefault();
    workspacePinState(row).toggle();
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => handlePinWorkspaceKey(e);
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // ⌘↓/⌘↑ cycle through the sidebar's rendered items in visual order (down =
  // next row), wrapping at the ends. Reading the DOM here is intentional: each
  // section owns its filtering and collapsed state, so rendered buttons are the
  // single source of truth for what keyboard navigation can reach.
  // Declines inside a text field, the composer included: there ⌘↑/⌘↓ are the
  // caret's own moves to the start and end of the draft, and taking them for
  // workspace cycling costs more than it gives. An empty composer is the one
  // exception, and editableOwnsCaretChord carries the reason. Alt is excluded
  // so ⌘⌥ arrows stay free for the reasoning-effort chord (SessionViewer);
  // Shift so ⌘⇧-arrow text selection keeps working.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      const dir = matchesShortcut(e, "sidebar-next")
        ? 1
        : matchesShortcut(e, "sidebar-prev")
          ? -1
          : 0;
      if (dir === 0) return;
      if (editableOwnsCaretChord(e.target)) return;
      if (blockingOverlayOpen()) return;
      const candidates = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          "[data-sidebar-list] button[data-sidebar-row]",
        ),
      );
      if (candidates.length === 0) return;
      const idx = candidates.findIndex((item) =>
        item.hasAttribute("data-selected"),
      );
      // No selected sidebar item (e.g. Home): enter from the edge.
      const next =
        idx < 0
          ? dir === 1
            ? candidates[0]
            : candidates[candidates.length - 1]
          : candidates[(idx + dir + candidates.length) % candidates.length];
      if (!next) return;
      e.preventDefault();
      closeWsHover();
      next.scrollIntoView({ block: "nearest" });
      next.click();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Mobile: tap-to-open a workspace row fires from `touchend`, not the
  // synthesized click — same trick as SessionRow. The row has :hover styles
  // (the reveal-on-hover pin/archive swap, the hover background) plus a
  // mouseenter hover card, and iOS treats the first tap on such an element as
  // a hover-in, swallowing the click — so a click-driven open needs a second
  // tap. A hold that stays roughly in place for LONG_PRESS_MS opens the
  // workspace menu (the touch stand-in for right-click); real finger travel
  // (a scroll) cancels both. Only one touch happens at a time, so one set of
  // refs serves every row.
  const wsPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsPressOrigin = useRef<{ x: number; y: number } | null>(null);
  const wsLongPressed = useRef(false);
  const wsMoved = useRef(false);
  const wsSwipeOrigin = useRef<{ x: number; y: number; width: number } | null>(
    null,
  );
  const wsSwiping = useRef(false);
  const [wsSwipe, setWsSwipe] = useState<SwipeState | null>(null);
  const [wsDraggingKey, setWsDraggingKey] = useState<string | null>(null);
  // Which action the in-flight drag is revealing. Split from wsSwipe so a
  // touchmove only re-renders when the side FLIPS — the per-frame offset is
  // written straight to the DOM in wsRowTouchMove.
  const [wsDragSide, setWsDragSide] = useState<SwipeAction | null>(null);
  useEffect(() => {
    if (!isPhone) {
      setWsSwipe(null);
      wsSwipeOffset.current = 0;
      setWsDraggingKey(null);
      setWsDragSide(null);
    }
  }, [isPhone]);
  useEffect(() => {
    setWsSwipe(null);
    wsSwipeOffset.current = 0;
    setWsDraggingKey(null);
    setWsDragSide(null);
  }, [selectedId]);

  function clearWsPress() {
    if (wsPressTimer.current) clearTimeout(wsPressTimer.current);
    wsPressTimer.current = null;
    wsPressOrigin.current = null;
  }
  function wsRowTouchStart(row: WsRow, e: React.TouchEvent) {
    if (rowRenameEditing(row)) return;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    wsLongPressed.current = false;
    wsMoved.current = false;
    wsSwiping.current = false;
    clearWsPress();
    if (wsSwipe?.key && wsSwipe.key !== row.key) setWsSwipe(null);
    // After clearWsPress (which nulls it) so it survives to move/end.
    wsPressOrigin.current = { x: t.clientX, y: t.clientY };
    wsSwipeOrigin.current = {
      x: t.clientX - (wsSwipe?.key === row.key ? wsSwipe.offset : 0),
      y: t.clientY,
      width: e.currentTarget.clientWidth,
    };
    const source = e.currentTarget as HTMLButtonElement;
    wsPressTimer.current = setTimeout(() => {
      wsLongPressed.current = true;
      closeWsHover();
      navigator.vibrate?.(10);
      // The touch stand-in for both the hover card AND right-click: a
      // bottom sheet with the overview block plus every workspace action.
      setWsSheet({ row, source });
    }, LONG_PRESS_MS);
  }
  function wsRowTouchMove(row: WsRow, e: React.TouchEvent) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const swipeO = wsSwipeOrigin.current;
    if (swipeO && !wsLongPressed.current) {
      const dx = t.clientX - swipeO.x;
      const dy = t.clientY - swipeO.y;
      if (
        wsSwiping.current ||
        (Math.abs(dx) > SWIPE_AXIS_LOCK_PX && Math.abs(dx) > Math.abs(dy))
      ) {
        wsSwiping.current = true;
        wsMoved.current = true;
        setWsDraggingKey(row.key);
        clearWsPress();
        e.preventDefault();
        const offset = clampSwipe(dx, swipeO.width);
        wsSwipeOffset.current = offset;
        // Per-frame position goes straight to the DOM: a setState here
        // re-rendered the entire sidebar on every touchmove, which
        // phones can't do at 60fps. React only hears about drag start
        // and side flips; touchend reconciles the committed state.
        const btn = e.currentTarget as HTMLElement;
        btn.style.setProperty("--swipe-x", `${offset}px`);
        btn.parentElement?.style.setProperty(
          "--swipe-action-w",
          `${Math.max(SWIPE_REVEAL_PX, Math.abs(offset))}px`,
        );
        setWsDragSide(swipeActionForOffset(offset));
        return;
      }
    }
    const o = wsPressOrigin.current;
    if (!o) return;
    if (
      Math.abs(t.clientX - o.x) > LONG_PRESS_SLOP ||
      Math.abs(t.clientY - o.y) > LONG_PRESS_SLOP
    ) {
      wsMoved.current = true;
      clearWsPress();
    }
  }
  // A bold row points to unread activity, so that tab wins over the row's lane
  // or remembered tab. Rows with no unread activity keep their normal routing.
  function openWsRow(row: WsRow, review: boolean) {
    const mainSession = workspaceMainSession(row);
    const unreadSession = pickUnreadWorkspaceSession(
      row.sessions,
      selectedId,
      reads,
    );
    if (unreadSession) {
      if (row.workspace)
        navigation.openWorkspace(row.workspace.id, unreadSession.id);
      else openSidebarSession(unreadSession);
      return;
    }
    // Only open Review when there is something to inspect: a PR, or a branch or
    // worktree that can produce a diff. Otherwise use the normal workspace path.
    const reviewable =
      row.workspace?.prNumber !== undefined ||
      row.sessions.some((s) => sessionHasPr(s) || sessionHasWorkspace(s));
    if (review && reviewable && mainSession)
      navigation.openSessionReview(mainSession);
    else if (row.workspace) navigation.openWorkspace(row.workspace.id);
    // Pre-migration grouped rows have no workspace record to restore through.
    else if (mainSession) openSidebarSession(mainSession);
  }
  function wsRowTouchEnd(row: WsRow, e: React.TouchEvent, review = false) {
    const hadOrigin = wsPressOrigin.current !== null;
    const wasSwiping = wsSwiping.current;
    const rowWidth =
      wsSwipeOrigin.current?.width ?? e.currentTarget.clientWidth;
    // Read the committed distance straight off the ref (like SessionRow),
    // gated on the `wasSwiping` ref — NOT the `wsSwipe` state. Touch events are
    // continuous, so React can batch the last touchmove's setWsSwipe and not
    // re-render before touchend; a `wsSwipe?.key === row.key` gate would then
    // read stale state, collapse the offset to 0, and silently drop the swipe
    // (the intermittent "slide didn't archive"). The ref is always current.
    const swipeOffset = isPhone && wasSwiping ? wsSwipeOffset.current : 0;
    clearWsPress();
    wsSwipeOrigin.current = null;
    wsSwiping.current = false;
    setWsDraggingKey(null);
    setWsDragSide(null);
    // The drag wrote --swipe-x / --swipe-action-w straight onto the DOM;
    // React never owned them, so a re-render with an undefined style prop
    // won't remove them. Clear here; the committed wsSwipe state (if any)
    // re-applies them through the style props on this same flush.
    const rowEl = e.currentTarget as HTMLButtonElement;
    rowEl.style.removeProperty("--swipe-x");
    rowEl.parentElement?.style.removeProperty("--swipe-action-w");
    if (rowRenameEditing(row)) return;
    if (wasSwiping) {
      e.preventDefault();
      if (Math.abs(swipeOffset) >= fullSwipeThreshold(rowWidth)) {
        const action = swipeActionForOffset(swipeOffset);
        if (!action) return;
        setWsSwipe({
          key: row.key,
          offset: swipeCommitOffset(action, rowWidth),
          action,
        });
        window.setTimeout(() => {
          if (action === "archive") {
            if (isDraftWsRow(row)) deleteDraftWsRow(row);
            else archiveWorkspaceWithNext(row, rowEl);
          } else {
            workspacePinState(row).toggle();
            setWsSwipe({ key: row.key, offset: 0, action });
            window.setTimeout(() => setWsSwipe(null), SWIPE_COMMIT_MS);
          }
          wsSwipeOffset.current = 0;
        }, SWIPE_COMMIT_MS);
        return;
      }
      setWsSwipe(
        (() => {
          const snapped =
            Math.abs(swipeOffset) > SWIPE_OPEN_THRESHOLD
              ? swipeOffset > 0
                ? SWIPE_REVEAL_PX
                : -SWIPE_REVEAL_PX
              : 0;
          wsSwipeOffset.current = snapped;
          return snapped ? { key: row.key, offset: snapped } : null;
        })(),
      );
      return;
    }
    // A clean tap: started on this row, never became a long-press, never
    // turned into a scroll. Open now and swallow the ghost click — which
    // also keeps the synthesized mouseenter from opening the hover card.
    if (hadOrigin && !wsLongPressed.current && !wsMoved.current) {
      e.preventDefault();
      if (wsSwipe?.key === row.key && wsSwipe.offset !== 0) {
        setWsSwipe(null);
        wsSwipeOffset.current = 0;
        return;
      }
      openWsRow(row, review);
    } else if (wsLongPressed.current) {
      // Release after a long-press: the workspace sheet is already up —
      // swallow any ghost click so it can't land on the sheet (or its
      // backdrop's close handler) and immediately dismiss it.
      e.preventDefault();
    }
  }

  function renderWsRowImpl(
    row: WsRow,
    inbox: boolean,
    review = false,
    includeSubagents = true,
  ) {
    const active = rowOwnsSelection(row);
    const editing = rowRenameEditing(row);
    const rowPin = workspacePinState(row);
    const swipeOffset =
      isPhone && wsSwipe?.key === row.key ? wsSwipe.offset : 0;
    const swipeAction =
      isPhone && wsSwipe?.key === row.key ? (wsSwipe.action ?? null) : null;
    const subagents =
      includeSubagents && showSubagents
        ? subagentsForSelectedWorkspace(
            subagentsByWorkspaceId,
            row.workspace?.id,
            selectedWorkspaceId,
          )
        : [];
    const editingState = editing
      ? {
          value: row.workspace ? workspaceDraft : sessionDraft,
          onChange: row.workspace ? setWorkspaceDraft : setSessionDraft,
          onCommit: () =>
            row.workspace
              ? commitWorkspaceRename()
              : commitSessionRename(row.sessions[0]),
          onCancel: () =>
            row.workspace
              ? setEditingWorkspaceId(null)
              : setEditingSessionId(null),
        }
      : null;

    return (
      <React.Fragment key={row.key}>
        <WorkspaceRow
          row={row}
          presentation={{
            inbox,
            active,
            isPhone,
            isDraft: isDraftWsRow(row),
            hasSectionHeading: !rowIsScratch(row),
            groupsByRepo,
            repoName: wsRowRepo(row),
            runStartSeenMs: runStartSeen.get(row.key) ?? null,
            snoozed: rowIsSnoozed(row),
            snoozeIso: activeSnoozeKeys.has(row.key)
              ? (snoozes[row.key] ?? null)
              : null,
            timePreference: wsTimePref,
            shipsDirectlyToMain: rowShipsDirectlyToMain(row),
            pinned: rowPin.pinned,
          }}
          context={{
            editing: editingState,
            currentUser,
            mePersonKey,
            teamViewing,
          }}
          swipe={{
            offset: swipeOffset,
            action: swipeAction,
            dragging: wsDraggingKey === row.key,
            dragSide: wsDraggingKey === row.key ? wsDragSide : null,
          }}
          shortcuts={{
            pinShortcutKeys: pinShortcutKeys ?? undefined,
            archiveShortcutKeys: archiveShortcutKeys ?? undefined,
          }}
          events={{
            onActivate: (event) => {
              // Touch taps open from touchend (their ghost click is
              // preventDefault'd), so this is the mouse/desktop path. Still
              // swallow a click that ends a long-press, belt-and-suspenders.
              if (wsLongPressed.current) {
                wsLongPressed.current = false;
                event.preventDefault();
                return;
              }
              if (editing) return;
              // Keyboard activation has no mousedown. Give it the same
              // immediate selection feedback before the route render.
              previewSidebarSelection(
                sidebarScrollRef.current,
                event.currentTarget,
              );
              openWsRow(row, review);
            },
            onMouseEnter: (event) => wsRowHoverEnter(row, event.currentTarget),
            onMouseLeave: scheduleWsHoverClose,
            onMouseDown: (event) => {
              closeWsHover();
              if (event.button === 0 && !editing)
                previewSidebarSelection(
                  sidebarScrollRef.current,
                  event.currentTarget,
                );
            },
            onTouchStart: (event) => wsRowTouchStart(row, event),
            onTouchMove: (event) => wsRowTouchMove(row, event),
            onTouchEnd: (event) => wsRowTouchEnd(row, event, review),
            onTouchCancel: (event) => {
              clearWsPress();
              wsSwipeOrigin.current = null;
              wsSwiping.current = false;
              setWsDraggingKey(null);
              setWsDragSide(null);
              event.currentTarget.style.removeProperty("--swipe-x");
              event.currentTarget.parentElement?.style.removeProperty(
                "--swipe-action-w",
              );
            },
            onContextMenu: (event) => {
              event.preventDefault();
              // The sidebar background carries a menu of its own, so this
              // row has to claim the event rather than let both open.
              event.stopPropagation();
              if (wsLongPressed.current || wsPressOrigin.current) return;
              closeWsHover();
              setWorkspaceMenu({
                id: row.workspace ? row.workspace.id : row.key,
                x: event.clientX,
                y: event.clientY,
                source: event.currentTarget,
              });
            },
          }}
          actions={{
            onCloseSwipe: () => setWsSwipe(null),
            onTogglePin: rowPin.toggle,
            onToggleSnooze: () => toggleWorkspaceSnooze(row),
            onArchive: (current) => archiveWorkspaceWithNext(row, current),
            onDeleteDraft: () => deleteDraftWsRow(row),
            onConfirmDeleteDraft: confirmDeleteDraft,
            onOpenMention: (target) => {
              if (wsLongPressed.current) return;
              if (row.workspace)
                navigation.openWorkspace(row.workspace.id, target);
              else navigation.openSession(target);
            },
            onStartWorkspaceRename: () => {
              if (!row.workspace) return;
              setWorkspaceDraft(row.workspace.name);
              setEditingWorkspaceId(row.workspace.id);
            },
            onStartSessionRename: () => {
              if (row.sessions[0]) startSessionRename(row.sessions[0]);
            },
            onKeepInSidebar: () => onSetStatus(row.sessions, "mine"),
          }}
        />
        <SubagentRows
          items={subagents}
          selectedId={selectedId}
          onSelect={openSidebarSession}
          onArchive={(session) => onArchive(session, null)}
        />
      </React.Fragment>
    );
  }
  // One sidebar row per workspace: status dot (most urgent session), name, session
  // count, unread dot. Click opens the first session (or the workspace itself for
  // real workspaces — App resolves that to its first session / scoped New palette).
  // Right-click opens the workspace menu (pin / color / rename / delete);
  // double-click renames inline.
  function renderWsRow(row: WsRow) {
    return renderWsRowImpl(row, false);
  }

  // The "Needs review" band's rows: identical in every way except that a click
  // opens the workspace's Review tab (see openWsRow).
  function renderReviewWsRow(row: WsRow) {
    return renderWsRowImpl(row, false, true);
  }

  // Pinned is the row's visible placement while it is pinned. Its children stay
  // hidden here, keeping one visible subagent row per session.
  function renderPinnedWsRow(row: WsRow) {
    return renderWsRowImpl(row, false, false, false);
  }

  // `inbox` renders the Inbox-mode variant of the same row — a repo tile in
  // front of the title, idle timestamp on every row — with identical behavior
  // (click, swipe, context menu, pin, archive).
  // Separate impl rather than an optional param because `.map(renderWsRow)`
  // callers would pass the array index into it.
  //
  // `review` marks a row under the "Needs review" band, whose click opens the
  // Review tab instead of the session.

  const workspaceOverlays = (
    <>
      {/* One card for the whole workspace list: WorkspaceRow owns each row's
          DOM, while this controller owns the one shared hover state and popover.
          The hovered row is the anchor instead, with the same shell and card. */}
      <Popover.Root
        open={!!wsHover}
        onOpenChange={(open) => {
          if (!open) closeWsHover();
        }}
      >
        {wsHover && (
          <RowCardPopup anchor={wsHover.el}>
            <div
              onMouseEnter={cancelWsHoverTimers}
              onMouseLeave={scheduleWsHoverClose}
            >
              <WsCardBody
                row={wsHover.row}
                snoozed={rowIsSnoozed(wsHover.row)}
                onToggleSnooze={() => {
                  closeWsHover();
                  toggleWorkspaceSnooze(wsHover.row);
                }}
                onOpen={(session) => {
                  closeWsHover();
                  openSidebarSession(session);
                }}
              />
            </div>
          </RowCardPopup>
        )}
      </Popover.Root>
      {wsSheet &&
        (() => {
          const { row, source } = wsSheet;
          const ws = row.workspace;
          // Same pin resolution as the row's star and the right-click menu: a
          // row can be pinned via its own key or a legacy pin on any member
          // session (incl. alias ids) — unpin must clear all of them.
          const pinKey = ws ? `workspace:${ws.id}` : row.key;
          const pinnedKeys = [
            pinKey,
            row.key,
            ...row.sessions.flatMap((c) => [c.id, ...(c.aliasIds || [])]),
          ].filter((k, i, a) => pins.includes(k) && a.indexOf(k) === i);
          const pinned = pinnedKeys.length > 0;
          return (
            <WsMobileSheet
              row={row}
              pinned={pinned}
              onTogglePin={() => {
                if (pinned) togglePinnedKeys(pinnedKeys);
                else togglePinKey(pinKey);
              }}
              onClose={() => setWsSheet(null)}
              onArchive={() => archiveWorkspaceWithNext(row, source)}
              onSetStatus={(status) => onSetStatus(row.sessions, status)}
              snoozeUntil={
                activeSnoozeKeys.has(row.key)
                  ? (snoozes[row.key] ?? null)
                  : null
              }
              onSnooze={(until) =>
                until ? setSnooze(row.key, until) : clearSnooze(row.key)
              }
              onOpen={(session) => openSidebarSession(session)}
              onRename={() => {
                if (ws) {
                  setWorkspaceDraft(ws.name);
                  setEditingWorkspaceId(ws.id);
                } else if (row.sessions[0]) {
                  // Solo session rows rename the session itself.
                  startSessionRename(row.sessions[0]);
                }
              }}
              claimed={
                row.sessions.length === 0
                  ? null
                  : row.sessions.some((c) => isClaimed(c))
                    ? true
                    : row.sessions.some((c) => ownedBy(c, currentUser))
                      ? null
                      : false
              }
              unread={row.unread}
              onToggleRead={
                row.sessions.length > 0
                  ? () =>
                      row.sessions.forEach((c) =>
                        row.unread
                          ? markRead(c.id, c.lastActivity)
                          : markUnread(c.id),
                      )
                  : null
              }
              onCopyLink={
                row.sessions[0]
                  ? () =>
                      copyToClipboard(
                        absoluteLink(sessionPath(row.sessions[0])),
                        () => onToast?.("Link copied"),
                      )
                  : null
              }
              onDelete={
                ws
                  ? () => {
                      if (row.sessions.length === 0) {
                        confirmDeleteDraft(() => onDeleteWorkspace(ws.id));
                        return;
                      }
                      confirm({
                        title: `Delete workspace "${ws.name}"?`,
                        description:
                          "All sessions in this workspace will be permanently deleted.",
                        confirmLabel: "Delete",
                        destructive: true,
                        onConfirm: () => onDeleteWorkspace(ws.id),
                      });
                    }
                  : null
              }
            />
          );
        })()}
    </>
  );

  return {
    archiveWorkspaceWithNext,
    hideRow,
    isDraftWsRow,
    newSessionKeys,
    renderPinnedWsRow,
    renderReviewWsRow,
    renderWsRow,
    renderWsRowImpl,
    rowIsSnoozed,
    toggleWorkspaceSnooze,
    workspaceOverlays,
    wsHover,
    wsSheet,
    closeWsHover,
    cancelWsHoverTimers,
    scheduleWsHoverClose,
    setWsSheet,
  };
}
