import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WalkthroughCard } from "./WalkthroughCard";

Object.assign(
  ((
    globalThis as unknown as { localStorage?: Record<string, unknown> }
  ).localStorage ??= {}),
  {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
);
// See TranscriptBlocks.test.tsx: one process, so `window` may already be
// installed (and readonly) by whichever test file ran first. Fill it in.
Object.assign(
  ((globalThis as unknown as { window?: Record<string, unknown> }).window ??=
    {}),
  {
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  },
);

const walkthrough = {
  summary: "The clearer controls make the next action easier to find.",
  publishedAt: "2026-08-11T12:00:00Z",
  publishedBy: "Kent",
  shots: [{ after: "/tmp/after.png" }],
};

describe("WalkthroughCard", () => {
  test("shows the walkthrough in a PR panel", () => {
    const html = renderToStaticMarkup(
      <WalkthroughCard walkthrough={walkthrough} />,
    );
    expect(html).toContain("The clearer controls");
    expect(html).toContain(">After</span>");
    expect(html).not.toContain('class="overflow-hidden"');
  });

  test("folds the inline session walkthrough", () => {
    const html = renderToStaticMarkup(
      <WalkthroughCard walkthrough={walkthrough} variant="session" />,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("by Kent");
    expect(html).toContain("1 still");
    // Folded is not hidden: the card keeps the writeup's first line and the
    // media it explains, so the fold is what hides the rest, not the point.
    expect(html).toContain(">After</span>");
    expect(html).toContain("The clearer controls");
    // StyleX: the fold's three-line clamp renders as the -webkit-line-clamp
    // declaration; the measure is still the session column var.
    expect(html).toContain("-webkit-line-clamp:3");
    expect(html).toContain("var(--session-col)");
    expect(html).not.toContain("transition-[max-width]");
    expect(html).not.toContain("max-w-[min(1120px,100%)]");
  });

  test("shows the media in the folded session walkthrough", () => {
    const html = renderToStaticMarkup(
      <WalkthroughCard
        walkthrough={{
          ...walkthrough,
          video: "/tmp/demo.mp4",
          shots: [{ before: "/tmp/before.png", after: "/tmp/after.png" }],
        }}
        variant="session"
      />,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("/media?path=%2Ftmp%2Fdemo.mp4");
    expect(html).toContain("/media?path=%2Ftmp%2Fbefore.png");
    expect(html).toContain("/media?path=%2Ftmp%2Fafter.png");
  });
});
