import { beforeEach, expect, mock, test } from "bun:test";
import type { TranscriptIndexEntry } from "@tellahq/opensession-protocol/session";
import type { TranscriptEntry } from "../lib/types";
import { TranscriptViewStore } from "../lib/transcript-view-store";

// Exercise frame ordering without a browser. State updates run immediately,
// and render() refreshes the hook's closures and layout-effect refs.
let cells: unknown[] = [];
let cursor = 0;
let effects: Array<() => void> = [];
mock.module("react", () => ({
  // React's public API distinguishes lazy initializers and functional updaters
  // by callability, rather than a domain discriminator.
  /* oxlint-disable anti-slop/no-runtime-typeof */
  useState: <T>(initial: T | (() => T)) => {
    const slot = cursor++;
    if (!(slot in cells)) {
      // SAFETY: React's initializer union is callable only on the lazy branch.
      cells[slot] =
        typeof initial === "function" ? (initial as () => T)() : initial;
    }
    return [
      cells[slot],
      (next: T | ((previous: T) => T)) => {
        // SAFETY: Each stable hook slot holds the T it was initialized with;
        // a callable setter argument is React's functional updater.
        cells[slot] =
          typeof next === "function"
            ? (next as (previous: T) => T)(cells[slot] as T)
            : next;
      },
    ];
  },
  /* oxlint-enable anti-slop/no-runtime-typeof */
  useRef: <T>(initial: T) => {
    const slot = cursor++;
    if (!(slot in cells)) cells[slot] = { current: initial };
    return cells[slot];
  },
  useLayoutEffect: (effect: () => void) => effects.push(effect),
}));

const { useTranscript } = await import("./useTranscript");
const sessionId = "os-message-race";
const prompt: TranscriptEntry = {
  id: "prompt",
  seq: 1,
  changeSeq: 1,
  type: "user",
  content: "Keep this message visible",
  timestamp: "2026-09-16T12:00:00Z",
};
const row: TranscriptIndexEntry = {
  id: prompt.id,
  seq: 1,
  changeSeq: 1,
  role: "user",
  timestampMs: Date.parse(prompt.timestamp),
  contentLength: prompt.content.length,
};

beforeEach(() => {
  cells = [];
  cursor = 0;
  effects = [];
});

function harness() {
  const store = new TranscriptViewStore();
  const useRender = () => {
    cursor = 0;
    effects = [];
    const controller = useTranscript({
      sessionId,
      cachedTranscript: null,
      send: () => true,
      transcriptViewStore: store,
    });
    for (const effect of effects) effect();
    return controller;
  };
  const index = (
    entries: TranscriptIndexEntry[],
    lastChangeSeq: number,
    epoch = 0,
  ) => ({
    type: "transcript_index" as const,
    sessionId,
    entries,
    firstSeq: entries[0]?.seq ?? 0,
    lastSeq: entries.at(-1)?.seq ?? 0,
    lastChangeSeq,
    epoch,
  });
  return { render: useRender, index };
}

test("a user append stays indexed before and after a delayed opening index", () => {
  const { render, index } = harness();
  const opening = render();
  opening.setIndexMode(true);
  opening.acceptInitTail([], null);
  opening.projectAppend([prompt], 1);
  expect(render().index).toEqual([row]);

  // The index read started before the append, but its reply arrived later.
  opening.replaceIndex(index([], 0), null, true);
  expect(render().index).toEqual([row]);
});

test("an index refresh cannot erase a newer user entry or rewrite", () => {
  const { render, index } = harness();
  render().replaceIndex(index([row], 1), null, true);
  const controller = render();
  const updated = { ...prompt, changeSeq: 2, content: "Edited prompt" };
  const followup = { ...prompt, id: "followup", seq: 2, changeSeq: 3 };
  controller.projectAppend([updated, followup], 1);
  controller.replaceIndex(index([row], 1), null, true);
  expect(render().index).toMatchObject([
    { id: "prompt", changeSeq: 2, contentLength: updated.content.length },
    { id: "followup", changeSeq: 3, role: "user" },
  ]);
});

test("a reset removes old outline rows rather than resurrecting history", () => {
  const { render, index } = harness();
  render().replaceIndex(index([row], 1), null, true);
  render().replaceIndex(index([], 2, 2), null, true);
  expect(render().index).toEqual([]);
});

test("the authoritative index retains hidden roles at the same revision", () => {
  const { render, index } = harness();
  render().acceptInitTail([prompt], null);
  render().replaceIndex(index([{ ...row, role: "hidden" }], 1), null, true);
  expect(render().index?.[0]?.role).toBe("hidden");
});
