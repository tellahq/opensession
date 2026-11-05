import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WalkthroughCard } from "./WalkthroughCard";

if (!globalThis.localStorage) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {},
  });
}
Object.assign(globalThis.localStorage, {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});

// See TranscriptBlocks.test.tsx: one process, so `window` may already be
// installed (and readonly) by whichever test file ran first. Fill it in.
if (!globalThis.window) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
}
Object.assign(globalThis.window, {
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
});

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
});
