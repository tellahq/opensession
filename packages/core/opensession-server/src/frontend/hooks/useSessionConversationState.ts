import { z } from "zod";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ModelOption, ProviderAccountOption } from "../lib/api";
import { repairPausedSession } from "../lib/api/session-safety";
import type { FileAttachment } from "../lib/images";
import type { Quote } from "../lib/quotes";
import type {
  ShippedChangeComposerProps,
  SlackSent,
} from "../components/ShippedChangeComposer";
import type {
  SessionSlackShare,
  TranscriptEntry,
  UnifiedSession,
  WSClientMessage,
} from "../lib/types";
import { modelIsCodex } from "../components/session-viewer/model-labels";
import { suggestedShippedChangeMessage } from "../lib/shipped-change-copy";
import {
  cancelComposedSlackMessageAction,
  reconnectShippedSlackAction,
  sendComposedSlackMessageAction,
  shareSessionAction,
  openSlackComposerAction,
  undoComposedSlackMessageAction,
} from "../lib/session-viewer-actions";
import { safetyContinuationPrompt } from "../lib/session-safety";
import { CONTINUE_AFTER_FAILURE_PROMPT } from "../lib/continue-run";
import { getCurrentUser } from "../components/UserPicker";
import { toast } from "../ui/toast";
import { useConfirm } from "../ui/confirm";
import { loadDraft } from "../lib/drafts";
import { prReviewCompletion } from "../lib/review-queue";
import type { useNavigation } from "./useNavigation";
import type { useSessionRuntime } from "./useSessionRuntime";
import type { useSessionSocket } from "./useSessionSocket";
import { useImageRegionComposer } from "./useSessionComposerController";
import {
  commitSessionQueueReorder,
  discardSessionOutboxItem,
  reorderSessionQueue,
  sendSessionMessage,
  takeSessionQueueItem,
} from "../lib/session-viewer-send";
import { deriveSessionQueue, type QueueReceipt } from "../lib/session-queue";
import type { PromptOutboxItem } from "../lib/prompt-outbox";
import type { LiveTurnStore } from "../lib/live-turn-store";

interface AvailabilityIdentity {
  session: UnifiedSession;
  model: string;
  defaultModel: string;
  models: ModelOption[];
  entries: TranscriptEntry[];
}

export function sessionConversationAvailability({
  session,
  model,
  defaultModel,
  models,
  entries,
}: AvailabilityIdentity) {
  const effectiveModel = model || defaultModel;
  const isCodexModel = modelIsCodex(effectiveModel, models);
  const noEngine =
    !isCodexModel && !session.ran && session.source !== "opensession";
  const latestAssistantMessage =
    entries
      .findLast((entry) => entry.type === "assistant" && entry.content.trim())
      ?.content.trim() || "";
  return { effectiveModel, isCodexModel, noEngine, latestAssistantMessage };
}

interface ShippedPresentationIdentity {
  session: UnifiedSession;
  mergedPr?: { number?: number; title?: string };
  shippedShare: SessionSlackShare | null;
  shareDismissed: boolean;
  shippedScreenshot?: string;
  latestAssistantMessage: string;
}

interface ShippedPresentationActions {
  reconnectRequired: boolean;
  status: "idle" | "sharing";
  send: (
    message: string,
    channel: string,
    screenshots: string[],
  ) => Promise<void>;
  reconnect: () => Promise<void>;
  undo: (at: string) => Promise<void>;
  dismiss: () => void;
}

type ShippedChangeShare = ShippedChangeComposerProps & { prNumber: number };

