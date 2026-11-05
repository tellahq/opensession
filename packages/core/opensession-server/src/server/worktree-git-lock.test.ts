import { describe, expect, test } from "bun:test";
import { withGitLock } from "./worktree";

describe("withGitLock", () => {
  test("a busy repository does not hold up another repository", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const blocker = withGitLock("/repos/acme-app", () => held);

    let otherRan = false;
    await withGitLock("/repos/acme-api", async () => {
      otherRan = true;
    });
    expect(otherRan).toBe(true);
    release();
    await blocker;
  });

  test("operations on one repository run one at a time, in order", async () => {
    const events: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = withGitLock("/repos/acme-app", async () => {
      events.push("first:start");
      await held;
      events.push("first:end");
    });
    const second = withGitLock("/repos/acme-app", async () => {
      events.push("second");
    });
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  test("a failed operation does not block the next one", async () => {
    await expect(
      withGitLock("/repos/acme-app", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withGitLock("/repos/acme-app", async () => 7)).toBe(7);
  });
});
