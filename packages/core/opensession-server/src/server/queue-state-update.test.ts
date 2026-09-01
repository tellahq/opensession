import { beforeEach, describe, expect, test } from "bun:test";
import { classifyEntry } from "@tellahq/opensession-protocol/notices";
import {
  acknowledgePromptDispatch,
  acknowledgeSteerDelivery,
  beginNextPromptDispatch,
  beginPromptDispatch,
  clientVisibleQueuedCount,
  isDelegatedQueueItem,
  isEditableQueueItem,
  isWorkerQueueItem,
  preparePromptInterrupt,
  isWorkflowQueueItem,
  promptDispatches,
  promptQueues,
  promoteQueuedPrompt,
  queueDisplayState,
  recoverUnownedPromptDispatch,
  steeredReceipts,
  settlePromptInterrupt,
  takeQueuedPrompt,
  takeSteeredPrompt,
  undeliveredSteers,
} from "./queue-state";
import { AUTO_CONTINUE_USER } from "./auto-continue";
import { agentActor, workerActor } from "./session-actors";

const SESSION = "os-queue-state-update-test";
const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("unowned prompt dispatch recovery", () => {
  test("restores an ordinary dispatch ahead of a later queued message", async () => {
    const sessionId = `unowned-dispatch-${crypto.randomUUID()}`;
    const first = { id: "first", content: "retry me" };
    try {
      await promptQueues.set(sessionId, [first]);
      await beginPromptDispatch(
        sessionId,
        [first],
        "first-entry",
        false,
        undefined,
        true,
      );
      await promptQueues.set(sessionId, [{ id: "later", content: "later" }]);

      expect(await recoverUnownedPromptDispatch(sessionId, () => false)).toBe(
        true,
      );
      expect(promptQueues.get(sessionId)?.map((item) => item.id)).toEqual([
        "first",
        "later",
      ]);
      expect(promptDispatches.has(sessionId)).toBe(false);
    } finally {
      await promptQueues.delete(sessionId);
      await promptDispatches.delete(sessionId);
    }
  });

  test("preserves dispatches with a live owner", async () => {
    const sessionId = `owned-dispatch-${crypto.randomUUID()}`;
    try {
      await beginPromptDispatch(
        sessionId,
        [{ id: "owned", content: "in flight" }],
        "owned-entry",
        false,
      );

      expect(await recoverUnownedPromptDispatch(sessionId, () => true)).toBe(
        false,
      );
      expect(promptDispatches.get(sessionId)?.promptEntryId).toBe(
        "owned-entry",
      );
    } finally {
      await promptDispatches.delete(sessionId);
    }
  });

  test("leaves creation dispatches to their durable creation owner", async () => {
    const sessionId = `create-dispatch-${crypto.randomUUID()}`;
    try {
      await beginPromptDispatch(
        sessionId,
        [{ id: "opening", content: "open" }],
        "opening-entry",
        false,
        "create",
      );

      expect(await recoverUnownedPromptDispatch(sessionId, () => false)).toBe(
        false,
      );
      expect(promptDispatches.get(sessionId)?.kind).toBe("create");
    } finally {
      await promptDispatches.delete(sessionId);
    }
  });
});

