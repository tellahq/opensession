import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  committedTranscriptMeasureKeys,
  didScrollTranscriptTowardHistory,
  measureTranscriptElement,
  VirtualTranscriptList,
  shouldAdjustTranscriptScroll,
  shouldTransitionTranscriptItemPosition,
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

const source = await Bun.file(
  new URL("./VirtualTranscriptList.tsx", import.meta.url),
).text();

describe("VirtualTranscriptList", () => {
  test("defers observer fallback while keeping semantic measurement pre-paint", () => {
    expect(source).toContain("useAnimationFrameWithResizeObserver: true");
    expect(source).toContain("this.measureCommittedRows(prevProps)");
  });

  test("does not flush virtualizer notifications from a React lifecycle", () => {
    expect(source).toContain("this.runCommitLifecycle(() =>");
    expect(source).toMatch(
      /if \(this\.committing\) \{[\s\S]*this\.renderAfterCommit = true;/,
    );
    expect(source).toContain("if (this.rendering || sync) this.queueRender()");
    expect(source).not.toContain("flushSync");
  });

  test("captures history intent before scroll-driven rerenders", () => {
    expect(source).toContain("capture: true");
    expect(source).toMatch(/removeEventListener\(\s*"scroll"/);
  });

  test("loads history when the opening content cannot scroll", () => {
    expect(transcriptViewportNeedsHistory(700, 700)).toBe(true);
    expect(transcriptViewportNeedsHistory(699, 700)).toBe(true);
    expect(transcriptViewportNeedsHistory(701, 700)).toBe(true);
    expect(transcriptViewportNeedsHistory(702, 700)).toBe(false);
    expect(transcriptViewportNeedsHistory(0, 0)).toBe(false);
    expect(source).toContain("this.scheduleUnderfilledHistory()");
    expect(source).toContain(
      "if (callback()) this.scheduleUnderfilledHistory()",
    );
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

  test("compensates only hydration that grows at the row start", () => {
    expect(
      shouldAdjustTranscriptScroll({
        itemStart: 200,
        itemEnd: 1_200,
        scrollOffset: 600,
        growsAtStart: true,
      }),
    ).toBe(true);
    expect(
      shouldAdjustTranscriptScroll({
        itemStart: 700,
        itemEnd: 1_200,
        scrollOffset: 600,
        growsAtStart: true,
      }),
    ).toBe(false);
    // A continuation page appends below the point being read inside this row.
    expect(
      shouldAdjustTranscriptScroll({
        itemStart: 200,
        itemEnd: 1_200,
        scrollOffset: 600,
      }),
    ).toBe(false);
  });

  test("uses native keyed prepend anchoring without a competing end owner", () => {
    expect(source).toContain('anchorTo: "end"');
    expect(source).toContain("scrollEndThreshold: -1");
    expect(source).toContain("this.props.shouldMaintainEnd?.()");
    expect(source).not.toContain("getSnapshotBeforeUpdate");
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
    expect(source).toContain("measureElement: measureTranscriptElement");
    expect(source).toContain("this.virtualizer.measureElement(node)");
    expect(source).not.toContain("this.virtualizer.resizeItem(");
  });

  test("reaffirms following after measured virtual extent changes", () => {
    expect(source).toContain("this.renderedTotalSize = totalSize");
    expect(source).toContain(
      "if (this.renderedTotalSize === this.notifiedTotalSize) return",
    );
    expect(source).toContain("this.props.onLayout?.()");
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

  test("keeps prompt reconciliation out of position transitions", () => {
    expect(shouldTransitionTranscriptItemPosition(item(0))).toBe(true);
    expect(
      shouldTransitionTranscriptItemPosition({
        ...item(0),
        arrivalAliases: ["outbox-prompt"],
      }),
    ).toBe(false);
    expect(
      shouldTransitionTranscriptItemPosition({
        ...item(0),
        animatePositionChanges: false,
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
