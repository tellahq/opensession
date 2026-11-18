import { describe, expect, test } from "bun:test";
import {
  getPromptPending,
  observePromptFrame,
  sendPrPrompt,
} from "./pr-prompt-pending";
import type { WSClientMessage } from "./types";

const SESSION = "s-1";
const outbox = new Map<string, WSClientMessage[]>();

async function press(key: string) {
  const sent: WSClientMessage[] = [];
  outbox.set(key, sent);
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

const reply = {
  id: "reply-1",
  type: "assistant" as const,
  content: "Fixed",
  timestamp: "2026-11-18T00:00:01Z",
};

function queue(...ids: string[]) {
  return {
    type: "queue_update" as const,
    sessionId: SESSION,
    queued: ids.map((id) => ({ id, content: "Fix the checks" })),
  };
}

function feedSnapshot(running: boolean) {
  return {
    type: "feed_snapshot" as const,
    sessionId: SESSION,
    feedEpoch: "epoch-1",
    feedSeq: 1,
    active: running
      ? {
          runId: "run-1",
          turnId: "turn:run-1",
          entryId: "stream:run-1",
          text: "",
          startedAt: 0,
        }
      : null,
  };
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

  test("a viewer that comes back mid-fix picks it up from the snapshot", async () => {
    const requestId = await press("return");
    observePromptFrame(SESSION, {
      type: "queue_update",
      sessionId: SESSION,
      queued: [{ id: requestId, content: "Fix the checks" }],
    });
    // The viewer is gone while the queue drains into the fix's turn. On its
    // next watch it receives the transcript snapshot, then the queue and the
    // status.
    observePromptFrame(SESSION, {
      ...userEntry("entry-2", [requestId]),
      type: "transcript_init",
    });
    observePromptFrame(SESSION, {
      type: "queue_update",
      sessionId: SESSION,
      queued: [],
    });
    observePromptFrame(SESSION, { ...idle, isRunning: true });
    // Started, so the grace timeout no longer applies to it.
    expect(getPromptPending("return")?.started).toBe(true);
  });

  test("the fix's own turn ending clears it while other work runs", async () => {
    const requestId = await press("workflow");
    observePromptFrame(SESSION, userEntry(requestId));
    observePromptFrame(SESSION, { type: "stream_done", sessionId: SESSION });
    // A background workflow keeps the session reported as running.
    observePromptFrame(SESSION, { ...idle, isRunning: true });
    expect(getPromptPending("workflow")).toBeUndefined();
  });

  test("coming back after the fix ended clears it while a workflow runs", async () => {
    const requestId = await press("ended");
    observePromptFrame(SESSION, queue(requestId));
    // The viewer is gone while the fix runs and ends. Watch sends the
    // snapshot, the queue, the status and the feed snapshot, in that order.
    const entry = userEntry("entry-3", [requestId]).entries[0];
    observePromptFrame(SESSION, {
      type: "transcript_init",
      sessionId: SESSION,
      entries: [entry, reply],
    });
    observePromptFrame(SESSION, queue());
    observePromptFrame(SESSION, { ...idle, isRunning: true });
    expect(getPromptPending("ended")).toBeDefined();
    observePromptFrame(SESSION, feedSnapshot(false));
    expect(getPromptPending("ended")).toBeUndefined();
  });

  test("coming back while the fix's turn runs keeps it until that turn ends", async () => {
    const requestId = await press("running");
    observePromptFrame(SESSION, {
      type: "transcript_init",
      sessionId: SESSION,
      entries: [userEntry(requestId).entries[0], reply],
    });
    observePromptFrame(SESSION, queue());
    observePromptFrame(SESSION, { ...idle, isRunning: true });
    observePromptFrame(SESSION, feedSnapshot(true));
    expect(getPromptPending("running")?.started).toBe(true);
    observePromptFrame(SESSION, { type: "stream_done", sessionId: SESSION });
    expect(getPromptPending("running")).toBeUndefined();
  });

  test("an entry landing before its turn starts is not mistaken for its end", async () => {
    const requestId = await press("landing");
    observePromptFrame(SESSION, feedSnapshot(false));
    observePromptFrame(SESSION, userEntry(requestId));
    expect(getPromptPending("landing")?.started).toBe(true);
  });

  test("a batched fix outside the snapshot's tail is found through the outline", async () => {
    const requestId = await press("batched");
    observePromptFrame(SESSION, queue(requestId));
    // On return, the batch's entry is older than the tail, and the queue
    // no longer holds the fix.
    observePromptFrame(SESSION, {
      type: "transcript_init",
      sessionId: SESSION,
      entries: [reply],
    });
    observePromptFrame(SESSION, queue());
    observePromptFrame(SESSION, feedSnapshot(true));
    observePromptFrame(SESSION, {
      type: "transcript_index",
      sessionId: SESSION,
      entries: [
        {
          id: "batch-1",
          seq: 10,
          changeSeq: 10,
          timestampMs: Date.now(),
          role: "user",
          contentLength: 20,
        },
        {
          id: "reply-1",
          seq: 11,
          changeSeq: 11,
          timestampMs: Date.now(),
          role: "agent_message",
          contentLength: 5,
        },
      ],
      firstSeq: 10,
      lastSeq: 11,
      lastChangeSeq: 11,
      epoch: 3,
    });
    const lookup = outbox.get("batched")?.at(-1);
    if (lookup?.type !== "load_transcript_range") throw new Error("no lookup");
    expect([lookup.firstSeq, lookup.lastSeq, lookup.epoch]).toEqual([
      10, 10, 3,
    ]);

    observePromptFrame(SESSION, {
      type: "transcript_range",
      sessionId: SESSION,
      requestId: lookup.requestId,
      entries: userEntry("batch-1", ["other", requestId]).entries,
      firstSeq: 10,
      lastSeq: 10,
      coveredThroughSeq: 10,
      complete: true,
      epoch: 3,
      lastChangeSeq: 11,
    });
    expect(getPromptPending("batched")?.started).toBe(true);
    observePromptFrame(SESSION, { type: "stream_done", sessionId: SESSION });
    expect(getPromptPending("batched")).toBeUndefined();
  });

  test("frames from another session leave the prompt alone", async () => {
    const requestId = await press("other");
    observePromptFrame("s-2", userEntry(requestId));
    observePromptFrame("s-2", idle);
    expect(getPromptPending("other")?.started).toBe(false);
  });
});
