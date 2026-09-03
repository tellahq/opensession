import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { getCurrentUser } from "../components/UserPicker";
import type { SessionSocketSend } from "../hooks/useSessionSocket";
import { postSessionNoteApi } from "./api";
import { MAX_PROMPT_IMAGES } from "@tellahq/opensession-protocol/session";
import { dropStagingAttachments } from "./attachments";
import type { ComposerSendOptions } from "./composer-types";
import { unhideForSession } from "./hides";
import { composePastedText } from "./pasted-text";
import type { FileAttachment } from "./images";
import type { OptimisticPendingPrompt } from "./pending-reconcile";
import {
  promptOutbox,
  type PromptOutboxInput,
  type PromptOutboxItem,
} from "./prompt-outbox";
import { withQuotes, type Quote } from "./quotes";
import type { SessionRuntimeAction } from "./session-runtime";
import type { QueueReceipt } from "./session-queue";
import { measureSessionPerf } from "./session-performance";
import type { TranscriptViewStore } from "./transcript-view-store";
import type { UnifiedSession, WSClientMessage } from "./types";
import { toast } from "../ui/toast";
import type { SessionForkTarget } from "../hooks/useSessionComposerController";

interface SendIdentity {
  session: UnifiedSession;
  noEngine: boolean;
  noteMode: boolean;
}

interface SendDraft {
  draftKey: string;
  images: string[];
  setImages: Dispatch<SetStateAction<string[]>>;
  files: FileAttachment[];
  setFiles: Dispatch<SetStateAction<FileAttachment[]>>;
  quote: Quote | null;
  setQuote: Dispatch<SetStateAction<Quote | null>>;
  contextSessions: string[];
  setContextSessions: Dispatch<SetStateAction<string[]>>;
  forkFrom: SessionForkTarget;
  setForkFrom: Dispatch<SetStateAction<SessionForkTarget>>;
}

interface SendRuntime {
  isBusy: boolean;
  effort: string;
  fastMode: boolean;
  pendingRef: MutableRefObject<OptimisticPendingPrompt[]>;
  setPending: Dispatch<SetStateAction<OptimisticPendingPrompt[]>>;
  dispatch: Dispatch<SessionRuntimeAction>;
  onRunningChange?: (sessionId: string, running: boolean) => void;
}

interface SendTranscript {
  viewStore: TranscriptViewStore;
  sequenceRef: MutableRefObject<{
    sessionId: string;
    lastSeq: number;
  } | null>;
  tailActionNeedsLayoutScrollRef: MutableRefObject<boolean>;
  cancelIndexAnchorHold: () => void;
  scrollToLatest: (behavior?: ScrollBehavior) => void;
}

interface SendSessionMessageOptions {
  identity: SendIdentity;
  draft: SendDraft;
  runtime: SendRuntime;
  transcript: SendTranscript;
  send: SessionSocketSend;
}

/**
 * Plain send body. SessionViewer keeps the same function declaration and all
 * memoized callers; this module only owns the delivery branches.
 */
