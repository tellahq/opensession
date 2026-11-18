import { describe, expect, test } from "bun:test";
import {
  getPromptPending,
  observePromptFrame,
  sendPrPrompt,
} from "./pr-prompt-pending";
import type { WSClientMessage, WSServerMessage } from "./types";

const SESSION = "s-1";

async function press(key: string) {
  const sent: WSClientMessage[] = [];
  sendPrPrompt((msg) => sent.push(msg), {
    key,
    sessionId: SESSION,
    user: "acme",
    label: "Fixing…",
    headline: "failing",
    content: "Fix the checks",
  });
  // The prompt follows the button's morph.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const msg = sent[0];
  if (msg?.type !== "prompt" || !msg.requestId) throw new Error("no prompt");
  return msg.requestId;
}

function userEntry(id: string, sourceMessageIds?: string[]) {
  return {
    type: "transcript_append" as const,
    sessionId: SESSION,
    entries: [
      {
        id,
        type: "user" as const,
        content: "Fix the checks",
        timestamp: "2026-11-18T00:00:00Z",
        sourceMessageIds,
      },
    ],
  };
}

function queue(...ids: string[]) {
  return {
    type: "queue_update" as const,
    sessionId: SESSION,
    queued: ids.map((id) => ({ id, content: "Fix the checks" })),
  };
}

function steered(id: string) {
  return { ...queue(), steered: [{ id, content: "Fix the checks" }] };
}

function feedSnapshot(activePromptIds?: string[]) {
  const snapshot: Extract<WSServerMessage, { type: "feed_snapshot" }> = {
    type: "feed_snapshot",
    sessionId: SESSION,
    feedEpoch: "epoch-1",
    feedSeq: 1,
    active: null,
  };
  if (activePromptIds) snapshot.activePromptIds = activePromptIds;
  return snapshot;
}

const idle = {
  type: "session_status" as const,
  sessionId: SESSION,
  isRunning: false,
};