test("sent queue fallbacks stay in chat and pending until exact engine acknowledgement", async () => {
  const item = {
    id: "sent-steer",
    promptEntryId: "sent-steer",
    content: "read this next",
    user: "Kent",
  };
  await promptQueues.set(SESSION, [
    { id: "ordinary", content: "later" },
    { id: item.id, content: item.content, user: item.user },
  ]);
  await promoteQueuedPrompt(SESSION, item.id, item.promptEntryId, item);

  expect(promptQueues.get(SESSION)?.map((entry) => entry.id)).toEqual([
    "sent-steer",
    "ordinary",
  ]);
  expect(clientVisibleQueuedCount(SESSION)).toBe(1);
  expect(await queueDisplayState(SESSION)).toEqual({
    queued: [{ id: "ordinary", content: "later", editable: false }],
    steered: [],
    pendingDeliveryIds: ["sent-steer"],
  });
  // The early transcript row is a sent receipt, not evidence that the engine
  // crossed its delivery boundary.
  expect(undeliveredSteers([item], ["[Kent] read this next"])).toEqual([item]);
});
describe("takeQueuedPrompt", () => {
  beforeEach(async () => {
    await promptDispatches.clear();
    await promptQueues.set(SESSION, [
      {
        id: "q1",
        content: "first",
        user: "Kent",
        images: [PNG],
        files: [{ name: "brief.pdf", path: "/tmp/brief.pdf" }],
      },
      { id: "q2", content: "second", user: "Michiel" },
    ]);
  });

  test("selects and claims through the compatibility actor store", async () => {
    const interruptId = await preparePromptInterrupt(
      SESSION,
      "q2",
      SESSION,
      "q2",
    );
    expect(await preparePromptInterrupt(SESSION, "q2", SESSION, "q2")).toBe(
      interruptId,
    );
    await expect(
      preparePromptInterrupt(SESSION, "q2", "another-dispatch", "q2"),
    ).rejects.toThrow("reused with another payload");
    await settlePromptInterrupt(SESSION, interruptId, "confirmed");
    const claim = await beginNextPromptDispatch(
      SESSION,
      { stillWorking: true },
      false,
    );
    expect(claim).toMatchObject({
      kind: "deliver",
      batch: [{ id: "q2", content: "second", user: "Michiel" }],
    });
    expect(promptQueues.get(SESSION)).toEqual([
      {
        id: "q1",
        content: "first",
        user: "Kent",
        images: [PNG],
        files: [{ name: "brief.pdf", path: "/tmp/brief.pdf" }],
      },
    ]);
  });

  test("prepares an interrupt from an already-steered receipt", async () => {
    await promptQueues.delete(SESSION);
    await steeredReceipts.set(SESSION, [
      { id: "steered", content: "accepted but unread", hold: true },
    ]);
    const interruptId = await preparePromptInterrupt(
      SESSION,
      "steered",
      SESSION,
      "steered",
    );
    expect(promptQueues.get(SESSION)).toMatchObject([{ id: "steered" }]);
    expect(steeredReceipts.get(SESSION)).toBeUndefined();
    await settlePromptInterrupt(SESSION, interruptId, "confirmed");
    expect(
      await beginNextPromptDispatch(SESSION, { stillWorking: true }, false),
    ).toMatchObject({
      kind: "deliver",
      interrupted: true,
      batch: [{ id: "steered" }],
    });
  });

  test("keeps a selected prompt durable until the runner acknowledges it", async () => {
    const promptEntryId = await beginPromptDispatch(
      SESSION,
      [{ id: "q1", content: "first", user: "Kent" }],
      "entry-1",
      false,
    );
    expect(promptEntryId).toBe("entry-1");
    expect(promptDispatches.get(SESSION)).toEqual({
      promptEntryId: "entry-1",
      items: [{ id: "q1", content: "first", user: "Kent" }],
    });

    await acknowledgePromptDispatch(SESSION, "other-entry", false);
    expect(promptDispatches.has(SESSION)).toBe(true);
    await acknowledgePromptDispatch(SESSION, "entry-1", false);
    expect(promptDispatches.has(SESSION)).toBe(false);
  });

  test("atomically removes and returns the complete payload", async () => {
    expect(await takeQueuedPrompt(SESSION, "q1", "Kent", false)).toMatchObject({
      id: "q1",
      content: "first",
      images: [PNG],
      files: [{ name: "brief.pdf", path: "/tmp/brief.pdf" }],
    });
    expect(promptQueues.get(SESSION)?.map((item) => item.id)).toEqual(["q2"]);
  });

  test("only the original sender can take a row", async () => {
    expect(
      await takeQueuedPrompt(SESSION, "q1", "Michiel", false),
    ).toBeUndefined();
    expect(promptQueues.get(SESSION)?.map((item) => item.id)).toEqual([
      "q1",
      "q2",
    ]);
  });

  test("routed and context-carrying rows remain queue-owned", async () => {
    await promptQueues.set(SESSION, [
      {
        id: "q1",
        content: "Slack",
        user: "Kent",
        slackReplyTo: { channel: "C1", threadTs: "1" },
      },
      {
        id: "q2",
        content: "Context",
        user: "Kent",
        contextSessions: ["os-other"],
      },
    ]);
    expect(
      await takeQueuedPrompt(SESSION, "q1", "Kent", false),
    ).toBeUndefined();
    expect(
      await takeQueuedPrompt(SESSION, "q2", "Kent", false),
    ).toBeUndefined();
  });
});

