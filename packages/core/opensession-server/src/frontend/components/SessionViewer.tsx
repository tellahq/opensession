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
import { getLiveTypingPref } from "../lib/live-typing-pref";
import { randomUUID } from "../lib/random-uuid";
import { isTimelineOnlyRunnerNotice } from "../lib/runner-events";
import { TranscriptViewStore } from "../lib/transcript-view-store";
import {
  measureSessionPerf,
  recordSessionPerf,
  scheduleTranscriptDomNodeSample,
} from "../lib/session-performance";
import { AGENT_NAME, DEFAULT_DOC_TITLE } from "../lib/brand";
import { withQuotes, type Quote } from "../lib/quotes";
import {
  absoluteLink,
  sessionPath,
  workspacePanePath,
} from "../lib/share-link";
import { markNotesRead } from "../lib/note-reads";
import { clearMention, onMentionsChanged } from "../lib/mentions";
import { QuoteSelection } from "./QuoteSelection";
import { plainThreadUrl } from "./PlainThreadPanel";
import type {
  UnifiedSession,
  GitStatusInfo,
  SessionNote,
  SessionSlackShare,
  TranscriptEntry,
} from "../lib/types";
import {
  mergeTranscriptEntries,
  orderTranscriptEntries,
} from "../lib/transcript-state";
import {
  HISTORY_PAGE_ENTRIES,
  shouldContinueHistoryReveal,
} from "../lib/transcript-history";
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
import { SubagentPane, type SubagentRef } from "./SubagentPane";
import { ShellPanel } from "./TerminalPanel";
import { getCurrentUser, useCurrentUser } from "./UserPicker";
import { UserAvatar } from "./UserAvatar";
import {
  deleteSessionApi,
  archiveSessionApi,
  fetchModels,
  fetchProviderAccounts,
  fetchFileMentions,
  fetchMentionSuggestions,
  fetchSkillMentions,
  fetchSessionSubagents,
  promoteSessionApi,
  fetchSessionNotesApi,
  postSessionNoteApi,
  fetchPr,
  fetchGitStatus,
  fetchPreview,
  moveSessionToBranchApi,
  portalActionApi,
  startPortalRecipeApi,
  type WorkspaceMediaItem,
  type ModelOption,
  type ProviderAccountOption,
  type SessionSubagentSnapshot,
  type PreviewPortalRecipe,
  type PreviewStatus,
} from "../lib/api";
import { pollWhileVisible, PR_WEBHOOK_FALLBACK_POLL_MS } from "../lib/poll";
import { sessionPrPresentation } from "../lib/session-prs";
import { refChipText, refLabel, refTone, worstPrRef } from "../lib/pr-refs";
import { prPhoneChipClass } from "../lib/pr-tone-classes";
import type { PrFocus } from "../lib/pr-focus";
import { reviewLoopResult } from "../lib/review-loop";
import { CONTINUE_AFTER_FAILURE_PROMPT } from "../lib/continue-run";
import { repairPausedSession } from "../lib/api/session-safety";
import { ApiError } from "../lib/api/request";
import { safetyContinuationPrompt } from "../lib/session-safety";
import {
  cancelSlackComposer,
  fetchSlackChannels,
  openSlackComposer,
  reconnectSlack,
  sendSlackComposer,
  shareShippedChange,
  undoShippedChange,
  undoSlackComposer,
} from "../lib/api/shipped-changes";
import { suggestedShippedChangeMessage } from "../lib/shipped-change-copy";
import {
  dismissSlackShare,
  isSlackShareDismissed,
  onSlackShareDismissChanged,
  slackShareDismissKey,
} from "../lib/slack-share-dismiss";
import { latestFeaturedScreenshot } from "../../shared/shipped-change-media";
import { useBackSwipe } from "../hooks/useBackSwipe";
import { useNavigation } from "../hooks/useNavigation";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { useSessionRuntime } from "../hooks/useSessionRuntime";
import {
  dedupeViewers,
  facepileAvatarStyle,
  otherViewers,
} from "../lib/presence";
import { otherTypingUsers } from "../lib/typing";
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
import {
  isHiddenForSession,
  onHidesChanged,
  unhideForSession,
} from "../lib/hides";
import {
  markPendingBusy,
  markPendingStarted,
  type OptimisticPendingPrompt,
  reconcilePending,
} from "../lib/pending-reconcile";
import { promptOutbox, type PromptOutboxItem } from "../lib/prompt-outbox";
import { withPreviewPath } from "../lib/preview-url";
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
  switchDividerText,
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
import { PreviewPane } from "./PreviewPane";
import { PortalPane } from "./PortalPane";
import { PortalsPage } from "./PortalsPanel";
import { portalTargetFor } from "../lib/portals";
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
  IconArrowUpRight,
} from "./icons";
import { KeepInSidebarIcon } from "./sidebar/KeepInSidebarMark";
import { Button } from "../ui/button";
import { SessionQueue } from "./SessionQueue";
import { deriveSessionQueue, type QueueReceipt } from "../lib/session-queue";
import { useConfirm } from "../ui/confirm";
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
import {
  onPendingSessionFork,
  takePendingSessionFork,
  type PendingSessionFork,
} from "../lib/pending-session-fork";
import { isPinned, togglePin, onPinsChanged } from "../lib/pins";
import { getLane, onLanesChanged } from "../lib/lanes";
import { ownedBy } from "../lib/sidebar-lanes";
import { useSessionScroll } from "../hooks/useSessionScroll";
import {
  useShortcutKeys,
  useShortcutLabel,
} from "../hooks/useShortcutBindings";
import { useSidePanel } from "../hooks/useSidePanel";
import { sessionHasWorkspace } from "../lib/session-workspace";
import {
  workspaceSummaryOpen,
  WS_SUMMARY_ROOM_W,
  workspaceSummaryShift,
} from "../lib/workspace-summary-open";
import { blockingOverlayOpen } from "../lib/blocking-overlay";
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

// Stable identity for "no sub-agent open", so the default prop doesn't hand
// the memoized transcript a fresh array on every render.
const NO_SUBAGENTS: SubagentRef[] = [];
const NO_WORKFLOW_RUNS: WorkflowRunSnapshot[] = [];

class SessionShellTiming {
  private recorded = false;
  constructor(private readonly startedAt: number) {}
  record() {
    if (this.recorded) return;
    this.recorded = true;
    measureSessionPerf("shell_to_transcript_ms", this.startedAt);
  }
}

function reviewReposFromKey(key: string) {
  return key.split("\u0000").map((repo, index) => ({
    repo,
    primary: index === 0,
  }));
}

function discoveredPrsFromKey(key: string) {
  if (!key) return [];
  return key.split("\u0001").map((encoded) => {
    const [repo, branch, number, url, title] = encoded.split("\u0000");
    return {
      repo,
      branch,
      number: number ? Number(number) : undefined,
      url: url || undefined,
      title: title || undefined,
    };
  });
}

