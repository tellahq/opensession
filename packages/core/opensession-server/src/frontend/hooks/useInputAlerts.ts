import { useEffect, useLayoutEffect, useRef } from "react";
import type { UnifiedSession } from "../lib/types";
import { notifyEvent } from "../lib/notify";

// Watches the polled session list and alerts (sound + desktop banner, per the
// user's notification settings) each time one of *your* sessions newly:
//   • transitions into "needs input" (blocked on an AskUserQuestion, or its
//     run died on a terminal error — credits/usage limits/API failure), or
//   • finishes a run (was running, now idle and not waiting),
// plus — over ANY session, not just yours — each time a teammate newly asks
// YOU to review one (the info panel's Reviewer picker).
// Only transitions alert — a session already in that state when the tab opens, or
// one that stays there across polls, does not re-fire. Which events actually
// notify is decided inside notifyEvent from the persisted settings.
export function useInputAlerts(
  sessions: UnifiedSession[],
  opts: {
    isMine: (s: UnifiedSession) => boolean;
    /** Is this session's pending review request pointed at the current user? */
    isMyReview: (s: UnifiedSession) => boolean;
    onOpen: (id: string) => void;
    /** WebSocket connectivity — a drop (server restart) re-seeds the
     * baselines, so the flap where every resumed session briefly reads
     * not-running doesn't fire spurious "Finished" alerts. */
    connected?: boolean;
  },
): void {
  // null until the first snapshot — used to seed the baseline without alerting on
  // sessions that were already in-state before this tab opened.
  const waitingRef = useRef<Set<string> | null>(null);
  const runningRef = useRef<Set<string> | null>(null);
  const reviewRef = useRef<Set<string> | null>(null);
  const isMineRef = useRef(opts.isMine);
  const isMyReviewRef = useRef(opts.isMyReview);
  const onOpenRef = useRef(opts.onOpen);
  // Mirror latest props for the effect/handlers below. Committed values are
  // enough: nothing reads these during render.
  useLayoutEffect(() => {
    isMineRef.current = opts.isMine;
    isMyReviewRef.current = opts.isMyReview;
    onOpenRef.current = opts.onOpen;
  });

  // A disconnect voids the baselines: the next snapshot after reconnect
  // seeds silently instead of diffing against pre-restart state.
  useEffect(() => {
    if (opts.connected === false) {
      waitingRef.current = null;
      runningRef.current = null;
      reviewRef.current = null;
    }
  }, [opts.connected]);

  useEffect(() => {
    const mine = sessions.filter((s) => isMineRef.current(s));

    const waiting = mine.filter(
      (s) => s.waitingForInput || (s.lastRunError && !s.isRunning),
    );
    const waitingIds = new Set(waiting.map((s) => s.id));
    const running = mine.filter((s) => s.isRunning);
    const runningIds = new Set(running.map((s) => s.id));
    const review = sessions.filter((s) => isMyReviewRef.current(s));
    // Key on the request timestamp too, so a re-request (clear → ask again,
    // or a hand-off back to you) re-fires.
    const reviewIds = new Set(
      review.map((s) => `${s.id}:${s.reviewRequest?.at}`),
    );

    // Seed baselines on the first snapshot without firing.
    if (
      waitingRef.current === null ||
      runningRef.current === null ||
      reviewRef.current === null
    ) {
      waitingRef.current = waitingIds;
      runningRef.current = runningIds;
      reviewRef.current = reviewIds;
      return;
    }

    const prevWaiting = waitingRef.current;
    const prevRunning = runningRef.current;
    const prevReview = reviewRef.current;
    waitingRef.current = waitingIds;
    runningRef.current = runningIds;
    reviewRef.current = reviewIds;

    // Newly asked to review — treated like "needs input": a human is being
    // waited on, it's just you instead of the owner.
    for (const s of review) {
      if (prevReview.has(`${s.id}:${s.reviewRequest?.at}`)) continue;
      notifyEvent(
        "needsInput",
        "Needs your review",
        `${s.reviewRequest?.by || "Someone"} asked you to review ${s.title || "a session"}`,
        () => onOpenRef.current(s.id),
        s.id,
      );
    }

    // Newly waiting for input.
    for (const s of waiting) {
      if (prevWaiting.has(s.id)) continue;
      notifyEvent(
        "needsInput",
        "Needs input",
        s.waitingForInput
          ? s.title || "A session is waiting for your answer"
          : `Run failed: ${s.title || "a session needs attention"}`,
        () => onOpenRef.current(s.id),
        s.id,
      );
    }

    // Newly finished: was running, now not running and not waiting on a
    // question (a run that died on an error alerts as "needs input" above,
    // not as a misleading "Finished").
    for (const s of mine) {
      if (!prevRunning.has(s.id)) continue;
      if (s.isRunning || s.waitingForInput || s.lastRunError) continue;
      notifyEvent(
        "done",
        "Finished",
        s.title || "A session finished working",
        () => onOpenRef.current(s.id),
        s.id,
      );
    }
  }, [sessions]);
}
