import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "./types";
import type { OptimisticPendingPrompt } from "./pending-reconcile";
import type { PromptOutboxItem } from "./prompt-outbox";
import { deriveSessionQueue, type QueueReceipt } from "./session-queue";

const NOW = Date.parse("2026-08-18T12:00:00.000Z");

function derive(
  overrides: Partial<{
    queued: QueueReceipt[];
    steered: QueueReceipt[];
    pending: OptimisticPendingPrompt[];
    pendingDeliveryIds: string[];
    outboxItems: PromptOutboxItem[];
    landedOutboxIds: Set<string>;
    entries: TranscriptEntry[];
    settingUpWorkspace: boolean;
  }> = {},
) {
  return deriveSessionQueue({
    queued: [],
    steered: [],
    pending: [],
    pendingDeliveryIds: [],
    outboxItems: [],
    landedOutboxIds: new Set(),
    entries: [],
    settingUpWorkspace: false,
    now: NOW,
    ...overrides,
  });
}

function pending(
  id: string,
  busyMode?: OptimisticPendingPrompt["busyMode"],
): OptimisticPendingPrompt {
  return {
    id,
    content: id,
    user: "Jaap",
    sentAt: NOW,
    transcriptAfterEntryId: null,
    busyMode,
  };
}

function outbox(
  clientId: string,
  state: PromptOutboxItem["state"],
): PromptOutboxItem {
  return {
    clientId,
    sessionId: "session-1",
    content: clientId,
    state,
    attempts: state === "failed" ? 1 : 0,
    createdAt: NOW,
    nextAttemptAt: NOW,
  };
}

describe("deriveSessionQueue", () => {
  test("classifies queued traffic and builds its summary", () => {
    const result = derive({
      queued: [
        { id: "message", content: "Please continue", user: "Jaap" },
        {
          id: "review",
          content:
            "<!--os:review-handoff-->\n🔍 This session's PR #42 has feedback",
          user: "GitHub",
        },
      ],
    });

    expect(result.queueCount).toBe(2);
    expect(result.shownQueued).toHaveLength(2);
    expect(result.queueTitle).toContain("1 message queued");
    expect(result.queueTitle).toContain("1 PR review waiting");
  });

  test("keeps steers in the transcript and deliberate queues above the composer", () => {
    const result = derive({
      pending: [pending("steer", "steer"), pending("queue", "queue")],
      pendingDeliveryIds: ["existing"],
    });

    expect(result.pendingQueue.map((item) => item.id)).toEqual(["queue"]);
    expect(result.pendingBubbles.map((item) => item.id)).toEqual(["steer"]);
    expect(result.optimisticTranscriptEntries.map((item) => item.id)).toEqual([
      "steer",
    ]);
    expect(result.optimisticTranscriptEntries[0]?.sender).toBe("Jaap");
    expect(result.pendingTranscriptDeliveryIds).toEqual(["existing", "steer"]);
  });

  test("shows failed outbox items but projects pristine sends into the transcript", () => {
    const result = derive({
      outboxItems: [outbox("fresh", "pending"), outbox("failed", "failed")],
    });

    expect(result.pendingBubbles.map((item) => item.id)).toEqual([
      "outbox-fresh",
    ]);
    expect(result.durableOutbox.map((item) => item.clientId)).toEqual([
      "failed",
    ]);
    expect(result.queueCount).toBe(1);
  });
});
