import { describe, expect, test } from "bun:test";
import {
  onPendingSessionFork,
  setPendingSessionFork,
  takePendingSessionFork,
} from "./pending-session-fork";

describe("pending session fork", () => {
  test("carries a message target across navigation exactly once", () => {
    setPendingSessionFork("session-a", "message-1");
    expect(takePendingSessionFork("session-a")).toEqual({
      kind: "message",
      messageId: "message-1",
    });
    expect(takePendingSessionFork("session-a")).toBeNull();
  });

  test("carries a current-tip target when no message is provided", () => {
    setPendingSessionFork("session-a");
    expect(takePendingSessionFork("session-a")).toEqual({ kind: "tip" });
  });

  test("keeps simultaneous session intents separate", () => {
    setPendingSessionFork("session-a", "message-a");
    setPendingSessionFork("session-b");
    expect(takePendingSessionFork("session-b")).toEqual({ kind: "tip" });
    expect(takePendingSessionFork("session-a")).toEqual({
      kind: "message",
      messageId: "message-a",
    });
  });

  test("notifies an already-open viewer", () => {
    const seen: string[] = [];
    const unsubscribe = onPendingSessionFork((sessionId) =>
      seen.push(sessionId),
    );
    setPendingSessionFork("session-a");
    unsubscribe();
    setPendingSessionFork("session-b");
    expect(seen).toEqual(["session-a"]);
    takePendingSessionFork("session-a");
    takePendingSessionFork("session-b");
  });
});
