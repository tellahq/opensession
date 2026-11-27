import { expect, test } from "bun:test";

const popoverSource = await Bun.file(
  new URL("./PrChecksPopover.tsx", import.meta.url),
).text();
const statusBarSource = await Bun.file(
  new URL("./PrStatusBar.tsx", import.meta.url),
).text();
const summarySource = await Bun.file(
  new URL("./WorkspaceSummary.tsx", import.meta.url),
).text();
const popupClassesSource = await Bun.file(
  new URL("../ui/popup-classes.ts", import.meta.url),
).text();
const tokensSource = await Bun.file(
  new URL("../ui/tokens.stylex.ts", import.meta.url),
).text();
const popupStylesSource = await Bun.file(
  new URL("../ui/popup-styles.ts", import.meta.url),
).text();
const menuSource = await Bun.file(
  new URL("../ui/menu.tsx", import.meta.url),
).text();
const tooltipSource = await Bun.file(
  new URL("../ui/tooltip.tsx", import.meta.url),
).text();
const floatingPrimitiveSources = await Promise.all([
  ...["popover.tsx", "select.tsx", "combobox.tsx"].map((file) =>
    Bun.file(new URL(`../ui/${file}`, import.meta.url)).text(),
  ),
  menuSource,
  tooltipSource,
]);
const floatingFeatureSources = await Promise.all(
  ["./useFileMentions.tsx", "./useSlackMentions.tsx"].map((file) =>
    Bun.file(new URL(file, import.meta.url)).text(),
  ),
);

test("shared floating interactions paint above the workspace summary", () => {
  expect(summarySource).toContain('positionerClassName="z-[2147483646]"');
  // One layer token, one step above the summary's 2147483646.
  expect(tokensSource).toContain('floating: "2147483647"');
  expect(popupStylesSource).toContain("layer: { zIndex: layer.floating }");
  expect(popupStylesSource).toContain(
    'positioner: { zIndex: layer.floating, outline: "none" }',
  );
  expect(popupClassesSource).toContain("stylex.props(popup.layer)");
  for (const source of floatingPrimitiveSources) {
    expect(source).toMatch(/popup\.(positioner|layer)/);
  }
  for (const source of floatingFeatureSources) {
    expect(source).toContain("FLOATING_OVERLAY_LAYER");
  }
});

test("active floating interactions escape nested popup portal containers", () => {
  expect(tooltipSource).toContain("document.body");
  expect(menuSource).toContain("<BaseContextMenu.Portal");
  expect(menuSource).toContain("document.body");
});

test("the summary separates its headline from PR metadata", () => {
  const summaryStart = statusBarSource.indexOf('if (variant === "summary")');
  const summaryEnd = statusBarSource.indexOf('if (variant === "header")');
  const summary = statusBarSource.slice(summaryStart, summaryEnd);

  expect(summaryStart).toBeGreaterThan(-1);
  // The headline shares the first row with the action; the PR line runs on
  // under both, so the action never cuts it short.
  expect(summary).toContain("grid grid-cols-[auto_minmax(0,1fr)_auto]");
  expect(summary).toContain("col-span-2 col-start-2 row-start-2");
});

test("the summary's checks preview stays open with its parent", () => {
  const summaryStart = statusBarSource.indexOf('if (variant === "summary")');
  const summaryEnd = statusBarSource.indexOf('if (variant === "header")');
  const summary = statusBarSource.slice(summaryStart, summaryEnd);

  expect(summaryStart).toBeGreaterThan(-1);
  expect(summary).toContain("<PrChecksPopover");
  expect(summary).toContain("nested");
  expect(popoverSource).toContain("<Popover.Root exclusive={!nested}>");
  expect(popoverSource).toContain("document.body");
});
