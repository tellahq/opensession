import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { useAttachmentUploads } from "./useAttachmentUploads";
import { clearDraft, loadDraft, saveDraft } from "../lib/drafts";
import { dropStagingAttachments } from "../lib/attachments";
import { attachToDraft, sameFiles, sameImages } from "../lib/attachments";
import { foregroundFileComposerOpen, hasDraggedFiles } from "../lib/file-drag";
import { cropImageRegionFile } from "../lib/image-region-comment";
import {
  registerImageRegionCommentHandler,
  type ImageRegionCommentRequest,
} from "../lib/image-region-comment-registry";
import { splitAttachments } from "../lib/images";
import type { FileAttachment } from "../lib/images";
import {
  markPendingBusy,
  markPendingStarted,
  reconcilePending,
  type OptimisticPendingPrompt,
} from "../lib/pending-reconcile";
import type { QueueReceipt } from "../lib/session-queue";
import type { LiveTurnStore } from "../lib/live-turn-store";
import { promptOutbox, type PromptOutboxItem } from "../lib/prompt-outbox";
import type { SessionRuntimeAction } from "../lib/session-runtime";
import type { TranscriptEntry } from "../lib/types";
import { getCurrentUser } from "../components/UserPicker";
import { takePendingSessionFork } from "../lib/pending-session-fork";

export type SessionForkTarget =
  | { kind: "tip" }
  | { kind: "message"; messageId: string }
  | null;

interface ComposerDraftIdentity {
  sessionId: string;
}

interface SessionComposerDraftOptions {
  identity: ComposerDraftIdentity;
}

export function useSessionComposerDraft({
  identity: { sessionId },
}: SessionComposerDraftOptions) {
  // The composer draft lives INSIDE Composer (uncontrolled mode) so keystrokes
  // don't re-render this whole component; the text arrives via handleSend.
  // Same fix as the CommentableDiff draft-text gotcha.
  // Text + attachments persist in the draft store (keyed per session) so
  // switching to another session/workspace — which remounts this component —
  // doesn't lose typed work. Text rides Composer's `draftKey`; the staged
  // images/files live here, seeded from and mirrored into the same draft.
  const draftKey = `session:${sessionId}`;
  const [images, setImages] = useState<string[]>(
    () => loadDraft(draftKey).images,
  );
  const [files, setFiles] = useState<FileAttachment[]>(
    () => loadDraft(draftKey).files,
  );
  const uploads = useAttachmentUploads();
  useEffect(() => {
    saveDraft(draftKey, { images, files });
  }, [draftKey, images, files]);
  const [forkFrom, setForkFrom] = useState<SessionForkTarget>(null);
  useEffect(() => {
    const messageId = takePendingSessionFork(sessionId);
    if (messageId) setForkFrom({ kind: "message", messageId });
  }, [sessionId]);

  return {
    attachments: {
      draftKey,
      images,
      setImages,
      files,
      setFiles,
      uploads,
      uploadStaging: uploads.staging,
    },
    fork: { forkFrom, setForkFrom },
  };
}

export function useComposerReset({
  newSessionSeq,
  draftKey,
  setImages,
  setFiles,
  setForkFrom,
  scrollToLatest,
  composerRef,
}: {
  newSessionSeq: number | undefined;
  draftKey: string;
  setImages: Dispatch<SetStateAction<string[]>>;
  setFiles: Dispatch<SetStateAction<FileAttachment[]>>;
  setForkFrom: Dispatch<SetStateAction<SessionForkTarget>>;
  scrollToLatest: (behavior?: ScrollBehavior) => void;
  composerRef: MutableRefObject<{ focus: () => void } | null>;
}) {
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
  }, [
    newSessionSeq,
    composerResetSeq,
    draftKey,
    scrollToLatest,
    setImages,
    setFiles,
    setForkFrom,
    composerRef,
  ]);
  return composerResetSeq;
}

