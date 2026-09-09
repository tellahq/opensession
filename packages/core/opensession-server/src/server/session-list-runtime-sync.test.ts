import { afterEach, describe, expect, test } from "bun:test";
import { emitSessionStateChange } from "./session-state-events";
import {
  startSessionListRuntimeSync,
  stopSessionListRuntimeSync,
} from "./session-list-runtime-sync";

afterEach(() => stopSessionListRuntimeSync());

describe("session list runtime sync", () => {
  test("publishes the changed row once per session when a run starts or settles", async () => {
    const published: string[] = [];
    startSessionListRuntimeSync((id) => published.push(id));

    emitSessionStateChange({ sessionId: "session-1", isRunning: true, at: 1 });
    emitSessionStateChange({ sessionId: "session-1", isRunning: true, at: 1 });
    emitSessionStateChange({ sessionId: "session-2", isRunning: true, at: 1 });
    expect(published).toEqual([]);
    await Promise.resolve();
    expect(published).toEqual(["session-1", "session-2"]);

    emitSessionStateChange({ sessionId: "session-1", isRunning: false, at: 2 });
    emitSessionStateChange({ sessionId: "session-1", isRunning: false, at: 2 });
    await Promise.resolve();
    expect(published).toEqual(["session-1", "session-2", "session-1"]);
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
