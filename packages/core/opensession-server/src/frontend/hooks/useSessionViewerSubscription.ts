import type { WorkflowRunSnapshot } from "../../server/workflow-types";
import type { ComposerPrefill } from "../lib/composer-types";
import { useEffect, useEffectEvent } from "react";
import { z } from "zod";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { withModelSwitches } from "../components/session-viewer/model-switches";
import { switchDividerText } from "../components/session-viewer/model-labels";
import type { SlackSent } from "../components/ShippedChangeComposer";
import { getCurrentUser } from "../components/UserPicker";
import type { FileAttachment } from "../lib/images";
import { loadDraft } from "../lib/drafts";
import { getLiveTypingPref } from "../lib/live-typing-pref";
import { randomUUID } from "../lib/random-uuid";
import {
  hasRestartQueueNotice,
  restartQueueNoticeEntryId,
  withoutRestartQueueNotice,
} from "../lib/restart-queue-notice";
import { isTimelineOnlyRunnerNotice } from "../lib/runner-events";
import type { SessionRuntimeAction } from "../lib/session-runtime";
import { shouldContinueHistoryReveal } from "../lib/transcript-history";
import type {
  HistoryWalk,
  TranscriptCursor,
  TranscriptSequence,
} from "../lib/transcript-history-controller";
import type { TranscriptViewStore } from "../lib/transcript-view-store";
import type {
  TranscriptEntry,
  UnifiedSession,
  WSServerMessage,
} from "../lib/types";
import { otherTypingUsers } from "../lib/typing";
import type { LiveTurnStore } from "../lib/live-turn-store";
import { toast } from "../ui/toast";
import type { ReplySuggestion } from "../lib/reply-suggestions";
import type {
  SessionSocketAddHandler,
  SessionSocketSend,
} from "./useSessionSocket";
import type { TranscriptController } from "./useTranscript";

type Setter<T> = Dispatch<SetStateAction<T>>;
type SlackComposerRequest = Extract<
  WSServerMessage,
  { type: "slack_composer" }
>["request"];
type SetEntries = (
  update:
    | TranscriptEntry[]
    | ((previous: TranscriptEntry[]) => TranscriptEntry[]),
) => void;

const queuedFileSchema = z.object({
  name: z.string(),
  type: z.string().catch("application/octet-stream"),
  path: z.string().optional().catch(undefined),
  dataUrl: z.string().optional().catch(undefined),
});

interface SubscriptionConnection {
  connected: boolean;
  session: UnifiedSession;
  addHandler: SessionSocketAddHandler;
  send: SessionSocketSend;
  onRunningChange: ((id: string, isRunning: boolean) => void) | undefined;
}

interface SubscriptionTranscript {
  cursorRef: RefObject<TranscriptCursor | null>;
  sequenceRef: RefObject<TranscriptSequence | null>;
  readySessionRef: RefObject<string | null>;
  viewStore: TranscriptViewStore;
  setEntries: SetEntries;
  setLoading: Setter<boolean>;
  setHistoryTruncated: Setter<boolean>;
  liveTurnStore: LiveTurnStore;
}

interface SubscriptionIndex {
  existingForInit: TranscriptController["existingIndexForInit"];
  setMode: TranscriptController["setIndexMode"];
  acceptInitTail: TranscriptController["acceptInitTail"];
  replace: TranscriptController["replaceIndex"];
  messagesRef: RefObject<HTMLDivElement | null>;
  followingLive: RefObject<boolean>;
  acceptRange: TranscriptController["acceptRange"];
  projectAppend: TranscriptController["projectAppend"];
}

interface SubscriptionHistory {
  backgroundRef: RefObject<boolean>;
  revealRef: RefObject<HistoryWalk | null>;
  loadingRef: RefObject<boolean>;
  setLoading: Setter<boolean>;
  walkRef: RefObject<HistoryWalk | null>;
  setLoadingAll: Setter<boolean>;
  finishWalk: () => void;
  shellTiming: { record: () => void };
  startRef: RefObject<number | null>;
  jumpMaxEntries: number;
  requestPage: (whole?: boolean) => void;
  scrollToLatest: (behavior?: ScrollBehavior) => void;
}

interface SubscriptionRuntime {
  setWorkflowRuns: Setter<WorkflowRunSnapshot[]>;
  setViewers: Setter<string[]>;
  setTypingUsers: Setter<string[]>;
  dispatch: Dispatch<SessionRuntimeAction>;
  setGitRefreshTick: Setter<number>;
  prTargetsRef: RefObject<Set<string>>;
  setWorkspacePreparing: Setter<boolean>;
  setStopRequestedAt: Setter<number | null>;
  setAccountId: Setter<string>;
}

