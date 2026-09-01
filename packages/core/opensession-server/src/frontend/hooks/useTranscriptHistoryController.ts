import { useRef, useState } from "react";
import type { RefObject } from "react";
import {
  cacheTranscriptView,
  peekCachedTranscriptView,
  type CachedTranscriptView,
} from "../components/session-viewer/transcript-cache";
import {
  pickScrollAnchor,
  readFollowingLive,
} from "../components/session-viewer/transcript-anchor";
import type { LiveTurnStore } from "../lib/live-turn-store";
import type { TranscriptEntry } from "../lib/types";
import type {
  HiddenTranscriptSnapshot,
  HistoryWalk,
  ResumeTranscriptWatch,
  TranscriptCursor,
  TranscriptSequence,
} from "../lib/transcript-history-controller";
import {
  scrolledTowardHistory,
  shouldConsumeHistoryGesture,
  shouldJumpOnVisibilityResume,
} from "../lib/transcript-history-controller";

export type HistoryHold = {
  node: HTMLElement;
  top: number;
  eid: string | null;
  eidTop: number | null;
  until: number;
  raf: number;
  fallback: { height: number; top: number } | null;
};

type TranscriptHistoryVisibility = {
  lastEntryIdRef: RefObject<string | null>;
  streamLenRef: RefObject<number>;
  hiddenSnapRef: RefObject<HiddenTranscriptSnapshot | null>;
  resumeWatchRef: RefObject<ResumeTranscriptWatch | null>;
};

export function stopTranscriptHistoryHold(
  historyHoldRef: RefObject<HistoryHold | null>,
  messagesRef: RefObject<HTMLDivElement | null>,
) {
  const hold = historyHoldRef.current;
  if (!hold) return;
  cancelAnimationFrame(hold.raf);
  historyHoldRef.current = null;
  const container = messagesRef.current;
  if (container) container.style.overflowAnchor = "";
}

export function startTranscriptHistoryHold(
  historyHoldRef: RefObject<HistoryHold | null>,
  followingLive: RefObject<boolean>,
  messagesRef: RefObject<HTMLDivElement | null>,
  stopHistoryHold: () => void,
  anchor: {
    node: HTMLElement;
    ms: number;
    fallback: { height: number; top: number } | null;
  },
) {
  const container = messagesRef.current;
  if (!container) return;
  stopHistoryHold();
  container.style.overflowAnchor = "none";
  const contentTopOf = (node: HTMLElement, parent: HTMLElement) =>
    node.getBoundingClientRect().top -
    parent.getBoundingClientRect().top +
    parent.scrollTop;
  // Two anchor layers: the tight node for frame-to-frame deltas, and its
  // nearest [data-eid] ancestor as a *recovery identity* — when a prepend
  // merges into the anchor's turn block the whole block remounts (its key
  // is its first item id) and every DOM node dies, but the same entry
  // re-renders under the same data-eid.
  const closestEntry = anchor.node.closest?.("[data-eid]");
  const idElement = closestEntry instanceof HTMLElement ? closestEntry : null;
  const hold: HistoryHold = {
    node: anchor.node,
    top: contentTopOf(anchor.node, container),
    eid: idElement?.dataset.eid ?? null,
    eidTop: idElement ? contentTopOf(idElement, container) : null,
    until: performance.now() + anchor.ms,
    raf: 0,
    fallback: anchor.fallback,
  };
  historyHoldRef.current = hold;
  const tick = () => {
    const current = historyHoldRef.current;
    const parent = messagesRef.current;
    if (!current || current !== hold || !parent) return;
    if (performance.now() > current.until || readFollowingLive(followingLive)) {
      stopHistoryHold();
      return;
    }
    if (current.node.isConnected) {
      const top = contentTopOf(current.node, parent);
      const delta = top - current.top;
      if (delta !== 0) parent.scrollTop += delta;
      current.top = top;
      // Keep the recovery identity fresh: cheap ancestor walk, and the
      // content offset re-measured so a later remount recovers to the
      // reader's latest position, not the hold's starting one.
      const closestEntry = current.node.closest?.("[data-eid]");
      const nextIdElement =
        closestEntry instanceof HTMLElement ? closestEntry : null;
      current.eid = nextIdElement?.dataset.eid ?? current.eid;
      current.eidTop = nextIdElement
        ? contentTopOf(nextIdElement, parent)
        : current.eidTop;
    } else {
      // Anchor DOM died (block remount). Recover through the entry id:
      // same content, new nodes — shift by how far it moved.
      const revived =
        current.eid && typeof CSS !== "undefined"
          ? parent.querySelector<HTMLElement>(
              `[data-eid="${CSS.escape(current.eid)}"]`,
            )
          : null;
      if (revived && current.eidTop !== null) {
        const delta = contentTopOf(revived, parent) - current.eidTop;
        if (delta !== 0) parent.scrollTop += delta;
      } else if (current.fallback) {
        // Last resort: height math. Skewed by content-visibility
        // estimate resets, but better than staying at a raw offset.
        parent.scrollTop =
          parent.scrollHeight - current.fallback.height + current.fallback.top;
      }
      current.fallback = null;
      const next = revived ?? pickScrollAnchor(parent);
      if (!next) {
        stopHistoryHold();
        return;
      }
      const closestEntry = next.closest?.("[data-eid]");
      const nextIdElement =
        closestEntry instanceof HTMLElement ? closestEntry : null;
      current.node = next;
      current.top = contentTopOf(next, parent);
      current.eid = nextIdElement?.dataset.eid ?? null;
      current.eidTop = nextIdElement
        ? contentTopOf(nextIdElement, parent)
        : null;
    }
    current.raf = requestAnimationFrame(tick);
  };
  hold.raf = requestAnimationFrame(tick);
}

