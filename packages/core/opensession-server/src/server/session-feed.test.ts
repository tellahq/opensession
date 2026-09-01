import { describe, expect, test } from "bun:test";
import type { ProtocolServerMessage } from "@tellahq/opensession-protocol/session";
import {
  appendSessionFeed,
  resumeSessionFeed,
  sessionFeedSnapshot,
} from "./session-feed";
import {
  holdSessionRunning,
  onSessionStateChange,
  releaseSessionRunning,
} from "./session-state-events";
import { publishTranscript, subscribeTranscript } from "./transcript-bus";

type FeedAppend = Extract<
  Extract<ProtocolServerMessage, { type: "session_feed" }>["event"],
  { type: "transcript_append" }
>;
type TopLevelAppend = Extract<
  ProtocolServerMessage,
  { type: "transcript_append" }
>;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("session feed", () => {
  test("a wrapped transcript_append is the top-level frame, cursors included", () => {
    // Compile-time half: the two routes are the SAME declared shape, so a
    // field added to one can never be missing from the other.
    const sameShape: Exact<FeedAppend, TopLevelAppend> = true;
    expect(sameShape).toBe(true);

    const sessionId = `feed-${crypto.randomUUID()}`;
    const frame = appendSessionFeed(sessionId, {
      type: "transcript_append",
      sessionId,
      entries: [],
      endOffset: 512,
      rev: "mirror-1",
      lastSeq: 7,
      lastChangeSeq: 9,
      v2: true,
    });
    expect(frame.phase).toBe("committed");
    expect(frame.event).toMatchObject({
      type: "transcript_append",
      endOffset: 512,
      rev: "mirror-1",
      lastSeq: 7,
      lastChangeSeq: 9,
      v2: true,
    });
  });

  test("sequences committed frames when their async fan-out delivers", async () => {
    const sessionId = `feed-${crypto.randomUUID()}`;
    let committedSeq: number | undefined;
    const unsubscribe = subscribeTranscript(sessionId, (event) => {
      committedSeq = event.feed?.feedSeq;
    });
    try {
      publishTranscript(sessionId, {
        entries: [
          {
            id: "call-1",
            type: "tool_use",
            content: "Using Read",
            timestamp: new Date().toISOString(),
            toolName: "Read",
            toolUseId: "call-1",
            toolInput: { path: "README.md" },
            seq: 1,
            changeSeq: 1,
          },
        ],
        firstSeq: 1,
        lastSeq: 1,
      });

      // A runner can emit the next live frame before transcript fan-out's
      // microtask. Its synchronous delivery must receive the earlier feed
      // sequence too, or the client advances past and drops the durable call.
      const live = appendSessionFeed(sessionId, {
        type: "stream_tool_result",
        sessionId,
        entry: {
          id: "tr-call-1",
          type: "tool_result",
          content: "ok",
          timestamp: new Date().toISOString(),
          toolUseId: "call-1",
        },
      });
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      expect(committedSeq).toBe(live.feedSeq + 1);
    } finally {
      unsubscribe();
    }
  });

  test("orders active frames and resumes a true gap", () => {
    const sessionId = `feed-${crypto.randomUUID()}`;
    const start = appendSessionFeed(sessionId, {
      type: "stream_start",
      sessionId,
      by: "Jaap",
    });
    const text = appendSessionFeed(sessionId, {
      type: "stream_text",
      sessionId,
      text: "hello",
    });
    const resumed = resumeSessionFeed(
      sessionId,
      start.feedSeq,
      start.feedEpoch,
    );
    expect(resumed.frames.map((frame) => frame.feedSeq)).toEqual([
      text.feedSeq,
    ]);
    expect(resumed.snapshot.active).toBeNull();
  });

  test("active snapshot contains only text not yet committed", () => {
    const sessionId = `feed-${crypto.randomUUID()}`;
    appendSessionFeed(sessionId, { type: "stream_start", sessionId });
    appendSessionFeed(sessionId, {
      type: "stream_text",
      sessionId,
      text: "landed",
    });
    appendSessionFeed(sessionId, {
      type: "transcript_append",
      sessionId,
      entries: [
        {
          id: "a",
          type: "assistant",
          content: "landed",
          timestamp: new Date().toISOString(),
        },
      ],
    });
    expect(sessionFeedSnapshot(sessionId).active?.text).toBe("");
  });

  test("a block that landed mid-stream leaves the snapshot a joiner gets", () => {
    // The bug this pins: the reply types out in deltas, so when the durable
    // entry lands only part of the block has streamed. Subtracting whole
    // blocks missed that, and the next viewer to open the session was
    // handed the paragraph a second time under the one in its transcript.
    const sessionId = `feed-${crypto.randomUUID()}`;
    appendSessionFeed(sessionId, { type: "stream_start", sessionId });
    for (const [text, blockId] of [
      ["The main constraint ", "prt_1"],
      ["is decisive. ", "prt_1"],
    ] as const) {
      appendSessionFeed(sessionId, {
        type: "stream_text",
        sessionId,
        text,
        blockId,
      });
    }
    appendSessionFeed(sessionId, {
      type: "transcript_append",
      sessionId,
      entries: [
        {
          id: "prt_1",
          type: "assistant",
          content: "The main constraint is decisive. It cannot host agents.",
          timestamp: new Date().toISOString(),
        },
      ],
    });
    expect(sessionFeedSnapshot(sessionId).active?.text).toBe("");

    // The frames still in flight for that block are the entry's own words.
    appendSessionFeed(sessionId, {
      type: "stream_text",
      sessionId,
      text: "It cannot host agents.",
      blockId: "prt_1",
    });
    expect(sessionFeedSnapshot(sessionId).active?.text).toBe("");

    // The next block still streams into the bubble as usual.
    appendSessionFeed(sessionId, {
      type: "stream_text",
      sessionId,
      text: "So the viable shape is",
      blockId: "prt_2",
    });
    expect(sessionFeedSnapshot(sessionId).active?.text).toBe(
      "So the viable shape is",
    );
  });

  test("an engine that names no blocks keeps the string fallback", () => {
    const sessionId = `feed-${crypto.randomUUID()}`;
    appendSessionFeed(sessionId, { type: "stream_start", sessionId });
    appendSessionFeed(sessionId, {
      type: "stream_text",
      sessionId,
      text: "half a ",
    });
    appendSessionFeed(sessionId, {
      type: "transcript_append",
      sessionId,
      entries: [
        {
          id: "a",
          type: "assistant",
          content: "half a block",
          timestamp: new Date().toISOString(),
        },
      ],
    });
    expect(sessionFeedSnapshot(sessionId).active?.text).toBe("");
    appendSessionFeed(sessionId, {
      type: "stream_text",
      sessionId,
      text: "block",
    });
    expect(sessionFeedSnapshot(sessionId).active?.text).toBe("");
  });

  test("does not replay a completed ephemeral stream", () => {
    const sessionId = `feed-${crypto.randomUUID()}`;
    const start = appendSessionFeed(sessionId, {
      type: "stream_start",
      sessionId,
    });
    appendSessionFeed(sessionId, {
      type: "stream_text",
      sessionId,
      text: "done",
    });
    appendSessionFeed(sessionId, { type: "stream_done", sessionId });
    const resumed = resumeSessionFeed(sessionId, 0, start.feedEpoch);
    expect(resumed.frames).toEqual([]);
    expect(resumed.snapshot.active).toBeNull();
  });

  test("an adopted run starts a new epoch and rebuilds its active snapshot", () => {
    const sessionId = `feed-${crypto.randomUUID()}`;
    const before = appendSessionFeed(sessionId, {
      type: "stream_start",
      sessionId,
    });
    appendSessionFeed(sessionId, {
      type: "stream_text",
      sessionId,
      text: "before restart",
    });

    // A real process has a fresh globalThis map. The recovered run's init event
    // recreates the active phase instead of restoring any old feed frames.
    (
      globalThis as { __osSessionFeeds?: Map<string, unknown> }
    ).__osSessionFeeds = new Map();
    appendSessionFeed(sessionId, {
      type: "stream_start",
      sessionId,
      by: "Michiel",
    });
    appendSessionFeed(sessionId, {
      type: "stream_text",
      sessionId,
      text: "after adoption",
    });

    const resumed = resumeSessionFeed(
      sessionId,
      before.feedSeq,
      before.feedEpoch,
    );
    expect(resumed.frames).toEqual([]);
    expect(resumed.snapshot.feedEpoch).not.toBe(before.feedEpoch);
    expect(resumed.snapshot.active).toMatchObject({
      by: "Michiel",
      text: "after adoption",
    });
  });

  test("stream boundaries emit authoritative running transitions", () => {
    const sessionId = `feed-${crypto.randomUUID()}`;
    const states: boolean[] = [];
    const unsubscribe = onSessionStateChange((event) => {
      if (event.sessionId === sessionId) states.push(event.isRunning);
    });
    try {
      appendSessionFeed(sessionId, { type: "stream_start", sessionId });
      appendSessionFeed(sessionId, { type: "stream_done", sessionId });
    } finally {
      unsubscribe();
    }
    expect(states).toEqual([true, false]);
  });

  test("a background activity keeps the session running after its turn ends", () => {
    const sessionId = `feed-${crypto.randomUUID()}`;
    const key = "workflow:wf-1";
    appendSessionFeed(sessionId, { type: "stream_start", sessionId });
    holdSessionRunning(sessionId, key);

    appendSessionFeed(sessionId, { type: "stream_done", sessionId });
    const status = appendSessionFeed(sessionId, {
      type: "session_status",
      sessionId,
      isRunning: false,
    });
    expect(status.event).toMatchObject({
      type: "session_status",
      isRunning: true,
    });

    expect(releaseSessionRunning(sessionId, key)).toBe(false);
  });
});
