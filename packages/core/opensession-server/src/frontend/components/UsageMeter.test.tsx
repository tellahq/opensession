import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionUsage } from "../lib/types";
import { contextFill, contextRows, UsageDetails } from "./UsageMeter";

const usage: SessionUsage = {
  costUsd: 1.5,
  inputTokens: 1_000,
  outputTokens: 500,
  cacheReadTokens: 9_000,
  cacheCreationTokens: 0,
  contextTokens: 110_000,
  contextWindow: 1_000_000,
  turns: 3,
  updatedAt: "2026-01-01T00:00:00.000Z",
  context: {
    sections: [
      { kind: "system-prompt", tokens: 8_000 },
      { kind: "tools", tokens: 12_000 },
      { kind: "messages", tokens: 90_000 },
    ],
    compactAtTokens: 440_000,
    compactions: 2,
  },
};

describe("context fill", () => {
  test("measures against the compaction point, warns against the window", () => {
    const fill = contextFill(usage);
    expect(fill.limit).toBe(440_000);
    expect(fill.frac).toBe(0.25);
    expect(fill.tone.text).toBe("text-dim");
    // Nearly at the compaction point is routine, not an alarm.
    expect(contextFill({ ...usage, contextTokens: 430_000 }).tone.text).toBe(
      "text-dim",
    );
  });

  test("falls back to the window when nothing compacts earlier", () => {
    const fill = contextFill({
      ...usage,
      contextWindow: 200_000,
      contextTokens: 180_000,
      context: undefined,
    });
    expect(fill.limit).toBe(200_000);
    expect(fill.compacts).toBe(false);
    expect(fill.tone.text).toBe("text-red");
  });
});

describe("context rows", () => {
  test("puts the conversation first and keeps the rest in a fixed order", () => {
    expect(contextRows(usage.context).map((row) => row.label)).toEqual([
      "Messages",
      "System prompt",
      "Tools",
    ]);
  });

  test("keeps a section it does not know, as Other", () => {
    // SAFETY: a newer server may send a section kind this client's
    // ContextSectionKind union does not list; the cast stands in for it.
    const future = "future" as never;
    const rows = contextRows({
      sections: [
        { kind: "messages", tokens: 10 },
        { kind: future, tokens: 5 },
      ],
    });
    expect(rows.map((row) => [row.label, row.tokens])).toEqual([
      ["Messages", 10],
      ["Other", 5],
    ]);
  });
});

describe("UsageDetails", () => {
  test("shows what fills the context and when it compacts", () => {
    const html = renderToStaticMarkup(<UsageDetails usage={usage} />);
    expect(html).toContain("data-context-breakdown");
    expect(html).toContain("Messages");
    expect(html).toContain("82%");
    expect(html).toContain(
      "Compacts at 440K of a 1M window. Compacted 2 times.",
    );
  });

  test("stays as it was for a session with no breakdown yet", () => {
    const html = renderToStaticMarkup(
      <UsageDetails usage={{ ...usage, context: undefined }} />,
    );
    expect(html).not.toContain("data-context-breakdown");
    expect(html).not.toContain("Compacts at");
    expect(html).toContain("110K / 1M (11%)");
  });
});