interface SubscriptionComposer {
  draggingQueueRef: RefObject<boolean>;
  draftKey: string;
  setImages: Setter<string[]>;
  setFiles: Setter<FileAttachment[]>;
  setContextSessions: Setter<string[]>;
  setPrefill: Setter<ComposerPrefill | null>;
  setReplySuggestions: Setter<ReplySuggestion[]>;
  emptySuggestions: ReplySuggestion[];
}

interface SubscriptionSlack {
  setComposer: Setter<SlackComposerRequest>;
  setStatus: Setter<"idle" | "sharing">;
  setReconnect: Setter<boolean>;
  setSent: Setter<SlackSent | null>;
}

export interface SessionViewerSubscriptionOptions {
  connection: SubscriptionConnection;
  transcript: SubscriptionTranscript;
  index: SubscriptionIndex;
  history: SubscriptionHistory;
  runtime: SubscriptionRuntime;
  composer: SubscriptionComposer;
  slack: SubscriptionSlack;
}

export function useSessionViewerSubscription({
  connection: { connected, session, addHandler, send, onRunningChange },
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
    jumpMaxEntries,
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
    emptySuggestions,
  },
  slack: {
    setComposer: setSlackComposer,
    setStatus: setSlackComposerStatus,
    setReconnect: setSlackComposerReconnect,
    setSent: setSlackComposerSent,
  },
}: SessionViewerSubscriptionOptions) {
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
        case "hello":
          // A restart-queue notice belongs to the old connection. The new
          // server's handshake resolves it even though seq-mode transcript
          // snapshots preserve other optimistic local entries.
          if (hasRestartQueueNotice(transcriptViewStore.getSnapshot()))
            setEntries(withoutRestartQueueNotice);
          break;
        case "transcript_init": {
          // Weave persisted model switches into the conversation as dividers.
          const merged = withModelSwitches(msg.entries, session.modelHistory);
          transcriptReadySessionRef.current = session.id;
          // Mode detection (transcript v2): an init carrying seq fields
          // switches this session into seq mode; one without switches it
          // back to legacy (e.g. the flag was turned off — the resume
          // falls back to a full legacy snapshot). Init frames are
          // authoritative for the mode.
          const lastSeq = msg.lastSeq;
          const v2 = msg.v2 === true && lastSeq !== undefined;
          const existingIndex = existingIndexForInit(v2);
          setIndexMode(v2);
          if (v2) {
            transcriptSeqRef.current = {
              sessionId: session.id,
              lastSeq,
              firstSeq:
                msg.firstSeq !== undefined && msg.firstSeq > 0
                  ? msg.firstSeq
                  : null,
              lastChangeSeq: msg.lastChangeSeq ?? lastSeq,
            };
            // Seq mode ignores offset/rev cursors entirely.
            transcriptCursorRef.current = null;
          } else {
            transcriptSeqRef.current = null;
            if (msg.endOffset !== undefined && msg.rev) {
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
          if (!v2 && msg.startOffset !== undefined) {
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
            msg.firstSeq !== undefined &&
            msg.firstSeq > 0
          ) {
            // Older-page cursor: earliest seq loaded so far (min).
            seqState.firstSeq =
              seqState.firstSeq === null
                ? msg.firstSeq
                : Math.min(seqState.firstSeq, msg.firstSeq);
          } else if (!inSeqMode && msg.startOffset !== undefined) {
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
              jump.loaded < jumpMaxEntries
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
              msg.lastSeq !== undefined &&
              msg.lastSeq > 0
            ) {
              seqState.lastSeq = Math.max(seqState.lastSeq, msg.lastSeq);
            }
            if (msg.lastChangeSeq !== undefined) {
              seqState.lastChangeSeq = Math.max(
                seqState.lastChangeSeq,
                msg.lastChangeSeq,
              );
            }
          } else if (msg.endOffset !== undefined && msg.rev) {
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
          const item = msg.item;
          const existing = loadDraft(draftKey);
          setImages((current) => [...current, ...(item.images ?? [])]);
          const restoredFiles = Array.isArray(item.files)
            ? item.files.flatMap((file) => {
                const parsed = queuedFileSchema.safeParse(file);
                return parsed.success ? [parsed.data] : [];
              })
            : [];
          setFiles((current) => [...current, ...restoredFiles]);
          setContextSessions((current) => [
            ...new Set([...current, ...(item.contextSessions ?? [])]),
          ]);
          setComposerPrefill((current) => {
            const prefill: ComposerPrefill = {
              seq: (current?.seq ?? 0) + 1,
              text: item.content,
              replace: !existing.text.trim(),
            };
            if (item.pastedTexts?.length)
              prefill.pastedTexts = item.pastedTexts;
            return prefill;
          });
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
          setReplySuggestions(emptySuggestions);
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
              id: restartQueueNoticeEntryId(msg.message) ?? randomUUID(),
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
}
