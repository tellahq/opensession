import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptEntry } from "../lib/types";
import { transcriptIndexEntryFromPayload } from "../lib/transcript-index";
import {
  setThinkingMessagesPref,
  setTurnPrefs,
} from "./TranscriptBlocks.test-setup";
const { TranscriptBlocks } = await import("./TranscriptBlocks");

function entry(
  id: string,
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    id,
    type: "assistant",
    content: id,
    timestamp: "2026-09-08T10:00:00Z",
    ...extra,
  };
}
const progress = entry("progress", {
  content: "I will compare grain size and shape alignment.",
  assistantPhase: "commentary",
});
const answer = entry("answer", {
  content: "Grain size now matches the reference.",
  assistantPhase: "final_answer",
});
const tool = entry("tool", {
  type: "tool_use",
  toolName: "bash",
  toolUseId: "call",
  toolInput: { command: "private-probe-command" },
});

afterEach(() => {
  setTurnPrefs(null);
  setThinkingMessagesPref(null);
});

describe("response-safe work folds", () => {
  test("progress stays visible after a tool starts and after interruption", () => {
    setTurnPrefs("folded", "folded");
    for (const live of [true, false]) {
      const html = renderToStaticMarkup(
        <TranscriptBlocks entries={[progress, tool]} live={live} />,
      );
      expect(html).toContain(progress.content);
      expect(html).not.toContain("private-probe-command");
    }
  });
  test("an answer folds earlier progress but survives later tools", () => {
    setTurnPrefs("folded", "folded");
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={[
          progress,
          tool,
          answer,
          { ...tool, id: "later", toolUseId: "later" },
        ]}
      />,
    );
    expect(html).not.toContain(progress.content);
    expect(html).toContain(answer.content);
    expect(html.match(/>Worked<\/span>/g)).toHaveLength(2);
  });
  test("an answer settles earlier work while follow-up tools stay active", () => {
    setTurnPrefs("running", "folded");
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        live
        entries={[
          progress,
          tool,
          answer,
          { ...tool, id: "later", toolUseId: "later" },
        ]}
      />,
    );
    expect(html).not.toContain(progress.content);
    expect(html).toContain(answer.content);
    expect(html.match(/>Worked<\/span>/g)).toHaveLength(1);
    expect(html.match(/>Working<\/span>/g)).toHaveLength(1);
  });

  test("indexed ranges preserve answers between separate work folds", () => {
    setTurnPrefs("folded", "folded");
    const entries = [
      progress,
      tool,
      answer,
      { ...tool, id: "later", toolUseId: "later" },
    ].map((entry, index) => ({
      ...entry,
      seq: index + 1,
      changeSeq: index + 1,
    }));
    const transcriptIndex = entries.flatMap((entry) => {
      const row = transcriptIndexEntryFromPayload(entry);
      return row ? [row] : [];
    });
    const html = renderToStaticMarkup(
      <TranscriptBlocks entries={entries} transcriptIndex={transcriptIndex} />,
    );
    expect(html).not.toContain(progress.content);
    expect(html).toContain(answer.content);
    expect(html.match(/>Worked<\/span>/g)).toHaveLength(2);
  });

  test("unknown and heading-shaped output never becomes thinking or work", () => {
    setTurnPrefs("folded", "folded");
    setThinkingMessagesPref("none");
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        entries={[
          entry("unknown", { content: "**Important result**" }),
          tool,
          answer,
        ]}
      />,
    );
    expect(html).toContain("<strong>Important result</strong>");
    expect(html).toContain(answer.content);
  });
  test("multiple progress messages remain readable until an explicit answer", () => {
    setTurnPrefs("folded", "folded");
    const html = renderToStaticMarkup(
      <TranscriptBlocks
        live
        entries={[
          progress,
          tool,
          {
            ...progress,
            id: "p2",
            content: "Now checking the color distribution.",
          },
          { ...tool, id: "t2", toolUseId: "c2" },
        ]}
      />,
    );
    expect(html).toContain(progress.content);
    expect(html).toContain("Now checking the color distribution.");
  });
  test("opening Worked reveals superseded progress without duplicating the answer", () => {
    setTurnPrefs("open", "folded");
    const html = renderToStaticMarkup(
      <TranscriptBlocks entries={[progress, tool, answer]} />,
    );
    expect(html).toContain(progress.content);
    expect(html.split(answer.content)).toHaveLength(2);
  });
});
