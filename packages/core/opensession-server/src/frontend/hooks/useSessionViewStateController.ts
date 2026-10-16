import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ReplySuggestion } from "../lib/reply-suggestions";
import {
  getComposerPredictionsPref,
  onComposerPredictionsChanged,
} from "../lib/composer-prediction-pref";
import {
  getReplySuggestionsPref,
  onReplySuggestionsChanged,
} from "../lib/reply-suggestions";
import {
  getNextChatButtonPref,
  onNextChatButtonChanged,
} from "../lib/next-chat-pref";
import type {
  CommentThread,
  TranscriptEntry,
  UnifiedSession,
} from "../lib/types";
import type { SlackSent } from "../components/ShippedChangeComposer";
import { EMPTY_SUGGESTIONS } from "../lib/session-viewer-constants";
import {
  useComposerQueueState,
  useSessionAttachmentDrop,
  useSessionComposerDraft,
  useSessionPromptOutbox,
} from "./useSessionComposerController";
import {
  PRIVATE_ATTACHMENTS_UNAVAILABLE,
  isPrivateSession,
} from "../lib/private-session-attachments";
import { useSessionRuntime } from "./useSessionRuntime";
import { useSessionRuntimeController } from "./useSessionRuntimeController";
import { reviewLoopResult, type ReviewLoopResult } from "../lib/review-loop";
import { useSidePanel } from "./useSidePanel";
import { useSessionAssets } from "../components/AssetsPanel";
import { setOpenAsset, useOpenAssetPath } from "../lib/asset-overlay-store";
import { useSessionReports } from "../components/SessionReportsPanel";
import { useSessionDatabases } from "../components/SessionDatabasesPanel";
import { fetchThreadsApi } from "../lib/api";
import { timelineThreads, upsertThread } from "../lib/comment-threads";
import { clearMention, onMentionsChanged } from "../lib/mentions";
import { watchSessionNotifications } from "../lib/notifications";
import { useCopy } from "../ui/copy";
import { useSessionHeaderLayout } from "./useSessionViewerActionsController";
import {
  workspaceSummaryOpen,
  WS_SUMMARY_ROOM_W,
  workspaceSummaryShift,
} from "../lib/workspace-summary-open";
import { useLivePlan } from "../components/session-viewer/use-live-plan";
import type { WorkflowRunSnapshot } from "../../server/workflow-types";
import type { useSessionSocket } from "./useSessionSocket";
import type { LiveTurnStore } from "../lib/live-turn-store";
import type { TranscriptViewStore } from "../lib/transcript-view-store";
import type { SessionPrRef } from "../lib/types";
import type { PortalTarget } from "../lib/portals";
import { onPortalPinRequest } from "../lib/portal-pin";
import type { SessionViewerProps } from "../lib/session-viewer-bindings";

type WorkspaceSummaryStyle = CSSProperties & {
  "--ws-summary-step": string;
};

interface ViewStateIdentity {
  session: UnifiedSession;
  focused: boolean;
  optimisticEmpty: boolean;
  connected: boolean;
  initialPending?: {
    content: string;
    user: string;
    sentAt: number;
    images?: string[];
    pastedTexts?: string[];
  };
  workspaceSessions?: UnifiedSession[];
  onSetStatus: SessionViewerProps["workspace"]["onSetStatus"];
}

interface ViewStateTranscript {
  entries: TranscriptEntry[];
  loading: boolean;
  liveTurnStore: LiveTurnStore;
  setEntries: (
    update:
      | TranscriptEntry[]
      | ((previous: TranscriptEntry[]) => TranscriptEntry[]),
  ) => void;
  transcriptViewStore: TranscriptViewStore;
}

interface ViewStateSurface {
  phonePr?: SessionPrRef;
  showStaging: boolean;
  onCloseStaging?: () => void;
  showReview: boolean;
  sessionHidden: boolean;
  openAssets?: () => void;
  onOpenSubagent?: (sessionId: string, agentId: string, label: string) => void;
  onSubagentLabel?: (sessionId: string, agentId: string, label: string) => void;
}

interface ViewStateSocket {
  send: ReturnType<typeof useSessionSocket>["send"];
  addHandler: ReturnType<typeof useSessionSocket>["addHandler"];
}