describe("automated turns are not user messages", () => {
  test("keeps review work queued without exposing it to clients", async () => {
    await promptQueues.set(SESSION, [
      { id: "human", content: "Please fix this", user: "Kent" },
      {
        id: "review",
        content: "<!--os:review-handoff-->\nReview PR #42",
        user: "GitHub",
        reviewHandoff: true,
      },
    ]);

    expect(
      (await queueDisplayState(SESSION)).queued.map((item) => item.id),
    ).toEqual(["human"]);
    expect(clientVisibleQueuedCount(SESSION)).toBe(1);
    // Filtering is presentation-only. Dispatch still owns the handoff.
    expect(promptQueues.get(SESSION)?.map((item) => item.id)).toEqual([
      "human",
      "review",
    ]);
  });

  test("hides context-only system steers even without an auto-continue sender", async () => {
    const backgroundWait = {
      id: "background-wait",
      content:
        '<opensession:context source="background-wait">Continue after the timer.</opensession:context>',
    };
    await promptQueues.set(SESSION, [backgroundWait]);
    await steeredReceipts.set(SESSION, [backgroundWait]);

    expect(clientVisibleQueuedCount(SESSION)).toBe(0);
    expect(await queueDisplayState(SESSION)).toEqual({
      queued: [],
      steered: [],
    });
    // Presentation filtering must not remove the runner-owned delivery.
    expect(promptQueues.get(SESSION)).toEqual([backgroundWait]);
    expect(steeredReceipts.get(SESSION)).toEqual([backgroundWait]);
  });

  test("keeps auto-continues queued without exposing them to clients", async () => {
    const autoContinue = {
      id: "auto-continue",
      content: "<opensession:context>Continue working.</opensession:context>",
      user: AUTO_CONTINUE_USER,
    };
    await promptQueues.set(SESSION, [
      { id: "human", content: "Please continue", user: "Kent" },
      autoContinue,
    ]);
    await steeredReceipts.set(SESSION, [autoContinue]);

    expect(clientVisibleQueuedCount(SESSION)).toBe(1);
    expect(await queueDisplayState(SESSION)).toEqual({
      queued: [
        {
          id: "human",
          content: "Please continue",
          user: "Kent",
          editable: true,
        },
      ],
      steered: [],
    });
    // Filtering is presentation-only. Dispatch still owns the nudge.
    expect(promptQueues.get(SESSION)).toEqual([
      { id: "human", content: "Please continue", user: "Kent" },
      autoContinue,
    ]);
    expect(steeredReceipts.get(SESSION)).toEqual([autoContinue]);
  });
});

describe("steer delivery acknowledgement", () => {
  test("retires the exact receipt even when its context is absent from the transcript", async () => {
    await steeredReceipts.set(SESSION, [
      {
        id: "hidden",
        content:
          '<opensession:context source="background-wait">Continue.</opensession:context>',
      },
      { id: "human", content: "Keep this receipt", user: "Kent" },
    ]);

    expect(await acknowledgeSteerDelivery(SESSION, "hidden", false)).toBe(true);
    expect(steeredReceipts.get(SESSION)?.map((item) => item.id)).toEqual([
      "human",
    ]);
    expect(await acknowledgeSteerDelivery(SESSION, "missing", false)).toBe(
      false,
    );
  });
});

