import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as stylex from "@stylexjs/stylex";
import { Button } from "./button";

const layout = stylex.create({
  pushEnd: { marginInlineStart: "auto" },
  recolor: { backgroundColor: "var(--red)" },
});

// The lock is in the type: a Button can be moved, not restyled.
// @ts-expect-error backgroundColor is not a layout property
export const rejected = <Button xstyle={layout.recolor}>Nope</Button>;

// What this primitive is FOR, beyond looking like a button: it gives every
// label the cap-band trim, so a word with no descenders does not sit high on
// the plate. That only reaches a plain string child, which is why the two
// slots below exist — a caller who works around their absence by passing an
// element child silently loses the trim, and the hover card's footer is the
// worked example of what that costs.
// StyleX's test mode names each class after its style key, so these read as
// the style the button applied rather than as a hash.
const TRIMMED = /<span class="[^"]*button__styles\.label[^"]*">/;

describe("Button", () => {
  test("wraps a string label in the cap-band trim", () => {
    expect(renderToStaticMarkup(<Button>Archive</Button>)).toMatch(TRIMMED);
  });

  test("renders as another element without giving up its optics", () => {
    const html = renderToStaticMarkup(
      <Button
        size="sm"
        variant="success-strong"
        render={<a href="https://example.test/pull/1" target="_blank" />}
      >
        Merge
      </Button>,
    );
    // An action that navigates has to be an anchor: middle click and the
    // context menu's copy-link come from the element, not from an onClick.
    expect(html).toStartWith("<a ");
    expect(html).toContain('href="https://example.test/pull/1"');
    // And it is still a button to look at, trim included.
    expect(html).toMatch(TRIMMED);
    // The base carries focus, press and `text-decoration: none`: an <a>
    // underlines its text by default, so a button that navigates arrives
    // looking like body copy without it.
    expect(html).toContain("button__styles.base");
    expect(html).toContain("button__styles.successStrong");
  });

  test("a trailing glyph does not cost the label its trim", () => {
    const html = renderToStaticMarkup(
      <Button trailing={<svg data-testid="arrow" />}>Review</Button>,
    );
    expect(html).toMatch(TRIMMED);
    // After the word, not before it.
    expect(html.indexOf("Review")).toBeLessThan(html.indexOf("<svg"));
  });

  test("can keep a meaningful icon at full strength", () => {
    const muted = renderToStaticMarkup(<Button icon={<svg />}>Add</Button>);
    const full = renderToStaticMarkup(
      <Button icon={<svg />} iconTone="full">
        Add
      </Button>,
    );
    expect(muted).toContain("button__styles.glyphMuted");
    expect(full).not.toContain("button__styles.glyphMuted");
  });

  test("overlay actions keep standard button behavior on a dark scrim", () => {
    const html = renderToStaticMarkup(
      <Button variant="overlay" icon={<svg />}>
        Download
      </Button>,
    );
    expect(html).toContain("button__styles.overlay");
    expect(html).toContain("button__styles.base");
    expect(html).toMatch(TRIMMED);
  });

  test("a caller's className lands after the variant", () => {
    // Coexistence with Tailwind: the StyleX sheet is linked ahead of the
    // utilities, so a caller's class wins a tie by coming later in the
    // cascade, and it is kept verbatim rather than merged away.
    const html = renderToStaticMarkup(
      <Button variant="primary" className="bg-purple hover:bg-purple/90">
        Archive
      </Button>,
    );
    expect(html).toContain(
      'class="button__styles.base button__styles.plainGap button__styles.md button__styles.primary bg-purple hover:bg-purple/90"',
    );
  });

  test("xstyle places the button without restyling it", () => {
    const html = renderToStaticMarkup(
      <Button variant="ghost" xstyle={layout.pushEnd}>
        Archive
      </Button>,
    );
    expect(html).toContain("button__styles.ghost");
    expect(html).toContain("button__layout.pushEnd");
  });
});
