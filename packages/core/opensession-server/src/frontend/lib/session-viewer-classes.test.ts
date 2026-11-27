import { expect, test } from "bun:test";
import {
  VIEWER_HEADER_ACTIONS,
  VIEWER_INPUT,
  VIEWER_MESSAGES,
} from "./session-viewer-classes";

// The stacking layers, bottom to top (base-theme.css `--layer-*`).
const baseTheme = await Bun.file(
  new URL("../styles/base-theme.css", import.meta.url),
).text();
function layer(name: string): number {
  return Number(new RegExp(`--layer-${name}: (\\d+);`).exec(baseTheme)?.[1]);
}

test("the desktop tab strip cannot cover the header actions", () => {
  expect(VIEWER_HEADER_ACTIONS).toContain("relative z-header-actions");
});

test("the summary card in the header actions clears the chat's sticky prompt", () => {
  // The card is portaled into this row, so the row's step is the card's. The
  // sticky prompt pill over the top of the chat is `z-float`.
  expect(layer("header-actions")).toBeGreaterThan(layer("float"));
});

test("the focused phone composer is fixed close to the keyboard edge", () => {
  // Do not leave placement to Safari's focus pan: anchor the input to the
  // viewport. Fixed bottom already follows the visible keyboard edge, so adding
  // the measured keyboard height again would lift the composer far above it.
  expect(VIEWER_INPUT).toContain("phone:[body.kb-open_&]:fixed");
  expect(VIEWER_INPUT).toContain("phone:[body.kb-open_&]:bottom-0");
  expect(VIEWER_INPUT).toContain("phone:[body.kb-open_&]:pb-2");
  expect(VIEWER_INPUT).not.toContain("var(--kb-inset");
});

test("the focused phone transcript clears the keyboard and complete composer", async () => {
  expect(VIEWER_MESSAGES).toContain("var(--kb-inset,0px)");
  expect(VIEWER_MESSAGES).toContain("var(--viewer-input-height,64px)");

  const reader = await Bun.file(
    new URL("../hooks/useTranscriptReaderController.ts", import.meta.url),
  ).text();
  expect(reader).toContain('"--viewer-input-height"');
  expect(reader).toContain("new ResizeObserver(measure)");
  expect(reader).toContain('observe(viewerInput, { box: "border-box" })');
});
