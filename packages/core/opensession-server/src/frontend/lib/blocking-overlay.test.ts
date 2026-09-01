// The one thing this guard has to keep doing: ask whether an overlay is OPEN,
// not whether its element exists. Dropping `:not([hidden])` is a silent,
// app-wide regression (every window-level chord stops firing, nothing throws),
// and it is exactly the edit a later cleanup makes while shortening the
// selector, so it is pinned here rather than left to review.
//
// There is no DOM preload in this repo (see lib/shortcuts.test.ts), so the
// root is a stand-in that records what it was asked.

import { describe, expect, test } from "bun:test";
import {
  BLOCKING_OVERLAY_SELECTOR,
  blockingOverlayOpen,
} from "./blocking-overlay";

const MARKERS = [
  ".palette-backdrop",
  ".composer-schedule-modal-backdrop",
  ".session-delete-overlay",
];

function root(match: unknown): ParentNode {
  return {
    querySelector: (selector: string) => {
      asked = selector;
      return match;
    },
  } as unknown as ParentNode;
}
let asked = "";

describe("blockingOverlayOpen", () => {
  // The Desk keeps its palette mounted, so every marker is in the DOM from
  // boot carrying `hidden`. Without this qualifier the guard is true forever.
  test("every marker requires the element to be rendered", () => {
    for (const marker of MARKERS) {
      expect(BLOCKING_OVERLAY_SELECTOR).toContain(`${marker}:not([hidden])`);
    }
  });

  test("no marker appears unqualified", () => {
    for (const marker of MARKERS) {
      // Each name must be followed by the qualifier everywhere it occurs.
      const occurrences = BLOCKING_OVERLAY_SELECTOR.split(marker).length - 1;
      const qualified =
        BLOCKING_OVERLAY_SELECTOR.split(`${marker}:not([hidden])`).length - 1;
      expect(qualified).toBe(occurrences);
    }
  });

  test("reports what the root found", () => {
    expect(blockingOverlayOpen(root(null))).toBe(false);
    expect(blockingOverlayOpen(root({}))).toBe(true);
    expect(asked).toBe(BLOCKING_OVERLAY_SELECTOR);
  });
});