export function useShippedChangePresentation({
  identity,
  actions,
}: {
  identity: ShippedPresentationIdentity;
  actions: ShippedPresentationActions;
}) {
  const {
    session,
    mergedPr,
    shippedShare,
    shareDismissed,
    shippedScreenshot,
    latestAssistantMessage,
  } = identity;
  const { reconnectRequired, status, send, reconnect, undo, dismiss } = actions;
  const shippedSentValue =
    shippedShare ||
    (mergedPr
      ? session.slackShares?.findLast(
          (share) => share.prNumber === mergedPr.number,
        )
      : undefined);
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
  const shippedChangeShare = useMemo(() => {
    if (mergedPr?.number === undefined || shareDismissed) return undefined;
    const share: ShippedChangeShare = {
      prNumber: mergedPr.number,
      sessionId: session.id,
      defaultMessage: suggestedShippedChangeMessage(
        mergedPr.title || "an update",
        session.walkthrough?.summary,
      ),
      screenshot: shippedScreenshot,
      reconnectRequired,
      status,
      onShare: send,
      onReconnectSlack: reconnect,
      onCancel: dismiss,
      nextMessage: latestAssistantMessage,
    };
    if (shippedSent) {
      share.sent = {
        channelName: shippedSent.channelName,
        permalink: shippedSent.permalink,
        receiptKey: shippedSent.at,
      };
      if (shippedSent.ts) share.onUndo = () => undo(shippedSent.at);
    }
    return share;
  }, [
    mergedPr,
    reconnectRequired,
    shippedScreenshot,
    session.id,
    session.walkthrough?.summary,
    send,
    reconnect,
    undo,
    dismiss,
    shareDismissed,
    status,
    shippedSent,
    latestAssistantMessage,
  ]);
  return { shippedSent, shippedChangeShare };
}

interface SlackComposerState {
  composer: {
    id: string;
    message: string;
    channel?: string;
    images: string[];
  } | null;
  setComposer: Dispatch<SetStateAction<SlackComposerState["composer"]>>;
  setStatus: Dispatch<SetStateAction<"idle" | "sharing">>;
  setReconnect: Dispatch<SetStateAction<boolean>>;
  setSent: Dispatch<SetStateAction<SlackSent | null>>;
}

interface ConversationActionIdentity {
  session: UnifiedSession;
  entries: TranscriptEntry[];
  queued: ReturnType<typeof useSessionRuntime>[0]["queued"];
}

type CreateSessionMessage = Extract<
  WSClientMessage,
  { type: "create_session" }
>;

type SessionFork = NonNullable<CreateSessionMessage["forkFrom"]>;

interface ConversationActionRuntime {
  send: ReturnType<typeof useSessionSocket>["send"];
  dispatch: ReturnType<typeof useSessionRuntime>[1];
  onRunningChange?: (id: string, isRunning: boolean) => void;
  openSession?: (id: string) => void;
  openAsset: (path: string) => void;
  navigation: ReturnType<typeof useNavigation>;
  composerSettersRef: MutableRefObject<{
    setImages: Dispatch<SetStateAction<string[]>>;
    setFiles: Dispatch<SetStateAction<FileAttachment[]>>;
    setForkFrom: Dispatch<
      SetStateAction<
        { kind: "tip" } | { kind: "message"; messageId: string } | null
      >
    >;
  }>;
}

