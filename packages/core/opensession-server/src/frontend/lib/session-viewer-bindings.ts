import type { RefWebPanel } from "../components/FeedWebPane";
import type { RelatedSession } from "../components/SessionRelations";
import type { SubagentRef } from "../components/SubagentPane";
import type { Lane } from "./lanes";
import type { PortalTarget } from "./portals";
import type { UnifiedSession } from "./types";

export interface ComposerBinding {
  setTyping: (sessionId: string, active: boolean) => void;
  /** Bumped to clear the draft and return the session to the live edge. */
  resetSeq?: number;
  /** Focus the composer when the session opens. Ignored on phones. */
  autoFocus?: boolean;
  /** One-shot draft text appended from another surface, such as Checks. */
  prefill?: { seq: number; text: string } | null;
  onPrefillConsumed?: (seq: number) => void;
}

export interface SessionViewerAvailabilityBinding {
  /** Verified workspace role from the ordinary auth bootstrap. */
  canRepairSafety?: boolean;
  /** Open the next chat needing attention, or continue through the sidebar. */
  canOpenNextChat?: boolean;
  /** Start a new session in this workspace. Phone surfaces it in More. */
  canStartNewSession?: boolean;
  /** Start a session in a new workspace. Phone surfaces it as +. */
  canOpenNewWorkspace?: boolean;
  /** Whether relationship chips and delegated session links can navigate. */
  canOpenSession?: boolean;
  /** Whether PR/review triggers can foreground this session's Review view-tab. */
  canOpenReview?: boolean;
  /** Whether the Info panel can foreground this session's Assets view-tab. */
  canOpenAssets?: boolean;
  /** Whether stack map layer links can open another PR in the review panel. */
  canOpenPr?: boolean;
  /** Whether a running service can open in the center-panel browser. */
  canOpenPortal?: boolean;
  /** Whether a view-tab can return to this workspace's active session. */
  canOpenWorkspace?: boolean;
}

export interface SessionViewerLifecycleBinding {
  connected: boolean;
  /** A client-minted session whose server record is still being persisted. */
  pendingCreation?: boolean;
  /** A client-minted blank tab in an existing, already-ready workspace. */
  optimisticEmpty?: boolean;
  /** Opening prompt shown while a just-created session is still catching up
   * through the session poll. Reconciles away when the transcript arrives. */
  initialPending?: {
    content: string;
    user: string;
    sentAt: number;
    images?: string[];
    pastedTexts?: string[];
  };
  /** Archive through the sidebar so the nearest visible row becomes active. */
  onArchive?: () => void;
  /** Called after a successful archive (not unarchive), with whether archiving
   * gracefully stopped an in-flight owned turn — so the parent can toast. */
  onArchived?: (stoppedRun: boolean) => void;
  /** Rename this session (double-click the header title); empty resets it to
   * the derived title. Same handler the tab strip and sidebar use. */
  onRename?: (id: string, title: string) => void;
  /** Mirror live run state into the app-level session list for sidebar rows. */
  onRunningChange?: (id: string, isRunning: boolean) => void;
  /** Mirror a reviewer pick / sign-off into the app-level session list so the
   * sidebar's review bands flip immediately instead of waiting for a poll. */
  onReviewChange?: (
    id: string,
    request: NonNullable<UnifiedSession["reviewRequest"]> | null,
  ) => void;
}

export interface SessionViewerChromeBinding {
  /** Only the focused pane in a desktop tab split owns global shortcuts/title. */
  focused?: boolean;
  /** The unfocused half of a split keeps its conversation chrome-free. */
  hideHeader?: boolean;
  hideRightPanel?: boolean;
  /** App-level top-bar node above the tab strip; when present the header renders
   * there (name-on-top layout) instead of inline. */
  topbarEl?: HTMLElement | null;
  /** Right-side slot inside the mobile top bar (next to the centered title).
   * On phones the header actions portal there — a single iOS-style nav bar —
   * instead of rendering as their own row. Desktop ignores it. */
  headerActionsEl?: HTMLElement | null;
  /** Centered slot under the mobile top-bar title. On phones the composer's
   * model pill is hidden, so a compact tap-to-switch model selector portals
   * here instead. Desktop ignores it. */
  headerModelEl?: HTMLElement | null;
  /** Leading slot inside the mobile top-bar title pill. The repo tile portals
   * here so it sits in front of the title (Slack-header style); an archived
   * session replaces it with its archive mark. Desktop ignores it. */
  headerRepoEl?: HTMLElement | null;
  /** App-level right-column node (sibling of the left sidebar); when present the
   * workspace/sub-agent panel portals here so it spans the full height from the
   * top, instead of opening only below the session. */
  rightPanelEl?: HTMLElement | null;
}

