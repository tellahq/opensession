import { describe, expect, test } from "bun:test";
import {
  beginPromptDispatch,
  promptDispatches,
  promptQueues,
  queueDisplayState,
} from "./queue-state";
import {
  takePendingPromptForEdit,
  withdrawablePendingPrompt,
  withdrawPendingPrompt,
} from "./withdraw-pending-prompt";

describe("withdrawing a message no run picked up", () => {
  test("removes the accepted message from delivery", async () => {
    const sessionId = `withdraw-${crypto.randomUUID()}`;
    try {
      await promptQueues.set(sessionId, [
        { id: "stuck", content: "are you there", promptEntryId: "entry-1" },
        { id: "later", content: "queued after" },
      ]);
      expect((await queueDisplayState(sessionId)).pendingDeliveryIds).toEqual([
        "entry-1",
      ]);

      expect(await withdrawPendingPrompt({ id: sessionId }, "entry-1")).toBe(
        true,
      );
      expect(promptQueues.get(sessionId)?.map((item) => item.id)).toEqual([
        "later",
      ]);
      expect(
        (await queueDisplayState(sessionId)).pendingDeliveryIds,
      ).toBeUndefined();
    } finally {
      await promptQueues.delete(sessionId);
    }
  });

  test("leaves a queued message that is not in the conversation yet", async () => {
    const sessionId = `withdraw-queued-${crypto.randomUUID()}`;
    try {
      await promptQueues.set(sessionId, [{ id: "plain", content: "later" }]);
      expect(withdrawablePendingPrompt(sessionId, "plain")).toBeNull();
      expect(await withdrawPendingPrompt({ id: sessionId }, "plain")).toBe(
        false,
      );
      expect(promptQueues.get(sessionId)).toHaveLength(1);
    } finally {
      await promptQueues.delete(sessionId);
    }
  });

  test("keeps a message already on its way to the engine", async () => {
    const sessionId = `withdraw-dispatch-${crypto.randomUUID()}`;
    try {
      await beginPromptDispatch(
        sessionId,
        [{ id: "sent", content: "in flight", promptEntryId: "entry-2" }],
        "entry-2",
        false,
      );
      expect(await withdrawPendingPrompt({ id: sessionId }, "entry-2")).toBe(
        false,
      );
      expect(promptDispatches.get(sessionId)?.promptEntryId).toBe("entry-2");
    } finally {
      await promptDispatches.delete(sessionId);
    }
  });

  test("hands your own waiting message back for editing, not someone else's", async () => {
    const sessionId = `withdraw-edit-${crypto.randomUUID()}`;
    try {
      await promptQueues.set(sessionId, [
        {
          id: "mine",
          content: "fix the typo",
          user: "Acme Dev",
          promptEntryId: "entry-3",
        },
      ]);
      expect(
        await takePendingPromptForEdit({ id: sessionId }, "entry-3", "Other"),
      ).toBeUndefined();
      expect(promptQueues.get(sessionId)).toHaveLength(1);

      const taken = await takePendingPromptForEdit(
        { id: sessionId },
        "entry-3",
        "Acme Dev",
      );
      expect(taken?.content).toBe("fix the typo");
      expect(promptQueues.has(sessionId)).toBe(false);
    } finally {
      await promptQueues.delete(sessionId);
    }
  });
});
