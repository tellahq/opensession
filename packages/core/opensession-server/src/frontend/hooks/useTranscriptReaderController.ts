import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";
import type { UnifiedSession, TranscriptEntry } from "../lib/types";
import type { LiveTurnStore } from "../lib/live-turn-store";
import type { TranscriptViewStore } from "../lib/transcript-view-store";
import { withModelSwitches } from "../components/session-viewer/model-switches";
import {
  cacheTranscriptView,
  cachedTranscriptView,
  peekCachedTranscriptView,
} from "../components/session-viewer/transcript-cache";
import {
  pickScrollAnchor,
  readFollowingLive,
} from "../components/session-viewer/transcript-anchor";
import { onTranscriptDisclosure } from "../lib/transcript-disclosures";
import { historyPageRequest } from "../lib/transcript-history-controller";
import { HISTORY_PAGE_ENTRIES } from "../lib/transcript-history";
import {
  HIDDEN_REOPEN_MS,
  INDEXED_OPEN_SETTLE_MAX_MS,
  JUMP_PAGE_ENTRIES,
  LEGACY_OPEN_SETTLE_MAX_MS,
  RESUME_GROWTH_WINDOW_MS,
} from "../lib/session-viewer-constants";
import { matchesShortcut } from "../lib/shortcuts";
import { useSessionScroll } from "./useSessionScroll";
import { useTranscriptIndexAnchor } from "./useTranscript";
import type { useTranscript } from "./useTranscript";
import type { SessionSocketSend } from "./useSessionSocket";
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
  type useTranscriptHistoryController,
} from "./useTranscriptHistoryController";

interface ReaderTranscriptState {
  entries: TranscriptEntry[];
  setEntries: (
    update:
      | TranscriptEntry[]
      | ((previous: TranscriptEntry[]) => TranscriptEntry[]),
  ) => void;
  loading: boolean;
  historyTruncated: boolean;
  store: TranscriptViewStore;
}

interface ReaderIndexState {
  index: ReturnType<typeof useTranscript>["index"];
  indexState: ReturnType<typeof useTranscript>["indexState"];
  indexExpected: boolean;
  indexExpectedRef: RefObject<boolean>;
  indexEpochRef: RefObject<number | null>;
  restorePendingIndexPosition: ReturnType<
    typeof useTranscript
  >["restorePendingIndexPosition"];
  settleVisibleRanges: ReturnType<typeof useTranscript>["settleVisibleRanges"];
}

type HistoryController = ReturnType<typeof useTranscriptHistoryController>;

interface ReaderHistoryState {
  controller: HistoryController;
  loadingHistory: boolean;
}

interface ReaderLayoutOptions {
  session: Pick<UnifiedSession, "id" | "modelHistory">;
  transcript: ReaderTranscriptState;
  index: ReaderIndexState;
  history: ReaderHistoryState;
  send: SessionSocketSend;
}

export function useTranscriptReaderLayout({
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
}: ReaderLayoutOptions) {
  const transcriptHistoryRef = useRef(transcriptHistory);
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
    const cursors = transcriptHistoryRef.current.cursors;
    if (cursors.transcriptReadySessionRef.current !== session.id) return;
    const previous = cachedTranscriptView(session.id);
    const el = messagesRef.current;
    cacheTranscriptView(session.id, {
      entries,
      cursor: cursors.transcriptCursorRef.current,
      seq: cursors.transcriptSeqRef.current,
      historyTruncated,
      historyStart: cursors.historyStartRef.current,
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
    stopTranscriptHistoryHold(
      transcriptHistoryRef.current.hold.historyHoldRef,
      messagesRef,
    );
  }, [messagesRef]);
  useEffect(() => {
    transcriptHistoryRef.current.hold.loadingHistoryRef.current =
      loadingHistory;
  }, [loadingHistory]);
  // One page request. `whole` is the whole-history variant: a fat page in seq
  // mode, and in legacy mode the deliberately cursor-less request the server
  // answers with the entire transcript in one transcript_init — byte-window
  // paging has no cheap way to walk a backlog, and that full resend has always
  // been its fallback.
  const requestHistoryPage = useCallback(
    (whole = false) => {
      // Seq mode (transcript v2): page backwards from the earliest seq we
      // hold. Without a usable cursor the server falls back to a full
      // legacy resend, same as the legacy no-offset case below.
      send(
        historyPageRequest({
          sessionId: session.id,
          whole,
          sequence:
            transcriptHistoryRef.current.cursors.transcriptSeqRef.current,
          cursor:
            transcriptHistoryRef.current.cursors.transcriptCursorRef.current,
          historyStart:
            transcriptHistoryRef.current.cursors.historyStartRef.current,
          limits: {
            page: HISTORY_PAGE_ENTRIES,
            whole: JUMP_PAGE_ENTRIES,
          },
        }),
      );
    },
    [send, session.id],
  );
  // The whole backlog, one click: each page's arrival schedules the next (see
  // the transcript_history handler). `loadingHistory` deliberately stays true
  // across the gaps, which is what keeps the auto-load sentinel and a second
  // click from interleaving requests of their own.
  const finishHistoryWalk = useCallback(() => {
    const controller = transcriptHistoryRef.current;
    if (!controller.walk.historyWalkRef.current) return;
    controller.walk.historyWalkRef.current = null;
    controller.state.setLoadingAllHistory(false);
    stopHistoryHold();
  }, [stopHistoryHold]);

  const startHistoryHold = useCallback(
    (
      node: HTMLElement,
      ms: number,
      fallback: { height: number; top: number } | null,
    ) => {
      startTranscriptHistoryHold(
        transcriptHistoryRef.current.hold.historyHoldRef,
        followingLive,
        messagesRef,
        stopHistoryHold,
        { node, ms, fallback },
      );
    },
    [messagesRef, stopHistoryHold, followingLive],
  );
  // A page's worth of settling outlives its arrival, not the request: slow
  // fetches shouldn't burn the hold window, so extend it when a load lands.
  useEffect(() => {
    if (loadingHistory) return;
    const h = transcriptHistoryRef.current.hold.historyHoldRef.current;
    if (h) h.until = Math.max(h.until, performance.now() + 2500);
  }, [loadingHistory]);
  useEffect(() => stopHistoryHold, [session.id, stopHistoryHold]);
  // Switching sessions abandons an in-flight whole-history walk (its pages are
  // session-guarded anyway) — without this the flag would outlive it and keep
  // the control stuck in its loading state.
  useEffect(() => {
    const controller = transcriptHistoryRef.current;
    return () => resetTranscriptHistoryWalk(controller);
  }, [session.id]);

  return {
    scroll: {
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
    },
    settle: {
      tailActionNeedsLayoutScrollRef,
      openSettlePending,
      onVisibleRangesSettled,
      viewerInput,
      setViewerInput,
    },
    history: {
      stopHistoryHold,
      startHistoryHold,
      requestHistoryPage,
      finishHistoryWalk,
    },
  };
}

