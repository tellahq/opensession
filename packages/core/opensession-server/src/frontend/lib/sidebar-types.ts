import React from "react";
import type { UnifiedSession, Workspace } from "./types";

export type OpenNextSidebarItem = () => boolean;

export interface Props {
  sessions: UnifiedSession[];
  /** Repositories registered on this instance, including ones with no sessions yet. */
  registeredRepos: string[];
  /** Shared-checkout repos whose sessions ship on the default branch, keyed by repo id. */
  directToMainBranches: Record<string, string>;
  /** The initial/live session list request failed entirely. */
  sessionsError: string | null;
  /** True until the first session-list request settles. */
  sessionsLoading: boolean;
  onRetrySessions: () => void;
  /** Initial sessions + project metadata have loaded, so dependent queues can render. */
  workspaceDataReady: boolean;
  /** Workspace folders that group sessions. */
  workspaces: Workspace[];
  selectedId: string | null;
  /** True while the pull request list is open: highlights its entry. */
  prsActive: boolean;
  /**
   * True while the Feed page is open: highlights its entry. Note this is the
   * Feed *tool*, not the sidebar's `feeds` (the Slack/Linear/GitHub sources,
   * which the UI calls Sources).
   */
  feedActive: boolean;
  /** Whether the active server socket is connected. */
  connected: boolean;
  /** True while the Tasks tool is open. */
  tasksActive: boolean;
  /** Current open-task count. */
  taskCount?: number;
  /** The open workspace id (route or the open session's), for row selection. */
  selectedWorkspaceId?: string | null;
  /** True while the Support queue (the Plain tool) is open. */
  plainActive: boolean;
  /** True while the Support Tinder deck is open — highlights its entry. */
  supportTinderActive: boolean;
  /** True while the recurring Reports surface is open. */
  reportsActive: boolean;
  /** True while the Analytics surface is open. */
  analyticsActive: boolean;
  /**
   * Show the row for the session that hasn't started yet: with nothing in the
   * list, the sidebar still has one entry, and the main panel is its input.
   * App owns the flag so the row waits for the same loaded-and-empty answer
   * the panel does, instead of flashing while the first list request is out.
   */
  showDraftRow?: boolean;
  /** True while the main panel is showing that input. */
  draftRowActive?: boolean;
  /** Rename a project folder. */
  onRenameWorkspace: (id: string, name: string) => void;
  /** Delete a project folder and all of its sessions. A sessionless draft is
   *  simply removed. May reject; callers that need to react to failure (a swipe
   *  or long-press commit) await it. */
  onDeleteWorkspace: (id: string) => void | Promise<void>;
  /** True while the archived view is open — highlights the Archived row. */
  archivedActive: boolean;
  /** True while the catch-up deck is open — highlights its entry. */
  catchUpActive: boolean;
  /** Report whether Next can open attention work or another rendered chat. */
  onNextChatAvailableChange?: (available: boolean) => void;
  /**
   * Archive a session. `openNext` opens the rendered sidebar item after it, or
   * the previous item when it is last. It returns false when no item remains.
   */
  onArchive: (
    session: UnifiedSession,
    openNext: OpenNextSidebarItem | null,
  ) => void;
  /**
   * Archive every session in a workspace. `openNext` follows the same rendered
   * order as the row the person archived.
   */
  onArchiveWorkspace: (
    sessions: UnifiedSession[],
    openNext: OpenNextSidebarItem | null,
  ) => void;
  /** Rename a session (double-click its title); empty title resets it. */
  onRename: (session: UnifiedSession, title: string) => void;
  /**
   * Pin a workspace's sessions into a sidebar lane (or clear back to derived with
   * `null`). Applies to every session in the row so the aggregated row lands there.
   */
  onSetStatus: (sessions: UnifiedSession[], status: LaneChoice | null) => void;
  /** Who's viewing what right now (global presence), for live People rows. */
  teamViewing?: Array<{ user: string; sessionId: string }>;
  /**
   * The mobile top-bar's right-side actions slot. On phones the sidebar's
   * filter button lives here (next to Search) instead of in the workspace
   * header — the header's own filter/+ buttons are hidden on mobile.
   */
  headerActionsEl?: HTMLElement | null;
  /** Show a transient toast (e.g. "Link copied"). */
  onToast?: (message: string) => void;
}

export interface SidebarHandle {
  archiveSelected: () => void;
}

export interface PersonalBandPinnedEntry {
  key: string;
  /** Every pin key represented by this row. Legacy session pins move with the
   * workspace pin so one visible entry always reorders as one unit. */
  pinKeys: string[];
  /** Lane-drop payload. Empty sessions make non-work entries such as tickets
   * ineligible; repo limits nested lane targets to the matching project. */
  repo: string | null;
  sessions: UnifiedSession[];
  node: React.ReactNode;
}