export function useComposerQueueState() {
  // Drag-to-reorder bookkeeping. onReorder fires continuously during a drag, so
  // we only reorder locally then flush the final order to the server on drop —
  // broadcasting mid-drag would swap the item references out from under Motion
  // and drop the gesture. draggingQueueRef gates the incoming queue_update the
  // same way, so an unrelated broadcast can't yank the list while dragging.
  const draggingQueueRef = useRef(false);
  const pendingReorderRef = useRef<
    import("../lib/session-queue").QueueReceipt[] | null
  >(null);
  const [composerPrefill, setComposerPrefill] = useState<{
    seq: number;
    text: string;
    replace?: boolean;
  } | null>(null);
  return {
    draggingQueueRef,
    pendingReorderRef,
    composerPrefill,
    setComposerPrefill,
  };
}

interface OutboxIdentity {
  sessionId: string;
  connected: boolean;
}

interface OutboxRuntime {
  dispatch: Dispatch<SessionRuntimeAction>;
  initialPending?: Omit<
    OptimisticPendingPrompt,
    "id" | "transcriptAfterEntryId"
  >;
}

interface OutboxTranscript {
  entries: TranscriptEntry[];
  setEntries: (
    update:
      | TranscriptEntry[]
      | ((previous: TranscriptEntry[]) => TranscriptEntry[]),
  ) => void;
}

interface SessionPromptOutboxOptions {
  identity: OutboxIdentity;
  runtime: OutboxRuntime;
  transcript: OutboxTranscript;
}

export function useSessionPromptOutbox({
  identity: { sessionId, connected },
  runtime: { dispatch, initialPending },
  transcript: { entries, setEntries },
}: SessionPromptOutboxOptions) {
  // Optimistic just-sent messages, shown instantly and reconciled once the real
  // turn lands (transcript) or the server confirms it as queued (busy path).
  // `busyMode` marks a send made while the run was busy: it renders inside the
  // queue flap (as "Queueing…") instead of as a transcript bubble.
  const [pending, setPending] = useState<OptimisticPendingPrompt[]>(() =>
    initialPending
      ? [
          {
            id: `pending-initial-${sessionId}`,
            transcriptAfterEntryId: null,
            ...initialPending,
          },
        ]
      : [],
  );
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
    promptOutbox.list(sessionId),
  );
  useEffect(() => {
    const stopObserving = promptOutbox.observeDelivery((item, result) => {
      if (item.sessionId !== sessionId) return;
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
        dispatch({ type: "mark_running" });
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
        dispatch({ type: "mark_running" });
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
      const items = promptOutbox.list(sessionId);
      setOutboxItems(items);
      // Forget claims the outbox no longer holds (delivered, discarded, or
      // another session's), so the set can't grow for the life of the tab.
      setLandedOutboxIds((previous) => {
        if (previous.size === 0) return previous;
        const live = new Set(items.map((item) => `outbox-${item.clientId}`));
        const next = new Set([...previous].filter((id) => live.has(id)));
        return next.size === previous.size ? previous : next;
      });
    };
    sync();
    const unsubscribe = promptOutbox.subscribe(sync);
    void promptOutbox.flush();
    return () => {
      unsubscribe();
      stopObserving();
    };
  }, [dispatch, sessionId, setEntries]);
  useEffect(() => {
    if (connected) void promptOutbox.flush();
  }, [connected]);
  useEffect(() => {
    if (!initialPending) return;
    const content = initialPending.content.trim();
    setPending((previous) => {
      if (previous.some((item) => item.id === `pending-initial-${sessionId}`))
        return previous;
      if (
        entries.some(
          (entry) =>
            entry.type === "user" &&
            (!content || entry.content.trim() === content),
        )
      )
        return previous;
      return [
        ...previous,
        {
          id: `pending-initial-${sessionId}`,
          transcriptAfterEntryId: null,
          ...initialPending,
        },
      ];
    });
  }, [entries, initialPending, sessionId, setEntries]);

  return {
    pending: { pending, setPending, pendingRef },
    durable: {
      outboxItems,
      landedOutboxIds,
      setLandedOutboxIds,
    },
  };
}

