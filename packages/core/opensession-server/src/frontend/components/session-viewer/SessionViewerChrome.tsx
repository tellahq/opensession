import * as stylex from "@stylexjs/stylex";
import { sx } from "../../ui/sx";
import {
  color,
  controlHeight,
  corner,
  geometry,
  layer,
  leading,
  motion,
  radius,
  space,
  text,
  tracking,
  weight,
} from "../../ui/tokens.stylex";
import type { TabStripPlacement } from "../../lib/split-tabs";
import type { useSessionModelWorkflowController } from "../../hooks/useSessionModelWorkflowController";
import { HuddleButton, huddleTarget } from "../huddle/HuddleButton";
import type React from "react";
import { useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { createPortal } from "react-dom";
import { BASE_PATH } from "../../lib/base";
import type {
  ExternalRef,
  GitStatusInfo,
  ReportMeta,
  DatabaseMeta,
  SessionUsage,
  TranscriptEntry,
  UnifiedSession,
} from "../../lib/types";
import { portalActionApi } from "../../lib/api";
import type {
  ModelOption,
  PreviewPortalRecipe,
  PreviewStatus,
  ProviderAccountOption,
  SessionSubagentSnapshot,
  WorkspaceMediaItem,
} from "../../lib/api";
import type { NavigationActions } from "../../lib/navigation";
import type { PortalTarget } from "../../lib/portals";
import type { SidePanelPage } from "../../lib/side-panel-open";
import type { SessionSocketSend } from "../../hooks/useSessionSocket";
import type { WorkflowRunSnapshot } from "../../../server/workflow-types";
import { DiffPanel, type SessionDiffState } from "../DiffPanel";
import { SessionHeader } from "../session/SessionHeader";
import { SidePanelToggle } from "../session/SidePanelToggle";
import { ArchivedSessionItems } from "../ArchivedSessionItems";
import { ModelMenuRow } from "../ModelMenuRow";
import { PortalsPage } from "../PortalsPanel";
import { PortalLaunchButton } from "../PortalLaunchButton";
import { PrStatusBar } from "../PrStatusBar";
import type { PrReviewPage } from "../PrPanel";
import { RepoBar } from "../RepoBar";
import { RepoTile } from "../RepoTile";
import { SandboxBadge } from "../SandboxBadge";
import { canMoveToSandbox, MoveToSandboxMenu } from "../MoveToSandboxMenu";
import { SessionReportsPanel } from "../SessionReportsPanel";
import { SessionDatabasesPanel } from "../SessionDatabasesPanel";
import { SpinOffMenu } from "../SpinOffMenu";
import { StagingLink } from "../StagingLink";
import { UsageMeter } from "../UsageMeter";
import { UserAvatar } from "../UserAvatar";
import { WorkflowPanel } from "../WorkflowPanel";
import type { PanelBrowserFrame } from "../../lib/panel-browser-frame";
import { WorkspaceSummary, WorkspaceSummaryBody } from "../WorkspaceSummary";
import { CollaboratorsSubmenu } from "../WorkspaceCollaborators";
import { WorkspaceWaiting } from "./busy-indicators";
import { ThreadsDetailsSection } from "../threads/ThreadsPanel";
import { CoordinatorOverflowItems } from "../threads/CoordinatorMenuItems";
import {
  IconArchive,
  IconCopy,
  IconDesk,
  IconDotsHorizontal,
  IconFile,
  IconGlobe,
  IconHistory,
  IconLink,
  IconListCircles,
  IconNewBranch,
  IconPencil,
  IconPlus,
  IconPullRequest,
  IconRobot,
  IconTrash,
} from "../icons";
import { KeepInSidebarIcon } from "../sidebar/KeepInSidebarMark";
import { Button } from "../../ui/button";
import type { ConfirmRequest } from "../../ui/confirm";
import { CopyCheck } from "../../ui/copy";
import {
  Menu,
  MENU_ICON,
  MenuLabel,
  MenuSubmenuArrow,
  MenuShortcut,
} from "../../ui/menu";
import { PulseDot } from "../../ui/status";
import { Tooltip } from "../../ui/tooltip";
import {
  TopBar,
  TopBarAction,
  TopBarActions,
  TopBarBack,
  TopBarTitle,
} from "../../ui/top-bar";
import { cn } from "../../ui/cn";
import { TAB_MENU_CONTROL } from "../../lib/session-tab-classes";
import { useTabMenuSlot } from "../../lib/tab-menu-slot";
import { toast } from "../../ui/toast";
import { copySessionTranscript } from "../../lib/transcript-copy";
import { dedupeViewers, facepileAvatarStyle } from "../../lib/presence";
import { personKey } from "../../lib/review-queue";
import { metadataModelLabel } from "./model-labels";
import { SessionBanners } from "../SessionBanners";
import { getCurrentUser } from "../UserPicker";
import {
  HEADER_SESSIONBAR,
  HEADER_SESSIONBAR_MODEL,
  HEADER_SESSIONBAR_SEP,
  HEADER_SESSIONBAR_USAGE,
} from "../../lib/app-header-classes";
import {
  VIEWER_OVERFLOW,
  VIEWER_PRESENCE,
  VIEWER_PRESENCE_AVATAR,
  infoTopbarClass,
  infoTopbarTitleClass,
} from "../../lib/session-viewer-classes";

interface ChromeIdentity {
  session: UnifiedSession;
  hasWorkspace: boolean;
  workspaceName: string | undefined;
  parentSession: React.ComponentProps<typeof SessionHeader>["parentSession"];
  workerSessions: React.ComponentProps<typeof SessionHeader>["workerSessions"];
  archivedSessions: UnifiedSession[] | undefined;
  workspaceSessions: UnifiedSession[] | undefined;
  tabStripVisible: TabStripPlacement | undefined;
  deskOwner: string;
  currentUser: string;
  newSiblingKeys: string[] | null;
  hasRepoWork: boolean;
  workspacePreparing: boolean;
  hasPlain: boolean;
  plainUrl: string;
}
interface ChromeLayout {
  hideHeader: boolean;
  isPhone: boolean;
  compactHeader: boolean;
  topbarEl: HTMLElement | null | undefined;
  headerActionsEl: HTMLElement | null | undefined;
  headerRepoEl: HTMLElement | null | undefined;
  headerModelEl: HTMLElement | null | undefined;
  headerRef: RefObject<HTMLDivElement | null>;
  headerActionsRef: RefObject<HTMLDivElement | null>;
  panelAvailable: boolean;
  panelOpen: boolean;
  activePanelOpen: boolean;
  summaryVisible: boolean;
  summaryHasRoom: boolean;
}
interface ChromeOverflowGit {
  sessionId: string;
  status: GitStatusInfo | null;
}

interface ChromePrTarget {
  repo: string;
  branch: string;
}

interface ChromeEffectiveReview {
  req: NonNullable<UnifiedSession["reviewRequest"]> | null;
  ownerId: string;
  acceptedFromPr: boolean;
  prReviewRequested: string[];
}

interface ChromeMenuState {
  overflowOpen: boolean;
  setOverflowOpen: Dispatch<SetStateAction<boolean>>;
  copied: boolean;
  copyTranscriptLabel: string | null;
  archiveShortcutLabel: string | null;
  archiving: boolean;
  branchActionBusy: "move" | "create" | null;
  setBranchConfirmMode: Dispatch<SetStateAction<"move" | "create">>;
  setBranchConfirmOpen: Dispatch<SetStateAction<boolean>>;
  overflowGit: ChromeOverflowGit | null;
  primaryPrNumber: number | undefined;
  livePortals: number;
  feedRef: ExternalRef | undefined;
  feedRefLabel: string;
  renameDraft: string | null;
}
interface ChromeSessionActions {
  canKeepInSidebar: boolean;
  canForkSession: boolean;
  keepInSidebar: () => void;
  handleShare: () => void;
  handleShareWorkspace: () => void;
  openNewSession: React.ComponentProps<typeof SessionHeader>["openNewSession"];
  openSession:
    | ((id: string, created?: UnifiedSession | null) => void)
    | undefined;
  onRestoreSession: ((session: UnifiedSession) => void) | undefined;
  onRename: ((id: string, title: string) => void) | undefined;
  setRenameDraft: Dispatch<SetStateAction<string | null>>;
  commitRename: (title?: string) => void;
  handleFork: (messageId?: string) => void;
  send: SessionSocketSend;
  connected: boolean;
  handleArchive: () => Promise<void>;
}
interface ChromeWorkspaceActions {
  setShowDeleteConfirm: Dispatch<SetStateAction<boolean>>;
  onArchiveWorkspace: (() => void) | undefined;
  onDeleteWorkspace: (() => void | Promise<void>) | undefined;
  confirm: (request: ConfirmRequest) => void;
  createPrFromMenu: () => void;
  focusPrInReview: (ref?: ChromePrTarget, view?: "checks") => void;
  openReview: (() => void) | undefined;
  openPr: ((repo: string, branch: string) => void) | undefined;
  openAssetFromTranscript: (path: string) => void;
  openAssets: (() => void) | undefined;
  /** Open the side panel on `page`, or on its overview (the toggle). */
  openActivePanel: (page?: SidePanelPage) => void;
  setSummaryOpen: Dispatch<SetStateAction<boolean>>;
  gitRefreshTick: number;
  reviewPage: PrReviewPage | null;
}
interface ChromeModel {
  models: ModelOption[];
  model: string;
  defaultModel: string;
  effectiveModel: string;
  handleModelChange: (next: string) => void;
  prettyModel: (id: string) => string;
  runPreferences: ReturnType<
    typeof useSessionModelWorkflowController
  >["model"]["runPreferences"];
  accounts: ProviderAccountOption[];
  accountId: string;
  handleAccountChange: (next: string) => void;
  usage: SessionUsage | undefined;
  isRunningLive: boolean;
}
interface ChromeInfoState {
  infoPageOpen: boolean;
  setInfoPageOpen: Dispatch<SetStateAction<boolean>>;
  infoPageScrolled: boolean;
  setInfoPageScrolled: Dispatch<SetStateAction<boolean>>;
  infoPageRef: RefObject<HTMLDivElement | null>;
  infoHeroNameRef: RefObject<HTMLHeadingElement | null>;
  panelPage: "changes" | "portals" | "agents" | "terminal" | null;
  setPanelPage: Dispatch<
    SetStateAction<"changes" | "portals" | "agents" | "terminal" | null>
  >;
  waitingForWorkspace: boolean;
  isBusy: boolean;
  noEngine: boolean;
  diffState: SessionDiffState;
  worktreeDiffSource: "worktree" | undefined;
  changeWorktreeDiffSource: (next: "pull-request" | "worktree") => void;
  previewStatus: PreviewStatus | null;
}
/** What the session has produced that outlives it: its published reports
 *  and the databases it created or wrote to. One prop on the chrome, so the
 *  info-actions group stays within its bound as the kinds of artifact grow. */
interface SessionArtifacts {
  reports: ReportMeta[];
  databases: DatabaseMeta[];
}
/** Starting a declared Portal, from the Portals page or the header's play
 *  button, and which recipe the button is waiting on to open. */
interface ChromePortalLaunch {
  start: (recipe: PreviewPortalRecipe) => Promise<void>;
  launching: string | null;
  setLaunching: (recipeId: string | null) => void;
}
interface ChromeInfoActions {
  setPreviewStatus: (status: PreviewStatus | null) => void;
  portalTarget: PortalTarget | null;
  openPortal: ((target: PortalTarget) => void) | undefined;
  portalLaunch: ChromePortalLaunch;
  workflowRuns: WorkflowRunSnapshot[];
  workflowAction: (
    runId: string,
    action: "cancel" | "pause" | "resume" | "skip" | "retry",
    seq?: number,
  ) => void;
  subagents: SessionSubagentSnapshot[];
  openSubagent: (agentId: string, label: string) => void | undefined;
  sessionArtifacts: SessionArtifacts;
  navigation: NavigationActions;
  effectiveReview: ChromeEffectiveReview;
  onReviewChange:
    | ((
        id: string,
        request: NonNullable<UnifiedSession["reviewRequest"]> | null,
      ) => void)
    | undefined;
  liveOverviewMedia: WorkspaceMediaItem[];
  setReviewSessionActionTarget: Dispatch<SetStateAction<HTMLDivElement | null>>;
  /** Open the shipped-change Slack composer for a direct ship. */
  openSlackComposer?: () => void;
}
interface ChromeConversation {
  others: string[];
  entries: TranscriptEntry[];
}
interface SessionViewerChromeProps {
  identity: ChromeIdentity;
  layout: ChromeLayout;
  menuState: ChromeMenuState;
  sessionActions: ChromeSessionActions;
  workspaceActions: ChromeWorkspaceActions;
  model: ChromeModel;
  infoState: ChromeInfoState;
  infoActions: ChromeInfoActions;
  conversation: ChromeConversation;
  /** The side panel Browser page the summary card previews, or null. */
  summaryBrowser: { frame: PanelBrowserFrame; onOpen: () => void } | null;
}

/** The phone workspace page rises into place as it opens. */
const infoPageIn = stylex.keyframes({
  from: { opacity: 0, transform: `translateY(${space.s8})` },
  to: { opacity: 1, transform: "translateY(0)" },
});

const styles = stylex.create({
  /** The phone workspace page: a full-screen scrolling column. Its children
   *  must not shrink (`[&>*]:shrink-0` at the call site): a column flex
   *  container still fits its children to its own height, and the one child
   *  that clips would give up its height first. */
  infoPage: {
    position: "fixed",
    inset: 0,
    zIndex: layer.sheet,
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    overflowY: "auto",
    overscrollBehavior: "contain",
    backgroundColor: color.page,
    paddingBottom: geometry.pagePadBottom,
    animationName: infoPageIn,
    animationDuration: motion.standard,
    animationTimingFunction: motion.ease,
  },
  /** Identity: repo tile, name, and the repo · model line. */
  infoHero: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    paddingInline: space.s20,
    paddingTop: space.s2,
    paddingBottom: space.s20,
    textAlign: "center",
  },
  /** The page's one heading. */
  infoName: {
    marginTop: space.s8,
    maxWidth: "100%",
    fontSize: text.pageTitle,
    fontWeight: weight.strong,
    lineHeight: leading.tight,
    letterSpacing: tracking.title,
    overflowWrap: "break-word",
    color: color.fg,
  },
  infoSub: {
    display: "flex",
    minHeight: controlHeight.touch,
    width: "100%",
    maxWidth: "100%",
    alignItems: "center",
    justifyContent: "center",
    columnGap: space.s4,
    paddingInline: space.s24,
    fontSize: text.label,
    fontWeight: weight.medium,
    color: color.dim,
  },
  infoContent: {
    minHeight: geometry.infoContentMinHeight,
    paddingBottom: space.s8,
  },
  /** Each section brings its own quiet plate. */
  infoSummaryCard: {
    marginInline: space.s12,
    marginTop: space.s8,
    display: "flex",
    flexDirection: "column",
    gap: space.s10,
  },
  /** A section rendered by its own component: the page's inset, 16px above. */
  infoSection: { marginTop: space.s16, paddingInline: space.s12 },
  /** Header controls sit 6px apart. */
  keepGap: { marginInlineEnd: space.s6 },
  contents: { display: "contents" },
  diffUnderInfoBar: { "--diff-panel-top": geometry.infoBarClearance },
  dim: { color: color.dim },
  heroModel: {
    display: "inline-flex",
    minHeight: controlHeight.touch,
    alignItems: "center",
    paddingInline: space.s6,
  },
  sandboxCard: {
    display: "flex",
    minHeight: controlHeight.touch,
    alignItems: "center",
    borderRadius: radius.xxl,
    ["cornerShape"]: corner.squircle,
    backgroundColor: color.panel,
    paddingInline: space.s20,
    paddingBlock: space.s8,
  },
});

