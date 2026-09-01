import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./button";

// What this primitive is FOR, beyond looking like a button: it gives every
// label the cap-band trim, so a word with no descenders does not sit high on
// the plate. That only reaches a plain string child, which is why the two
// slots below exist — a caller who works around their absence by passing an
// element child silently loses the trim, and the hover card's footer is the
// worked example of what that costs.
const TRIMMED = /<span style="[^"]*text-box:trim-both cap alphabetic[^"]*">/;

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
    expect(html).toContain("focus-ring");
    expect(html).toContain("bg-green");
    // An <a> underlines its text by default, so a button that navigates
    // arrives looking like body copy without this. Inert on a <button>,
    // which is why it is easy to leave out and only shows up rendered.
    expect(html).toContain("no-underline");
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
    expect(muted).toContain("opacity-60");
    expect(full).not.toContain("opacity-60");
  });

  test("overlay actions keep standard button behavior on a dark scrim", () => {
    const html = renderToStaticMarkup(
      <Button variant="overlay" icon={<svg />}>
        Download
      </Button>,
    );
    expect(html).toContain("bg-transparent");
    expect(html).toContain("text-white/60");
    expect(html).toContain("hover:bg-white/15");
    expect(html).toContain("focus-ring");
    expect(html).toMatch(TRIMMED);
  });

  test("a caller's fill replaces the variant's, resting and on hover", () => {
    const html = renderToStaticMarkup(
      <Button variant="primary" className="bg-purple hover:bg-purple/90">
        Archive
      </Button>,
    );
    expect(html).toContain("bg-purple");
    expect(html).toContain("hover:bg-purple/90");
    // StyleX resolves property conflicts by composition order, so the caller
    // override must land after the variant fill it replaces.
    expect(html.indexOf("bg-purple")).toBeGreaterThan(
      html.indexOf("bg-accent"),
    );
  });

  test("overriding only the resting fill leaves the variant's hover behind", () => {
    // tailwind-merge resolves per variant modifier, so `bg-purple` alone
    // drops `bg-accent` and keeps `hover:bg-accent-hover` — a purple button
    // that turns accent under the pointer. Worth a test rather than a
    // comment: it looks correct in every screenshot and only shows up live.
    const html = renderToStaticMarkup(
      <Button variant="primary" className="bg-purple">
        Archive
      </Button>,
    );
    expect(html).toContain("hover:bg-accent-hover");
  });
});
