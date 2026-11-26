import { afterEach, describe, expect, test } from "bun:test";
import { parentWatchPlan, startParentWatch } from "./parent-watch";

let watch: { stop(): void } | null = null;
afterEach(() => {
  watch?.stop();
  watch = null;
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ending with the program that started the server", () => {
  test("does nothing unless a parent pid is named", () => {
    expect(parentWatchPlan({})).toBe(null);
    expect(parentWatchPlan({ OPENSESSION_EXIT_WITH_PARENT: "1" })).toBe(null);
    expect(parentWatchPlan({ OPENSESSION_EXIT_WITH_PARENT: "yes" })).toBe(null);
    expect(parentWatchPlan({ OPENSESSION_EXIT_WITH_PARENT: "4242" })).toEqual({
      pid: 4242,
      delayMs: 0,
    });
    expect(
      parentWatchPlan({
        OPENSESSION_EXIT_WITH_PARENT: "4242",
        OPENSESSION_EXIT_WITH_PARENT_DELAY_MS: "1500",
      }),
    ).toEqual({ pid: 4242, delayMs: 1500 });
    let ended = 0;
    expect(startParentWatch({ env: {}, end: () => ended++, everyMs: 5 })).toBe(
      null,
    );
  });

  test("shuts down once, when the parent is no longer the one named", async () => {
    let parent = 4242;
    let ended = 0;
    watch = startParentWatch({
      env: { OPENSESSION_EXIT_WITH_PARENT: "4242" },
      parent: () => parent,
      end: () => ended++,
      everyMs: 5,
    });
    await wait(40);
    expect(ended).toBe(0);
    // What an orphan sees: it now belongs to the system's first process.
    parent = 1;
    await wait(40);
    expect(ended).toBe(1);
    await wait(40);
    expect(ended).toBe(1);
  });

  test("can hold the shutdown back for a process others depend on", async () => {
    let parent = 4242;
    let ended = 0;
    watch = startParentWatch({
      env: {
        OPENSESSION_EXIT_WITH_PARENT: "4242",
        OPENSESSION_EXIT_WITH_PARENT_DELAY_MS: "120",
      },
      parent: () => parent,
      end: () => ended++,
      everyMs: 5,
    });
    parent = 1;
    await wait(60);
    expect(ended).toBe(0);
    await wait(150);
    expect(ended).toBe(1);
  });
});
