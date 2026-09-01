import { describe, expect, test } from "bun:test";
import {
  cancelDeferredMerge,
  cancelDeferredMergeByKey,
  deferredMergeKey,
  deferredMergePhase,
  MERGE_UNDO_DELAY_MS,
  scheduleDeferredMerge,
} from "./deferred-merge";
import { undoLatestAction } from "./undo";

const waitForTimer = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("deferred merge", () => {
  test("uses a five-second undo window", () => {
    expect(MERGE_UNDO_DELAY_MS).toBe(5000);
  });

  test("waits, runs once, and stays busy until the merge settles", async () => {
    let finish!: () => void;
    let calls = 0;
    const handle = scheduleDeferredMerge(
      "pr:one",
      () =>
        new Promise<void>((resolve) => {
          calls++;
          finish = resolve;
        }),
      0,
    );

    expect(handle).not.toBeNull();
    expect(deferredMergePhase("pr:one")).toBe("scheduled");
    await waitForTimer();
    expect(calls).toBe(1);
    expect(deferredMergePhase("pr:one")).toBe("running");

    finish();
    await waitForTimer();
    expect(deferredMergePhase("pr:one")).toBe("idle");
  });

  test("undo prevents the merge and a stale undo cannot cancel a newer one", () => {
    let calls = 0;
    const first = scheduleDeferredMerge("pr:two", () => calls++, 1000)!;
    expect(cancelDeferredMerge(first)).toBe(true);
    expect(deferredMergePhase("pr:two")).toBe("idle");

    const second = scheduleDeferredMerge("pr:two", () => calls++, 1000)!;
    expect(cancelDeferredMerge(first)).toBe(false);
    expect(deferredMergePhase("pr:two")).toBe("scheduled");
    expect(cancelDeferredMerge(second)).toBe(true);
    expect(calls).toBe(0);
  });

  test("lets any control for the PR undo the current schedule", () => {
    let calls = 0;
    scheduleDeferredMerge("pr:shared", () => calls++, 1000);
    expect(cancelDeferredMergeByKey("pr:shared")).toBe(true);
    expect(deferredMergePhase("pr:shared")).toBe("idle");
    expect(calls).toBe(0);
  });

  test("links the visible merge Undo to the app-wide shortcut", () => {
    let calls = 0;
    scheduleDeferredMerge("pr:shortcut", () => calls++, 1000);

    expect(undoLatestAction()).toBe(true);
    expect(deferredMergePhase("pr:shortcut")).toBe("idle");
    expect(calls).toBe(0);
  });

  test("deduplicates one PR while allowing another PR", () => {
    const first = scheduleDeferredMerge("pr:three", () => undefined, 1000)!;
    expect(scheduleDeferredMerge("pr:three", () => undefined, 1000)).toBeNull();
    const other = scheduleDeferredMerge("pr:four", () => undefined, 1000)!;
    expect(deferredMergePhase("pr:three")).toBe("scheduled");
    expect(deferredMergePhase("pr:four")).toBe("scheduled");
    cancelDeferredMerge(first);
    cancelDeferredMerge(other);
  });

  test("clears a failed merge so it can be retried", async () => {
    scheduleDeferredMerge(
      "pr:five",
      async () => {
        throw new Error("failed");
      },
      0,
    );
    await waitForTimer();
    expect(deferredMergePhase("pr:five")).toBe("idle");
  });

  test("normalizes the PR URL shared by every surface", () => {
    expect(
      deferredMergeKey(
        "https://github.com/tellahq/opensession/pull/123/?tab=files",
      ),
    ).toBe("pr:https://github.com/tellahq/opensession/pull/123");
  });
});