interface ReaderLifecycleIdentity {
  session: Pick<UnifiedSession, "id">;
  focused: boolean;
  sessionHidden: boolean;
}

interface ReaderLifecycleTranscript {
  entries: TranscriptEntry[];
  liveTurnStore: LiveTurnStore;
  loading: boolean;
  tailActionNeedsLayoutScrollRef: RefObject<boolean>;
}

interface ReaderLifecycleHistory {
  controller: HistoryController;
  historyTruncated: boolean;
  loadingHistory: boolean;
  requestHistoryPage: (whole?: boolean) => void;
  startHistoryHold: (
    node: HTMLElement,
    ms: number,
    fallback: { height: number; top: number } | null,
  ) => void;
}

interface ReaderLifecycleScroll {
  messagesRef: RefObject<HTMLDivElement | null>;
  followingLive: RefObject<boolean>;
  scrollToLatest: (behavior?: ScrollBehavior) => void;
  leaveLatest: () => void;
  relayout: () => void;
  onScroll: () => void;
  scheduleAnchorCapture: () => void;
  endTurn: () => void;
}

interface ReaderLifecycleRuntime {
  queued: unknown;
  steered: unknown;
  pending: unknown;
  ask: unknown;
  isBusy: boolean;
}

interface ReaderLifecycleIndex {
  transcriptIndexExpected: boolean;
  transcriptIndexExpectedRef: RefObject<boolean>;
}

interface ReaderLifecycleOptions {
  identity: ReaderLifecycleIdentity;
  transcript: ReaderLifecycleTranscript;
  history: ReaderLifecycleHistory;
  scroll: ReaderLifecycleScroll;
  runtime: ReaderLifecycleRuntime;
  index: ReaderLifecycleIndex;
}