export function useSessionConversationActions({
  identity,
  slack,
  runtime,
}: {
  identity: ConversationActionIdentity;
  slack: SlackComposerState;
  runtime: ConversationActionRuntime;
}) {
  const { session, entries, queued } = identity;
  const {
    composer: slackComposer,
    setComposer,
    setStatus,
    setReconnect,
    setSent,
  } = slack;
  const {
    send,
    dispatch,
    onRunningChange,
    openSession,
    openAsset,
    navigation,
    composerSettersRef,
  } = runtime;
  const slackSettersRef = useRef({
    setComposer,
    setStatus,
    setReconnect,
    setSent,
  });
  const stableComposerSettersRef = useRef(composerSettersRef);
  const sendComposedSlackMessage = useCallback(
    async (message: string, channel: string, screenshots: string[]) => {
      await sendComposedSlackMessageAction({
        sessionId: session.id,
        composer: slackComposer,
        input: { message, channel, screenshots },
        setters: slackSettersRef.current,
        toast,
      });
    },
    [session.id, slackComposer],
  );
  const undoComposedSlackMessage = useCallback(
    async (sent: SlackSent) => {
      await undoComposedSlackMessageAction({
        sessionId: session.id,
        sent,
        setSent: slackSettersRef.current.setSent,
        toast,
      });
    },
    [session.id],
  );
  const cancelComposedSlackMessage = useCallback(async () => {
    await cancelComposedSlackMessageAction({
      sessionId: session.id,
      composer: slackComposer,
      setComposer: slackSettersRef.current.setComposer,
      toast,
    });
  }, [session.id, slackComposer]);
  async function reconnectComposedSlack() {
    await reconnectShippedSlackAction({
      setReconnectRequired: slackSettersRef.current.setReconnect,
      toast,
    });
  }
  const canForkSession = session.source === "opensession" && !!session.ran;
  const handleFork = useCallback(
    (messageId?: string) => {
      if (!messageId) {
        void navigation.duplicateSession();
        return;
      }
      stableComposerSettersRef.current.current.setForkFrom({
        kind: "message",
        messageId,
      });
    },
    [navigation],
  );
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
    const forkFrom: SessionFork = { sourceId: session.id };
    const createMessage: CreateSessionMessage = {
      type: "create_session",
      branch: "",
      prompt: safetyContinuationPrompt(session.title, queued),
      user: getCurrentUser(),
      forkFrom,
    };
    if (lastMessageId) forkFrom.messageId = lastMessageId;
    if (carriedImages.length) createMessage.images = carriedImages;
    send(createMessage);
  }, [entries, queued, send, session.id, session.title]);
  const repairSafetyPause = useCallback(async () => {
    await repairPausedSession(session.id);
    dispatch({ type: "repair_safety" });
    onRunningChange?.(session.id, false);
    toast("Session repaired");
  }, [dispatch, onRunningChange, session.id]);
  const handleMessagesClick = useCallback(
    (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const assetCandidate = target.closest("[data-asset-path]");
      const assetEl =
        assetCandidate instanceof HTMLElement ? assetCandidate : null;
      const assetPath = assetEl?.dataset.assetPath;
      if (assetPath) {
        if (
          (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) &&
          assetEl?.getAttribute("href")
        )
          return;
        e.preventDefault();
        openAsset(assetPath);
        return;
      }
      const sessionCandidate = target.closest("[data-session-id]");
      const sessionEl =
        sessionCandidate instanceof HTMLElement ? sessionCandidate : null;
      const id = sessionEl?.dataset.sessionId;
      if (!id || !openSession) return;
      if (
        (e.metaKey || e.ctrlKey || e.shiftKey) &&
        sessionEl?.getAttribute("href")
      )
        return;
      e.preventDefault();
      openSession(id);
    },
    [openSession, openAsset],
  );
  return {
    slack: {
      sendComposedSlackMessage,
      undoComposedSlackMessage,
      cancelComposedSlackMessage,
      reconnectComposedSlack,
    },
    session: {
      canForkSession,
      handleFork,
      continueAfterFailure,
      continuePausedSession,
      repairSafetyPause,
      handleMessagesClick,
    },
  };
}

interface DraftContextState {
  draftKey: string;
  images: string[];
  files: FileAttachment[];
  contextSessions: string[];
  setContextSessions: Dispatch<SetStateAction<string[]>>;
  sessionHidden: boolean;
}