// Groups are rendered in three visually separated bands (spacing between each):
//   "personal"    — My sessions (split by status), Pinned
//   "people"      — one group per other teammate (+ ownerless source groups)
//   "automations" — one group per automation
// Distinct from the *project* bands below (ProjectBands + the feed bands):
// a project is a source of work — a repo or a feed like Plain — and the rows
// inside it are workspaces. See CONCEPTS.md.
export type GroupBand = "personal" | "people" | "automations";

// The bands below the personal one get a text header ("People" / "Automations").
export function bandLabel(band: GroupBand): string | null {
  if (band === "people") return "People";
  if (band === "automations") return "Automations";
  return null;
}

export interface Group {
  key: string;
  label: string;
  dotColor: string | null;
  band: GroupBand;
  items: UnifiedSession[];
  /** Complete count when `items` is a bounded recent window. */
  totalItems?: number;
}

// "My sessions" is split, Conductor-style, into status buckets. Order + labels +
// dot color are defined here; a session is bucketed by the first rule it matches.
export type MineStatus =
  | "needsinput"
  | "merged"
  | "pending"
  | "review"
  | "inprogress";

// What a lane control can write: a forced status lane, "mine" (claimed into
// your sidebar, free to follow its live state), or null to drop the entry.
export type LaneChoice = MineStatus | "mine";

// The "review" key renders as "Ready to merge" since the PR-queue dissolution:
// the lane holds work whose PR is green and mergeable (plus anything manually
// pinned there). The key stays "review" because per-user lanes and the legacy
// manualStatus overrides persist it server-side.
export const MINE_STATUS_META: Array<{
  key: MineStatus;
  label: string;
  dotColor: string;
}> = [
  { key: "needsinput", label: "Needs input", dotColor: "var(--blue)" },
  { key: "inprogress", label: "In progress", dotColor: "var(--yellow)" },
  { key: "review", label: "Ready to merge", dotColor: "var(--green)" },
  { key: "pending", label: "Backlog", dotColor: "var(--text-faint)" },
  { key: "merged", label: "Done", dotColor: "var(--purple)" },
];

// ── Workspace rows ───────────────────────────────────────────────────────────
// The sidebar's main list is Workspaces (not individual sessions): one row per
// workspace, plus one implicit row per not-yet-wrapped standalone session (the
// pre-migration case — the data migration wraps those 1:1). A row's status
// dot is derived from its most urgent session; clicking opens the first session.
// It lives here rather than inside Sidebar so the lib modules that take a row
// (review-queue, hides, sidebar-lanes) can name the whole shape.
export interface WsRow {
  /** Pin/menu key: `workspace:<id>` for real workspaces, the session id solo. */
  key: string;
  /** Real workspace record, or null for an implicit single-session row. */
  workspace: Workspace | null;
  name: string;
  sessions: UnifiedSession[]; // createdAt asc, so sessions[0] is "the first session"
  status: MineStatus;
  lastActivity: string;
  createdAt: string;
  unread: boolean;
  /** Who tagged you in one of this row's sessions, if anyone. */
  mention?: string;
  /** The member session that mention lives on. The badge is a jump target:
      opening that exact session is what clears the mention (lib/mentions.ts),
      and the row's own click may open a different sibling. */
  mentionSessionId?: string;
  running: boolean;
  /** Lowercased owner (workspace creator, else the first session's starter). */
  owner: string;
}

// ── Right-click context menu (workspace / session / PR rows) ──────────────────
// A single presentational menu shared by every sidebar row that has one. Rows
// pass a flat list of entries; a `status` entry renders the "Set status" row
// with a hover flyout (the sub-panel is a sibling of the menu, not a child, so
// the menu's own overflow can't clip it).
export type CtxEntry =
  | {
      kind: "item";
      icon?: React.ReactNode;
      label: string;
      shortcut?: string;
      /** Pinned to the row's trailing edge, past the label. A tick for a
       * row that toggles something, where the leading slot is spent on
       * the thing's own icon. */
      trailing?: React.ReactNode;
      danger?: boolean;
      /** Leave the menu open after the click. For rows that toggle
       * something you often set more than one of (what shows in the
       * sidebar), where closing after each one turns four toggles into
       * four right-clicks. */
      keepOpen?: boolean;
      onClick: () => void;
    }
  | { kind: "sep" }
  /** Heading over the group of entries that follows it. */
  | { kind: "label"; label: string }
  | {
      kind: "status";
      current: MineStatus | null;
      onPick: (status: MineStatus | null) => void;
    }
  | {
      kind: "snooze";
      /** Active snooze expiry (ISO), or null when not snoozed. */
      until: string | null;
      /** ISO until to snooze, or null to unsnooze. */
      onPick: (until: string | null) => void;
    };
