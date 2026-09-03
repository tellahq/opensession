import type {
  ComponentProps,
  CSSProperties,
  Dispatch,
  RefObject,
  SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { duration, ease } from "../../ui/motion";
import { EmptyState, InlineAlert } from "../../ui/state";
import { AGENT_NAME } from "../../lib/brand";
import { withQuotes, type Quote } from "../../lib/quotes";
import {
  fetchFileMentions,
  fetchMentionSuggestions,
  fetchSkillMentions,
} from "../../lib/api";
import { fetchSlackChannels } from "../../lib/api/shipped-changes";
import { getCurrentUser } from "../UserPicker";
import { SessionPreviewSurface } from "../session/SessionPreviewSurface";
import { AssetsPanel } from "../AssetsPanel";
import { SubagentPane } from "../SubagentPane";
import { ConversationPane } from "../ConversationPane";
import { SlackChannelPane } from "../SlackChannelPane";
import { FeedWebPane } from "../FeedWebPane";
import { ShellPanel } from "../TerminalPanel";
import { PrPanel } from "../PrPanel";
import { QuoteSelection } from "../QuoteSelection";
import {
  WorkspaceSetup,
  ConversationLoading,
  BusyInline,
  WorkspaceWaiting,
} from "./busy-indicators";
import { Button } from "../../ui/button";
import { TranscriptView } from "../session/TranscriptView";
import { SessionSafetyNotice } from "../SessionSafetyNotice";
import { AskCard } from "../AskCard";
import {
  ShippedChangeComposer,
  SlackSentNotice,
  type SlackSent,
} from "../ShippedChangeComposer";
import { MessageRail } from "../MessageRail";
import { Tooltip } from "../../ui/tooltip";
import { ReplySuggestions } from "../ReplySuggestions";
import { TypingIndicator } from "../TypingIndicator";
import { Composer } from "../Composer";
import { SchedulePromptButton } from "../SchedulePrompt";
import { BrandMark } from "../BrandMark";
import { UsageMeter } from "../UsageMeter";
import { cn } from "../../ui/cn";
import { composerMenuIcon, composerMenuItem } from "../../lib/composer-classes";
import {
  IconArrowDown,
  IconArrowRight,
  IconArrowUp,
  IconArrowUpToLine,
  IconCheck,
  IconChevronRight,
  IconEye,
  IconMessage,
  IconPlus,
  IconSparkle,
  IconTerminal,
  IconArchive,
} from "../icons";
import { TURN_SPACER } from "../../lib/app-shell-classes";
import { MOBILE_CONTROL_GLASS } from "../../lib/app-header-classes";
import {
  PILL_CENTRED,
  TRANSCRIPT_ICON_BUTTON,
  TRANSCRIPT_PILL_BUTTON,
  TRANSCRIPT_PILL_TOP,
  VIEWER_ACTION_ROW,
  VIEWER_ACTION_ROW_WITH_SCROLL,
  VIEWER_INPUT,
  VIEWER_MESSAGES,
  VIEWER_MESSAGES_REGION,
  VIEWER_REVIEW_MAIN,
  VIEWER_SUGGESTIONS,
  VIEWER_SUGGESTIONS_ROW,
  VIEWER_SUGGESTIONS_ROW_INLINE,
  VIEWER_SUMMARY_STEP,
} from "../../lib/session-viewer-classes";
import type { UnifiedSession, SessionNote } from "../../lib/types";
import type { SessionViewerProps } from "../../lib/session-viewer-bindings";
import type { QueueReceipt } from "../../lib/session-queue";
import type { FileAttachment } from "../../lib/images";
import type { ReplySuggestion } from "../../lib/reply-suggestions";
import type { PrFocus } from "../../lib/pr-focus";
import type { PrReviewPage } from "../PrPanel";
import type { WorkspaceMediaItem } from "../../lib/api";
import type { useNavigation } from "../../hooks/useNavigation";
import type { useSessionSocket } from "../../hooks/useSessionSocket";
import type { useSessionAssets } from "../AssetsPanel";
import type { useSessionRuntimeController } from "../../hooks/useSessionRuntimeController";
import type { useTranscriptHistoryController } from "../../hooks/useTranscriptHistoryController";
import type { useSessionComposerDraft } from "../../hooks/useSessionComposerController";

type Send = ReturnType<typeof useSessionSocket>["send"];
type Navigation = ReturnType<typeof useNavigation>;
type PreviewController = ReturnType<
  typeof useSessionRuntimeController
>["preview"];
type PreviewSurface = ComponentProps<typeof SessionPreviewSurface>["surface"];
type ComposerProps = ComponentProps<typeof Composer>;
type TranscriptProps = ComponentProps<typeof TranscriptView>;
type PrPanelProps = ComponentProps<typeof PrPanel>;
type AssetFiles = ComponentProps<typeof AssetsPanel>["files"];
type SubagentStack = ComponentProps<typeof SubagentPane>["stack"];
type TranscriptEntries = TranscriptProps["entries"];
type LiveTurnStore = TranscriptProps["liveTurnStore"];
type ComposerPrefill = {
  seq: number;
  text: string;
  replace?: boolean;
  pastedTexts?: string[];
} | null;
type AskState =
  ComponentProps<typeof AskCard> extends {
    questions: infer Questions;
  }
    ? { questionId: string; questions: Questions } | null
    : never;
type SlackComposerDraft = {
  id: string;
  message: string;
  images: string[];
  channel?: string;
};

interface SurfaceRegion {
  showPortal: boolean;
  portalTarget: SessionViewerProps["viewTabs"]["portalTarget"];
  showPreviewTab: boolean;
  onClosePreviewTab: SessionViewerProps["viewTabs"]["onClosePreviewTab"];
  showStaging: boolean;
  staging: Extract<PreviewSurface, { kind: "staging" }>["deployment"];
  stagingUrl?: string | null;
  shareLink: Extract<PreviewSurface, { kind: "staging" }>["shareLink"];
  showAssets: boolean;
  showTerminal: boolean;
  showReview: boolean;
  showConversation: boolean;
  showVideo: boolean;
  subagentOpen: boolean;
  conversationThreadId?: string | null;
}

interface PaneRegion {
  assetFiles: AssetFiles;
  refreshAssets: ComponentProps<typeof AssetsPanel>["refresh"];
  selectedAssetPath: ComponentProps<typeof AssetsPanel>["selectedPath"];
  setSelectedAssetPath: ComponentProps<typeof AssetsPanel>["onSelectPath"];
  navigation: Navigation;
  videoPanel: SessionViewerProps["viewTabs"]["videoPanel"];
  videoTitle: SessionViewerProps["viewTabs"]["videoTitle"];
  subagentStack: SubagentStack;
  openSubagent: ComponentProps<typeof SubagentPane>["onOpenSubagent"];
  onSubagentBack: SessionViewerProps["subagents"]["onSubagentBack"];
  nameSubagent: ComponentProps<typeof SubagentPane>["onLabel"];
  hasWorkspace: boolean;
  waitingForWorkspace: boolean;
  terminalTabOpen: boolean;
  previewStatus: Extract<PreviewSurface, { kind: "preview" }>["status"];
}

interface ReviewRegion {
  openPr: PrPanelProps["onOpenPr"];
  allSessions: SessionViewerProps["workspace"]["allSessions"];
  workspaceSessions: SessionViewerProps["workspace"]["workspaceSessions"];
  reviewSessionActionTarget: PrPanelProps["sessionActionTarget"];
  connected: boolean;
  isBusy: boolean;
  noEngine: boolean;
  openCurrentWorkspace: PrPanelProps["onOpenSession"];
  openNewSession: PrPanelProps["onStartSession"];
  setComposerPrefill: Dispatch<SetStateAction<ComposerPrefill>>;
  panelReviewRepos: PrPanelProps["repos"];
  discoveredPrs: PrPanelProps["discoveredPrs"];
  reviewFocus: PrFocus | undefined;
  reviewPage: PrReviewPage;
  setReviewPage: Dispatch<SetStateAction<PrReviewPage>>;
}

interface TranscriptState {
  loading: boolean;
  entries: TranscriptEntries;
  hasLiveConversation: boolean;
  inlineRunFailure: UnifiedSession["lastRunError"] | null | undefined;
  openSettlePending: boolean;
  optimisticTranscriptEntries: TranscriptProps["optimisticEntries"];
  pendingTranscriptDeliveryIds: TranscriptProps["pendingDeliveryIds"];
  transcriptIndex: TranscriptProps["transcriptIndex"] | null;
  transcriptRangeRetryGeneration: TranscriptProps["transcriptRangeRetryGeneration"];
  isBusy: boolean;
  shouldMaintainEnd: TranscriptProps["shouldMaintainEnd"];
  reviewResult: TranscriptProps["reviewResult"];
  sessionWalkthrough: TranscriptProps["walkthrough"];
  notes: SessionNote[];
  safety: ComponentProps<typeof SessionSafetyNotice>["safety"] | undefined;
}

interface TranscriptContent {
  assetPaths: TranscriptProps["assetPaths"];
  toolPathRoots: TranscriptProps["toolPathRoots"];
  liveSubagents: TranscriptProps["liveSubagents"];
  liveTurnStore: LiveTurnStore;
  sentMessages: ComponentProps<typeof MessageRail>["messages"];
  shippedChangeShare: TranscriptProps["slackShare"];
  ask: AskState;
  busySince: ComponentProps<typeof BusyInline>["since"];
  stopRequestedAt: ComponentProps<typeof BusyInline>["stoppingSince"];
  settingUpWorkspace: boolean;
  transcriptIndexExpected: boolean;
  historyTruncated: boolean;
  atTop: boolean;
  loadingHistory: boolean;
}

interface TranscriptActions {
  openAssetFromTranscript: TranscriptProps["openAsset"];
  onTranscriptRender: TranscriptProps["onRender"];
  loadTranscriptRanges: TranscriptProps["onLoadTranscriptRanges"];
  onVisibleRangesSettled: TranscriptProps["onVisibleRangesSettled"];
  relayout: TranscriptProps["onLayout"];
  editSentMessageInComposer: TranscriptProps["onEditMessage"];
  continueAfterFailure: NonNullable<TranscriptProps["onContinue"]>;
  continuePausedSession: ComponentProps<
    typeof SessionSafetyNotice
  >["onContinue"];
  repairSafetyPause: NonNullable<
    ComponentProps<typeof SessionSafetyNotice>["onRepair"]
  >;
  handleFork: NonNullable<TranscriptProps["onFork"]>;
  handleMessagesScroll: ComponentProps<"div">["onScroll"];
  handleMessagesClick: ComponentProps<"div">["onClick"];
  cancelIndexAnchorHold: () => void;
  scrollToLatest: (behavior: ScrollBehavior) => void;
  loadAllHistory: () => void;
}

interface TranscriptInteraction {
  messagesRef: RefObject<HTMLDivElement | null>;
  setMessagesRef: (node: HTMLDivElement | null) => void;
  spacerRef: RefObject<HTMLDivElement | null>;
  tailActionNeedsLayoutScrollRef: RefObject<boolean>;
  fileDragActive: boolean;
  canForkSession: boolean;
  typingUsers: ComponentProps<typeof TypingIndicator>["users"];
  setQuote: Dispatch<SetStateAction<Quote | null>>;
  focusComposerForQuote: () => HTMLTextAreaElement | null;
}

interface SlackRegion {
  slackComposer: SlackComposerDraft | null;
  slackComposerStatus: ComponentProps<typeof ShippedChangeComposer>["status"];
  slackComposerReconnect: boolean;
  sendComposedSlackMessage: ComponentProps<
    typeof ShippedChangeComposer
  >["onShare"];
  reconnectComposedSlack: ComponentProps<
    typeof ShippedChangeComposer
  >["onReconnectSlack"];
  cancelComposedSlackMessage: ComponentProps<
    typeof ShippedChangeComposer
  >["onCancel"];
  slackComposerSent: SlackSent | null;
  handleOpenSlackComposer: () => void | Promise<void>;
  undoComposedSlackMessage: (sent: SlackSent) => void | Promise<void>;
}

interface EmptyConversationRegion {
  workspaceName?: string;
  contextSessionOptions: UnifiedSession[];
  contextSessions: string[];
  setContextSessions: Dispatch<SetStateAction<string[]>>;
  showAllContextSessions: boolean;
  setShowAllContextSessions: Dispatch<SetStateAction<boolean>>;
}

interface ActionBandRegion {
  actionBand: boolean;
  quickReplies: boolean;
  nextAction: boolean;
  scrollAction: boolean;
  isPhone: boolean;
  replySuggestions: ReplySuggestion[];
  pickReplySuggestion: (text: string) => void;
  transcriptDownKeys: string[] | null;
  nextChatKeys: string[] | null;
  openNextChat?: () => void;
  archiving: boolean;
  handleArchive: () => void | Promise<void>;
  setMobileActionMenuEl: (node: HTMLDivElement | null) => void;
  openNewWorkspace?: () => void;
  showNextChatButton: boolean | undefined;
}

interface ComposerState {
  forkFrom: ReturnType<typeof useSessionComposerDraft>["fork"]["forkFrom"];
  composerResetSeq: number | undefined;
  draftKey: string;
  images: string[];
  files: FileAttachment[];
  uploadStaging: ComposerProps["config"]["staging"];
  focused: boolean;
  quote: Quote | null;
  promoting: boolean;
  isAsk: boolean;
}

interface ComposerConfiguration {
  stopRequestedAt: number | null;
  stopRequest: number;
  composerPrefill: ComposerProps["config"]["prefill"];
  models: ComposerProps["config"]["models"];
  defaultModel: string;
  model: string;
  effort: ComposerProps["config"]["effort"];
  fastMode: boolean;
  accounts: NonNullable<ComposerProps["config"]["accounts"]>;
  accountId: string;
  currentGoal: string | null;
  usage: ComposerProps["config"]["usage"];
  composerRef: RefObject<HTMLTextAreaElement | null>;
  noteMode: boolean;
  attachedComposer: ComposerProps["attached"];
}

interface ComposerActions {
  setTyping: SessionViewerProps["composer"]["setTyping"];
  setForkFrom: ReturnType<
    typeof useSessionComposerDraft
  >["fork"]["setForkFrom"];
  handleSend: ComposerProps["onTyping"] extends never
    ? never
    : ComposerProps["actions"]["onSend"];
  setImages: ComposerProps["actions"]["onImagesChange"];
  setFiles: ComposerProps["actions"]["onFilesChange"];
  addSessionAttachments: ComposerProps["actions"]["onAddAttachments"];
  cancelPendingImage: ComposerProps["actions"]["onRemovePendingImage"];
  cancelPendingFile: ComposerProps["actions"]["onRemovePendingFile"];
  clearQuote: () => void;
  handlePromote: (close?: () => void) => void | Promise<void>;
  setNoteMode: ComposerProps["actions"]["onNoteModeChange"];
  handleCancel: ComposerProps["actions"]["onStop"];
  handleModelChange: ComposerProps["actions"]["onModelChange"];
  setEffort: ComposerProps["actions"]["onEffortChange"];
  setFastMode: ComposerProps["actions"]["onFastModeChange"];
}

interface ComposerMoreActions {
  handleAccountChange: NonNullable<ComposerProps["actions"]["onAccountChange"]>;
  handleSetGoal: NonNullable<ComposerProps["actions"]["onSetGoal"]>;
}

interface LayoutRegion {
  actionClearance?: string;
  summaryStep: number;
  summaryStepStyle?: CSSProperties;
  summaryVisible: boolean;
  tabStripVisible: boolean | undefined;
  setViewerInput: (node: HTMLDivElement | null) => void;
  leaveLatest: ComponentProps<typeof MessageRail>["leaveLatest"];
}

interface TranscriptRegion {
  state: TranscriptState;
  content: TranscriptContent;
  actions: TranscriptActions;
  interaction: TranscriptInteraction;
}

interface ComposerRegion {
  state: ComposerState;
  configuration: ComposerConfiguration;
  actions: ComposerActions;
  moreActions: ComposerMoreActions;
}

interface SessionViewerMainRegionProps {
  session: UnifiedSession;
  surfaces: SurfaceRegion;
  panes: PaneRegion;
  review: ReviewRegion;
  transcript: TranscriptRegion;
  slack: SlackRegion;
  emptyConversation: EmptyConversationRegion;
  actionBand: ActionBandRegion;
  composer: ComposerRegion;
  layout: LayoutRegion;
  send: Send;
  canRepairSafety: boolean;
}

export function SessionViewerMainRegion({
  session,
  surfaces,
  panes,
  review,
  transcript,
  slack,
  emptyConversation,
  actionBand,
  composer,
  layout,
  send,
  canRepairSafety,
}: SessionViewerMainRegionProps) {
  const {
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
  } = surfaces;
  const {
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
  } = panes;
  const {
    openPr,
    allSessions,
    workspaceSessions,
    reviewSessionActionTarget,
    connected,
    isBusy,
    noEngine,
    openCurrentWorkspace,
    openNewSession,
    setComposerPrefill,
    panelReviewRepos,
    discoveredPrs,
    reviewFocus,
    reviewPage,
    setReviewPage,
  } = review;
  const {
    loading,
    entries,
    hasLiveConversation,
    inlineRunFailure,
    openSettlePending,
    optimisticTranscriptEntries,
    pendingTranscriptDeliveryIds,
    transcriptIndex,
    transcriptRangeRetryGeneration,
    shouldMaintainEnd,
    reviewResult,
    sessionWalkthrough,
    notes,
    safety,
  } = transcript.state;
  const {
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
  } = transcript.content;
  const {
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
  } = transcript.actions;
  const {
    messagesRef,
    setMessagesRef,
    spacerRef,
    tailActionNeedsLayoutScrollRef,
    fileDragActive,
    canForkSession,
    typingUsers,
    setQuote,
    focusComposerForQuote,
  } = transcript.interaction;
  const {
    slackComposer,
    slackComposerStatus,
    slackComposerReconnect,
    sendComposedSlackMessage,
    reconnectComposedSlack,
    cancelComposedSlackMessage,
    slackComposerSent,
    handleOpenSlackComposer,
    undoComposedSlackMessage,
  } = slack;
  const {
    workspaceName,
    contextSessionOptions,
    contextSessions,
    setContextSessions,
    showAllContextSessions,
    setShowAllContextSessions,
  } = emptyConversation;
  const {
    actionBand: hasActionBand,
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
  } = actionBand;
  const {
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
  } = composer.state;
  const {
    stopRequestedAt: composerStopRequestedAt,
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
  } = composer.configuration;
  const {
    setTyping,
    setForkFrom,
    handleSend,
    setImages,
    setFiles,
    addSessionAttachments,
    cancelPendingImage,
    cancelPendingFile,
    clearQuote,
    handlePromote,
    setNoteMode,
    handleCancel,
    handleModelChange,
    setEffort,
    setFastMode,
  } = composer.actions;
  const { handleAccountChange, handleSetGoal } = composer.moreActions;
  const {
    actionClearance,
    summaryStep,
    summaryStepStyle,
    summaryVisible,
    tabStripVisible,
    setViewerInput,
    leaveLatest,
  } = layout;

  return (
    <div
      /* The last class is what the floating action band covers, paid for
					   by the transcript's bottom padding and by the scroll-to-bottom
					   pill's offset. Set here so both read one value. */
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col [--session-under:16px]",
        actionClearance,
      )}
    >
      {showPortal && portalTarget ? (
        <SessionPreviewSurface
          surface={{ kind: "portal", target: portalTarget }}
        />
      ) : showPreviewTab ? (
        <SessionPreviewSurface
          surface={{
            kind: "preview",
            session,
            status: previewStatus,
            onClose: () => onClosePreviewTab?.(),
          }}
        />
      ) : showStaging && stagingUrl ? (
        <SessionPreviewSurface
          surface={{
            kind: "staging",
            deployment: staging,
            url: stagingUrl,
            shareLink,
          }}
        />
      ) : showAssets ? (
        // The session's scratch assets, full-width (same component
        // the Info panel's Assets button opens). AssetsPanel is
        // `h-full`, so the flex-column viewer-review-main gives it
        // height exactly like the Review PrPanel.
        <div className={VIEWER_REVIEW_MAIN}>
          <AssetsPanel
            sessionId={session.id}
            files={assetFiles}
            refresh={refreshAssets}
            selectedPath={selectedAssetPath}
            onSelectPath={setSelectedAssetPath}
            onOpenNewSession={navigation.openPrefilledSession}
          />
        </div>
      ) : subagentOpen ? (
        // A sub-agent's conversation, full-width like Review — it reads
        // as a conversation, so it gets the session column instead of being
        // squeezed into the right sidebar. Nested Task calls push onto
        // the same tab's breadcrumb.
        <div className={VIEWER_REVIEW_MAIN}>
          <SubagentPane
            sessionId={session.id}
            stack={subagentStack}
            onOpenSubagent={openSubagent}
            onBack={() => onSubagentBack?.(session.id)}
            onLabel={nameSubagent}
          />
        </div>
      ) : showConversation && conversationThreadId ? (
        // The workspace's Plain ticket thread, full-width — same
        // ConversationPane the session-less workspace route renders, so
        // the session stays mounted underneath exactly like Review.
        <div className={VIEWER_REVIEW_MAIN}>
          <ConversationPane
            threadId={conversationThreadId}
            onOpenSession={() => {}}
            hideTriage
          />
        </div>
      ) : showVideo && videoPanel ? (
        // The workspace's feed panel: a web embed or a custom
        // component (Slack channel Conversation) via the panel
        // registry (the feeds design).
        <div className={VIEWER_REVIEW_MAIN}>
          {videoPanel.component === "slack-channel" ? (
            <SlackChannelPane channelId={videoPanel.refId} />
          ) : (
            <FeedWebPane panel={videoPanel} title={videoTitle || undefined} />
          )}
        </div>
      ) : showTerminal ? (
        // Nothing here on purpose: the shells are mounted once below,
        // outside this chain, so switching tabs doesn't kill their PTYs.
        // This branch only stops the transcript rendering under them.
        waitingForWorkspace ? (
          <div className={VIEWER_REVIEW_MAIN}>
            <WorkspaceWaiting detail="This takes a moment." />
          </div>
        ) : null
      ) : showReview && hasWorkspace ? (
        <div className={VIEWER_REVIEW_MAIN}>
          <PrPanel
            onOpenPr={openPr}
            sessionId={session.id}
            sessions={allSessions || workspaceSessions || []}
            onStartSession={openNewSession}
            sessionActionTarget={
              isPhone ? undefined : reviewSessionActionTarget
            }
            editGate={connected && !isBusy && !noEngine}
            onOpenSession={openCurrentWorkspace}
            onAddToInput={(text) =>
              setComposerPrefill((p) => ({
                seq: (p?.seq ?? 0) + 1,
                text,
              }))
            }
            repos={panelReviewRepos}
            linkedPrs={session.linkedPrs}
            discoveredPrs={discoveredPrs}
            focusTarget={reviewFocus}
            hideWideOverviewRail
            linkable
            walkthrough={session.walkthrough}
            page={reviewPage}
            onPageChange={setReviewPage}
            compactToolbar={summaryVisible}
            flushToolbarTop={!tabStripVisible}
          />
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {fileDragActive &&
            createPortal(
              <>
                <motion.div
                  className="pointer-events-none fixed inset-0 z-[12000] flex flex-col items-center justify-center bg-[color-mix(in_srgb,var(--bg-panel)_68%,transparent)] px-6 text-center"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{
                    type: "tween",
                    duration: duration.base,
                    ease,
                  }}
                  aria-hidden="true"
                  data-file-drop-overlay
                >
                  <IconArrowUpToLine size={40} className="text-fg" />
                  <div className="mt-4 text-title font-semibold text-fg">
                    Add files
                  </div>
                  <div className="mt-1 text-label text-dim">
                    Drop here to attach them to your message.
                  </div>
                </motion.div>
                <span className="sr-only" role="status">
                  Drop files to attach
                </span>
              </>,
              document.body,
            )}
          {/* The step lives here rather than on the scroller alone, so the
					    pills floating beside it inherit it too and stay on the reading
					    column instead of the middle of the pane. */}
          <div className={VIEWER_MESSAGES_REGION} style={summaryStepStyle}>
            {/* Selecting transcript text offers actions without changing either
						    composer until the person chooses where to use it. */}
            <QuoteSelection
              containerRef={messagesRef}
              disabled={noEngine}
              quote={quote}
              onQuote={setQuote}
              onStartNewChat={(selection) =>
                navigation.startNewChat(session, withQuotes([selection], ""))
              }
              onClear={clearQuote}
              onInputIntent={focusComposerForQuote}
            />
            <div
              className={cn(
                VIEWER_MESSAGES,
                // The open card and the reading column share the pane, so the
                // messages take a visible step left instead of staying under
                // the card's side of the composition.
                summaryStep > 0 && VIEWER_SUMMARY_STEP,
              )}
              ref={setMessagesRef}
              data-lightbox-session-id={session.id}
              onScroll={handleMessagesScroll}
              onClick={handleMessagesClick}
            >
              {/* The outgoing setup/loading canvas owns min-h-full. Waiting for its
							    short fade before mounting transcript rows prevents both surfaces
							    occupying the phone scroller for one frame and pushing a just-sent
							    message from the composer edge to the top. */}
              <AnimatePresence initial={false} mode="wait">
                {settingUpWorkspace ? (
                  <WorkspaceSetup key="workspace-setup" />
                ) : loading ? (
                  <ConversationLoading key="conversation-loading" />
                ) : entries.length === 0 &&
                  !hasLiveConversation &&
                  !inlineRunFailure &&
                  !session.transcriptPath ? (
                  // A fresh session with no run yet is just an empty conversation —
                  // blank canvas, the composer below is the UI. Only a session
                  // that *ran*, has no transcript file, and has nothing in flight
                  // gets the notice: the first turn of a just-created session
                  // flips `ran` the moment it starts, seconds before its first
                  // entry lands, so a live conversation reads as "no transcript"
                  // unless it wins here. A session with anything live falls
                  // through to the transcript below, which is where the sent
                  // bubble and the streaming reply render. When the workspace has
                  // sibling sessions, the canvas offers their transcripts as
                  // attachable context for the first message.
                  session.ran ? (
                    <div className="py-10 text-center text-faint">
                      No transcript available for this session
                    </div>
                  ) : contextSessionOptions.length > 0 ? (
                    // Simple centered empty state: the whole region centers the
                    // heading + attachable-context chips so a fresh session reads as a
                    // calm blank canvas rather than a top-left form.
                    <div className="min-h-full flex flex-col items-center justify-center text-center w-full max-w-[840px] mx-auto px-4">
                      <div className="mb-4">
                        <div className="text-label font-medium text-dim">
                          New session in
                        </div>
                        <div className="max-w-[340px] mx-auto text-item-title font-semibold leading-snug text-fg">
                          {workspaceName || session.branch || "this workspace"}
                        </div>
                      </div>
                      <div className="text-dim mb-3">
                        Add session transcripts
                      </div>
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        {(showAllContextSessions
                          ? contextSessionOptions
                          : contextSessionOptions.slice(0, 4)
                        ).map((c) => {
                          const selected = contextSessions.includes(c.id);
                          const codex =
                            (c.model || "").startsWith("gpt") ||
                            (c.model || "").startsWith("codex");
                          const ChipIcon = selected
                            ? IconCheck
                            : codex
                              ? IconTerminal
                              : IconSparkle;
                          return (
                            <Button
                              key={c.id}
                              variant="ghost"
                              icon={
                                <ChipIcon
                                  size={16}
                                  className={
                                    selected ? "text-green" : undefined
                                  }
                                />
                              }
                              onClick={() =>
                                setContextSessions((prev) =>
                                  prev.includes(c.id)
                                    ? prev.filter((id) => id !== c.id)
                                    : [...prev, c.id],
                                )
                              }
                              title={
                                selected
                                  ? "Attached · its transcript rides along with your first message"
                                  : "Attach this session's transcript as context"
                              }
                              className={
                                selected
                                  ? "bg-pressed text-fg hover:bg-pressed"
                                  : "bg-hover/50"
                              }
                            >
                              <span className="max-w-[200px] truncate">
                                {c.title || "Untitled session"}
                              </span>
                            </Button>
                          );
                        })}
                        {!showAllContextSessions &&
                          contextSessionOptions.length > 4 && (
                            <Button
                              variant="ghost"
                              onClick={() => setShowAllContextSessions(true)}
                            >
                              +{contextSessionOptions.length - 4} more
                            </Button>
                          )}
                      </div>
                    </div>
                  ) : (
                    <EmptyState
                      icon={<IconMessage size={22} />}
                      title="Start a conversation"
                      className="min-h-full px-4"
                    >
                      Ask a question or describe your task.
                    </EmptyState>
                  )
                ) : entries.length === 0 &&
                  !hasLiveConversation &&
                  !inlineRunFailure ? (
                  <div className="py-10 text-center text-faint">
                    Empty transcript
                  </div>
                ) : (
                  <TranscriptView
                    openSettlePending={openSettlePending}
                    assetPaths={assetPaths}
                    toolPathRoots={toolPathRoots}
                    liveSubagents={liveSubagents}
                    openAsset={openAssetFromTranscript}
                    onRender={onTranscriptRender}
                    entries={entries}
                    optimisticEntries={optimisticTranscriptEntries}
                    pendingDeliveryIds={pendingTranscriptDeliveryIds}
                    transcriptIndex={transcriptIndex ?? undefined}
                    historyLoading={loadingHistory}
                    transcriptRangeRetryGeneration={
                      transcriptRangeRetryGeneration
                    }
                    onLoadTranscriptRanges={loadTranscriptRanges}
                    onVisibleRangesSettled={onVisibleRangesSettled}
                    live={isBusy}
                    sessionId={session.id}
                    liveTurnStore={liveTurnStore}
                    shouldMaintainEnd={shouldMaintainEnd}
                    onLayout={relayout}
                    reviewResult={reviewResult}
                    onEditMessage={editSentMessageInComposer}
                    // Same gate the composer sends under: a busy session
                    // is already continuing, and one you cannot type into
                    // must not offer a button that types for you.
                    onContinue={
                      connected && !isBusy && !noEngine
                        ? continueAfterFailure
                        : undefined
                    }
                    walkthrough={sessionWalkthrough}
                    notes={notes}
                    slackShare={shippedChangeShare}
                    onFork={canForkSession ? handleFork : undefined}
                    onOpenSubagent={openSubagent}
                    // For automation-owned sessions (e.g. a GitHub PR run), the
                    // automation never *types* a user turn — humans steer them.
                    // So don't credit un-attributed turns to the automation
                    // ("GitHub (automation)"); leave the owner unset so they read
                    // as "You" (explicit [Name] steers still show the teammate).
                    owner={
                      session.automation
                        ? undefined
                        : session.startedBy || undefined
                    }
                  />
                )}
              </AnimatePresence>

              {safety && (
                <SessionSafetyNotice
                  safety={safety}
                  onContinue={continuePausedSession}
                  onRepair={canRepairSafety ? repairSafetyPause : undefined}
                />
              )}

              {inlineRunFailure && (
                <InlineAlert
                  title="Run failed"
                  className="mx-auto mt-3 max-w-2xl rounded-2xl border-0 text-center [&>div>div]:leading-snug [&>div>div+div]:mt-0"
                >
                  {inlineRunFailure.message}
                </InlineAlert>
              )}

              <AnimatePresence initial={false}>
                {isBusy && !settingUpWorkspace && (
                  <BusyInline
                    key="busy"
                    since={busySince}
                    stoppingSince={stopRequestedAt}
                    liveTurnStore={liveTurnStore}
                    onLayout={relayout}
                  />
                )}
              </AnimatePresence>

              {ask && (
                <AskCard
                  key={ask.questionId}
                  questions={ask.questions}
                  onAnswer={(answers) => {
                    tailActionNeedsLayoutScrollRef.current = true;
                    send({
                      type: "answer_question",
                      sessionId: session.id,
                      questionId: ask.questionId,
                      answers,
                    });
                    // Answering is explicit intent to watch the resumed
                    // turn, even if the ask was only partly in view.
                    cancelIndexAnchorHold();
                    scrollToLatest("auto");
                  }}
                />
              )}

              {slackComposer && (
                <ShippedChangeComposer
                  key={slackComposer.id}
                  sessionId={session.id}
                  defaultMessage={slackComposer.message}
                  initialScreenshots={slackComposer.images}
                  defaultChannel={slackComposer.channel}
                  draftId={slackComposer.id}
                  status={slackComposerStatus}
                  reconnectRequired={slackComposerReconnect}
                  loadChannels={() => fetchSlackChannels(session.id)}
                  onShare={sendComposedSlackMessage}
                  onReconnectSlack={reconnectComposedSlack}
                  onCancel={cancelComposedSlackMessage}
                />
              )}

              {!slackComposer && slackComposerSent && (
                <SlackSentNotice
                  {...slackComposerSent}
                  onSendAnother={handleOpenSlackComposer}
                  onUndo={
                    slackComposerSent.channelId && slackComposerSent.ts
                      ? () => undoComposedSlackMessage(slackComposerSent)
                      : undefined
                  }
                />
              )}

              {/* Reserves room so a freshly-sent turn can sit near the top while its
                reply streams into the space below; sized by the scroll hook. */}
              <div ref={spacerRef} className={TURN_SPACER} aria-hidden="true" />
            </div>

            {/* Sibling of the scroller, not a child: a press on the rail
							    must never reach the transcript container, whose scroll hook
							    reads one in the scrollbar strip as "the reader took over". */}
            {!loading && (
              <MessageRail
                messages={sentMessages}
                containerRef={messagesRef}
                leaveLatest={leaveLatest}
              />
            )}

            {/* The action belongs to the transcript head. While it loads, the
                session-context slot reports the request without adding a row. */}
            {!transcriptIndexExpected &&
              historyTruncated &&
              atTop &&
              !loadingHistory && (
                <div className={TRANSCRIPT_PILL_TOP}>
                  <button
                    type="button"
                    onClick={loadAllHistory}
                    className={cn(
                      TRANSCRIPT_PILL_BUTTON,
                      "pointer-events-auto",
                    )}
                  >
                    <IconArrowUp
                      size={13}
                      className="text-dim transition-transform group-hover:-translate-y-px"
                      aria-hidden
                    />
                    Load all
                  </button>
                </div>
              )}

            {scrollAction && isPhone && (
              /* Phone keeps this above its stacked action rows. Desktop
								   places the same control inside the shared row below. */
              <Tooltip
                label="Scroll to the bottom"
                shortcut={transcriptDownKeys ?? undefined}
              >
                <button
                  className={cn(
                    TRANSCRIPT_ICON_BUTTON,
                    `absolute bottom-[calc(24px+var(--suggestions-under,0px))] left-1/2 z-[5] ${PILL_CENTRED}`,
                  )}
                  type="button"
                  aria-label="Scroll to the bottom"
                  onClick={() => {
                    cancelIndexAnchorHold();
                    scrollToLatest("auto");
                  }}
                >
                  <IconArrowDown
                    size={13}
                    className="text-dim transition-transform group-hover:translate-y-px"
                    aria-hidden
                  />
                </button>
              </Tooltip>
            )}
          </div>

          <div
            ref={setViewerInput}
            className={cn(
              VIEWER_INPUT,
              // Moves with the transcript above it, or the composer would
              // sit off the column it belongs to.
              summaryStep > 0 && VIEWER_SUMMARY_STEP,
            )}
            style={summaryStepStyle}
          >
            {noEngine ? (
              <div className="mx-auto max-w-[var(--session-col)] text-label text-faint">
                No engine session to resume
              </div>
            ) : (
              <>
                {forkFrom && (
                  <div className="mb-2 flex items-center justify-between gap-3 rounded-control border border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] px-3 py-[7px] text-supporting text-fg">
                    <span>
                      {forkFrom.kind === "tip"
                        ? "Duplicating this session from the current context. Type the new direction."
                        : "Duplicating this session from the selected message. Type the new direction."}
                    </span>
                    <button
                      className="cursor-pointer bg-transparent text-label text-dim hover:text-fg"
                      onClick={() => setForkFrom(null)}
                    >
                      Cancel
                    </button>
                  </div>
                )}
                {/* Session actions float above the composer. Desktop pairs quick
								    replies with Next. Phone centers the visible actions, with quick
								    replies on their own row when present. */}
                {hasActionBand && (
                  <div className={VIEWER_SUGGESTIONS}>
                    <div
                      className={cn(
                        VIEWER_ACTION_ROW,
                        scrollAction && VIEWER_ACTION_ROW_WITH_SCROLL,
                      )}
                    >
                      {quickReplies && (
                        <ReplySuggestions
                          className={cn(
                            nextAction && !isPhone
                              ? VIEWER_SUGGESTIONS_ROW_INLINE
                              : VIEWER_SUGGESTIONS_ROW,
                            "desktop:col-start-1 desktop:row-start-1 desktop:w-full",
                            isPhone && "w-full flex-none self-stretch",
                          )}
                          suggestions={replySuggestions}
                          onPick={pickReplySuggestion}
                        />
                      )}
                      {scrollAction && !isPhone && (
                        <div className="pointer-events-auto col-start-2 row-start-1 shrink-0 justify-self-center">
                          <Tooltip
                            label="Scroll to the bottom"
                            shortcut={transcriptDownKeys ?? undefined}
                          >
                            <button
                              className={TRANSCRIPT_ICON_BUTTON}
                              type="button"
                              aria-label="Scroll to the bottom"
                              onClick={() => {
                                cancelIndexAnchorHold();
                                scrollToLatest("auto");
                              }}
                            >
                              <IconArrowDown
                                size={13}
                                className="text-dim transition-transform group-hover:translate-y-px"
                                aria-hidden
                              />
                            </button>
                          </Tooltip>
                        </div>
                      )}
                      {nextAction && !isPhone && (
                        <div className="pointer-events-auto col-start-3 row-start-1 shrink-0 justify-self-end">
                          <Tooltip
                            label="Next chat"
                            shortcut={nextChatKeys ?? undefined}
                          >
                            <Button
                              size="lg"
                              className="min-h-10 shrink-0 border-divider hover:border-line"
                              trailing={
                                <IconChevronRight size={18} aria-hidden />
                              }
                              aria-label="Next chat"
                              onClick={openNextChat}
                            >
                              Next
                            </Button>
                          </Tooltip>
                        </div>
                      )}
                      {isPhone && (
                        <div
                          className={cn(
                            "pointer-events-auto mx-auto hidden h-12 shrink-0 items-center rounded-full border border-[color:var(--mobile-header-control-border)] px-0.5 text-dim shadow-[var(--mobile-header-control-shadow)] phone:flex phone:[body.kb-open_&]:hidden",
                            MOBILE_CONTROL_GLASS,
                          )}
                        >
                          {!session.archived && (
                            <Button
                              variant="ghost"
                              size="lg"
                              className="size-11 min-h-11 rounded-control [corner-shape:squircle]"
                              icon={<IconArchive size={22} aria-hidden />}
                              aria-label="Archive and open next chat"
                              disabled={archiving}
                              onClick={() => void handleArchive()}
                            />
                          )}
                          <div
                            ref={setMobileActionMenuEl}
                            className="inline-flex size-11"
                          />
                          <span
                            className="mx-0.5 h-5 w-px shrink-0 bg-divider"
                            aria-hidden
                          />
                          <Button
                            variant="ghost"
                            size="lg"
                            className="size-11 min-h-11 rounded-control [corner-shape:squircle]"
                            icon={<IconPlus size={22} aria-hidden />}
                            aria-label="New workspace"
                            disabled={!openNewWorkspace}
                            onClick={openNewWorkspace}
                          />
                          {showNextChatButton && (
                            <Button
                              variant="ghost"
                              size="lg"
                              className="size-11 min-h-11 rounded-control [corner-shape:squircle]"
                              icon={<IconArrowRight size={22} aria-hidden />}
                              aria-label="Next chat"
                              disabled={!openNextChat}
                              onClick={openNextChat}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <TypingIndicator
                  users={typingUsers}
                  className="mx-auto mb-1 w-full max-w-[calc(var(--session-col)+40px)] px-5"
                />
                <Composer
                  // Uncontrolled: the draft lives in the Composer (persisted
                  // per session via draftKey). Remount on the tab-bar +
                  // after its persisted draft has been cleared.
                  key={composerResetSeq ?? 0}
                  onTyping={(active) => setTyping(session.id, active)}
                  config={{
                    draftKey,
                    images,
                    files,
                    staging: uploadStaging,
                    attachmentShortcutActive: focused,
                    quote,
                    placeholder: safety
                      ? "Paused for safety"
                      : settingUpWorkspace
                        ? "Queue while workspace sets up…"
                        : !connected
                          ? "Send when reconnected…"
                          : forkFrom
                            ? "New direction…"
                            : promoting
                              ? "Setting up code workspace…"
                              : isBusy
                                ? "Queue for when it finishes…"
                                : isAsk
                                  ? `Ask ${AGENT_NAME}, read-only…`
                                  : `Ask ${AGENT_NAME}…`,
                    disabled: !!safety || (!connected && !!forkFrom),
                    sendDisabled: (text) =>
                      !!safety ||
                      promoting ||
                      (!text.trim() &&
                        images.length === 0 &&
                        (noteMode || files.length === 0) &&
                        !forkFrom),
                    // Tints the composer green and names the mode in a chip above
                    // the field. Only opensession sessions can promote.
                    askMode: isAsk,
                    askExitPending: promoting,
                    // Team notes post to the human transcript, never to the agent.
                    noteMode,
                    busy: isBusy && !forkFrom,
                    stopping: stopRequestedAt != null,
                    // Bumped by the ⌘. listener above; the composer opens the
                    // same confirmation Escape does.
                    stopRequest,
                    prefill: composerPrefill,
                    models,
                    defaultModel,
                    model,
                    modelDisabled:
                      session.source !== "opensession" &&
                      session.source !== "slack",
                    modelTitle:
                      session.source === "opensession" ||
                      session.source === "slack"
                        ? "Switch the model for this session"
                        : "Set the model from the owning agent (its session file is agent-owned)",
                    effort,
                    fastMode,
                    // Account pinning is a backstage-session affordance. The
                    // picker filters the combined pool by the active model.
                    accounts:
                      session.source === "opensession" ? accounts : undefined,
                    accountId,
                    goal: currentGoal,
                    usage,
                    textareaRef: composerRef,
                  }}
                  actions={{
                    onSend: handleSend,
                    onImagesChange: setImages,
                    onFilesChange: setFiles,
                    onAddAttachments: addSessionAttachments,
                    onRemovePendingImage: cancelPendingImage,
                    onRemovePendingFile: cancelPendingFile,
                    onQuoteClear: clearQuote,
                    onAskModeExit:
                      isAsk && session.source === "opensession"
                        ? () => void handlePromote()
                        : undefined,
                    onNoteModeChange: setNoteMode,
                    onStop: handleCancel,
                    onModelChange: handleModelChange,
                    onEffortChange: setEffort,
                    onFastModeChange: setFastMode,
                    onAccountChange:
                      session.source === "opensession"
                        ? handleAccountChange
                        : undefined,
                    onSetGoal:
                      session.source === "opensession"
                        ? handleSetGoal
                        : undefined,
                    mentionFetch: (query) =>
                      fetchFileMentions(query, session.id),
                    paletteFetch: (query) =>
                      fetchMentionSuggestions(
                        query,
                        session.id,
                        getCurrentUser(),
                      ),
                    skillsFetch: (query) =>
                      fetchSkillMentions(query, session.id),
                  }}
                  // Leaving ask mode is a setting of this session, so it sits in
                  // the composer's "+" with the rest of them. It disappears as
                  // soon as selected; workspace setup reports progress on the
                  // code surfaces that are waiting for it.
                  menuExtra={({ close }) => (
                    <>
                      <button
                        type="button"
                        className={composerMenuItem}
                        disabled={!!slackComposer}
                        title="Review a message before sending it to Slack"
                        onClick={() => {
                          close();
                          void handleOpenSlackComposer();
                        }}
                      >
                        <span className={composerMenuIcon}>
                          <BrandMark name="slack" size={16} />
                        </span>
                        <span className="grow whitespace-nowrap">
                          Send to Slack…
                        </span>
                      </button>
                      {isAsk && session.source === "opensession" && (
                        <button
                          type="button"
                          className={composerMenuItem}
                          disabled={promoting}
                          title="Ask mode: this session can read the code but not change it"
                          onClick={() => void handlePromote(close)}
                        >
                          <span className={composerMenuIcon}>
                            <IconEye size={22} />
                          </span>
                          {promoting ? "Switching to code…" : "Switch to code"}
                        </button>
                      )}
                    </>
                  )}
                  attached={attachedComposer}
                  sendMenu={
                    session.source === "opensession"
                      ? ({ text, disabled, onScheduled }) => (
                          <SchedulePromptButton
                            sessionId={session.id}
                            text={withQuotes(quote ? [quote] : [], text)}
                            disabled={disabled}
                            onScheduled={() => {
                              clearQuote();
                              onScheduled();
                            }}
                            variant="menu-item"
                          />
                        )
                      : undefined
                  }
                />
              </>
            )}
          </div>
        </div>
      )}
      {/* Shells keep their PTYs alive across view-tab switches: mounted
					    for as long as the Terminal tab exists, hidden while another
					    surface is in front. Closing the tab unmounts them, which is what
					    tears the PTYs down; they also die with the socket. */}
      {hasWorkspace && !waitingForWorkspace && terminalTabOpen ? (
        <div className={showTerminal ? VIEWER_REVIEW_MAIN : "hidden"}>
          <ShellPanel sessionId={session.id} visible={showTerminal} />
        </div>
      ) : null}
    </div>
  );
}
