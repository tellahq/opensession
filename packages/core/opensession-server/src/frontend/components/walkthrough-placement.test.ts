import { expect, test } from "bun:test";
import type { SessionWalkthrough, TranscriptEntry } from "../lib/types";
import { walkthroughInsertIndex } from "./walkthrough-placement";

const entry = (
  id: string,
  type: TranscriptEntry["type"],
  timestamp: string,
  toolName?: string,
): TranscriptEntry => ({ id, type, timestamp, toolName, content: "" });

const published = (
  publishedAt: string,
  publishedEntryId?: string,
): SessionWalkthrough => ({ summary: "…", publishedAt, publishedEntryId });

test("uses publishedAt when the publishing call is outside the loaded window", () => {
  const blocks = [
    {
      kind: "entry",
      entry: entry("answer", "assistant", "2026-07-24T21:41:00Z"),
    },
    {
      kind: "entry",
      entry: entry("later", "user", "2026-07-24T22:00:00Z"),
    },
  ];

  expect(
    walkthroughInsertIndex(blocks, published("2026-07-24T21:43:01Z")),
  ).toBe(1);
});

test("puts an older walkthrough at the top of a newer transcript window", () => {
  const blocks = [
    {
      kind: "entry",
      entry: entry("answer", "assistant", "2026-07-24T21:55:00Z"),
    },
    {
      kind: "entry",
      entry: entry("later", "user", "2026-07-24T22:00:00Z"),
    },
  ];

  expect(
    walkthroughInsertIndex(blocks, published("2026-07-24T21:43:01Z")),
  ).toBe(0);
});

test("keeps the exact publishing turn authoritative", () => {
  const blocks = [
    {
      kind: "turn",
      items: [
        entry(
          "publish",
          "tool_use",
          "2026-07-24T21:43:01Z",
          "opensession-walkthrough_publish_walkthrough",
        ),
      ],
    },
    {
      kind: "entry",
      entry: entry("answer", "assistant", "2026-07-24T21:44:00Z"),
    },
    { kind: "footer" },
    {
      kind: "entry",
      entry: entry("later", "user", "2026-07-24T22:00:00Z"),
    },
  ];

  expect(
    walkthroughInsertIndex(blocks, published("2026-07-24T21:43:01Z")),
  ).toBe(3);
});

test("anchors on the recorded publishing entry, wherever it sits", () => {
  const blocks = [
    {
      kind: "turn",
      items: [
        entry("a", "tool_use", "2026-07-24T21:40:00Z", "bash"),
        entry(
          "publish",
          "tool_use",
          "2026-07-24T21:43:01Z",
          "publish_walkthrough",
        ),
      ],
    },
    {
      kind: "entry",
      entry: entry("answer", "assistant", "2026-07-24T21:44:00Z"),
    },
    { kind: "footer" },
    { kind: "entry", entry: entry("later", "user", "2026-07-24T22:00:00Z") },
  ];

  expect(
    walkthroughInsertIndex(
      blocks,
      published("2026-07-24T21:43:01Z", "publish"),
    ),
  ).toBe(3);
});

test("falls back to the scan when the anchored entry isn't in the window", () => {
  const blocks = [
    {
      kind: "entry",
      entry: entry("answer", "assistant", "2026-07-24T21:41:00Z"),
    },
    { kind: "entry", entry: entry("later", "user", "2026-07-24T22:00:00Z") },
  ];

  expect(
    walkthroughInsertIndex(
      blocks,
      published("2026-07-24T21:43:01Z", "trimmed-away"),
    ),
  ).toBe(1);
});