function toolPathRootsFromKey(key: string) {
  const [primaryDir = "", ...attached] = key.split("\u0001");
  return [
    { dir: primaryDir },
    ...attached.map((encoded) => {
      const [dir, label] = encoded.split("\u0000");
      return { dir, label };
    }),
  ].filter((root) => Boolean(root.dir));
}
// Same reason: the empty row is set on every stream_start, and a fresh array
// each time would re-render the composer block for nothing.
const EMPTY_SUGGESTIONS: ReplySuggestion[] = [];
// And again for the Review tab's repo list, which a promoted PR replaces with
// an empty one: PrPanel memoizes its targets on this array.
const NO_REVIEW_REPOS: Array<{ repo: string; primary: boolean }> = [];
// Hidden for at least this long, returning to the tab is a "reopen" — jump to
// the live edge even if nothing new arrived. Shorter absences (glancing at a
// notification) keep the reader's place unless the transcript grew meanwhile.
const HIDDEN_REOPEN_MS = 30_000;
// After becoming visible again, keep watching this long for growth that lands
// late: on the iOS PWA the WebSocket only reconnects after visibility, so what
// streamed while backgrounded arrives moments after the visibilitychange.
const RESUME_GROWTH_WINDOW_MS = 8_000;
// Positive settlement normally lifts the opening curtain first. These deadlines
// are fail-safes: legacy transcripts have no structural outline callback, while
// an indexed transcript must never stay invisible if its index or visible-range
// callback is delayed or lost. Indexed opens get longer to avoid exposing the
// bounded tail just before the complete outline lands on a busy phone.
const LEGACY_OPEN_SETTLE_MAX_MS = 350;
const INDEXED_OPEN_SETTLE_MAX_MS = 2_500;
// "Jump to the start of the session" walks the backlog a page at a time rather
// than asking for it in one frame: a multi-thousand-entry transcript would be a
// tens-of-MB payload and one giant reconciliation. Fat pages keep the number of
// round trips (and whole-transcript re-renders) in single digits; the ceiling
// stops a runaway walk on a session nobody should be rendering whole — when it
// trips, the pill stays put so the reader can keep going deliberately.
const JUMP_PAGE_ENTRIES = HISTORY_PAGE_ENTRIES;
const JUMP_MAX_ENTRIES = 4_000;
const EMPTY_TRANSCRIPT_ENTRIES: TranscriptEntry[] = [];
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
  // Closing the card is a decision about this PR, not a fold, so it sticks
  // across reloads and devices (lib/slack-share-dismiss). The next merged PR
  // in the same session gets its own card, and "Send to Slack…" in the
  // composer menu still opens a composer, so closing loses nothing.
  const shareDismissKey = mergedPr?.number
    ? slackShareDismissKey(session.id, mergedPr.number)
    : "";
  const [shareDismissed, setShareDismissed] = useState(() =>
    isSlackShareDismissed(shareDismissKey),
  );
  const isSessionFocused = useEffectEvent(() => focused);
  useEffect(() => {
    const sync = () =>
      setShareDismissed(isSlackShareDismissed(shareDismissKey));
    sync();
    return onSlackShareDismissChanged(sync);
  }, [shareDismissKey]);
  const dismissShippedChangeShare = useCallback(
    () => dismissSlackShare(shareDismissKey),
    [shareDismissKey],
  );
  const sendShippedChangeToSlack = useCallback(
    async (message: string, channel: string, screenshots: string[]) => {
      if (!mergedPr) return;
      setShippedChangeStatus("sharing");
      try {
        const result = await shareShippedChange(session.id, {
          repo: mergedPr.repo,
          branch: mergedPr.branch,
          message,
          channel,
          screenshots,
        });
        setShippedChangeStatus("idle");
        setShippedSlackReconnectRequired(false);
        if (result.share) setShippedShare(result.share);
        else toast("This post was already sent");
      } catch (error) {
        setShippedChangeStatus("idle");
        if (
          error instanceof ApiError &&
          error.status === 403 &&
          /Reconnect Slack/.test(error.message)
        ) {
          setShippedSlackReconnectRequired(true);
          toast("Reconnect Slack to add image access");
        } else {
          toast(
            error instanceof Error
              ? error.message
              : "Couldn't share the shipped update",
          );
        }
      }
    },
    [mergedPr, session.id],
  );
  // Undo deletes the message in Slack and drops the receipt, so the card can
  // offer the send again. Slack only lets someone delete their own message, so
  // a teammate's post fails here rather than silently doing nothing.
  const undoShippedChangeShare = useCallback(
    async (at: string) => {
      try {
        await undoShippedChange(session.id, at);
        setShippedShare(null);
        toast("Removed from Slack");
      } catch (error) {
        toast(
          error instanceof Error
            ? error.message
            : "Couldn't undo the Slack message",
        );
      }
    },
    [session.id],
  );
  const reconnectShippedSlack = useCallback(async () => {
    try {
      await reconnectSlack();
      setShippedSlackReconnectRequired(false);
      toast("Approve image access in Slack, then send again");
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "Couldn't reconnect Slack",
      );
    }
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
  // Initial scrolling must wait for this session's transcript_init. During a
  // session switch, entries from the previous session remain rendered until the
  // WebSocket response arrives and must not consume the new session's scroll.
  const transcriptReadySessionRef = useRef<string | null>(
    cachedTranscript ? session.id : null,
  );
  // Reconnect resume cursor: endOffset/rev of the last transcript frame the
  // server sent (transcript_init/append). On a re-watch of the SAME session
  // with entries still mounted, it rides the watch message as
  // sinceOffset/sinceRev so the server replays only the gap from the mirror
  // jsonl instead of replacing the whole tail.
  const transcriptCursorRef = useRef<{
    sessionId: string;
    rev: string;
    offset: number;
  } | null>(cachedTranscript?.cursor ?? null);
  // Transcript v2 seq mode (docs/transcripts.md): when init/append
  // frames carry seq fields the server is serving from the owned store —
  // resume watches with sinceSeq, page older history with beforeSeq, and
  // ignore offset/rev cursors while in this mode. null = legacy mode (old
  // server or ineligible session): behavior byte-identical to pre-v2.
  // lastSeq tracks the newest seq seen (max — upsert republishes reuse old
  // seqs); firstSeq the earliest loaded (the "load earlier" cursor).
  const transcriptSeqRef = useRef<{
    sessionId: string;
    lastSeq: number;
    firstSeq: number | null;
    lastChangeSeq: number;
  } | null>(cachedTranscript?.seq ?? null);
  // Existing engine-backed sessions can load from the owned transcript store even
  // when no mirror file exists. Fresh sessions never ran, so they still render
  // the empty canvas without flashing a loader. `ran` and not the engine ids:
  // this is the FIRST render, before the session's detail has hydrated, and
  // the list row carries the answer where it no longer carries the ids.
  const [loading, setLoading] = useState(!cachedTranscript && !!session.ran);
  // Cached transcripts stay visible while the watch handshake catches them up.
  // That background sync is intentionally silent: it does not block reading or
  // sending, and a loader at the live edge looks like part of the conversation.
  // The initial transcript is the tail only when the file is large; these drive
  // the "load earlier history" affordance at the top of the conversation.
  const [historyTruncated, setHistoryTruncated] = useState(
    cachedTranscript?.historyTruncated ?? false,
  );
  const [loadingHistory, setLoadingHistory] = useState(false);
  // The whole-history actions walk backward a page at a time. The walk is
  // driven from the transcript_history handler (each page schedules the next),
  // so its state lives in a ref; `loaded` enforces the ceiling and
  // `cursor` catches a backlog that stops receding (a transcript whose
  // earliest surviving entry isn't seq 1 reports "truncated" forever).
  const historyWalkRef = useRef<{
    sessionId: string;
    loaded: number;
    cursor: number | null;
  } | null>(null);
  // An ordinary history load walks until it reaches a user/system boundary.
  // A raw page can otherwise land wholly inside one collapsed work turn, which
  // makes a successful load look like a no-op. This stays separate from the
  // explicit whole-history walk and has its own small ceiling.
  const historyRevealRef = useRef<{
    sessionId: string;
    loaded: number;
    cursor: number | null;
  } | null>(null);
  // One extra page downloads after the initial view settles. It starts only
  // while the reader is still at the live edge; an upward gesture adopts the
  // in-flight request into historyRevealRef and gives it the normal scroll hold.
  const backgroundHistoryRef = useRef(false);
  const backgroundHistoryAttemptedRef = useRef(false);
  const [loadingAllHistory, setLoadingAllHistory] = useState(false);
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
  // Byte offset the loaded history begins at — the "load earlier" pagination
  // cursor (server: parseTranscriptTail/parseTranscriptWindow startOffset).
  // null = unknown (old server) → load_history falls back to the full resend.
  const historyStartRef = useRef<number | null>(
    cachedTranscript?.historyStart ?? null,
  );
  // Scroll anchor for "Load earlier history":
  // older entries prepend above the viewport, so keep the reader on the same
  // content. See startHistoryHold below — a DOM-element anchor plus a short
  // rAF hold, because a one-shot scrollTop restore breaks in three ways:
  // bottom growth (streaming) skews scrollHeight math, prepended bubbles
  // enter at their content-visibility estimate (80px) and re-size as they
  // render, and Safari has no native scroll anchoring to compensate.
  const historyHoldRef = useRef<{
    node: HTMLElement;
    top: number;
    eid: string | null;
    eidTop: number | null;
    until: number;
    raf: number;
    fallback: { height: number; top: number } | null;
  } | null>(null);
  // The composer draft lives INSIDE Composer (uncontrolled mode) so keystrokes
  // don't re-render this whole component; the text arrives via handleSend.
  // Same fix as the CommentableDiff draft-text gotcha.
  // Text + attachments persist in the draft store (keyed per session) so
  // switching to another session/workspace — which remounts this component —
  // doesn't lose typed work. Text rides Composer's `draftKey`; the staged
  // images/files live here, seeded from and mirrored into the same draft.
  const draftKey = `session:${session.id}`;
  const [images, setImages] = useState<string[]>(
    () => loadDraft(draftKey).images,
  );
  const [files, setFiles] = useState<FileAttachment[]>(
    () => loadDraft(draftKey).files,
  );
  const uploads = useAttachmentUploads();
  const uploadStaging = uploads.staging;
  const dragDepthRef = useRef(0);
  const fileDragPresentRef = useRef(false);
  const cancelledFileDragRef = useRef(false);
  const fileDragWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [fileDragActive, setFileDragActive] = useState(false);
  useEffect(() => {
    saveDraft(draftKey, { images, files });
  }, [draftKey, images, files]);
  // When set, the next send forks a new session from either the current tip or
  // a specific earlier message instead of continuing this one.
  const [forkFrom, setForkFrom] = useState<PendingSessionFork | null>(null);
  useEffect(() => {
    const applyPendingFork = () => {
      const target = takePendingSessionFork(session.id);
      if (target) setForkFrom(target);
    };
    applyPendingFork();
    return onPendingSessionFork((sessionId) => {
      if (sessionId === session.id) applyPendingFork();
    });
  }, [session.id]);
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
  // Bumped on git pushes and matching GitHub webhook events so every mounted PR
  // surface revalidates immediately.
  const [gitRefreshTick, setGitRefreshTick] = useState(0);
  const sessionPrTargetsRef = useRef<Set<string>>(new Set());
  useLayoutEffect(() => {
    sessionPrTargetsRef.current = new Set([
      `${session.repo || "repository"}\0${session.branch}`,
      ...(session.attachedRepos || []).map(
        (repo) => `${repo.repo}\0${repo.branch}`,
      ),
      ...(session.prs || []).map((ref) => `${ref.repo}\0${ref.branch}`),
    ]);
  }, [session.repo, session.branch, session.attachedRepos, session.prs]);
  const [viewers, setViewers] = useState<string[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  // The create run is still preparing this session's worktree (new workspaces
  // announce the session before the slow git work). While true the conversation
  // shows creation progress, and the opening message holds above the composer.
  // Flipped off by the workspace_status event, kept in sync with
  // the sessions poll otherwise.
  const [workspacePreparing, setWorkspacePreparing] = useState(
    !!session.workspacePreparing,
  );
  useEffect(() => {
    setWorkspacePreparing(!!session.workspacePreparing);
  }, [session.workspacePreparing]);
  // Drag-to-reorder bookkeeping. onReorder fires continuously during a drag, so
  // we only reorder locally then flush the final order to the server on drop —
  // broadcasting mid-drag would swap the item references out from under Motion
  // and drop the gesture. draggingQueueRef gates the incoming queue_update the
  // same way, so an unrelated broadcast can't yank the list while dragging.
  const draggingQueueRef = useRef(false);
  const pendingReorderRef = useRef<QueueReceipt[] | null>(null);
  // Delivery ownership stays server-side, but sent steering messages live in
  // the conversation. These ids only give their bubbles a quiet pending
  // treatment until the engine confirms it has read them.
  // One-shot draft injection into the Composer (bump seq to apply) — how
  // "edit queued message" puts the text back into the input.
  const [composerPrefill, setComposerPrefill] = useState<{
    seq: number;
    text: string;
    replace?: boolean;
  } | null>(null);
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
  // Optimistic just-sent messages, shown instantly and reconciled once the real
  // turn lands (transcript) or the server confirms it as queued (busy path).
  // `busyMode` marks a send made while the run was busy: it renders inside the
  // queue flap (as "Queueing…") instead of as a transcript bubble.
  const [pending, setPending] = useState<OptimisticPendingPrompt[]>(() =>
    initialPending
      ? [
          {
            id: `pending-initial-${session.id}`,
            transcriptAfterEntryId: null,
            ...initialPending,
          },
        ]
      : [],
  );
  // Read by the reconcile effect below, which must not re-run on every send.
  const pendingRef = useRef(pending);
  useLayoutEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  // Pending ids the server has CONFIRMED (transcript entry or queue/steer
  // receipt). Their durable outbox row is hidden, so one message can't render
  // as a transcript bubble and a "Sending" flap row at the same time.
  const [landedOutboxIds, setLandedOutboxIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [outboxItems, setOutboxItems] = useState<PromptOutboxItem[]>(() =>
    promptOutbox.list(session.id),
  );
  useEffect(() => {
    const stopObserving = promptOutbox.observeDelivery((item, result) => {
      if (item.sessionId !== session.id) return;
      const pendingId = `outbox-${item.clientId}`;
      const deliveredPrompt: OptimisticPendingPrompt = {
        id: pendingId,
        content: item.content,
        user: item.user || getCurrentUser(),
        sentAt: item.createdAt,
        transcriptAfterEntryId: item.transcriptAfterEntryId,
        transcriptAfterSeq: item.transcriptAfterSeq,
        ...(item.images?.length ? { images: item.images } : {}),
      };
      if (result.status === "started") {
        // Placement guessed from local running state can lose a turn-end race.
        // The server started a turn, so this is an optimistic transcript bubble,
        // not a queued row.
        setPending((current) => markPendingStarted(current, deliveredPrompt));
        dispatchSessionRuntime({ type: "mark_running" });
        return;
      }
      if (result.status === "queued" || result.status === "steered") {
        // Queued messages stay above the composer. A steer is already sent, so
        // it stays in the conversation while the engine catches up.
        setPending((current) =>
          markPendingBusy(
            current,
            deliveredPrompt,
            result.status === "queued" ? "queue" : "steer",
          ),
        );
        dispatchSessionRuntime({ type: "mark_running" });
        return;
      }
      if (result.status !== "handled") return;
      // Slash commands are consumed by Open Session, so no user transcript
      // entry or queue echo will ever reconcile their optimistic row. The old
      // WebSocket composer received an inline notice; preserve that feedback
      // now that sends travel through the durable REST outbox.
      setPending((current) =>
        current.filter((entry) => entry.id !== pendingId),
      );
      const noticeId = `prompt-delivery-${result.deliveryId || item.clientId}`;
      setEntries((current) =>
        current.some((entry) => entry.id === noticeId)
          ? current
          : [
              ...current,
              {
                id: noticeId,
                type: "system",
                content: result.message,
                timestamp: new Date().toISOString(),
              },
            ],
      );
    });
    const sync = () => {
      const items = promptOutbox.list(session.id);
      setOutboxItems(items);
      // Forget claims the outbox no longer holds (delivered, discarded, or
      // another session's), so the set can't grow for the life of the tab.
      setLandedOutboxIds((prev) => {
        if (prev.size === 0) return prev;
        const live = new Set(items.map((i) => `outbox-${i.clientId}`));
        const next = new Set([...prev].filter((id) => live.has(id)));
        return next.size === prev.size ? prev : next;
      });
    };
    sync();
    const unsubscribe = promptOutbox.subscribe(sync);
    void promptOutbox.flush();
    return () => {
      unsubscribe();
      stopObserving();
    };
  }, [dispatchSessionRuntime, session.id, setEntries]);
  useEffect(() => {
    if (connected) void promptOutbox.flush();
  }, [connected]);
  useEffect(() => {
    if (!initialPending) return;
    const content = initialPending.content.trim();
    setPending((prev) => {
      if (prev.some((p) => p.id === `pending-initial-${session.id}`))
        return prev;
      if (
        entries.some(
          (e) =>
            e.type === "user" && (!content || e.content.trim() === content),
        )
      ) {
        return prev;
      }
      return [
        ...prev,
        {
          id: `pending-initial-${session.id}`,
          transcriptAfterEntryId: null,
          ...initialPending,
        },
      ];
    });
  }, [entries, initialPending, session.id, setEntries]);
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
  const [pinned, setPinned] = useState(() => isPinned(session.id));
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
  async function addSessionAttachments(picked: FileList | File[]) {
    const selected = Array.from(picked);
    const noteImageTypes = new Set([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
    ]);
    const disallowed = noteMode
      ? selected.filter((file) => !noteImageTypes.has(file.type))
      : [];
    const accepted = noteMode
      ? selected.filter((file) => noteImageTypes.has(file.type))
      : selected;
    const results = await uploads.upload(accepted, (file, signal) =>
      attachToDraft(draftKey, [file], signal),
    );
    if (results.some((result) => result.applied)) {
      const stored = loadDraft(draftKey);
      setImages((current) =>
        sameImages(current, stored.images) ? current : stored.images,
      );
      setFiles((current) =>
        sameFiles(current, stored.files) ? current : stored.files,
      );
    }
    const failures = [
      ...results.flatMap((result) => result.rejected),
      ...disallowed.map(
        (file) => `${file.name} (notes accept PNG, JPEG, GIF, or WebP images)`,
      ),
    ];
    if (failures.length) alert(`Couldn't attach:\n${failures.join("\n")}`);
  }

  function resetFileDrag() {
    dragDepthRef.current = 0;
    setFileDragActive(false);
  }
  function finishFileDrag() {
    if (fileDragWatchdogRef.current) clearTimeout(fileDragWatchdogRef.current);
    fileDragWatchdogRef.current = null;
    resetFileDrag();
    fileDragPresentRef.current = false;
    cancelledFileDragRef.current = false;
  }
  function armFileDragWatchdog() {
    if (fileDragWatchdogRef.current) clearTimeout(fileDragWatchdogRef.current);
    fileDragWatchdogRef.current = setTimeout(finishFileDrag, 500);
  }
  const dropAttachments = useEffectEvent((picked: FileList | File[]) =>
    addSessionAttachments(picked),
  );
  useEffect(() => {
    // Own external file drags at the window, not on the conversation node.
    // Dialogs and sheets portal to document.body, so a node-scoped handler
    // loses the drag as soon as it crosses their backdrop. Only the focused
    // conversation subscribes, which also keeps split panes from attaching the
    // same drop twice.
    if (!focused || sessionHidden) {
      finishFileDrag();
      return;
    }
    function cancelFileDrag(event: KeyboardEvent) {
      if (event.key !== "Escape" || !fileDragPresentRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancelledFileDragRef.current = true;
      resetFileDrag();
      armFileDragWatchdog();
    }
    function finishNativeDrag() {
      finishFileDrag();
    }
    function handleFileDragEnter(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      if (foregroundFileComposerOpen()) {
        finishFileDrag();
        return;
      }
      event.preventDefault();
      armFileDragWatchdog();
      if (cancelledFileDragRef.current) return;
      if (!fileDragPresentRef.current) {
        fileDragPresentRef.current = true;
        dragDepthRef.current = 0;
      }
      dragDepthRef.current += 1;
      setFileDragActive(true);
    }
    function handleFileDragLeave(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      if (foregroundFileComposerOpen()) {
        finishFileDrag();
        return;
      }
      const next = event.relatedTarget;
      const leftApp =
        !(next instanceof Node) || !document.documentElement.contains(next);
      if (cancelledFileDragRef.current) {
        if (leftApp) finishFileDrag();
        else resetFileDrag();
        return;
      }
      // Escape during an external file drag is owned by the browser on some
      // platforms. Its observable signal is a final leave with no drop effect.
      if (event.dataTransfer?.dropEffect === "none") {
        finishFileDrag();
        return;
      }
      if (leftApp) {
        finishFileDrag();
        return;
      }
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setFileDragActive(false);
    }
    function handleFileDragOver(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      if (foregroundFileComposerOpen()) {
        finishFileDrag();
        return;
      }
      event.preventDefault();
      armFileDragWatchdog();
      if (cancelledFileDragRef.current) {
        if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
        return;
      }
      if (!fileDragPresentRef.current) {
        fileDragPresentRef.current = true;
        dragDepthRef.current = 1;
        setFileDragActive(true);
      }
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
    function handleFileDrop(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      if (foregroundFileComposerOpen()) {
        finishFileDrag();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const cancelled = cancelledFileDragRef.current;
      const dropped = event.dataTransfer?.files;
      finishFileDrag();
      if (!cancelled && dropped?.length) void dropAttachments(dropped);
    }
    // Capture before modal backdrops and the composer. Listen for keyup too:
    // Chromium can consume keydown while it owns a native OS drag.
    window.addEventListener("keydown", cancelFileDrag, true);
    window.addEventListener("keyup", cancelFileDrag, true);
    window.addEventListener("dragenter", handleFileDragEnter, true);
    window.addEventListener("dragleave", handleFileDragLeave, true);
    window.addEventListener("dragover", handleFileDragOver, true);
    window.addEventListener("drop", handleFileDrop, true);
    window.addEventListener("dragend", finishNativeDrag, true);
    return () => {
      finishFileDrag();
      window.removeEventListener("keydown", cancelFileDrag, true);
      window.removeEventListener("keyup", cancelFileDrag, true);
      window.removeEventListener("dragenter", handleFileDragEnter, true);
      window.removeEventListener("dragleave", handleFileDragLeave, true);
      window.removeEventListener("dragover", handleFileDragOver, true);
      window.removeEventListener("drop", handleFileDrop, true);
      window.removeEventListener("dragend", finishNativeDrag, true);
    };
  }, [focused, sessionHidden, draftKey, noteMode]);
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
  // Intent-aware scrolling: stick to the live edge only while the reader is there,
  // pin new turns near the top, and surface a "Jump to latest" affordance.
  const {
    containerRef: messagesRef,
    setContainerRef: setMessagesRef,
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
    suspendEndMaintenance,
    onScroll,
  } = useSessionScroll(true);
  // An explicit tail action first resumes live-edge following immediately,
  // then needs one more positioning pass after React commits its DOM change.
  // Scrolling only in the event handler targets the old scrollHeight: a sent
  // row does not exist yet, while an answered ask is about to disappear.
  // Either transition can otherwise leave the response below the composer.
  const tailActionNeedsLayoutScrollRef = useRef(false);

  // A fold toggle (turn work blocks, tool-call details, review loops) changes
  // block heights above the reader. Hold the live-edge glue off for the two
  // frames the layout needs to settle so it cannot drag the reader off the
  // block they just opened or read the movement as intent to leave.
  useEffect(
    () => onTranscriptDisclosure(suspendEndMaintenance),
    [suspendEndMaintenance],
  );

  // Open-settle curtain: indexed transcripts normally lift on positive proof
  // that their complete outline and real near-visible rows have settled. On a
  // phone under CPU pressure transcript_index can arrive seconds after the
  // bounded init, so its fallback is deliberately longer than legacy mode's.
  // It is still bounded: a dropped index frame or a virtualizer that cannot
  // report visible rows must reveal the readable tail instead of leaving an
  // apparently empty conversation forever.
  const [openSettlePending, setOpenSettlePending] = useState(true);
  const transcriptRendered =
    !loading && (entries.length > 0 || Boolean(transcriptIndex));
  useEffect(() => {
    if (!transcriptRendered) return;
    const timer = window.setTimeout(
      () => setOpenSettlePending(false),
      transcriptIndexExpected
        ? INDEXED_OPEN_SETTLE_MAX_MS
        : LEGACY_OPEN_SETTLE_MAX_MS,
    );
    return () => window.clearTimeout(timer);
  }, [transcriptIndexExpected, transcriptRendered]);
  const onVisibleRangesSettled = useCallback(() => {
    settleVisibleRanges({
      followingLive,
      scrollToLatest,
      onSettled: () => setOpenSettlePending(false),
    });
  }, [followingLive, scrollToLatest, settleVisibleRanges]);
  const [viewerInput, setViewerInput] = useState<HTMLDivElement | null>(null);
  // The focused phone composer is fixed above the keyboard, so it contributes
  // no height to the transcript's flex layout. Publish its real height without
  // re-rendering on each draft line: the scroll padding can then clear the
  // whole composer instead of assuming the resting one-row pill.
  useLayoutEffect(() => {
    if (!viewerInput || typeof ResizeObserver === "undefined") return;
    const region = viewerInput.parentElement;
    if (!region) return;
    const measure = () => {
      region.style.setProperty(
        "--viewer-input-height",
        `${Math.ceil(viewerInput.getBoundingClientRect().height)}px`,
      );
      relayout();
    };
    measure();
    const observer = new ResizeObserver(measure);
    // Keyboard focus changes the wrapper's padding, not its content box.
    observer.observe(viewerInput, { box: "border-box" });
    return () => {
      observer.disconnect();
      region.style.removeProperty("--viewer-input-height");
    };
  }, [relayout, viewerInput]);

  useTranscriptIndexAnchor({
    indexState: transcriptIndexState,
    restorePendingIndexPosition,
    containerRef: messagesRef,
    scrollToLatest,
    leaveLatest,
  });

  // Keep the cached snapshot current as live frames and history pages land.
  // Scroll position is updated synchronously in handleMessagesScroll below;
  // the anchor is carried rather than recomputed, because this runs on every
  // streamed frame and pickScrollAnchor reads a rect per [data-eid] node.
  useEffect(() => {
    if (transcriptReadySessionRef.current !== session.id) return;
    const previous = cachedTranscriptView(session.id);
    const el = messagesRef.current;
    cacheTranscriptView(session.id, {
      entries,
      cursor: transcriptCursorRef.current,
      seq: transcriptSeqRef.current,
      historyTruncated,
      historyStart: historyStartRef.current,
      index: transcriptIndex,
      indexEpoch: transcriptIndexEpochRef.current,
      scrollTop: el?.scrollTop ?? previous?.scrollTop ?? 0,
      following,
      anchorEid: previous?.anchorEid ?? null,
      anchorTop: previous?.anchorTop ?? null,
    });
  }, [
    entries,
    following,
    historyTruncated,
    messagesRef,
    session.id,
    transcriptIndex,
    transcriptIndexEpochRef,
  ]);
  // Where the anchor is computed. Nothing reads it until this session is
  // opened again, and pickScrollAnchor reads a rect per [data-eid] node, so
  // it runs once the reader settles instead of on every scroll event and
  // every streamed frame.
  const captureScrollAnchor = useCallback(() => {
    const el = messagesRef.current;
    const cached = peekCachedTranscriptView(session.id);
    if (!el || !cached) return;
    // Nothing qualifying at the top edge clears the pair, rather than
    // leaving one the reader has scrolled away from.
    const anchor = pickScrollAnchor(el);
    cacheTranscriptView(session.id, {
      ...cached,
      scrollTop: el.scrollTop,
      following: readFollowingLive(followingLive),
      anchorEid: anchor?.dataset.eid ?? null,
      anchorTop: anchor
        ? anchor.getBoundingClientRect().top - el.getBoundingClientRect().top
        : null,
    });
  }, [followingLive, messagesRef, session.id]);
  const anchorCaptureRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleAnchorCapture = useCallback(() => {
    if (anchorCaptureRef.current) clearTimeout(anchorCaptureRef.current);
    anchorCaptureRef.current = setTimeout(captureScrollAnchor, 250);
  }, [captureScrollAnchor]);
  // And once more on the way out, so the last thing the reader did is what a
  // switch back restores to. App keys SessionViewer on the session id
  // (App.tsx), so this cleanup still sees the transcript it measures: React
  // commits deletions before insertions.
  useLayoutEffect(() => {
    return () => {
      if (anchorCaptureRef.current) clearTimeout(anchorCaptureRef.current);
      anchorCaptureRef.current = null;
      captureScrollAnchor();
    };
  }, [captureScrollAnchor]);
  useEffect(() => {
    setEntries((prev) => withModelSwitches(prev, session.modelHistory));
  }, [session.modelHistory, setEntries]);

  // The hold: keep an anchor element at a stable content offset while history
  // prepends above it and the new bubbles' heights settle (content-visibility
  // estimates resolve to real sizes as they render). `overflow-anchor: none`
  // for the duration so Chrome's native scroll anchoring doesn't compensate
  // the same shift twice; Safari has no native anchoring, so without this
  // hold it loses the reader's position outright. Content-space offsets
  // (rect relative to container + scrollTop) are scroll-invariant, so the
  // reader's own scrolling composes cleanly with the compensation.
  const stopHistoryHold = useCallback(() => {
    const h = historyHoldRef.current;
    if (!h) return;
    cancelAnimationFrame(h.raf);
    historyHoldRef.current = null;
    const el = messagesRef.current;
    if (el) el.style.overflowAnchor = "";
  }, [messagesRef]);
  // Ref mirror keeps rapid clicks from sending duplicate history requests
  // before React re-renders with the disabled button.
  const loadingHistoryRef = useRef(false);
  useEffect(() => {
    loadingHistoryRef.current = loadingHistory;
  }, [loadingHistory]);
  // One page request. `whole` is the whole-history variant: a fat page in seq
  // mode, and in legacy mode the deliberately cursor-less request the server
  // answers with the entire transcript in one transcript_init — byte-window
  // paging has no cheap way to walk a backlog, and that full resend has always
  // been its fallback.
  const requestHistoryPage = useCallback(
    (whole = false) => {
      const seqState = transcriptSeqRef.current;
      if (seqState?.sessionId === session.id) {
        // Seq mode (transcript v2): page backwards from the earliest seq we
        // hold. Without a usable cursor the server falls back to a full
        // legacy resend, same as the legacy no-offset case below.
        send({
          type: "load_history",
          sessionId: session.id,
          ...(seqState.firstSeq !== null && seqState.firstSeq > 1
            ? { beforeSeq: seqState.firstSeq }
            : {}),
          limit: whole ? JUMP_PAGE_ENTRIES : HISTORY_PAGE_ENTRIES,
        });
        return;
      }
      const cursor = transcriptCursorRef.current;
      send({
        type: "load_history",
        sessionId: session.id,
        ...(!whole &&
        historyStartRef.current !== null &&
        historyStartRef.current > 0
          ? {
              beforeOffset: historyStartRef.current,
              beforeRev:
                cursor?.sessionId === session.id ? cursor.rev : undefined,
            }
          : {}),
      });
    },
    [send, session.id],
  );
  // The whole backlog, one click: each page's arrival schedules the next (see
  // the transcript_history handler). `loadingHistory` deliberately stays true
  // across the gaps, which is what keeps the auto-load sentinel and a second
  // click from interleaving requests of their own.
  const finishHistoryWalk = useCallback(() => {
    if (!historyWalkRef.current) return;
    historyWalkRef.current = null;
    setLoadingAllHistory(false);
    stopHistoryHold();
  }, [stopHistoryHold]);

  const startHistoryHold = useCallback(
    (
      node: HTMLElement,
      ms: number,
      fallback: { height: number; top: number } | null,
    ) => {
      const el = messagesRef.current;
      if (!el) return;
      stopHistoryHold();
      el.style.overflowAnchor = "none";
      const contentTopOf = (n: HTMLElement, c: HTMLElement) =>
        n.getBoundingClientRect().top -
        c.getBoundingClientRect().top +
        c.scrollTop;
      // Two anchor layers: the tight node for frame-to-frame deltas, and its
      // nearest [data-eid] ancestor as a *recovery identity* — when a prepend
      // merges into the anchor's turn block the whole block remounts (its key
      // is its first item id) and every DOM node dies, but the same entry
      // re-renders under the same data-eid.
      const idEl = (node.closest?.("[data-eid]") as HTMLElement | null) ?? null;
      const hold = {
        node,
        top: contentTopOf(node, el),
        eid: idEl?.dataset.eid ?? null,
        eidTop: idEl ? contentTopOf(idEl, el) : null,
        until: performance.now() + ms,
        raf: 0,
        fallback,
      };
      historyHoldRef.current = hold;
      const tick = () => {
        const h = historyHoldRef.current;
        const c = messagesRef.current;
        if (!h || h !== hold || !c) return;
        if (performance.now() > h.until || readFollowingLive(followingLive)) {
          stopHistoryHold();
          return;
        }
        if (h.node.isConnected) {
          const t = contentTopOf(h.node, c);
          const d = t - h.top;
          if (d !== 0) c.scrollTop += d;
          h.top = t;
          // Keep the recovery identity fresh: cheap ancestor walk, and the
          // content offset re-measured so a later remount recovers to the
          // reader's latest position, not the hold's starting one.
          const id2 = h.node.closest?.("[data-eid]") as HTMLElement | null;
          h.eid = id2?.dataset.eid ?? h.eid;
          h.eidTop = id2 ? contentTopOf(id2, c) : h.eidTop;
        } else {
          // Anchor DOM died (block remount). Recover through the entry id:
          // same content, new nodes — shift by how far it moved.
          const revived =
            h.eid && typeof CSS !== "undefined"
              ? c.querySelector<HTMLElement>(
                  `[data-eid="${CSS.escape(h.eid)}"]`,
                )
              : null;
          if (revived && h.eidTop !== null) {
            const d = contentTopOf(revived, c) - h.eidTop;
            if (d !== 0) c.scrollTop += d;
          } else if (h.fallback) {
            // Last resort: height math. Skewed by content-visibility
            // estimate resets, but better than staying at a raw offset.
            c.scrollTop = c.scrollHeight - h.fallback.height + h.fallback.top;
          }
          h.fallback = null;
          const next = revived ?? pickScrollAnchor(c);
          if (!next) {
            stopHistoryHold();
            return;
          }
          const nid =
            (next.closest?.("[data-eid]") as HTMLElement | null) ?? null;
          h.node = next;
          h.top = contentTopOf(next, c);
          h.eid = nid?.dataset.eid ?? null;
          h.eidTop = nid ? contentTopOf(nid, c) : null;
        }
        h.raf = requestAnimationFrame(tick);
      };
      hold.raf = requestAnimationFrame(tick);
    },
    [messagesRef, stopHistoryHold, followingLive],
  );
  // A page's worth of settling outlives its arrival, not the request: slow
  // fetches shouldn't burn the hold window, so extend it when a load lands.
  useEffect(() => {
    if (loadingHistory) return;
    const h = historyHoldRef.current;
    if (h) h.until = Math.max(h.until, performance.now() + 2500);
  }, [loadingHistory]);
  useEffect(() => stopHistoryHold, [session.id, stopHistoryHold]);
  // Switching sessions abandons an in-flight whole-history walk (its pages are
  // session-guarded anyway) — without this the flag would outlive it and keep
  // the control stuck in its loading state.
  useEffect(() => {
    return () => {
      historyWalkRef.current = null;
      historyRevealRef.current = null;
      backgroundHistoryRef.current = false;
      setLoadingAllHistory(false);
    };
  }, [session.id]);

  // Per-session model (switchable from the composer; "" = default)
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  // Pinnable Claude/Codex accounts + this session's pin ("" = auto pool).
  const [accounts, setAccounts] = useState<ProviderAccountOption[]>([]);
  const [accountId, setAccountId] = useState(session.accountId || "");
  // Live token/cost accounting is seeded from the session and updated per run
  // through the `usage_update` broadcast in useSessionRuntime.
  // Reasoning effort — a composer control mirroring the new-session palette.
  // Persisted on the session server-side and enforced per run (Claude effort /
  // Codex modelReasoningEffort), so seed from the session's stored value.
  const [effort, setEffort] = useState(session.effort || "high");
  const [fastMode, setFastMode] = useState(session.fastMode || false);
  // Optimistic goal: reflects a just-set/cleared goal instantly (the /goal
  // command persists server-side but doesn't broadcast a live session update).
  // `undefined` = defer to session.goal; a string/null = the pending override.
  const [goalOverride, setGoalOverride] = useState<string | null | undefined>(
    undefined,
  );
  // Drop the override once the server-side session catches up (or we switch).
  useEffect(() => setGoalOverride(undefined), [session.id, session.goal]);
  const currentGoal =
    goalOverride !== undefined ? goalOverride : (session.goal ?? null);
  useEffect(() => {
    fetchModels(session.workspaceId || undefined)
      .then((m) => {
        setModels(m.models);
        setDefaultModel(m.default);
      })
      .catch(() => {});
    fetchProviderAccounts()
      .then(setAccounts)
      .catch(() => {});
  }, [session.workspaceId]);
  useEffect(() => {
    dispatchSessionRuntime({
      type: "sync_model",
      model: session.model || "",
    });
  }, [dispatchSessionRuntime, session.id, session.model]);
  useEffect(() => {
    setAccountId(session.accountId || "");
  }, [session.id, session.accountId]);
  useEffect(() => {
    setEffort(session.effort || "high");
  }, [session.id, session.effort]);
  useEffect(() => {
    setFastMode(session.fastMode || false);
  }, [session.id, session.fastMode]);
  useEffect(() => {
    dispatchSessionRuntime({ type: "sync_usage", usage: session.usage });
  }, [dispatchSessionRuntime, session.id, session.usage]);

  // Dynamic workflow runs (opensession-workflows MCP): seeded by a fetch on
  // open/session switch, then kept live by workflow_update broadcasts. Powers
  // the Agents tab — hidden entirely while empty.
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunSnapshot[]>([]);
  // True once the seed fetch for the current session has settled — the
  // runs-vanished fallback below must not flip tabs off an empty [] mid-fetch.
  const [workflowsLoaded, setWorkflowsLoaded] = useState(false);
  useEffect(() => {
    let stale = false;
    setWorkflowRuns([]);
    setWorkflowsLoaded(false);
    fetch(
      `${BASE_PATH}/api/sessions/${encodeURIComponent(session.id)}/workflows`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (stale) return;
        if (Array.isArray(d?.runs)) {
          const fetched = d.runs as WorkflowRunSnapshot[];
          // WS upserts may have landed while the fetch was in flight — those
          // snapshots are newer than the seed, so keep them and only add
          // fetched runs we don't have yet (the panel re-sorts by startedAt).
          setWorkflowRuns((prev) => {
            const have = new Set(prev.map((r) => r.runId));
            const added = fetched.filter((r) => !have.has(r.runId));
            return added.length ? [...prev, ...added] : prev;
          });
        }
        setWorkflowsLoaded(true);
      })
      .catch(() => {
        if (!stale) setWorkflowsLoaded(true);
      });
    return () => {
      stale = true;
    };
  }, [session.id]);
  function workflowAction(
    runId: string,
    action: "cancel" | "pause" | "resume" | "skip" | "retry",
    seq?: number,
  ) {
    // Fire-and-forget: workflow_update echoes every state transition. Resume
    // after a process restart may create a new run, which arrives as another
    // workflow_update on the same session.
    const suffix =
      action === "skip" || action === "retry"
        ? `/agents/${seq}/${action}`
        : `/${action}`;
    fetch(`${BASE_PATH}/api/workflows/${encodeURIComponent(runId)}${suffix}`, {
      method: "POST",
    }).catch(() => {});
  }

  // Sub-agents the session spawned directly (pi task-tool children /
  // SDK Task agents) — shown in the Agents tab next to workflow runs. Seeded
  // here; the polling effect below (after isBusy exists) keeps them live.
  const [subagents, setSubagents] = useState<SessionSubagentSnapshot[]>([]);
  useEffect(() => setSubagents([]), [session.id]);

  // Keep the pin star in sync with the store (changes can come from the tab bar
  // or the Home screen) and reset when switching sessions.
  const currentUser = useCurrentUser();
  useEffect(() => setPinned(isPinned(session.id)), [session.id]);
  useEffect(
    () => onPinsChanged(() => setPinned(isPinned(session.id))),
    [session.id],
  );

  // Claimed into your own sidebar lanes (lib/lanes.ts) — the whole workspace,
  // since that's the unit the sidebar row claims. Lanes live in a module cache
  // like pins, so mirror it into state and re-read on every change.
  const claimSessions = workspaceSessions?.length
    ? workspaceSessions
    : [session];
  const claimIds = claimSessions.map((c) => c.id).join(",");
  const claimedGlobally = claimSessions.some((c) => !!c.manualStatus);
  const [claimedLane, setClaimedLane] = useState(false);
  useEffect(() => {
    const read = () =>
      setClaimedLane(claimIds.split(",").some((id) => !!getLane(id)));
    read();
    return onLanesChanged(read);
  }, [claimIds]);
  const claimed = claimedLane || claimedGlobally;
  const hiddenFromSidebar = useSyncExternalStore(
    onHidesChanged,
    () => isHiddenForSession(session),
    () => false,
  );
  // A linked session can be open without belonging to your sidebar: teammate
  // work, automation runs and agent-spawned probes all stay out until claimed.
  // A session you started (or a workspace with one) already renders in your
  // sidebar bands without a lane claim, so it must not offer Add to sidebar.
  const naturallyInSidebar = claimSessions.some(
    (c) => !c.spawnedBy && !c.automation && ownedBy(c, currentUser),
  );
  const canKeepInSidebar =
    !session.archived &&
    !!onSetStatus &&
    (hiddenFromSidebar || (!claimed && !naturallyInSidebar));
  function keepInSidebar() {
    unhideForSession(session);
    if (!claimed && !naturallyInSidebar) onSetStatus?.(claimSessions, "mine");
  }
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (
        !focused ||
        e.defaultPrevented ||
        !matchesShortcut(e, "session-pin") ||
        blockingOverlayOpen()
      ) {
        return;
      }
      e.preventDefault();
      togglePin(session.id);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focused, session.id]);

  // Switching modes is immediate in the interface. The only slow part is the
  // workspace setup behind it, so code affordances appear now and show their
  // own setup state until the server has cut the branch.
  const [promoting, setPromoting] = useState(false);
  const [promotionReady, setPromotionReady] = useState(false);
  const codeMode = session.mode === "code" || promoting || promotionReady;
  const isAsk = session.mode === "ask" && !codeMode;
  const hasWorkspace = sessionHasWorkspace(session) || codeMode;
  // Everything that only makes sense against a repo: the diff, the Changes
  // tab, the PR strip, the repo switch/attach bar. A repo-less session still
  // has a workspace (terminal, agents, assets run in its scratch dir), so
  // these ride their own flag rather than `hasWorkspace`. Promotion gives a
  // repo-less Ask session the selected/default repo on the server.
  const hasRepoWork = hasWorkspace && (!session.repoLess || codeMode);
  async function handlePromote(onDone?: () => void) {
    if (promoting) return;
    setPromoting(true);
    onDone?.();
    try {
      await promoteSessionApi(session.id);
      setPromotionReady(true);
      setPromoting(false);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not switch to code mode");
      setPromoting(false);
    }
  }
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
  const isBusy = !safety && (isRunningLive || isStreaming);
  // Sub-agent list: fetch on open, then re-poll while the session runs so
  // live task-tool spawns appear/settle. Keyed on isBusy too: a run starting
  // after mount restarts the poll loop, and the flip back to idle lands one
  // final fetch that settles statuses.
  useEffect(() => {
    let stale = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const d = await fetchSessionSubagents(session.id);
        if (stale) return;
        // Keep the previous array when nothing changed: downstream memos
        // (and the LiveSubagents context feeding every ToolCallBlock)
        // only re-render on real updates, not on every 4s poll tick.
        setSubagents((prev) =>
          JSON.stringify(prev) === JSON.stringify(d.subagents)
            ? prev
            : d.subagents,
        );
        if (d.sessionRunning) timer = window.setTimeout(load, 4000);
      } catch {
        // Transient (auth refresh, reload) — the next poll or session
        // switch retries.
      }
    };
    load();
    return () => {
      stale = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [session.id, isBusy]);
  // Task rows learn their child session id from this map while the call is
  // still running (the result text that normally carries it doesn't exist
  // yet), enabling the mid-run "Watch ↗" drill-in.
  const liveSubagents = useMemo(() => {
    const m = new Map<string, LiveSubagent>();
    for (const s of subagents)
      if (s.toolUseId) m.set(s.toolUseId, { id: s.id, status: s.status });
    return m;
  }, [subagents]);
  // Derived, not the raw flag: transcript content or streaming text means the
  // opening run already started, so the worktree is done — this guards against
  // a stale sessions poll re-asserting the flag after the workspace_status
  // event already cleared it.
  const waitingForWorkspace =
    promoting ||
    (workspacePreparing && entries.length === 0 && !liveTurnStore.hasText());
  // A sibling session already owns a ready workspace, so its optimistic shell
  // can show the blank conversation and composer immediately. A genuinely new
  // workspace keeps the setup state until its worktree is ready.
  const settingUpWorkspace = waitingForWorkspace && !optimisticEmpty;

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

  // Anchor for the agent-working elapsed timer. A run that starts
  // while we're watching anchors to now; opening a session mid-run anchors to
  // the server's journaled run start (runStartedAt — survives switches and
  // refreshes), falling back to the turn's user prompt in the transcript, so
  // the timer shows the run's real age, not time-since-I-opened-the-tab. The
  // ref tracks which case we're in: it stays true until we've observed the
  // session idle.
  const [busySince, setBusySince] = useState<number | null>(null);
  // When the Stop was asked for, so the click can be acknowledged locally at
  // once. The server's isRunning:false only lands after the aborted turn
  // actually unwinds — an abort signal is observed at the next await, so a
  // long bash command, an MCP call or a retrying model request holds it for
  // seconds — and until then this row went on counting up as if the click had
  // never happened. 18% of stops in the audit log are a second stop on the
  // same session within a minute (median 1.9s apart): people clicking again
  // because the first click showed them nothing.
  const [stopRequestedAt, setStopRequestedAt] = useState<number | null>(null);
  const anchorFromTranscript = useRef(session.isRunning);
  useEffect(() => {
    anchorFromTranscript.current = true;
    setBusySince(null);
    setStopRequestedAt(null);
  }, [session.id]);
  useEffect(() => {
    if (!isBusy) {
      anchorFromTranscript.current = false;
      setBusySince(null);
      setStopRequestedAt(null);
      return;
    }
    // The journaled run start is authoritative whenever we have it — for a
    // run that starts while watching it's ~now anyway (App stamps it on the
    // status flip), and mid-run it's the real start even when a stale
    // isRunning=false at mount already flipped the anchor ref.
    if (session.runStartedAt) {
      const t = Date.parse(session.runStartedAt);
      if (Number.isFinite(t)) {
        setBusySince((prev) => prev ?? t);
        return;
      }
    }
    // Mid-run open: wait for the transcript so we can find the turn's prompt.
    if (anchorFromTranscript.current && loading) return;
    setBusySince((prev) => {
      if (prev != null) return prev;
      if (anchorFromTranscript.current) {
        for (let i = entries.length - 1; i >= 0; i--) {
          if (entries[i].type !== "user") continue;
          const t = new Date(entries[i].timestamp).getTime();
          if (Number.isFinite(t)) return t;
          break;
        }
      }
      return Date.now();
    });
  }, [isBusy, loading, entries, session.runStartedAt]);

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
  }, [focused, models, defaultModel, model, effort]);

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
  const [composerResetSeq, setComposerResetSeq] = useState(newSessionSeq);
  useLayoutEffect(() => {
    if (newSessionSeq === composerResetSeq) return;
    // Clear storage before changing the Composer key. The layout update causes
    // its replacement to initialize only after the stale draft is gone.
    clearDraft(draftKey);
    dropStagingAttachments(draftKey);
    setImages([]);
    setFiles([]);
    setForkFrom(null);
    setComposerResetSeq(newSessionSeq);
    scrollToLatest("smooth");
    composerRef.current?.focus();
  }, [newSessionSeq, composerResetSeq, draftKey, scrollToLatest]);

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

  // Subscribe to WebSocket messages
  const subscribeToSession = useEffectEvent(() => {
    if (!connected) return;

    // Resume rather than re-snapshot when this exact session's transcript is
    // still mounted (a reconnect blip, not a session switch) and we hold a
    // cursor from a previous frame. Seq mode (transcript v2) resumes with
    // sinceSeq; legacy with the byte cursor. supportsSeq advertises the
    // capability — old servers ignore it and behave exactly as before.
    const cursor = transcriptCursorRef.current;
    const seqState = transcriptSeqRef.current;
    const ready = transcriptReadySessionRef.current === session.id;
    const resume =
      ready && seqState?.sessionId === session.id
        ? {
            sinceSeq: seqState.lastSeq,
            sinceChangeSeq: seqState.lastChangeSeq,
          }
        : ready && cursor?.sessionId === session.id
          ? { sinceOffset: cursor.offset, sinceRev: cursor.rev }
          : {};
    const unsubscribe = addHandler((msg) => {
      // Session-scoped messages carry the session id — drop anything meant
      // for a different session. Without this, a socket race (or a lingering
      // creator-side direct send from a session you navigated away from) bleeds
      // another session's stream into this view. Messages without a
      // sessionId (direct replies like slash-command notices) pass through.
      if ("sessionId" in msg && msg.sessionId && msg.sessionId !== session.id) {
        return;
      }
      switch (msg.type) {
        case "workflow_update": {
          // Dynamic workflows: upsert the live run snapshot (already
          // session-filtered by the sessionId gate above).
          const run = msg.run;
          setWorkflowRuns((prev) =>
            prev.some((r) => r.runId === run.runId)
              ? prev.map((r) => (r.runId === run.runId ? run : r))
              : [run, ...prev],
          );
          break;
        }
        case "transcript_init": {
          // Weave persisted model switches into the conversation as dividers.
          const merged = withModelSwitches(msg.entries, session.modelHistory);
          transcriptReadySessionRef.current = session.id;
          // Mode detection (transcript v2): an init carrying seq fields
          // switches this session into seq mode; one without switches it
          // back to legacy (e.g. the flag was turned off — the resume
          // falls back to a full legacy snapshot). Init frames are
          // authoritative for the mode.
          const v2 = msg.v2 === true && typeof msg.lastSeq === "number";
          const existingIndex = existingIndexForInit(v2);
          setIndexMode(v2);
          if (v2) {
            transcriptSeqRef.current = {
              sessionId: session.id,
              lastSeq: msg.lastSeq!,
              firstSeq:
                typeof msg.firstSeq === "number" && msg.firstSeq > 0
                  ? msg.firstSeq
                  : null,
              lastChangeSeq:
                typeof msg.lastChangeSeq === "number"
                  ? msg.lastChangeSeq
                  : msg.lastSeq!,
            };
            // Seq mode ignores offset/rev cursors entirely.
            transcriptCursorRef.current = null;
          } else {
            transcriptSeqRef.current = null;
            if (typeof msg.endOffset === "number" && msg.rev) {
              transcriptCursorRef.current = {
                sessionId: session.id,
                rev: msg.rev,
                offset: msg.endOffset,
              };
            } else {
              transcriptCursorRef.current = null;
            }
          }
          if (v2) acceptInitTail(msg.entries, existingIndex);
          if (v2 && existingIndex)
            transcriptViewStore.merge(merged, true, true);
          else transcriptViewStore.replace(merged, true, v2);
          setHistoryTruncated(!!msg.truncated);
          backgroundHistoryRef.current = false;
          historyRevealRef.current = null;
          loadingHistoryRef.current = false;
          setLoadingHistory(false);
          setLoading(false);
          // A whole-history walk ends here when the server answers with the
          // whole transcript — the legacy path's only way to serve a backlog,
          // and the seq path's fallback when a store read fails. A TRUNCATED
          // init is a re-snapshot of the tail instead (a reconnect landing
          // mid-walk), so cancel that quietly rather than parking the reader
          // at the top of a tail they didn't ask for.
          if (historyWalkRef.current?.sessionId === session.id) {
            if (msg.truncated) {
              historyWalkRef.current = null;
              setLoadingAllHistory(false);
            } else {
              finishHistoryWalk();
            }
          }
          shellTiming.record();
          // Pagination cursor for "load earlier" (the byte offset the shipped
          // tail begins at). Each history page arrives as transcript_history
          // below. Seq mode pages with
          // beforeSeq instead, so the byte cursor stays untouched there.
          if (!v2 && typeof msg.startOffset === "number") {
            historyStartRef.current = msg.startOffset;
          }
          break;
        }
        case "transcript_index": {
          replaceIndex(msg, messagesRef.current, followingLive.current);
          setHistoryTruncated(false);
          backgroundHistoryRef.current = false;
          historyRevealRef.current = null;
          loadingHistoryRef.current = false;
          setLoadingHistory(false);
          break;
        }
        case "transcript_range": {
          acceptRange(msg);
          break;
        }
        case "transcript_history": {
          // Older entries from a "load earlier" page: merge by id and re-sort
          // by time — mergeEntries
          // appends, which is wrong for content older than what's shown.
          transcriptViewStore.prepend(msg.entries, msg.v2 === true);
          setHistoryTruncated(!!msg.truncated);
          const seqState = transcriptSeqRef.current;
          const inSeqMode = seqState?.sessionId === session.id;
          if (
            inSeqMode &&
            msg.v2 === true &&
            typeof msg.firstSeq === "number" &&
            msg.firstSeq > 0
          ) {
            // Older-page cursor: earliest seq loaded so far (min).
            seqState.firstSeq =
              seqState.firstSeq === null
                ? msg.firstSeq
                : Math.min(seqState.firstSeq, msg.firstSeq);
          } else if (!inSeqMode && typeof msg.startOffset === "number") {
            historyStartRef.current =
              historyStartRef.current === null
                ? msg.startOffset
                : Math.min(historyStartRef.current, msg.startOffset);
          }
          // Whole-history walk: this page's cursor is now in place, so ask
          // for the next one straight from here — leaving loadingHistory
          // true across the gap. Stop on a whole transcript, an empty page,
          // a cursor that stopped receding, or the ceiling.
          const jump = historyWalkRef.current;
          if (jump && jump.sessionId === session.id) {
            jump.loaded += msg.entries.length;
            const cursor = inSeqMode
              ? seqState.firstSeq
              : historyStartRef.current;
            if (
              msg.truncated &&
              msg.entries.length > 0 &&
              cursor !== null &&
              cursor !== jump.cursor &&
              jump.loaded < JUMP_MAX_ENTRIES
            ) {
              jump.cursor = cursor;
              requestHistoryPage(true);
              break;
            }
            finishHistoryWalk();
          }
          const reveal = historyRevealRef.current;
          if (reveal && reveal.sessionId === session.id && inSeqMode) {
            reveal.loaded += msg.entries.length;
            const cursor = seqState.firstSeq;
            if (
              shouldContinueHistoryReveal({
                entries: msg.entries,
                truncated: !!msg.truncated,
                loaded: reveal.loaded,
                cursor,
                previousCursor: reveal.cursor,
              })
            ) {
              reveal.cursor = cursor;
              requestHistoryPage();
              break;
            }
            historyRevealRef.current = null;
          }
          if (backgroundHistoryRef.current) scrollToLatest("auto");
          backgroundHistoryRef.current = false;
          loadingHistoryRef.current = false;
          setLoadingHistory(false);
          break;
        }
        case "transcript_append": {
          const seqState = transcriptSeqRef.current;
          const inSeqMode = seqState?.sessionId === session.id;
          if (inSeqMode) {
            // Seq mode: track the resume cursor as a max — upsert
            // republishes reuse the entry's ORIGINAL seq, so a frame's
            // lastSeq can sit below what we already hold. Offset/rev
            // fields (if any) are ignored while in this mode.
            if (
              msg.v2 === true &&
              typeof msg.lastSeq === "number" &&
              msg.lastSeq > 0
            ) {
              seqState.lastSeq = Math.max(seqState.lastSeq, msg.lastSeq);
            }
            if (typeof msg.lastChangeSeq === "number") {
              seqState.lastChangeSeq = Math.max(
                seqState.lastChangeSeq,
                msg.lastChangeSeq,
              );
            }
          } else if (typeof msg.endOffset === "number" && msg.rev) {
            transcriptCursorRef.current = {
              sessionId: session.id,
              rev: msg.rev,
              offset: msg.endOffset,
            };
          }
          transcriptViewStore.merge(msg.entries, inSeqMode, true);
          if (inSeqMode) projectAppend(msg.entries, msg.firstSeq);
          // The live stream and the transcript tail both carry assistant text.
          // stream_text accumulates whole blocks until stream_done (end of the
          // run), so a mid-run text block would otherwise show twice: as the
          // persisted entry above later tool steps AND in the streaming bubble
          // at the bottom. Once a block lands as an entry, drop it from the
          // stream buffer.
          const landed = msg.entries.filter(
            (e) => e.type === "assistant" && e.content,
          );
          if (landed.length) {
            liveTurnStore.land(
              landed.map((e) => ({ id: e.id, content: e.content })),
            );
          }
          break;
        }
        case "presence":
          if (msg.sessionId === session.id) setViewers(msg.viewers);
          break;
        case "typing":
          if (msg.sessionId === session.id)
            setTypingUsers(otherTypingUsers(msg.users, getCurrentUser()));
          break;
        case "queue_update":
          if (msg.sessionId === session.id) {
            // Don't let a broadcast rewrite the list mid-drag (see
            // draggingQueueRef) — the drop will send our order and the
            // server's echo reconciles it right after.
            dispatchSessionRuntime({
              type: "frame",
              frame: msg,
              acceptQueueUpdate: !draggingQueueRef.current,
            });
          }
          break;
        case "queued_prompt_taken": {
          if (msg.sessionId !== session.id) break;
          if (!msg.item) {
            dispatchSessionRuntime({ type: "frame", frame: msg });
            toast(msg.message || "That queued message could not be edited");
            break;
          }
          const item = msg.item as QueueReceipt;
          const existing = loadDraft(draftKey);
          setImages((current) => [...current, ...(item.images ?? [])]);
          const restoredFiles = Array.isArray(item.files)
            ? item.files.flatMap((file) => {
                if (!file || typeof file !== "object") return [];
                const value = file as Record<string, unknown>;
                if (typeof value.name !== "string") return [];
                return [
                  {
                    name: value.name,
                    type:
                      typeof value.type === "string"
                        ? value.type
                        : "application/octet-stream",
                    ...(typeof value.path === "string"
                      ? { path: value.path }
                      : {}),
                    ...(typeof value.dataUrl === "string"
                      ? { dataUrl: value.dataUrl }
                      : {}),
                  },
                ];
              })
            : [];
          setFiles((current) => [...current, ...restoredFiles]);
          setContextSessions((current) => [
            ...new Set([...current, ...(item.contextSessions ?? [])]),
          ]);
          setComposerPrefill((current) => ({
            seq: (current?.seq ?? 0) + 1,
            text: item.content,
            replace: !existing.text.trim(),
          }));
          break;
        }
        case "ask_question":
        case "ask_resolved":
          if (msg.sessionId === session.id)
            dispatchSessionRuntime({ type: "frame", frame: msg });
          break;
        case "reply_suggestions":
          // Null retires the row (the turn they answered has been answered).
          if (msg.sessionId === session.id)
            setReplySuggestions(msg.suggestions ?? []);
          break;
        case "slack_composer":
          if (msg.sessionId === session.id) {
            setSlackComposer(msg.request);
            setSlackComposerStatus("idle");
            setSlackComposerReconnect(false);
            if (msg.request) setSlackComposerSent(null);
          }
          break;
        case "slack_composer_resolved":
          if (msg.sessionId === session.id) {
            setSlackComposer((current) =>
              current?.id === msg.requestId ? null : current,
            );
            if (msg.status === "sent" && msg.channel) {
              setSlackComposerSent({
                channelName: msg.channel.name,
                permalink: msg.permalink,
                receiptKey: msg.requestId,
                channelId: msg.channel.id,
                ts: msg.ts,
              });
            }
          }
          break;
        case "session_status": {
          const running = !!msg.isRunning && !msg.safety;
          dispatchSessionRuntime({ type: "frame", frame: msg });
          if (!running) {
            // Every isRunning:false broadcast follows its run's stream_done,
            // so a live turn never gets cut here. This clears the stale case:
            // a socket that died mid-stream (server restart) reconnects, the
            // re-watch hello reports the turn already over, and the spinner
            // from the dead stream would otherwise stay up forever.
            liveTurnStore.finish();
          }
          onRunningChange?.(session.id, running);
          break;
        }
        case "git_pushed":
          if (msg.sessionId === session.id) setGitRefreshTick((t) => t + 1);
          break;
        case "pr_updated":
          // Include PR-backed workspace branches: legacy review sessions keep a
          // synthetic checkout branch that differs from the real PR head.
          if (sessionPrTargetsRef.current.has(`${msg.repo}\0${msg.branch}`))
            setGitRefreshTick((t) => t + 1);
          break;
        case "workspace_status":
          if (msg.sessionId === session.id) setWorkspacePreparing(!msg.ready);
          break;
        case "stream_start":
          dispatchSessionRuntime({ type: "frame", frame: msg });
          // A new turn is never the stopped one: clear the pending stop so
          // its label can't bleed into the run that follows it.
          setStopRequestedAt(null);
          liveTurnStore.start(msg.by);
          // A new turn answers the last one's chips. The server clears its
          // copy on the same event; this is what stops the row lingering
          // for the seconds before that broadcast lands.
          setReplySuggestions(EMPTY_SUGGESTIONS);
          break;
        case "stream_text": {
          if (isTimelineOnlyRunnerNotice(msg.text)) break;
          // Live typing is per viewer (Settings > Preferences), default off.
          // Dropping the frame is the whole implementation: the durable
          // entry for the block still lands over the transcript feed, which
          // is what filled the transcript before streaming existed. Read per
          // frame rather than captured, so a toggle takes on the running turn.
          if (!getLiveTypingPref()) break;
          liveTurnStore.append(msg.text, msg.blockId);
          break;
        }
        case "stream_tool_use":
        case "stream_tool_result":
          transcriptViewStore.merge([msg.entry]);
          break;
        case "stream_done": {
          dispatchSessionRuntime({ type: "frame", frame: msg });
          liveTurnStore.finish();
          break;
        }
        case "model_changed":
          if (msg.sessionId !== session.id) break;
          dispatchSessionRuntime({ type: "frame", frame: msg });
          if (msg.by && msg.by !== getCurrentUser()) {
            setEntries((prev) => [
              ...prev,
              {
                id: `model-switch-live-${Date.now()}`,
                type: "system",
                content: switchDividerText(msg.model, msg.from, msg.by),
                timestamp: new Date().toISOString(),
              },
            ]);
          }
          break;
        case "subscription_changed":
          // Keep every viewer's Subscription submenu in sync; the /sub
          // notice in the transcript carries the human-readable detail.
          if (msg.sessionId !== session.id) break;
          setAccountId(msg.accountId || "");
          break;
        case "usage_update":
          if (msg.sessionId !== session.id) break;
          dispatchSessionRuntime({ type: "frame", frame: msg });
          break;
        case "cache_warning":
          if (msg.sessionId !== session.id) break;
          toast("Prompt cache missed");
          break;
        case "notice":
          setEntries((prev) => [
            ...prev,
            {
              id: randomUUID(),
              type: "system",
              content: msg.message,
              timestamp: new Date().toISOString(),
            },
          ]);
          break;
        case "error":
          dispatchSessionRuntime({ type: "frame", frame: msg });
          liveTurnStore.finish();
          // Show the failure where the reply would have been — otherwise a
          // failed run looks like a send that silently went nowhere.
          if (msg.message) {
            setEntries((prev) => [
              ...prev,
              {
                id: randomUUID(),
                type: "system",
                content: `⚠ Run failed: ${msg.message}`,
                timestamp: new Date().toISOString(),
              },
            ]);
          }
          break;
      }
    });
    // Register first: `watch` synchronously receives a presence snapshot. On a
    // reconnect, sending before this handler exists can drop the empty snapshot
    // and leave a departed viewer's face rendered indefinitely.
    send({
      type: "watch",
      sessionId: session.id,
      user: getCurrentUser(),
      supportsSeq: true,
      supportsChangeSeq: true,
      supportsTranscriptIndex: true,
      ...resume,
    });
    return () => {
      unsubscribe();
      // Tell the server we stopped watching, so it can drop the transcript
      // stream and our presence entry (otherwise we linger as a ghost viewer).
      // send() is a no-op unless the socket is OPEN, so a dropped connection
      // (the usual reason this effect re-runs) never throws here.
      send({ type: "unwatch", sessionId: session.id });
    };
    // `ran` in deps: new sessions start with no engine conversation and no
    // transcript file — re-watch once the first run makes one so the live
    // tail attaches. It stands in for `transcriptPath`, which said the same
    // thing a moment later but is detail-only now: reading it here would
    // re-watch every session ONCE MORE the instant its detail hydrated.
  });
  useEffect(
    () => subscribeToSession(),
    [session.id, connected, session.ran, liveTurnStore],
  );

  // Drop optimistic bubbles once their real turn shows up. Each pending message
  // is claimed (one-to-one) either by a transcript user entry recorded around or
  // after we sent it, or by a server-confirmed queued entry (the busy path).
  // A long-unmatched bubble is dropped so a dead send never sticks as "sending…".
  useEffect(() => {
    const { landed, expired } = reconcilePending(
      pendingRef.current,
      entries,
      [...queued, ...steered],
      Date.now(),
    );
    if (landed.size === 0 && expired.size === 0) return;
    setPending((prev) =>
      prev.filter((p) => !landed.has(p.id) && !expired.has(p.id)),
    );
    // Only a CONFIRMED claim retires the durable outbox row below. An expired
    // bubble is merely hidden: its prompt may still be in flight, and the
    // outbox is localStorage-backed and shared across tabs, so anything that
    // looks like a discard has to be earned by a real server confirmation.
    if (landed.size > 0)
      setLandedOutboxIds((prev) => {
        const next = new Set(prev);
        for (const id of landed) next.add(id);
        return next;
      });
  }, [entries, queued, steered, setEntries]);

  // Forget optimistic bubbles and live state when switching sessions. This
  // component is retained between tabs, so carrying a busy flag from the prior
  // session makes an idle prompt render as queued until the new watch handshake
  // arrives. Reset in layout, before the next session can accept input, so an
  // idle send paints directly in the transcript on its first frame.
  const resetOptimisticState = useEffectEvent(() => {
    setPending(
      initialPending
        ? [
            {
              id: `pending-initial-${session.id}`,
              transcriptAfterEntryId: null,
              ...initialPending,
            },
          ]
        : [],
    );
    dispatchSessionRuntime({
      type: "reset_live",
      isRunning: session.isRunning,
    });
    liveTurnStore.clear();
  });
  useLayoutEffect(() => {
    resetOptimisticState();
  }, [session.id, liveTurnStore]);

  // Every session opens at the live edge. Do this in a layout effect so the
  // transcript never paints at scrollTop 0 before moving to the end.
  const initiallyScrolledSessionRef = useRef<string | null>(null);
  const [initialScrollSession, setInitialScrollSession] = useState<
    string | null
  >(null);
  useLayoutEffect(() => {
    const el = messagesRef.current;
    if (
      !el ||
      transcriptReadySessionRef.current !== session.id ||
      initiallyScrolledSessionRef.current === session.id ||
      entries.length === 0
    )
      return;
    initiallyScrolledSessionRef.current = session.id;
    scrollToLatest("auto");
    setInitialScrollSession(session.id);
  }, [entries, session.id, sessionHidden, scrollToLatest, messagesRef]);
  // Message blocks use content-visibility with estimated heights. Those estimates
  // resolve after the first scroll calculation without a React update, growing the
  // transcript above the viewport. Hold the bottom through that initial browser
  // layout pass, but release immediately if the reader touches the transcript.
  useLayoutEffect(() => {
    if (initialScrollSession !== session.id) return;
    const el = messagesRef.current;
    if (!el) return;

    let stopped = false;
    const keepAtLatest = () => {
      if (!stopped) el.scrollTop = el.scrollHeight;
    };
    const sizes = new ResizeObserver(keepAtLatest);
    const observeChildren = () => {
      for (const child of el.children) sizes.observe(child);
    };
    const children = new MutationObserver(() => {
      observeChildren();
      keepAtLatest();
    });
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      sizes.disconnect();
      children.disconnect();
      if (expiry) clearTimeout(expiry);
      el.removeEventListener("wheel", stop);
      el.removeEventListener("touchstart", stop);
      el.removeEventListener("pointerdown", stop);
      window.removeEventListener("keydown", stopForScrollKey);
    };
    const stopForScrollKey = (event: KeyboardEvent) => {
      if (!isSessionFocused()) return;
      if (
        ["PageUp", "PageDown", "Home", "End"].includes(event.key) ||
        (event.ctrlKey &&
          event.shiftKey &&
          (event.key === "ArrowUp" || event.key === "ArrowDown"))
      )
        stop();
    };

    observeChildren();
    children.observe(el, { childList: true });
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("touchstart", stop, { passive: true });
    el.addEventListener("pointerdown", stop, { passive: true });
    window.addEventListener("keydown", stopForScrollKey);
    expiry = setTimeout(stop, 3000);
    keepAtLatest();
    return stop;
  }, [initialScrollSession, session.id, sessionHidden, messagesRef]);
  // Returning to the app reads like reopening the session, not resuming a
  // paused one. On the iOS PWA the page survives backgrounding with the scroll
  // parked wherever it was; on desktop a hidden tab keeps streaming below the
  // fold. So when the tab turns visible again, jump to the live edge if the
  // transcript grew while hidden — or if we were away long enough that this is
  // a reopen, not a glance at another app. Growth often only lands moments
  // AFTER visibility (the PWA's WebSocket reconnects first, then backfills),
  // so a short watch window catches late arrivals. A real reader gesture
  // cancels the pending jump — their hands on the transcript always win.
  const lastEntryIdRef = useRef<string | null>(null);
  const streamLenRef = useRef(0);
  useLayoutEffect(() => {
    lastEntryIdRef.current =
      entries.length > 0 ? entries[entries.length - 1].id : null;
    streamLenRef.current = liveTurnStore.textLength();
  }, [entries, liveTurnStore]);
  const hiddenSnapRef = useRef<{
    at: number;
    lastEntryId: string | null;
    streamLen: number;
  } | null>(null);
  const resumeWatchRef = useRef<{
    until: number;
    lastEntryId: string | null;
    streamLen: number;
  } | null>(null);
  useEffect(() => {
    hiddenSnapRef.current = null;
    resumeWatchRef.current = null;
  }, [session.id]);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenSnapRef.current = {
          at: Date.now(),
          lastEntryId: lastEntryIdRef.current,
          streamLen: streamLenRef.current,
        };
        resumeWatchRef.current = null;
        return;
      }
      const snap = hiddenSnapRef.current;
      hiddenSnapRef.current = null;
      if (!snap) return;
      const grew =
        lastEntryIdRef.current !== snap.lastEntryId ||
        streamLenRef.current > snap.streamLen;
      if (grew || Date.now() - snap.at >= HIDDEN_REOPEN_MS) {
        scrollToLatest("auto");
      } else {
        resumeWatchRef.current = {
          until: performance.now() + RESUME_GROWTH_WINDOW_MS,
          lastEntryId: snap.lastEntryId,
          streamLen: snap.streamLen,
        };
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [scrollToLatest]);
  // The late-arrival half of the resume jump: growth landing inside the watch
  // window (WS backfill after a PWA resume) completes the jump to the edge.
  useEffect(() => {
    const watch = resumeWatchRef.current;
    if (!watch) return;
    if (performance.now() > watch.until) {
      resumeWatchRef.current = null;
      return;
    }
    if (lastEntryIdRef.current !== watch.lastEntryId) {
      resumeWatchRef.current = null;
      scrollToLatest("auto");
    }
  }, [entries, scrollToLatest]);
  useEffect(
    () =>
      liveTurnStore.subscribe(() => {
        streamLenRef.current = liveTurnStore.textLength();
        const watch = resumeWatchRef.current;
        if (
          watch &&
          performance.now() <= watch.until &&
          streamLenRef.current > watch.streamLen
        ) {
          resumeWatchRef.current = null;
          scrollToLatest("auto");
        }
      }),
    [liveTurnStore, scrollToLatest],
  );
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const cancelResumeJump = () => {
      resumeWatchRef.current = null;
    };
    el.addEventListener("touchstart", cancelResumeJump, { passive: true });
    el.addEventListener("wheel", cancelResumeJump, { passive: true });
    return () => {
      el.removeEventListener("touchstart", cancelResumeJump);
      el.removeEventListener("wheel", cancelResumeJump);
    };
  }, [messagesRef]);

  // After any content change: keep a following reader at the live edge, or maintain
  // the pinned-turn spacer for a turn streaming into the space below (principles 4–6).
  // Layout effect so the adjustment happens before the browser paints — no flicker.
  useLayoutEffect(() => {
    relayout();
    if (!tailActionNeedsLayoutScrollRef.current) return;
    tailActionNeedsLayoutScrollRef.current = false;
    scrollToLatest("auto");
  }, [entries, queued, steered, pending, ask, relayout, scrollToLatest]);

  // Shared preamble: stop tracking the live edge, and pin the reader to the
  // content they're on while the page prepends above it.
  const beginHistoryLoad = useCallback(
    (holdMs = 8000) => {
      leaveLatest();
      const el = messagesRef.current;
      if (el) {
        // Anchor on the tightest element at the viewport top — it sits below
        // everything the prepend inserts, so its content offset shifts by
        // exactly the added height (what native scroll anchoring would pick).
        const node = pickScrollAnchor(el);
        if (node)
          startHistoryHold(node, holdMs, {
            height: el.scrollHeight,
            top: el.scrollTop,
          });
      }
      setLoadingHistory(true);
    },
    [leaveLatest, messagesRef, startHistoryHold],
  );
  const loadEarlierHistory = useCallback(() => {
    if (transcriptIndexExpectedRef.current || !historyTruncated) return;
    if (loadingHistoryRef.current) {
      // The deferred page is already on the wire. Adopt it rather than making
      // the first upward gesture look ignored, and let its response continue
      // until a visible conversation boundary lands.
      if (backgroundHistoryRef.current) {
        backgroundHistoryRef.current = false;
        if (transcriptSeqRef.current?.sessionId === session.id) {
          historyRevealRef.current = {
            sessionId: session.id,
            loaded: 0,
            cursor: null,
          };
        }
        beginHistoryLoad();
      }
      return;
    }
    loadingHistoryRef.current = true;
    if (transcriptSeqRef.current?.sessionId === session.id) {
      historyRevealRef.current = {
        sessionId: session.id,
        loaded: 0,
        cursor: null,
      };
    }
    beginHistoryLoad();
    requestHistoryPage();
  }, [
    beginHistoryLoad,
    historyTruncated,
    requestHistoryPage,
    session.id,
    transcriptIndexExpectedRef,
  ]);
  const loadAllHistory = useCallback(() => {
    if (
      transcriptIndexExpectedRef.current ||
      !historyTruncated ||
      loadingHistoryRef.current
    )
      return;
    loadingHistoryRef.current = true;
    historyRevealRef.current = null;
    backgroundHistoryRef.current = false;
    historyWalkRef.current = {
      sessionId: session.id,
      loaded: 0,
      cursor: null,
    };
    setLoadingAllHistory(true);
    beginHistoryLoad(60_000);
    requestHistoryPage(true);
  }, [
    beginHistoryLoad,
    historyTruncated,
    requestHistoryPage,
    session.id,
    transcriptIndexExpectedRef,
  ]);

  // Preserve the fast opening snapshot, then download one fuller page once the
  // browser has had time to paint it. This only runs at the live edge in seq
  // mode. A reader who starts moving first wins and uses the interactive path.
  useEffect(() => {
    if (
      loading ||
      transcriptIndexExpected ||
      !historyTruncated ||
      loadingHistory ||
      sessionHidden ||
      backgroundHistoryAttemptedRef.current ||
      transcriptSeqRef.current?.sessionId !== session.id
    )
      return;
    let attempts = 0;
    let timer = 0;
    const tryPrefetch = () => {
      const el = messagesRef.current;
      if (!el || el.scrollHeight - el.scrollTop - el.clientHeight > 4) {
        // Opening scroll restoration can settle after the first transcript
        // paint. Give it a short window without chasing a reader who moved up.
        attempts += 1;
        if (attempts < 12) timer = window.setTimeout(tryPrefetch, 500);
        return;
      }
      backgroundHistoryAttemptedRef.current = true;
      backgroundHistoryRef.current = true;
      loadingHistoryRef.current = true;
      setLoadingHistory(true);
      requestHistoryPage();
    };
    timer = window.setTimeout(tryPrefetch, 1_500);
    return () => window.clearTimeout(timer);
  }, [
    historyTruncated,
    loading,
    transcriptIndexExpected,
    loadingHistory,
    messagesRef,
    requestHistoryPage,
    session.id,
    sessionHidden,
  ]);

  // Auto-load is driven by upward reader intent, never by viewport geometry
  // alone. That keeps initial hydration and programmatic bottom settling from
  // fetching history while still preloading a page as the reader approaches it.
  const historyGestureUntilRef = useRef(0);
  const historyGestureConsumedRef = useRef(true);
  const lastHistoryWheelAtRef = useRef(0);
  const lastHistoryScrollTopRef = useRef(0);
  const handleMessagesScroll = useCallback(() => {
    const el = messagesRef.current;
    const previous = lastHistoryScrollTopRef.current;
    const current = el?.scrollTop ?? previous;
    lastHistoryScrollTopRef.current = current;
    onScroll();
    const cached = peekCachedTranscriptView(session.id);
    // Only the cheap fields here: a scroll event must not walk the
    // transcript. The anchor follows once the reader settles.
    if (el && cached) {
      cacheTranscriptView(session.id, {
        ...cached,
        scrollTop: current,
        following: followingLive.current,
      });
      scheduleAnchorCapture();
    }
    if (el && current < previous - 1 && backgroundHistoryRef.current) {
      loadEarlierHistory();
    }
    if (
      el &&
      current < previous - 1 &&
      current <= 600 &&
      !historyGestureConsumedRef.current &&
      performance.now() <= historyGestureUntilRef.current
    ) {
      historyGestureConsumedRef.current = true;
      historyGestureUntilRef.current = 0;
      loadEarlierHistory();
    }
  }, [
    followingLive,
    loadEarlierHistory,
    messagesRef,
    onScroll,
    scheduleAnchorCapture,
    session.id,
  ]);
  useEffect(() => {
    const el = messagesRef.current;
    if (!el || sessionHidden) return;
    historyGestureUntilRef.current = 0;
    historyGestureConsumedRef.current = true;
    lastHistoryWheelAtRef.current = 0;
    lastHistoryScrollTopRef.current = el.scrollTop;
    let touchY: number | null = null;
    const nearHistory = () => {
      if (historyGestureConsumedRef.current || el.scrollTop > 600) return;
      historyGestureConsumedRef.current = true;
      historyGestureUntilRef.current = 0;
      loadEarlierHistory();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY >= 0) return;
      if (backgroundHistoryRef.current) loadEarlierHistory();
      const now = performance.now();
      if (now - lastHistoryWheelAtRef.current > 200)
        historyGestureConsumedRef.current = false;
      lastHistoryWheelAtRef.current = now;
      historyGestureUntilRef.current = now + 1200;
      nearHistory();
    };
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null;
      historyGestureConsumedRef.current = false;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (y === undefined || touchY === null) return;
      if (y > touchY + 1) {
        if (backgroundHistoryRef.current) loadEarlierHistory();
        historyGestureUntilRef.current = performance.now() + 6000;
        nearHistory();
      }
      touchY = y;
    };
    const onPointerDown = (event: PointerEvent) => {
      // Classic scrollbar drags hit the container beyond its content box.
      if (
        event.target === el &&
        (event.offsetX >= el.clientWidth || event.offsetY >= el.clientHeight)
      ) {
        historyGestureConsumedRef.current = false;
        historyGestureUntilRef.current = performance.now() + 1500;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!focused) return;
      const upward =
        event.ctrlKey &&
        event.shiftKey &&
        !event.metaKey &&
        !event.altKey &&
        event.key === "ArrowUp";
      if (!upward) return;
      if (backgroundHistoryRef.current) loadEarlierHistory();
      historyGestureConsumedRef.current = false;
      historyGestureUntilRef.current = performance.now() + 1200;
      nearHistory();
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [focused, session.id, sessionHidden, loadEarlierHistory, messagesRef]);

  // When a turn finishes, release the spacer so the layout settles back.
  const wasBusyRef = useRef(false);
  useEffect(() => {
    if (wasBusyRef.current && !isBusy) endTurn();
    wasBusyRef.current = isBusy;
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
      if (!slackComposer) return;
      setSlackComposerStatus("sharing");
      try {
        const result = await sendSlackComposer(session.id, {
          requestId: slackComposer.id,
          message,
          channel,
          screenshots,
        });
        setSlackComposer(null);
        setSlackComposerStatus("idle");
        setSlackComposerSent({
          channelName: result.channel.name,
          permalink: result.permalink,
          receiptKey: slackComposer.id,
          channelId: result.channel.id,
          ts: result.ts,
        });
      } catch (error) {
        setSlackComposerStatus("idle");
        if (
          error instanceof ApiError &&
          error.status === 403 &&
          /Reconnect Slack/.test(error.message)
        ) {
          setSlackComposerReconnect(true);
          toast("Reconnect Slack to add image access");
        } else {
          toast(
            error instanceof Error ? error.message : "Couldn't send to Slack",
          );
        }
      }
    },
    [session.id, slackComposer],
  );
  // Slack accepts a delete only from the account that posted, which is the
  // person's own grant token, so an undo here can never touch someone else's
  // message.
  const undoComposedSlackMessage = useCallback(
    async (sent: SlackSent) => {
      if (!sent.channelId || !sent.ts) return;
      try {
        await undoSlackComposer(session.id, {
          channel: sent.channelId,
          ts: sent.ts,
        });
        setSlackComposerSent(null);
        toast("Removed from Slack");
      } catch (error) {
        toast(
          error instanceof Error
            ? error.message
            : "Couldn't undo the Slack message",
        );
      }
    },
    [session.id],
  );
  const cancelComposedSlackMessage = useCallback(async () => {
    if (!slackComposer) return;
    try {
      await cancelSlackComposer(session.id, slackComposer.id);
      setSlackComposer(null);
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : "Couldn't close the Slack composer",
      );
    }
  }, [session.id, slackComposer]);
  // Exact engine-state forks use Claude's SDK forkSession. Other backends can
  // still fork as a new sibling with a transcript handoff.
  const canForkSession = session.source === "opensession" && !!session.ran;

  const handleFork = useCallback((messageId?: string) => {
    setForkFrom(messageId ? { kind: "message", messageId } : { kind: "tip" });
  }, []);

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
    const sendStartedAt = performance.now();
    const typed = raw.trim();
    const isolated = isolatedImages !== undefined;
    // Quoted transcript selections lead a normal composer message. A region
    // comment carries its own visual context and leaves the draft untouched.
    const text = isolated ? typed : withQuotes(quote ? [quote] : [], typed);
    const imgs = isolatedImages ?? images;
    const fls = isolated ? [] : files;
    if (!typed && imgs.length === 0 && fls.length === 0) return false;

    // Note mode: post a team note on this session — never a prompt. The
    // server broadcast echoes it back into `notes` for every viewer, so
    // nothing is rendered optimistically here. Notes carry the quoted
    // selection too (as "> " lines, the same shape a prompt sends).
    if (!isolated && noteMode) {
      if (!typed && imgs.length === 0) return false;
      return postSessionNoteApi(session.id, text, getCurrentUser(), imgs).then(
        () => {
          dropStagingAttachments(draftKey);
          setImages([]);
          setQuote(null);
          return true;
        },
        () => {
          toast("Failed to add note");
          return false;
        },
      );
    }

    const user = getCurrentUser();
    // Prefer the staged disk path (HTTP upload); fall back to inline dataUrl.
    const filePayload = fls.map((f) =>
      f.path
        ? { name: f.name, path: f.path }
        : { name: f.name, dataUrl: f.dataUrl },
    );

    // Fork mode: branch a brand-new session from the current tip or selected
    // message, keeping the real conversation history. App navigates into it on
    // session_created.
    if (!isolated && forkFrom) {
      send({
        type: "create_session",
        branch: "",
        prompt: text || "Continue from here.",
        user,
        forkFrom: {
          sourceId: session.id,
          ...(forkFrom.kind === "message"
            ? { messageId: forkFrom.messageId }
            : {}),
        },
        ...(imgs.length ? { images: imgs } : {}),
        ...(fls.length ? { files: filePayload } : {}),
      });
      setForkFrom(null);
      dropStagingAttachments(draftKey);
      setImages([]);
      setFiles([]);
      setQuote(null);
      return true;
    }

    if (noEngine) return false;
    // Two follow-up behaviors while busy: plain send QUEUES (parked until
    // the run FULLY finishes — including any auto-continue turns the server
    // holds the queue behind), and the steer button / ⌘Ctrl+Enter STEERS
    // (folds into the LIVE run at its next step boundary — busyMode:"steer",
    // real in-band steering since 2026-07-12; the server falls back to the
    // queue when nothing is steerable or files are attached). The turn keeps
    // running on both paths: no abort, no lost work. Idle: just run it.
    // Attachments ride along on every path — images fold into the run as
    // content blocks; files route to the queue server-side.
    const steerNow = isBusy && !!opts?.steer;
    const optimisticTail = [...pendingRef.current]
      .reverse()
      .find((item) => item.busyMode !== "queue");
    const transcriptTail = transcriptViewStore.getSnapshot().at(-1);
    const transcriptAfterEntryId = optimisticTail
      ? optimisticTail.id.startsWith("outbox-")
        ? optimisticTail.id.slice("outbox-".length)
        : optimisticTail.id
      : (transcriptTail?.id ?? null);
    const transcriptAfterSeq =
      transcriptSeqRef.current?.sessionId === session.id
        ? transcriptSeqRef.current.lastSeq
        : undefined;
    let outboxItem: PromptOutboxItem;
    try {
      outboxItem = promptOutbox.enqueue({
        sessionId: session.id,
        content: text,
        user,
        effort,
        fastMode,
        busyMode: isBusy ? (steerNow ? "steer" : "queue") : undefined,
        transcriptAfterEntryId,
        transcriptAfterSeq,
        ...(imgs.length ? { images: imgs } : {}),
        ...(fls.length ? { files: filePayload } : {}),
        ...(!isolated && contextSessions.length ? { contextSessions } : {}),
      });
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : "Couldn't save this message for delivery.",
      );
      return false;
    }
    // Prompting in a session you'd hidden from your sidebar brings its row back
    // — you're working in it again (see lib/hides.ts).
    unhideForSession(session);
    if (!isBusy || steerNow) {
      if (!isBusy) {
        dispatchSessionRuntime({ type: "mark_running" });
        onRunningChange?.(session.id, true);
      }
      // Sent messages always enter the conversation immediately. A busy steer
      // keeps its delivery mode only so the bubble can remain slightly muted
      // until the engine reads it.
      tailActionNeedsLayoutScrollRef.current = true;
      setPending((p) => [
        ...p,
        {
          id: `outbox-${outboxItem.clientId}`,
          content: text,
          user,
          sentAt: outboxItem.createdAt,
          transcriptAfterEntryId,
          transcriptAfterSeq,
          images: imgs.length ? imgs : undefined,
          ...(steerNow ? { busyMode: "steer" as const } : {}),
        },
      ]);
      requestAnimationFrame(() =>
        measureSessionPerf("send_to_optimistic_paint_ms", sendStartedAt),
      );
    } else {
      // Only deliberately queued messages live above the composer.
      setPending((p) => [
        ...p,
        {
          id: `outbox-${outboxItem.clientId}`,
          content: text,
          user,
          sentAt: outboxItem.createdAt,
          transcriptAfterEntryId,
          transcriptAfterSeq,
          images: imgs.length ? imgs : undefined,
          busyMode: "queue" as const,
        },
      ]);
    }
    // Your own send always lands in view. relayout's glue only runs while
    // `following`, so once the reader has scrolled up into history the
    // optimistic bubble arrives below the fold with nothing moving — and a
    // send is unambiguous intent to watch this turn. Instant, not smooth: the
    // glue that follows sets scrollTop directly and would fight an animation.
    cancelIndexAnchorHold();
    scrollToLatest("auto");
    if (!isolated) {
      dropStagingAttachments(draftKey);
      setImages([]);
      setFiles([]);
      setQuote(null);
      setContextSessions([]);
    }
    measureSessionPerf("send_handler_ms", sendStartedAt);
    return true;
  }

  const imageRegionCommentRef = useRef<
    (request: ImageRegionCommentRequest) => Promise<void>
  >(async () => {});
  useLayoutEffect(() => {
    imageRegionCommentRef.current = async (request) => {
      if (request.sessionId !== session.id)
        throw new Error("That session changed");
      const crop = await cropImageRegionFile(request.src, request.region);
      const staged = await splitAttachments([crop]);
      if (staged.images.length === 0)
        throw new Error(
          staged.rejected[0] || "Could not attach the selected image",
        );
      const sent = await handleSend(request.text, undefined, staged.images);
      if (!sent) throw new Error("Could not send this comment");
    };
  });
  useEffect(() => {
    if (noEngine) return;
    return registerImageRegionCommentHandler(session.id, (request) =>
      imageRegionCommentRef.current(request),
    );
  }, [noEngine, session.id]);

  function discardOutbox(item: PromptOutboxItem) {
    setPending((current) =>
      current.filter((entry) => entry.id !== `outbox-${item.clientId}`),
    );
    promptOutbox.discard(item.clientId);
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
    if (composerHasDraft()) {
      toast("Send or clear your draft before editing a message");
      return;
    }
    if (!q.id) return;
    if (steering) {
      dispatchSessionRuntime({
        type: "set_steered_editing",
        queueId: q.id,
        editing: true,
      });
    }
    send({
      type: steering ? "take_steered_prompt" : "take_queued_prompt",
      sessionId: session.id,
      queueId: q.id,
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
      setImages(entry.images ?? []);
      setFiles(
        (entry.files ?? []).map((file) => ({
          ...file,
          type: "application/octet-stream",
        })),
      );
      setComposerPrefill((current) => ({
        seq: (current?.seq ?? 0) + 1,
        text: entry.content,
        replace: true,
      }));
    },
    [composerHasDraft],
  );

  function handleQueueReorder(next: QueueReceipt[]) {
    pendingReorderRef.current = next;
    dispatchSessionRuntime({ type: "reorder_queue", queued: next });
  }

  function commitQueueReorder() {
    draggingQueueRef.current = false;
    const next = pendingReorderRef.current;
    pendingReorderRef.current = null;
    if (!next) return;
    const order = next
      .map((q) => q.id)
      .filter((id): id is string => typeof id === "string");
    if (order.length > 1) {
      send({ type: "reorder_queued_prompt", sessionId: session.id, order });
    }
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
    const path = session.workspaceId
      ? `${BASE_PATH}/workspace/${encodeURIComponent(session.workspaceId)}`
      : sessionPath(session);
    shareLink(absoluteLink(path), {
      toast: "Link copied",
      title: workspaceName || session.title || undefined,
    });
  }

  function handleShare() {
    // Share the workspace pane on screen rather than the session that happened
    // to host it. Session and sub-agent links keep their existing canonical form.
    const pane = showReview
      ? "review"
      : showConversation
        ? "conversation"
        : showVideo
          ? "video"
          : null;
    const path =
      pane && session.workspaceId
        ? workspacePanePath(session.workspaceId, pane)
        : sessionPath(
            session,
            subagentOpen ? subagentStack.map((s) => s.agentId) : [],
          );
    const link = absoluteLink(path);
    // Phone: native share sheet. Desktop: copy, with the inline check on
    // the button + a floating "Link copied" toast.
    // The native sheet titles the link with the workspace, matching the header.
    shareLink(link, {
      toast: "Link copied",
      title: workspaceName || session.title || undefined,
    });
  }

  async function handleOpenSlackComposer() {
    setOverflowOpen(false);
    try {
      const request = await openSlackComposer(
        session.id,
        latestAssistantMessage,
      );
      setSlackComposer(request);
      setSlackComposerStatus("idle");
      setSlackComposerReconnect(false);
      setSlackComposerSent(null);
      requestAnimationFrame(() => scrollToLatest("smooth"));
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : "Couldn't open the Slack composer",
      );
    }
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
    const target = next ? accounts.find((a) => a.id === next) : null;
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

  // Responsive header: when the top bar gets narrow (small window, sidebar +
  // workspace panel both open), the title truncates first (CSS), then the
  // Share button collapses into the ⋯ menu so it never overlaps the title.
  // (Pin stays inline beside Preview on desktop; Spin off lives in the ⋯ menu.) Measured on the
  // header element itself so it tracks the real available width regardless
  // of the surrounding chrome.
  const headerRef = useRef<HTMLDivElement>(null);
  const headerActionsRef = useRef<HTMLDivElement>(null);
  const desktopChangesRef = useRef<HTMLDivElement>(null);
  const [headerW, setHeaderW] = useState(0);
  // Whether the header's workspace-summary card is up. The transcript and
  // composer shift out from under it while it is, and the header's own PR
  // strip and preview globe stand down, so this lives here rather than inside
  // the card. Seeded from the stored preference rather than starting shut: the
  // card reports itself an effect later, and a frame of the strip it replaces
  // is the thing this is here to prevent.
  const [summaryOpen, setSummaryOpen] = useState(workspaceSummaryOpen);
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    // Once by hand, before the first paint: the observer's own opening callback
    // lands after it, and this width decides whether the summary card has room
    // to stand open. A frame late is a frame of a card lying across a narrow
    // transcript. Content box, to match what the observer reports below.
    const box = getComputedStyle(el);
    setHeaderW(
      el.clientWidth -
        parseFloat(box.paddingLeft) -
        parseFloat(box.paddingRight),
    );
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setHeaderW(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [topbarEl]);
  // Collapse before the inline row can overrun: the title's non-shrinkable
  // floor (source chip + Working pill) plus the inline actions (facepile,
  // links, Share) needs ~740px, so below that Share moves into the ⋯ menu.
  const compactHeader = headerW > 0 && headerW < 740;

  // Phone layout (same 720px breakpoint as the CSS page-stack): the header
  // actions portal into the top bar next to the centered title, and every
  // secondary action folds into the ⋯ menu so the bar holds just ⋯ + Workspace.
  const [isPhone, setIsPhone] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 720px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 720px)");
    const onChange = () => setIsPhone(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
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
    setComposerPrefill(composerPrefillExternal);
    onComposerPrefillConsumed?.(composerPrefillExternal.seq);
    if (!isPhone) composerRef.current?.focus();
  }, [composerPrefillExternal, onComposerPrefillConsumed, isPhone]);

  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowGit, setOverflowGit] = useState<{
    sessionId: string;
    status: GitStatusInfo | null;
  } | null>(null);
  const [branchActionBusy, setBranchActionBusy] = useState<
    "move" | "create" | null
  >(null);
  const [branchConfirmOpen, setBranchConfirmOpen] = useState(false);
  const [branchConfirmMode, setBranchConfirmMode] = useState<"move" | "create">(
    "move",
  );
  const [mobileActionMenuEl, setMobileActionMenuEl] =
    useState<HTMLDivElement | null>(null);
  const primaryPrNumber = prPresentation.primary?.number;
  // PR actions are tucked into the overflow menu. Fetch once when the session
  // branch changes so the menu does not open first and add its actions later.
  useEffect(() => {
    if (!hasRepoWork || primaryPrNumber) return;
    let stale = false;
    fetchGitStatus(session.id, session.repo || undefined)
      .then((status) => {
        if (!stale) setOverflowGit({ sessionId: session.id, status });
      })
      .catch(() => {
        if (!stale) setOverflowGit({ sessionId: session.id, status: null });
      });
    return () => {
      stale = true;
    };
  }, [hasRepoWork, primaryPrNumber, session.id, session.repo, session.branch]);
  useEffect(() => {
    setOverflowGit(null);
    setBranchActionBusy(null);
    setBranchConfirmOpen(false);
    setBranchConfirmMode("move");
  }, [session.id]);

  async function moveToBranchFromMenu() {
    if (isBusy || branchActionBusy) return;
    setBranchActionBusy("move");
    try {
      const result = await moveSessionToBranchApi(session.id);
      setOverflowOpen(false);
      setBranchConfirmOpen(false);
      toast(
        result.copiedFiles
          ? `Moved to ${result.branch} · ${result.copiedFiles} file${result.copiedFiles === 1 ? "" : "s"} copied`
          : `Moved to ${result.branch}`,
      );
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "Could not move to a branch",
      );
    }
    setBranchActionBusy(null);
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
    if (!connected || isBusy || branchActionBusy) return;
    setBranchActionBusy("create");
    try {
      const result = await moveSessionToBranchApi(session.id);
      setBranchConfirmOpen(false);
      requestCreatePr();
      toast(`Moved to ${result.branch}. Creating PR…`);
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "Could not move to a branch",
      );
    }
    setBranchActionBusy(null);
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
    setDeleteLabel(
      cleanWorktree ? "Deleting session and worktree…" : "Deleting session…",
    );
    setDeleting(true);
    try {
      await deleteSessionApi(session.id, cleanWorktree);
      // Leave the overlay up through the navigation so it never flashes back to
      // the (now-deleted) session view.
      goBack();
    } catch (error) {
      alert(
        `Delete failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  }

  // Archive is the reversible "I'm done with this" — unlike delete it keeps the
  // session (and worktree) and just tucks it into the Archived view, so no
  // confirm step. Unarchiving from here keeps the session selected as it moves
  // back into the live sidebar.
  const handleArchive = useCallback(async () => {
    const next = !session.archived;
    setArchiving(true);
    setOverflowOpen(false);
    if (next && onArchive) {
      onArchive();
      return;
    }
    try {
      const { stoppedRun } = await archiveSessionApi(session.id, next);
      if (next) {
        onArchived?.(stoppedRun);
        goBack();
      }
    } catch (error) {
      alert(
        `${next ? "Archive" : "Unarchive"} failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      setArchiving(false);
    }
  }, [
    onArchive,
    onArchived,
    goBack,
    session.archived,
    session.id,
    setArchiving,
    setOverflowOpen,
  ]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!focused) return;
      if (e.defaultPrevented || blockingOverlayOpen()) {
        return;
      }
      // Same composer exemption as the sidebar's archive chords: the
      // composer autofocuses, so an unconditional editable-focus bail
      // would leave ⌘E dead almost always. Other inputs keep the guard.
      const target = e.target as HTMLElement | null;
      const editable = target?.closest(
        "input, textarea, select, [contenteditable='true'], [contenteditable='']",
      );
      if (editable && !editable.classList.contains("composer-textarea")) {
        return;
      }
      if (matchesShortcut(e, "workspace-next-unread") && openNextChat) {
        e.preventDefault();
        openNextChat();
        return;
      }
      // The sidebar handles live sessions when it can, because it knows which
      // visible row comes next. Keep this listener as the route-level fallback:
      // the viewer remains mounted even when the sidebar cannot handle the open
      // session. `defaultPrevented` above ensures only one handler fires.
      if (matchesShortcut(e, "session-archive") && !archiving) {
        e.preventDefault();
        void handleArchive();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [focused, archiving, handleArchive, openNextChat, session.archived]);

  // Preview environment for the ⌘O chord — mirrors StagingLink's poll (same
  // relevance gate; the server caches PR details for 30s, so the duplicate
  // fetch stays cheap). Kept here because StagingLink mounts per layout
  // variant, so a window listener inside it would register multiple times.
  const stagingRelevant = phonePr
    ? (phonePr.state ??
        (phonePr.source === "primary" ? session.prState : undefined)) === "OPEN"
    : !!session.prUrl && session.prState === "OPEN";
  const [staging, setStaging] = useState<{
    url: string;
    status: string;
    embeddable?: boolean;
  } | null>(null);
  // True once the PR fetch has resolved at least once for this session — lets us
  // tell "staging genuinely absent" from "not loaded yet" (the fetch starts null
  // and fills in async), so the Preview environment view-tab auto-closes only on the former
  // rather than flicker-closing during load.
  const [stagingSettled, setStagingSettled] = useState(false);
  useEffect(() => {
    setStagingSettled(false);
    if (!stagingRelevant) {
      setStaging(null);
      setStagingSettled(true);
      return;
    }
    let alive = true;
    const load = () =>
      fetchPr(session.id, phonePr?.repo, phonePr?.branch)
        .then((pr) => {
          if (alive) {
            setStaging(pr?.staging ?? null);
            setStagingSettled(true);
          }
        })
        .catch(() => {});
    load();
    const stop = pollWhileVisible(load, PR_WEBHOOK_FALLBACK_POLL_MS);
    return () => {
      alive = false;
      stop();
    };
  }, [
    session.id,
    stagingRelevant,
    gitRefreshTick,
    phonePr?.repo,
    phonePr?.branch,
  ]);
  const stagingUrl = staging
    ? withPreviewPath(staging.url, session.previewPath)
    : null;
  // The Preview environment pane is a top-strip view-tab now (App owns whether it's
  // foregrounded). If the deploy vanishes while its tab is open+active — PR
  // merged/closed, so `stagingRelevant` drops and the fetch settles with no
  // staging — close the tab rather than leave it pointing at nothing.
  useEffect(() => {
    if (showStaging && stagingSettled && !stagingUrl) onCloseStaging?.();
  }, [showStaging, stagingSettled, stagingUrl, onCloseStaging]);
  // The Assets pane is a top-strip view-tab too (App owns whether it's
  // foregrounded). If the last asset is deleted while its tab is up, close it
  // rather than leave an empty pane pointing at nothing.
  useEffect(() => {
    if (showAssets && assetFiles.length === 0) onCloseAssets?.();
  }, [showAssets, assetFiles.length, onCloseAssets]);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus | null>(
    null,
  );
  useEffect(() => setPreviewStatus(null), [session.id]);
  async function startDeclaredPortal(recipe: PreviewPortalRecipe) {
    if (!recipe.command) {
      if (!recipe.skill) throw new Error("This Portal has no start command.");
      send({
        type: "prompt",
        sessionId: session.id,
        user: getCurrentUser(),
        content: `Use the $${recipe.skill} skill to start the “${recipe.name}” Portal, then verify it is ready.`,
      });
      return;
    }
    setPreviewStatus(await startPortalRecipeApi(session.id, recipe.id));
  }
  // Services with a route we can open: what the panel's tab strip reports
  // beside Portals, so the count is the openable ones rather than every port
  // the repository declares.
  const livePortals = (previewStatus?.services ?? []).filter((service) =>
    portalTargetFor(session.id, service),
  ).length;
  // Same reading beside Agents: how many are working right now. A finished
  // run stays on its page rather than keeping a number on the bar.
  const runningAgents =
    workflowRuns.reduce(
      (n, run) => n + run.agents.filter((a) => a.status === "running").length,
      0,
    ) + subagents.filter((s) => s.status === "running").length;
  // The header preview control used to keep this status warm. Now that the
  // launcher lives in the overflow menu. Keep status warm while Preview or the
  // portal browser is up, and while the workspace panel is open. Its bottom
  // bar counts live portals and its portals page lists them. Status requests
  // also renew the authenticated Caddy routes for remote sandbox services.
  useEffect(() => {
    if (
      (!showPreviewTab && !showPortal && !activePanelOpen && !infoPageOpen) ||
      !session.worktreeDir
    )
      return;
    let alive = true;
    const load = () =>
      fetchPreview(session.id)
        .then((status) => {
          if (alive) setPreviewStatus(status);
        })
        .catch(() => {});
    load();
    const stop = pollWhileVisible(load, 3000);
    return () => {
      alive = false;
      stop();
    };
  }, [
    showPreviewTab,
    showPortal,
    activePanelOpen,
    infoPageOpen,
    session.id,
    session.worktreeDir,
  ]);

  // ⌘O opens the PR's preview environment (the Vercel preview StagingLink's globe
  // points at); ⌘G opens its GitHub PR. Chords without a target (no staging
  // deploy / no PR) fall through to the browser.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!focused) return;
      const openPr = matchesShortcut(e, "open-pr");
      const openPreview = matchesShortcut(e, "open-preview");
      if (
        e.defaultPrevented ||
        (!openPr && !openPreview) ||
        blockingOverlayOpen()
      ) {
        return;
      }
      // Same composer exemption as the archive chords above: the composer
      // autofocuses, so an unconditional editable-focus bail would leave
      // these dead almost always. Other inputs keep the guard.
      const target = e.target as HTMLElement | null;
      const editable = target?.closest(
        "input, textarea, select, [contenteditable='true'], [contenteditable='']",
      );
      if (editable && !editable.classList.contains("composer-textarea")) {
        return;
      }
      if (openPr) {
        // Primary branch's PR, falling back to the first attached/linked
        // repo PR on multi-repo sessions.
        const prUrl = session.prUrl ?? session.prs?.find((p) => p.url)?.url;
        if (!prUrl) return;
        e.preventDefault();
        window.open(prUrl, "_blank", "noopener");
      } else if (openPreview && staging) {
        e.preventDefault();
        // Match the globe's click semantics: before the first deploy goes
        // Ready the branch alias 404s, so swallow the chord with the same
        // explanatory toast instead of opening a dead link. (A rebuild
        // after a push keeps status Ready and stays openable — the alias
        // serves the previous deploy until the new one lands.)
        if (staging.status !== "Ready") {
          toast(
            `Preview environment is ${staging.status.toLowerCase()}. The link goes live once the first deploy finishes.`,
          );
          return;
        }
        window.open(
          withPreviewPath(staging.url, session.previewPath),
          "_blank",
          "noopener",
        );
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focused, session.prUrl, session.prs, session.previewPath, staging]);

  // ⌘. asks to stop the running turn from anywhere in the session. Escape
  // asks the same question, but only with the composer focused — which is
  // exactly where you are not when you have been reading the transcript.
  //
  // Both land on the composer's own confirmation. The dialog, and the rule
  // that it goes away when the turn finishes on its own rather than stopping
  // the next one, live there; this only asks for it, through a counter, so
  // there is no second copy of any of that here. (The stop BUTTON stays
  // immediate: pressing it is already deliberate.)
  const [stopRequest, setStopRequest] = useState(0);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!focused || e.defaultPrevented) return;
      if (!matchesShortcut(e, "run-stop")) return;
      // Nothing running: leave the chord alone rather than swallowing it.
      if (!isBusy || forkFrom) return;
      e.preventDefault();
      setStopRequest((n) => n + 1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focused, isBusy, forkFrom]);

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
      {deleting && (
        <div
          /* `session-delete-overlay` stays on the markup as a bare hook with
					   no rule behind it: the Escape/outside-click handlers above ask
					   `closest('.palette-backdrop, .composer-schedule-modal-backdrop,
					   .session-delete-overlay')` whether a click landed on a blocking
					   surface. Drop the name and a click through this overlay starts
					   dismissing what's underneath it. */
          className="session-delete-overlay absolute inset-0 z-30 flex items-center justify-center bg-[color-mix(in_srgb,var(--bg)_72%,transparent)] backdrop-blur-[2px]"
          role="status"
          aria-live="polite"
        >
          <div className="flex flex-col items-center gap-[14px] rounded-xl border border-line bg-panel px-8 py-[26px] smooth-shadow-lg">
            {/* `rounded-full` rather than `rounded-[50%]`: base.css grants the
						    squircle to every `rounded-*` class EXCEPT `rounded-full`, and
						    this ring was a bare `border-radius: 50%` with no corner-shape.
						    It serialises as a clamped huge px value instead of 50%, which
						    on a square box is the same circle. */}
            <div className="size-[30px] animate-[spin_0.8s_linear_infinite] rounded-full border-2 border-line-strong border-t-accent" />
            <span className={SESSION_DELETE_LABEL}>{deleteLabel}</span>
          </div>
        </div>
      )}
      {confirmDialog}
      <DeleteSessionDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        hasWorktree={Boolean(session.worktreeDir && !isAsk)}
        deleting={deleting}
        onDelete={(cleanWorktree) => void handleDelete(cleanWorktree)}
      />
      <Modal.Root
        open={branchConfirmOpen}
        onOpenChange={(open) => {
          if (!branchActionBusy) setBranchConfirmOpen(open);
        }}
        disablePointerDismissal={branchActionBusy !== null}
      >
        <Modal.Content>
          <Modal.Header title="Move to a branch?" />
          <Modal.Description className="m-0 text-pretty text-supporting font-normal leading-relaxed text-dim">
            {branchConfirmMode === "create"
              ? "You need to move this session to a branch before you can create a PR."
              : "Copies this session’s changes to a new branch without removing them from the shared checkout."}
          </Modal.Description>
          <Modal.Footer>
            <Modal.Close
              render={
                <Button variant="ghost" disabled={branchActionBusy !== null}>
                  Cancel
                </Button>
              }
            />
            <Button
              variant="primary"
              disabled={
                isBusy ||
                branchActionBusy !== null ||
                (branchConfirmMode === "create" && !connected)
              }
              onClick={() =>
                void (branchConfirmMode === "create"
                  ? moveAndCreatePr()
                  : moveToBranchFromMenu())
              }
            >
              {branchActionBusy
                ? "Moving…"
                : branchConfirmMode === "create"
                  ? "Move and create PR"
                  : "Move to branch"}
            </Button>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
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
        )}

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
            <div className={VIEWER_REVIEW_MAIN}>
              <PortalPane target={portalTarget} />
            </div>
          ) : showPreviewTab ? (
            <div className={VIEWER_REVIEW_MAIN}>
              <PreviewPane
                session={session}
                status={previewStatus}
                onClose={() => onClosePreviewTab?.()}
              />
            </div>
          ) : showStaging && stagingUrl ? (
            staging?.embeddable ? (
              // This deploy opts into being framed by this app (its CSP
              // frame-ancestors names our origin), so we embed it inline.
              // When the deploy's session cookie is scoped to a parent
              // domain this app also sits under (SameSite=None; Secure), it
              // rides into the frame on every device, iOS included, so a
              // logged-in reviewer sees the deploy directly. A
              // logged-OUT one gets a blank frame (staging redirects to
              // WorkOS AuthKit, which refuses framing), so the header keeps a
              // first-party "Open" break-out to log in, then come back.
              <div className={VIEWER_REVIEW_MAIN}>
                <div className="flex h-full flex-col">
                  <div className="flex items-center gap-2 border-b border-divider bg-panel px-3 py-1.5 text-xs text-dim">
                    <IconGlobe size={14} />
                    <span className="truncate">
                      Preview environment
                      {staging.status !== "Ready"
                        ? ` · ${staging.status.toLowerCase()}…`
                        : ""}
                    </span>
                    <div className="ml-auto flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() =>
                          shareLink(stagingUrl, { toast: "Link copied" })
                        }
                        className="inline-flex items-center gap-1 transition-colors hover:text-fg"
                      >
                        <IconCopy size={13} />
                        Copy link
                      </button>
                      <a
                        href={stagingUrl}
                        target="_blank"
                        rel="noopener"
                        title="Open first-party in a new tab. Needed if the frame is blank because you aren't logged in to the preview environment yet."
                        className="inline-flex items-center gap-1 transition-colors hover:text-fg"
                      >
                        Open
                        <IconArrowUpRight size={13} />
                      </a>
                    </div>
                  </div>
                  <iframe
                    key={stagingUrl}
                    src={stagingUrl}
                    title="Preview environment"
                    className="min-h-0 flex-1 border-0 bg-surface"
                    allow="camera; microphone; display-capture; fullscreen; autoplay; clipboard-write"
                  />
                </div>
              </div>
            ) : (
              // Deploy hasn't opted into being framed (older preview, or the
              // fusion CSP change hasn't reached it yet) — open it
              // first-party in a new tab rather than show a blocked frame.
              <div className={VIEWER_REVIEW_MAIN}>
                <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
                  <IconGlobe size={40} className="text-dim" />
                  <div className="flex flex-col items-center gap-1">
                    <div className="text-base font-medium text-fg">
                      Preview environment
                    </div>
                    <div className="text-xs text-dim">
                      {staging?.status === "Ready"
                        ? "Test this PR on real infra"
                        : `Deploy is ${(staging?.status ?? "building").toLowerCase()}…`}
                    </div>
                  </div>
                  <a
                    href={stagingUrl}
                    target="_blank"
                    rel="noopener"
                    className="inline-flex items-center gap-2 rounded-md border border-line bg-surface px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-panel"
                  >
                    <IconGlobe size={16} />
                    Open staging
                    <IconArrowUpRight size={16} />
                  </a>
                  <button
                    type="button"
                    onClick={() =>
                      shareLink(stagingUrl, { toast: "Link copied" })
                    }
                    className="inline-flex items-center gap-1.5 text-xs text-dim transition-colors hover:text-fg"
                  >
                    <IconCopy size={14} />
                    Copy link
                  </button>
                  <div className="max-w-xs text-xs leading-relaxed text-dim">
                    Opens in a new tab. This deploy isn&apos;t set up to embed
                    here yet.
                  </div>
                </div>
              </div>
            )
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
                <FeedWebPane
                  panel={videoPanel}
                  title={videoTitle || undefined}
                />
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
                onOpenSessionById={openSession}
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
                    navigation.startNewChat(
                      session,
                      withQuotes([selection], ""),
                    )
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
                              {workspaceName ||
                                session.branch ||
                                "this workspace"}
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
                                  onClick={() =>
                                    setShowAllContextSessions(true)
                                  }
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
                      onReconnectSlack={async () => {
                        await reconnectSlack();
                        setSlackComposerReconnect(false);
                        toast("Approve image access in Slack, then send again");
                      }}
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
                  <div
                    ref={spacerRef}
                    className={TURN_SPACER}
                    aria-hidden="true"
                  />
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

                {/* The pill belongs to the head of the transcript, so it only
							    shows while the reader is in reach of it. Over the live tail
							    it was an offer for something far above, floating across
							    whatever was being read. The loading state ignores the gate:
							    the prepend it reports pushes the reader away from the top,
							    and hiding the pill mid-load takes the feedback with it. */}
                {!transcriptIndexExpected &&
                  historyTruncated &&
                  (atTop || loadingHistory) && (
                    <div className={TRANSCRIPT_PILL_TOP}>
                      {loadingHistory ? (
                        <div className={TRANSCRIPT_PILL_LOADING}>
                          <span
                            className={TRANSCRIPT_PILL_SPINNER}
                            aria-hidden
                          />
                          <span>
                            {loadingAllHistory
                              ? "Loading all messages…"
                              : "Loading older messages…"}
                          </span>
                        </div>
                      ) : (
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
                      )}
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
                    {actionBand && (
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
                                  icon={
                                    <IconArrowRight size={22} aria-hidden />
                                  }
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
                          session.source === "opensession"
                            ? accounts
                            : undefined,
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
                        onRemovePendingImage: uploads.cancelPendingImage,
                        onRemovePendingFile: uploads.cancelPendingFile,
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
                              {promoting
                                ? "Switching to code…"
                                : "Switch to code"}
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

        {/* Right region: the Workspace panel. Portaled to an app-level slot so
            it opens as a full-height column beside the left sidebar (not just
            below the session header). */}
        <SidePanelHost
          hidden={hideRightPanel}
          isPhone={isPhone}
          available={panelAvailable}
          open={activePanelOpen}
          onOpenChange={setActivePanelOpen}
          portalTarget={rightPanelEl}
          style={panelStyle}
          resizeHandle={panelResizeHandle}
          hasWorkspace={hasWorkspace}
          page={desktopPanelPage}
          onPageChange={setDesktopPanelPage}
          livePortals={livePortals}
          runningAgents={runningAgents}
          terminalMounted={panelTerminalMounted}
          onTerminalMount={() => setPanelTerminalMounted(true)}
          sessionId={session.id}
          changes={
            <>
              <section
                aria-label="Workspace summary"
                className="flex flex-col border-b border-divider py-2"
              >
                <WorkspaceSummaryBody
                  session={session}
                  onOpenPanelTab={(tab) => {
                    if (tab === "changes") {
                      desktopChangesRef.current?.scrollIntoView({
                        block: "start",
                      });
                      return;
                    }
                    focusPrInReview();
                  }}
                  onOpenPr={() => focusPrInReview()}
                  onOpenStackPr={openPr}
                  onOpenChecks={() => focusPrInReview(undefined, "checks")}
                  onOpenAsset={openAssetFromTranscript}
                  onOpenAssets={openAssets}
                  onOpenSession={openSession}
                  onArchive={handleArchive}
                  reviewRequest={effectiveReview?.req ?? null}
                  reviewRequestSessionId={effectiveReview?.ownerId}
                  onReviewChange={onReviewChange}
                  prReviewRequested={effectiveReview?.prReviewRequested}
                  running={isRunningLive}
                  workspacePreparing={workspacePreparing}
                  send={connected ? send : undefined}
                  refreshTick={gitRefreshTick}
                  liveMedia={liveOverviewMedia}
                  close={() => setActivePanelOpen(false)}
                />
              </section>
              <div ref={desktopChangesRef}>
                {waitingForWorkspace ? (
                  <WorkspaceWaiting detail="This takes a moment." />
                ) : (
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
                )}
              </div>
            </>
          }
          portals={
            <PortalsPage
              sessionId={session.id}
              status={previewStatus}
              activePortal={portalTarget}
              onBack={() => setActivePanelOpen(false)}
              hideHeader
              onOpenPortal={openPortal}
              onStartPortal={startDeclaredPortal}
              onPortalAction={async (name, action) => {
                setPreviewStatus(
                  await portalActionApi(session.id, name, action),
                );
              }}
            />
          }
          agents={
            <WorkflowPanel
              sessionId={session.id}
              runs={workflowRuns}
              onAction={workflowAction}
              subagents={subagents}
              onOpenSubagent={openSubagent}
              onOpenSession={openSession}
              onBack={() => setActivePanelOpen(false)}
              hideHeader
            />
          }
        />
      </div>
      {/* Portals to the body, so it sits over the whole viewer rather than
			    inside whichever column opened it. */}
      <AssetOverlay
        sessionId={session.id}
        path={overlayAssetPath}
        files={assetFiles}
        refresh={refreshAssets}
        onClose={closeAssetOverlay}
        onSelectPath={setOverlayAssetPath}
        onOpenAsTab={openAssets ? promoteAssetToTab : undefined}
        onOpenNewSession={navigation.openPrefilledSession}
      />
    </div>
  );
}

// Placeholder for regions that need the session's worktree while the create
// run is still preparing it (new-workspace creates announce the session before
// the slow git work — see create_session in opensession.ts).
