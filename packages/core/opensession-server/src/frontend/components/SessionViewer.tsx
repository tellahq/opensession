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
import { useConnectionPresentation } from "../hooks/useConnectionPresentation";
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
import { useSessionReviewController } from "../hooks/useSessionReviewController";
import {
  useSessionHeaderLayoutController,
  useSessionViewStateController,
} from "../hooks/useSessionViewStateController";
import { useSessionWorkspaceToolsController } from "../hooks/useSessionWorkspaceToolsController";
import { useSessionChromeController } from "../hooks/useSessionChromeController";
import {
  sessionConversationAvailability,
  useSessionConversationActions,
  useSessionDraftContext,
  useSessionHeaderActions,
  useSessionSendController,
  useShippedChangePresentation,
} from "../hooks/useSessionConversationState";
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
  SESSION_BANNERS,
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
  const presentedConnected = useConnectionPresentation(connected);
  const reviewController = useSessionReviewController({
    session,
    navigation,
    focused,
    reviewFocusPr,
    availability: {
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
    visibility: {
      showReview,
      showStaging,
      showAssets,
      showTerminal,
      showPreviewTab,
      showPortal,
      hasPortalTarget: !!portalTarget,
      showSubagent,
      hasSubagent: subagentStack.length > 0,
      showConversation,
      hasConversation: !!conversationThreadId,
      showVideo,
      hasVideo: !!videoPanel,
    },
  });
  const { goBack, openNextChat } = reviewController.navigation;
  const { openNewSession, openNewWorkspace } = reviewController.navigation;
  const { openSession, openReview, openAssets } = reviewController.navigation;
  const { openPr, openPortal, openCurrentWorkspace } =
    reviewController.navigation;
  const { reviewRepos, prPresentation } = reviewController.review;
  const { worktreeDiffSource, changeWorktreeDiffSource } =
    reviewController.review;
  const { mergedPr, promotedPr, phonePr, discoveredPrs } =
    reviewController.review;
  const { reviewFocus, reviewPage, setReviewPage } = reviewController.review;
  const { focusPrInReview, toolPathRoots, panelReviewRepos } =
    reviewController.review;
  const { shippedChangeStatus, shippedSlackReconnectRequired } =
    reviewController.shipped;
  const { shippedShare, walkthroughScreenshot, shareDismissed } =
    reviewController.shipped;
  const { dismissShippedChangeShare } = reviewController.shipped;
  const { sendShippedChangeToSlack, undoShippedChangeShare } =
    reviewController.shipped;
  const { reconnectShippedSlack } = reviewController.shipped;
  const { shellTiming, sessionHidden } = reviewController.shell;
  const subagentOpen = showSubagent && subagentStack.length > 0;
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
    rangesLoading: transcriptRangesLoading,
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
  const viewState = useSessionViewStateController({
    identity: {
      session,
      focused,
      optimisticEmpty,
      connected,
      initialPending,
      workspaceSessions,
      onSetStatus,
    },
    transcript: {
      entries,
      loading,
      liveTurnStore,
      setEntries,
      transcriptViewStore,
    },
    surface: {
      phonePr,
      showStaging,
      onCloseStaging,
      showReview,
      sessionHidden,
      openAssets,
      onOpenSubagent,
      onSubagentLabel,
    },
    socket: { send, addHandler },
  });
  const { draftKey, images, setImages } = viewState.composer;
  const { files, setFiles, uploads } = viewState.composer;
  const { uploadStaging, forkFrom, setForkFrom } = viewState.composer;
  const { composerSettersRef } = viewState.composer;
  const { isStreaming, isRunningLive, safety } = viewState.runtime;
  const { queued, steered, pendingDeliveryIds } = viewState.runtime;
  const { ask, model, usage } = viewState.runtime;
  const { dispatchSessionRuntime, runtimeController } = viewState.runtime;
  const { agents: agentsController } = runtimeController;
  const { presence: presenceController } = runtimeController;
  const { run: runController } = runtimeController;
  const { staging: stagingController } = runtimeController;
  const { preview: previewController } = runtimeController;
  const { subagents, currentUser, pinned } = agentsController;
  const { canKeepInSidebar, keepInSidebar, promoting } = agentsController;
  const { isAsk, hasWorkspace, hasRepoWork, handlePromote } = agentsController;
  const { gitRefreshTick, setGitRefreshTick } = presenceController;
  const { sessionPrTargetsRef, viewers, setViewers } = presenceController;
  const { typingUsers, setTypingUsers } = presenceController;
  const { workspacePreparing, setWorkspacePreparing } = presenceController;
  const { isBusy, busySince, stopRequestedAt } = runController;
  const { setStopRequestedAt, stopRequest } = runController;
  const { waitingForWorkspace, settingUpWorkspace } = runController;
  const { deployment: staging, url: stagingUrl } = stagingController;
  const { status: previewStatus } = previewController;
  const { setStatus: setPreviewStatus } = previewController;
  const { startDeclaredPortal, livePortals } = previewController;
  const { draggingQueueRef, pendingReorderRef } = viewState.queue;
  const { composerPrefill, setComposerPrefill } = viewState.queue;
  const { setComposerPrefillRef, pending, setPending } = viewState.queue;
  const stableComposerPrefillRef = useRef(setComposerPrefillRef);
  const { pendingRef, outboxItems, landedOutboxIds } = viewState.queue;
  const { setLandedOutboxIds } = viewState.queue;
  const { replySuggestions, setReplySuggestions } = viewState.preferences;
  const { showReplySuggestions, showNextChatButton } = viewState.preferences;
  const { slackComposer, setSlackComposer } = viewState.slack;
  const { slackComposerStatus, setSlackComposerStatus } = viewState.slack;
  const { slackComposerReconnect, setSlackComposerReconnect } = viewState.slack;
  const { slackComposerSent, setSlackComposerSent } = viewState.slack;
  const { copied, shareLink, renameDraft, setRenameDraft } = viewState.chrome;
  const { infoPageOpen, setInfoPageOpen } = viewState.chrome;
  const { infoPageScrolled, setInfoPageScrolled } = viewState.chrome;
  const infoPageSettersRef = useRef({ setInfoPageOpen, setInfoPageScrolled });
  const { openSubagent, nameSubagent } = viewState.subagents;
  const { sessionWalkthrough, reviewResult } = viewState.presentation;
  const { panelOpen, setPanelOpen } = viewState.panel;
  const { desktopPanelPage, setDesktopPanelPage } = viewState.panel;
  const { panelStyle, panelResizeHandle } = viewState.panel;
  const { activePanelOpen, setActivePanelOpen } = viewState.panel;
  const { panelPage, setPanelPage } = viewState.panel;
  const { panelTerminalMounted, setPanelTerminalMounted } = viewState.panel;
  const { assetFiles, refreshAssets, assetPaths } = viewState.assets;
  const { selectedAssetPath, setSelectedAssetPath } = viewState.assets;
  const { overlayAssetPath, setOverlayAssetPath } = viewState.assets;
  const { closeAssetOverlay, promoteAssetToTab } = viewState.assets;
  const { openAssetFromTranscript } = viewState.assets;
  const { sessionReports, notes, setNotes } = viewState.notes;
  const { noteMode, setNoteMode } = viewState.notes;
  const { addSessionAttachments, fileDragActive } = viewState.notes;
  // Intent-aware scrolling: stick to the live edge only while the reader is there,
  // pin new turns near the top, and surface a "Jump to latest" affordance.

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

  const workspaceTools = useSessionWorkspaceToolsController({
    identity: { session, focused, hideRightPanel, pendingCreation },
    runtime: {
      dispatch: dispatchSessionRuntime,
      model,
      isBusy,
      hasWorkspace,
      hasRepoWork,
      activePanelOpen,
      infoPageOpen,
    },
    relations: { subagents, sessionReportCount: sessionReports.length },
  });
  const workspaceModel = workspaceTools.model;
  const { models, defaultModel, accounts } = workspaceModel;
  const { accountId, effort, fastMode, goalOverride } = workspaceModel;
  const { currentGoal, setEffort, setFastMode } = workspaceModel;
  const { setAccountId, setGoalOverride } = workspaceModel;
  const { workflowRuns, workflowsLoaded, workflowAction, setWorkflowRuns } =
    workspaceTools.workflows;
  const { runningAgents, hasPlain, plainUrl } = workspaceTools.relations;
  const { feedRef, feedRefLabel, panelAvailable } = workspaceTools.relations;
  const { liveSubagents } = workspaceTools.relations;
  const { diffState } = workspaceTools.workspace;
  const { archiveShortcutLabel, copyTranscriptLabel } =
    workspaceTools.shortcuts;
  const { nextChatKeys, newSiblingKeys } = workspaceTools.shortcuts;
  const { transcriptDownKeys, composerRef } = workspaceTools.shortcuts;
  const stableComposerRef = useRef(composerRef);
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
  const { effectiveModel, isCodexModel, noEngine, latestAssistantMessage } =
    sessionConversationAvailability({
      session,
      model,
      defaultModel,
      models,
      entries,
    });
  const { shippedSent, shippedChangeShare } = useShippedChangePresentation({
    identity: {
      session,
      mergedPr,
      shippedShare,
      shareDismissed,
      shippedScreenshot,
      latestAssistantMessage,
    },
    actions: {
      reconnectRequired: shippedSlackReconnectRequired,
      status: shippedChangeStatus,
      send: sendShippedChangeToSlack,
      reconnect: reconnectShippedSlack,
      undo: undoShippedChangeShare,
      dismiss: dismissShippedChangeShare,
    },
  });
  const conversationActions = useSessionConversationActions({
    identity: { session, entries, queued },
    slack: {
      composer: slackComposer,
      setComposer: setSlackComposer,
      setStatus: setSlackComposerStatus,
      setReconnect: setSlackComposerReconnect,
      setSent: setSlackComposerSent,
    },
    runtime: {
      send,
      dispatch: dispatchSessionRuntime,
      onRunningChange,
      openSession,
      openAsset: openAssetFromTranscript,
      navigation,
      composerSettersRef,
    },
  });
  const slackActions = conversationActions.slack;
  const sessionActions = conversationActions.session;
  const { sendComposedSlackMessage, undoComposedSlackMessage } = slackActions;
  const { cancelComposedSlackMessage, reconnectComposedSlack } = slackActions;
  const { canForkSession, handleFork, continueAfterFailure } = sessionActions;
  const { continuePausedSession, repairSafetyPause } = sessionActions;
  const { handleMessagesClick } = sessionActions;
  const draftContext = useSessionDraftContext({
    session,
    workspaceSessions,
    allSessions,
    draft: {
      draftKey,
      images,
      files,
      contextSessions,
      setContextSessions,
      sessionHidden,
    },
  });
  const { quote, setQuote, clearQuote } = draftContext.quote;
  const { composerHasDraft } = draftContext;
  const { showAllContextSessions, setShowAllContextSessions } =
    draftContext.context;
  const { contextSessionOptions } = draftContext.context;
  const { deskOwner, effectiveReview } = draftContext.metadata;
  const sendController = useSessionSendController({
    message: {
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
    },
    composer: {
      setEffort,
      setFastMode,
      setPrefill: setComposerPrefill,
      hasDraft: composerHasDraft,
      settersRef: composerSettersRef,
      prefillRef: setComposerPrefillRef,
    },
    queue: {
      sessionId: session.id,
      dispatch: dispatchSessionRuntime,
      send,
      pendingReorderRef,
      draggingQueueRef,
    },
    conversation: {
      projection: {
        queued,
        steered,
        pending,
        pendingDeliveryIds,
        outboxItems,
        landedOutboxIds,
        entries,
        settingUpWorkspace,
      },
      liveTurnStore,
      isBusy,
      ask,
      safety,
      session,
      entries,
    },
  });
  const sendActions = sendController.actions;
  const sendPresentation = sendController.presentation;
  const { handleSend, discardOutbox } = sendActions;
  const { editOutboxInComposer, editQueuedInComposer } = sendActions;
  const { editSentMessageInComposer, handleQueueReorder } = sendActions;
  const { commitQueueReorder } = sendActions;
  const { pendingQueue, pendingBubbles } = sendPresentation;
  const { optimisticTranscriptEntries } = sendPresentation;
  const { pendingTranscriptDeliveryIds, durableOutbox } = sendPresentation;
  const { shownQueued, queuedClassified } = sendPresentation;
  const { queueCount, queueTitle, hasLiveConversation } = sendPresentation;
  const { inlineRunFailure } = sendPresentation;
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

  const headerActions = useSessionHeaderActions({
    identity: {
      session,
      workspaceName,
      showReview,
      showConversation,
      showVideo,
      subagentIds: subagentOpen
        ? subagentStack.map((subagent) => subagent.agentId)
        : [],
      latestAssistantMessage,
    },
    runtime: {
      send,
      dispatch: dispatchSessionRuntime,
      setStopRequestedAt,
      shareLink,
      closeOverflow: () => setOverflowOpen(false),
      scrollToLatest,
    },
    model: {
      model,
      defaultModel,
      accountId: accountId || "",
      accounts,
      setAccountId,
      setFastMode,
      setGoalOverride,
    },
    setters: {
      renameDraft,
      setRenameDraft,
      setSlackComposer,
      setSlackStatus: setSlackComposerStatus,
      setSlackReconnect: setSlackComposerReconnect,
      setSlackSent: setSlackComposerSent,
    },
    onRenameWorkspace,
    onRename,
  });
  const { handleCancel, handleShareWorkspace, handleShare } =
    headerActions.actions;
  const { handleOpenSlackComposer, commitRename } = headerActions.actions;
  const { handleModelChange, handleAccountChange, handleSetGoal } =
    headerActions.actions;
  const { showDeleteConfirm, setShowDeleteConfirm, confirm } =
    headerActions.deleteState;
  const { confirmDialog, deleting, setDeleting } = headerActions.deleteState;
  const { archiving, setArchiving, deleteLabel, setDeleteLabel } =
    headerActions.deleteState;
  const headerController = useSessionHeaderLayoutController({
    topbarEl,
    activePanelOpen,
    desktopPanelPage,
    setPanelTerminalMounted,
    infoPageOpen,
    setPanelPage,
    composerRef,
    hasRepoWork,
    workflowRuns,
    subagents,
    entries,
    isBusy,
  });
  const { headerRef, headerActionsRef } = headerController.layout;
  const { reviewSessionActionTarget, setReviewSessionActionTarget } =
    headerController.layout;
  const { desktopChangesRef, headerW, compactHeader } = headerController.layout;
  const { summaryOpen, setSummaryOpen, isPhone } = headerController.layout;
  const { summaryHasRoom, summaryVisible } = headerController.summary;
  const { summaryStep, summaryStepStyle } = headerController.summary;
  const { focusComposerForQuote } = headerController.composer;
  const { runningWorkflowRuns, anySubagentRunning } = headerController.agents;
  const { showAgents, livePlan } = headerController.agents;
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
    if (autoFocusComposer && !isPhone)
      stableComposerRef.current.current?.focus();
  }, [autoFocusComposer, isPhone]);
  useEffect(() => {
    if (!composerPrefillExternal) return;
    stableComposerPrefillRef.current.current(composerPrefillExternal);
    onComposerPrefillConsumed?.(composerPrefillExternal.seq);
    if (!isPhone) stableComposerRef.current.current?.focus();
  }, [composerPrefillExternal, onComposerPrefillConsumed, isPhone]);
  const primaryPrNumber = prPresentation.primary?.number;
  const chromeController = useSessionChromeController({
    identity: { session, compactHeader, isPhone, focused, connected },
    panel: { infoPageOpen, setInfoPageOpen, setInfoPageScrolled, panelPage },
    runtime: { isBusy, hasRepoWork, send, viewers, pending, queued },
    lifecycle: {
      goBack,
      onArchive,
      onArchived,
      openNextChat,
      showAssets,
      assetFileCount: assetFiles.length,
      onCloseAssets,
    },
    deletion: {
      setDeleteLabel,
      setDeleting,
      setShowDeleteConfirm,
      archiving,
      setArchiving,
    },
    preview: {
      controller: previewController,
      showPreviewTab,
      showPortal,
      activePanelOpen,
      worktreeDir: session.worktreeDir,
    },
    primaryPrNumber,
  });
  const { overflowOpen, setOverflowOpen } = chromeController.overflow;
  const { mobileActionMenuEl, setMobileActionMenuEl } =
    chromeController.overflow;
  const { overflowGit, branchActionBusy } = chromeController.overflow;
  const { setBranchActionBusy, branchConfirmOpen } = chromeController.overflow;
  const { setBranchConfirmOpen, branchConfirmMode } = chromeController.overflow;
  const { setBranchConfirmMode, moveToBranchFromMenu } =
    chromeController.overflow;
  const { createPrFromMenu, moveAndCreatePr } = chromeController.overflow;
  const { infoPageRef, infoHeroNameRef, others, liveOverviewMedia } =
    chromeController.info;
  const { handleDelete, handleArchive } = chromeController.lifecycle;
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

      {(session.goal || session.loop) && (
        <div className={SESSION_BANNERS}>
          {session.goal && (
            <span
              className="inline-flex max-w-full items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap rounded-full border border-line bg-panel px-3 py-[3px] text-label text-dim"
              title="Cleared with /goal clear"
            >
              🎯 {session.goal}
            </span>
          )}
          {session.loop && (
            <span
              className="inline-flex max-w-full items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap rounded-full border border-line bg-panel px-3 py-[3px] text-label text-dim"
              title={`"${session.loop.prompt}" · stop with /loop stop`}
            >
              ⟳ every {session.loop.intervalMinutes}m ·{" "}
              {session.loop.prompt.slice(0, 60)}
              {session.loop.prompt.length > 60 ? "…" : ""}
            </span>
          )}
        </div>
      )}

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
            reviewSessionActionTarget,
            connected: presentedConnected,
            isBusy,
            noEngine,
            openCurrentWorkspace,
            openNewSession: openNewSession
              ? () => void openNewSession("share")
              : undefined,
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
              loadingHistory: loadingHistory || transcriptRangesLoading,
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