export function useSessionDraftContext({
  session,
  workspaceSessions,
  allSessions,
  draft,
}: {
  session: UnifiedSession;
  workspaceSessions?: UnifiedSession[];
  allSessions?: UnifiedSession[];
  draft: DraftContextState;
}) {
  const setContextSessionsRef = useRef(draft.setContextSessions);
  const [quote, setQuote] = useState<Quote | null>(null);
  const clearQuote = useCallback(() => setQuote(null), []);
  const composerDraftRef = useRef({
    draftKey: draft.draftKey,
    images: draft.images,
    files: draft.files,
    quote,
    contextSessions: draft.contextSessions,
  });
  useLayoutEffect(() => {
    composerDraftRef.current = {
      draftKey: draft.draftKey,
      images: draft.images,
      files: draft.files,
      quote,
      contextSessions: draft.contextSessions,
    };
  }, [draft.draftKey, draft.images, draft.files, quote, draft.contextSessions]);
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
  useEffect(() => setQuote(null), [session.id]);
  useEffect(() => {
    if (draft.sessionHidden) setQuote(null);
  }, [draft.sessionHidden]);
  const [showAllContextSessions, setShowAllContextSessions] = useState(false);
  const contextSessionOptions = useMemo(() => {
    const siblings = session.workspaceId
      ? (allSessions || []).filter(
          (candidate) => candidate.workspaceId === session.workspaceId,
        )
      : workspaceSessions || [];
    return siblings
      .filter((candidate) => candidate.id !== session.id && candidate.ran)
      .sort((a, b) =>
        (b.lastActivity || "").localeCompare(a.lastActivity || ""),
      );
  }, [allSessions, workspaceSessions, session.id, session.workspaceId]);
  useEffect(() => {
    setContextSessionsRef.current([]);
    setShowAllContextSessions(false);
  }, [session.id]);
  const deskOwner = session.desk ? session.startedBy || "" : "";
  const effectiveReview = (() => {
    const owner = session.reviewRequest
      ? session
      : (workspaceSessions || []).find((candidate) => candidate.reviewRequest);
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
      prReviewRequested: [
        ...new Set(
          (workspaceSessions?.length ? workspaceSessions : [session]).flatMap(
            (candidate) => candidate.prReviewRequested || [],
          ),
        ),
      ],
    };
  })();
  return {
    quote: { quote, setQuote, clearQuote },
    composerHasDraft,
    context: {
      showAllContextSessions,
      setShowAllContextSessions,
      contextSessionOptions,
    },
    metadata: { deskOwner, effectiveReview },
  };
}

const promptOutboxFileSchema = z.object({
  name: z.string(),
  type: z.string().optional(),
  path: z.string().optional(),
  dataUrl: z.string().optional(),
});

function parsePromptOutboxFiles(
  files: PromptOutboxItem["files"],
): FileAttachment[] | null {
  const result = z.array(promptOutboxFileSchema).safeParse(files ?? []);
  if (!result.success) return null;
  return result.data.map((file) => {
    const attachment: FileAttachment = {
      name: file.name,
      type: file.type ?? "application/octet-stream",
    };
    if (file.path !== undefined) attachment.path = file.path;
    if (file.dataUrl !== undefined) attachment.dataUrl = file.dataUrl;
    return attachment;
  });
}