export function sendSessionMessage(
  raw: string,
  options: ComposerSendOptions | undefined,
  isolatedImages: string[] | undefined,
  controller: SendSessionMessageOptions,
): boolean | Promise<boolean> {
  const { identity, draft, runtime, transcript, send } = controller;
  const sendStartedAt = performance.now();
  const typed = raw.trim();
  const isolated = isolatedImages !== undefined;
  // Quoted transcript selections lead a normal composer message. A region
  // comment carries its own visual context and leaves the draft untouched.
  const text = isolated
    ? typed
    : withQuotes(draft.quote ? [draft.quote] : [], typed);
  const images = isolatedImages ?? draft.images;
  const files = isolated ? [] : draft.files;
  // Large pastes ride beside the text; the server places them after the
  // message in the prompt and lifts them back onto the entry as cards.
  const pastedTexts = isolated ? [] : (options?.pastedTexts ?? []);
  if (
    !typed &&
    images.length === 0 &&
    files.length === 0 &&
    pastedTexts.length === 0
  )
    return false;
  // Attaching already stops at the cap; this catches a message brought back
  // for editing with more. The server would refuse it, and a refused message
  // used to sit in the outbox retrying with nothing to press.
  if (images.length > MAX_PROMPT_IMAGES) {
    toast(`Attach up to ${MAX_PROMPT_IMAGES} images per message`);
    return false;
  }

  // Note mode: post a team note on this session — never a prompt. The
  // server broadcast echoes it back into `notes` for every viewer, so
  // nothing is rendered optimistically here. Notes carry the quoted
  // selection too (as "> " lines, the same shape a prompt sends), and a
  // paste folded in behind a divider: a note has no attachment slot.
  if (!isolated && identity.noteMode) {
    if (!typed && images.length === 0 && pastedTexts.length === 0) return false;
    return postSessionNoteApi(
      identity.session.id,
      composePastedText(text, pastedTexts),
      getCurrentUser(),
      images,
    ).then(
      () => {
        dropStagingAttachments(draft.draftKey);
        draft.setImages([]);
        draft.setQuote(null);
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
  const filePayload = files.map((file) =>
    file.path
      ? { name: file.name, path: file.path }
      : { name: file.name, dataUrl: file.dataUrl },
  );

  // Fork mode: branch a brand-new session from the current tip or selected
  // message, keeping the real conversation history. App navigates into it on
  // session_created.
  if (!isolated && draft.forkFrom) {
    type CreateSessionMessage = Extract<
      WSClientMessage,
      { type: "create_session" }
    >;
    const forkFrom: NonNullable<CreateSessionMessage["forkFrom"]> = {
      sourceId: identity.session.id,
    };
    if (draft.forkFrom.kind === "message")
      forkFrom.messageId = draft.forkFrom.messageId;
    const message: CreateSessionMessage = {
      type: "create_session",
      branch: "",
      prompt: text || "Continue from here.",
      user,
      forkFrom,
    };
    if (images.length) message.images = images;
    if (files.length) message.files = filePayload;
    if (pastedTexts.length) message.pastedTexts = pastedTexts;
    send(message);
    draft.setForkFrom(null);
    dropStagingAttachments(draft.draftKey);
    draft.setImages([]);
    draft.setFiles([]);
    draft.setQuote(null);
    return true;
  }

  if (identity.noEngine) return false;
  // Two follow-up behaviors while busy: plain send QUEUES (parked until
  // the run FULLY finishes — including any auto-continue turns the server
  // holds the queue behind), and the steer button / ⌘Ctrl+Enter STEERS
  // (folds into the LIVE run at its next step boundary — busyMode:"steer",
  // real in-band steering since 2026-07-12; the server falls back to the
  // queue when nothing is steerable or files are attached). The turn keeps
  // running on both paths: no abort, no lost work. Idle: just run it.
  // Attachments ride along on every path — images fold into the run as
  // content blocks; files route to the queue server-side.
  const steerNow = runtime.isBusy && !!options?.steer;
  const optimisticTail = [...runtime.pendingRef.current]
    .reverse()
    .find((item) => item.busyMode !== "queue");
  const transcriptTail = transcript.viewStore.getSnapshot().at(-1);
  const transcriptAfterEntryId = optimisticTail
    ? optimisticTail.id.startsWith("outbox-")
      ? optimisticTail.id.slice("outbox-".length)
      : optimisticTail.id
    : (transcriptTail?.id ?? null);
  const transcriptAfterSeq =
    transcript.sequenceRef.current?.sessionId === identity.session.id
      ? transcript.sequenceRef.current.lastSeq
      : undefined;
  let outboxItem: PromptOutboxItem;
  try {
    const input: PromptOutboxInput = {
      sessionId: identity.session.id,
      content: text,
      user,
      effort: runtime.effort,
      fastMode: runtime.fastMode,
      busyMode: runtime.isBusy ? (steerNow ? "steer" : "queue") : undefined,
      transcriptAfterEntryId,
      transcriptAfterSeq,
    };
    if (images.length) input.images = images;
    if (files.length) input.files = filePayload;
    if (pastedTexts.length) input.pastedTexts = pastedTexts;
    if (!isolated && draft.contextSessions.length)
      input.contextSessions = draft.contextSessions;
    outboxItem = promptOutbox.enqueue(input);
  } catch (error) {
    toast(
      error instanceof Error
        ? error.message
        : "Couldn't save this message for delivery.",
    );
    return false;
  }
  unhideForSession(identity.session);
  if (!runtime.isBusy) {
    runtime.dispatch({ type: "mark_running" });
    runtime.onRunningChange?.(identity.session.id, true);
  }
  const pending: OptimisticPendingPrompt = {
    id: `outbox-${outboxItem.clientId}`,
    content: text,
    user,
    sentAt: outboxItem.createdAt,
    transcriptAfterEntryId,
    transcriptAfterSeq,
    images: images.length ? images : undefined,
    pastedTexts: pastedTexts.length ? pastedTexts : undefined,
    ...(steerNow
      ? { busyMode: "steer" }
      : runtime.isBusy
        ? { busyMode: "queue" }
        : {}),
  };
  if (!runtime.isBusy || steerNow) {
    // Sent messages always enter the conversation immediately. A busy steer
    // keeps its delivery mode only so the bubble can remain slightly muted
    // until the engine reads it.
    transcript.tailActionNeedsLayoutScrollRef.current = true;
    runtime.setPending((current) => [...current, pending]);
    requestAnimationFrame(() =>
      measureSessionPerf("send_to_optimistic_paint_ms", sendStartedAt),
    );
  } else {
    // Only deliberately queued messages live above the composer.
    runtime.setPending((current) => [...current, pending]);
  }
  // Your own send always lands in view. relayout's glue only runs while
  // `following`, so once the reader has scrolled up into history the
  // optimistic bubble arrives below the fold with nothing moving — and a
  // send is unambiguous intent to watch this turn. Instant, not smooth: the
  // glue that follows sets scrollTop directly and would fight an animation.
  transcript.cancelIndexAnchorHold();
  transcript.scrollToLatest("auto");
  if (!isolated) {
    dropStagingAttachments(draft.draftKey);
    draft.setImages([]);
    draft.setFiles([]);
    draft.setQuote(null);
    draft.setContextSessions([]);
  }
  measureSessionPerf("send_handler_ms", sendStartedAt);
  return true;
}

export function discardSessionOutboxItem(
  item: PromptOutboxItem,
  setPending: Dispatch<SetStateAction<OptimisticPendingPrompt[]>>,
) {
  setPending((current) =>
    current.filter((entry) => entry.id !== `outbox-${item.clientId}`),
  );
  promptOutbox.discard(item.clientId);
}

export function reorderSessionQueue(
  next: QueueReceipt[],
  pendingReorderRef: MutableRefObject<QueueReceipt[] | null>,
  dispatch: Dispatch<SessionRuntimeAction>,
) {
  pendingReorderRef.current = next;
  dispatch({ type: "reorder_queue", queued: next });
}

export function takeSessionQueueItem(
  item: QueueReceipt,
  steering: boolean,
  options: {
    sessionId: string;
    composerHasDraft: () => boolean;
    dispatch: Dispatch<SessionRuntimeAction>;
    send: SessionSocketSend;
  },
) {
  if (options.composerHasDraft()) {
    toast("Send or clear your draft before editing a message");
    return;
  }
  if (!item.id) return;
  if (steering)
    options.dispatch({
      type: "set_steered_editing",
      queueId: item.id,
      editing: true,
    });
  options.send({
    type: steering ? "take_steered_prompt" : "take_queued_prompt",
    sessionId: options.sessionId,
    queueId: item.id,
  });
}

export function commitSessionQueueReorder(
  sessionId: string,
  draggingQueueRef: MutableRefObject<boolean>,
  pendingReorderRef: MutableRefObject<QueueReceipt[] | null>,
  send: SessionSocketSend,
) {
  draggingQueueRef.current = false;
  const next = pendingReorderRef.current;
  pendingReorderRef.current = null;
  if (!next) return;
  const order = next.flatMap((item) =>
    item.id === undefined ? [] : [item.id],
  );
  if (order.length > 1)
    send({ type: "reorder_queued_prompt", sessionId, order });
}