export interface SessionViewerWorkspaceBinding {
  /**
   * The workspace this session belongs to. When set, the header titles the
   * WORKSPACE (every sibling session shows the same name — per-session titles live
   * on the tabs) and double-click renames the workspace, not the session.
   */
  workspaceName?: string;
  onRenameWorkspace?: (name: string) => void;
  /** The header overflow is workspace-scoped; session lifecycle belongs to its tab. */
  onArchiveWorkspace?: () => void;
  onDeleteWorkspace?: () => void | Promise<void>;
  /** Sibling sessions in this session's workspace (the tab strip's list, oldest
   * first) — feeds the floating overview panel's cross-session media. */
  workspaceSessions?: UnifiedSession[];
  /** Claim this workspace into your own per-user sidebar lanes ("mine"), or
   * release it (null) — the ⋯ menu's twin of the sidebar row's action. */
  onSetStatus?: (sessions: UnifiedSession[], status: Lane | null) => void;
  /** Every session — the pool the workspace-context picker and the PR panel
   * draw their sibling sessions from. */
  allSessions?: UnifiedSession[];
  /** True when the tab strip is on screen (2+ sessions, an open view tab, or a
   * split). The strip carries its own "+", so the header one stands down
   * rather than showing a second plus a few pixels above it. */
  tabStripVisible?: boolean;
  /** This workspace's closed sessions, newest activity first. With no strip
   * there is no history button, so the ⋯ menu carries the list instead. */
  archivedSessions?: UnifiedSession[];
  /** Un-archive a closed session, putting it back among the tabs. */
  onRestoreSession?: (session: UnifiedSession) => void;
}

export interface SessionViewerViewTabsBinding {
  /**
   * Whether the Review pane is foregrounded — driven by the top tab strip's
   * Review view-tab (App state), replacing the old inline Session|Review toggle.
   * When false, the session transcript shows.
   */
  showReview?: boolean;
  /**
   * Which PR the Review pane should land on, pulsed by the app when a sidebar
   * row or a `repo#123` chip opened it: a workspace can carry several PRs,
   * and the one you clicked says which you meant. `seq` re-applies the same
   * PR after you've switched targets by hand. Branch and number are both
   * optional — see lib/pr-focus.ts for what each caller knows.
   */
  reviewFocusPr?: {
    repo: string;
    branch?: string;
    number?: number;
    seq: number;
  } | null;
  /**
   * Whether the Preview environment pane (the PR's Vercel preview, full-width) is
   * foregrounded — driven by the top tab strip's Preview environment view-tab (App state).
   */
  showStaging?: boolean;
  /** Close this session's Preview environment view-tab (the deploy vanished, e.g. PR merged). */
  onCloseStaging?: () => void;
  /**
   * Whether the Assets pane (the session's scratch artifacts, full-width) is
   * foregrounded — driven by the top tab strip's Assets view-tab (App state).
   */
  showAssets?: boolean;
  /** Close this session's Assets view-tab (its last asset was deleted). */
  onCloseAssets?: () => void;
  /**
   * Whether the Terminal pane (interactive shells in this session's
   * workspace) is foregrounded — driven by the top tab strip's Terminal
   * view-tab (App state).
   */
  showTerminal?: boolean;
  /** Close this session's Terminal view-tab, tearing its shells down. */
  onCloseTerminal?: () => void;
  /**
   * Whether the Terminal tab is present in the strip at all — distinct from
   * `showTerminal`, which is only true while it is foregrounded. The shells
   * stay mounted (and their PTYs alive) whenever the tab exists, so that
   * switching away and back returns to the same session; closing the tab is
   * what tears them down.
   */
  terminalTabOpen?: boolean;
  /**
   * Whether the Conversation pane (the workspace's Plain support-ticket
   * thread, full-width) is foregrounded — driven by the top tab strip's
   * Conversation view-tab (App state).
   */
  showConversation?: boolean;
  /** The Plain thread the Conversation pane renders (workspace or session). */
  conversationThreadId?: string | null;
  /** Whether the feed web panel (Video view-tab) is foregrounded (App state). */
  showVideo?: boolean;
  /** The web panel spec of the workspace's feed-item ref (the feeds design). */
  videoPanel?: RefWebPanel | null;
  /** The feed item's title (pane header). */
  videoTitle?: string | null;
  /** Foregrounded full-width local-dev Preview view-tab (App state). */
  showPreviewTab?: boolean;
  /** Close the Preview view-tab (its Stop button / tab close). */
  onClosePreviewTab?: () => void;
  /** Foregrounded browser pane for a service selected in Portals. */
  showPortal?: boolean;
  /** The service currently loaded in the center-panel browser. */
  portalTarget?: PortalTarget | null;
}

export interface SessionViewerSubagentsBinding {
  /** Orchestrator this session was delegated from (when it's a worker
   * sub-session), and the worker sessions it in turn spawned. Powers the
   * header relationship chips. */
  parentSession?: RelatedSession | null;
  workerSessions?: RelatedSession[];
  /**
   * Whether the sub-agent pane (a Task drill-in from this session's transcript,
   * full-width) is foregrounded — driven by the top tab strip's sub-agent
   * view-tab (App state).
   */
  showSubagent?: boolean;
  /** Breadcrumb of opened sub-agents; the last entry is the one shown. */
  subagentStack?: SubagentRef[];
  /** Open/foreground a sub-agent (a Task call's "Watch" affordance). */
  onOpenSubagent?: (sessionId: string, agentId: string, label: string) => void;
  /** Pop back to the sub-agent that spawned the current one. */
  onSubagentBack?: (sessionId: string) => void;
  /** The name the pane read off a sub-agent's transcript, for its tab: a link
   *  carries agent ids only, so this is where a linked tab gets its label. */
  onSubagentLabel?: (sessionId: string, agentId: string, label: string) => void;
}

export interface SessionViewerProps {
  session: UnifiedSession;
  composer: ComposerBinding;
  availability: SessionViewerAvailabilityBinding;
  lifecycle: SessionViewerLifecycleBinding;
  chrome: SessionViewerChromeBinding;
  workspace: SessionViewerWorkspaceBinding;
  viewTabs: SessionViewerViewTabsBinding;
  subagents: SessionViewerSubagentsBinding;
}
