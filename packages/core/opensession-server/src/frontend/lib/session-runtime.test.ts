import { describe, expect, test } from "bun:test";
import type { SessionSafetyState } from "./types";
import {
  initialSessionRuntimeState,
  reduceSessionRuntimeFrame,
  sessionRuntimeReducer,
} from "./session-runtime";

const usage = {
  costUsd: 0.25,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 10,
  cacheCreationTokens: 5,
  contextTokens: 120,
  contextWindow: 200_000,
  turns: 1,
  updatedAt: "2026-08-24T12:00:00.000Z",
};

function state() {
  return initialSessionRuntimeState({
    isRunning: false,
    safety: undefined,
    model: "claude-sonnet",
    usage: undefined,
  });
}

describe("reduceSessionRuntimeFrame", () => {
  test("tracks run status and clears stale streaming state", () => {
    const streaming = reduceSessionRuntimeFrame(state(), {
      type: "stream_start",
      sessionId: "session-1",
    });
    expect(streaming.isStreaming).toBe(true);

    const stopped = reduceSessionRuntimeFrame(streaming, {
      type: "session_status",
      sessionId: "session-1",
      isRunning: false,
    });
    expect(stopped.isRunningLive).toBe(false);
    expect(stopped.isStreaming).toBe(false);

    const safety: SessionSafetyState = {
      status: "paused_for_safety",
      explanation: "The previous operation may have completed.",
      automaticReconciliationRunning: false,
      pausedAt: "2026-08-24T12:00:00.000Z",
      operation: "send prompt",
      repairAvailable: true,
    };
    const paused = reduceSessionRuntimeFrame(stopped, {
      type: "session_status",
      sessionId: "session-1",
      isRunning: true,
      safety,
    });
    expect(paused).toMatchObject({
      isRunningLive: false,
      isStreaming: false,
      safety,
    });
  });

  test("updates queue receipts without replacing a queue during drag", () => {
    const first = reduceSessionRuntimeFrame(state(), {
      type: "queue_update",
      sessionId: "session-1",
      queued: [{ id: "queued-1", content: "First" }],
      steered: [{ id: "steered-1", content: "Now" }],
      pendingDeliveryIds: ["entry-1"],
    });
    const dragged = reduceSessionRuntimeFrame(
      first,
      {
        type: "queue_update",
        sessionId: "session-1",
        queued: [{ id: "queued-2", content: "Second" }],
        steered: [],
        pendingDeliveryIds: [],
      },
      false,
    );
    expect(dragged.queued).toBe(first.queued);
    expect(dragged.steered).toEqual([]);
    expect(dragged.pendingDeliveryIds).toEqual([]);
  });

  test("retires only the matching ask", () => {
    const asking = reduceSessionRuntimeFrame(state(), {
      type: "ask_question",
      sessionId: "session-1",
      questionId: "ask-1",
      questions: [{ question: "Ship it?" }],
    });
    const other = reduceSessionRuntimeFrame(asking, {
      type: "ask_resolved",
      sessionId: "session-1",
      questionId: "ask-2",
    });
    expect(other).toBe(asking);

    expect(
      reduceSessionRuntimeFrame(other, {
        type: "ask_resolved",
        sessionId: "session-1",
        questionId: "ask-1",
      }).ask,
    ).toBeNull();
  });

  test("accepts live model and usage updates", () => {
    const changed = reduceSessionRuntimeFrame(state(), {
      type: "model_changed",
      sessionId: "session-1",
      model: "gpt-5",
    });
    expect(changed.model).toBe("gpt-5");
    expect(
      reduceSessionRuntimeFrame(changed, {
        type: "usage_update",
        sessionId: "session-1",
        usage,
      }).usage,
    ).toEqual(usage);
  });
});

describe("sessionRuntimeReducer", () => {
  test("preserves local optimistic and reset transitions", () => {
    const running = sessionRuntimeReducer(state(), { type: "mark_running" });
    expect(running.isRunningLive).toBe(true);

    const selected = sessionRuntimeReducer(running, {
      type: "select_model",
      model: "gpt-5",
    });
    expect(selected.model).toBe("gpt-5");

    expect(
      sessionRuntimeReducer(selected, {
        type: "reset_live",
        isRunning: false,
      }),
    ).toMatchObject({
      isRunningLive: false,
      isStreaming: false,
      pendingDeliveryIds: [],
      model: "gpt-5",
    });
  });
});
