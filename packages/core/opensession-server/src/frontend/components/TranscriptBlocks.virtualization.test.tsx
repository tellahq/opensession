import { describe, expect, test } from "bun:test";
import type { TranscriptIndexEntry } from "@tellahq/opensession-protocol/session";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptEntry } from "../lib/types";
import { setTurnPrefs } from "./TranscriptBlocks.test-setup";

const { TranscriptBlocks } = await import("./TranscriptBlocks");

describe("TranscriptBlocks virtual-list fallback", () => {
  /** A review loop that swallows `absorbed` agent answers, then `tail` turns. */
  function transcriptWithReviewLoop(
    absorbed: number,
    tail: number,
  ): TranscriptEntry[] {
    const at = (minute: number) =>
      `2026-08-12T${String(12 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00Z`;
    const built: TranscriptEntry[] = [
      {
        id: "handoff",
        type: "user",
        content: "[GitHub] <!--os:review-handoff-->\nReview PR #42",
        timestamp: at(0),
      },
    ];
    // Absorbed by the loop: agent answers, none of them a human turn.
    for (let i = 0; i < absorbed; i++)
      built.push({
        id: `loop-answer-${i}`,
        type: "assistant",
        content: `Fixed finding ${i}.`,
        timestamp: at(1 + i),
      });
    // A human turn ends the loop, then ordinary exchanges after it.
    for (let i = 0; i < tail; i++)
      built.push({
        id: `tail-${i}`,
        type: i % 2 === 0 ? "user" : "assistant",
        content: `Tail message ${i}.`,
        timestamp: at(20 + i),
      });
    return built;
  }

  test("renders every row when measurement is unavailable", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks entries={transcriptWithReviewLoop(10, 30)} />,
    );
    expect(html).toContain('aria-label="Review loop, 1 round, PR #42"');
    expect(html).toContain("Tail message 29.");
    expect(html).not.toContain("data-virtual-transcript");
  });
});