describe("PR prompt pending state", () => {
  test("a prompt queued behind another turn outlasts that turn", async () => {
    const requestId = await press("busy");
    observePromptFrame(SESSION, {
      type: "queue_update",
      sessionId: SESSION,
      queued: [{ id: requestId, content: "Fix the checks" }],
    });
    // The unrelated turn ahead of it ends.
    observePromptFrame(SESSION, idle);
    expect(getPromptPending("busy")?.queued).toBe(true);

    observePromptFrame(SESSION, {
      type: "queue_update",
      sessionId: SESSION,
      queued: [],
    });
    observePromptFrame(SESSION, userEntry("entry-1", [requestId]));
    expect(getPromptPending("busy")?.started).toBe(true);

    observePromptFrame(SESSION, idle);
    expect(getPromptPending("busy")).toBeUndefined();
  });

  test("an idle session's turn ends the prompt it started for", async () => {
    const requestId = await press("idle");
    observePromptFrame(SESSION, idle);
    expect(getPromptPending("idle")).toBeDefined();
    observePromptFrame(SESSION, userEntry(requestId));
    observePromptFrame(SESSION, idle);
    expect(getPromptPending("idle")).toBeUndefined();
  });

  test("the fix's own turn ending clears it while other work runs", async () => {
    const requestId = await press("workflow");
    observePromptFrame(SESSION, userEntry(requestId));
    observePromptFrame(SESSION, { type: "stream_done", sessionId: SESSION });
    // A background workflow keeps the session reported as running.
    observePromptFrame(SESSION, { ...idle, isRunning: true });
    expect(getPromptPending("workflow")).toBeUndefined();
  });

  test("coming back while a batch with the fix runs keeps it until that turn ends", async () => {
    const requestId = await press("batched");
    observePromptFrame(SESSION, queue(requestId));
    // The viewer is gone while the fix is batched into a turn. Watch sends
    // the queue, the status, then the feed snapshot. The batch's entry may
    // be outside the transcript tail; the snapshot still lists the fix.
    observePromptFrame(SESSION, queue());
    observePromptFrame(SESSION, { ...idle, isRunning: true });
    observePromptFrame(SESSION, feedSnapshot(["other", requestId]));
    expect(getPromptPending("batched")?.started).toBe(true);
    observePromptFrame(SESSION, { type: "stream_done", sessionId: SESSION });
    expect(getPromptPending("batched")).toBeUndefined();
  });

  test("a resumed feed without the turn's text keeps a running fix", async () => {
    const requestId = await press("resumed");
    observePromptFrame(SESSION, userEntry(requestId));
    observePromptFrame(SESSION, { ...idle, isRunning: true });
    // An in-window resume replays deltas and leaves `active` out.
    observePromptFrame(SESSION, feedSnapshot([requestId]));
    expect(getPromptPending("resumed")?.started).toBe(true);
  });

  test("coming back after the fix ended clears it, reply or not, while a workflow runs", async () => {
    const requestId = await press("ended");
    observePromptFrame(SESSION, queue(requestId));
    // It ran and failed with only a notice while the viewer was away.
    observePromptFrame(SESSION, queue());
    observePromptFrame(SESSION, { ...idle, isRunning: true });
    observePromptFrame(SESSION, feedSnapshot([]));
    expect(getPromptPending("ended")).toBeUndefined();
  });

  test("a prompt the server has not shown yet waits out its grace period", async () => {
    await press("unseen");
    observePromptFrame(SESSION, queue());
    observePromptFrame(SESSION, feedSnapshot([]));
    expect(getPromptPending("unseen")).toBeDefined();
  });

  test("a steer the turn never read goes back to waiting, not done", async () => {
    const requestId = await press("unread");
    observePromptFrame(SESSION, queue(requestId));
    // Steered: its entry lands at once, the receipt stays in the queue.
    observePromptFrame(SESSION, userEntry(requestId));
    observePromptFrame(SESSION, steered(requestId));
    expect(getPromptPending("unread")?.started).toBe(false);
    // The turn ends before the engine reads it: back in the queue first.
    observePromptFrame(SESSION, queue(requestId));
    observePromptFrame(SESSION, { type: "stream_done", sessionId: SESSION });
    observePromptFrame(SESSION, idle);
    expect(getPromptPending("unread")?.queued).toBe(true);
    // Its own turn later takes it from the queue and ends.
    observePromptFrame(SESSION, queue());
    expect(getPromptPending("unread")?.started).toBe(true);
    observePromptFrame(SESSION, { type: "stream_done", sessionId: SESSION });
    expect(getPromptPending("unread")).toBeUndefined();
  });

  test("a steer the engine read ends with the turn it joined", async () => {
    const requestId = await press("read");
    observePromptFrame(SESSION, steered(requestId));
    observePromptFrame(SESSION, userEntry(requestId));
    expect(getPromptPending("read")?.started).toBe(false);
    // steer_delivered retires the receipt.
    observePromptFrame(SESSION, queue());
    expect(getPromptPending("read")?.started).toBe(true);
    observePromptFrame(SESSION, { type: "stream_done", sessionId: SESSION });
    expect(getPromptPending("read")).toBeUndefined();
  });

  test("a snapshot that can't name the running turn's prompts changes nothing", async () => {
    const requestId = await press("adopted");
    observePromptFrame(SESSION, userEntry(requestId));
    // A run adopted after a restart: the server leaves the list out.
    observePromptFrame(SESSION, feedSnapshot());
    expect(getPromptPending("adopted")?.started).toBe(true);
  });

  test("frames from another session leave the prompt alone", async () => {
    const requestId = await press("other");
    observePromptFrame("s-2", userEntry(requestId));
    observePromptFrame("s-2", idle);
    expect(getPromptPending("other")?.started).toBe(false);
  });
});
