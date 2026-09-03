import { expect, test } from "bun:test";
import { readBaseCss } from "./base-css-test-support";
const MODAL = new URL("../ui/modal.tsx", import.meta.url);

test("an open palette holds the page behind it still", async () => {
  const css = await readBaseCss();

  // The lock is on the app root, not on body: the palette and the mention
  // popup are portaled outside .app and must keep taking touches.
  expect(css).toMatch(
    /body:has\(\.palette-backdrop:not\(\[hidden\]\)\)\s+\.app\s*\{[^}]*touch-action:\s*none/,
  );
  // touch-action rather than overflow, so no scroller loses its position.
  expect(css).not.toMatch(
    /body:has\(\.palette-backdrop:not\(\[hidden\]\)\)\s+\.app\s*\{[^}]*overflow/,
  );
});

test("the marker the lock keys off is still on every palette backdrop", async () => {
  const modal = await Bun.file(MODAL).text();

  expect(modal).toContain('palette && "palette-backdrop"');
});
