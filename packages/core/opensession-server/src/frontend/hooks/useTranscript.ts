import type { TranscriptIndexEntry } from "@tellahq/opensession-protocol/session";
import { useLayoutEffect, useRef, useState } from "react";
import { randomUUID } from "../lib/random-uuid";
import {
  mergeTranscriptIndexEntries,
  transcriptIndexEntryFromPayload,
  type TranscriptIndexedRange,
} from "../lib/transcript-index";
import type { TranscriptViewStore } from "../lib/transcript-view-store";
import type { TranscriptEntry, WSServerMessage } from "../lib/types";
import type { CachedTranscriptView } from "../components/session-viewer/transcript-cache";
import {
  holdTranscriptAnchor,
  pickScrollAnchor,
  readFollowingLive,
} from "../components/session-viewer/transcript-anchor";
import type { SessionSocketSend } from "./useSessionSocket";

const TRANSCRIPT_RANGE_CONCURRENCY = 6;
// The custom hold only bridges the bounded-tail → full-index identity handoff.
// Once the entry exists under its new structural key, native virtual anchoring
// owns every later insertion and measurement. Keeping both active double-moves
// the viewport when range payload lands.
const INDEX_ANCHOR_BRIDGE_MS = 0;
const RANGE_REQUEST_TIMEOUT_MS = 15_000;
const LIVE_EDGE_THRESHOLD = 90;

type TranscriptIndexMessage = Extract<
  WSServerMessage,
  { type: "transcript_index" }
>;
type TranscriptRangeMessage = Extract<
  WSServerMessage,
  { type: "transcript_range" }
>;

type TranscriptIndexState = {
  sessionId: string;
  entries: TranscriptIndexEntry[];
};

type PendingIndexPosition = {
  sessionId: string;
  keepLiveEdge: boolean;
  bottomGap: number | null;
  anchorEid: string | null;
  anchorTop: number | null;
};

type TranscriptRangeRequest = {
  range: TranscriptIndexedRange;
  requestId: string;
  timer: ReturnType<typeof setTimeout>;
};

interface UseTranscriptOptions {
  sessionId: string;
  cachedTranscript: CachedTranscriptView | null;
  send: SessionSocketSend;
  transcriptViewStore: TranscriptViewStore;
}

export interface TranscriptController {
  index: TranscriptIndexEntry[] | null;
  indexState: TranscriptIndexState | null;
  indexExpected: boolean;
  indexExpectedRef: React.RefObject<boolean>;
  indexEpochRef: React.RefObject<number | null>;
  rangeRetryGeneration: number;
  rangesLoading: boolean;
  existingIndexForInit: (v2: boolean) => TranscriptIndexEntry[] | null;
  setIndexMode: (v2: boolean) => void;
  acceptInitTail: (
    entries: TranscriptEntry[],
    existingIndex: TranscriptIndexEntry[] | null,
  ) => void;
  replaceIndex: (
    message: TranscriptIndexMessage,
    container: HTMLDivElement | null,
    followingLive: boolean,
  ) => void;
  acceptRange: (message: TranscriptRangeMessage) => void;
  projectAppend: (entries: TranscriptEntry[], firstSeq?: number) => void;
  loadRanges: (ranges: TranscriptIndexedRange[]) => void;
  cancelIndexAnchorHold: () => void;
  restorePendingIndexPosition: (options: {
    container: HTMLDivElement | null;
    scrollToLatest: (behavior?: ScrollBehavior) => void;
    leaveLatest: () => void;
  }) => void;
  settleVisibleRanges: (options: {
    followingLive: React.RefObject<boolean>;
    scrollToLatest: (behavior?: ScrollBehavior) => void;
    onSettled: () => void;
  }) => void;
}

