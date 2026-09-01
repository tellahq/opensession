import { afterEach, describe, expect, test } from "bun:test";
import {
  deliveryQueueState,
  promptDispatches,
  promptQueues,
  steeredReceipts,
} from "../queue-state";

const sessionId = "delivery-adoption-test";

afterEach(() => {
  promptQueues.delete(sessionId);
  promptDispatches.delete(sessionId);
  steeredReceipts.delete(sessionId);
});

describe("durable delivery adoption", () => {
  test("recognizes the same delivery in every pre-journal state", () => {
    promptQueues.set(sessionId, [{ id: "d1", content: "queued" }]);
    expect(deliveryQueueState(sessionId, "d1")).toBe("queued");

    promptQueues.delete(sessionId);
    promptDispatches.set(sessionId, {
      promptEntryId: "entry",
      items: [{ id: "d1", content: "dispatching" }],
    });
    expect(deliveryQueueState(sessionId, "d1")).toBe("dispatching");

    promptDispatches.delete(sessionId);
    steeredReceipts.set(sessionId, [{ id: "d1", content: "steered" }]);
    expect(deliveryQueueState(sessionId, "d1")).toBe("steered");
  });
});