interface PendingReconciliationOptions {
  identity: {
    sessionId: string;
    sessionIsRunning: boolean;
    initialPending?: Omit<
      OptimisticPendingPrompt,
      "id" | "transcriptAfterEntryId"
    >;
  };
  delivery: {
    entries: TranscriptEntry[];
    queued: QueueReceipt[];
    steered: QueueReceipt[];
    pendingRef: MutableRefObject<OptimisticPendingPrompt[]>;
    setPending: Dispatch<SetStateAction<OptimisticPendingPrompt[]>>;
    setLandedOutboxIds: Dispatch<SetStateAction<Set<string>>>;
  };
  runtime: {
    dispatch: Dispatch<SessionRuntimeAction>;
    liveTurnStore: LiveTurnStore;
  };
}

export function usePendingPromptReconciliation({
  identity: { sessionId, sessionIsRunning, initialPending },
  delivery: {
    entries,
    queued,
    steered,
    pendingRef,
    setPending,
    setLandedOutboxIds,
  },
  runtime: { dispatch, liveTurnStore },
}: PendingReconciliationOptions) {
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
    setPending((previous) =>
      previous.filter((item) => !landed.has(item.id) && !expired.has(item.id)),
    );
    // Only a CONFIRMED claim retires the durable outbox row below. An expired
    // bubble is merely hidden: its prompt may still be in flight, and the
    // outbox is localStorage-backed and shared across tabs, so anything that
    // looks like a discard has to be earned by a real server confirmation.
    if (landed.size > 0)
      setLandedOutboxIds((previous) => {
        const next = new Set(previous);
        for (const id of landed) next.add(id);
        return next;
      });
  }, [entries, queued, steered, setPending, pendingRef, setLandedOutboxIds]);

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
              id: `pending-initial-${sessionId}`,
              transcriptAfterEntryId: null,
              ...initialPending,
            },
          ]
        : [],
    );
    dispatch({ type: "reset_live", isRunning: sessionIsRunning });
    liveTurnStore.clear();
  });
  useLayoutEffect(() => {
    resetOptimisticState();
  }, [sessionId, liveTurnStore]);
}

interface SessionAttachmentDropOptions {
  identity: { focused: boolean; sessionHidden: boolean; noteMode: boolean };
  draft: {
    draftKey: string;
    setImages: Dispatch<SetStateAction<string[]>>;
    setFiles: Dispatch<SetStateAction<FileAttachment[]>>;
    uploads: ReturnType<typeof useAttachmentUploads>;
  };
}

export function useImageRegionComposer({
  sessionId,
  noEngine,
  handleSend,
}: {
  sessionId: string;
  noEngine: boolean;
  handleSend: (
    raw: string,
    options?: { steer?: boolean },
    isolatedImages?: string[],
  ) => boolean | Promise<boolean>;
}) {
  const imageRegionCommentRef = useRef<
    (request: ImageRegionCommentRequest) => Promise<void>
  >(async () => {});
  useLayoutEffect(() => {
    imageRegionCommentRef.current = async (request) => {
      if (request.sessionId !== sessionId)
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
    return registerImageRegionCommentHandler(sessionId, (request) =>
      imageRegionCommentRef.current(request),
    );
  }, [noEngine, sessionId]);
}

export function useSessionAttachmentDrop({
  identity: { focused, sessionHidden, noteMode },
  draft: { draftKey, setImages, setFiles, uploads },
}: SessionAttachmentDropOptions) {
  const dragDepthRef = useRef(0);
  const fileDragPresentRef = useRef(false);
  const cancelledFileDragRef = useRef(false);
  const fileDragWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [fileDragActive, setFileDragActive] = useState(false);

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

  const dropAttachments = useEffectEvent((picked: FileList | File[]) =>
    addSessionAttachments(picked),
  );
  useEffect(() => {
    function resetFileDrag() {
      dragDepthRef.current = 0;
      setFileDragActive(false);
    }
    function finishFileDrag() {
      if (fileDragWatchdogRef.current)
        clearTimeout(fileDragWatchdogRef.current);
      fileDragWatchdogRef.current = null;
      resetFileDrag();
      fileDragPresentRef.current = false;
      cancelledFileDragRef.current = false;
    }
    function armFileDragWatchdog() {
      if (fileDragWatchdogRef.current)
        clearTimeout(fileDragWatchdogRef.current);
      fileDragWatchdogRef.current = setTimeout(finishFileDrag, 500);
    }

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
  return { addSessionAttachments, fileDragActive };
}