interface SendComposerOptions {
  setEffort: (effort: string) => void;
  setFastMode: (fast: boolean) => void;
  setPrefill: Dispatch<
    SetStateAction<{ seq: number; text: string; replace?: boolean } | null>
  >;
  hasDraft: () => boolean;
  settersRef: ConversationActionRuntime["composerSettersRef"];
  prefillRef: MutableRefObject<SendComposerOptions["setPrefill"]>;
}
interface SendQueueOptions {
  sessionId: string;
  dispatch: ReturnType<typeof useSessionRuntime>[1];
  send: ReturnType<typeof useSessionSocket>["send"];
  pendingReorderRef: Parameters<typeof reorderSessionQueue>[1];
  draggingQueueRef: Parameters<typeof commitSessionQueueReorder>[1];
}
interface ConversationProjectionOptions {
  projection: Omit<Parameters<typeof deriveSessionQueue>[0], "now">;
  liveTurnStore: LiveTurnStore;
  isBusy: boolean;
  ask: ReturnType<typeof useSessionRuntime>[0]["ask"];
  safety: UnifiedSession["safety"];
  session: UnifiedSession;
  entries: TranscriptEntry[];
}
export function useSessionSendController({
  message,
  composer,
  queue,
  conversation,
}: {
  message: Parameters<typeof sendSessionMessage>[3];
  composer: SendComposerOptions;
  queue: SendQueueOptions;
  conversation: ConversationProjectionOptions;
}) {
  const {
    setEffort,
    setFastMode,
    setPrefill,
    hasDraft,
    settersRef,
    prefillRef,
  } = composer;
  const stableSettersRef = useRef(settersRef);
  const stablePrefillRef = useRef(prefillRef);
  function handleSend(
    raw: string,
    opts?: { steer?: boolean },
    isolatedImages?: string[],
  ): boolean | Promise<boolean> {
    return sendSessionMessage(raw, opts, isolatedImages, message);
  }
  useImageRegionComposer({
    sessionId: message.identity.session.id,
    noEngine: message.identity.noEngine,
    handleSend,
  });
  function discardOutbox(item: PromptOutboxItem) {
    discardSessionOutboxItem(item, message.runtime.setPending);
  }
  function editOutboxInComposer(item: PromptOutboxItem) {
    const files = parsePromptOutboxFiles(item.files);
    if (!files) {
      toast("This queued message has invalid file attachments");
      return;
    }
    message.draft.setImages(item.images ?? []);
    message.draft.setFiles(files);
    message.draft.setContextSessions(item.contextSessions ?? []);
    if (item.effort) setEffort(item.effort);
    if (item.fastMode !== undefined) setFastMode(item.fastMode);
    setPrefill((current) => ({
      seq: (current?.seq ?? 0) + 1,
      text: item.content,
    }));
    discardOutbox(item);
  }
  function editQueuedInComposer(receipt: QueueReceipt, steering = false) {
    takeSessionQueueItem(receipt, steering, {
      sessionId: queue.sessionId,
      composerHasDraft: hasDraft,
      dispatch: queue.dispatch,
      send: queue.send,
    });
  }
  const editSentMessageInComposer = useCallback(
    (entry: TranscriptEntry) => {
      if (hasDraft()) {
        toast("Send or clear your draft before editing a message");
        return;
      }
      stableSettersRef.current.current.setImages(entry.images ?? []);
      stableSettersRef.current.current.setFiles(
        (entry.files ?? []).map((file) => ({
          ...file,
          type: "application/octet-stream",
        })),
      );
      stablePrefillRef.current.current((current) => ({
        seq: (current?.seq ?? 0) + 1,
        text: entry.content,
        replace: true,
      }));
    },
    [hasDraft],
  );
  function handleQueueReorder(next: QueueReceipt[]) {
    reorderSessionQueue(next, queue.pendingReorderRef, queue.dispatch);
  }
  function commitQueueReorder() {
    commitSessionQueueReorder(
      queue.sessionId,
      queue.draggingQueueRef,
      queue.pendingReorderRef,
      queue.send,
    );
  }
  const derived = deriveSessionQueue({
    ...conversation.projection,
    now: Date.now(),
  });
  const hasLiveConversation =
    derived.pendingBubbles.length > 0 ||
    conversation.liveTurnStore.hasText() ||
    conversation.isBusy ||
    !!conversation.ask;
  const inlineRunFailure =
    !conversation.safety &&
    !conversation.isBusy &&
    conversation.session.lastRunError &&
    !conversation.entries.some(
      (entry) =>
        entry.type === "system" &&
        entry.content.includes(conversation.session.lastRunError!.message),
    )
      ? conversation.session.lastRunError
      : null;
  return {
    actions: {
      handleSend,
      discardOutbox,
      editOutboxInComposer,
      editQueuedInComposer,
      editSentMessageInComposer,
      handleQueueReorder,
      commitQueueReorder,
    },
    presentation: { ...derived, hasLiveConversation, inlineRunFailure },
  };
}

