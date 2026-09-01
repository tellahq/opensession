import type { ReactNode } from "react";
import type { UnifiedSession } from "./types";

export type NewTabMorphOrigin = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type ViewTab = {
  /** Stable id, e.g. `review:<sessionId>`. */
  id: string;
  /** Tab label ("Review"). Also the tooltip/aria label when `icon` is set. */
  label: string;
  /** Whether this pane is the foregrounded tab. */
  active: boolean;
  /** Optional status-dot class (e.g. PR state) shown before the label. */
  dotClass?: string | null;
  /**
   * Optional glyph shown INSTEAD of the text label — the tab reads as just the
   * icon (e.g. Staging → a globe). `label` still supplies the tooltip/aria.
   */
  icon?: ReactNode;
  /**
   * Whether the tab carries a ×. Defaults to true; the workspace home sets it
   * false, because it only exists when it is the strip's last tab and closing
   * it would leave the workspace with none.
   */
  closable?: boolean;
};

export interface SessionTabsContent {
  /** Sibling sessions in the current workspace, in display order. */
  sessions: UnifiedSession[];
  /** Archived (closed) sessions of this workspace, newest activity first. */
  archivedSessions: UnifiedSession[];
  /** Session id of the active tab. */
  activeSessionId: string | null;
  /** Map of session id → swatch key for colored tabs. */
  colors: Record<string, string>;
  /**
   * Teammates currently in each session, by session id — one entry per person,
   * with your own devices already filtered out (see lib/presence). The sidebar
   * shows the same faces per WORKSPACE, which says someone is in this strip but
   * not which tab; this is that second half.
   */
  viewers?: Record<string, string[]>;
  /**
   * The strip's left-to-right arrangement — session ids and view-tab ids in ONE
   * list, so a pane (Review, Assets, …) can sit in front of a session. Ids the
   * list doesn't mention keep their natural place at the end.
   */
  order: string[];
  /**
   * Non-session "view" tabs (Review, Preview, …), in their natural order — they
   * follow the session tabs until dragged elsewhere (see `order`). Each is
   * bound to a session; selecting one foregrounds that pane, its × dismisses
   * it. Generalized so more panes (diff, terminal, …) can drop in later.
   */
  views: ViewTab[];
}

export interface SessionTabsLayout {
  /**
   * This bar is one column of a split. It renders even when it holds a single
   * tab (each column keeps its "+" however few tabs it has), and its tabs stay
   * draggable at any count — the drop target is the other column, so a bar
   * holding one tab must still be able to hand it over.
   */
  inSplit?: boolean;
  /** Show the archived-sessions menu — only the rightmost bar does. */
  showHistory?: boolean;
  /** The workspace's reusable empty tab, which morphs from and back into +. */
  emptySessionId?: string | null;
  /** Client-minted tab id available in the same optimistic render as the click. */
  morphingSessionId?: string | null;
  /** Pointer control rectangle that the opening tab grows from. */
  morphOrigin?: NewTabMorphOrigin | null;
  /** Where `moveAcross` lands — it names the menu item. */
  moveAcrossSide?: "left" | "right";
}

export interface SessionTabsActions {
  selectSession: (session: UnifiedSession) => void;
  setColor: (key: string, color: string | null) => void;
  /**
   * Commit a new left-to-right order for this bar's tabs (desktop drag-drop).
   * Receives the reordered ids — sessions and view tabs alike; the parent splices
   * them back into the workspace's order and persists it.
   */
  reorder: (orderedIds: string[]) => void;
  /** Dragging below the strip previews a left/right split over the content. */
  previewSplit?: (id: string | null, point?: { x: number; y: number }) => void;
  /** Return true when the drop created a split instead of committing a reorder. */
  dropIntoSplit?: (id: string, point: { x: number; y: number }) => boolean;
  /**
   * Hand a tab to the split's other column (the tab context menu's spelling of
   * the cross-bar drag). Only set on a bar that is part of a split.
   */
  moveAcross?: (id: string) => void;
  /** Foreground a view tab (show its pane). */
  selectView: (id: string) => void;
  /** Dismiss a view tab from the strip. */
  closeView: (id: string) => void;
  /**
   * Start a new session in this workspace. share = reuse the workspace worktree
   * (the + button's plain-click default), stack = new worktree branched off it,
   * ask = no worktree.
   */
  newSession?: (
    mode: "share" | "stack" | "ask",
    origin?: NewTabMorphOrigin,
  ) => void;
  /** Rename a session (double-click the title); empty title resets it. */
  rename: (id: string, title: string) => void;
  /** Close (archive) a session — the × revealed on hover. */
  close: (session: UnifiedSession) => void;
  /** Permanently delete a session from its tab's context menu. */
  delete?: (
    session: UnifiedSession,
    cleanWorktree: boolean,
  ) => void | Promise<void>;
  /** Un-archive a session from the history menu, back into the strip. */
  restore: (session: UnifiedSession) => void;
  /** Report a copy action's outcome ("Link copied", …). */
  toast: (message: string) => void;
}

export interface SessionTabsProps {
  content: SessionTabsContent;
  layout?: SessionTabsLayout;
  actions: SessionTabsActions;
}