export function useSessionViewStateController({
  identity,
  transcript,
  surface,
  socket,
}: {
  identity: ViewStateIdentity;
  transcript: ViewStateTranscript;
  surface: ViewStateSurface;
  socket: ViewStateSocket;
}) {
  const { session } = identity;
  const {
    phonePr,
    showStaging,
    onCloseStaging,
    showReview,
    sessionHidden,
    openAssets,
    onOpenSubagent,
    onSubagentLabel,
  } = surface;
  const { send, addHandler } = socket;
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
  const [runtime, dispatchSessionRuntime] = useSessionRuntime({
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
      focused: identity.focused,
      optimisticEmpty: identity.optimisticEmpty,
      workspaceSessions: identity.workspaceSessions,
      onSetStatus: identity.onSetStatus,
    },
    run: {
      isRunningLive: runtime.isRunningLive,
      isStreaming: runtime.isStreaming,
      safety: runtime.safety,
      entries: transcript.entries,
      loading: transcript.loading,
      liveTurnStore: transcript.liveTurnStore,
      forkFrom,
    },
    staging: {
      phonePr,
      show: showStaging,
      onClose: onCloseStaging,
    },
    socket: { send },
  });
  const queueState = useComposerQueueState();
  const setComposerPrefillRef = useRef(queueState.setComposerPrefill);
  const [replySuggestions, setReplySuggestions] =
    useState<ReplySuggestion[]>(EMPTY_SUGGESTIONS);
  const [composerPrediction, setComposerPrediction] = useState<string | null>(
    null,
  );
  const [showComposerPrediction, setShowComposerPrediction] = useState(
    getComposerPredictionsPref,
  );
  useEffect(
    () =>
      onComposerPredictionsChanged(() =>
        setShowComposerPrediction(getComposerPredictionsPref()),
      ),
    [],
  );
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
    identity: { sessionId: session.id, connected: identity.connected },
    runtime: {
      dispatch: dispatchSessionRuntime,
      initialPending: identity.initialPending,
    },
    transcript: {
      entries: transcript.entries,
      setEntries: transcript.setEntries,
    },
  });
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
  const copy = useCopy();
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [infoPageOpen, setInfoPageOpen] = useState(false);
  const [infoPageScrolled, setInfoPageScrolled] = useState(false);
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
  const wt = session.walkthrough;
  const wtSummary = wt?.summary ?? "";
  const wtVideo = wt?.video;
  const wtVideoTitle = wt?.videoTitle;
  const wtShots = wt?.shots;
  const wtPublishedAt = wt?.publishedAt ?? "";
  const wtPublishedBy = wt?.publishedBy;
  const wtPublishedEntryId = wt?.publishedEntryId;
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
  const reviewResultValue = reviewLoopResult(session);
  const reviewStatus = reviewResultValue?.status;
  const reviewConfidence = reviewResultValue?.confidence;
  const reviewChecksPassed = reviewResultValue?.checksPassed;
  const reviewChecksFailed = reviewResultValue?.checksFailed;
  const reviewBlocking = reviewResultValue?.blocking;
  const reviewResult = useMemo(() => {
    if (!reviewStatus) return undefined;
    const result: ReviewLoopResult = { status: reviewStatus };
    if (reviewConfidence !== undefined) result.confidence = reviewConfidence;
    if (reviewChecksPassed !== undefined)
      result.checksPassed = reviewChecksPassed;
    if (reviewChecksFailed !== undefined)
      result.checksFailed = reviewChecksFailed;
    if (reviewBlocking !== undefined) result.blocking = reviewBlocking;
    return result;
  }, [
    reviewBlocking,
    reviewChecksFailed,
    reviewChecksPassed,
    reviewConfidence,
    reviewStatus,
  ]);
  const sidePanel = useSidePanel();
  const [reviewPanelOpen, setReviewPanelOpen] = useState(false);
  const activePanelOpen = showReview ? reviewPanelOpen : sidePanel.open;
  const setActivePanelOpen = showReview
    ? setReviewPanelOpen
    : sidePanel.setOpen;
  const [panelPage, setPanelPage] = useState<
    null | "changes" | "portals" | "agents" | "terminal"
  >(null);
  const [panelTerminalMounted, setPanelTerminalMounted] = useState(
    () => activePanelOpen && sidePanel.page === "terminal",
  );
  const [pinnedPortal, setPinnedPortal] = useState<PortalTarget | null>(null);
  const handledSidebarPortalsRef = useRef(new Set<string>());
  useEffect(() => {
    handledSidebarPortalsRef.current.clear();
  }, [session.id]);
  const sidebarPortalIdentity = (target: PortalTarget) =>
    `${target.sessionId}\u0000${target.key}\u0000${target.name}`;
  const pinPortal = (target: PortalTarget) => {
    if (target.sessionId !== session.id) return;
    const identity = sidebarPortalIdentity(target);
    handledSidebarPortalsRef.current.add(identity);
    setPinnedPortal(target);
  };
  const autoPinPortal = (target: PortalTarget) => {
    if (
      target.sessionId !== session.id ||
      pinnedPortal?.sessionId === session.id
    )
      return false;
    const identity = sidebarPortalIdentity(target);
    if (handledSidebarPortalsRef.current.has(identity)) return false;
    handledSidebarPortalsRef.current.add(identity);
    setPinnedPortal(target);
    return true;
  };
  // A Portal tab dropped on the side panel (see useSessionTabs) lands here.
  const pinDroppedPortal = useEffectEvent((target: PortalTarget) => {
    if (target.sessionId !== session.id) return;
    pinPortal(target);
    setActivePanelOpen(true);
  });
  useEffect(() => onPortalPinRequest(pinDroppedPortal), []);
  const closePinnedPortal = () => {
    if (pinnedPortal?.sessionId !== session.id) return;
    setPinnedPortal(null);
  };
  const expandPinnedPortal = () => {
    if (pinnedPortal?.sessionId !== session.id) return null;
    const target = pinnedPortal;
    setPinnedPortal(null);
    return target;
  };
  const assets = useSessionAssets(session.id, addHandler);
  const assetPaths = useMemo(
    () => assets.files.map((file) => file.path),
    [assets.files],
  );
  const [selectedAssetPath, setSelectedAssetPath] = useState<string | null>(
    null,
  );
  const overlayAssetPath = useOpenAssetPath(session.id);
  const setOverlayAssetPath = useCallback(
    (path: string | null) => setOpenAsset(session.id, path),
    [session.id],
  );
  const openAssetsRef = useRef(openAssets);
  useLayoutEffect(() => {
    openAssetsRef.current = openAssets;
  }, [openAssets]);
  const openAssetFromTranscript = useCallback(
    (path: string) => setOverlayAssetPath(path),
    [setOverlayAssetPath],
  );
  const closeAssetOverlay = useCallback(
    () => setOverlayAssetPath(null),
    [setOverlayAssetPath],
  );
  const promoteAssetToTab = useCallback(
    (path: string) => {
      setSelectedAssetPath(path);
      setOverlayAssetPath(null);
      openAssetsRef.current?.();
    },
    [setOverlayAssetPath],
  );
  const sessionReports = useSessionReports(session.id, addHandler);
  const sessionDatabases = useSessionDatabases(session.id, addHandler);
  const [threads, setThreads] = useState<CommentThread[]>([]);
  // The timeline's team notes are the threads without a passage. Derived
  // once here so the transcript's memoized blocks see a stable array.
  const comments = useMemo(
    () => ({ threads, notes: timelineThreads(threads) }),
    [threads],
  );
  const [noteMode, setNoteMode] = useState(false);
  const attachmentDrop = useSessionAttachmentDrop({
    identity: {
      focused: identity.focused,
      sessionHidden,
      noteMode,
      // Authoritative privacy: the server-projected scope, never a name.
      attachmentsUnavailable: isPrivateSession(session)
        ? PRIVATE_ATTACHMENTS_UNAVAILABLE
        : undefined,
    },
    draft: { draftKey, setImages, setFiles, uploads },
  });
  useEffect(() => {
    setThreads([]);
    setNoteMode(false);
    let cancelled = false;
    fetchThreadsApi(session.id)
      .then((loaded) => {
        if (!cancelled && loaded.length) setThreads(loaded);
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
          (msg.type !== "comment_thread" &&
            msg.type !== "comment_thread_deleted") ||
          msg.sessionId !== session.id
        )
          return;
        if (msg.type === "comment_thread_deleted") {
          setThreads((prev) => prev.filter((t) => t.id !== msg.threadId));
          return;
        }
        setThreads((prev) => upsertThread(prev, msg.thread));
      }),
    [addHandler, session.id],
  );
  useEffect(() => {
    clearMention(session.id);
    return onMentionsChanged(() => clearMention(session.id));
  }, [session.id]);
  useEffect(() => watchSessionNotifications(session.id), [session.id]);

  return {
    composer: {
      ...composerDraft.attachments,
      ...composerDraft.fork,
      composerSettersRef,
    },
    runtime: { ...runtime, dispatchSessionRuntime, runtimeController },
    queue: {
      ...queueState,
      setComposerPrefillRef,
      ...composerOutbox.pending,
      ...composerOutbox.durable,
    },
    preferences: {
      replySuggestions,
      setReplySuggestions,
      showReplySuggestions,
      // Null while the person has predictions switched off.
      composerPrediction: showComposerPrediction ? composerPrediction : null,
      setComposerPrediction,
      showNextChatButton,
    },
    slack: {
      slackComposer,
      setSlackComposer,
      slackComposerStatus,
      setSlackComposerStatus,
      slackComposerReconnect,
      setSlackComposerReconnect,
      slackComposerSent,
      setSlackComposerSent,
    },
    chrome: {
      copied: copy.copied,
      shareLink: copy.share,
      renameDraft,
      setRenameDraft,
      infoPageOpen,
      setInfoPageOpen,
      infoPageScrolled,
      setInfoPageScrolled,
    },
    subagents: { openSubagent, nameSubagent },
    presentation: { sessionWalkthrough, reviewResult },
    panel: {
      panelOpen: sidePanel.open,
      setPanelOpen: sidePanel.setOpen,
      desktopPanelPage: sidePanel.page,
      setDesktopPanelPage: sidePanel.setPage,
      panelStyle: sidePanel.style,
      panelResizeHandle: sidePanel.resizeHandle,
      activePanelOpen,
      setActivePanelOpen,
      panelPage,
      setPanelPage,
      panelTerminalMounted,
      setPanelTerminalMounted,
      pinnedPortal:
        pinnedPortal?.sessionId === session.id ? pinnedPortal : null,
      pinPortal,
      autoPinPortal,
      closePinnedPortal,
      expandPinnedPortal,
    },
    assets: {
      assetFiles: assets.files,
      refreshAssets: assets.refresh,
      assetPaths,
      selectedAssetPath,
      setSelectedAssetPath,
      overlayAssetPath,
      setOverlayAssetPath,
      closeAssetOverlay,
      promoteAssetToTab,
      openAssetFromTranscript,
    },
    notes: {
      sessionReports,
      sessionDatabases,
      comments,
      setThreads,
      noteMode,
      setNoteMode,
      ...attachmentDrop,
    },
  };
}

