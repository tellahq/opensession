import { describe, expect, test } from "bun:test";
import {
  getPromptPending,
  observePromptFrame,
  sendPrPrompt,
} from "./pr-prompt-pending";
import type { WSClientMessage } from "./types";

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

  test("frames from another session leave the prompt alone", async () => {
    const requestId = await press("other");
    observePromptFrame("s-2", userEntry(requestId));
    observePromptFrame("s-2", idle);
    expect(getPromptPending("other")?.started).toBe(false);
  });
});
