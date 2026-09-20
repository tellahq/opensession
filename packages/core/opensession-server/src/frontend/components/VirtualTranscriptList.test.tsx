import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  committedTranscriptMeasureKeys,
  deferredReaderCorrection,
  didScrollTranscriptTowardHistory,
  measureTranscriptElement,
  nextDeferredLedger,
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

/** Count every property read on each item: the diff can only compare rows by
 * reading them, so zero reads means the scan did not run. */
function counted(items: VirtualTranscriptItem[]) {
  let reads = 0;
  const wrapped = items.map(
    (row) =>
      new Proxy(row, {
        get(target, property) {
          reads++;
          // SAFETY: the proxy forwards whichever field the diff reads from
          // the same row; the fixture only declares item fields.
          return target[property as keyof VirtualTranscriptItem];
        },
      }),
  );
  return { items: wrapped, reads: () => reads };
}

// The adapter's scrolling contract (the reader anchor captured before the DOM
// mutates and settled as a delta, prepends and external growth included, one
// writer per commit, touch deferral, rows that never glide) is asserted in a
// real browser by tools/transcript-scroll-regression.ts and its in-page
// probe, on desktop, phone, and phone with an iOS WebKit user agent. These
// tests cover the pure decision helpers only.
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

  test("defers corrections until touch scrolling is quiet", () => {
    expect(
      shouldDeferReaderCorrection({
        touching: true,
        sinceTouchActivity: 5_000,
      }),
    ).toBe(true);
    expect(
      shouldDeferReaderCorrection({
        touching: false,
        sinceTouchActivity: 40,
      }),
    ).toBe(true);
    expect(
      shouldDeferReaderCorrection({
        touching: false,
        sinceTouchActivity: 400,
      }),
    ).toBe(false);
  });

  test("a deferred correction moves the reader by the entry they are on, not by the anchor they left", () => {
    // Rows p, a, b, c stacked at 0, 500, 1000, 2000; c and d in view when
    // touch takes the scroller. Row a then measures 800px taller.
    const before = new Map([
      ["p", 0],
      ["a", 500],
      ["b", 1000],
      ["c", 2000],
      ["d", 2600],
    ]);
    const after = {
      mounted: new Map([
        ["p", 0],
        ["a", 500],
        ["b", 1800],
        ["c", 2800],
        ["d", 3400],
      ]),
      inView: new Map([
        ["c", 2800],
        ["d", 3400],
      ]),
    };
    const ledger = nextDeferredLedger(null, before, after);
    // Still on c: put c back under them.
    expect(
      deferredReaderCorrection(ledger, { id: "c", contentTop: 2800 }),
    ).toBe(800);
    // Flung on to b or p after that commit with no commit since: b moved
    // while out of view and p never moved; the reader arrived at both where
    // they are now. The banked anchor delta would have thrown them 800px
    // toward the live edge here.
    expect(
      deferredReaderCorrection(ledger, { id: "b", contentTop: 1800 }),
    ).toBe(0);
    expect(deferredReaderCorrection(ledger, { id: "p", contentTop: 0 })).toBe(
      0,
    );
    expect(deferredReaderCorrection(ledger, undefined)).toBe(0);
  });

  test("the ledger adds up movement in view and drops what happened out of view", () => {
    // c in view, displaced 800 by one commit and 300 more by the next.
    let ledger = nextDeferredLedger(null, new Map([["c", 2000]]), {
      mounted: new Map([["c", 2800]]),
      inView: new Map([["c", 2800]]),
    });
    ledger = nextDeferredLedger(ledger, new Map([["c", 2800]]), {
      mounted: new Map([["c", 3100]]),
      inView: new Map([["c", 3100]]),
    });
    expect(
      deferredReaderCorrection(ledger, { id: "c", contentTop: 3100 }),
    ).toBe(1100);
    // The reader flings to b; a commit then measures rows above b while b is
    // in view: b came into view at 1800 before that commit, so the growth
    // since counts, but nothing that moved b earlier does.
    ledger = nextDeferredLedger(
      ledger,
      new Map([
        ["b", 1800],
        ["c", 3100],
      ]),
      {
        mounted: new Map([
          ["b", 2300],
          ["c", 3600],
        ]),
        inView: new Map([["b", 2300]]),
      },
    );
    expect(
      deferredReaderCorrection(ledger, { id: "b", contentTop: 2300 }),
    ).toBe(500);
    // c left the view and is out of the ledger: flinging back to it later
    // lands wherever it is by then.
    expect(
      deferredReaderCorrection(ledger, { id: "c", contentTop: 3600 }),
    ).toBe(0);
  });

  test("a growth that pushes the whole view away still keeps the reader's place", () => {
    // Only c is in view; 3000px of history mounts above it in one commit,
    // so afterwards the view shows a, which was mounted above but out of
    // view. a's position before the commit is the reference: the reader
    // watched it slide down into view.
    const ledger = nextDeferredLedger(
      null,
      new Map([
        ["a", 500],
        ["c", 2000],
      ]),
      {
        mounted: new Map([
          ["a", 3500],
          ["c", 5000],
        ]),
        inView: new Map([["a", 3500]]),
      },
    );
    expect(
      deferredReaderCorrection(ledger, { id: "a", contentTop: 3500 }),
    ).toBe(3000);
    // An entry mounted by this commit has no earlier position: it is where
    // it first appeared.
    const fresh = nextDeferredLedger(null, new Map(), {
      mounted: new Map([["n", 400]]),
      inView: new Map([["n", 400]]),
    });
    expect(deferredReaderCorrection(fresh, { id: "n", contentTop: 400 })).toBe(
      0,
    );
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

  test("skips the measurement diff when the committed list is unchanged", () => {
    const { items, reads } = counted([item(0), item(1), item(2)]);
    // A scroll, resize, or nested measurement commit re-renders against the
    // same immutable list: nothing to remeasure and no row is even read.
    expect(committedTranscriptMeasureKeys(items, items).size).toBe(0);
    expect(reads()).toBe(0);
    // A new list is still diffed row by row.
    expect(
      committedTranscriptMeasureKeys(items, [...items, item(3)]).size,
    ).toBe(1);
    expect(reads()).toBeGreaterThan(0);
  });

  test("finds moved rows after a history prepend and an append", () => {
    const before = [item(2), item(3)];
    const extended = { ...item(3), entryIds: ["entry-3", "tool-result-3"] };
    expect([
      ...committedTranscriptMeasureKeys(before, [
        item(0),
        item(1),
        item(2),
        extended,
        item(4),
      ]),
    ]).toEqual(["block-0", "block-1", "block-3", "block-4"]);
    // Rows that only changed position are still matched by key.
    expect(
      committedTranscriptMeasureKeys(before, [item(3), item(2)]).size,
    ).toBe(0);
    expect(
      committedTranscriptMeasureKeys(before, [item(2), item(3)]).size,
    ).toBe(0);
  });

  test("leaves estimate-only rows out of the synchronous measurement", () => {
    expect(
      committedTranscriptMeasureKeys(
        [item(0)],
        [item(0), { ...item(1), measure: false }],
      ).size,
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