describe("TranscriptBlocks indexed ranges", () => {
  const indexRow = (
    seq: number,
    role: "user" | "assistant" | "tool_use" | "tool_result" | "review_handoff",
    extra: Partial<
      Pick<TranscriptIndexEntry, "timestampMs" | "reviewPrNumber">
    > = {},
  ) => ({
    id: `indexed-${seq}`,
    seq,
    changeSeq: seq,
    timestampMs: Date.parse(`2026-08-12T12:00:0${seq}Z`),
    role,
    contentLength: 24,
    ...extra,
  });

  test("keeps unloaded history out of the transcript until it hydrates", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        transcriptIndex={[
          indexRow(1, "user"),
          indexRow(2, "assistant"),
          indexRow(3, "user"),
        ]}
        entries={[
          {
            id: "indexed-3",
            seq: 3,
            changeSeq: 3,
            type: "user",
            content: "Newest prompt",
            timestamp: "2026-08-12T12:00:03Z",
          },
        ]}
      />,
    );
    expect(html).not.toContain("Loading messages");
    expect(html).toContain("Newest prompt");
  });

  test("keeps a message that arrived mid-turn below the turn it interrupted", () => {
    // The interrupting message is stamped 09:56:47, while the turn it landed in
    // the middle of kept emitting tool rows until 09:56:52. Its range is newer by
    // seq and older by time, so only the seq spine orders these two correctly.
    const ms = (clock: string) => Date.parse(`2026-08-21T09:56:${clock}Z`);
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        transcriptIndex={[
          indexRow(1, "user", { timestampMs: ms("28.274") }),
          indexRow(2, "tool_use", { timestampMs: ms("52.223") }),
          indexRow(3, "tool_result", { timestampMs: ms("52.269") }),
          indexRow(4, "user", { timestampMs: ms("47.472") }),
        ]}
        entries={[
          {
            id: "indexed-1",
            seq: 1,
            changeSeq: 1,
            type: "user",
            content: "First question",
            timestamp: "2026-08-21T09:56:28.274Z",
          },
          {
            id: "indexed-2",
            seq: 2,
            changeSeq: 2,
            type: "tool_use",
            toolName: "grep",
            toolInput: { pattern: "filterMcpServers" },
            content: "Using grep",
            timestamp: "2026-08-21T09:56:52.223Z",
          },
          {
            id: "indexed-3",
            seq: 3,
            changeSeq: 3,
            type: "tool_result",
            toolUseId: "indexed-2",
            content: "runner-shared.ts",
            timestamp: "2026-08-21T09:56:52.269Z",
          },
          {
            id: "indexed-4",
            seq: 4,
            changeSeq: 4,
            type: "user",
            content: "Second question",
            timestamp: "2026-08-21T09:56:47.472Z",
          },
        ]}
      />,
    );
    expect(html.indexOf("First question")).toBeLessThan(
      html.indexOf("Second question"),
    );
  });

  test("places an optimistic prompt before later tools despite clock skew", () => {
    setTurnPrefs("open", "open");
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        transcriptIndex={[indexRow(1, "assistant"), indexRow(2, "tool_use")]}
        entries={[
          {
            id: "indexed-1",
            seq: 1,
            changeSeq: 1,
            type: "assistant",
            content: "Earlier answer",
            timestamp: "2026-08-12T12:00:01Z",
          },
          {
            id: "indexed-2",
            seq: 2,
            changeSeq: 2,
            type: "tool_use",
            toolName: "bash",
            toolInput: { command: "git status" },
            content: "Using bash",
            timestamp: "2026-08-12T12:00:02Z",
          },
        ]}
        optimisticEntries={[
          {
            id: "outbox-prompt",
            type: "user",
            content: "Question before tools",
            // Browser clock is eight seconds ahead of the server.
            timestamp: "2026-08-12T12:00:10Z",
            optimisticAfterEntryId: "indexed-1",
            optimisticAfterSeq: 1,
          },
        ]}
      />,
    );
    expect(html.indexOf("Question before tools")).toBeLessThan(
      html.indexOf("git status"),
    );
    setTurnPrefs(null);
  });

  test("keeps live assistant output below its optimistic prompt across a model switch", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        live
        transcriptIndex={[indexRow(1, "assistant")]}
        entries={[
          {
            id: "indexed-1",
            seq: 1,
            changeSeq: 1,
            type: "assistant",
            content: "Earlier answer",
            timestamp: "2026-08-12T12:00:01Z",
          },
          {
            id: "model-switch",
            type: "system",
            content: "Switched model",
            timestamp: "2026-08-12T12:00:09Z",
          },
          {
            id: "live-assistant",
            type: "assistant",
            content: "Later assistant output",
            // The server clock is behind the browser that sent the prompt.
            timestamp: "2026-08-12T12:00:02Z",
          },
        ]}
        optimisticEntries={[
          {
            id: "outbox-prompt",
            type: "user",
            content: "Does this work?",
            timestamp: "2026-08-12T12:00:10Z",
            optimisticAfterEntryId: "model-switch",
            optimisticAfterSeq: 1,
          },
        ]}
      />,
    );
    expect(html.indexOf("Does this work?")).toBeLessThan(
      html.indexOf("Later assistant output"),
    );
  });

  test("keeps a partial opening range visible while its prefix hydrates", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        transcriptIndex={[indexRow(1, "user"), indexRow(2, "assistant")]}
        entries={[
          {
            id: "indexed-2",
            seq: 2,
            changeSeq: 2,
            type: "assistant",
            content: "Visible tail answer",
            timestamp: "2026-08-12T12:00:02Z",
          },
        ]}
      />,
    );
    expect(html).toContain("Visible tail answer");
    expect(html).not.toContain("Loading messages");
  });

  test("keeps live tool frames inside their indexed work group", () => {
    setTurnPrefs(null);
    const at = (seq: number) => `2026-08-12T12:00:0${seq}Z`;
    const tool = (seq: number, durable = true): TranscriptEntry => {
      const entry: TranscriptEntry = {
        id: `indexed-${seq}`,
        type: "tool_use",
        toolUseId: `call-${seq}`,
        toolName: "bash",
        toolInput: { command: `check ${seq}` },
        content: "Using bash",
        timestamp: at(seq),
      };
      if (durable) {
        entry.seq = seq;
        entry.changeSeq = seq;
      }
      return entry;
    };
    const result = (
      seq: number,
      toolSeq: number,
      durable = true,
    ): TranscriptEntry => {
      const entry: TranscriptEntry = {
        id: `indexed-${seq}`,
        type: "tool_result",
        toolUseId: `call-${toolSeq}`,
        content: "ok",
        timestamp: at(seq),
      };
      if (durable) {
        entry.seq = seq;
        entry.changeSeq = seq;
      }
      return entry;
    };
    const baseIndex = [
      indexRow(1, "user"),
      indexRow(2, "tool_use"),
      indexRow(3, "tool_result"),
      indexRow(4, "tool_use"),
      indexRow(5, "tool_result"),
    ];
    const fullIndex = [
      ...baseIndex,
      indexRow(6, "tool_use"),
      indexRow(7, "tool_result"),
    ];
    const baseEntries: TranscriptEntry[] = [
      {
        id: "indexed-1",
        seq: 1,
        changeSeq: 1,
        type: "user",
        content: "Inspect the session",
        timestamp: at(1),
      },
      tool(2),
      result(3, 2),
      tool(4),
      result(5, 4),
    ];
    const liveTool = tool(6, false);
    const liveResult = result(7, 6, false);
    const scenarios = [
      { index: baseIndex, entries: [...baseEntries, liveTool, liveResult] },
      {
        index: [...baseIndex, indexRow(6, "tool_use")],
        entries: [
          ...baseEntries,
          { ...liveTool, seq: 6, changeSeq: 6 },
          liveResult,
        ],
      },
      // The index and payload state updates can render in either order.
      { index: fullIndex, entries: [...baseEntries, liveTool, liveResult] },
      {
        index: fullIndex,
        entries: [
          ...baseEntries,
          { ...liveTool, seq: 6, changeSeq: 6 },
          { ...liveResult, seq: 7, changeSeq: 7 },
        ],
      },
    ];

    for (const scenario of scenarios) {
      const html = renderToStaticMarkup(
        <TranscriptBlocks
          live
          transcriptIndex={scenario.index}
          entries={scenario.entries}
        />,
      );
      expect(html).toContain(">Working</span>");
      expect(html).not.toContain(">Worked</span>");
      expect(html).toContain("3 steps");
      expect(html).toContain('data-eid="indexed-6#turn"');
    }
  });

  test("keeps live tools grouped when unindexed narration precedes them", () => {
    setTurnPrefs(null);
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        live
        transcriptIndex={[indexRow(1, "user")]}
        entries={[
          {
            id: "indexed-1",
            seq: 1,
            changeSeq: 1,
            type: "user",
            content: "Inspect the settings",
            timestamp: "2026-08-12T12:00:01Z",
          },
          {
            id: "live-narration",
            type: "assistant",
            content: "I’ll inspect the relevant files first.",
            timestamp: "2026-08-12T12:00:02Z",
          },
          {
            id: "live-tool-1",
            type: "tool_use",
            toolUseId: "call-1",
            toolName: "read",
            toolInput: { filePath: "settings.ts" },
            content: "Using read",
            timestamp: "2026-08-12T12:00:03Z",
          },
          {
            id: "live-result-1",
            type: "tool_result",
            toolUseId: "call-1",
            content: "first",
            timestamp: "2026-08-12T12:00:04Z",
          },
          {
            id: "live-tool-2",
            type: "tool_use",
            toolUseId: "call-2",
            toolName: "read",
            toolInput: { filePath: "routes.ts" },
            content: "Using read",
            timestamp: "2026-08-12T12:00:05Z",
          },
          {
            id: "live-result-2",
            type: "tool_result",
            toolUseId: "call-2",
            content: "second",
            timestamp: "2026-08-12T12:00:06Z",
          },
        ]}
      />,
    );

    expect(html.match(/>Working<\/span>/g)).toHaveLength(1);
    expect(html).not.toContain(">Worked</span>");
    expect(html).toContain("2 steps");
    expect(html).toContain("I’ll inspect the relevant files first.");
  });

  test("keeps a note inside its loaded conversation range", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        transcriptIndex={[indexRow(1, "user"), indexRow(2, "assistant")]}
        entries={[
          {
            id: "indexed-1",
            seq: 1,
            changeSeq: 1,
            type: "user",
            content: "Question before note",
            timestamp: "2026-08-12T12:00:01Z",
          },
          {
            id: "indexed-2",
            seq: 2,
            changeSeq: 2,
            type: "assistant",
            content: "Answer after note",
            timestamp: "2026-08-12T12:00:02Z",
          },
        ]}
        notes={[
          {
            id: "middle-note",
            user: "Kent",
            text: "Note in between",
            ts: Date.parse("2026-08-12T12:00:01.500Z"),
          },
        ]}
      />,
    );
    expect(html.indexOf("Question before note")).toBeLessThan(
      html.indexOf("Note in between"),
    );
    expect(html.indexOf("Note in between")).toBeLessThan(
      html.indexOf("Answer after note"),
    );
  });

  test("drops an unloaded review loop until its payload hydrates", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        transcriptIndex={[
          indexRow(1, "review_handoff", { reviewPrNumber: 42 }),
          indexRow(2, "assistant"),
        ]}
        entries={[]}
      />,
    );
    expect(html).not.toContain("PR #42");

    const hydrated = renderToStaticMarkup(
      <TranscriptBlocks
        transcriptIndex={[
          indexRow(1, "review_handoff", { reviewPrNumber: 42 }),
          indexRow(2, "assistant"),
        ]}
        entries={[
          {
            id: "indexed-1",
            seq: 1,
            changeSeq: 1,
            type: "system",
            content: "Starting review of PR #42",
            timestamp: "2026-08-12T12:00:01Z",
            notice: {
              kind: "review-handoff",
              title: "Reviewing PR #42",
              tone: "info",
            },
          },
        ]}
      />,
    );
    expect(hydrated).toContain("PR #42");
  });

  test("does not let a model switch materialize an unloaded review loop", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        transcriptIndex={[
          indexRow(1, "review_handoff", { reviewPrNumber: 42 }),
          indexRow(2, "assistant"),
          indexRow(3, "user"),
        ]}
        entries={[
          {
            id: "model-switch",
            type: "system",
            content: "Switched model inside old review work",
            timestamp: "2026-08-12T12:00:02.500Z",
          },
          {
            id: "indexed-3",
            seq: 3,
            changeSeq: 3,
            type: "user",
            content: "Loaded tail",
            timestamp: "2026-08-12T12:00:03Z",
          },
        ]}
      />,
    );
    expect(html).toContain("Loaded tail");
    expect(html).not.toContain("PR #42");
    expect(html).not.toContain("Switched model inside old review work");
  });

  test("grows around unloaded middle history while loaded neighbors keep order", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        transcriptIndex={[
          indexRow(1, "user"),
          indexRow(2, "assistant"),
          indexRow(3, "user"),
          indexRow(4, "assistant"),
          indexRow(5, "user"),
          indexRow(6, "assistant"),
        ]}
        entries={[
          {
            id: "indexed-2",
            seq: 2,
            changeSeq: 2,
            type: "assistant",
            content: "Early answer",
            timestamp: "2026-08-12T12:00:02Z",
          },
          {
            id: "indexed-6",
            seq: 6,
            changeSeq: 6,
            type: "assistant",
            content: "Late answer",
            timestamp: "2026-08-12T12:00:06Z",
          },
        ]}
      />,
    );
    expect(html).not.toContain("Loading messages");
    expect(html.indexOf("Early answer")).toBeLessThan(
      html.indexOf("Late answer"),
    );
  });
});
