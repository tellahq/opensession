import { BASE_PATH } from "../lib/base";
import React, {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { duration, ease } from "../ui/motion";
import { EmptyState, InlineAlert, TranscriptSkeleton } from "../ui/state";
import { LiveTurnStore } from "../lib/live-turn-store";
import { TranscriptViewStore } from "../lib/transcript-view-store";
import {
  measureSessionPerf,
  recordSessionPerf,
  scheduleTranscriptDomNodeSample,
} from "../lib/session-performance";
import { AGENT_NAME, DEFAULT_DOC_TITLE } from "../lib/brand";
import { withQuotes, type Quote } from "../lib/quotes";
import { markNotesRead } from "../lib/note-reads";
import { clearMention, onMentionsChanged } from "../lib/mentions";
import { QuoteSelection } from "./QuoteSelection";
import { plainThreadUrl } from "./PlainThreadPanel";
import type {
  UnifiedSession,
  SessionNote,
  SessionSlackShare,
  TranscriptEntry,
} from "../lib/types";
import {
  mergeTranscriptEntries,
  orderTranscriptEntries,
} from "../lib/transcript-state";
import { HISTORY_PAGE_ENTRIES } from "../lib/transcript-history";
import { MessageRail } from "./MessageRail";
import { collectSentMessages } from "../lib/sent-messages";
import { canonicalToolName, type LiveSubagent } from "./ToolCallBlock";
import {
  parsePlanItems,
  type PlanItem,
} from "@tellahq/opensession-protocol/todo-plan";
import { ReplySuggestions } from "./ReplySuggestions";
import { SessionSafetyNotice } from "./SessionSafetyNotice";
import {
  getReplySuggestionsPref,
  onReplySuggestionsChanged,
  type ReplySuggestion,
} from "../lib/reply-suggestions";
import {
  getNextChatButtonPref,
  onNextChatButtonChanged,
} from "../lib/next-chat-pref";
import { SubagentPane } from "./SubagentPane";
import { ShellPanel } from "./TerminalPanel";
import { getCurrentUser } from "./UserPicker";
import { UserAvatar } from "./UserAvatar";
import {
  fetchFileMentions,
  fetchMentionSuggestions,
  fetchSkillMentions,
  fetchSessionNotesApi,
  postSessionNoteApi,
  portalActionApi,
  type WorkspaceMediaItem,
} from "../lib/api";
import { sessionPrPresentation } from "../lib/session-prs";
import { refChipText, refLabel, refTone, worstPrRef } from "../lib/pr-refs";
import { prPhoneChipClass } from "../lib/pr-tone-classes";
import type { PrFocus } from "../lib/pr-focus";
import { reviewLoopResult } from "../lib/review-loop";
import { CONTINUE_AFTER_FAILURE_PROMPT } from "../lib/continue-run";
import { repairPausedSession } from "../lib/api/session-safety";
import { safetyContinuationPrompt } from "../lib/session-safety";
import { fetchSlackChannels } from "../lib/api/shipped-changes";
import { suggestedShippedChangeMessage } from "../lib/shipped-change-copy";
import { dismissSlackShare } from "../lib/slack-share-dismiss";
import { latestFeaturedScreenshot } from "../../shared/shipped-change-media";
import { useBackSwipe } from "../hooks/useBackSwipe";
import { useNavigation } from "../hooks/useNavigation";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { useSessionRuntime } from "../hooks/useSessionRuntime";
import {
  useComposerQueueState,
  useComposerReset,
  useImageRegionComposer,
  usePendingPromptReconciliation,
  useSessionAttachmentDrop,
  useSessionComposerDraft,
  useSessionPromptOutbox,
} from "../hooks/useSessionComposerController";
import {
  useSessionArchiveShortcut,
  useSessionHeaderLayout,
  useSessionOverflowState,
  useShippedShareState,
} from "../hooks/useSessionViewerActionsController";
import {
  archiveSessionAction,
  cancelComposedSlackMessageAction,
  deleteSessionAction,
  moveAndCreatePrAction,
  moveSessionToBranchAction,
  openSlackComposerAction,
  reconnectShippedSlackAction,
  sendComposedSlackMessageAction,
  shareSessionAction,
  shareShippedChangeAction,
  undoComposedSlackMessageAction,
  undoShippedChangeAction,
} from "../lib/session-viewer-actions";
import { useSessionViewerSubscription } from "../hooks/useSessionViewerSubscription";
import {
  useTranscriptReaderLayout,
  useTranscriptReaderLifecycle,
} from "../hooks/useTranscriptReaderController";
import { useSessionModelWorkflowController } from "../hooks/useSessionModelWorkflowController";
import {
  useSessionPreviewStatusEffect,
  useSessionRuntimeController,
} from "../hooks/useSessionRuntimeController";
import {
  beginTranscriptHistoryLoad,
  captureTranscriptVisibility,
  handleTranscriptHistoryScroll,
  listenForResumeCancellation,
  listenForTranscriptVisibility,
  loadAllTranscriptHistory,
  loadEarlierTranscriptHistory,
  resetTranscriptHistoryWalk,
  resetTranscriptVisibility,
  resumeTranscriptForEntryGrowth,
  startTranscriptHistoryHold,
  stopTranscriptHistoryHold,
  subscribeToTranscriptStreamGrowth,
  useTranscriptHistoryController,
} from "../hooks/useTranscriptHistoryController";
import {
  dedupeViewers,
  facepileAvatarStyle,
  otherViewers,
} from "../lib/presence";
import { personKey, prReviewCompletion } from "../lib/review-queue";
import { Composer } from "./Composer";
import { TypingIndicator } from "./TypingIndicator";
import { ComposerAgents } from "./ComposerAgents";
import { UsageMeter } from "./UsageMeter";
import { SchedulePromptButton } from "./SchedulePrompt";
import {
  ShippedChangeComposer,
  SlackSentNotice,
  type SlackSent,
} from "./ShippedChangeComposer";
import { BrandMark } from "./BrandMark";
import { SessionHeader } from "./session/SessionHeader";
import { SidePanelHost } from "./session/SidePanelHost";
import { SessionPreviewSurface } from "./session/SessionPreviewSurface";
import { TranscriptView } from "./session/TranscriptView";
import { splitAttachments, type FileAttachment } from "../lib/images";
import { cropImageRegionFile } from "../lib/image-region-comment";
import {
  registerImageRegionCommentHandler,
  type ImageRegionCommentRequest,
} from "../lib/image-region-comment-registry";
import { loadDraft, saveDraft, clearDraft } from "../lib/drafts";
import {
  attachToDraft,
  dropStagingAttachments,
  sameFiles,
  sameImages,
} from "../lib/attachments";
import { useAttachmentUploads } from "../hooks/useAttachmentUploads";
import { foregroundFileComposerOpen, hasDraggedFiles } from "../lib/file-drag";
import { unhideForSession } from "../lib/hides";
import {
  markPendingBusy,
  markPendingStarted,
  reconcilePending,
  type OptimisticPendingPrompt,
} from "../lib/pending-reconcile";
import { promptOutbox, type PromptOutboxItem } from "../lib/prompt-outbox";
import { DiffPanel, useSessionDiff } from "./DiffPanel";
import { RepoBar } from "./RepoBar";
import { RepoTile } from "./RepoTile";
import { SandboxBadge } from "./SandboxBadge";
import { ModelMenuRow } from "./ModelMenuRow";
import {
  EFFORTS,
  baseModelId,
  friendlyModelSlug,
  routedModelParts,
  workspacePresetLabel,
} from "./ModelEffortSelect";

import {
  metadataModelLabel,
  modelIsCodex,
  prettyModel,
} from "./session-viewer/model-labels";
import { withModelSwitches } from "./session-viewer/model-switches";
import {
  cacheTranscriptView,
  cachedTranscriptView,
  peekCachedTranscriptView,
} from "./session-viewer/transcript-cache";
import {
  pickScrollAnchor,
  readFollowingLive,
} from "./session-viewer/transcript-anchor";
import { historyPageRequest } from "../lib/transcript-history-controller";
import { useLivePlan } from "./session-viewer/use-live-plan";
import {
  useTranscript,
  useTranscriptIndexAnchor,
} from "../hooks/useTranscript";
import {
  BusyInline,
  ConversationLoading,
  WorkspaceSetup,
  WorkspaceWaiting,
} from "./session-viewer/busy-indicators";
import { AskCard } from "./AskCard";
import { PrPanel, type PrReviewPage } from "./PrPanel";
import { PrStatusBar } from "./PrStatusBar";

import { ConversationPane } from "./ConversationPane";
import { FeedWebPane } from "./FeedWebPane";
import { SlackChannelPane } from "./SlackChannelPane";
import { feedForRefKind } from "../lib/feeds-meta";
import { WorkflowPanel } from "./WorkflowPanel";
import { AssetsPanel, useSessionAssets } from "./AssetsPanel";
import { AssetOverlay } from "./AssetView";
import { SessionReportsPanel, useSessionReports } from "./SessionReportsPanel";
import type { WorkflowRunSnapshot } from "../../server/workflow-types";
import { ArchivedSessionItems } from "./ArchivedSessionItems";
import { PortalsPage } from "./PortalsPanel";
import { StagingLink } from "./StagingLink";
import { WorkspaceSummary, WorkspaceSummaryBody } from "./WorkspaceSummary";
import { SpinOffMenu } from "./SpinOffMenu";
import { DeleteSessionDialog } from "./DeleteSessionDialog";
import {
  IconSidebarRight,
  IconTrash,
  IconArchive,
  IconCheck,
  IconPlus,
  IconPencil,
  IconArrowDown,
  IconArrowRight,
  IconArrowUp,
  IconArrowUpToLine,
  IconDesk,
  IconDotsHorizontal,
  IconEye,
  IconNewBranch,
  IconPullRequest,
  IconLink,
  IconSparkle,
  IconTerminal,
  IconCopy,
  IconChevronRight,
  IconHistory,
  IconFile,
  IconListCircles,
  IconGlobe,
  IconRobot,
  IconMessage,
} from "./icons";
import { KeepInSidebarIcon } from "./sidebar/KeepInSidebarMark";
import { Button } from "../ui/button";
import { useConfirm } from "../ui/confirm";
import { SessionQueue } from "./SessionQueue";
import { deriveSessionQueue, type QueueReceipt } from "../lib/session-queue";
import {
  TopBar,
  TopBarAction,
  TopBarActions,
  TopBarBack,
  TopBarTitle,
} from "../ui/top-bar";
import { cn } from "../ui/cn";
import { composerMenuIcon, composerMenuItem } from "../lib/composer-classes";
import { msgRow } from "../lib/msg-classes";
import { Menu, MENU_ICON } from "../ui/menu";
import { Modal } from "../ui/modal";
import { Tooltip } from "../ui/tooltip";
import { CopyCheck, useCopy } from "../ui/copy";
import { toast } from "../ui/toast";
import { copySessionTranscript } from "../lib/transcript-copy";
import { onTranscriptDisclosure } from "../lib/transcript-disclosures";
import { takePendingSessionFork } from "../lib/pending-session-fork";
import { useSessionScroll } from "../hooks/useSessionScroll";
import {
  useShortcutKeys,
  useShortcutLabel,
} from "../hooks/useShortcutBindings";
import { useSidePanel } from "../hooks/useSidePanel";
import {
  workspaceSummaryOpen,
  WS_SUMMARY_ROOM_W,
  workspaceSummaryShift,
} from "../lib/workspace-summary-open";
import { matchesShortcut } from "../lib/shortcuts";
import { PulseDot } from "../ui/status";
import { TURN_SPACER } from "../lib/app-shell-classes";
import {
  SESSION_DELETE_LABEL,
  SESSION_LINK,
  SESSION_LINK_LINEAR,
  SESSION_LINK_PLAIN,
  PILL_CENTRED,
  ACTION_CLEARANCE,
  ACTION_WITH_REPLIES_CLEARANCE,
  SCROLL_ACTION_CLEARANCE,
  SUGGESTIONS_CLEARANCE,
  TRANSCRIPT_ICON_BUTTON,
  TRANSCRIPT_PILL_BUTTON,
  TRANSCRIPT_PILL_LOADING,
  TRANSCRIPT_PILL_SPINNER,
  TRANSCRIPT_PILL_TOP,
  VIEWER_ACTION_ROW,
  VIEWER_ACTION_ROW_WITH_SCROLL,
  VIEWER_INPUT,
  VIEWER_MENU_SEP,
  VIEWER_MESSAGES,
  VIEWER_MESSAGES_REGION,
  VIEWER_OVERFLOW,
  VIEWER_PRESENCE,
  VIEWER_PRESENCE_AVATAR,
  VIEWER_REVIEW_MAIN,
  VIEWER_SUGGESTIONS,
  VIEWER_SUGGESTIONS_ROW,
  VIEWER_SUGGESTIONS_ROW_INLINE,
  VIEWER_SUMMARY_STEP,
  INFO_CONTENT,
  INFO_HERO,
  INFO_NAME,
  INFO_PAGE,
  INFO_SECTION,
  INFO_SUB,
  INFO_SUMMARY_CARD,
  infoTopbarClass,
  infoTopbarTitleClass,
} from "../lib/session-viewer-classes";
import {
  HEADER_SESSIONBAR,
  HEADER_SESSIONBAR_MODEL,
  HEADER_SESSIONBAR_SEP,
  HEADER_SESSIONBAR_USAGE,
  MOBILE_CONTROL_GLASS,
} from "../lib/app-header-classes";
import type { SessionViewerProps } from "../lib/session-viewer-bindings";

import {
  NO_SUBAGENTS,
  NO_WORKFLOW_RUNS,
  EMPTY_SUGGESTIONS,
  NO_REVIEW_REPOS,
  HIDDEN_REOPEN_MS,
  RESUME_GROWTH_WINDOW_MS,
  LEGACY_OPEN_SETTLE_MAX_MS,
  INDEXED_OPEN_SETTLE_MAX_MS,
  JUMP_PAGE_ENTRIES,
  JUMP_MAX_ENTRIES,
  EMPTY_TRANSCRIPT_ENTRIES,
} from "../lib/session-viewer-constants";
import {
  reviewReposFromKey,
  discoveredPrsFromKey,
  toolPathRootsFromKey,
} from "../lib/session-viewer-derive";
import { SessionShellTiming } from "./session-viewer/shell-timing";
import { SessionViewerAssetOverlay } from "./session-viewer/SessionViewerAssetOverlay";
import { SessionViewerBanners } from "./session-viewer/SessionViewerBanners";
import { SessionViewerChrome } from "./session-viewer/SessionViewerChrome";
import { SessionViewerDialogs } from "./session-viewer/SessionViewerDialogs";
import { SessionViewerMainRegion } from "./session-viewer/SessionViewerMainRegion";
import { SessionViewerSidePanel } from "./session-viewer/SessionViewerSidePanel";
import { runningAgentCount } from "./session-viewer/runtime-controller";
import {
  commitSessionQueueReorder,
  discardSessionOutboxItem,
  reorderSessionQueue,
  sendSessionMessage,
  takeSessionQueueItem,
} from "../lib/session-viewer-send";

export function SessionViewer({
  session,
  composer: {
    setTyping,
    resetSeq: newSessionSeq,
    autoFocus: autoFocusComposer,
    prefill: composerPrefillExternal,
    onPrefillConsumed: onComposerPrefillConsumed,
  },
  availability: {
    canRepairSafety = false,
    canOpenNextChat,
    canStartNewSession,
    canOpenNewWorkspace,
    canOpenSession,
    canOpenReview,
    canOpenAssets,
    canOpenPr,
    canOpenPortal,
    canOpenWorkspace,
  },
  lifecycle: {
    connected,
    pendingCreation = false,
    optimisticEmpty = false,
    initialPending,
    onArchive,
    onArchived,
    onRename,
    onRunningChange,
    onReviewChange,
  },
  chrome: {
    focused = true,
    hideHeader = false,
    hideRightPanel = false,
    topbarEl,
    headerRepoEl,
    headerActionsEl,
    headerModelEl,
    rightPanelEl,
  },
  workspace: {
    workspaceName,
    onRenameWorkspace,
    onArchiveWorkspace,
    onDeleteWorkspace,
    workspaceSessions,
    onSetStatus,
    allSessions,
    tabStripVisible,
    archivedSessions,
    onRestoreSession,
  },
  viewTabs: {
    showReview = false,
    reviewFocusPr,
    showStaging = false,
    onCloseStaging,
    showAssets = false,
    onCloseAssets,
    showTerminal = false,
    onCloseTerminal,
    terminalTabOpen = false,
    showConversation = false,
    conversationThreadId = null,
    showVideo = false,
    videoPanel = null,
    videoTitle = null,
    showPreviewTab = false,
    onClosePreviewTab,
    showPortal = false,
    portalTarget = null,
  },
  subagents: {
    parentSession,
    workerSessions,
    showSubagent = false,
    subagentStack = NO_SUBAGENTS,
    onOpenSubagent,
    onSubagentBack,
    onSubagentLabel,
  },
}: SessionViewerProps) {
  const navigation = useNavigation();
  const { send, addHandler } = useSessionSocket();
  const goBack = navigation.goBack;
  const openNextChat = canOpenNextChat ? navigation.openNextChat : undefined;
  const openNewSession = canStartNewSession
    ? navigation.openNewSessionInWorkspace
    : undefined;
  const openNewWorkspace = canOpenNewWorkspace
    ? navigation.openNewWorkspace
    : undefined;
  const openSession = canOpenSession ? navigation.openSession : undefined;
  const openReview = canOpenReview ? navigation.openReview : undefined;
  const openAssets = canOpenAssets ? navigation.openAssets : undefined;
  const openPr = canOpenPr ? navigation.openPr : undefined;
  const openPortal = canOpenPortal ? navigation.openPortal : undefined;
  const openCurrentWorkspace = canOpenWorkspace
    ? navigation.openCurrentWorkspace
    : undefined;

  // Repos the Review tab can target: the session's own, then each attached
  // one. Keyed on the contents like the PR lists below, and for a sharper
  // reason than they have — this was a bare literal, so it handed PrPanel a
  // new array on every render, and its `targets` memo could never bail no
  // matter what else downstream was stable.
  const reviewReposKey = [
    session.repo || "repository",
    ...(session.attachedRepos || []).map((repo) => repo.repo),
  ].join("\u0000");
  const reviewRepos = useMemo(
    () => reviewReposFromKey(reviewReposKey),
    [reviewReposKey],
  );
  const prPresentation = useMemo(
    () => sessionPrPresentation(session.prs),
    [session.prs],
  );
  const worktreeDiffSource: "worktree" | undefined =
    openReview && (prPresentation.primary || prPresentation.additional.length)
      ? "worktree"
      : undefined;
  const changeWorktreeDiffSource = (next: "pull-request" | "worktree") => {
    if (next === "pull-request") openReview?.();
  };
  const mergedPrValue =
    prPresentation.primary?.state === "MERGED"
      ? prPresentation.primary
      : undefined;
  const prNumber = mergedPrValue?.number;
  const prRepo = mergedPrValue?.repo;
  const prBranch = mergedPrValue?.branch;
  const prTitle = mergedPrValue?.title;
  // The sessions poll rebuilds session.prs every tick, so `primary` is a new
  // object on every render. Everything downstream memoizes on it, including
  // the Slack share the memoized transcript takes as a prop, so key it on the
  // fields those readers use, the way the walkthrough below does.
  const mergedPrKey = mergedPrValue
    ? [
        mergedPrValue.number,
        mergedPrValue.repo,
        mergedPrValue.branch ?? "",
        mergedPrValue.title ?? "",
      ].join("\u0000")
    : "";
  // Rebuilt from the key's own leaves so the memo callback reads only its
  // deps: identity stays stable across poll ticks that change nothing.
  const mergedPr = useMemo(
    () =>
      mergedPrKey
        ? {
            number: prNumber,
            repo: prRepo,
            branch: prBranch,
            title: prTitle,
          }
        : undefined,
    [mergedPrKey, prNumber, prRepo, prBranch, prTitle],
  );
  const [shippedChangeStatus, setShippedChangeStatus] = useState<
    "idle" | "sharing"
  >("idle");
  const [shippedSlackReconnectRequired, setShippedSlackReconnectRequired] =
    useState(false);
  // The share this view just made. The persisted receipt on the session is the
  // same thing after a reload; this only covers the gap before it refreshes.
  const [shippedShare, setShippedShare] = useState<SessionSlackShare | null>(
    null,
  );
  const walkthroughScreenshot = session.walkthrough?.shots?.find(
    (shot) => shot.after,
  )?.after;
  useEffect(() => {
    setShippedChangeStatus("idle");
    setShippedSlackReconnectRequired(false);
    setShippedShare(null);
  }, [session.id, mergedPr?.number]);
  // Shipped-share hooks stay at the first moved hook position so the existing
  // SessionViewer hook order remains unchanged.
  const shippedShareState = useShippedShareState({
    sessionId: session.id,
    mergedPrNumber: mergedPr?.number,
  });
  const { dismissKey: shareDismissKey, dismissed: shareDismissed } =
    shippedShareState;
  const dismissShippedChangeShare = useCallback(
    () => dismissSlackShare(shareDismissKey),
    [shareDismissKey],
  );
  const sendShippedChangeToSlack = useCallback(
    async (message: string, channel: string, screenshots: string[]) => {
      await shareShippedChangeAction({
        identity: { sessionId: session.id, mergedPr },
        setters: {
          setStatus: setShippedChangeStatus,
          setReconnectRequired: setShippedSlackReconnectRequired,
          setShare: setShippedShare,
        },
        input: { message, channel, screenshots },
        toast,
      });
    },
    [mergedPr, session.id],
  );
  // Undo deletes the message in Slack and drops the receipt, so the card can
  // offer the send again. Slack only lets someone delete their own message, so
  // a teammate's post fails here rather than silently doing nothing.
  const undoShippedChangeShare = useCallback(
    async (at: string) => {
      await undoShippedChangeAction({
        sessionId: session.id,
        at,
        setShare: setShippedShare,
        toast,
      });
    },
    [session.id],
  );
  const reconnectShippedSlack = useCallback(async () => {
    await reconnectShippedSlackAction({
      setReconnectRequired: setShippedSlackReconnectRequired,
      toast,
    });
  }, []);
  const promotedPr =
    prPresentation.primary?.source !== "primary"
      ? prPresentation.primary
      : undefined;
  // The one PR a phone's top bar shows. The primary if there is one, else the
  // series' worst state, so a failing attached-repo PR is not hidden behind a
  // green one. Undefined when the session has no PR at all — the bar then
  // carries nothing rather than a chip that says "none".
  const phonePr =
    prPresentation.primary ?? worstPrRef(prPresentation.additional);
  // PRs the server matched to this session through their body's attribution
  // footer — opened on a branch the session doesn't own, so they'd otherwise
  // have no Review tab of their own.
  //
  // Keyed on the contents, the way mergedPr above is: the poll rebuilds
  // session.prs on every tick that changed any session, so this list arrives
  // as a new array with the same PRs in it. It is a dep of PrPanel's
  // `targets` memo, which a fresh identity re-runs. Every field the
  // projection carries is in the key, not only the three that memo reads:
  // LinkedPrEntry is shared with the linked-PR path, so a reader of `title`
  // or `url` should not be handed a stale one.
  const discoveredPrsKey = (session.prs || [])
    .filter((ref) => ref.source === "discovered")
    .map((ref) =>
      [
        ref.repo,
        ref.branch,
        ref.number ?? "",
        ref.url ?? "",
        ref.title ?? "",
      ].join("\u0000"),
    )
    .join("\u0001");
  const discoveredPrs = useMemo(
    () => discoveredPrsFromKey(discoveredPrsKey),
    [discoveredPrsKey],
  );
  // Which PR the Review tab should open on, set by the PR chips in the
  // Workspace strip (seq lets the same chip re-focus after a manual switch).
  const [reviewFocus, setReviewFocus] = useState<PrFocus | undefined>(
    undefined,
  );
  // Wide Review moves this navigation into the standing workspace summary.
  // Keep the page in the host so the summary and review canvas cannot diverge.
  const [reviewPage, setReviewPage] = useState<PrReviewPage>("files");
  const focusPrInReview = useCallback(
    (ref?: { repo: string; branch: string }, view?: "checks") => {
      if (ref || view)
        setReviewFocus((prev) => ({ ...ref, view, seq: (prev?.seq ?? 0) + 1 }));
      openReview?.();
    },
    [openReview],
  );
  // The app opened Review on a specific PR (a sidebar PR row, or a workspace
  // row whose PR isn't this session's primary). Re-sequenced locally so it
  // shares one monotonic counter with the chips above.
  const syncReviewFocus = useEffectEvent(() => {
    if (!reviewFocusPr) return;
    setReviewFocus((prev) => ({
      repo: reviewFocusPr.repo,
      branch: reviewFocusPr.branch,
      number: reviewFocusPr.number,
      seq: (prev?.seq ?? 0) + 1,
    }));
  });
  useEffect(() => {
    syncReviewFocus();
  }, [reviewFocusPr?.seq]);
  // Worktree roots for the transcript's tool rows: paths inside them render
  // repo-relative instead of as a long absolute path (see tidyPath).
  //
  // Keyed on the contents, the way mergedPr above is: a poll that changed any
  // session re-parses the whole list, so `attachedRepos` is a new array on
  // most ticks with the same repos in it. This one is a context value, which
  // no memo downstream can stop, so a fresh identity re-renders every tool
  // row in the transcript. tidyPath reads dir and label, and nothing else.
  const toolPathRootsKey = [
    session.worktreeDir || "",
    ...(session.attachedRepos || []).map(
      (repo) => `${repo.dir}\u0000${repo.repo}`,
    ),
  ].join("\u0001");
  const toolPathRoots = useMemo(
    () => toolPathRootsFromKey(toolPathRootsKey),
    [toolPathRootsKey],
  );
  const githubReviewRepos = reviewRepos;
  // With no session-owned primary, workspace PRs are the only real review
  // targets. This includes the multi-PR case where no single ref was promoted;
  // leaving the current repo target first opened an empty “Create PR” canvas.
  const workspaceOnlyPrs =
    !prPresentation.primary && prPresentation.additional.length > 0;
  const panelReviewRepos =
    promotedPr || workspaceOnlyPrs ? NO_REVIEW_REPOS : githubReviewRepos;
  const [shellTiming] = useState(
    () => new SessionShellTiming(performance.now()),
  );
  // A full-width view-tab (Review, Staging, Assets, a sub-agent) takes over the
  // session column, so the session DOM isn't mounted while any is up — the scroll /
  // history / scroll-restore effects below must bail in all cases.
  const subagentOpen = showSubagent && subagentStack.length > 0;
  const sessionHidden =
    showReview ||
    showStaging ||
    showAssets ||
    showTerminal ||
    showPreviewTab ||
    (showPortal && !!portalTarget) ||
    subagentOpen ||
    (showConversation && !!conversationThreadId) ||
    (showVideo && !!videoPanel);
  const [cachedTranscript] = useState(() =>
    peekCachedTranscriptView(session.id),
  );
  // App keys SessionViewer by session id, so this store is created once for
  // the mounted session and cannot be replaced by polling model metadata.
  const [transcriptViewStore] = useState(
    () =>
      new TranscriptViewStore(
        withModelSwitches(
          peekCachedTranscriptView(session.id)?.entries ?? [],
          session.modelHistory,
        ),
      ),
  );
  const entries = useSyncExternalStore(
    transcriptViewStore.subscribe,
    transcriptViewStore.getSnapshot,
    transcriptViewStore.getServerSnapshot,
  );
  const shippedScreenshot =
    walkthroughScreenshot || latestFeaturedScreenshot(entries);
  const setEntries = useCallback(
    (
      update:
        | TranscriptEntry[]
        | ((previous: TranscriptEntry[]) => TranscriptEntry[]),
    ) => transcriptViewStore.update(update),
    [transcriptViewStore],
  );
  // The message rail's index. useMemo on purpose (against the house rule):
  // this is a full scan of a transcript that runs to several thousand
  // entries, not the routine allocation the rule is about.
  const sentMessages = useMemo(() => collectSentMessages(entries), [entries]);
  const liveTurnStore = useMemo(() => {
    // Read (and discard) the session id so the reset key is explicit.
    void session.id;
    return new LiveTurnStore();
  }, [session.id]);
  const transcriptCommitCount = useRef(0);
  const onTranscriptRender = useCallback(
    (
      _: string,
      phase: "mount" | "update" | "nested-update",
      actualDuration: number,
    ) => {
      recordSessionPerf("react_transcript_commit_ms", actualDuration, {
        phase,
        entries: transcriptViewStore.getSnapshot().length,
      });
      transcriptCommitCount.current++;
      if (phase === "mount" || transcriptCommitCount.current % 20 === 0)
        scheduleTranscriptDomNodeSample();
    },
    [transcriptViewStore],
  );
  const transcriptHistory = useTranscriptHistoryController({
    sessionId: session.id,
    ran: session.ran,
    cachedTranscript,
  });
  const {
    loading,
    setLoading,
    historyTruncated,
    setHistoryTruncated,
    loadingHistory,
    setLoadingHistory,
    loadingAllHistory,
    setLoadingAllHistory,
  } = transcriptHistory.state;
  const {
    transcriptReadySessionRef,
    transcriptCursorRef,
    transcriptSeqRef,
    historyStartRef,
  } = transcriptHistory.cursors;
  const {
    historyWalkRef,
    historyRevealRef,
    backgroundHistoryRef,
    backgroundHistoryAttemptedRef,
  } = transcriptHistory.walk;
  const { loadingHistoryRef } = transcriptHistory.hold;
  const {
    index: transcriptIndex,
    indexState: transcriptIndexState,
    indexExpected: transcriptIndexExpected,
    indexExpectedRef: transcriptIndexExpectedRef,
    indexEpochRef: transcriptIndexEpochRef,
    rangeRetryGeneration: transcriptRangeRetryGeneration,
    existingIndexForInit,
    setIndexMode,
    acceptInitTail,
    replaceIndex,
    acceptRange,
    projectAppend,
    loadRanges: loadTranscriptRanges,
    cancelIndexAnchorHold,
    restorePendingIndexPosition,
    settleVisibleRanges,
  } = useTranscript({
    sessionId: session.id,
    cachedTranscript,
    send,
    transcriptViewStore,
  });
  // Composer state stays at the first moved hook position so the existing
  // SessionViewer hook order remains unchanged.
  const composerDraft = useSessionComposerDraft({
    identity: { sessionId: session.id },
  });
  const {
    draftKey,
    images,
    setImages,
    files,
    setFiles,
    uploads,
    uploadStaging,
  } = composerDraft.attachments;
  const { forkFrom, setForkFrom } = composerDraft.fork;
  const composerSettersRef = useRef({ setImages, setFiles, setForkFrom });
  const [
    {
      isStreaming,
      isRunningLive,
      safety,
      queued,
      steered,
      pendingDeliveryIds,
      ask,
      model,
      usage,
    },
    dispatchSessionRuntime,
  ] = useSessionRuntime({
    isRunning: session.isRunning,
    safety: session.safety,
    model: session.model || "",
    usage: session.usage,
  });
  useEffect(() => {
    dispatchSessionRuntime({ type: "sync_safety", safety: session.safety });
  }, [dispatchSessionRuntime, session.id, session.safety]);
  const runtimeController = useSessionRuntimeController({
    identity: {
      session,
      focused,
      optimisticEmpty,
      workspaceSessions,
      onSetStatus,
    },
    run: {
      isRunningLive,
      isStreaming,
      safety,
      entries,
      loading,
      liveTurnStore,
      forkFrom,
    },
    staging: {
      phonePr,
      show: showStaging,
      onClose: onCloseStaging,
    },
    socket: { send },
  });
  const agentsController = runtimeController.agents;
  const presenceController = runtimeController.presence;
  const runController = runtimeController.run;
  const stagingController = runtimeController.staging;
  const previewController = runtimeController.preview;
  const subagents = agentsController.subagents;
  const currentUser = agentsController.currentUser;
  const pinned = agentsController.pinned;
  const canKeepInSidebar = agentsController.canKeepInSidebar;
  const keepInSidebar = agentsController.keepInSidebar;
  const promoting = agentsController.promoting;
  const isAsk = agentsController.isAsk;
  const hasWorkspace = agentsController.hasWorkspace;
  const hasRepoWork = agentsController.hasRepoWork;
  const handlePromote = agentsController.handlePromote;
  const gitRefreshTick = presenceController.gitRefreshTick;
  const setGitRefreshTick = presenceController.setGitRefreshTick;
  const sessionPrTargetsRef = presenceController.sessionPrTargetsRef;
  const viewers = presenceController.viewers;
  const setViewers = presenceController.setViewers;
  const typingUsers = presenceController.typingUsers;
  const setTypingUsers = presenceController.setTypingUsers;
  const workspacePreparing = presenceController.workspacePreparing;
  const setWorkspacePreparing = presenceController.setWorkspacePreparing;
  const isBusy = runController.isBusy;
  const busySince = runController.busySince;
  const stopRequestedAt = runController.stopRequestedAt;
  const setStopRequestedAt = runController.setStopRequestedAt;
  const stopRequest = runController.stopRequest;
  const waitingForWorkspace = runController.waitingForWorkspace;
  const settingUpWorkspace = runController.settingUpWorkspace;
  const staging = stagingController.deployment;
  const stagingUrl = stagingController.url;
  const previewStatus = previewController.status;
  const setPreviewStatus = previewController.setStatus;
  const startDeclaredPortal = previewController.startDeclaredPortal;
  const livePortals = previewController.livePortals;
  const {
    draggingQueueRef,
    pendingReorderRef,
    composerPrefill,
    setComposerPrefill,
  } = useComposerQueueState();
  const setComposerPrefillRef = useRef(setComposerPrefill);
  // Quick-reply chips for the turn that just ended (components/ReplySuggestions).
  // Server-generated and server-cleared; a picked chip retires the row here.
  const [replySuggestions, setReplySuggestions] =
    useState<ReplySuggestion[]>(EMPTY_SUGGESTIONS);
  // Settings → Preferences, default on. Only hides the row: the server keeps
  // its own switch (OPENSESSION_REPLY_SUGGESTIONS=0) for the generation.
  const [showReplySuggestions, setShowReplySuggestions] = useState(
    getReplySuggestionsPref,
  );
  useEffect(
    () =>
      onReplySuggestionsChanged(() =>
        setShowReplySuggestions(getReplySuggestionsPref()),
      ),
    [],
  );
  // Settings → Preferences, default on. This only hides the visible button;
  // the keyboard shortcut and command palette action remain available.
  const [showNextChatButton, setShowNextChatButton] = useState(
    getNextChatButtonPref,
  );
  useEffect(
    () =>
      onNextChatButtonChanged(() =>
        setShowNextChatButton(getNextChatButtonPref()),
      ),
    [],
  );
  const composerOutbox = useSessionPromptOutbox({
    identity: { sessionId: session.id, connected },
    runtime: { dispatch: dispatchSessionRuntime, initialPending },
    transcript: { entries, setEntries },
  });
  const { pending, setPending, pendingRef } = composerOutbox.pending;
  const { outboxItems, landedOutboxIds, setLandedOutboxIds } =
    composerOutbox.durable;
  const [slackComposer, setSlackComposer] = useState<{
    id: string;
    message: string;
    channel?: string;
    images: string[];
  } | null>(null);
  const [slackComposerStatus, setSlackComposerStatus] = useState<
    "idle" | "sharing"
  >("idle");
  const [slackComposerReconnect, setSlackComposerReconnect] = useState(false);
  const [slackComposerSent, setSlackComposerSent] = useState<SlackSent | null>(
    null,
  );
  const { copied, share: shareLink } = useCopy();
  // Inline rename of the header title (double-click), mirroring the tab strip.
  // `null` = not editing; a string = the working draft.
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  // Main session-area view: the transcript+composer vs. the full-width PR review
  // that takes over the whole session column. Which one shows is now owned by App
  // (the top tab strip's Review view-tab) and passed in as `showReview`; the
  // open triggers call openReview. Only meaningful on a code session
  // (hasWorkspace) — App only offers the Review tab there.
  // Sub-agents open as their own view-tab (App owns the breadcrumb stack, like
  // every other tab) — a sub-agent run is a conversation, so it gets the session
  // column rather than the right sidebar.
  // Phones fold the desktop Workspace panel into the title-opened detail page.
  // Keeping this state near panelOpen lets the shared diff poll serve either
  // surface without mounting a second copy of the data hook.
  const [infoPageOpen, setInfoPageOpen] = useState(false);
  const [infoPageScrolled, setInfoPageScrolled] = useState(false);
  // Stable identity so the memoized TranscriptBlocks bails out on unrelated
  // re-renders (e.g. toggling the workspace panel) instead of re-rendering the
  // whole transcript.
  const openSubagent = useCallback(
    (agentId: string, label: string) =>
      onOpenSubagent?.(session.id, agentId, label),
    [onOpenSubagent, session.id],
  );
  const nameSubagent = useCallback(
    (agentId: string, label: string) =>
      onSubagentLabel?.(session.id, agentId, label),
    [onSubagentLabel, session.id],
  );
  // The agent-published walkthrough, rendered inline in the session as well as in
  // the Review tab. Keyed on its contents so the object identity only changes
  // when the walkthrough actually does — the sessions poll hands back a fresh
  // session object every tick, and an unstable prop here would re-render the
  // whole (expensive) transcript each time.
  const wt = session.walkthrough;
  const wtSummary = wt?.summary ?? "";
  const wtVideo = wt?.video;
  const wtVideoTitle = wt?.videoTitle;
  const wtShots = wt?.shots;
  const wtPublishedAt = wt?.publishedAt ?? "";
  const wtPublishedBy = wt?.publishedBy;
  const wtPublishedEntryId = wt?.publishedEntryId;
  const walkthroughKey = session.walkthrough
    ? [
        session.walkthrough.publishedAt,
        session.walkthrough.video || "",
        session.walkthrough.summary.length,
        session.walkthrough.shots?.length || 0,
      ].join("|")
    : "";
  // Same rebuild-from-key-leaves trick as mergedPr above.
  const hasWalkthrough = !!wt;
  const sessionWalkthrough = useMemo(
    () =>
      hasWalkthrough
        ? {
            summary: wtSummary,
            video: wtVideo,
            videoTitle: wtVideoTitle,
            shots: wtShots,
            publishedAt: wtPublishedAt,
            publishedBy: wtPublishedBy,
            publishedEntryId: wtPublishedEntryId,
          }
        : undefined,
    [
      hasWalkthrough,
      wtSummary,
      wtVideo,
      wtVideoTitle,
      wtShots,
      wtPublishedAt,
      wtPublishedBy,
      wtPublishedEntryId,
    ],
  );
  // The PR verdict on the transcript's last review loop, keyed the same way:
  // it is built fresh from the polled session on every render, and an
  // unstable prop here re-renders the whole transcript on every poll tick.
  const reviewResultValue = reviewLoopResult(session);
  const reviewResultKey = JSON.stringify(reviewResultValue ?? null);
  const reviewResult = useMemo(
    () =>
      reviewResultKey === "null"
        ? undefined
        : (JSON.parse(reviewResultKey) as ReturnType<typeof reviewLoopResult>),
    [reviewResultKey],
  );
  // Open state + width of the right panel. Browser-level, and shared with the
  // session-less workspace route so the chosen summary card or panel follows
  // the person between workspaces (hooks/useSidePanel).
  const {
    open: panelOpen,
    setOpen: setPanelOpen,
    page: desktopPanelPage,
    setPage: setDesktopPanelPage,
    style: panelStyle,
    resizeHandle: panelResizeHandle,
  } = useSidePanel();
  // Review starts with a clear canvas without overwriting the browser-wide
  // workspace-panel preference. Its own toggle can open the panel for this view,
  // while returning to a session restores that session's ordinary panel state.
  const [reviewPanelOpen, setReviewPanelOpen] = useState(false);
  const activePanelOpen = showReview ? reviewPanelOpen : panelOpen;
  const setActivePanelOpen = showReview ? setReviewPanelOpen : setPanelOpen;
  // Phones use null for their Workspace details overview and push tools from
  // that page. The desktop selection comes from useSidePanel so the open panel
  // stays on the same tool while its session changes.
  const [panelPage, setPanelPage] = useState<
    null | "changes" | "portals" | "agents" | "terminal"
  >(null);
  // Start a panel terminal only after its tab is opened. Keep it mounted while
  // switching tabs, then drop it when the panel closes.
  const [panelTerminalMounted, setPanelTerminalMounted] = useState(
    () => activePanelOpen && desktopPanelPage === "terminal",
  );
  // Session scratch assets (Assets tab): fetched once per session + on
  // assets_changed broadcasts; the tab only appears once files exist.
  const { files: assetFiles, refresh: refreshAssets } = useSessionAssets(
    session.id,
    addHandler,
  );
  const assetPaths = useMemo(
    () => assetFiles.map((file) => file.path),
    [assetFiles],
  );
  // Which asset the main-area Assets view-tab previews. Controlled here so a
  // tree selection and a later overlay promotion never drift apart.
  const [selectedAssetPath, setSelectedAssetPath] = useState<string | null>(
    null,
  );
  // One file, lifted over the conversation. Every way into an asset — a
  // transcript chip, a tool row, the Info panel's list — lands here, so the
  // file behaves the same whichever one you used; the Assets tab is where you
  // go deliberately, and the overlay's own header is how you get promoted
  // into it.
  const [overlayAssetPath, setOverlayAssetPath] = useState<string | null>(null);
  // Through a ref because this reaches the memoized transcript as a context
  // value — changing action availability must not re-render the whole thing.
  const openAssetsRef = useRef(openAssets);
  useLayoutEffect(() => {
    openAssetsRef.current = openAssets;
  }, [openAssets]);
  const openAssetFromTranscript = useCallback((path: string) => {
    setOverlayAssetPath(path);
  }, []);
  const closeAssetOverlay = useCallback(() => setOverlayAssetPath(null), []);
  // The overlay's "Open as tab": the file it was showing becomes the Assets
  // tab's selection, and the overlay gets out of the way.
  const promoteAssetToTab = useCallback((path: string) => {
    setSelectedAssetPath(path);
    setOverlayAssetPath(null);
    openAssetsRef.current?.();
  }, []);
  const sessionReports = useSessionReports(session.id, addHandler);
  // Team notes — human-to-human messages on this session, interleaved into
  // the transcript as NoteBubbles. The agent never sees them; they're posted
  // from the composer's note mode.
  const [notes, setNotes] = useState<SessionNote[]>([]);
  const [noteMode, setNoteMode] = useState(false);
  const { addSessionAttachments, fileDragActive } = useSessionAttachmentDrop({
    identity: { focused, sessionHidden, noteMode },
    draft: { draftKey, setImages, setFiles, uploads },
  });
  useEffect(() => {
    setNotes([]);
    setNoteMode(false);
    let cancelled = false;
    fetchSessionNotesApi(session.id)
      .then((loaded) => {
        if (!cancelled && loaded.length) setNotes(loaded);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session.id]);
  useEffect(
    () =>
      addHandler((msg) => {
        if (
          (msg.type !== "session_note" &&
            msg.type !== "session_note_deleted") ||
          msg.sessionId !== session.id
        )
          return;
        if (msg.type === "session_note_deleted") {
          setNotes((prev) => prev.filter((n) => n.id !== msg.noteId));
          return;
        }
        setNotes((prev) => {
          const i = prev.findIndex((n) => n.id === msg.note.id);
          if (i < 0) return [...prev, msg.note];
          // An edit re-broadcasts the whole note under the same id.
          const next = [...prev];
          next[i] = msg.note;
          return next;
        });
      }),
    [addHandler, session.id],
  );
  // Viewing the session marks its notes read (an unread indicator keys off
  // this stamp).
  useEffect(() => {
    if (!notes.length) return;
    markNotesRead(session.id, notes[notes.length - 1]!.ts);
  }, [notes, session.id]);
  // Opening the session is what clears an @-mention of you: looking at it is
  // what "seen" means, so there is no separate dismiss. Runs on the session
  // id alone — a mention that lands while you are already here clears too,
  // which is right: you are looking at it.
  useEffect(() => {
    clearMention(session.id);
    return onMentionsChanged(() => clearMention(session.id));
  }, [session.id]);
  const readerLayout = useTranscriptReaderLayout({
    session,
    transcript: {
      entries,
      setEntries,
      loading,
      historyTruncated,
      store: transcriptViewStore,
    },
    index: {
      index: transcriptIndex,
      indexState: transcriptIndexState,
      indexExpected: transcriptIndexExpected,
      indexExpectedRef: transcriptIndexExpectedRef,
      indexEpochRef: transcriptIndexEpochRef,
      restorePendingIndexPosition,
      settleVisibleRanges,
    },
    history: { controller: transcriptHistory, loadingHistory },
    send,
  });
  const {
    messagesRef,
    setMessagesRef,
    spacerRef,
    followingLive,
    following,
    showScrollToBottom,
    atTop,
    scrollToLatest,
    leaveLatest,
    endTurn,
    shouldMaintainEnd,
    relayout,
    onScroll,
    scheduleAnchorCapture,
  } = readerLayout.scroll;
  const {
    tailActionNeedsLayoutScrollRef,
    openSettlePending,
    onVisibleRangesSettled,
    viewerInput,
    setViewerInput,
  } = readerLayout.settle;
  const { startHistoryHold, requestHistoryPage, finishHistoryWalk } =
    readerLayout.history;

  // Per-session model/account/effort/goal state, plus the dynamic workflow
  // run list — extracted to useSessionModelWorkflowController. Destructured
  // into the same local names the rest of this component already used.
  const { model: modelController, workflows: workflowController } =
    useSessionModelWorkflowController(session, dispatchSessionRuntime);
  const {
    models,
    defaultModel,
    accounts,
    accountId,
    effort,
    fastMode,
    goalOverride,
    currentGoal,
    setEffort,
    setFastMode,
    setAccountId,
    setGoalOverride,
  } = modelController;
  const { workflowRuns, workflowsLoaded, workflowAction, setWorkflowRuns } =
    workflowController;
  const runningAgents = runningAgentCount(workflowRuns, subagents);

  // A linked Plain thread gets a read-only conversation sidebar (+ jump-to-Plain),
  // available even for ask-mode sessions that have no code workspace.
  const hasPlain = Boolean(session.plainThreadId);
  const plainUrl = session.plainThreadId
    ? plainThreadUrl(session.plainThreadId)
    : "";
  // Feed-item link (a video, a dashboard, …): the same
  // jump-out affordance Plain has, generic over the session's externalRefs.
  const feedRef = (session.externalRefs || []).find((r) => r.url);
  const feedRefLabel = feedRef
    ? feedForRefKind(feedRef.kind)?.title ||
      feedRef.kind.charAt(0).toUpperCase() + feedRef.kind.slice(1)
    : "";
  // Workflow runs open the panel too: ask-mode sessions without a workspace
  // or Plain thread still need somewhere to show the Agents tab.
  const panelAvailable =
    !hideRightPanel &&
    (hasWorkspace ||
      hasPlain ||
      workflowRuns.length > 0 ||
      subagents.length > 0 ||
      sessionReports.length > 0);
  // Task rows learn their child session id from this map while the call is
  // still running (the result text that normally carries it doesn't exist
  // yet), enabling the mid-run "Watch ↗" drill-in.
  const liveSubagents = useMemo(() => {
    const m = new Map<string, LiveSubagent>();
    for (const s of subagents)
      if (s.toolUseId) m.set(s.toolUseId, { id: s.id, status: s.status });
    return m;
  }, [subagents]);
  // Live worktree diff, handed to the Changes page as `diff=` so opening it
  // reads the poll the panel already runs rather than starting a second one.
  // Parked unless a workspace surface is open on a code session: the panel
  // column on desktop, the info page on a phone. A client-minted session is not
  // queryable until create persistence lands; leaving the resource parked makes
  // Changes use its ordinary empty state instead of flashing a transient 404.
  const diffState = useSessionDiff(session.id, {
    enabled:
      !pendingCreation && hasRepoWork && (activePanelOpen || infoPageOpen),
    isRunning: isBusy,
  });

  // Ctrl+R focuses the session composer directly.
  const archiveShortcutLabel = useShortcutLabel("session-archive");
  const copyTranscriptLabel = useShortcutLabel("session-copy-transcript");
  const nextChatKeys = useShortcutKeys("workspace-next-unread");
  const newSiblingKeys = useShortcutKeys("session-new-sibling");
  const transcriptDownKeys = useShortcutKeys("transcript-down");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!focused) return;
      if (matchesShortcut(e, "composer-focus")) {
        e.preventDefault();
        composerRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focused]);

  // ⌘⌥↑/⌘⌥↓ step the reasoning effort through the current model's supported
  // levels (up = more thinking), wrapping at the ends. Resolves the same
  // effective effort as the ModelEffortSelect pill (stored value when the
  // model offers it, else "high", else the model's first level), so the step
  // always starts from what the pill displays. Fires with the composer
  // focused too — the Alt modifier keeps it clear of plain ⌘↑/⌘↓ (workspace
  // cycling in the Sidebar, and caret start/end moves in the textarea).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!focused) return;
      if (e.defaultPrevented) return;
      const dir = matchesShortcut(e, "effort-up")
        ? 1
        : matchesShortcut(e, "effort-down")
          ? -1
          : 0;
      if (dir === 0) return;
      const effectiveModel = model || defaultModel;
      const supportedIds =
        models.find((m) => m.id === effectiveModel)?.efforts ?? [];
      const supported = EFFORTS.filter((ef) => supportedIds.includes(ef.id));
      if (supported.length < 2) return;
      const effective = supportedIds.includes(effort)
        ? effort
        : supportedIds.includes("high")
          ? "high"
          : supported[0].id;
      const idx = supported.findIndex((ef) => ef.id === effective);
      const next = supported[(idx + dir + supported.length) % supported.length];
      if (!next) return;
      e.preventDefault();
      setEffort(next.id);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focused, models, defaultModel, model, effort, setEffort]);

  // ⌃⇧↑/⌃⇧↓ page the transcript up/down — keyboard scrolling that works while
  // the composer is focused. A programmatic scroll carries no reader gesture,
  // so useSessionScroll won't re-engage auto-follow from it: a Down that would
  // land at the live edge goes through scrollToLatest, which resumes following.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!focused) return;
      if (e.defaultPrevented) return;
      const up = matchesShortcut(e, "transcript-up");
      const down = matchesShortcut(e, "transcript-down");
      if (!up && !down) return;
      const el = messagesRef.current;
      if (!el) return;
      e.preventDefault();
      const delta = Math.max(120, el.clientHeight * 0.8);
      if (down) {
        const remaining = el.scrollHeight - el.clientHeight - el.scrollTop;
        if (remaining - delta < 48) {
          scrollToLatest();
          return;
        }
      }
      if (up) leaveLatest();
      el.scrollBy({
        top: up ? -delta : delta,
        behavior: "smooth",
      });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focused, messagesRef, scrollToLatest, leaveLatest]);

  // A "new tab" while this session is open is a fresh session *in this session*:
  // clear the composer and jump to the live edge. We skip the first run (and
  // session switches, which remount this with whatever the counter's at) and
  // only react to real bumps from the tab-bar +.
  const composerResetSeq = useComposerReset({
    newSessionSeq,
    draftKey,
    setImages,
    setFiles,
    setForkFrom,
    scrollToLatest,
    composerRef,
  });

  // Browser tab title follows the workspace, the same name the header shows.
  // The session's own title names a tab inside it, not the page.
  useEffect(() => {
    if (!focused) return;
    document.title = workspaceName || session.title || DEFAULT_DOC_TITLE;
    return () => {
      document.title = DEFAULT_DOC_TITLE;
    };
  }, [focused, workspaceName, session.title]);

  // "Add session transcripts" chips on a fresh session's blank canvas: sibling
  // workspace sessions the user can attach as context — selected ids ride the
  // first send as `contextSessions` and the server inlines a fenced transcript
  // digest of each. One-shot: cleared once a send consumes them.
  const [contextSessions, setContextSessions] = useState<string[]>([]);

  useSessionViewerSubscription({
    connection: {
      connected,
      session,
      addHandler,
      send,
      onRunningChange,
    },
    transcript: {
      cursorRef: transcriptCursorRef,
      sequenceRef: transcriptSeqRef,
      readySessionRef: transcriptReadySessionRef,
      viewStore: transcriptViewStore,
      setEntries,
      setLoading,
      setHistoryTruncated,
      liveTurnStore,
    },
    index: {
      existingForInit: existingIndexForInit,
      setMode: setIndexMode,
      acceptInitTail,
      replace: replaceIndex,
      messagesRef,
      followingLive,
      acceptRange,
      projectAppend,
    },
    history: {
      backgroundRef: backgroundHistoryRef,
      revealRef: historyRevealRef,
      loadingRef: loadingHistoryRef,
      setLoading: setLoadingHistory,
      walkRef: historyWalkRef,
      setLoadingAll: setLoadingAllHistory,
      finishWalk: finishHistoryWalk,
      shellTiming,
      startRef: historyStartRef,
      jumpMaxEntries: JUMP_MAX_ENTRIES,
      requestPage: requestHistoryPage,
      scrollToLatest,
    },
    runtime: {
      setWorkflowRuns,
      setViewers,
      setTypingUsers,
      dispatch: dispatchSessionRuntime,
      setGitRefreshTick,
      prTargetsRef: sessionPrTargetsRef,
      setWorkspacePreparing,
      setStopRequestedAt,
      setAccountId,
    },
    composer: {
      draggingQueueRef,
      draftKey,
      setImages,
      setFiles,
      setContextSessions,
      setPrefill: setComposerPrefill,
      setReplySuggestions,
      emptySuggestions: EMPTY_SUGGESTIONS,
    },
    slack: {
      setComposer: setSlackComposer,
      setStatus: setSlackComposerStatus,
      setReconnect: setSlackComposerReconnect,
      setSent: setSlackComposerSent,
    },
  });

  usePendingPromptReconciliation({
    identity: {
      sessionId: session.id,
      sessionIsRunning: session.isRunning,
      initialPending,
    },
    delivery: {
      entries,
      queued,
      steered,
      pendingRef,
      setPending,
      setLandedOutboxIds,
    },
    runtime: { dispatch: dispatchSessionRuntime, liveTurnStore },
  });

  const {
    beginHistoryLoad,
    loadEarlierHistory,
    loadAllHistory,
    handleMessagesScroll,
  } = useTranscriptReaderLifecycle({
    identity: { session, focused, sessionHidden },
    transcript: {
      entries,
      liveTurnStore,
      loading,
      tailActionNeedsLayoutScrollRef,
    },
    history: {
      controller: transcriptHistory,
      historyTruncated,
      loadingHistory,
      requestHistoryPage,
      startHistoryHold,
    },
    scroll: {
      messagesRef,
      followingLive,
      scrollToLatest,
      leaveLatest,
      relayout,
      onScroll,
      scheduleAnchorCapture,
      endTurn,
    },
    runtime: { queued, steered, pending, ask, isBusy },
    index: { transcriptIndexExpected, transcriptIndexExpectedRef },
  });

  // Codex-model sessions start fresh threads server-side; only Claude-model
  // sessions need an existing claude session id to resume.
  const effectiveModel = model || defaultModel;
  const isCodexModel = modelIsCodex(effectiveModel, models);
  // A opensession session with no engine ids is a *fresh* session (e.g. a new sibling
  // from the tab strip's +): the composer stays enabled — its first prompt
  // starts a new engine conversation server-side (see runSessionPrompt). Only
  // non-opensession sources with no engine to resume stay read-only.
  const noEngine =
    !isCodexModel && !session.ran && session.source !== "opensession";
  const latestAssistantMessage =
    entries
      .findLast((entry) => entry.type === "assistant" && entry.content.trim())
      ?.content.trim() || "";
  const shippedSentValue =
    shippedShare ||
    (mergedPr
      ? session.slackShares?.findLast(
          (share) => share.prNumber === mergedPr.number,
        )
      : undefined);
  // Same reason as mergedPr above: a receipt read off the polled session is a
  // fresh object every tick, and the share below is a transcript prop.
  const sentChannelName = shippedSentValue?.channelName ?? "";
  const sentPermalink = shippedSentValue?.permalink;
  const sentAt = shippedSentValue?.at ?? "";
  const sentTs = shippedSentValue?.ts;
  const shippedSentKey = shippedSentValue
    ? [
        shippedSentValue.channelName,
        shippedSentValue.permalink,
        shippedSentValue.at,
        shippedSentValue.ts,
      ].join("\u0000")
    : "";
  const shippedSent = useMemo(() => {
    if (!shippedSentKey) return undefined;
    return {
      channelName: sentChannelName,
      permalink: sentPermalink,
      at: sentAt,
      ts: sentTs,
    };
  }, [shippedSentKey, sentChannelName, sentPermalink, sentAt, sentTs]);
  const shippedChangeShare = useMemo(
    () =>
      mergedPr && !shareDismissed
        ? {
            prNumber: mergedPr.number!,
            sessionId: session.id,
            defaultMessage: suggestedShippedChangeMessage(
              mergedPr.title || "an update",
              session.walkthrough?.summary,
            ),
            screenshot: shippedScreenshot,
            reconnectRequired: shippedSlackReconnectRequired,
            status: shippedChangeStatus,
            onShare: sendShippedChangeToSlack,
            onReconnectSlack: reconnectShippedSlack,
            onCancel: dismissShippedChangeShare,
            nextMessage: latestAssistantMessage,
            ...(shippedSent
              ? {
                  sent: {
                    channelName: shippedSent.channelName,
                    permalink: shippedSent.permalink,
                    receiptKey: shippedSent.at,
                  },
                  ...(shippedSent.ts
                    ? { onUndo: () => undoShippedChangeShare(shippedSent.at) }
                    : {}),
                }
              : {}),
          }
        : undefined,
    [
      mergedPr,
      shippedSlackReconnectRequired,
      shippedScreenshot,
      session.id,
      session.walkthrough?.summary,
      sendShippedChangeToSlack,
      reconnectShippedSlack,
      undoShippedChangeShare,
      dismissShippedChangeShare,
      shareDismissed,
      shippedChangeStatus,
      shippedSent,
      latestAssistantMessage,
    ],
  );
  const sendComposedSlackMessage = useCallback(
    async (message: string, channel: string, screenshots: string[]) => {
      await sendComposedSlackMessageAction({
        sessionId: session.id,
        composer: slackComposer,
        input: { message, channel, screenshots },
        setters: {
          setComposer: setSlackComposer,
          setStatus: setSlackComposerStatus,
          setReconnect: setSlackComposerReconnect,
          setSent: setSlackComposerSent,
        },
        toast,
      });
    },
    [session.id, slackComposer],
  );
  // Slack accepts a delete only from the account that posted, which is the
  // person's own grant token, so an undo here can never touch someone else's
  // message.
  const undoComposedSlackMessage = useCallback(
    async (sent: SlackSent) => {
      await undoComposedSlackMessageAction({
        sessionId: session.id,
        sent,
        setSent: setSlackComposerSent,
        toast,
      });
    },
    [session.id],
  );
  const cancelComposedSlackMessage = useCallback(async () => {
    await cancelComposedSlackMessageAction({
      sessionId: session.id,
      composer: slackComposer,
      setComposer: setSlackComposer,
      toast,
    });
  }, [session.id, slackComposer]);
  async function reconnectComposedSlack() {
    await reconnectShippedSlackAction({
      setReconnectRequired: setSlackComposerReconnect,
      toast,
    });
  }
  // Exact engine-state forks use Claude's SDK forkSession. Other backends can
  // still fork as a new sibling with a transcript handoff.
  const canForkSession = session.source === "opensession" && !!session.ran;

  const handleFork = useCallback(
    (messageId?: string) => {
      if (!messageId) {
        void navigation.duplicateSession();
        return;
      }
      composerSettersRef.current.setForkFrom({
        kind: "message",
        messageId,
      });
    },
    [navigation],
  );

  // "Continue" under a failed run's notice. An ordinary prompt, so it steers,
  // notices and broadcasts like anything else a person sends — the failure
  // notice tells you to send the prompt again, and this is that press.
  const continueAfterFailure = useCallback(() => {
    send({
      type: "prompt",
      sessionId: session.id,
      content: CONTINUE_AFTER_FAILURE_PROMPT,
      user: getCurrentUser(),
    });
  }, [send, session.id]);

  const continuePausedSession = useCallback(() => {
    const lastMessageId = entries.findLast(
      (entry) => entry.type === "assistant" || entry.type === "user",
    )?.id;
    const carriedImages = queued.flatMap((item) => item.images || []);
    send({
      type: "create_session",
      branch: "",
      prompt: safetyContinuationPrompt(session.title, queued),
      user: getCurrentUser(),
      forkFrom: {
        sourceId: session.id,
        ...(lastMessageId ? { messageId: lastMessageId } : {}),
      },
      ...(carriedImages.length ? { images: carriedImages } : {}),
    });
  }, [entries, queued, send, session.id, session.title]);

  const repairSafetyPause = useCallback(async () => {
    await repairPausedSession(session.id);
    dispatchSessionRuntime({ type: "repair_safety" });
    onRunningChange?.(session.id, false);
    toast("Session repaired");
  }, [dispatchSessionRuntime, onRunningChange, session.id]);

  // Session and asset links navigate on a delegated click. markdown.ts renders
  // them into dangerouslySetInnerHTML, where they cannot carry React handlers;
  // data attributes identify which in-app surface should open.
  const handleMessagesClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      const assetEl = target.closest?.(
        "[data-asset-path]",
      ) as HTMLElement | null;
      const assetPath = assetEl?.dataset.assetPath;
      if (assetPath) {
        // Modified clicks keep the anchor's raw-file fallback and native new-tab
        // behaviour. A normal click stays in context, in the asset preview.
        if (
          (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) &&
          assetEl?.getAttribute("href")
        )
          return;
        e.preventDefault();
        openAssetFromTranscript(assetPath);
        return;
      }
      const el = target.closest?.("[data-session-id]") as HTMLElement | null;
      const id = el?.dataset.sessionId;
      if (!id || !openSession) return;
      // Modified clicks on href-carrying chips (markdown links to session
      // URLs) keep native browser behavior (open in new tab, etc.).
      if ((e.metaKey || e.ctrlKey || e.shiftKey) && el?.getAttribute("href"))
        return;
      e.preventDefault();
      openSession(id);
    },
    [openSession, openAssetFromTranscript],
  );

  // The transcript passage explicitly attached to the next message. It stays
  // highlighted until the message sends or the person removes it.
  const [quote, setQuote] = useState<Quote | null>(null);
  const clearQuote = useCallback(() => setQuote(null), []);
  // Whether a draft is in the way of reopening a message in the composer, read
  // through a ref. Every value it reads changes as you type or attach, and
  // the transcript's onEditMessage has to keep one identity across all of
  // that: the memoized TranscriptBlocks is what stands between a keystroke
  // and a re-render of the whole conversation.
  const composerDraftRef = useRef({
    draftKey,
    images,
    files,
    quote,
    contextSessions,
  });
  useLayoutEffect(() => {
    composerDraftRef.current = {
      draftKey,
      images,
      files,
      quote,
      contextSessions,
    };
  }, [draftKey, images, files, quote, contextSessions]);
  const composerHasDraft = useCallback(() => {
    const current = composerDraftRef.current;
    const stored = loadDraft(current.draftKey);
    return Boolean(
      stored.text.trim() ||
      stored.pastedTexts.length ||
      current.images.length ||
      current.files.length ||
      current.quote ||
      current.contextSessions.length,
    );
  }, []);
  // Switching sessions drops staged selections: they quote THAT transcript.
  useEffect(() => {
    setQuote(null);
  }, [session.id]);
  // Full-width view tabs unmount the transcript and its visible highlight. Do
  // not leave that context invisibly attached when the conversation returns.
  useEffect(() => {
    if (sessionHidden) setQuote(null);
  }, [sessionHidden]);
  const [showAllContextSessions, setShowAllContextSessions] = useState(false);
  const contextSessionOptions = useMemo(() => {
    // Whole workspace, archived sessions included — the common case is exactly a
    // closed (archived-after-merge) sibling whose context the new session needs.
    // workspaceSessions (the live tab strip) is the fallback when the session has no
    // workspace id of its own.
    const siblings = session.workspaceId
      ? (allSessions || []).filter((c) => c.workspaceId === session.workspaceId)
      : workspaceSessions || [];
    return siblings
      .filter(
        (c) =>
          c.id !== session.id &&
          // Legacy hidden sessions are not valid workspace context options.
          // Only sessions with something to hand over — a session that has
          // actually run a turn. These are LIST rows, so `ran` is the only
          // form of that answer they carry.
          c.ran,
      )
      .sort((a, b) =>
        (b.lastActivity || "").localeCompare(a.lastActivity || ""),
      );
  }, [allSessions, workspaceSessions, session.id, session.workspaceId]);
  useEffect(() => {
    setContextSessions([]);
    setShowAllContextSessions(false);
  }, [session.id]);

  // Whose Desk this is. Every Desk is titled "Desk" and carries no repo, so
  // the owner is the only thing that tells one apart from another — see the
  // mobile title pill's leading slot.
  const deskOwner = session.desk ? session.startedBy || "" : "";
  // The review request is stored per session, but the sidebar's "Awaiting/Needs
  // review" bands group by workspace — so a request set on a sibling session lit
  // the band while the open session's Reviewer chip read empty. Surface the
  // workspace's request in the chip: the open session's own if it has one, else a
  // sibling's, carrying the owner id so clear/re-assign target the right session.
  // GitHub reviews can complete an explicit request; GitHub's own requested
  // reviewers ride alongside as `prReviewRequested`, since being added as a
  // reviewer on the PR is the other way a review lands on you. It writes no
  // Open Session request — only the picker does that — so the chip reads both.
  const effectiveReview = (() => {
    const owner = session.reviewRequest
      ? session
      : (workspaceSessions || []).find((c) => c.reviewRequest);
    const request = owner?.reviewRequest ?? null;
    const completion =
      owner && request ? prReviewCompletion(request, owner) : null;
    return {
      req: request
        ? completion
          ? { ...request, accepted: completion }
          : request
        : null,
      ownerId: owner?.id ?? session.id,
      acceptedFromPr: !!completion,
      // A workspace can span several PRs; a request on any of them is a
      // request on the workspace, which is the unit the chip speaks for.
      prReviewRequested: [
        ...new Set(
          (workspaceSessions?.length ? workspaceSessions : [session]).flatMap(
            (c) => c.prReviewRequested || [],
          ),
        ),
      ],
    };
  })();

  // Returns true when the message was consumed, so the (uncontrolled)
  // Composer knows to clear its draft; false keeps it for a retry.
  function handleSend(
    raw: string,
    opts?: { steer?: boolean },
    /** A region comment is already a complete message. Its derived crop must
     *  not consume or inherit anything waiting in the main composer. */
    isolatedImages?: string[],
  ): boolean | Promise<boolean> {
    return sendSessionMessage(raw, opts, isolatedImages, {
      identity: { session, noEngine, noteMode },
      draft: {
        draftKey,
        images,
        setImages,
        files,
        setFiles,
        quote,
        setQuote,
        contextSessions,
        setContextSessions,
        forkFrom,
        setForkFrom,
      },
      runtime: {
        isBusy,
        effort,
        fastMode,
        pendingRef,
        setPending,
        dispatch: dispatchSessionRuntime,
        onRunningChange,
      },
      transcript: {
        viewStore: transcriptViewStore,
        sequenceRef: transcriptSeqRef,
        tailActionNeedsLayoutScrollRef,
        cancelIndexAnchorHold,
        scrollToLatest,
      },
      send,
    });
  }

  useImageRegionComposer({
    sessionId: session.id,
    noEngine,
    handleSend,
  });

  function discardOutbox(item: PromptOutboxItem) {
    discardSessionOutboxItem(item, setPending);
  }

  function editOutboxInComposer(item: PromptOutboxItem) {
    setImages(item.images ?? []);
    setFiles((item.files ?? []) as FileAttachment[]);
    setContextSessions(item.contextSessions ?? []);
    if (item.effort) setEffort(item.effort);
    if (typeof item.fastMode === "boolean") setFastMode(item.fastMode);
    setComposerPrefill((current) => ({
      seq: (current?.seq ?? 0) + 1,
      text: item.content,
    }));
    discardOutbox(item);
  }

  function editQueuedInComposer(q: QueueReceipt, steering = false) {
    takeSessionQueueItem(q, steering, {
      sessionId: session.id,
      composerHasDraft,
      dispatch: dispatchSessionRuntime,
      send,
    });
  }

  // Stable identity: this is a prop of the memoized transcript, so a fresh
  // function each render would re-render every bubble on every poll tick.
  const editSentMessageInComposer = useCallback(
    (entry: TranscriptEntry) => {
      if (composerHasDraft()) {
        toast("Send or clear your draft before editing a message");
        return;
      }
      composerSettersRef.current.setImages(entry.images ?? []);
      composerSettersRef.current.setFiles(
        (entry.files ?? []).map((file) => ({
          ...file,
          type: "application/octet-stream",
        })),
      );
      setComposerPrefillRef.current((current) => ({
        seq: (current?.seq ?? 0) + 1,
        text: entry.content,
        replace: true,
      }));
    },
    [composerHasDraft],
  );

  function handleQueueReorder(next: QueueReceipt[]) {
    reorderSessionQueue(next, pendingReorderRef, dispatchSessionRuntime);
  }

  function commitQueueReorder() {
    commitSessionQueueReorder(
      session.id,
      draggingQueueRef,
      pendingReorderRef,
      send,
    );
  }

  const {
    pendingQueue,
    pendingBubbles,
    optimisticTranscriptEntries,
    pendingTranscriptDeliveryIds,
    durableOutbox,
    shownQueued,
    queuedClassified,
    queueCount,
    queueTitle,
  } = deriveSessionQueue({
    queued,
    steered,
    pending,
    pendingDeliveryIds,
    outboxItems,
    landedOutboxIds,
    entries,
    settingUpWorkspace,
    now: Date.now(),
  });
  const hasLiveConversation =
    pendingBubbles.length > 0 || liveTurnStore.hasText() || isBusy || !!ask;
  // Fall back to the durable session error if its best-effort transcript notice
  // could not be written during startup.
  const inlineRunFailure =
    !safety &&
    !isBusy &&
    session.lastRunError &&
    !entries.some(
      (entry) =>
        entry.type === "system" &&
        entry.content.includes(session.lastRunError!.message),
    )
      ? session.lastRunError
      : null;
  const attachedQueue = queueCount ? (
    <SessionQueue
      currentUser={currentUser}
      queueTitle={queueTitle}
      shownQueued={shownQueued}
      queuedClassified={queuedClassified}
      pendingQueue={pendingQueue}
      durableOutbox={durableOutbox}
      settingUpWorkspace={settingUpWorkspace}
      onReorder={handleQueueReorder}
      onReorderStart={() => {
        draggingQueueRef.current = true;
      }}
      onReorderEnd={commitQueueReorder}
      onEditQueued={editQueuedInComposer}
      onDeleteQueued={(queueId, queueIndex) =>
        send({
          type: "delete_queued_prompt",
          sessionId: session.id,
          queueId,
          queueIndex,
        })
      }
      onSteerQueued={(queueId, queueIndex) =>
        send({
          type: "steer_queued_prompt",
          sessionId: session.id,
          queueId,
          queueIndex,
        })
      }
      onRetryOutbox={(clientId) => promptOutbox.retry(clientId)}
      onEditOutbox={editOutboxInComposer}
      onDiscardOutbox={discardOutbox}
    />
  ) : null;

  function handleCancel() {
    // Local acknowledgement first: the gesture must land visibly whether or
    // not the engine can drop what it is doing this instant.
    setStopRequestedAt((prev) => prev ?? Date.now());
    send({ type: "cancel", sessionId: session.id });
  }

  function handleShareWorkspace() {
    shareSessionAction({
      context: {
        session,
        workspaceName,
        workspaceScoped: Boolean(session.workspaceId),
      },
      pane: {
        showReview,
        showConversation,
        showVideo,
        subagentIds: [],
      },
      shareLink,
    });
  }

  function handleShare() {
    shareSessionAction({
      context: { session, workspaceName, workspaceScoped: false },
      pane: {
        showReview,
        showConversation,
        showVideo,
        subagentIds: subagentOpen
          ? subagentStack.map((subagent) => subagent.agentId)
          : [],
      },
      shareLink,
    });
  }

  async function handleOpenSlackComposer() {
    await openSlackComposerAction({
      sessionId: session.id,
      latestAssistantMessage,
      setters: {
        setComposer: setSlackComposer,
        setStatus: setSlackComposerStatus,
        setReconnect: setSlackComposerReconnect,
        setSent: setSlackComposerSent,
      },
      closeOverflow: () => setOverflowOpen(false),
      scrollToLatest,
      toast,
    });
  }

  function commitRename() {
    if (renameDraft !== null) {
      // When the header titles the workspace, renaming edits the workspace —
      // every sibling session picks the new name up. Session titles live on tabs.
      // A worker's header titles the WORKER (the workspace is the crumb before
      // it), so the same edit there renames just this session.
      if (session.workspaceId && onRenameWorkspace)
        onRenameWorkspace(renameDraft.trim());
      else onRename?.(session.id, renameDraft.trim());
    }
    setRenameDraft(null);
  }

  // Drop an in-progress rename when switching sessions so the draft never bleeds
  // into the next session's header.
  useEffect(() => setRenameDraft(null), [session.id]);

  function handleModelChange(next: string) {
    const target = next || defaultModel;
    if (!target || target === (model || defaultModel)) return;
    dispatchSessionRuntime({ type: "select_model", model: next });
    // Routed through the /model slash command so it persists, notices, and
    // broadcasts to other viewers.
    send({
      type: "prompt",
      sessionId: session.id,
      content: `/model ${target}`,
      user: getCurrentUser(),
    });
  }

  // Pin (or clear, "" = auto) the current provider account for this session.
  // Same shape as the model switch: /account persists, notices,
  // and broadcasts subscription_changed to every viewer.
  function handleAccountChange(next: string) {
    if (next === (accountId || "")) return;
    setAccountId(next);
    const target = next
      ? accounts.find((account) => account.id === next)
      : null;
    if (target?.kind === "api_key") setFastMode(false);
    send({
      type: "prompt",
      sessionId: session.id,
      // The name reads better in the transcript; the command matches by
      // id first, then case-insensitive name, so either form works.
      content: next ? `/account ${target?.id || next}` : "/account auto",
      user: getCurrentUser(),
    });
  }

  // Pin or clear the session goal from the composer's Goal button. Routed
  // through the /goal slash command (handled backstage-side, not a real turn);
  // optimistically reflected via goalOverride until the session file catches up.
  function handleSetGoal(goal: string | null) {
    setGoalOverride(goal);
    send({
      type: "prompt",
      sessionId: session.id,
      content: goal ? `/goal ${goal}` : "/goal clear",
      user: getCurrentUser(),
    });
  }

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const [deleting, setDeleting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleteLabel, setDeleteLabel] = useState("");

  const headerLayout = useSessionHeaderLayout({
    topbarEl,
    workspaceSummaryOpen,
  });
  const {
    headerRef,
    headerActionsRef,
    reviewSessionActionTarget,
    setReviewSessionActionTarget,
    desktopChangesRef,
  } = headerLayout.elements;
  const { headerW, compactHeader } = headerLayout.width;
  const { summaryOpen, setSummaryOpen } = headerLayout.summary;
  const { isPhone } = headerLayout.viewport;
  useEffect(() => {
    if (!activePanelOpen) {
      setPanelTerminalMounted(false);
    } else if (!isPhone && desktopPanelPage === "terminal") {
      // A newly mounted session inherits the selected tab and starts its own
      // terminal, just as selecting Terminal in-place would.
      setPanelTerminalMounted(true);
    }
  }, [activePanelOpen, desktopPanelPage, isPhone]);
  // Whether the pane can hold the card beside the reading column instead of
  // over it. Unmeasured counts as room: the width lands in a layout effect
  // before the first paint, and assuming the common case keeps a pinned card
  // from blinking on wide panes. Below the threshold the card hides itself and
  // the header takes back the strip it had stood down for.
  const summaryHasRoom = headerW === 0 || headerW >= WS_SUMMARY_ROOM_W;
  const summaryVisible =
    summaryOpen &&
    summaryHasRoom &&
    !activePanelOpen &&
    !isPhone &&
    hasRepoWork;
  // Keep a visible left step whenever the card is up. This composes the card,
  // transcript and composer as two sides of one pane instead of letting the
  // reading column drift back to centre as the window grows.
  const summaryStep = summaryVisible ? workspaceSummaryShift(headerW) : 0;
  const summaryStepStyle =
    summaryStep > 0
      ? ({ "--ws-summary-step": `-${summaryStep}px` } as React.CSSProperties)
      : undefined;
  // Phone drill-ins return to Workspace details when their page closes. The
  // desktop panel deliberately keeps its selected tab while it is closed.
  useEffect(() => {
    if (isPhone && !infoPageOpen) setPanelPage(null);
  }, [isPhone, infoPageOpen]);
  const focusComposerForQuote = useCallback(() => {
    const composer = composerRef.current;
    composer?.focus({ preventScroll: true });
    return composer;
  }, []);

  // Run-status flap above the composer (ComposerAgents): the tappable
  // pill → mini-card → full-panel progression, reusing the queue flap's
  // tuck-under styling. It carries two things at different breakpoints.
  //
  // Agents — phone-only. On desktop the Agents panel tab (with its pulsing
  // dot) is always visible; on a phone the right panel overlays the session and
  // is closed by default, so a running workflow fan-out has no glance.
  const runningWorkflowRuns = workflowRuns.filter(
    (r) => r.status === "running" || r.status === "paused",
  );
  // Sub-agents ride along only while one is live, so a finished batch doesn't
  // pad a later workflow's tallies (their statuses clamp to done once the
  // session's run ends, so the flap can't stick around stale either).
  const anySubagentRunning = subagents.some((s) => s.status === "running");
  const showAgents =
    isPhone && (runningWorkflowRuns.length > 0 || anySubagentRunning);
  // Plan — every width, since the model's todowrite checklist has no other
  // home at any size (in the transcript it's one dim row inside a turn fold
  // that's collapsed by default).
  const livePlan = useLivePlan(entries, isBusy);
  const agentBubble =
    showAgents || livePlan.length > 0 ? (
      <ComposerAgents
        runs={showAgents ? runningWorkflowRuns : NO_WORKFLOW_RUNS}
        subagents={showAgents && anySubagentRunning ? subagents : undefined}
        plan={livePlan}
        // The Agents list is a section of the workspace panel now, so this
        // just opens it — the phone's info page on a phone, the side panel
        // on desktop (this flap rides the composer at every width).
        onOpenPanel={() => {
          if (isPhone) setInfoPageOpen(true);
          else setPanelOpen(true);
        }}
      />
    ) : null;
  // The composer takes a single `attached` node; stack the agents flap above
  // the queue flap when both are live.
  const attachedComposer =
    agentBubble || attachedQueue ? (
      <>
        {agentBubble}
        {attachedQueue}
      </>
    ) : null;

  // Opened by picking this session's workspace in the sidebar: focus the
  // composer so you can start typing immediately. Runs on mount (a new session
  // remounts this component) and when the pulse re-fires for the already-open
  // session. Skipped on phones so we don't shove the keyboard over the session.
  useEffect(() => {
    if (autoFocusComposer && !isPhone) composerRef.current?.focus();
  }, [autoFocusComposer, isPhone]);

  useEffect(() => {
    if (!composerPrefillExternal) return;
    setComposerPrefillRef.current(composerPrefillExternal);
    onComposerPrefillConsumed?.(composerPrefillExternal.seq);
    if (!isPhone) composerRef.current?.focus();
  }, [composerPrefillExternal, onComposerPrefillConsumed, isPhone]);

  const [overflowOpen, setOverflowOpen] = useState(false);
  const primaryPrNumber = prPresentation.primary?.number;
  const overflowState = useSessionOverflowState({
    sessionId: session.id,
    repo: session.repo || undefined,
    branch: session.branch,
    hasRepoWork,
    primaryPrNumber,
  });
  const { mobileActionMenuEl, setMobileActionMenuEl } = overflowState.menu;
  const { overflowGit } = overflowState.git;
  const {
    branchActionBusy,
    setBranchActionBusy,
    branchConfirmOpen,
    setBranchConfirmOpen,
    branchConfirmMode,
    setBranchConfirmMode,
  } = overflowState.branch;

  async function moveToBranchFromMenu() {
    await moveSessionToBranchAction({
      sessionId: session.id,
      isBusy,
      state: {
        busy: branchActionBusy,
        setBusy: setBranchActionBusy,
        closeOverflow: () => setOverflowOpen(false),
        closeConfirm: () => setBranchConfirmOpen(false),
      },
      toast,
    });
  }

  function requestCreatePr() {
    if (!connected) return;
    send({
      type: "prompt",
      sessionId: session.id,
      user: getCurrentUser(),
      content:
        "Commit any remaining work, push the branch, and open a PR for it.",
    });
  }

  function createPrFromMenu() {
    setOverflowOpen(false);
    requestCreatePr();
  }

  async function moveAndCreatePr() {
    await moveAndCreatePrAction({
      sessionId: session.id,
      connected,
      isBusy,
      state: {
        busy: branchActionBusy,
        setBusy: setBranchActionBusy,
        closeOverflow: () => setOverflowOpen(false),
        closeConfirm: () => setBranchConfirmOpen(false),
      },
      requestCreatePr,
      toast,
    });
  }
  // Left-edge swipe on phones pops the topmost overlay before the page stack:
  // the info page registers as a higher-priority back-swipe layer, so the
  // gesture closes it instead of popping the whole session back to the
  // sidebar (App's layer, priority 0).
  const infoPageRef = useRef<HTMLDivElement | null>(null);
  const infoHeroNameRef = useRef<HTMLHeadingElement | null>(null);
  useBackSwipe({
    active: isPhone && infoPageOpen,
    onBack: () => setInfoPageOpen(false),
    paneRef: infoPageRef,
    priority: 2,
  });
  useEffect(() => {
    if (!infoPageOpen || panelPage !== null) {
      setInfoPageScrolled(false);
      return;
    }
    const root = infoPageRef.current;
    const title = infoHeroNameRef.current;
    if (!root || !title) return;
    const topbar = root.querySelector<HTMLElement>(".session-info-topbar");
    const topInset = Math.ceil(topbar?.getBoundingClientRect().height || 52);
    const observer = new IntersectionObserver(
      ([entry]) => setInfoPageScrolled(!entry.isIntersecting),
      {
        root,
        rootMargin: `-${topInset}px 0px 0px`,
        threshold: 0,
      },
    );
    observer.observe(title);
    return () => observer.disconnect();
  }, [infoPageOpen, isPhone, panelPage]);
  useEffect(() => {
    if (!infoPageOpen) return;
    const app = document.querySelector<HTMLElement>(".app");
    app?.setAttribute("inert", "");
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setInfoPageOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      app?.removeAttribute("inert");
    };
  }, [infoPageOpen]);
  // The mobile top-bar title (rendered by App, outside this component) opens the
  // same settings menu — it toggles via a window event so it doesn't need a prop
  // thread through App's render.
  useEffect(() => {
    const toggle = () =>
      setInfoPageOpen((open) => {
        if (!open) {
          setInfoPageScrolled(false);
        }
        return !open;
      });
    window.addEventListener("opensession:toggle-session-settings", toggle);
    return () =>
      window.removeEventListener("opensession:toggle-session-settings", toggle);
  }, [session.id]);
  // The menu's contents change across the breakpoint — don't leave it stuck open.
  useEffect(() => {
    setOverflowOpen(false);
    setInfoPageOpen(false);
  }, [compactHeader]);

  const me = getCurrentUser();
  // The pile is about the people you can't see, so your own sockets come out
  // first (lib/presence.ts documents why, and is tested).
  const others = otherViewers(viewers, me);

  // Media queued for the current turn has not reached the workspace overview
  // yet, so carry it into the phone summary directly.
  const liveOverviewMedia = useMemo<WorkspaceMediaItem[]>(() => {
    const fromImages = (
      items: Array<{ images?: string[]; sentAt?: number }>,
    ): WorkspaceMediaItem[] =>
      items.flatMap((item) =>
        (item.images || []).map((src, i) => ({
          kind: "image" as const,
          src,
          sessionId: session.id,
          sessionTitle: session.title,
          at: new Date((item.sentAt || Date.now()) + i).toISOString(),
        })),
      );
    return [...fromImages(pending), ...fromImages(queued)];
  }, [pending, queued, session.id, session.title]);

  async function handleDelete(cleanWorktree: boolean) {
    await deleteSessionAction({
      sessionId: session.id,
      cleanWorktree,
      setLabel: setDeleteLabel,
      setDeleting,
      setConfirmOpen: setShowDeleteConfirm,
      goBack,
    });
  }

  const handleArchive = useCallback(async () => {
    await archiveSessionAction({
      sessionId: session.id,
      archived: session.archived,
      callbacks: { onArchive, onArchived, goBack },
      setters: { setArchiving, setOverflowOpen },
    });
  }, [
    onArchive,
    onArchived,
    goBack,
    session.archived,
    session.id,
    setArchiving,
    setOverflowOpen,
  ]);

  useSessionArchiveShortcut({
    identity: { focused, archiving, archived: session.archived },
    actions: { archive: handleArchive, openNextChat },
  });

  // The Assets pane is a top-strip view-tab too (App owns whether it's
  // foregrounded). If the last asset is deleted while its tab is up, close it
  // rather than leave an empty pane pointing at nothing.
  useEffect(() => {
    if (showAssets && assetFiles.length === 0) onCloseAssets?.();
  }, [showAssets, assetFiles.length, onCloseAssets]);

  useSessionPreviewStatusEffect(previewController, {
    showPreviewTab,
    showPortal,
    activePanelOpen,
    infoPageOpen,
    sessionId: session.id,
    worktreeDir: session.worktreeDir,
  });

  /* Quick replies for the turn that just ended. Off while a run is live (they
	   answer a finished turn), while an ask card is up (that card already offers
	   the choices, in the agent's own wording), and while forking (the point
	   there is a new direction, not a follow-up).

	   The row floats on the transcript rather than sitting between it and the
	   composer, so it is also what the transcript pads for and what the
	   scroll-to-bottom pill has to clear. One flag, read in three places. */
  const quickReplies =
    showReplySuggestions &&
    !isBusy &&
    !ask &&
    !forkFrom &&
    replySuggestions.length > 0;

  /* Desktop shows reading controls between quick replies and Next. Phone keeps
	   its existing standalone reading control and centered session toolbar. */
  const nextAction = showNextChatButton && !!openNextChat;
  const scrollAction = showScrollToBottom && entries.length > 0;
  const actionBand = quickReplies || nextAction || scrollAction || isPhone;
  const actionClearance = !actionBand
    ? undefined
    : nextAction || isPhone
      ? isPhone && quickReplies
        ? ACTION_WITH_REPLIES_CLEARANCE
        : ACTION_CLEARANCE
      : scrollAction
        ? SCROLL_ACTION_CLEARANCE
        : SUGGESTIONS_CLEARANCE;
  // This class changes the scroller's bottom padding. Session metadata can make
  // Next appear after a cached transcript has already settled; re-pin before
  // that larger scroll height paints, but never move a reader in history.
  useLayoutEffect(() => {
    if (readFollowingLive(followingLive)) scrollToLatest("auto");
  }, [actionClearance, followingLive, scrollToLatest]);

  const pickReplySuggestion = (text: string) => {
    setComposerPrefill((current) => ({
      seq: (current?.seq ?? 0) + 1,
      text,
      replace: false,
    }));
    setReplySuggestions(EMPTY_SUGGESTIONS);
    if (!isPhone) composerRef.current?.focus();
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <SessionViewerDialogs
        confirmDialog={confirmDialog}
        deletion={{
          open: showDeleteConfirm,
          deleting,
          label: deleteLabel,
          hasWorktree: Boolean(session.worktreeDir && !isAsk),
        }}
        deletionActions={{
          onOpenChange: setShowDeleteConfirm,
          onDelete: (cleanWorktree) => void handleDelete(cleanWorktree),
        }}
        branch={{
          open: branchConfirmOpen,
          busy: branchActionBusy,
          mode: branchConfirmMode,
          sessionBusy: isBusy,
          connected,
        }}
        branchActions={{
          onOpenChange: setBranchConfirmOpen,
          onMove: moveToBranchFromMenu,
          onMoveAndCreatePr: moveAndCreatePr,
        }}
      />
      <SessionViewerChrome
        identity={{
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
        }}
        layout={{
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
        }}
        menuState={{
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
        }}
        sessionActions={{
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
        }}
        workspaceActions={{
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
        }}
        model={{
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
        }}
        infoState={{
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
        }}
        infoActions={{
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
        }}
        conversation={{ others, entries }}
      />

      <SessionViewerBanners goal={session.goal} loop={session.loop} />

      <div className="flex min-h-0 flex-1">
        <SessionViewerMainRegion
          session={session}
          surfaces={{
            showPortal,
            portalTarget,
            showPreviewTab,
            onClosePreviewTab,
            showStaging,
            staging,
            stagingUrl,
            shareLink,
            showAssets,
            showTerminal,
            showReview,
            showConversation,
            showVideo,
            subagentOpen,
            conversationThreadId,
          }}
          panes={{
            assetFiles,
            refreshAssets,
            selectedAssetPath,
            setSelectedAssetPath,
            navigation,
            videoPanel,
            videoTitle,
            subagentStack,
            openSubagent,
            onSubagentBack,
            nameSubagent,
            hasWorkspace,
            waitingForWorkspace,
            terminalTabOpen,
            previewStatus,
          }}
          review={{
            openPr,
            allSessions,
            workspaceSessions,
            openSession,
            reviewSessionActionTarget,
            connected,
            isBusy,
            noEngine,
            openCurrentWorkspace,
            setComposerPrefill,
            panelReviewRepos,
            discoveredPrs,
            reviewFocus,
            reviewPage,
            setReviewPage,
          }}
          transcript={{
            state: {
              loading,
              entries,
              hasLiveConversation,
              inlineRunFailure,
              openSettlePending,
              optimisticTranscriptEntries,
              pendingTranscriptDeliveryIds,
              transcriptIndex,
              transcriptRangeRetryGeneration,
              isBusy,
              shouldMaintainEnd,
              reviewResult,
              sessionWalkthrough,
              notes,
              safety,
            },
            content: {
              assetPaths,
              toolPathRoots,
              liveSubagents,
              liveTurnStore,
              sentMessages,
              shippedChangeShare,
              ask,
              busySince,
              stopRequestedAt,
              settingUpWorkspace,
              transcriptIndexExpected,
              historyTruncated,
              atTop,
              loadingHistory,
              loadingAllHistory,
            },
            actions: {
              openAssetFromTranscript,
              onTranscriptRender,
              loadTranscriptRanges,
              onVisibleRangesSettled,
              relayout,
              editSentMessageInComposer,
              continueAfterFailure,
              continuePausedSession,
              repairSafetyPause,
              handleFork,
              handleMessagesScroll,
              handleMessagesClick,
              cancelIndexAnchorHold,
              scrollToLatest,
              loadAllHistory,
            },
            interaction: {
              messagesRef,
              setMessagesRef,
              spacerRef,
              tailActionNeedsLayoutScrollRef,
              fileDragActive,
              canForkSession,
              typingUsers,
              setQuote,
              focusComposerForQuote,
            },
          }}
          slack={{
            slackComposer,
            slackComposerStatus,
            slackComposerReconnect,
            sendComposedSlackMessage,
            reconnectComposedSlack,
            cancelComposedSlackMessage,
            slackComposerSent,
            handleOpenSlackComposer,
            undoComposedSlackMessage,
          }}
          emptyConversation={{
            workspaceName,
            contextSessionOptions,
            contextSessions,
            setContextSessions,
            showAllContextSessions,
            setShowAllContextSessions,
          }}
          actionBand={{
            actionBand,
            quickReplies,
            nextAction,
            scrollAction,
            isPhone,
            replySuggestions,
            pickReplySuggestion,
            transcriptDownKeys,
            nextChatKeys,
            openNextChat,
            archiving,
            handleArchive,
            setMobileActionMenuEl,
            openNewWorkspace,
            showNextChatButton,
          }}
          composer={{
            state: {
              forkFrom,
              composerResetSeq,
              draftKey,
              images,
              files,
              uploadStaging,
              focused,
              quote,
              promoting,
              isAsk,
            },
            configuration: {
              stopRequestedAt,
              stopRequest,
              composerPrefill,
              models,
              defaultModel,
              model,
              effort,
              fastMode,
              accounts,
              accountId,
              currentGoal,
              usage,
              composerRef,
              noteMode,
              attachedComposer,
            },
            actions: {
              setTyping,
              setForkFrom,
              handleSend,
              setImages,
              setFiles,
              addSessionAttachments,
              cancelPendingImage: uploads.cancelPendingImage,
              cancelPendingFile: uploads.cancelPendingFile,
              clearQuote,
              handlePromote,
              setNoteMode,
              handleCancel,
              handleModelChange,
              setEffort,
              setFastMode,
            },
            moreActions: {
              handleAccountChange,
              handleSetGoal,
            },
          }}
          layout={{
            actionClearance,
            summaryStep,
            summaryStepStyle,
            summaryVisible,
            tabStripVisible,
            setViewerInput,
            leaveLatest,
          }}
          send={send}
          canRepairSafety={canRepairSafety}
        />

        {/* Right region: the Workspace panel. Portaled to an app-level slot so
            it opens as a full-height column beside the left sidebar (not just
            below the session header). */}
        <SessionViewerSidePanel
          shell={{
            hidden: hideRightPanel,
            isPhone,
            available: panelAvailable,
            open: activePanelOpen,
            onOpenChange: setActivePanelOpen,
            portalTarget: rightPanelEl,
            style: panelStyle,
            resizeHandle: panelResizeHandle,
            hasWorkspace,
            page: desktopPanelPage,
            onPageChange: setDesktopPanelPage,
            livePortals,
            runningAgents,
            terminalMounted: panelTerminalMounted,
            onTerminalMount: () => setPanelTerminalMounted(true),
          }}
          summary={{
            session,
            onOpenPanelTab: (tab) => {
              if (tab === "changes") {
                desktopChangesRef.current?.scrollIntoView({
                  block: "start",
                });
                return;
              }
              focusPrInReview();
            },
            onOpenPr: () => focusPrInReview(),
            onOpenStackPr: openPr,
            onOpenChecks: () => focusPrInReview(undefined, "checks"),
            onOpenAsset: openAssetFromTranscript,
            onOpenAssets: openAssets,
            onOpenSession: openSession,
            onArchive: handleArchive,
            reviewRequest: effectiveReview?.req ?? null,
            reviewRequestSessionId: effectiveReview?.ownerId,
            onReviewChange,
            prReviewRequested: effectiveReview?.prReviewRequested,
            running: isRunningLive,
            workspacePreparing,
          }}
          summaryRuntime={{
            send: connected ? send : undefined,
            refreshTick: gitRefreshTick,
            liveMedia: liveOverviewMedia,
            close: () => setActivePanelOpen(false),
          }}
          changes={{
            waitingForWorkspace,
            sessionId: session.id,
            isRunning: isBusy,
            canSend: connected && !isBusy && !noEngine,
            send,
            diff: diffState,
            source: worktreeDiffSource,
            onSourceChange: changeWorktreeDiffSource,
          }}
          changesContainerRef={desktopChangesRef}
          portals={{
            sessionId: session.id,
            status: previewStatus,
            activePortal: portalTarget,
            onBack: () => setActivePanelOpen(false),
            onOpenPortal: openPortal,
            onStartPortal: startDeclaredPortal,
            onPortalAction: async (name, action) => {
              setPreviewStatus(await portalActionApi(session.id, name, action));
            },
          }}
          agents={{
            sessionId: session.id,
            runs: workflowRuns,
            onAction: workflowAction,
            subagents,
            onOpenSubagent: openSubagent,
            onOpenSession: openSession,
            onBack: () => setActivePanelOpen(false),
          }}
        />
      </div>
      {/* Portals to the body, so it sits over the whole viewer rather than
			    inside whichever column opened it. */}
      <SessionViewerAssetOverlay
        asset={{
          sessionId: session.id,
          path: overlayAssetPath,
          files: assetFiles,
        }}
        actions={{
          refresh: refreshAssets,
          onClose: closeAssetOverlay,
          onSelectPath: setOverlayAssetPath,
          onOpenAsTab: openAssets ? promoteAssetToTab : undefined,
          onOpenNewSession: navigation.openPrefilledSession,
        }}
      />
    </div>
  );
}

// Placeholder for regions that need the session's worktree while the create
// run is still preparing it (new-workspace creates announce the session before
// the slow git work — see create_session in opensession.ts).