interface HeaderLayoutControllerOptions {
  topbarEl?: HTMLElement | null;
  activePanelOpen: boolean;
  desktopPanelPage: string;
  setPanelTerminalMounted: Dispatch<SetStateAction<boolean>>;
  infoPageOpen: boolean;
  setPanelPage: Dispatch<
    SetStateAction<null | "changes" | "portals" | "agents" | "terminal">
  >;
  composerRef: MutableRefObject<HTMLTextAreaElement | null>;
  hasRepoWork: boolean;
  workflowRuns: WorkflowRunSnapshot[];
  subagents: Array<{ status: string }>;
  entries: TranscriptEntry[];
  isBusy: boolean;
}
export function useSessionHeaderLayoutController(
  options: HeaderLayoutControllerOptions,
) {
  const {
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
  } = options;
  const stableComposerRef = useRef(composerRef);
  const headerLayout = useSessionHeaderLayout({
    topbarEl,
    workspaceSummaryOpen,
  });
  const { headerW } = headerLayout.width;
  const { summaryOpen } = headerLayout.summary;
  const { isPhone } = headerLayout.viewport;
  useEffect(() => {
    if (!activePanelOpen) {
      setPanelTerminalMounted(false);
    } else if (!isPhone && desktopPanelPage === "terminal") {
      setPanelTerminalMounted(true);
    }
  }, [activePanelOpen, desktopPanelPage, isPhone, setPanelTerminalMounted]);
  const summaryHasRoom = headerW === 0 || headerW >= WS_SUMMARY_ROOM_W;
  const summaryVisible =
    summaryOpen &&
    summaryHasRoom &&
    !activePanelOpen &&
    !isPhone &&
    hasRepoWork;
  const summaryStep = summaryVisible ? workspaceSummaryShift(headerW) : 0;
  const summaryStepStyle: WorkspaceSummaryStyle | undefined =
    summaryStep > 0 ? { "--ws-summary-step": `-${summaryStep}px` } : undefined;
  useEffect(() => {
    if (isPhone && !infoPageOpen) setPanelPage(null);
  }, [isPhone, infoPageOpen, setPanelPage]);
  const focusComposerForQuote = useCallback(() => {
    const composer = stableComposerRef.current.current;
    composer?.focus({ preventScroll: true });
    return composer;
  }, []);
  const runningWorkflowRuns = workflowRuns.filter(
    (run) => run.status === "running" || run.status === "paused",
  );
  const anySubagentRunning = subagents.some(
    (subagent) => subagent.status === "running",
  );
  const showAgents =
    isPhone && (runningWorkflowRuns.length > 0 || anySubagentRunning);
  const livePlan = useLivePlan(entries, isBusy);
  return {
    layout: {
      ...headerLayout.elements,
      ...headerLayout.width,
      ...headerLayout.summary,
      ...headerLayout.viewport,
    },
    summary: { summaryHasRoom, summaryVisible, summaryStep, summaryStepStyle },
    composer: { focusComposerForQuote },
    agents: { runningWorkflowRuns, anySubagentRunning, showAgents, livePlan },
  };
}
