import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Submenus stay open while the pointer travels diagonally toward them, because
 * Base UI drives `Menu.SubmenuTrigger` with floating-ui's `safePolygon`: leaving
 * the trigger row is forgiven as long as the cursor is inside a wedge aimed at
 * the submenu. Stock, that wedge is guarded by a 40ms timer meant to catch a
 * cursor that comes to REST inside it. Every pointer event clears and re-arms
 * the timer, so the guard is really "have pointer events stopped arriving" — and
 * on a busy main thread ours arrive 55-65ms apart, which tripped it mid-traverse.
 * The submenu being aimed at closed and the row under the cursor opened its own.
 *
 * patches/@base-ui%2Freact@1.6.0.patch raises that grace period. This test reads
 * the installed package so a Base UI upgrade that drops the patch fails here
 * rather than as a submenu that flickers shut for people on slower machines.
 */
const GRACE_MS_MIN = 100;

test("Base UI's safe-polygon grace period survives our pointer-event cadence", () => {
  // safePolygon is internal, so it has no exports entry to resolve directly:
  // find the package root through a part that does.
  const packageRoot = dirname(dirname(require.resolve("@base-ui/react/menu")));
  const source = readFileSync(
    join(packageRoot, "floating-ui-react", "safePolygon.mjs"),
    "utf8",
  );
  const match = source.match(/timeout\.start\((\d+),\s*closeIfNoOpenChild\)/);
  expect(
    match,
    "safePolygon no longer arms a timer named closeIfNoOpenChild — re-read the upstream source and re-cut patches/@base-ui%2Freact@1.6.0.patch",
  ).not.toBeNull();
  const graceMs = Number(match![1]);
  expect(
    graceMs,
    `safe-polygon grace period is ${graceMs}ms; below ${GRACE_MS_MIN}ms a dropped frame closes the submenu the pointer is aiming at. Re-apply patches/@base-ui%2Freact@1.6.0.patch for the installed Base UI version.`,
  ).toBeGreaterThanOrEqual(GRACE_MS_MIN);
});