export function useTranscript({
  sessionId,
  cachedTranscript,
  send,
  transcriptViewStore,
}: UseTranscriptOptions): TranscriptController {
  const [indexState, setIndexState] = useState<TranscriptIndexState | null>(
    () =>
      cachedTranscript?.index
        ? { sessionId, entries: cachedTranscript.index }
        : null,
  );
  const indexStateRef = useRef(indexState);
  useLayoutEffect(() => {
    indexStateRef.current = indexState;
  }, [indexState]);
  const [indexExpected, setIndexExpected] = useState(
    Boolean(cachedTranscript?.index),
  );
  const indexExpectedRef = useRef(Boolean(cachedTranscript?.index));
  const index = indexState?.sessionId === sessionId ? indexState.entries : null;
  const indexEpochRef = useRef<number | null>(
    cachedTranscript?.indexEpoch ?? null,
  );
  // A bounded init only describes its loaded tail. Do not settle against that
  // partial outline while the complete index is still on the wire.
  const [outlineReady, setOutlineReady] = useState(
    !cachedTranscript?.index || cachedTranscript.indexEpoch !== null,
  );
  const rangeDemandReadyRef = useRef(false);
  const [rangeRetryGeneration, setRangeRetryGeneration] = useState(0);
  const indexAnchorHoldCancelRef = useRef<(() => void) | null>(null);
  const pendingIndexPositionRef = useRef<PendingIndexPosition | null>(null);
  const completedRangeKeysRef = useRef(new Set<string>());
  const rangeRequestsRef = useRef(new Map<string, TranscriptRangeRequest>());
  const [rangesLoading, setRangesLoading] = useState(false);
  const syncRangesLoading = () =>
    setRangesLoading(rangeRequestsRef.current.size > 0);
  const settledIndexRef = useRef<TranscriptIndexEntry[] | null>(null);

  const cancelIndexAnchorHold = () => {
    indexAnchorHoldCancelRef.current?.();
    indexAnchorHoldCancelRef.current = null;
  };

  const clearRangeRequests = () => {
    for (const request of rangeRequestsRef.current.values())
      clearTimeout(request.timer);
    rangeRequestsRef.current.clear();
    completedRangeKeysRef.current.clear();
    syncRangesLoading();
  };

  const existingIndexForInit = (v2: boolean) =>
    v2 && indexStateRef.current?.sessionId === sessionId
      ? indexStateRef.current.entries
      : null;

  const setIndexMode = (v2: boolean) => {
    indexExpectedRef.current = v2;
    setIndexExpected(v2);
    setOutlineReady(!v2);
  };

  const acceptInitTail = (
    entries: TranscriptEntry[],
    existingIndex: TranscriptIndexEntry[] | null,
  ) => {
    const tailIndex = entries
      .map(transcriptIndexEntryFromPayload)
      .filter((entry): entry is TranscriptIndexEntry => entry !== null);
    setIndexState({
      sessionId,
      entries: existingIndex
        ? mergeTranscriptIndexEntries(existingIndex, tailIndex)
        : tailIndex,
    });
    indexEpochRef.current = null;
    rangeDemandReadyRef.current = false;
    pendingIndexPositionRef.current = null;
    cancelIndexAnchorHold();
    clearRangeRequests();
  };

  const replaceIndex = (
    message: TranscriptIndexMessage,
    container: HTMLDivElement | null,
    followingLive: boolean,
  ) => {
    // Capture both mappings before replacing the bounded tail. Bottom distance
    // is the fallback while virtual rows mount; the entry identity restores the
    // exact visible content once its real row exists.
    const keepLiveEdge =
      followingLive ||
      (!!container &&
        container.scrollHeight - container.scrollTop - container.clientHeight <
          LIVE_EDGE_THRESHOLD);
    const bottomGap =
      !keepLiveEdge && container
        ? Math.max(
            0,
            container.scrollHeight -
              container.scrollTop -
              container.clientHeight,
          )
        : null;
    const anchor =
      !keepLiveEdge && container ? pickScrollAnchor(container) : null;
    pendingIndexPositionRef.current = {
      sessionId,
      keepLiveEdge,
      bottomGap,
      anchorEid: anchor?.dataset.eid ?? null,
      anchorTop:
        anchor && container
          ? anchor.getBoundingClientRect().top -
            container.getBoundingClientRect().top
          : null,
    };
    indexExpectedRef.current = true;
    setIndexExpected(true);
    indexEpochRef.current = message.epoch;
    setOutlineReady(true);
    setIndexState({ sessionId, entries: message.entries });
    rangeDemandReadyRef.current = false;
  };

  const loadRanges = (ranges: TranscriptIndexedRange[]) => {
    const epoch = indexEpochRef.current;
    if (epoch === null || !rangeDemandReadyRef.current) return;
    let capacity = Math.max(
      0,
      TRANSCRIPT_RANGE_CONCURRENCY - rangeRequestsRef.current.size,
    );
    for (const range of ranges) {
      if (capacity <= 0) break;
      const key = `${range.firstSeq}:${range.lastSeq}`;
      if (
        completedRangeKeysRef.current.has(key) ||
        rangeRequestsRef.current.has(key)
      )
        continue;
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        rangeRequestsRef.current.delete(key);
        syncRangesLoading();
        setRangeRetryGeneration((generation) => generation + 1);
      }, RANGE_REQUEST_TIMEOUT_MS);
      rangeRequestsRef.current.set(key, { range, requestId, timer });
      capacity -= 1;
      send({
        type: "load_transcript_range",
        sessionId,
        requestId,
        firstSeq: range.firstSeq,
        lastSeq: range.lastSeq,
        epoch,
      });
    }
    syncRangesLoading();
  };

  const acceptRange = (message: TranscriptRangeMessage) => {
    if (message.epoch !== indexEpochRef.current) return;
    const found = [...rangeRequestsRef.current.entries()].find(
      ([, request]) => request.requestId === message.requestId,
    );
    if (!found) return;
    transcriptViewStore.mergeRange(message.entries);
    const [key, request] = found;
    clearTimeout(request.timer);
    if (message.complete) {
      completedRangeKeysRef.current.add(key);
      rangeRequestsRef.current.delete(key);
      syncRangesLoading();
      setRangeRetryGeneration((generation) => generation + 1);
      return;
    }
    request.timer = setTimeout(() => {
      rangeRequestsRef.current.delete(key);
      syncRangesLoading();
      setRangeRetryGeneration((generation) => generation + 1);
    }, RANGE_REQUEST_TIMEOUT_MS);
    send({
      type: "load_transcript_range",
      sessionId,
      requestId: request.requestId,
      firstSeq: request.range.firstSeq,
      lastSeq: request.range.lastSeq,
      afterSeq: message.coveredThroughSeq,
      epoch: message.epoch,
    });
  };

  const projectAppend = (entries: TranscriptEntry[], firstSeq?: number) => {
    if (indexEpochRef.current === null) return;
    const projected = entries
      .map(transcriptIndexEntryFromPayload)
      .filter((entry): entry is TranscriptIndexEntry => entry !== null);
    setIndexState((current) =>
      current?.sessionId === sessionId
        ? {
            ...current,
            entries: mergeTranscriptIndexEntries(current.entries, projected),
          }
        : current,
    );
    if (entries.length === 0 && firstSeq !== undefined)
      send({ type: "load_transcript_index", sessionId });
  };

  const restorePendingIndexPosition = ({
    container,
    scrollToLatest,
    leaveLatest,
  }: {
    container: HTMLDivElement | null;
    scrollToLatest: (behavior?: ScrollBehavior) => void;
    leaveLatest: () => void;
  }) => {
    const pending = pendingIndexPositionRef.current;
    if (!pending || indexState?.sessionId !== pending.sessionId) return;
    pendingIndexPositionRef.current = null;
    if (pending.keepLiveEdge) {
      scrollToLatest("auto");
    } else if (container && pending.bottomGap !== null) {
      container.scrollTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight - pending.bottomGap,
      );
      if (pending.anchorEid && pending.anchorTop !== null) {
        cancelIndexAnchorHold();
        let cancelIndexHold = () => {};
        cancelIndexHold = holdTranscriptAnchor(
          container,
          pending.anchorEid,
          pending.anchorTop,
          pending.bottomGap,
          leaveLatest,
          () => {
            if (indexAnchorHoldCancelRef.current === cancelIndexHold)
              indexAnchorHoldCancelRef.current = null;
          },
          INDEX_ANCHOR_BRIDGE_MS,
        );
        indexAnchorHoldCancelRef.current = cancelIndexHold;
      }
    }
    requestAnimationFrame(() => {
      rangeDemandReadyRef.current = true;
      setRangeRetryGeneration((generation) => generation + 1);
    });
  };

  const settleVisibleRanges = ({
    followingLive,
    scrollToLatest,
    onSettled,
  }: {
    followingLive: React.RefObject<boolean>;
    scrollToLatest: (behavior?: ScrollBehavior) => void;
    onSettled: () => void;
  }) => {
    if (!outlineReady) return;
    onSettled();
    // Retire a bridge still waiting for its replacement identity. The identity
    // check prevents this delayed cleanup from cancelling a newer handoff.
    const settledHold = indexAnchorHoldCancelRef.current;
    if (settledHold) {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (indexAnchorHoldCancelRef.current !== settledHold) return;
          settledHold();
          indexAnchorHoldCancelRef.current = null;
        }),
      );
    }
    if (settledIndexRef.current === index) return;
    settledIndexRef.current = index;
    if (readFollowingLive(followingLive)) scrollToLatest("auto");
  };

  return {
    index,
    indexState,
    indexExpected,
    indexExpectedRef,
    indexEpochRef,
    rangeRetryGeneration,
    rangesLoading,
    existingIndexForInit,
    setIndexMode,
    acceptInitTail,
    replaceIndex,
    acceptRange,
    projectAppend,
    loadRanges,
    cancelIndexAnchorHold,
    restorePendingIndexPosition,
    settleVisibleRanges,
  };
}

export function useTranscriptIndexAnchor({
  indexState,
  restorePendingIndexPosition,
  containerRef,
  scrollToLatest,
  leaveLatest,
}: {
  indexState: TranscriptIndexState | null;
  restorePendingIndexPosition: TranscriptController["restorePendingIndexPosition"];
  containerRef: React.RefObject<HTMLDivElement | null>;
  scrollToLatest: (behavior?: ScrollBehavior) => void;
  leaveLatest: () => void;
}) {
  useLayoutEffect(() => {
    restorePendingIndexPosition({
      container: containerRef.current,
      scrollToLatest,
      leaveLatest,
    });
  }, [
    containerRef,
    indexState,
    leaveLatest,
    restorePendingIndexPosition,
    scrollToLatest,
  ]);
}
