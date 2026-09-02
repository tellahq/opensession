import React, {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import type { ProtocolClientMessage, TranscriptEntry } from "../lib/types";
import { useWebSocket } from "../hooks/useWebSocket";
import { getCurrentUser } from "./UserPicker";
import {
  fetchFileMentions,
  fetchMentionSuggestions,
  fetchModels,
  type ModelOption,
} from "../lib/api";
import { splitAttachments, type FileAttachment } from "../lib/images";
import { Composer } from "./Composer";
import { mergeTranscriptEntries } from "../lib/transcript-state";
import { CONTINUE_AFTER_FAILURE_PROMPT } from "../lib/continue-run";
import { LiveTurnStore } from "../lib/live-turn-store";
import { getLiveTypingPref } from "../lib/live-typing-pref";
import { randomUUID } from "../lib/random-uuid";
import { isTimelineOnlyRunnerNotice } from "../lib/runner-events";
import { otherTypingUsers } from "../lib/typing";
import { cn } from "../ui/cn";
import { msgBubbleUser, msgOwnTurn, msgRow } from "../lib/msg-classes";
import { SessionTranscript } from "./SessionTranscript";
import { TypingIndicator } from "./TypingIndicator";
import { duration, ease } from "../ui/motion";
import { useAttachmentUploads } from "../hooks/useAttachmentUploads";
import { foregroundFileComposerOwns, hasDraggedFiles } from "../lib/file-drag";
import { FullPageFileDropOverlay } from "./FullPageFileDropOverlay";
import { errorMessage } from "../lib/error-message";

interface DeskConversationProps {
  sessionId: string;
  /** The dismissed Desk stays mounted and streaming, but is not presence. */
  presenceActive?: boolean;
  /** Focus the composer when this conversation first mounts. */
  autoFocus?: boolean;
  placeholder?: string;
  /** The Desk session's stored model and reasoning effort (from
   *  /api/desk/ensure). Both are switchable from the composer's model pill. */
  model?: string;
  effort?: string;
  hideBefore?: string;
  /** While a voice call is live, typed messages go into it instead of
   *  starting a text run. Return false to fall through to the normal send. */
  voiceSend?: (text: string) => boolean;
  /** Drill into a session a tool call spawned (the Desk delegates constantly).
   *  The overlay has no side pane, so this opens it in the full viewer. */
  onOpenSubagent?: (sessionId: string) => void;
  /** Starter prompts, shown as a scrolling pill row above the composer while
   *  there's no conversation. Picking one fills the composer rather than
   *  sending: some of them name actions with side effects, and all of them
   *  are openings you'd want to finish in your own words. */
  suggestions?: string[];
}

/**
 * Compact conversation view for the standing Desk session. It owns a separate
 * socket because the app-wide socket may already be watching a regular session.
 */
export function DeskConversation({
  sessionId,
  presenceActive = true,
  autoFocus = false,
  placeholder,
  model: sessionModel,
  effort: sessionEffort,
  hideBefore,
  voiceSend,
  onOpenSubagent,
  suggestions,
}: DeskConversationProps) {
  const { connected, send, setTyping, addHandler } =
    useWebSocket(presenceActive);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [hasLiveText, setHasLiveText] = useState(false);
  const [dictationHidesSuggestions, setDictationHidesSuggestions] =
    useState(false);
  // Attachments staged for the next send. The Composer stages files to disk
  // itself (no `onAddAttachments`), the same way the catch-up deck's reply box
  // does; both ride along on the prompt.
  const [images, setImages] = useState<string[]>([]);
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const uploads = useAttachmentUploads();
  const dropStaging = uploads.staging;
  const [fileDragActive, setFileDragActive] = useState(false);
  const fileDragWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // The model pill's catalog. Empty until it loads — the pill falls back to
  // naming the id it was given, so nothing waits on this.
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [model, setModel] = useState(sessionModel || "");
  // The Desk is pinned to a fast model on low effort server-side (desk.ts);
  // both are the session's own settings from here on.
  const [effort, setEffort] = useState(sessionEffort || "low");
  // Picking a starter pill fills the composer rather than sending, so it goes
  // in as a one-shot prefill (the draft lives inside the Composer).
  const [prefill, setPrefill] = useState<{
    seq: number;
    text: string;
    replace: boolean;
  } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const globalFileComposerRef = useRef<HTMLDivElement | null>(null);
  // Stick to the live edge only while the reader is already there, so a
  // streaming reply doesn't yank them up from scrollback.
  const followRef = useRef(true);
  // One store per session, stable across renders: it sits in effect deps
  // below, and a fresh instance every render would loop those effects forever
  // (the compiler bails on this component, so it gets no automatic help).
  const liveTurnStore = useMemo(() => {
    // Read (and discard) the session id so the linter sees the reset key:
    // a new session must get a fresh store, nothing else may re-create it.
    void sessionId;
    return new LiveTurnStore();
  }, [sessionId]);

  useEffect(() => {
    if (!autoFocus) return;
    const timer = window.setTimeout(
      () => textareaRef.current?.focus({ preventScroll: true }),
      160,
    );
    return () => window.clearTimeout(timer);
  }, [autoFocus]);

  function handleDictationActive(active: boolean) {
    // The row exits during the Composer morph, not after it. Sharing the same
    // start makes the two pieces read as one compacting surface.
    setDictationHidesSuggestions(active);
  }

  async function addDeskAttachments(picked: FileList | File[]) {
    const results = await uploads.upload(picked, (file, signal) =>
      splitAttachments([file], signal),
    );
    const addedImages = results.flatMap((result) => result.images);
    const addedFiles = results.flatMap((result) => result.files);
    if (addedImages.length)
      setImages((current) => [...current, ...addedImages]);
    if (addedFiles.length) setFiles((current) => [...current, ...addedFiles]);
    const rejected = results.flatMap((result) => result.rejected);
    if (rejected.length) alert(`Couldn't attach:\n${rejected.join("\n")}`);
  }
  const addDroppedAttachments = useEffectEvent((picked: FileList | File[]) => {
    void addDeskAttachments(picked);
  });

  function resetFileDrag() {
    if (fileDragWatchdogRef.current) clearTimeout(fileDragWatchdogRef.current);
    fileDragWatchdogRef.current = null;
    setFileDragActive(false);
  }

  function armFileDragWatchdog() {
    if (fileDragWatchdogRef.current) clearTimeout(fileDragWatchdogRef.current);
    fileDragWatchdogRef.current = setTimeout(resetFileDrag, 500);
  }

  useEffect(() => {
    if (!presenceActive || !connected) return;
    function ownsFileDrag() {
      return foregroundFileComposerOwns(globalFileComposerRef.current);
    }
    function handleDragEnter(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      if (!ownsFileDrag()) {
        resetFileDrag();
        return;
      }
      event.preventDefault();
      armFileDragWatchdog();
      setFileDragActive(true);
    }
    function handleDragLeave(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      if (!ownsFileDrag()) {
        resetFileDrag();
        return;
      }
      const next = event.relatedTarget;
      if (next instanceof Node && document.documentElement.contains(next))
        return;
      resetFileDrag();
    }
    function handleDragOver(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      if (!ownsFileDrag()) {
        resetFileDrag();
        return;
      }
      event.preventDefault();
      armFileDragWatchdog();
      setFileDragActive(true);
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
    function handleDrop(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      if (!ownsFileDrag()) {
        resetFileDrag();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const dropped = event.dataTransfer?.files;
      resetFileDrag();
      if (dropped?.length) addDroppedAttachments(dropped);
    }
    window.addEventListener("dragenter", handleDragEnter, true);
    window.addEventListener("dragleave", handleDragLeave, true);
    window.addEventListener("dragover", handleDragOver, true);
    window.addEventListener("drop", handleDrop, true);
    return () => {
      window.removeEventListener("dragenter", handleDragEnter, true);
      window.removeEventListener("dragleave", handleDragLeave, true);
      window.removeEventListener("dragover", handleDragOver, true);
      window.removeEventListener("drop", handleDrop, true);
      resetFileDrag();
    };
  }, [presenceActive, connected, sessionId]);

  // The Desk's "Clear" marker: everything at/before it stays out of this view
  // (locally-minted system lines have fresh timestamps and survive).
  const visibleEntries = hideBefore
    ? entries.filter((e) => !e.timestamp || e.timestamp > hideBefore)
    : entries;
  const hasContent =
    visibleEntries.length > 0 || hasLiveText || isRunning || !!pending;

  useEffect(() => {
    fetchModels()
      .then((m) => {
        setModels(m.models);
        setDefaultModel(m.default);
      })
      .catch((error) => {
        // The catalog only populates the picker. The Desk keeps its stored
        // model id and remains usable when this optional lookup fails.
        console.warn(errorMessage(error, "Could not load models"));
      });
  }, []);

  // Watch the Desk only and tear the socket down on unmount / id change.
  useEffect(() => {
    if (!connected) return;
    setEntries([]);
    liveTurnStore.clear();
    setPending(null);
    followRef.current = true;
    // supportsSeq: transcript v2 capability (docs/transcripts.md).
    // This view merges by entry id and never uses offset/rev cursors or
    // history paging, so seq-mode frames need no extra state here; old
    // servers ignore the field entirely.
    send({
      type: "watch",
      sessionId,
      user: getCurrentUser(),
      supportsSeq: true,
      supportsChangeSeq: true,
    });

    const unsubscribe = addHandler((msg) => {
      if ("sessionId" in msg && msg.sessionId && msg.sessionId !== sessionId)
        return;
      switch (msg.type) {
        case "transcript_init":
          setEntries(msg.entries);
          break;
        case "transcript_history":
          setEntries((prev) =>
            mergeTranscriptEntries(prev, msg.entries, msg.v2 === true),
          );
          break;
        case "transcript_append": {
          setEntries((prev) =>
            mergeTranscriptEntries(prev, msg.entries, msg.v2 === true),
          );
          if (msg.entries.some((e) => e.type === "user")) setPending(null);
          const landed = msg.entries.filter(
            (e) => e.type === "assistant" && e.content,
          );
          if (landed.length)
            liveTurnStore.land(
              landed.map((entry) => ({
                id: entry.id,
                content: entry.content,
              })),
            );
          break;
        }
        case "session_status":
          setIsRunning(msg.isRunning);
          break;
        case "typing":
          setTypingUsers(otherTypingUsers(msg.users, getCurrentUser()));
          break;
        case "stream_start":
          setIsRunning(true);
          liveTurnStore.start(msg.by);
          setPending(null);
          break;
        case "stream_text":
          // Live typing is per viewer (Settings > Preferences), default off;
          // with it off the reply appears as each block's durable entry lands.
          if (!isTimelineOnlyRunnerNotice(msg.text) && getLiveTypingPref())
            liveTurnStore.append(msg.text, msg.blockId);
          break;
        case "stream_tool_use":
        case "stream_tool_result":
          setEntries((prev) => mergeTranscriptEntries(prev, [msg.entry]));
          break;
        case "stream_done":
          setIsRunning(false);
          liveTurnStore.finish();
          break;
        // A slash-command reply / server heads-up. Weave it in as a system
        // line so it reads inline with the conversation (mirrors SessionViewer).
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
        // A failed/aborted run. Without this the panel just stops silently —
        // surface the error where the reply would have been and clear any
        // streaming/sending state so nothing sticks (mirrors SessionViewer).
        case "error":
          setIsRunning(false);
          liveTurnStore.clear();
          setPending(null);
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

    return () => {
      unsubscribe();
      send({ type: "unwatch", sessionId });
      liveTurnStore.clear();
    };
  }, [connected, sessionId, send, addHandler, liveTurnStore]);

  // The live tail updates through an external store so the whole Desk does not
  // re-render for every frame. Only mirror its empty boundary for the board and
  // keep a following reader pinned after React paints each new frame.
  useEffect(() => {
    const unsubscribe = liveTurnStore.subscribe(() => {
      setHasLiveText(liveTurnStore.hasText());
    });
    return unsubscribe;
  }, [liveTurnStore]);
  const shouldMaintainEnd = () => followRef.current;
  const relayoutLive = () => {
    const el = bodyRef.current;
    if (el && shouldMaintainEnd()) el.scrollTop = el.scrollHeight;
  };

  // Keep a following reader pinned to the live edge as content lands. With no
  // conversation the pane holds the board instead, which is read top-down —
  // pinning it to the bottom would open the Desk halfway down your own work.
  useEffect(() => {
    if (!hasContent) return;
    const el = bodyRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [entries, pending, hasContent]);

  function onScroll() {
    const el = bodyRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  // Returns true when the message was consumed, so the (uncontrolled) Composer
  // clears its draft; false keeps it for a retry — same contract as the
  // session view.
  function handleSend(raw: string, opts?: { steer?: boolean }): boolean {
    const content = raw.trim();
    if (!connected) return false;
    if (!content && images.length === 0 && files.length === 0) return false;
    // Slash commands (/model, /loop, /goal, …) are handled by the main
    // session's command system, which this compact surface deliberately
    // doesn't wire up. Sent as a plain prompt they produce no turn, so the
    // optimistic "sending…" bubble below would never reconcile and stick
    // forever. Surface an inline hint instead — the input isn't silently
    // eaten, and no bubble is left dangling.
    if (content.startsWith("/")) {
      setEntries((prev) => [
        ...prev,
        {
          id: randomUUID(),
          type: "system",
          content:
            "Slash commands aren't supported in the Desk. Run them from a session.",
          timestamp: new Date().toISOString(),
        },
      ]);
      return true;
    }
    // Live voice call: inject the typed message into it (the call mirrors its
    // transcript back, so no optimistic bubble — the entry lands via append).
    if (content && voiceSend?.(content)) {
      followRef.current = true;
      return true;
    }
    // Prefer the staged disk path (HTTP upload); fall back to inline dataUrl.
    const filePayload = files.map((f) =>
      f.path
        ? { name: f.name, path: f.path }
        : { name: f.name, dataUrl: f.dataUrl },
    );
    const message: Extract<ProtocolClientMessage, { type: "prompt" }> = {
      type: "prompt",
      sessionId,
      content,
      user: getCurrentUser(),
      effort: effort || "low",
    };
    // Busy sends follow the same two behaviours as a session: plain send
    // queues until the run finishes, ⌘/Ctrl+Enter steers into it.
    if (isRunning) message.busyMode = opts?.steer ? "steer" : "queue";
    if (images.length) message.images = images;
    if (files.length) message.files = filePayload;
    send(message);
    setPending(content);
    setImages([]);
    setFiles([]);
    followRef.current = true;
    return true;
  }

  // Model and effort are settings of the Desk session, so the switch routes
  // through the /model command (persisted + broadcast server-side), exactly
  // as SessionViewer and the catch-up deck do.
  function handleModelChange(next: string) {
    const target = next || defaultModel;
    if (!target || target === (model || defaultModel)) return;
    setModel(next);
    send({
      type: "prompt",
      sessionId,
      content: `/model ${target}`,
      user: getCurrentUser(),
    });
  }

  // "Continue" under a failed run's notice. An ordinary prompt, like anything
  // else typed here — no optimistic bubble, because the press is the button's
  // own feedback and the turn lands as a normal entry.
  function continueAfterFailure() {
    send({
      type: "prompt",
      sessionId,
      content: CONTINUE_AFTER_FAILURE_PROMPT,
      user: getCurrentUser(),
      effort: effort || "low",
    });
    followRef.current = true;
  }
  return (
    // `--desk-under` is what the composer takes back off the conversation: the
    // input box rides up over the last rows in normal flow, so they scroll
    // under it instead of stopping above it. The session view does the same
    // (VIEWER_INPUT), fading the overlap into its own opaque fill — the Desk
    // sits on the palette's glass, so the rows dissolve into a mask instead.
    <div className="relative flex h-full min-h-0 flex-col [--desk-under:18px]">
      {/* The shared transcript virtualizer and lazy markdown/code renderers
			    resolve their scroll root through this marker, as in SessionViewer. */}
      <div
        className={cn(
          "viewer-messages min-h-0 flex-1 overflow-y-auto px-3 pt-2",
          "pb-[calc(var(--desk-under)_+_12px)]",
          "[-webkit-mask-image:linear-gradient(to_bottom,#000_calc(100%_-_var(--desk-under)),transparent_100%)]",
          "[mask-image:linear-gradient(to_bottom,#000_calc(100%_-_var(--desk-under)),transparent_100%)]",
        )}
        ref={bodyRef}
        onScroll={onScroll}
      >
        {!hasContent ? (
          <>
            {/* Nothing else. A Desk with no conversation is its composer
						    and the starter pills above it. A list of your open work
						    here was a second inbox to read past on the way to typing,
						    and the sessions list already owns that job. */}
          </>
        ) : (
          <>
            {/* sessionId is load-bearing, not decoration: the server
						    wire-clamps big entries and replaces inline images with
						    os-blob: markers, and both are resolved through routes
						    keyed on the session. Without it a Desk tool call with a
						    large result is truncated with a "Show full message"
						    button that can't fetch, and any screenshot a tool
						    returned renders as a broken image. */}
            <SessionTranscript
              entries={visibleEntries}
              live={isRunning}
              sessionId={sessionId}
              liveTurnStore={liveTurnStore}
              shouldMaintainEnd={shouldMaintainEnd}
              onLayout={relayoutLive}
              onOpenSubagent={onOpenSubagent}
              // The Desk shows the same failure pill as a session, so it
              // offers the same one press out of it. Gated like handleSend.
              onContinue={
                connected && !isRunning ? continueAfterFailure : undefined
              }
            />
            {/* Optimistic echo of the just-sent message — rendered as a normal
						    sent bubble (not the dimmed "sending" look) so it reads as
						    delivered the instant Enter lands; reconciles away when the
						    real user entry arrives. */}
            {pending && (
              <div className={cn(msgRow, msgOwnTurn, "msg-user")}>
                <div className={msgBubbleUser}>{pending}</div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="relative z-[1] mt-[calc(-1*var(--desk-under))] shrink-0 px-2 pb-2">
        {/* Starter pills stay attached to the composer and disappear once the
				    conversation starts. Picking one fills the draft rather than
				    sending: some name actions with side effects, and all of them are
				    openings you'd want to finish in your own words. */}
        <div className="overflow-hidden">
          <AnimatePresence initial={false}>
            {!hasContent &&
              !!suggestions?.length &&
              !dictationHidesSuggestions && (
                <motion.div
                  key="desk-suggestions"
                  initial={{ y: 40 }}
                  animate={{ y: 0 }}
                  exit={{ y: 40 }}
                  transition={{ type: "tween", duration: duration.base, ease }}
                  className="flex gap-1.5 overflow-x-auto px-1 pb-3 pr-8 [-webkit-mask-image:linear-gradient(to_right,#000_0,#000_calc(100%_-_32px),transparent_100%)] [mask-image:linear-gradient(to_right,#000_0,#000_calc(100%_-_32px),transparent_100%)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                >
                  {suggestions.map((s) => (
                    <button
                      type="button"
                      key={s}
                      className="shrink-0 whitespace-nowrap rounded-full bg-hover px-3 py-1.5 text-label font-medium text-dim hover:bg-active hover:text-fg"
                      onClick={() => {
                        setPrefill((current) => ({
                          seq: (current?.seq ?? 0) + 1,
                          text: s,
                          replace: true,
                        }));
                        textareaRef.current?.focus();
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </motion.div>
              )}
          </AnimatePresence>
        </div>

        <TypingIndicator users={typingUsers} className="mb-1 px-5" />
        {/* The open Desk owns the app-wide drop over the session underneath. */}
        <div
          ref={globalFileComposerRef}
          className="relative"
          data-global-file-composer={
            presenceActive && connected ? "" : undefined
          }
        >
          <Composer
            onTyping={(active) => setTyping(sessionId, active)}
            onDictationActive={handleDictationActive}
            config={{
              draftKey: `desk:${sessionId}`,
              attachmentShortcutActive: presenceActive,
              placeholder: connected
                ? placeholder || "Ask your Desk…"
                : "Not connected",
              disabled: !connected,
              sendDisabled: (text) =>
                !text.trim() && images.length === 0 && files.length === 0,
              busy: isRunning,
              images,
              files,
              staging: dropStaging,
              prefill,
              models,
              defaultModel,
              model,
              modelTitle: "Model and reasoning effort for your Desk",
              effort,
              autoFocus,
              textareaRef,
            }}
            actions={{
              onSend: handleSend,
              onImagesChange: setImages,
              onFilesChange: setFiles,
              onAddAttachments: addDeskAttachments,
              onRemovePendingImage: uploads.cancelPendingImage,
              onRemovePendingFile: uploads.cancelPendingFile,
              onModelChange: handleModelChange,
              onEffortChange: setEffort,
              mentionFetch: (query) => fetchFileMentions(query, sessionId),
              paletteFetch: (query) =>
                fetchMentionSuggestions(query, sessionId, getCurrentUser()),
            }}
          />
          <FullPageFileDropOverlay active={fileDragActive} />
        </div>
      </div>
    </div>
  );
}
