import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { composerBoxExpanded } from "../lib/composer-classes";
import type { ReplySuggestion } from "../lib/reply-suggestions";
import {
  ACTION_CLEARANCE,
  ACTION_WITH_REPLIES_CLEARANCE,
  SCROLL_ACTION_CLEARANCE,
  SUGGESTIONS_CLEARANCE,
  VIEWER_ACTION_ROW,
  VIEWER_ACTION_ROW_WITH_SCROLL,
  VIEWER_SUGGESTIONS,
  VIEWER_SUGGESTIONS_ROW,
  VIEWER_SUGGESTIONS_ROW_INLINE,
} from "../lib/session-viewer-classes";

const { ReplySuggestions } = await import("./ReplySuggestions");

const suggestions: ReplySuggestion[] = [
  {
    label: "Fix both",
    text: "Fix both the queue race and the stale cache read, then run bun test.",
  },
  { label: "Only step 1", text: "Only fix step 1 for now and stop there." },
];

describe("ReplySuggestions", () => {
  test("shows the short label and carries the full text as the accessible name", () => {
    const html = renderToStaticMarkup(
      <ReplySuggestions suggestions={suggestions} onPick={() => {}} />,
    );

    expect(html).toContain(">Fix both<");
    expect(html).toContain(">Only step 1<");
    // The sentence is what actually lands in the draft, so a screen reader
    // hears it rather than the two-word shorthand.
    expect(html).toContain(
      'aria-label="Fix both the queue race and the stale cache read, then run bun test."',
    );
  });

  test("renders one scrolling row rather than wrapping above the composer", () => {
    const html = renderToStaticMarkup(
      <ReplySuggestions suggestions={suggestions} onPick={() => {}} />,
    );

    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("whitespace-nowrap");
    expect(html).toContain(
      "data-[overflow-end]:[--reply-fade-end:transparent]",
    );
    expect(html).not.toContain("flex-wrap");
  });

  test("the pills start on the composer's own content rail", () => {
    // The row's left padding is the 4px it reserves for the pills' cast
    // shadow plus the composer's own content inset, which is what puts the
    // first pill where the draft it is offering starts. It cannot read that
    // inset as a variable (the composer declares it on itself), so this is
    // what keeps the two from drifting.
    const px = (source: string, pattern: RegExp) =>
      Number(pattern.exec(source)?.[1]);
    const SHADOW_PAD = 4;

    expect(px(VIEWER_SUGGESTIONS_ROW, /(?:^|\s)pl-\[(\d+)px\]/)).toBe(
      SHADOW_PAD +
        px(composerBoxExpanded, /(?:^|\s)\[--composer-inset-left:(\d+)px\]/),
    );
    expect(px(VIEWER_SUGGESTIONS_ROW, /\sphone:pl-\[(\d+)px\]/)).toBe(
      SHADOW_PAD +
        px(composerBoxExpanded, /\sphone:\[--composer-inset-left:(\d+)px\]/),
    );
  });

  test("the transcript keeps clear of whatever the band is carrying", () => {
    // The band floats on the transcript, so the only thing holding the last
    // line of an answer out from under it is this padding. It has to cover
    // the tallest thing in the band plus however far the band stands off the
    // composer, or the standoff eats into the 16px the reading ends on.
    const PILL_HEIGHT = 28; // `h-7` on the chip in ReplySuggestions.
    const SCROLL_HEIGHT = 32; // `min-h-8` on the reading action.
    const NEXT_HEIGHT = 40; // `min-h-10` on the Next button in SessionViewer.
    const NEXT_HEIGHT_PHONE = 48; // `h-12` on the phone action bar.
    const PHONE_ROW_GAP = 8;
    const SPACING_STEP = 4; // Tailwind's px-anchored scale (styles/tailwind.css).
    const standoff =
      Number(/\spb-(\d+(?:\.\d+)?)\s/.exec(VIEWER_SUGGESTIONS)?.[1]) *
      SPACING_STEP;

    expect(standoff).toBeGreaterThan(0);
    expect(SUGGESTIONS_CLEARANCE).toBe(
      `[--suggestions-under:${PILL_HEIGHT + standoff}px]`,
    );
    expect(SCROLL_ACTION_CLEARANCE).toBe(
      `[--suggestions-under:${SCROLL_HEIGHT + standoff}px]`,
    );
    expect(ACTION_CLEARANCE).toContain(
      `[--suggestions-under:${NEXT_HEIGHT + standoff}px]`,
    );
    expect(ACTION_CLEARANCE).toContain(
      `phone:[--suggestions-under:${NEXT_HEIGHT_PHONE + standoff}px]`,
    );
    expect(ACTION_WITH_REPLIES_CLEARANCE).toContain(
      `phone:[--suggestions-under:${PILL_HEIGHT + PHONE_ROW_GAP + NEXT_HEIGHT_PHONE + standoff}px]`,
    );
    expect(ACTION_CLEARANCE).toContain(
      "phone:[body.kb-open_&]:[--suggestions-under:0px]",
    );
    expect(ACTION_WITH_REPLIES_CLEARANCE).toContain(
      `phone:[body.kb-open_&]:[--suggestions-under:${PILL_HEIGHT + standoff}px]`,
    );
  });

  test("desktop keeps Next on the input's right edge", () => {
    expect(VIEWER_ACTION_ROW).toContain("justify-end");
  });

  test("desktop centers the reading action between replies and Next", () => {
    expect(VIEWER_ACTION_ROW_WITH_SCROLL).toContain("desktop:grid");
    expect(VIEWER_ACTION_ROW_WITH_SCROLL).toContain(
      "desktop:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]",
    );
  });

  test("phone stacks chips above the centered action bar", () => {
    expect(VIEWER_ACTION_ROW).toContain("phone:flex-col");
    expect(VIEWER_ACTION_ROW).toContain("phone:gap-2");
    expect(VIEWER_ACTION_ROW).toContain("phone:pr-0");

    // Longer desktop choices still yield rather than push Next off the edge.
    expect(VIEWER_SUGGESTIONS_ROW_INLINE).toContain("min-w-0");
  });

  test("renders nothing at all when there is nothing to suggest", () => {
    expect(
      renderToStaticMarkup(
        <ReplySuggestions suggestions={[]} onPick={() => {}} />,
      ),
    ).toBe("");
  });
});