export function handleTranscriptHistoryScroll(
  viewport: {
    sessionId: string;
    messagesRef: RefObject<HTMLDivElement | null>;
    followingLive: RefObject<boolean>;
  },
  history: {
    lastScrollTopRef: RefObject<number>;
    backgroundHistoryRef: RefObject<boolean>;
    gestureConsumedRef: RefObject<boolean>;
    gestureUntilRef: RefObject<number>;
  },
  actions: {
    onScroll: () => void;
    scheduleAnchorCapture: () => void;
    loadEarlierHistory: () => void;
  },
) {
  const container = viewport.messagesRef.current;
  const previous = history.lastScrollTopRef.current;
  const current = container?.scrollTop ?? previous;
  history.lastScrollTopRef.current = current;
  actions.onScroll();
  const cached = peekCachedTranscriptView(viewport.sessionId);
  // Only the cheap fields here: a scroll event must not walk the
  // transcript. The anchor follows once the reader settles.
  if (container && cached) {
    cacheTranscriptView(viewport.sessionId, {
      ...cached,
      scrollTop: current,
      following: viewport.followingLive.current,
    });
    actions.scheduleAnchorCapture();
  }
  if (
    container &&
    scrolledTowardHistory(previous, current) &&
    history.backgroundHistoryRef.current
  ) {
    actions.loadEarlierHistory();
  }
  if (
    container &&
    shouldConsumeHistoryGesture({
      previousScrollTop: previous,
      currentScrollTop: current,
      consumed: history.gestureConsumedRef.current,
      gestureUntil: history.gestureUntilRef.current,
      now: performance.now(),
    })
  ) {
    history.gestureConsumedRef.current = true;
    history.gestureUntilRef.current = 0;
    actions.loadEarlierHistory();
  }
}

export function beginTranscriptHistoryLoad(
  holdMs: number,
  viewport: { messagesRef: RefObject<HTMLDivElement | null> },
  actions: {
    leaveLatest: () => void;
    startHistoryHold: (
      node: HTMLElement,
      ms: number,
      fallback: { height: number; top: number },
    ) => void;
    setLoadingHistory: (loading: boolean) => void;
  },
) {
  actions.leaveLatest();
  const container = viewport.messagesRef.current;
  if (container) {
    // Anchor on the tightest element at the viewport top — it sits below
    // everything the prepend inserts, so its content offset shifts by
    // exactly the added height (what native scroll anchoring would pick).
    const node = pickScrollAnchor(container);
    if (node)
      actions.startHistoryHold(node, holdMs, {
        height: container.scrollHeight,
        top: container.scrollTop,
      });
  }
  actions.setLoadingHistory(true);
}

export function loadEarlierTranscriptHistory(
  sessionId: string,
  state: {
    historyTruncated: boolean;
    indexExpectedRef: RefObject<boolean>;
  },
  history: {
    loadingRef: RefObject<boolean>;
    backgroundRef: RefObject<boolean>;
    sequenceRef: RefObject<TranscriptSequence | null>;
    revealRef: RefObject<HistoryWalk | null>;
  },
  actions: { begin: () => void; requestPage: () => void },
) {
  if (state.indexExpectedRef.current || !state.historyTruncated) return;
  if (history.loadingRef.current) {
    // The deferred page is already on the wire. Adopt it rather than making
    // the first upward gesture look ignored, and let its response continue
    // until a visible conversation boundary lands.
    if (history.backgroundRef.current) {
      history.backgroundRef.current = false;
      if (history.sequenceRef.current?.sessionId === sessionId) {
        history.revealRef.current = { sessionId, loaded: 0, cursor: null };
      }
      actions.begin();
    }
    return;
  }
  history.loadingRef.current = true;
  if (history.sequenceRef.current?.sessionId === sessionId) {
    history.revealRef.current = { sessionId, loaded: 0, cursor: null };
  }
  actions.begin();
  actions.requestPage();
}