export function useTranscriptReaderLifecycle({
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
}: ReaderLifecycleOptions) {
  const transcriptHistoryRef = useRef(transcriptHistory);
  const tailActionRef = useRef(tailActionNeedsLayoutScrollRef);
  const isSessionFocused = useEffectEvent(() => focused);
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
      transcriptHistoryRef.current.cursors.transcriptReadySessionRef.current !==
        session.id ||
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
  useLayoutEffect(() => {
    captureTranscriptVisibility(
      transcriptHistoryRef.current.visibility,
      entries,
      liveTurnStore,
    );
  }, [entries, liveTurnStore]);
  useEffect(() => {
    resetTranscriptVisibility(transcriptHistoryRef.current.visibility);
  }, [session.id]);
  useEffect(
    () =>
      listenForTranscriptVisibility(
        transcriptHistoryRef.current.visibility,
        scrollToLatest,
        {
          reopenAfterMs: HIDDEN_REOPEN_MS,
          growthWindowMs: RESUME_GROWTH_WINDOW_MS,
        },
      ),
    [scrollToLatest],
  );
  // The late-arrival half of the resume jump: growth landing inside the watch
  // window (WS backfill after a PWA resume) completes the jump to the edge.
  useEffect(() => {
    resumeTranscriptForEntryGrowth(
      transcriptHistoryRef.current.visibility,
      scrollToLatest,
    );
  }, [entries, scrollToLatest]);
  useEffect(
    () =>
      subscribeToTranscriptStreamGrowth(
        transcriptHistoryRef.current.visibility,
        liveTurnStore,
        scrollToLatest,
      ),
    [liveTurnStore, scrollToLatest],
  );
  useEffect(
    () =>
      listenForResumeCancellation(
        transcriptHistoryRef.current.visibility,
        messagesRef,
      ),
    [messagesRef],
  );

  // After any content change: keep a following reader at the live edge, or maintain
  // the pinned-turn spacer for a turn streaming into the space below (principles 4–6).
  // Layout effect so the adjustment happens before the browser paints — no flicker.
  useLayoutEffect(() => {
    relayout();
    if (!tailActionRef.current.current) return;
    tailActionRef.current.current = false;
    scrollToLatest("auto");
  }, [entries, queued, steered, pending, ask, relayout, scrollToLatest]);

  // Shared preamble: stop tracking the live edge, and pin the reader to the
  // content they're on while the page prepends above it.
  const beginHistoryLoad = useCallback(
    (holdMs = 8000) => {
      beginTranscriptHistoryLoad(
        holdMs,
        { messagesRef },
        {
          leaveLatest,
          startHistoryHold,
          setLoadingHistory:
            transcriptHistoryRef.current.state.setLoadingHistory,
        },
      );
    },
    [leaveLatest, messagesRef, startHistoryHold],
  );
  const loadEarlierHistory = useCallback(() => {
    loadEarlierTranscriptHistory(
      session.id,
      { historyTruncated, indexExpectedRef: transcriptIndexExpectedRef },
      {
        loadingRef: transcriptHistoryRef.current.hold.loadingHistoryRef,
        backgroundRef: transcriptHistoryRef.current.walk.backgroundHistoryRef,
        sequenceRef: transcriptHistoryRef.current.cursors.transcriptSeqRef,
        revealRef: transcriptHistoryRef.current.walk.historyRevealRef,
      },
      { begin: beginHistoryLoad, requestPage: requestHistoryPage },
    );
  }, [
    beginHistoryLoad,
    historyTruncated,
    requestHistoryPage,
    session.id,
    transcriptIndexExpectedRef,
  ]);
  const loadAllHistory = useCallback(() => {
    loadAllTranscriptHistory(
      session.id,
      { historyTruncated, indexExpectedRef: transcriptIndexExpectedRef },
      {
        loadingRef: transcriptHistoryRef.current.hold.loadingHistoryRef,
        revealRef: transcriptHistoryRef.current.walk.historyRevealRef,
        backgroundRef: transcriptHistoryRef.current.walk.backgroundHistoryRef,
        walkRef: transcriptHistoryRef.current.walk.historyWalkRef,
      },
      {
        setLoadingAllHistory:
          transcriptHistoryRef.current.state.setLoadingAllHistory,
        begin: beginHistoryLoad,
        requestPage: requestHistoryPage,
      },
    );
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
    const controller = transcriptHistoryRef.current;
    if (
      loading ||
      transcriptIndexExpected ||
      !historyTruncated ||
      loadingHistory ||
      sessionHidden ||
      controller.walk.backgroundHistoryAttemptedRef.current ||
      controller.cursors.transcriptSeqRef.current?.sessionId !== session.id
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
      controller.walk.backgroundHistoryAttemptedRef.current = true;
      controller.walk.backgroundHistoryRef.current = true;
      controller.hold.loadingHistoryRef.current = true;
      controller.state.setLoadingHistory(true);
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
  const handleMessagesScroll = useCallback(() => {
    handleTranscriptHistoryScroll(
      { sessionId: session.id, messagesRef, followingLive },
      {
        lastScrollTopRef:
          transcriptHistoryRef.current.gesture.lastHistoryScrollTopRef,
        backgroundHistoryRef:
          transcriptHistoryRef.current.walk.backgroundHistoryRef,
        gestureConsumedRef:
          transcriptHistoryRef.current.gesture.historyGestureConsumedRef,
        gestureUntilRef:
          transcriptHistoryRef.current.gesture.historyGestureUntilRef,
      },
      { onScroll, scheduleAnchorCapture, loadEarlierHistory },
    );
  }, [
    followingLive,
    loadEarlierHistory,
    messagesRef,
    onScroll,
    scheduleAnchorCapture,
    session.id,
  ]);
  useEffect(() => {
    const controller = transcriptHistoryRef.current;
    const {
      historyGestureUntilRef,
      historyGestureConsumedRef,
      lastHistoryWheelAtRef,
      lastHistoryScrollTopRef,
    } = controller.gesture;
    const { backgroundHistoryRef } = controller.walk;
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

  return {
    beginHistoryLoad,
    loadEarlierHistory,
    loadAllHistory,
    handleMessagesScroll,
  };
}
