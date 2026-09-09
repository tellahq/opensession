import { describe, expect, test } from "bun:test";
import {
  creationWaiterCountForTest,
  notifyCreationStateChanged,
  requestSessionKernelRuntimeDrain,
  setSessionKernelRuntimeDrainRequest,
  waitForCreationStateChange,
} from "./wakes";

describe("session kernel wakes", () => {
  test("a creation wait resolves on notify and forgets its waiter", async () => {
    const started = Date.now();
    const wait = waitForCreationStateChange("wake-session", 10_000);
    expect(creationWaiterCountForTest("wake-session")).toBe(1);
    notifyCreationStateChanged("wake-session");
    await wait;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(creationWaiterCountForTest("wake-session")).toBe(0);
  });

  test("a creation wait falls back to its interval without a notify", async () => {
    const started = Date.now();
    await waitForCreationStateChange("silent-session", 15);
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
    expect(creationWaiterCountForTest("silent-session")).toBe(0);
  });

  test("notify only wakes waiters on that session", async () => {
    let otherWoke = false;
    const other = waitForCreationStateChange("other-session", 60).then(() => {
      otherWoke = true;
    });
    const mine = waitForCreationStateChange("mine-session", 10_000);
    notifyCreationStateChanged("mine-session");
    await mine;
    expect(otherWoke).toBe(false);
    await other;
  });

  test("a drain request is a no-op until the runtime installs one", () => {
    setSessionKernelRuntimeDrainRequest(undefined);
    expect(() => requestSessionKernelRuntimeDrain()).not.toThrow();
    let requests = 0;
    setSessionKernelRuntimeDrainRequest(() => {
      requests += 1;
    });
    try {
      requestSessionKernelRuntimeDrain();
      expect(requests).toBe(1);
    } finally {
      setSessionKernelRuntimeDrainRequest(undefined);
    }
  });
});
