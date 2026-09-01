import { describe, expect, test } from "bun:test";
import type { PrAutomationDetails } from "../../server/pr-info";
import { DesiredReviewScheduler } from "./desired-review";
import type { PrRef, ReviewResult } from "./review";
import type { GithubPrState } from "./state";

function prDetails(ref: PrRef): PrAutomationDetails {
  return {
    number: ref.number,
    title: ref.title,
    url: `https://github.test/pull/${ref.number}`,
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: ref.headRef,
    headRefOid: ref.headSha,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    reviewDecision: "",
    author: "author",
    body: "",
    checks: [],
    comments: [],
    commits: [],
    files: [],
    reviewers: [],
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    staging: null,
  };
}

function harness() {
  let now = 1_000;
  let generation = 0;
  let restBackoffUntil = 0;
  let details = prDetails({
    number: 42,
    headRef: "feature",
    headSha: "head-a",
    title: "Feature",
  });
  let state: GithubPrState = {
    prNumber: 42,
    headRef: "feature",
    reviewedShas: [],
    updatedAt: new Date(now).toISOString(),
  };
  let reviewCalls = 0;
  let resolveCalls = 0;
  let runReview: (ref: PrRef) => Promise<ReviewResult | null> = async (ref) => {
    reviewCalls += 1;
    if (!state.reviewedShas.includes(ref.headSha))
      state.reviewedShas.push(ref.headSha);
    return { findings: 0, blocking: 0 };
  };

  type FakeTimer = {
    callback: () => void;
    cleared: boolean;
    ran: boolean;
    unref: () => void;
  };
  const timers: FakeTimer[] = [];
  const setTimer = ((callback: () => void) => {
    const timer: FakeTimer = {
      callback,
      cleared: false,
      ran: false,
      unref() {},
    };
    timers.push(timer);
    return timer;
  }) as unknown as typeof setTimeout;
  const clearTimer = ((timer: FakeTimer) => {
    timer.cleared = true;
  }) as unknown as typeof clearTimeout;

  const scheduler = new DesiredReviewScheduler(
    {
      readState: () => state,
      updateState: (_number, _headRef, patch) => {
        patch(state);
        return state;
      },
      updateStateIf: (_number, _headRef, patch) => {
        patch(state);
        return state;
      },
      resolvePr: async () => {
        resolveCalls += 1;
        return details;
      },
      runReview: (ref) => runReview(ref),
      isReviewLocked: () => false,
      restBackoffUntil: () => restBackoffUntil,
      setTimer,
      clearTimer,
      now: () => now,
      newGeneration: () => `generation-${++generation}`,
      log: () => {},
      logError: () => {},
    },
    {
      debounceMs: 100,
      maxWaitMs: 500,
      retryBaseMs: 10,
      retryMaxMs: 80,
      maxAttempts: 3,
      restoreStaggerMs: 0,
    },
  );

  async function runNextTimer(): Promise<void> {
    const timer = timers.find(
      (candidate) => !candidate.cleared && !candidate.ran,
    );
    if (!timer) throw new Error("No pending timer");
    timer.ran = true;
    timer.callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return {
    scheduler,
    get state() {
      return state;
    },
    get reviewCalls() {
      return reviewCalls;
    },
    get resolveCalls() {
      return resolveCalls;
    },
    setNow(value: number) {
      now = value;
    },
    setDetails(value: PrAutomationDetails) {
      details = value;
    },
    setRestBackoff(value: number) {
      restBackoffUntil = value;
    },
    setRunReview(value: typeof runReview) {
      runReview = value;
    },
    runNextTimer,
  };
}

const HEAD_A: PrRef = {
  number: 42,
  headRef: "feature",
  headSha: "head-a",
  title: "Feature",
};

const HEAD_B: PrRef = { ...HEAD_A, headSha: "head-b" };

describe("DesiredReviewScheduler", () => {
  test("restores and canonicalizes a stale persisted head before model work", async () => {
    const h = harness();
    h.state.pendingReview = {
      headRef: HEAD_A.headRef,
      headSha: HEAD_A.headSha,
      title: HEAD_A.title,
      firstPushAt: new Date(100).toISOString(),
      dueAt: new Date(200).toISOString(),
    };
    h.scheduler.restore([h.state]);
    h.setDetails(prDetails(HEAD_B));

    await h.runNextTimer();
    expect(h.reviewCalls).toBe(0);
    expect(h.state.pendingReview).toMatchObject({
      phase: "queued",
      headSha: "head-b",
      attempts: 0,
    });

    await h.runNextTimer();
    expect(h.reviewCalls).toBe(1);
    expect(h.state.reviewedShas).toContain("head-b");
    expect(h.state.pendingReview).toBeUndefined();
  });

  test("keeps transient review errors queued", async () => {
    const h = harness();
    h.setRunReview(async () => ({
      findings: 0,
      blocking: 0,
      error: "temporary",
    }));
    h.scheduler.admit(HEAD_A);

    await h.runNextTimer();
    expect(h.state.pendingReview).toMatchObject({
      phase: "queued",
      headSha: "head-a",
      attempts: 1,
      lastError: "temporary",
    });
  });

  test("a push during a running review starts a fresh generation", async () => {
    const h = harness();
    let finishReview!: (result: ReviewResult | null) => void;
    h.setRunReview(
      () =>
        new Promise((resolve) => {
          finishReview = resolve;
        }),
    );
    h.scheduler.admit(HEAD_A);
    await h.runNextTimer();
    expect(h.state.pendingReview).toMatchObject({
      phase: "running",
      attempts: 1,
    });

    h.setNow(9_000);
    h.scheduler.admit(HEAD_B);
    const newer = h.state.pendingReview;
    expect(newer).toMatchObject({
      phase: "queued",
      headSha: "head-b",
      attempts: 0,
    });
    expect(Date.parse(newer!.firstPushAt)).toBe(9_000);

    finishReview({ findings: 0, blocking: 0, error: "superseded" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.state.pendingReview?.headSha).toBe("head-b");
  });

  test("waits out the shared REST backoff without spending an attempt", async () => {
    const h = harness();
    h.setRestBackoff(20_000);
    h.scheduler.admit(HEAD_A);

    await h.runNextTimer();
    expect(h.resolveCalls).toBe(0);
    expect(h.state.pendingReview).toMatchObject({
      phase: "queued",
      attempts: 0,
    });
    expect(Date.parse(h.state.pendingReview!.dueAt)).toBe(20_000);
  });
});
