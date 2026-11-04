import { expect, test } from "bun:test";
import type { TranscriptEntry } from "../../lib/types";
import {
  cacheTranscriptView,
  peekCachedTranscriptView,
  seedDuplicateTranscriptView,
} from "./transcript-cache";

const entry = (id: string): TranscriptEntry => ({
  id,
  type: "system",
  content: id,
  timestamp: "2026-11-04T00:00:00.000Z",
});

function cacheSource(id: string, entries: TranscriptEntry[]) {
  cacheTranscriptView(id, {
    entries,
    cursor: { sessionId: id, rev: "r", offset: 10 },
    seq: { sessionId: id, lastSeq: 9, firstSeq: 1, lastChangeSeq: 9 },
    historyTruncated: true,
    historyStart: 4,
    index: [],
    indexEpoch: 1,
  });
}

test("a duplicate opens on the source's conversation through the chosen message", () => {
  cacheSource("os-source", [
    entry("model-switch-2026-11-03T00:00:00.000Z"),
    entry("a"),
    entry("b"),
    entry("c"),
  ]);
  expect(seedDuplicateTranscriptView("os-source", "os-copy", "b")).toBe(true);
  expect(peekCachedTranscriptView("os-copy")).toEqual({
    entries: [entry("a"), entry("b")],
    // Nothing the duplicate could resume from: its first watch takes the
    // server's own snapshot.
    cursor: null,
    seq: null,
    historyTruncated: false,
    historyStart: null,
    index: null,
    indexEpoch: null,
  });

  expect(seedDuplicateTranscriptView("os-source", "os-whole")).toBe(true);
  expect(
    peekCachedTranscriptView("os-whole")?.entries.map((item) => item.id),
  ).toEqual(["a", "b", "c"]);
});

test("a duplicate stays blank when there is nothing to copy from", () => {
  cacheSource("os-source", [entry("a")]);
  expect(seedDuplicateTranscriptView("os-source", "os-missing", "zz")).toBe(
    false,
  );
  expect(seedDuplicateTranscriptView("os-unknown", "os-blank")).toBe(false);
  expect(peekCachedTranscriptView("os-missing")).toBeNull();
  expect(peekCachedTranscriptView("os-blank")).toBeNull();
});

test("the duplicate's tab is seeded before it is routed", async () => {
  const tabs = await Bun.file(
    new URL("../../hooks/useSessionTabs.tsx", import.meta.url),
  ).text();
  const seed = tabs.indexOf(
    "if (duplicate) seedDuplicateTranscriptView(src.id, id, messageId);",
  );
  expect(seed).toBeGreaterThan(0);
  expect(seed).toBeLessThan(tabs.indexOf("flushSync(() => {", seed));
});
