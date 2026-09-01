import { describe, expect, test } from "bun:test";
import {
  markReplayedCommandResult,
  replayedSessionCreatedResult,
} from "./command-replay";

describe("replayedSessionCreatedResult", () => {
  test("builds the replay response for a previously completed create", () => {
    expect(replayedSessionCreatedResult("os-old", "ws-old")).toEqual({
      type: "session_created",
      id: "os-old",
      workspaceId: "ws-old",
      replayed: true,
    });
    expect(replayedSessionCreatedResult("os-old")).toEqual({
      type: "session_created",
      id: "os-old",
      replayed: true,
    });
  });
});

describe("markReplayedCommandResult", () => {
  test("marks a duplicate session create result", () => {
    expect(
      markReplayedCommandResult({
        type: "session_created",
        id: "os-old",
        workspaceId: "ws-old",
      }),
    ).toEqual({
      type: "session_created",
      id: "os-old",
      workspaceId: "ws-old",
      replayed: true,
    });
  });

  test("leaves other stored command results unchanged", () => {
    const result = { status: "queued" };
    expect(markReplayedCommandResult(result)).toBe(result);
    expect(markReplayedCommandResult(undefined)).toBeUndefined();
  });
});