export function SessionViewerChrome({
  identity,
  layout,
  menuState,
  sessionActions,
  workspaceActions,
  model: modelState,
  infoState,
  infoActions,
  conversation,
  summaryBrowser,
}: SessionViewerChromeProps) {
  const {
    session,
    hasWorkspace,
    workspaceName,
    parentSession,
    workerSessions,
    archivedSessions,
    workspaceSessions,
    tabStripVisible,
    deskOwner,
    currentUser,
    newSiblingKeys,
    hasRepoWork,
    workspacePreparing,
    hasPlain,
    plainUrl,
  } = identity;
  const {
    hideHeader,
    isPhone,
    compactHeader,
    topbarEl,
    headerActionsEl,
    headerRepoEl,
    headerModelEl,
    headerRef,
    headerActionsRef,
    panelAvailable,
    panelOpen,
    activePanelOpen,
    summaryVisible,
    summaryHasRoom,
  } = layout;
  const {
    overflowOpen,
    setOverflowOpen,
    copied,
    copyTranscriptLabel,
    archiveShortcutLabel,
    archiving,
    branchActionBusy,
    setBranchConfirmMode,
    setBranchConfirmOpen,
    overflowGit,
    primaryPrNumber,
    livePortals,
    feedRef,
    feedRefLabel,
    renameDraft,
  } = menuState;
  const {
    canKeepInSidebar,
    canForkSession,
    keepInSidebar,
    handleShare,
    handleShareWorkspace,
    openNewSession,
    openSession,
    onRestoreSession,
    onRename,
    setRenameDraft,
    commitRename,
    handleFork,
    send,
    connected,
    handleArchive,
  } = sessionActions;
  const {
    setShowDeleteConfirm,
    onArchiveWorkspace,
    onDeleteWorkspace,
    confirm,
    createPrFromMenu,
    focusPrInReview,
    openReview,
    openPr,
    openAssetFromTranscript,
    openAssets,
    openActivePanel,
    setSummaryOpen,
    gitRefreshTick,
    reviewPage,
  } = workspaceActions;
  const showReview = reviewPage !== null;
  const {
    models,
    model,
    defaultModel,
    effectiveModel,
    handleModelChange,
    prettyModel,
    runPreferences,
    accounts,
    accountId,
    handleAccountChange,
    usage,
    isRunningLive,
  } = modelState;
  const {
    effort,
    setEffort,
    speed,
    setSpeed,
    autoFallback,
    changeAutoFallback,
  } = runPreferences;
  const {
    infoPageOpen,
    setInfoPageOpen,
    infoPageScrolled,
    setInfoPageScrolled,
    infoPageRef,
    infoHeroNameRef,
    panelPage,
    setPanelPage,
    waitingForWorkspace,
    isBusy,
    noEngine,
    diffState,
    worktreeDiffSource,
    changeWorktreeDiffSource,
    previewStatus,
  } = infoState;
  // The new layout's open tab has a slot for this session's ⋯ menu; while
  // it does, the menu lives there instead of in the header.
  const tabMenuSlot = useTabMenuSlot(session.id);
  const menuInTab = !isPhone && !infoPageOpen && !!tabMenuSlot;
  const {
    setPreviewStatus,
    portalTarget,
    openPortal,
    portalLaunch,
    workflowRuns,
    workflowAction,
    subagents,
    openSubagent,
    sessionArtifacts,
    navigation,
    effectiveReview,
    onReviewChange,
    liveOverviewMedia,
    setReviewSessionActionTarget,
    openSlackComposer,
  } = infoActions;
  const { others, entries } = conversation;
  /** The goal/loop strip under the header; the Workspace summary card hangs
   *  below it instead of over it. */
  const [bannerHeight, setBannerHeight] = useState(0);
  return (
    <>
      {!hideHeader &&
        (() => {
          const workspaceScopedMenu = Boolean(session.workspaceId);
          const keepInSidebarAction = (inMenu: boolean) =>
            canKeepInSidebar &&
            (inMenu ? (
              <Menu.Item onClick={keepInSidebar} title="Add to sidebar">
                <KeepInSidebarIcon className={MENU_ICON} />
                <MenuLabel>Add to sidebar</MenuLabel>
              </Menu.Item>
            ) : (
              <Button
                size="md"
                variant="default"
                xstyle={styles.keepGap}
                icon={<KeepInSidebarIcon />}
                iconTone="full"
                onClick={keepInSidebar}
                title="Add to sidebar"
              >
                Add to sidebar
              </Button>
            ));
          // Share rides inline on a wide header but tucks into the ⋯ overflow
          // menu when it gets narrow. Both spellings use the link glyph, since
          // the action copies a link rather than opening a share sheet. Inline
          // it's icon-only (the header is dense, and the glyph carries it); in
          // the menu it keeps a label so it lines up with the other rows. The
          // copied confirmation is CopyCheck's green checkmark in both.
          const shareAction = (inMenu: boolean) =>
            inMenu ? (
              <Menu.Item
                onClick={
                  workspaceScopedMenu ? handleShareWorkspace : handleShare
                }
                title={
                  workspaceScopedMenu
                    ? "Copy a link to this workspace"
                    : "Copy a link to this session"
                }
              >
                <CopyCheck
                  copied={copied}
                  idle={<IconLink size={20} />}
                  size={20}
                  className={MENU_ICON}
                />
                <MenuLabel>
                  {copied
                    ? "Copied"
                    : workspaceScopedMenu
                      ? "Share workspace"
                      : "Share"}
                </MenuLabel>
              </Menu.Item>
            ) : (
              <Button
                size="md"
                variant="ghost"
                // 22 = the icon scale's "standard standalone" step, so it reads
                // level with the ⋯ and side-panel glyphs beside it.
                icon={
                  <CopyCheck
                    copied={copied}
                    idle={<IconLink size={22} />}
                    size={22}
                  />
                }
                className="rounded-control"
                onClick={handleShare}
                title="Copy a link to this session"
                aria-label="Share"
              />
            );
          // The tab strip hides on phones, so More carries its
          // sibling-session action.
          const newSessionAction = isPhone && openNewSession && (
            <Menu.Item
              onClick={() => {
                setOverflowOpen(false);
                void openNewSession("share");
              }}
              title="Start a new session in this workspace"
            >
              <IconPlus size={20} className={MENU_ICON} />
              <MenuLabel>New session in workspace</MenuLabel>
            </Menu.Item>
          );
          // Closed sessions of this workspace. They normally hang off the tab
          // strip's history button, so this appears exactly when there is no
          // strip to hold it — a lone session, which is when someone is most
          // likely to go looking for what was closed.
          const archivedActions = !tabStripVisible &&
            !!archivedSessions?.length &&
            openSession &&
            onRestoreSession && (
              <Menu.SubmenuRoot>
                <Menu.SubmenuTrigger title="Closed sessions in this workspace">
                  <IconHistory size={20} className={MENU_ICON} />
                  <MenuLabel>Archived sessions</MenuLabel>
                  <MenuSubmenuArrow />
                </Menu.SubmenuTrigger>
                <Menu.Popup className="min-w-menu-wide">
                  <ArchivedSessionItems
                    sessions={archivedSessions}
                    onSelect={(s) => {
                      setOverflowOpen(false);
                      openSession(s.id);
                    }}
                    onRestore={(s) => {
                      setOverflowOpen(false);
                      onRestoreSession(s);
                    }}
                  />
                </Menu.Popup>
              </Menu.SubmenuRoot>
            );
          // Copy transcript. These normally live on a tab's right-click menu,
          // but a lone-session workspace has no tab strip (and phones hide it at
          // every count), so the only place to grab this session's full text is the
          // ⋯ menu — surface both modes here when the strip isn't offering them.
          const showTranscriptActions =
            isPhone || (workspaceSessions?.length ?? 1) <= 1;
          const transcriptActions = showTranscriptActions && (
            <Menu.SubmenuRoot>
              <Menu.SubmenuTrigger title="Copy this session's transcript">
                <IconCopy size={20} className={MENU_ICON} />
                <MenuLabel>Copy transcript</MenuLabel>
                <MenuSubmenuArrow />
              </Menu.SubmenuTrigger>
              <Menu.Popup>
                <Menu.Item
                  onClick={() => {
                    setOverflowOpen(false);
                    void copySessionTranscript(session, "concise", toast);
                  }}
                  title="Copy a trimmed transcript of this session"
                >
                  <IconListCircles size={20} className={MENU_ICON} />
                  <MenuLabel>Concise</MenuLabel>
                  {copyTranscriptLabel && (
                    <Menu.Shortcut>{copyTranscriptLabel}</Menu.Shortcut>
                  )}
                </Menu.Item>
                <Menu.Item
                  onClick={() => {
                    setOverflowOpen(false);
                    void copySessionTranscript(session, "full", toast);
                  }}
                  title="Copy the complete transcript of this session"
                >
                  <IconFile size={20} className={MENU_ICON} />
                  <MenuLabel>Full</MenuLabel>
                </Menu.Item>
              </Menu.Popup>
            </Menu.SubmenuRoot>
          );
          // A code session on this machine can move into a Sandbox: a rare,
          // one-way choice that reads as a session action, not as status,
          // so it lives here rather than on a header badge.
          const moveToSandboxAction = canMoveToSandbox(session) && (
            <MoveToSandboxMenu
              session={session}
              running={isBusy}
              confirm={confirm}
              onClose={() => setOverflowOpen(false)}
            />
          );
          // Portals is a workspace tool, not the lead fact on the phone's
          // workspace overview. Keep it reachable from the shared ⋯ menu at
          // every width; desktop opens its panel page, phone opens the drill-in.
          const portalsAction = hasWorkspace && (
            <Menu.Item
              onClick={() => {
                setOverflowOpen(false);
                if (isPhone) {
                  setPanelPage("portals");
                  setInfoPageScrolled(false);
                  setInfoPageOpen(true);
                } else {
                  openActivePanel("portals");
                }
              }}
            >
              <IconGlobe size={20} className={MENU_ICON} />
              <MenuLabel>Portals</MenuLabel>
              {livePortals > 0 && (
                <MenuShortcut>{livePortals} live</MenuShortcut>
              )}
            </Menu.Item>
          );
          const menuGit =
            overflowGit?.sessionId === session.id ? overflowGit.status : null;
          const branchAction =
            !primaryPrNumber && menuGit ? (
              menuGit.sharedCheckout ? (
                <>
                  <Menu.Item
                    disabled={isBusy || branchActionBusy !== null}
                    onClick={() => {
                      setOverflowOpen(false);
                      setBranchConfirmMode("move");
                      setBranchConfirmOpen(true);
                    }}
                    title="Move this session into an isolated worktree"
                  >
                    <IconNewBranch size={20} className={MENU_ICON} />
                    <MenuLabel>
                      {branchActionBusy === "move"
                        ? "Moving…"
                        : "Move to branch"}
                    </MenuLabel>
                  </Menu.Item>
                  <Menu.Item
                    disabled={!connected || isBusy || branchActionBusy !== null}
                    onClick={() => {
                      setOverflowOpen(false);
                      setBranchConfirmMode("create");
                      setBranchConfirmOpen(true);
                    }}
                    title="Move to a branch and create a pull request"
                  >
                    <IconPullRequest size={20} className={MENU_ICON} />
                    <MenuLabel>Create PR</MenuLabel>
                  </Menu.Item>
                </>
              ) : menuGit.branch ? (
                <Menu.Item
                  disabled={!connected}
                  onClick={createPrFromMenu}
                  title="Ask this session to create a pull request"
                >
                  <IconPullRequest size={20} className={MENU_ICON} />
                  <MenuLabel>Create PR</MenuLabel>
                </Menu.Item>
              ) : null
            ) : null;
          // What this workspace is to you: its name, and whether it sits in your
          // sidebar. These lead the menu because they describe the session rather
          // than doing something with it. Pin used to lead here too and no longer
          // does: the sidebar row already offers it, and ⌘P still works from the
          // keyboard whether or not a menu spells it out.
          const placementActions = (
            <>
              {/* Rename. The title has always been double-clickable, which
						    nobody finds; this is the same inline editor, reachable. It
						    edits the workspace name when the header is titled by one,
						    exactly as the double-click does. */}
              {onRename && (
                <Menu.Item
                  onClick={() => setRenameDraft(workspaceName || session.title)}
                  title={
                    workspaceScopedMenu
                      ? "Rename this workspace"
                      : "Rename this session"
                  }
                >
                  <IconPencil size={20} className={MENU_ICON} />
                  <MenuLabel>
                    {workspaceScopedMenu
                      ? "Rename workspace"
                      : "Rename session"}
                  </MenuLabel>
                </Menu.Item>
              )}
            </>
          );
          // Fork: a new session carrying this one's history at the current tip,
          // so you can take the same context somewhere else without disturbing
          // this transcript. Forking from a specific message stays on that
          // message's own menu. Both land in the same composer mode.
          const forkAction = canForkSession && (
            <Menu.Item
              onClick={() => {
                setOverflowOpen(false);
                handleFork();
              }}
              title="Duplicate this session with its current context"
            >
              <IconCopy size={20} className={MENU_ICON} />
              <MenuLabel>Duplicate session</MenuLabel>
            </Menu.Item>
          );
          // Start something from this session. Renders nothing until the session
          // has an assistant turn to spin off.
          const spinOffAction = (
            <SpinOffMenu
              session={session}
              entries={entries}
              send={send}
              connected={connected}
              onOpenNewSession={navigation.openPrefilledSession}
            />
          );
          // Archive is the reversible primary "done with this" action — it sits
          // above Delete in the menu so the safe choice reads first. When the
          // session is already archived this becomes Unarchive.
          const archiveAction = (
            <Menu.Item
              onClick={handleArchive}
              disabled={archiving}
              title={
                session.archived
                  ? archiveShortcutLabel
                    ? `Unarchive session (${archiveShortcutLabel})`
                    : "Unarchive session"
                  : archiveShortcutLabel
                    ? `Archive session (${archiveShortcutLabel})`
                    : "Archive session"
              }
            >
              <IconArchive size={20} className={MENU_ICON} />
              <MenuLabel>
                {archiving
                  ? session.archived
                    ? "Unarchiving…"
                    : "Archiving…"
                  : session.archived
                    ? "Unarchive session"
                    : "Archive session"}
              </MenuLabel>
              {archiveShortcutLabel && (
                <Menu.Shortcut>{archiveShortcutLabel}</Menu.Shortcut>
              )}
            </Menu.Item>
          );
          // Delete is destructive, so it never rides in the visible action bar —
          // it always lives inside the ⋯ menu, one deliberate hop away.
          const deleteAction = (
            <Menu.Item
              // Red at rest, not only under the cursor. This is the one row in
              // the menu that cannot be undone, and a row that looks ordinary
              // until you are already on it announces that too late.
              tone="danger"
              onClick={() => setShowDeleteConfirm(true)}
              title="Delete session"
            >
              <IconTrash size={20} />
              <MenuLabel>Delete session</MenuLabel>
            </Menu.Item>
          );
          const workspaceLifecycleActions = workspaceScopedMenu && (
            <>
              {onArchiveWorkspace && (workspaceSessions?.length ?? 0) > 0 && (
                <Menu.Item onClick={onArchiveWorkspace}>
                  <IconArchive size={20} className={MENU_ICON} />
                  <MenuLabel>Archive workspace</MenuLabel>
                </Menu.Item>
              )}
              {onDeleteWorkspace && (
                <Menu.Item
                  tone="danger"
                  onClick={() =>
                    confirm({
                      title: `Delete workspace "${workspaceName || session.title}"?`,
                      description:
                        "All sessions in this workspace will be permanently deleted.",
                      confirmLabel: "Delete",
                      destructive: true,
                      onConfirm: () => void onDeleteWorkspace(),
                    })
                  }
                  title="Delete workspace"
                >
                  <IconTrash size={20} />
                  <MenuLabel>Delete workspace</MenuLabel>
                </Menu.Item>
              )}
            </>
          );
          // Secondary header controls (Linear/Plain links). Inline on desktop;
          // on phones they fold into the ⋯ menu so the single top bar holds only
          // ⋯ + the Workspace toggle beside the centered title. The code
          // affordances (Preview, Staging) sit as state-colored icons just left
          // of the panel toggle on desktop; PR status rides its own row.
          const secondaryActions = (inMenu: boolean) => (
            <>
              {/* The automation that produced this session rides in the title row
						    beside the workspace name on desktop — it names the session, it
						    isn't an action. .viewer-title is hidden on phones, so the ⋯
						    menu keeps carrying it there. */}
              {session.automation && inMenu && !workspaceScopedMenu && (
                <Menu.Item
                  render={
                    <a
                      href={`${BASE_PATH}/automations/${encodeURIComponent(session.automationId || session.automation)}`}
                    />
                  }
                  title={session.automation}
                >
                  <IconRobot size={20} className={MENU_ICON} />
                  <MenuLabel>Automation</MenuLabel>
                </Menu.Item>
              )}
              {session.linearIssue?.url &&
                (inMenu ? (
                  <Menu.Item
                    render={
                      <a
                        href={session.linearIssue.url}
                        target="_blank"
                        rel="noopener"
                      />
                    }
                  >
                    <MenuLabel>{session.linearIssue.identifier}</MenuLabel>
                  </Menu.Item>
                ) : (
                  <Button
                    size="md"
                    xstyle={styles.keepGap}
                    render={
                      <a
                        href={session.linearIssue.url}
                        target="_blank"
                        rel="noopener"
                      />
                    }
                  >
                    {session.linearIssue.identifier}
                  </Button>
                ))}
              {hasPlain &&
                plainUrl &&
                (inMenu ? (
                  <Menu.Item
                    render={
                      <a href={plainUrl} target="_blank" rel="noopener" />
                    }
                  >
                    <MenuLabel>Plain ↗</MenuLabel>
                  </Menu.Item>
                ) : (
                  <Button
                    size="md"
                    xstyle={styles.keepGap}
                    render={
                      <a href={plainUrl} target="_blank" rel="noopener" />
                    }
                  >
                    Plain ↗
                  </Button>
                ))}
              {feedRef &&
                (inMenu ? (
                  <Menu.Item
                    render={
                      <a href={feedRef.url} target="_blank" rel="noopener" />
                    }
                  >
                    <MenuLabel>{feedRefLabel} ↗</MenuLabel>
                  </Menu.Item>
                ) : (
                  <Button
                    size="md"
                    xstyle={styles.keepGap}
                    render={
                      <a href={feedRef.url} target="_blank" rel="noopener" />
                    }
                  >
                    {feedRefLabel} ↗
                  </Button>
                ))}
            </>
          );
          // The ⋯ menu. One instance, placed by width: on desktop it rides at the
          // end of the title cluster, where it reads as this workspace's own menu
          // and leaves the right end of the bar to status. On phones its trigger
          // moves into the centered action bar above the composer.
          //
          // The order runs: where this workspace sits for you, then what you can
          // start from it, then where else it lives, then how it ends. Archive
          // and Delete stay together at the bottom so the destructive end of the
          // menu is one place rather than two.
          const overflowMenu = (
            <Menu.Root open={overflowOpen} onOpenChange={setOverflowOpen}>
              <div className={VIEWER_OVERFLOW}>
                <Menu.Trigger
                  // Rendered AS the Button primitive rather than restyled to
                  // look like one, so the box, radius, hover wash, transition
                  // and press scale are identical to the share and side-panel
                  // buttons by construction instead of by hand-matching.
                  render={
                    menuInTab ? (
                      <button type="button" className={TAB_MENU_CONTROL}>
                        <IconDotsHorizontal size={20} aria-hidden="true" />
                      </button>
                    ) : infoPageOpen || isPhone ? (
                      <TopBarAction
                        floating
                        icon={<IconDotsHorizontal size={22} />}
                      />
                    ) : (
                      <Button
                        variant="ghost"
                        size="md"
                        icon={<IconDotsHorizontal size={22} />}
                      />
                    )
                  }
                  className={cn(
                    !menuInTab &&
                      !infoPageOpen &&
                      !isPhone &&
                      "rounded-control",
                    !menuInTab && overflowOpen && "bg-hover text-fg",
                  )}
                  title="More actions"
                  aria-label="More actions"
                />
                <Menu.Popup
                  // Desktop: opens rightward from a trigger that now sits at the
                  // left of the bar. Phones keep it flush with the right edge.
                  align={isPhone ? "end" : "start"}
                  // From the tab, the menu hangs below the tab's foot on
                  // the sheet rather than just under its ⋯.
                  sideOffset={menuInTab ? 8 : 6}
                  className="min-w-menu-wide"
                >
                  {/* Quick session actions use the same focus, spacing, collision,
								    and dismissal behavior as every other app menu. Each group is
								    conditional, so the rules between them collapse themselves
								    (ui/popup-styles separator) rather than being predicted here. */}
                  {placementActions}
                  {isPhone && keepInSidebarAction(true)}
                  {(compactHeader || isPhone) && shareAction(true)}
                  <CollaboratorsSubmenu
                    workspaceId={session.workspaceId || null}
                    sessionId={session.id}
                  />
                  <Menu.Separator />
                  {newSessionAction}
                  {/* Fork always applies to the open session, even when the
                  rest of this menu is scoped to its workspace. */}
                  {forkAction}
                  {!workspaceScopedMenu && spinOffAction}
                  {!workspaceScopedMenu && transcriptActions}
                  {portalsAction}
                  {session.source === "opensession" && !session.desk && (
                    <CoordinatorOverflowItems
                      session={session}
                      close={() => setOverflowOpen(false)}
                    />
                  )}
                  {moveToSandboxAction}
                  {branchAction && (
                    <>
                      <Menu.Separator />
                      {branchAction}
                    </>
                  )}
                  <Menu.Separator />
                  {isPhone && secondaryActions(true)}
                  {archivedActions}
                  <Menu.Separator />
                  {workspaceScopedMenu ? (
                    // The workspace-scoped menu swaps in workspace lifecycle
                    // actions, but an archived session still needs its way back:
                    // keep Unarchive reachable here.
                    <>
                      {session.archived && archiveAction}
                      {workspaceLifecycleActions}
                    </>
                  ) : (
                    <>
                      {archiveAction}
                      {deleteAction}
                    </>
                  )}
                </Menu.Popup>
              </div>
            </Menu.Root>
          );
          const header = (
            <SessionHeader
              session={session}
              hasWorkspace={hasWorkspace}
              workspaceName={workspaceName}
              parentSession={parentSession}
              workerSessions={workerSessions}
              models={models}
              openSession={openSession}
              archiving={archiving}
              onArchive={() => void handleArchive()}
              renameDraft={renameDraft}
              onRenameDraftChange={setRenameDraft}
              onCommitRename={commitRename}
              onCancelRename={() => setRenameDraft(null)}
              canRename={Boolean(onRename)}
              menu={
                menuInTab && tabMenuSlot
                  ? createPortal(overflowMenu, tabMenuSlot)
                  : overflowMenu
              }
              menuTrailing={
                !isPhone && showReview ? (
                  <div
                    ref={setReviewSessionActionTarget}
                    {...stylex.props(styles.contents)}
                  />
                ) : undefined
              }
              isPhone={isPhone}
              openNewSession={openNewSession}
              tabStripVisible={tabStripVisible}
              workspaceSessionCount={workspaceSessions?.length}
              workspaceSessions={workspaceSessions}
              newSiblingKeys={newSiblingKeys}
              headerRef={headerRef}
              headerActionsRef={headerActionsRef}
              topbarEl={topbarEl}
              headerActionsEl={headerActionsEl}
              actions={
                <>
                  {!isPhone && secondaryActions(false)}
                  {!isPhone && keepInSidebarAction(false)}
                  {/* Whoever ELSE has the session open, right before Share. Your
					    own face used to sit here too, which meant every session
					    you opened showed a face permanently — the one thing a
					    presence pile must never do, since it reads as somebody
					    standing behind you. You know you're here; this row is for
					    the people you can't see. (The native app has always
					    filtered its own name out — this matches it.) */}
                  {!session.desk && !isPhone && (
                    <HuddleButton target={huddleTarget(session)} />
                  )}
                  {!isPhone && others.length > 0 && (
                    <div
                      className={VIEWER_PRESENCE}
                      title={`Viewing: ${others.join(", ")}`}
                    >
                      {dedupeViewers(others).map((v, index, viewers) => (
                        <UserAvatar
                          key={v.name}
                          name={v.name}
                          size={24}
                          className={VIEWER_PRESENCE_AVATAR}
                          style={facepileAvatarStyle(
                            index,
                            viewers.length,
                            "var(--bg)",
                          )}
                        />
                      ))}
                    </div>
                  )}
                  {/* Share rides inline when there's room, else collapses into the ⋯
					    menu so it never crowds the title. It sits before Workspace so
					    the Workspace toggle stays rightmost. On phones the secondary
					    controls fold in too. */}
                  {!compactHeader && !isPhone && shareAction(false)}
                  {/* Phones keep this menu in the top bar's right slot, as the
					    native app does; Archive rides inside it. */}
                  {isPhone && !infoPageOpen && overflowMenu}
                  {/* Code-workspace testing affordances dock immediately left of the
					    side-panel toggle. The local preview launcher lives in the ⋯ menu;
					    the globe rides here only while nothing else is showing it. The
					    panel carries it in its PR row, the summary card as a row of its
					    own, so it is never in two places at once. */}
                  {/* Play starts the repository's declared Portal and opens it
					    in the Portal pane. Phones skip it to keep the header to the
					    title; Portals stays in the ⋯ menu there. */}
                  {!isPhone &&
                    !session.archived &&
                    openPortal &&
                    !infoPageOpen && (
                      <PortalLaunchButton
                        sessionId={session.id}
                        status={previewStatus}
                        launching={portalLaunch.launching}
                        onLaunchingChange={portalLaunch.setLaunching}
                        onStart={portalLaunch.start}
                        onOpen={openPortal}
                      />
                    )}
                  {!isPhone && !showReview && !panelOpen && !summaryVisible && (
                    <StagingLink
                      session={session}
                      variant="header"
                      refreshTick={gitRefreshTick}
                    />
                  )}
                  {/* Panel closed → surface the PR chip + its primary action (Merge/
					    Push/Resolve) inline, grouped with the globe directly left of
					    the side-panel toggle. Review owns that action in its own header,
					    so the global copy steps out while Review is open. So does the
					    summary card below, which says the same three things in rows with
					    room for the rest of them. */}
                  {!isPhone &&
                    hasRepoWork &&
                    !workspacePreparing &&
                    !panelOpen &&
                    !showReview &&
                    !summaryVisible && (
                      <PrStatusBar
                        sessionId={session.id}
                        repo={session.repo || undefined}
                        archived={session.archived}
                        prs={session.prs}
                        send={connected ? send : undefined}
                        onOpenPrTab={focusPrInReview}
                        onOpenChecksTab={() =>
                          focusPrInReview(undefined, "checks")
                        }
                        onArchive={handleArchive}
                        variant="header"
                        running={isRunningLive}
                        refreshTick={gitRefreshTick}
                      />
                    )}
                  {/* The compact Workspace summary keeps the card's quiet row grammar.
					    Detailed comments, files and tools open in the full side panel. */}
                  {/* The card steps down while the side panel is open and
					    returns when it closes; the button still opens it as an
					    overlay meanwhile. */}
                  {!isPhone && hasRepoWork && (
                    <WorkspaceSummary
                      session={session}
                      anchor={headerActionsRef}
                      // Changes opens beside the card. Review rows go to the full Review
                      // canvas now that the side panel contains tools only.
                      onOpenPanelTab={(tab) => {
                        if (tab === "changes") {
                          openActivePanel("changes");
                        } else {
                          openReview?.();
                        }
                      }}
                      onOpenPr={() => focusPrInReview()}
                      onOpenStackPr={openPr}
                      onOpenChecks={() => focusPrInReview(undefined, "checks")}
                      onOpenAsset={openAssetFromTranscript}
                      onOpenAssets={openAssets}
                      onOpenSession={openSession}
                      onArchive={handleArchive}
                      // Already resolved across the workspace's sessions (the
                      // request may live on a sibling), and already folded
                      // together with a GitHub review that completes it.
                      reviewRequest={effectiveReview?.req ?? null}
                      reviewRequestSessionId={effectiveReview?.ownerId}
                      onReviewChange={onReviewChange}
                      prReviewRequested={effectiveReview?.prReviewRequested}
                      browser={summaryBrowser}
                      running={isRunningLive}
                      workspacePreparing={workspacePreparing}
                      send={connected ? send : undefined}
                      refreshTick={gitRefreshTick}
                      onOpenChange={setSummaryOpen}
                      tabStripVisible={tabStripVisible}
                      bannerHeight={bannerHeight}
                      reviewMode={showReview}
                      forcePopover={showReview}
                      // Too narrow for both, and the card gets out of the way
                      // until someone asks for it from the same button.
                      hasRoom={summaryHasRoom}
                    />
                  )}
                  {/* Open, the panel's tab strip carries this toggle, so it
					    stays in the window's top-right corner instead of moving
					    to the main area's edge. */}
                  {!isPhone && panelAvailable && !activePanelOpen && (
                    <SidePanelToggle onClick={() => openActivePanel()} />
                  )}
                </>
              }
            />
          );
          const phoneInfoPage =
            isPhone && infoPageOpen
              ? createPortal(
                  <div
                    {...sx(styles.infoPage, "[&>*]:shrink-0")}
                    ref={infoPageRef}
                    role="dialog"
                    aria-modal="true"
                    aria-label={
                      panelPage === "changes"
                        ? "Changes"
                        : panelPage === "portals"
                          ? "Portals"
                          : "Workspace details"
                    }
                  >
                    {/* The phone's drill-in: this page is the workspace panel here,
								    so Changes navigates it rather than opening a column. The
								    workspace title moves into this bar as its large identity
								    header scrolls away, like chat info on a phone. */}
                    <TopBar
                      as="header"
                      className={infoTopbarClass(
                        infoPageScrolled || panelPage !== null,
                      )}
                    >
                      <TopBarBack
                        floating
                        className="relative z-1"
                        onClick={() =>
                          panelPage
                            ? setPanelPage(null)
                            : setInfoPageOpen(false)
                        }
                        aria-label={
                          panelPage
                            ? "Back to workspace details"
                            : "Back to session"
                        }
                        autoFocus
                      />
                      <TopBarTitle
                        className={infoTopbarTitleClass(
                          infoPageScrolled || panelPage !== null,
                        )}
                      >
                        {panelPage === "changes"
                          ? "Changes"
                          : panelPage === "portals"
                            ? "Portals"
                            : workspaceName || session.title}
                      </TopBarTitle>
                      {/* The same session menu moves with the person into Workspace
									    details instead of remaining behind the full-screen page. */}
                      <TopBarActions className="relative z-1">
                        {overflowMenu}
                      </TopBarActions>
                    </TopBar>
                    {panelPage === "changes" ? (
                      waitingForWorkspace ? (
                        <WorkspaceWaiting detail="This takes a moment." />
                      ) : (
                        // The Changes toolbar clears this page's taller bar
                        // (52px plus the notch); file titles add its own height.
                        <div {...stylex.props(styles.diffUnderInfoBar)}>
                          <DiffPanel
                            sessionId={session.id}
                            isRunning={isBusy}
                            canSend={connected && !isBusy && !noEngine}
                            send={send}
                            diff={diffState}
                            showFileList={false}
                            source={worktreeDiffSource}
                            onSourceChange={changeWorktreeDiffSource}
                            gitRefreshTick={gitRefreshTick}
                            onShareShipped={
                              openSlackComposer
                                ? () => {
                                    setInfoPageOpen(false);
                                    openSlackComposer();
                                  }
                                : undefined
                            }
                          />
                        </div>
                      )
                    ) : panelPage === "portals" ? (
                      <PortalsPage
                        sessionId={session.id}
                        status={previewStatus}
                        activePortal={portalTarget}
                        onBack={() => setPanelPage(null)}
                        hideHeader
                        onOpenPortal={(target) => {
                          setInfoPageOpen(false);
                          openPortal?.(target);
                        }}
                        onStartPortal={portalLaunch.start}
                        onPortalAction={async (name, action) => {
                          setPreviewStatus(
                            await portalActionApi(session.id, name, action),
                          );
                        }}
                      />
                    ) : (
                      <>
                        <div
                          {...sx(
                            styles.infoHero,
                            "[&_.repo-tile]:smooth-shadow-ring-sm",
                          )}
                        >
                          {session.desk ? (
                            <IconDesk size={40} {...stylex.props(styles.dim)} />
                          ) : (
                            <RepoTile
                              name={session.repo || "repository"}
                              size={40}
                            />
                          )}
                          <h1
                            {...stylex.props(styles.infoName)}
                            ref={infoHeroNameRef}
                          >
                            {workspaceName || session.title}
                          </h1>
                          <div {...stylex.props(styles.infoSub)}>
                            {!session.desk && hasRepoWork && (
                              <RepoBar
                                sessionId={session.id}
                                primaryRepo={session.repo || "repository"}
                                branch={session.branch}
                                initialAttached={session.attachedRepos || []}
                                variant="hero"
                              />
                            )}
                            {!session.desk &&
                              hasRepoWork &&
                              models.length > 0 && (
                                <span aria-hidden="true">·</span>
                              )}
                            {session.source === "opensession" &&
                            models.length > 0 ? (
                              <ModelMenuRow
                                models={models}
                                model={model}
                                defaultModel={defaultModel}
                                onChange={handleModelChange}
                                prettyLabel={prettyModel}
                                effort={effort}
                                onEffortChange={setEffort}
                                autoFallback={autoFallback}
                                onAutoFallbackChange={changeAutoFallback}
                                speed={speed}
                                onSpeedChange={setSpeed}
                                accounts={accounts}
                                accountId={accountId}
                                onAccountChange={handleAccountChange}
                                usage={usage}
                                variant="hero"
                              />
                            ) : models.length > 0 ? (
                              <span {...stylex.props(styles.heroModel)}>
                                {metadataModelLabel(effectiveModel, models)}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div {...stylex.props(styles.infoContent)}>
                          <ThreadsDetailsSection
                            session={session}
                            onOpenSession={openSession}
                            onOpenAsset={openAssetFromTranscript}
                            onLeave={() => setInfoPageOpen(false)}
                          />
                          <div {...stylex.props(styles.infoSummaryCard)}>
                            {session.sandbox && (
                              <div {...stylex.props(styles.sandboxCard)}>
                                <SandboxBadge
                                  sessionId={session.id}
                                  sandbox={session.sandbox}
                                />
                              </div>
                            )}
                            <WorkspaceSummaryBody
                              embedded
                              session={session}
                              onOpenPanelTab={(tab) => {
                                if (tab === "changes") {
                                  setPanelPage("changes");
                                  return;
                                }
                                setInfoPageOpen(false);
                                focusPrInReview();
                              }}
                              onOpenPr={() => {
                                setInfoPageOpen(false);
                                focusPrInReview();
                              }}
                              onOpenStackPr={(repo, branch) => {
                                setInfoPageOpen(false);
                                openPr?.(repo, branch);
                              }}
                              onOpenChecks={() => {
                                setInfoPageOpen(false);
                                focusPrInReview(undefined, "checks");
                              }}
                              onOpenAsset={openAssetFromTranscript}
                              onOpenAssets={() => {
                                setInfoPageOpen(false);
                                openAssets?.();
                              }}
                              onOpenSession={openSession}
                              onArchive={handleArchive}
                              reviewRequest={effectiveReview?.req ?? null}
                              reviewRequestSessionId={effectiveReview?.ownerId}
                              onReviewChange={onReviewChange}
                              prReviewRequested={
                                effectiveReview?.prReviewRequested
                              }
                              running={isRunningLive}
                              workspacePreparing={workspacePreparing}
                              send={connected ? send : undefined}
                              refreshTick={gitRefreshTick}
                              liveMedia={liveOverviewMedia}
                              close={() => setInfoPageOpen(false)}
                            />
                          </div>
                          {(workflowRuns.length > 0 ||
                            subagents.length > 0) && (
                            <div {...stylex.props(styles.infoSection)}>
                              <WorkflowPanel
                                sessionId={session.id}
                                runs={workflowRuns}
                                onAction={workflowAction}
                                subagents={subagents}
                                onOpenSubagent={(agentId, label) => {
                                  setInfoPageOpen(false);
                                  openSubagent(agentId, label);
                                }}
                                onOpenSession={
                                  openSession
                                    ? (id) => {
                                        setInfoPageOpen(false);
                                        openSession(id);
                                      }
                                    : undefined
                                }
                              />
                            </div>
                          )}
                          {sessionArtifacts.reports.length > 0 && (
                            <div {...stylex.props(styles.infoSection)}>
                              <SessionReportsPanel
                                reports={sessionArtifacts.reports}
                                onOpenNewSession={
                                  navigation.openPrefilledSession
                                }
                              />
                            </div>
                          )}
                          {sessionArtifacts.databases.length > 0 && (
                            <div {...stylex.props(styles.infoSection)}>
                              <SessionDatabasesPanel
                                databases={sessionArtifacts.databases}
                                onOpen={(id) => {
                                  setInfoPageOpen(false);
                                  navigation.openDatabases(id);
                                }}
                              />
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>,
                  document.body,
                )
              : null;
          return (
            <>
              {header}
              {phoneInfoPage}
            </>
          );
        })()}
      {/* Repo tile leads the mobile title pill (Slack-header style), except
			    when an archive mark replaces it for an archived session. A Desk
			    has no repo, and every Desk is titled just "Desk": opening a
			    teammate's from the People band gave a pill with nothing in front
			    of the name — no way to tell whose it is, and the name sitting
			    against the pill's edge where the tile's spacing should be. Their
			    face answers both; your own Desk gets the lamp instead of a
			    picture of yourself. */}
      {isPhone &&
        headerRepoEl &&
        (session.archived || session.desk || session.repo || hasWorkspace) &&
        createPortal(
          session.archived ? (
            <span role="img" aria-label="Archived" title="Archived">
              <IconArchive size={20} {...stylex.props(styles.dim)} />
            </span>
          ) : session.desk ? (
            deskOwner && personKey(deskOwner) !== personKey(currentUser) ? (
              <UserAvatar
                name={deskOwner}
                size={18}
                title={`${deskOwner}'s Desk`}
              />
            ) : (
              // 20, not the tile's 18: these 24-grid glyphs are clamped
              // at 20 (MIN_SIZE in icons.tsx) and only ink ~60% of
              // their box, so the lamp still reads smaller than a face.
              <IconDesk size={20} {...stylex.props(styles.dim)} />
            )
          ) : (
            <RepoTile name={session.repo || "repository"} size={18} round />
          ),
          headerRepoEl,
        )}
      {/* Compact "session bar" under the mobile top-bar title: it just *shows*
			    the session's model (no per-item dropdowns) — tapping it (or the
			    title above) opens the settings menu where they, and every other
			    workspace/session setting, can be changed. */}
      {isPhone &&
        headerModelEl &&
        (hasWorkspace || effectiveModel || models.length > 0) &&
        createPortal(
          <span
            className={`${HEADER_SESSIONBAR} session-settings-trigger`}
            role="button"
            tabIndex={0}
            title="Workspace & session settings"
            onClick={() =>
              // The metadata line is a React portal, so its clicks bubble
              // through this component's tree — not App's title button. Fire
              // the same event so tapping repo/model/cost opens the info page.
              window.dispatchEvent(
                new Event("opensession:toggle-session-settings"),
              )
            }
          >
            {/* The engine-running status dot rides the metadata line on
						    phones (it used to sit next to the title) so the name stays
						    steady and the working state reads alongside model · cost. */}
            {isRunningLive && <PulseDot size={7} />}
            {/* Repo now leads the pill (portaled into headerRepoEl in front of
						    the title), so the metadata line is just model · cost. The id
						    has its own friendly fallback, so the optimistic shell can name
						    it before this view's catalog fetch finishes. */}
            {effectiveModel && (
              <span className={HEADER_SESSIONBAR_MODEL}>
                {/* Drop the "Claude " prefix — "Opus 4.8" reads fine in the
								    thin subtitle and leaves room for the cost meter. */}
                {metadataModelLabel(effectiveModel, models).replace(
                  /^Claude[\s-]+/i,
                  "",
                )}
              </span>
            )}
            {/* Cost/context stays in the phone session bar, after the model and
						    restyled to the subtitle's size and colour. The cache rate stays
						    off: the line
						    is a pill capped by the screen, and "92% cached" was winning
						    that fight against the model name — the thing you actually
						    read to know what you are talking to. The full breakdown is
						    one tap away in the meter's own popup. */}
            {usage && usage.turns > 0 && (
              <>
                <span className={HEADER_SESSIONBAR_SEP} aria-hidden="true">
                  ·
                </span>
                <UsageMeter usage={usage} className={HEADER_SESSIONBAR_USAGE} />
              </>
            )}
          </span>,
          headerModelEl,
        )}{" "}
      <SessionBanners
        session={session}
        onHeightChange={setBannerHeight}
        onStopLoop={
          connected
            ? () =>
                send({
                  type: "prompt",
                  sessionId: session.id,
                  user: getCurrentUser(),
                  content: "/loop stop",
                })
            : undefined
        }
      />
    </>
  );
}
