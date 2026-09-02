import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  committedTranscriptMeasureKeys,
  didScrollTranscriptTowardHistory,
  measureTranscriptElement,
  VirtualTranscriptList,
  shouldAdjustTranscriptScroll,
  shouldCaptureReaderAnchor,
  shouldDeferReaderCorrection,
  transcriptOverscan,
  transcriptViewportNeedsHistory,
  type VirtualTranscriptItem,
  virtualTranscriptRange,
} from "./VirtualTranscriptList";

function item(index: number): VirtualTranscriptItem {
  return {
    key: `block-${index}`,
    anchorId: `entry-${index}`,
    entryIds: [`entry-${index}`],
    estimateSize: 80,
    content: <span>Block {index}</span>,
  };
}

// The adapter's scrolling contract (native keyed prepend anchoring, the
// reader anchor captured before the DOM mutates and settled as a delta, one
// writer per commit, touch deferral, rows that never glide) is asserted in a
// real browser by tools/transcript-scroll-regression.ts and its in-page
// probe. These tests cover the pure decision helpers only.
describe("VirtualTranscriptList", () => {
  test("loads history when the opening content cannot scroll", () => {
    expect(transcriptViewportNeedsHistory(700, 700)).toBe(true);
    expect(transcriptViewportNeedsHistory(699, 700)).toBe(true);
    expect(transcriptViewportNeedsHistory(701, 700)).toBe(true);
    expect(transcriptViewportNeedsHistory(702, 700)).toBe(false);
    expect(transcriptViewportNeedsHistory(0, 0)).toBe(false);
  });

  test("keeps the live-edge tail in the same virtual coordinate space", () => {
    expect(virtualTranscriptRange([10, 11], 40, 3)).toEqual([
      10, 11, 37, 38, 39,
    ]);
    expect(virtualTranscriptRange([0, 1], 2, 24)).toEqual([0, 1]);
  });

  test("keeps a deeper virtual window for phone momentum", () => {
    expect(transcriptOverscan(true)).toBe(16);
    expect(transcriptOverscan(false)).toBe(8);
  });

  test("treats every upward scroll path as history intent", () => {
    expect(didScrollTranscriptTowardHistory(1_000, 700)).toBe(true);
    expect(didScrollTranscriptTowardHistory(700, 700)).toBe(false);
    expect(didScrollTranscriptTowardHistory(700, 1_000)).toBe(false);
    expect(didScrollTranscriptTowardHistory(700, 699.75)).toBe(false);
    // A child can sample zero before its parent restores the live edge. A
    // one-step scrollbar/Home jump back to zero must still request history.
    expect(didScrollTranscriptTowardHistory(0, 0, 745, 6_226)).toBe(true);
    expect(didScrollTranscriptTowardHistory(0, 500, 745, 6_226)).toBe(false);
    expect(didScrollTranscriptTowardHistory(0, 0, 745, 900)).toBe(false);
  });

  test("captures the reader anchor only from a consistent, non-following DOM", () => {
    const base = { held: false, virtualizerWrote: false, following: false };
    expect(shouldCaptureReaderAnchor(base)).toBe(true);
    // The host's live-edge glue owns a following reader.
    expect(shouldCaptureReaderAnchor({ ...base, following: true })).toBe(false);
    // Rows have not re-rendered against a virtualizer scroll write: that DOM
    // is no viewport a reader ever saw. Keep the earlier anchor instead.
    expect(shouldCaptureReaderAnchor({ ...base, virtualizerWrote: true })).toBe(
      false,
    );
    expect(shouldCaptureReaderAnchor({ ...base, held: true })).toBe(false);
  });

  test("defers corrections while touch momentum may be in flight", () => {
    expect(
      shouldDeferReaderCorrection({ touching: true, sinceTouchEnd: 5_000 }),
    ).toBe(true);
    expect(
      shouldDeferReaderCorrection({ touching: false, sinceTouchEnd: 40 }),
    ).toBe(true);
    expect(
      shouldDeferReaderCorrection({ touching: false, sinceTouchEnd: 400 }),
    ).toBe(false);
  });

  test("keeps TanStack's ordinary measurement anchoring semantics", () => {
    expect(
      shouldAdjustTranscriptScroll({
        itemStart: 200,
        itemEnd: 400,
        scrollOffset: 600,
      }),
    ).toBe(true);
    expect(
      shouldAdjustTranscriptScroll({
        itemStart: 200,
        itemEnd: 700,
        scrollOffset: 600,
      }),
    ).toBe(false);
    expect(
      shouldAdjustTranscriptScroll({
        itemStart: 200,
        itemEnd: 700,
        scrollOffset: 600,
        firstMeasurement: true,
      }),
    ).toBe(true);
    expect(
      shouldAdjustTranscriptScroll({
        itemStart: 200,
        itemEnd: 400,
        scrollOffset: 600,
        scrollingBackward: true,
      }),
    ).toBe(false);
  });

  test("remeasures semantic changes through the observed measurement path", () => {
    const element = {
      getBoundingClientRect: () => ({
        x: 0,
        y: 0,
        top: 0,
        right: 0,
        bottom: 144.4,
        left: 0,
        width: 0,
        height: 144.4,
        toJSON: () => ({}),
      }),
    };
    expect(measureTranscriptElement(element, undefined)).toBe(144);
  });

  test("keeps positive live-edge growth pinned in the measurement frame", () => {
    expect(
      shouldAdjustTranscriptScroll({
        itemStart: 200,
        itemEnd: 1_200,
        scrollOffset: 600,
        liveEdgeDelta: 140,
      }),
    ).toBe(true);
    expect(
      shouldAdjustTranscriptScroll({
        itemStart: 200,
        itemEnd: 1_200,
        scrollOffset: 600,
        liveEdgeDelta: -140,
      }),
    ).toBe(false);
  });

  test("synchronously remeasures new and extended semantic rows", () => {
    const before = [item(0), item(1)];
    const extended = { ...item(1), entryIds: ["entry-1", "tool-result-1"] };
    const added = item(2);
    expect([
      ...committedTranscriptMeasureKeys(before, [item(0), extended, added]),
    ]).toEqual(["block-1", "block-2"]);
    expect([
      ...committedTranscriptMeasureKeys(
        [{ ...item(0), measureVersion: ["entry-0:10"] }],
        [{ ...item(0), measureVersion: ["entry-0:20"] }],
      ),
    ]).toEqual(["block-0"]);
    expect(
      committedTranscriptMeasureKeys(before, [item(0), item(1)]).size,
    ).toBe(0);
  });

  test("renders complete semantic content without browser measurement", () => {
    const html = renderToStaticMarkup(
      <VirtualTranscriptList
        items={[item(0), item(1), item(2)]}
        trailingMounted={1}
      />,
    );
    expect(html).toContain("Block 0");
    expect(html).toContain("Block 2");
    expect(html).not.toContain("data-virtual-transcript");
  });
});