export function loadAllTranscriptHistory(
  sessionId: string,
  state: {
    historyTruncated: boolean;
    indexExpectedRef: RefObject<boolean>;
  },
  history: {
    loadingRef: RefObject<boolean>;
    revealRef: RefObject<HistoryWalk | null>;
    backgroundRef: RefObject<boolean>;
    walkRef: RefObject<HistoryWalk | null>;
  },
  actions: {
    setLoadingAllHistory: (loading: boolean) => void;
    begin: (holdMs: number) => void;
    requestPage: (whole: boolean) => void;
  },
) {
  if (
    state.indexExpectedRef.current ||
    !state.historyTruncated ||
    history.loadingRef.current
  )
    return;
  history.loadingRef.current = true;
  history.revealRef.current = null;
  history.backgroundRef.current = false;
  history.walkRef.current = { sessionId, loaded: 0, cursor: null };
  actions.setLoadingAllHistory(true);
  actions.begin(60_000);
  actions.requestPage(true);
}

export function resetTranscriptHistoryWalk(controller: {
  walk: {
    historyWalkRef: RefObject<HistoryWalk | null>;
    historyRevealRef: RefObject<HistoryWalk | null>;
    backgroundHistoryRef: RefObject<boolean>;
  };
  state: { setLoadingAllHistory: (loading: boolean) => void };
}) {
  controller.walk.historyWalkRef.current = null;
  controller.walk.historyRevealRef.current = null;
  controller.walk.backgroundHistoryRef.current = false;
  controller.state.setLoadingAllHistory(false);
}

export function captureTranscriptVisibility(
  visibility: TranscriptHistoryVisibility,
  entries: TranscriptEntry[],
  liveTurnStore: LiveTurnStore,
) {
  visibility.lastEntryIdRef.current =
    entries.length > 0 ? entries[entries.length - 1].id : null;
  visibility.streamLenRef.current = liveTurnStore.textLength();
}

export function resetTranscriptVisibility(
  visibility: TranscriptHistoryVisibility,
) {
  visibility.hiddenSnapRef.current = null;
  visibility.resumeWatchRef.current = null;
}

export function listenForTranscriptVisibility(
  visibility: TranscriptHistoryVisibility,
  scrollToLatest: (behavior?: ScrollBehavior) => void,
  timing: { reopenAfterMs: number; growthWindowMs: number },
): () => void {
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      visibility.hiddenSnapRef.current = {
        at: Date.now(),
        lastEntryId: visibility.lastEntryIdRef.current,
        streamLen: visibility.streamLenRef.current,
      };
      visibility.resumeWatchRef.current = null;
      return;
    }
    const snapshot = visibility.hiddenSnapRef.current;
    visibility.hiddenSnapRef.current = null;
    if (!snapshot) return;
    if (
      shouldJumpOnVisibilityResume({
        hidden: snapshot,
        current: {
          lastEntryId: visibility.lastEntryIdRef.current,
          streamLen: visibility.streamLenRef.current,
        },
        now: Date.now(),
        reopenAfterMs: timing.reopenAfterMs,
      })
    ) {
      scrollToLatest("auto");
    } else {
      visibility.resumeWatchRef.current = {
        until: performance.now() + timing.growthWindowMs,
        lastEntryId: snapshot.lastEntryId,
        streamLen: snapshot.streamLen,
      };
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => document.removeEventListener("visibilitychange", onVisibility);
}

export function resumeTranscriptForEntryGrowth(
  visibility: TranscriptHistoryVisibility,
  scrollToLatest: (behavior?: ScrollBehavior) => void,
) {
  const watch = visibility.resumeWatchRef.current;
  if (!watch) return;
  if (performance.now() > watch.until) {
    visibility.resumeWatchRef.current = null;
    return;
  }
  if (visibility.lastEntryIdRef.current !== watch.lastEntryId) {
    visibility.resumeWatchRef.current = null;
    scrollToLatest("auto");
  }
}

export function subscribeToTranscriptStreamGrowth(
  visibility: TranscriptHistoryVisibility,
  liveTurnStore: LiveTurnStore,
  scrollToLatest: (behavior?: ScrollBehavior) => void,
): () => void {
  return liveTurnStore.subscribe(() => {
    visibility.streamLenRef.current = liveTurnStore.textLength();
    const watch = visibility.resumeWatchRef.current;
    if (
      watch &&
      performance.now() <= watch.until &&
      visibility.streamLenRef.current > watch.streamLen
    ) {
      visibility.resumeWatchRef.current = null;
      scrollToLatest("auto");
    }
  });
}

