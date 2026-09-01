import { afterEach, describe, expect, test } from "bun:test";
import { emitSessionStateChange } from "./session-state-events";
import {
  startSessionListRuntimeSync,
  stopSessionListRuntimeSync,
} from "./session-list-runtime-sync";

afterEach(() => stopSessionListRuntimeSync());

describe("session list runtime sync", () => {
  test("invalidates the global list when a room-scoped run settles", async () => {
    let invalidations = 0;
    startSessionListRuntimeSync(() => invalidations++);

    emitSessionStateChange({ sessionId: "session-1", isRunning: true, at: 1 });
    emitSessionStateChange({ sessionId: "session-1", isRunning: true, at: 1 });
    expect(invalidations).toBe(0);
    await Promise.resolve();
    expect(invalidations).toBe(1);

    emitSessionStateChange({ sessionId: "session-1", isRunning: false, at: 2 });
    emitSessionStateChange({ sessionId: "session-1", isRunning: false, at: 2 });
    await Promise.resolve();
    expect(invalidations).toBe(2);
  });

  test("starts only one listener", async () => {
    let first = 0;
    let second = 0;
    startSessionListRuntimeSync(() => first++);
    startSessionListRuntimeSync(() => second++);

    emitSessionStateChange({ sessionId: "session-1", isRunning: false, at: 1 });
    await Promise.resolve();

    expect(first).toBe(1);
    expect(second).toBe(0);
  });
});