describe("takeSteeredPrompt", () => {
  beforeEach(async () => {
    await steeredReceipts.set(SESSION, [
      { id: "s1", content: "first", user: "Kent", images: [PNG] },
      { id: "s2", content: "same", user: "Kent" },
    ]);
  });

  test("removes one exact pending steer with its complete payload", async () => {
    expect(await takeSteeredPrompt(SESSION, "s1", "Kent", false)).toMatchObject(
      {
        id: "s1",
        content: "first",
        images: [PNG],
      },
    );
    expect(steeredReceipts.get(SESSION)?.map((item) => item.id)).toEqual([
      "s2",
    ]);
  });

  test("only the original sender can take a steer", async () => {
    expect(
      await takeSteeredPrompt(SESSION, "s1", "Michiel", false),
    ).toBeUndefined();
    expect(steeredReceipts.get(SESSION)?.map((item) => item.id)).toEqual([
      "s1",
      "s2",
    ]);
  });
});

describe("delegated messages are not user messages", () => {
  const WORKER = "os-019fe194-5fbe-7000-a81e-d0a656ad77f4";

  test("a worker's report to its parent is queue-owned, not editable", async () => {
    // It rides the same queue as human sends because it drives the parent's
    // next turn, but nobody typed it — so it gets none of the composer's
    // gestures, and no teammate can pull it back into their draft.
    const report = { id: "w1", content: "Done.", user: workerActor(WORKER) };
    expect(isWorkerQueueItem(report)).toBe(true);
    expect(isEditableQueueItem(report)).toBe(false);
  });

  test("a person's message stays editable", async () => {
    const mine = { id: "q1", content: "ship it", user: "Kent" };
    expect(isWorkerQueueItem(mine)).toBe(false);
    expect(isEditableQueueItem(mine)).toBe(true);
  });

  test("a workflow result never enters the client message surface", async () => {
    const workflowSession = `${SESSION}-workflow`;
    const result = {
      id: "workflow:wf-1:done",
      content: '<!--os:workflow-notice:wf-1-->\n✅ Workflow "review" finished',
      user: "Kent",
    };
    expect(isWorkflowQueueItem(result)).toBe(true);
    expect(isEditableQueueItem(result)).toBe(false);

    await promptQueues.set(workflowSession, [result]);
    await steeredReceipts.set(workflowSession, [result]);
    expect(clientVisibleQueuedCount(workflowSession)).toBe(0);
    expect(await queueDisplayState(workflowSession)).toEqual({
      queued: [],
      steered: [],
    });
    // Filtering is presentation-only: delivery still owns the nudge.
    expect(promptQueues.get(workflowSession)).toEqual([result]);
    expect(steeredReceipts.get(workflowSession)).toEqual([result]);
    await promptQueues.delete(workflowSession);
    await steeredReceipts.delete(workflowSession);
  });

  test("a peer agent message is delegated but not a worker report", async () => {
    const message = { content: "ping", user: agentActor(WORKER) };
    expect(isDelegatedQueueItem(message)).toBe(true);
    expect(isWorkerQueueItem(message)).toBe(false);
    expect(isEditableQueueItem(message)).toBe(false);
    expect(
      isWorkerQueueItem({ content: "worker looks stuck", user: "Kent" }),
    ).toBe(false);
  });

  test("the sender the queue keeps still classifies as a worker report", async () => {
    // The queue stores content and user separately; the UI reads them back
    // through the same classifier the transcript uses, so the two cannot
    // disagree about what a row is.
    const classified = classifyEntry({
      id: "",
      type: "user",
      content: `[${workerActor(WORKER)}] <!--os:worker-report-->\nDone.`,
      timestamp: "",
    });
    expect(classified.notice?.kind).toBe("worker-report");
    expect(classified.sender).toBeUndefined();
  });
});
