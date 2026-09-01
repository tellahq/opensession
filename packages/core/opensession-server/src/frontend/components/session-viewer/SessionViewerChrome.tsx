import type React from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { createPortal } from "react-dom";
import { BASE_PATH } from "../../lib/base";
import type {
  ExternalRef,
  GitStatusInfo,
  ReportMeta,
  SessionPrRef,
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
import { ArchivedSessionItems } from "../ArchivedSessionItems";
import { ModelMenuRow } from "../ModelMenuRow";
import { PortalsPage } from "../PortalsPanel";
import { PrStatusBar } from "../PrStatusBar";
import { RepoBar } from "../RepoBar";
import { RepoTile } from "../RepoTile";
import { SandboxBadge } from "../SandboxBadge";
import { SessionReportsPanel } from "../SessionReportsPanel";
import { SpinOffMenu } from "../SpinOffMenu";
import { StagingLink } from "../StagingLink";
import { UsageMeter } from "../UsageMeter";
import { UserAvatar } from "../UserAvatar";
import { WorkflowPanel } from "../WorkflowPanel";
import { WorkspaceSummary, WorkspaceSummaryBody } from "../WorkspaceSummary";
import { WorkspaceWaiting } from "./busy-indicators";
import {
  IconArchive,
  IconChevronRight,
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
  IconSidebarRight,
  IconTrash,
} from "../icons";
import { KeepInSidebarIcon } from "../sidebar/KeepInSidebarMark";
import { Button } from "../../ui/button";
import type { ConfirmRequest } from "../../ui/confirm";
import { CopyCheck } from "../../ui/copy";
import { Menu, MENU_ICON } from "../../ui/menu";
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
import { toast } from "../../ui/toast";
import { copySessionTranscript } from "../../lib/transcript-copy";
import { dedupeViewers, facepileAvatarStyle } from "../../lib/presence";
import { personKey } from "../../lib/review-queue";
import { metadataModelLabel } from "./model-labels";
import { prPhoneChipClass } from "../../lib/pr-tone-classes";
import { refChipText, refLabel, refTone } from "../../lib/pr-refs";
import {
  HEADER_SESSIONBAR,
  HEADER_SESSIONBAR_MODEL,
  HEADER_SESSIONBAR_SEP,
  HEADER_SESSIONBAR_USAGE,
} from "../../lib/app-header-classes";
import {
  INFO_CONTENT,
  INFO_HERO,
  INFO_NAME,
  INFO_PAGE,
  INFO_SECTION,
  INFO_SUB,
  INFO_SUMMARY_CARD,
  SESSION_LINK,
  SESSION_LINK_LINEAR,
  SESSION_LINK_PLAIN,
  VIEWER_MENU_SEP,
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
  tabStripVisible: boolean | undefined;
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
  mobileActionMenuEl: HTMLDivElement | null;
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
  commitRename: () => void;
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
  setActivePanelOpen: (open: boolean) => void;
  setDesktopPanelPage: (page: SidePanelPage) => void;
  setSummaryOpen: Dispatch<SetStateAction<boolean>>;
  gitRefreshTick: number;
  showReview: boolean;
}
interface ChromeModel {
  models: ModelOption[];
  model: string;
  defaultModel: string;
  effectiveModel: string;
  handleModelChange: (next: string) => void;
  prettyModel: (id: string) => string;
  effort: string;
  setEffort: Dispatch<SetStateAction<string>>;
  fastMode: boolean;
  setFastMode: Dispatch<SetStateAction<boolean>>;
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
interface ChromeInfoActions {
  setPreviewStatus: Dispatch<SetStateAction<PreviewStatus | null>>;
  portalTarget: PortalTarget | null;
  openPortal: ((target: PortalTarget) => void) | undefined;
  startDeclaredPortal: (recipe: PreviewPortalRecipe) => Promise<void>;
  workflowRuns: WorkflowRunSnapshot[];
  workflowAction: (
    runId: string,
    action: "cancel" | "pause" | "resume" | "skip" | "retry",
    seq?: number,
  ) => void;
  subagents: SessionSubagentSnapshot[];
  openSubagent: (agentId: string, label: string) => void | undefined;
  sessionReports: ReportMeta[];
  navigation: NavigationActions;
  effectiveReview: ChromeEffectiveReview;
  onReviewChange:
    | ((
        id: string,
        request: NonNullable<UnifiedSession["reviewRequest"]> | null,
      ) => void)
    | undefined;
  liveOverviewMedia: WorkspaceMediaItem[];
  phonePr: SessionPrRef | undefined;
  setReviewSessionActionTarget: Dispatch<SetStateAction<HTMLDivElement | null>>;
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
}

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
    mobileActionMenuEl,
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
    setActivePanelOpen,
    setDesktopPanelPage,
    setSummaryOpen,
    gitRefreshTick,
    showReview,
  } = workspaceActions;
  const {
    models,
    model,
    defaultModel,
    effectiveModel,
    handleModelChange,
    prettyModel,
    effort,
    setEffort,
    fastMode,
    setFastMode,
    accounts,
    accountId,
    handleAccountChange,
    usage,
    isRunningLive,
  } = modelState;
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
  const {
    setPreviewStatus,
    portalTarget,
    openPortal,
    startDeclaredPortal,
    workflowRuns,
    workflowAction,
    subagents,
    openSubagent,
    sessionReports,
    navigation,
    effectiveReview,
    onReviewChange,
    liveOverviewMedia,
    phonePr,
    setReviewSessionActionTarget,
  } = infoActions;
  const { others, entries } = conversation;
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
                <span className="grow">Add to sidebar</span>
              </Menu.Item>
            ) : (
              <Button
                size="md"
                variant="default"
                className="mr-1.5 text-fg"
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
                <span className="grow">
                  {copied
                    ? "Copied"
                    : workspaceScopedMenu
                      ? "Share workspace"
                      : "Share"}
                </span>
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
              <span className="grow">New session in workspace</span>
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
                  <span className="grow">Archived sessions</span>
                  <IconChevronRight size={16} className="text-faint" />
                </Menu.SubmenuTrigger>
                <Menu.Popup className="min-w-[240px] max-w-[320px]">
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
                <span className="grow">Copy transcript</span>
                <IconChevronRight size={16} className="text-faint" />
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
                  <span className="grow">Concise</span>
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
                  <span className="grow">Full</span>
                </Menu.Item>
              </Menu.Popup>
            </Menu.SubmenuRoot>
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
                  setDesktopPanelPage("portals");
                  setActivePanelOpen(true);
                }
              }}
            >
              <IconGlobe size={20} className={MENU_ICON} />
              <span className="grow">Portals</span>
              {livePortals > 0 && (
                <span className="shrink-0 tabular-nums text-faint">
                  {livePortals} live
                </span>
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
                    <span className="grow">
                      {branchActionBusy === "move"
                        ? "Moving…"
                        : "Move to branch"}
                    </span>
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
                    <span className="grow">Create PR</span>
                  </Menu.Item>
                </>
              ) : menuGit.branch ? (
                <Menu.Item
                  disabled={!connected}
                  onClick={createPrFromMenu}
                  title="Ask this session to create a pull request"
                >
                  <IconPullRequest size={20} className={MENU_ICON} />
                  <span className="grow">Create PR</span>
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
                  <span className="grow">
                    {workspaceScopedMenu
                      ? "Rename workspace"
                      : "Rename session"}
                  </span>
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
              <span className="grow">Duplicate session</span>
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
              <span className="grow">
                {archiving
                  ? session.archived
                    ? "Unarchiving…"
                    : "Archiving…"
                  : session.archived
                    ? "Unarchive session"
                    : "Archive session"}
              </span>
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
              className="text-red data-[highlighted]:bg-red-soft data-[highlighted]:text-red"
              onClick={() => setShowDeleteConfirm(true)}
              title="Delete session"
            >
              <IconTrash size={20} />
              <span className="grow">Delete session</span>
            </Menu.Item>
          );
          const workspaceLifecycleActions = workspaceScopedMenu && (
            <>
              {onArchiveWorkspace && (workspaceSessions?.length ?? 0) > 0 && (
                <Menu.Item onClick={onArchiveWorkspace}>
                  <IconArchive size={20} className={MENU_ICON} />
                  <span className="grow">Archive workspace</span>
                </Menu.Item>
              )}
              {onDeleteWorkspace && (
                <Menu.Item
                  className="text-red data-[highlighted]:bg-red-soft data-[highlighted]:text-red"
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
                  <span className="grow">Delete workspace</span>
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
                  <span className="grow">Automation</span>
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
                    <span className="grow">
                      {session.linearIssue.identifier}
                    </span>
                  </Menu.Item>
                ) : (
                  <a
                    href={session.linearIssue.url}
                    target="_blank"
                    rel="noopener"
                    className={cn(SESSION_LINK, SESSION_LINK_LINEAR)}
                  >
                    {session.linearIssue.identifier}
                  </a>
                ))}
              {hasPlain &&
                plainUrl &&
                (inMenu ? (
                  <Menu.Item
                    render={
                      <a href={plainUrl} target="_blank" rel="noopener" />
                    }
                  >
                    <span className="grow">Plain ↗</span>
                  </Menu.Item>
                ) : (
                  <a
                    href={plainUrl}
                    target="_blank"
                    rel="noopener"
                    className={cn(SESSION_LINK, SESSION_LINK_PLAIN)}
                  >
                    Plain ↗
                  </a>
                ))}
              {feedRef &&
                (inMenu ? (
                  <Menu.Item
                    render={
                      <a href={feedRef.url} target="_blank" rel="noopener" />
                    }
                  >
                    <span className="grow">{feedRefLabel} ↗</span>
                  </Menu.Item>
                ) : (
                  <a
                    href={feedRef.url}
                    target="_blank"
                    rel="noopener"
                    className={cn(SESSION_LINK, SESSION_LINK_PLAIN)}
                  >
                    {feedRefLabel} ↗
                  </a>
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
                    infoPageOpen ? (
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
                    !infoPageOpen && "[corner-shape:squircle]",
                    !infoPageOpen &&
                      isPhone &&
                      "size-11 min-h-11 rounded-control border-transparent text-dim shadow-none [corner-shape:squircle]",
                    overflowOpen && "bg-hover text-fg",
                  )}
                  title="More actions"
                  aria-label="More actions"
                />
                <Menu.Popup
                  // Desktop: opens rightward from a trigger that now sits at the
                  // left of the bar. Phones keep it flush with the right edge.
                  align={isPhone ? "end" : "start"}
                  sideOffset={6}
                  className="min-w-[240px] max-w-[min(300px,calc(100vw-24px))]"
                >
                  {/* Quick session actions use the same focus, spacing, collision,
								    and dismissal behavior as every other app menu. Each group is
								    conditional, so the rules between them collapse themselves
								    rather than being predicted here (VIEWER_MENU_SEP). */}
                  {placementActions}
                  {isPhone && keepInSidebarAction(true)}
                  {(compactHeader || isPhone) && shareAction(true)}
                  <Menu.Separator className={VIEWER_MENU_SEP} />
                  {newSessionAction}
                  {/* Fork always applies to the open session, even when the
                  rest of this menu is scoped to its workspace. */}
                  {forkAction}
                  {!workspaceScopedMenu && spinOffAction}
                  {!workspaceScopedMenu && transcriptActions}
                  {portalsAction}
                  {branchAction && (
                    <>
                      <Menu.Separator className={VIEWER_MENU_SEP} />
                      {branchAction}
                    </>
                  )}
                  <Menu.Separator className={VIEWER_MENU_SEP} />
                  {isPhone && secondaryActions(true)}
                  {archivedActions}
                  <Menu.Separator className={VIEWER_MENU_SEP} />
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
                      {(!isPhone || session.archived) && archiveAction}
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
              menu={overflowMenu}
              menuTrailing={
                !isPhone && showReview ? (
                  <div
                    ref={setReviewSessionActionTarget}
                    className="contents"
                  />
                ) : undefined
              }
              isPhone={isPhone}
              openNewSession={openNewSession}
              tabStripVisible={tabStripVisible}
              workspaceSessionCount={workspaceSessions?.length}
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
                  {/* Phones portal this menu into the action bar above the composer. */}
                  {isPhone &&
                    !infoPageOpen &&
                    mobileActionMenuEl &&
                    createPortal(overflowMenu, mobileActionMenuEl)}
                  {/* Code-workspace testing affordances dock immediately left of the
					    side-panel toggle. The local preview launcher lives in the ⋯ menu;
					    the globe rides here only while nothing else is showing it. The
					    panel carries it in its PR row, the summary card as a row of its
					    own, so it is never in two places at once. */}
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
                  {!isPhone && hasRepoWork && !activePanelOpen && (
                    <WorkspaceSummary
                      session={session}
                      anchor={headerActionsRef}
                      // Changes opens beside the card. Review rows go to the full Review
                      // canvas now that the side panel contains tools only.
                      onOpenPanelTab={(tab) => {
                        if (tab === "changes") {
                          setDesktopPanelPage("changes");
                          setActivePanelOpen(true);
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
                      running={isRunningLive}
                      workspacePreparing={workspacePreparing}
                      send={connected ? send : undefined}
                      refreshTick={gitRefreshTick}
                      onOpenChange={setSummaryOpen}
                      tabStripVisible={tabStripVisible}
                      reviewMode={showReview}
                      // Too narrow for both, and the card gets out of the way
                      // until someone asks for it from the same button.
                      hasRoom={summaryHasRoom}
                    />
                  )}
                  {/* Phones have no workspace panel and no status strip, so the PR
					    state had nowhere to show: you had to open the info page to
					    learn whether checks were red. One toned chip in the bar's
					    right slot says the number and the state in its colour, and
					    tapping it opens Review on that PR. Only when the session
					    actually has one: a chip that says "no PR" is chrome. */}
                  {isPhone && phonePr && (
                    <button
                      type="button"
                      className={prPhoneChipClass(refTone(phonePr))}
                      title={refLabel(phonePr)}
                      aria-label={refLabel(phonePr)}
                      onClick={() =>
                        focusPrInReview({
                          repo: phonePr.repo,
                          branch: phonePr.branch,
                        })
                      }
                    >
                      {refChipText(phonePr, session.repo || undefined)}
                    </button>
                  )}
                  {!isPhone && panelAvailable && (
                    <Tooltip label="Toggle workspace panel">
                      <Button
                        variant="ghost"
                        size="md"
                        // No height/width overrides: the primitive's icon-only box is
                        // already the 32px square the ⋯ and share buttons use.
                        // text-dim, not text-faint: the share and ⋯ buttons beside it
                        // are dim, and a lighter ink made this read as disabled.
                        // No negative margin after the ⋯ either: that -4px pull dated
                        // from when both were narrow padded controls, and now that all
                        // three are equal squares it just made this gap 4px where the
                        // share → ⋯ one is the row's 8px.
                        className="rounded-control text-dim hover:bg-hover hover:text-fg phone:order-2 phone:h-[38px] phone:min-h-[38px] phone:w-[38px] phone:bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] phone:text-accent"
                        onClick={() => setActivePanelOpen(!activePanelOpen)}
                        aria-label="Toggle side panel"
                        // Iconic sidebar-right glyph — reads as "right side panel".
                        // Passed as `icon` (not children) so the primitive uses its
                        // icon-only square; as a child it counts as a label and gets
                        // the text button's px-3, which made it 50px wide.
                        icon={<IconSidebarRight size={22} />}
                      />
                    </Tooltip>
                  )}
                </>
              }
            />
          );
          const phoneInfoPage =
            isPhone && infoPageOpen
              ? createPortal(
                  <div
                    className={INFO_PAGE}
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
                        className="relative z-[1]"
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
                      <TopBarActions className="relative z-[1]">
                        {overflowMenu}
                      </TopBarActions>
                    </TopBar>
                    {panelPage === "changes" ? (
                      waitingForWorkspace ? (
                        <WorkspaceWaiting detail="This takes a moment." />
                      ) : (
                        // The Changes toolbar clears this page's taller bar
                        // (52px plus the notch); file titles add its own height.
                        <div className="[--diff-panel-top:calc(env(safe-area-inset-top,0px)+52px)]">
                          <DiffPanel
                            sessionId={session.id}
                            isRunning={isBusy}
                            canSend={connected && !isBusy && !noEngine}
                            send={send}
                            diff={diffState}
                            showFileList={false}
                            source={worktreeDiffSource}
                            onSourceChange={changeWorktreeDiffSource}
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
                        onStartPortal={startDeclaredPortal}
                        onPortalAction={async (name, action) => {
                          setPreviewStatus(
                            await portalActionApi(session.id, name, action),
                          );
                        }}
                      />
                    ) : (
                      <>
                        <div className={INFO_HERO}>
                          {session.desk ? (
                            <IconDesk size={40} className="text-dim" />
                          ) : (
                            <RepoTile
                              name={session.repo || "repository"}
                              size={40}
                            />
                          )}
                          <h1 className={INFO_NAME} ref={infoHeroNameRef}>
                            {workspaceName || session.title}
                          </h1>
                          <div className={INFO_SUB}>
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
                                fastMode={fastMode}
                                onFastModeChange={setFastMode}
                                accounts={accounts}
                                accountId={accountId}
                                onAccountChange={handleAccountChange}
                                usage={usage}
                                variant="hero"
                              />
                            ) : models.length > 0 ? (
                              <span className="inline-flex min-h-11 items-center px-1.5">
                                {metadataModelLabel(effectiveModel, models)}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className={INFO_CONTENT}>
                          <div className={INFO_SUMMARY_CARD}>
                            {session.sandbox && (
                              <div className="flex min-h-11 items-center rounded-2xl bg-panel px-5 py-2">
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
                            <div className={INFO_SECTION}>
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
                          {sessionReports.length > 0 && (
                            <div className={INFO_SECTION}>
                              <SessionReportsPanel
                                reports={sessionReports}
                                onOpenNewSession={
                                  navigation.openPrefilledSession
                                }
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
              <IconArchive size={20} className="text-dim" />
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
              <IconDesk size={20} className="text-dim" />
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
    </>
  );
}
