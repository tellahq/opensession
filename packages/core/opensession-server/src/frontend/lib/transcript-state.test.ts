import { describe, expect, test } from "bun:test";
import {
  classifyQueuedContent,
  isClientVisibleQueuedContent,
  mergeOptimisticTranscriptEntries,
  mergeTranscriptEntries,
  normalizeLegacyVoiceToolEntries,
  orderTranscriptEntries,
  queueAttribution,
  summarizeInFlightContent,
} from "./transcript-state";
import type { TranscriptEntry } from "./types";

function entry(
  id: string,
  seq: number,
  changeSeq: number,
  content = id,
  timestamp = "2026-07-23T12:00:00.000Z",
): TranscriptEntry {
  return { id, seq, changeSeq, content, timestamp, type: "assistant" };
}

describe("transcript client state", () => {
  test("orders v2 history by seq even when timestamps tie", () => {
    expect(
      orderTranscriptEntries([entry("new", 2, 2), entry("old", 1, 1)]).map(
        (e) => e.id,
      ),
    ).toEqual(["old", "new"]);
  });

  test("places an optimistic prompt by causal anchor instead of wall clock", () => {
    const older = entry(
      "older",
      1,
      1,
      "older answer",
      "2026-07-23T12:00:00.000Z",
    );
    const laterAssistant = entry(
      "later-assistant",
      2,
      2,
      "reply",
      // The server clock is behind the browser that stamped the prompt.
      "2026-07-23T12:00:01.000Z",
    );
    const optimistic = {
      id: "outbox-prompt",
      type: "user" as const,
      content: "new question",
      timestamp: "2026-07-23T12:00:10.000Z",
      optimisticAfterEntryId: "older",
      optimisticAfterSeq: 1,
    };

    expect(
      mergeOptimisticTranscriptEntries(
        [older, laterAssistant],
        [optimistic],
      ).map((item) => item.id),
    ).toEqual(["older", "outbox-prompt", "later-assistant"]);
  });

  test("keeps a later optimistic prompt after the durable prompt it followed", () => {
    const older = entry("older", 1, 1);
    const firstPrompt: TranscriptEntry = {
      id: "first-prompt",
      seq: 2,
      changeSeq: 2,
      type: "user",
      content: "first",
      timestamp: "2026-07-23T12:00:01.000Z",
    };
    const secondPrompt = {
      id: "outbox-second",
      type: "user" as const,
      content: "second",
      timestamp: "2026-07-23T12:00:10.000Z",
      optimisticAfterEntryId: "first-prompt",
      optimisticAfterSeq: 1,
    };
    expect(
      mergeOptimisticTranscriptEntries(
        [older, firstPrompt],
        [secondPrompt],
      ).map((item) => item.id),
    ).toEqual(["older", "first-prompt", "outbox-second"]);
  });

  test("uses the seq anchor across an unsequenced decoration", () => {
    const decoration: TranscriptEntry = {
      id: "divider",
      type: "system",
      content: "model changed",
      timestamp: "2026-07-23T12:00:01.000Z",
    };
    const optimistic = {
      id: "outbox-prompt",
      type: "user" as const,
      content: "question",
      timestamp: "2026-07-23T12:00:10.000Z",
      optimisticAfterEntryId: "missing-payload",
      optimisticAfterSeq: 2,
    };
    expect(
      mergeOptimisticTranscriptEntries(
        [entry("one", 1, 1), decoration, entry("two", 2, 2)],
        [optimistic],
      ).map((item) => item.id),
    ).toEqual(["one", "divider", "two", "outbox-prompt"]);
  });

  test("keeps an opening prompt first when assistant output lands early", () => {
    const assistant = entry("assistant", 1, 1);
    const optimistic = {
      id: "pending-initial",
      type: "user" as const,
      content: "opening prompt",
      timestamp: "2026-07-23T12:00:10.000Z",
      optimisticAfterEntryId: null,
    };
    expect(
      mergeOptimisticTranscriptEntries([assistant], [optimistic]).map(
        (item) => item.id,
      ),
    ).toEqual(["pending-initial", "assistant"]);
  });

  test("a delayed stale frame cannot overwrite a newer rewrite", () => {
    const result = mergeTranscriptEntries(
      [entry("a", 1, 5, "new")],
      [entry("a", 1, 4, "stale")],
      true,
    );
    expect(result[0].content).toBe("new");
    expect(result[0].changeSeq).toBe(5);
  });

  test("overlapping history updates by id instead of dropping corrections", () => {
    const result = mergeTranscriptEntries(
      [entry("b", 2, 2), entry("c", 3, 3)],
      [entry("a", 1, 1), entry("b", 2, 4, "corrected")],
      true,
    );
    expect(result.map((e) => [e.id, e.content])).toEqual([
      ["a", "a"],
      ["b", "corrected"],
      ["c", "c"],
    ]);
  });

  test("replaying a frame is idempotent", () => {
    const frame = [entry("a", 1, 1), entry("b", 2, 2)];
    const once = mergeTranscriptEntries([], frame, true);
    const twice = mergeTranscriptEntries(once, frame, true);
    expect(twice).toEqual(once);
  });

  test("synthetic dividers never let timestamps reorder the seq spine", () => {
    const rewrittenOld = entry(
      "old",
      1,
      5,
      "rewritten",
      "2026-07-23T15:00:00.000Z",
    );
    const newer = entry("new", 2, 2, "new", "2026-07-23T13:00:00.000Z");
    const divider: TranscriptEntry = {
      id: "divider",
      type: "system",
      content: "switched",
      timestamp: "2026-07-23T14:00:00.000Z",
    };
    const ordered = orderTranscriptEntries([newer, divider, rewrittenOld]);
    expect(ordered.filter((e) => e.seq !== undefined).map((e) => e.id)).toEqual(
      ["old", "new"],
    );
  });

  test("decorations interleave by timestamp around the seq spine", () => {
    const at = (h: number) =>
      `2026-07-23T${String(h).padStart(2, "0")}:00:00.000Z`;
    const spine = [
      entry("s1", 1, 1, "s1", at(10)),
      entry("s2", 2, 2, "s2", at(12)),
      entry("s3", 3, 3, "s3", at(14)),
    ];
    const decoration = (id: string, timestamp: string): TranscriptEntry => ({
      id,
      type: "system",
      content: id,
      timestamp,
    });
    const ordered = orderTranscriptEntries([
      decoration("d-tail", at(15)),
      spine[2]!,
      decoration("d-mid-b", at(12)),
      spine[0]!,
      decoration("d-head", at(9)),
      spine[1]!,
      // Same timestamp as d-mid-b but later in the input: stays after it.
      decoration("d-mid-c", at(12)),
    ]);
    expect(ordered.map((e) => e.id)).toEqual([
      "d-head",
      "s1",
      "s2",
      "d-mid-b",
      "d-mid-c",
      "s3",
      "d-tail",
    ]);
  });

  test("normalizes legacy Desk voice actions into linked tool entries", () => {
    const timestamp = "2026-08-07T12:00:00.000Z";
    const legacy: TranscriptEntry[] = [
      {
        id: "voice-tu-call-1",
        type: "tool_use",
        toolName: "steer_session",
        content: '{"id":"os-1","message":"continue"}',
        timestamp,
      },
      {
        id: "voice-tr-call-1",
        type: "tool_result",
        content: '{"status":"steered"}',
        timestamp,
      },
    ];
    const normalized = normalizeLegacyVoiceToolEntries(legacy);

    expect(normalized[0]).toMatchObject({
      toolUseId: "voice-tu-call-1",
      toolInput: { id: "os-1", message: "continue" },
    });
    expect(normalized[1].toolUseId).toBe("voice-tu-call-1");
    expect(normalizeLegacyVoiceToolEntries(legacy)[0]).toBe(normalized[0]);
    expect(normalizeLegacyVoiceToolEntries(normalized)[0]).toBe(normalized[0]);
  });

  test("classifies an attributed queued review without exposing its marker", () => {
    const classified = classifyQueuedContent(
      "<!--os:review-handoff-->\n🔍 This session's PR #42 has feedback",
      "GitHub",
    );

    expect(classified.notice).toMatchObject({
      kind: "review-handoff",
      title: "PR #42 review feedback",
    });
    expect(classified.content).not.toContain("os:review-handoff");
  });

  test("classifies a queued workflow result as system traffic", () => {
    const content =
      '<!--os:workflow-notice:wf-1-->\n✅ Workflow "review" finished';
    const classified = classifyQueuedContent(content, "Kent");

    expect(classified.content).toBe('Workflow "review" finished');
    expect(classified.notice).toMatchObject({
      kind: "workflow",
      title: 'Workflow "review" finished',
    });
    expect(classified.sender).toBeUndefined();
    expect(queueAttribution(classified, "Michiel")).toBeNull();
    expect(isClientVisibleQueuedContent(content, "Kent")).toBe(false);
  });

  test("never exposes auto-continues as queued messages", () => {
    expect(
      isClientVisibleQueuedContent("(auto-continue)", "auto-continue"),
    ).toBe(false);
    expect(isClientVisibleQueuedContent("Please continue", "Kent")).toBe(true);
  });

  test("classifies queued peer-session messages as notices", () => {
    const id = "os-01a01e56-a1fc-7000-bb91-bc99b916c4ad";
    for (const content of [
      "Please avoid overlapping edits.",
      "<!--os:session-notice-->\nPlease avoid overlapping edits.",
    ]) {
      const classified = classifyQueuedContent(content, `agent ${id}`);
      expect(classified.content).toBe("Please avoid overlapping edits.");
      expect(classified.notice).toMatchObject({
        kind: "session-notice",
        title: "Message from another session",
      });
      expect(queueAttribution(classified, "Grant")).toBe(
        "Message from another session",
      );
    }
  });

  test("classifies server-generated worker failures as worker reports", () => {
    const id = "bks-01a03a08-8dec-759f-9970-5766bb898909";
    const body = `Worker task \`${id}\` ended in error without reporting back.`;
    const current = classifyQueuedContent(
      `<!--os:worker-report:${id}-->\n${body}`,
    );
    const legacy = classifyQueuedContent(`Server notice: ${body}`);

    for (const classified of [current, legacy]) {
      expect(classified.notice).toMatchObject({
        kind: "worker-report",
        title: "Worker report",
        link: { label: "Open worker", sessionId: id },
      });
      expect(classified.content).toBe(body);
    }
    expect(summarizeInFlightContent([current, legacy])).toEqual({
      messages: 0,
      reviews: 0,
      workerReports: 2,
      sessionMessages: 0,
    });
  });

  test("keeps steered agent traffic grouped as reports and session messages", () => {
    const worker = classifyQueuedContent(
      "<!--os:worker-report-->\nReview complete.",
      "worker bks-01a03a08-8dec-759f-9970-5766bb898909",
    );
    const peer = classifyQueuedContent(
      "<!--os:session-notice-->\nNo blockers found.",
      "agent bks-01a03a08-8dec-759f-9970-5766bb898910",
    );
    const human = classifyQueuedContent("Please keep going.", "Michiel");

    expect(summarizeInFlightContent([worker, peer, human])).toEqual({
      messages: 1,
      reviews: 0,
      workerReports: 1,
      sessionMessages: 1,
    });
  });

  test("credits a teammate on a queue chip but never the viewer", () => {
    const mine = classifyQueuedContent("ship it", "Kent");
    const theirs = classifyQueuedContent("ship it", "Michiel");

    expect(queueAttribution(mine, "Kent de Bruin")).toBeNull();
    expect(queueAttribution(theirs, "Kent de Bruin")).toBe("Michiel");
  });
});