export function listenForResumeCancellation(
  visibility: TranscriptHistoryVisibility,
  messagesRef: RefObject<HTMLDivElement | null>,
): (() => void) | undefined {
  const container = messagesRef.current;
  if (!container) return;
  const cancelResumeJump = () => {
    visibility.resumeWatchRef.current = null;
  };
  container.addEventListener("touchstart", cancelResumeJump, { passive: true });
  container.addEventListener("wheel", cancelResumeJump, { passive: true });
  return () => {
    container.removeEventListener("touchstart", cancelResumeJump);
    container.removeEventListener("wheel", cancelResumeJump);
  };
}

export function useTranscriptHistoryController({
  sessionId,
  ran,
  cachedTranscript,
}: {
  sessionId: string;
  ran: boolean | undefined;
  cachedTranscript: CachedTranscriptView | null;
}) {
  // Initial scrolling must wait for this session's transcript_init. During a
  // session switch, entries from the previous session remain rendered until the
  // WebSocket response arrives and must not consume the new session's scroll.
  const transcriptReadySessionRef = useRef<string | null>(
    cachedTranscript ? sessionId : null,
  );
  // Reconnect resume cursor: endOffset/rev of the last transcript frame the
  // server sent (transcript_init/append). On a re-watch of the SAME session
  // with entries still mounted, it rides the watch message as
  // sinceOffset/sinceRev so the server replays only the gap from the mirror
  // jsonl instead of replacing the whole tail.
  const transcriptCursorRef = useRef<TranscriptCursor | null>(
    cachedTranscript?.cursor ?? null,
  );
  // Transcript v2 seq mode (docs/transcripts.md): when init/append
  // frames carry seq fields the server is serving from the owned store —
  // resume watches with sinceSeq, page older history with beforeSeq, and
  // ignore offset/rev cursors while in this mode. null = legacy mode (old
  // server or ineligible session): behavior byte-identical to pre-v2.
  // lastSeq tracks the newest seq seen (max — upsert republishes reuse old
  // seqs); firstSeq the earliest loaded (the "load earlier" cursor).
  const transcriptSeqRef = useRef<TranscriptSequence | null>(
    cachedTranscript?.seq ?? null,
  );
  // Existing engine-backed sessions can load from the owned transcript store even
  // when no mirror file exists. Fresh sessions never ran, so they still render
  // the empty canvas without flashing a loader. `ran` and not the engine ids:
  // this is the FIRST render, before the session's detail has hydrated, and
  // the list row carries the answer where it no longer carries the ids.
  const [loading, setLoading] = useState(!cachedTranscript && !!ran);
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
  const historyWalkRef = useRef<HistoryWalk | null>(null);
  // An ordinary history load walks until it reaches a user/system boundary.
  // A raw page can otherwise land wholly inside one collapsed work turn, which
  // makes a successful load look like a no-op. This stays separate from the
  // explicit whole-history walk and has its own small ceiling.
  const historyRevealRef = useRef<HistoryWalk | null>(null);
  // One extra page downloads after the initial view settles. It starts only
  // while the reader is still at the live edge; an upward gesture adopts the
  // in-flight request into historyRevealRef and gives it the normal scroll hold.
  const backgroundHistoryRef = useRef(false);
  const backgroundHistoryAttemptedRef = useRef(false);
  const [loadingAllHistory, setLoadingAllHistory] = useState(false);
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
  const historyHoldRef = useRef<HistoryHold | null>(null);
  // Ref mirror keeps rapid clicks from sending duplicate history requests
  // before React re-renders with the disabled button.
  const loadingHistoryRef = useRef(false);
  const lastEntryIdRef = useRef<string | null>(null);
  const streamLenRef = useRef(0);
  const hiddenSnapRef = useRef<HiddenTranscriptSnapshot | null>(null);
  const resumeWatchRef = useRef<ResumeTranscriptWatch | null>(null);
  const historyGestureUntilRef = useRef(0);
  const historyGestureConsumedRef = useRef(true);
  const lastHistoryWheelAtRef = useRef(0);
  const lastHistoryScrollTopRef = useRef(0);

  return {
    state: {
      loading,
      setLoading,
      historyTruncated,
      setHistoryTruncated,
      loadingHistory,
      setLoadingHistory,
      loadingAllHistory,
      setLoadingAllHistory,
    },
    cursors: {
      transcriptReadySessionRef,
      transcriptCursorRef,
      transcriptSeqRef,
      historyStartRef,
    },
    walk: {
      historyWalkRef,
      historyRevealRef,
      backgroundHistoryRef,
      backgroundHistoryAttemptedRef,
    },
    hold: { historyHoldRef, loadingHistoryRef },
    visibility: {
      lastEntryIdRef,
      streamLenRef,
      hiddenSnapRef,
      resumeWatchRef,
    },
    gesture: {
      historyGestureUntilRef,
      historyGestureConsumedRef,
      lastHistoryWheelAtRef,
      lastHistoryScrollTopRef,
    },
  };
}
