import { describe, expect, test } from "bun:test";
import {
  setPendingSessionFork,
  takePendingSessionFork,
} from "./pending-session-fork";

describe("pending session fork", () => {
  test("carries a fork across navigation exactly once", () => {
    setPendingSessionFork("session-a", "message-1");
    expect(takePendingSessionFork("session-a")).toBe("message-1");
    expect(takePendingSessionFork("session-a")).toBeNull();
  });

  test("keeps simultaneous session intents separate", () => {
    setPendingSessionFork("session-a", "message-a");
    setPendingSessionFork("session-b", "message-b");
    expect(takePendingSessionFork("session-b")).toBe("message-b");
    expect(takePendingSessionFork("session-a")).toBe("message-a");
  });
});