interface HeaderActionIdentity {
  session: UnifiedSession;
  workspaceName?: string;
  showReview: boolean;
  showConversation: boolean;
  showVideo: boolean;
  subagentIds: string[];
  latestAssistantMessage: string;
}
interface HeaderActionRuntime {
  send: ReturnType<typeof useSessionSocket>["send"];
  dispatch: ReturnType<typeof useSessionRuntime>[1];
  setStopRequestedAt: Dispatch<SetStateAction<number | null>>;
  shareLink: (url: string) => void;
  closeOverflow: () => void;
  scrollToLatest: () => void;
}
interface HeaderActionModel {
  model: string;
  defaultModel: string;
  accountId: string;
  accounts: ProviderAccountOption[];
  setAccountId: Dispatch<SetStateAction<string>>;
  setFastMode: Dispatch<SetStateAction<boolean>>;
  setGoalOverride: Dispatch<SetStateAction<string | null | undefined>>;
}
interface HeaderActionSetters {
  renameDraft: string | null;
  setRenameDraft: Dispatch<SetStateAction<string | null>>;
  setSlackComposer: SlackComposerState["setComposer"];
  setSlackStatus: SlackComposerState["setStatus"];
  setSlackReconnect: SlackComposerState["setReconnect"];
  setSlackSent: SlackComposerState["setSent"];
}
export function useSessionHeaderActions({
  identity,
  runtime,
  model,
  setters,
  onRenameWorkspace,
  onRename,
}: {
  identity: HeaderActionIdentity;
  runtime: HeaderActionRuntime;
  model: HeaderActionModel;
  setters: HeaderActionSetters;
  onRenameWorkspace?: (name: string) => void;
  onRename?: (id: string, title: string) => void;
}) {
  const setRenameDraftRef = useRef(setters.setRenameDraft);
  function handleCancel() {
    runtime.setStopRequestedAt((previous) => previous ?? Date.now());
    runtime.send({ type: "cancel", sessionId: identity.session.id });
  }
  function share(workspaceScoped: boolean) {
    shareSessionAction({
      context: {
        session: identity.session,
        workspaceName: identity.workspaceName,
        workspaceScoped,
      },
      pane: {
        showReview: identity.showReview,
        showConversation: identity.showConversation,
        showVideo: identity.showVideo,
        subagentIds: workspaceScoped ? [] : identity.subagentIds,
      },
      shareLink: runtime.shareLink,
    });
  }
  const handleShareWorkspace = () =>
    share(Boolean(identity.session.workspaceId));
  const handleShare = () => share(false);
  async function handleOpenSlackComposer() {
    await openSlackComposerAction({
      sessionId: identity.session.id,
      latestAssistantMessage: identity.latestAssistantMessage,
      setters: {
        setComposer: setters.setSlackComposer,
        setStatus: setters.setSlackStatus,
        setReconnect: setters.setSlackReconnect,
        setSent: setters.setSlackSent,
      },
      closeOverflow: runtime.closeOverflow,
      scrollToLatest: runtime.scrollToLatest,
      toast,
    });
  }
  function commitRename() {
    if (setters.renameDraft !== null) {
      if (identity.session.workspaceId && onRenameWorkspace)
        onRenameWorkspace(setters.renameDraft.trim());
      else onRename?.(identity.session.id, setters.renameDraft.trim());
    }
    setters.setRenameDraft(null);
  }
  useEffect(() => setRenameDraftRef.current(null), [identity.session.id]);
  function handleModelChange(next: string) {
    const target = next || model.defaultModel;
    if (!target || target === (model.model || model.defaultModel)) return;
    runtime.dispatch({ type: "select_model", model: next });
    runtime.send({
      type: "prompt",
      sessionId: identity.session.id,
      content: `/model ${target}`,
      user: getCurrentUser(),
    });
  }
  function handleAccountChange(next: string) {
    if (next === (model.accountId || "")) return;
    model.setAccountId(next);
    const target = next
      ? model.accounts.find((account) => account.id === next)
      : null;
    if (target?.kind === "api_key") model.setFastMode(false);
    runtime.send({
      type: "prompt",
      sessionId: identity.session.id,
      content: next ? `/account ${target?.id || next}` : "/account auto",
      user: getCurrentUser(),
    });
  }
  function handleSetGoal(goal: string | null) {
    model.setGoalOverride(goal);
    runtime.send({
      type: "prompt",
      sessionId: identity.session.id,
      content: goal ? `/goal ${goal}` : "/goal clear",
      user: getCurrentUser(),
    });
  }
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const [deleting, setDeleting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleteLabel, setDeleteLabel] = useState("");
  return {
    actions: {
      handleCancel,
      handleShareWorkspace,
      handleShare,
      handleOpenSlackComposer,
      commitRename,
      handleModelChange,
      handleAccountChange,
      handleSetGoal,
    },
    deleteState: {
      showDeleteConfirm,
      setShowDeleteConfirm,
      confirm,
      confirmDialog,
      deleting,
      setDeleting,
      archiving,
      setArchiving,
      deleteLabel,
      setDeleteLabel,
    },
  };
}
