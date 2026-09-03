import { expect, test } from "bun:test";
import { readBaseCss } from "./base-css-test-support";
import {
  APP_HEADER_ACTIONS,
  ARCHIVED_SEARCH_HEADER,
  HEADER_TITLE_PILL,
  MOBILE_BACK,
  MOBILE_CONTROL_GLASS,
  MOBILE_CONTROL_GLASS_EFFECTS,
  MOBILE_SEARCH_BTN,
  MOBILE_TOP_BAR_CONTROL,
  appHeader,
  mobileFilterBtn,
} from "../lib/app-header-classes";
import { TAB_ITEM, TAB_STRIP, tabClass } from "../lib/session-tab-classes";
import { REPORTS_COLUMN_HEADER } from "../lib/reports-classes";
import {
  infoTopbarClass,
  TRANSCRIPT_PILL_TOP,
} from "../lib/session-viewer-classes";

const sessionViewer = await Bun.file(
  new URL("../components/SessionViewer.tsx", import.meta.url),
).text();

test("phone transcript chrome never changes the scroll viewport", () => {
  const floatingHeader = appHeader({ detail: true, floating: true });

  expect(floatingHeader).toContain("phone:fixed");
  expect(floatingHeader).not.toContain("chrome-collapsed");
  expect(TAB_STRIP).not.toContain("chrome-collapsed");
  expect(TRANSCRIPT_PILL_TOP).not.toContain("chrome-collapsed");
  expect(sessionViewer).not.toContain("chrome-collapsed");
});

test("phone top-bar actions use neutral ink", () => {
  expect(MOBILE_TOP_BAR_CONTROL).toContain("phone:[&_svg]:size-[26px]");
  expect(MOBILE_BACK).toContain(MOBILE_TOP_BAR_CONTROL);
  expect(MOBILE_BACK).toContain("phone:[&_svg]:size-[34px]");
  for (const control of [
    MOBILE_TOP_BAR_CONTROL,
    MOBILE_BACK,
    MOBILE_SEARCH_BTN,
    mobileFilterBtn(true),
  ]) {
    expect(control).toContain("phone:text-fg");
    expect(control).not.toContain("phone:text-accent");
  }
  expect(mobileFilterBtn(false)).toContain("phone:text-dim");
});

test("phone navigation chrome has no hard divider bars", async () => {
  const css = await readBaseCss();

  expect(css).not.toMatch(
    /@media \(display-mode: standalone\)\s*\{\s*\.app\s*\{\s*border-top:/,
  );
  expect(TAB_STRIP).not.toContain("phone:border-b");
  expect(TAB_STRIP).not.toContain("phone:shadow-[");
  expect(TAB_STRIP).toContain("phone:bg-transparent");
  expect(TAB_ITEM).toContain("phone:after:hidden");
  expect(infoTopbarClass(true)).not.toContain("border-b");
  expect(infoTopbarClass(false)).not.toContain("border-b");
  expect(REPORTS_COLUMN_HEADER).not.toMatch(/(?<!desktop:)border-b/);
});

test("archived search focus collapses the phone header without clipping its shadow", () => {
  expect(ARCHIVED_SEARCH_HEADER).not.toContain("overflow-hidden");
  expect(ARCHIVED_SEARCH_HEADER).toContain("safe-area-inset-top,0px),16px");
  expect(ARCHIVED_SEARCH_HEADER).toContain("+60px");
  expect(ARCHIVED_SEARCH_HEADER).toContain("phone:[body.kb-open_&]:h-0!");
  expect(ARCHIVED_SEARCH_HEADER).toContain("phone:[body.kb-open_&]:opacity-0");
  expect(ARCHIVED_SEARCH_HEADER).toContain(
    "phone:transition-[height,padding-top,opacity,transform]",
  );
  expect(ARCHIVED_SEARCH_HEADER).toContain("motion-reduce:transition-none");
});

test("every floating phone header control is made of the same glass", async () => {
  const css = await readBaseCss();

  // The prefixed spelling is the whole point on iOS Safari and the installed
  // PWA, which still ship backdrop-filter only under `-webkit-`.
  expect(MOBILE_CONTROL_GLASS).toContain(
    "phone:[-webkit-backdrop-filter:var(--mobile-header-control-blur)]",
  );
  for (const control of [MOBILE_BACK, HEADER_TITLE_PILL, APP_HEADER_ACTIONS]) {
    expect(control).toContain(MOBILE_CONTROL_GLASS);
    // A page-coloured fill is what made these read as paper stickers.
    expect(control).not.toContain("phone:bg-surface");
  }

  const inactiveTab = tabClass({
    active: false,
    waiting: false,
    colored: false,
  });
  const activeTab = tabClass({ active: true, waiting: false, colored: false });
  // Both phone states are blurred pills, and both fills are OPAQUE: the
  // selected tab is the bright plate, the rest the grey a step under it.
  // A thinned fill here let the transcript read through the tab labels.
  expect(inactiveTab).toContain(MOBILE_CONTROL_GLASS_EFFECTS);
  expect(inactiveTab).toContain("phone:bg-[var(--mobile-tab-surface)]");
  expect(activeTab).toContain(MOBILE_CONTROL_GLASS_EFFECTS);
  expect(activeTab).toContain("phone:bg-[var(--mobile-tab-surface-selected)]");
  expect(css).toContain("--mobile-tab-surface-selected: var(--bg-hover);");
  expect(css).toContain("--mobile-tab-surface-selected: var(--bg);");
  expect(css).toContain("--mobile-tab-surface: var(--bg-raised);");
  expect(css).toContain("--mobile-tab-surface: var(--bg-hover);");
  expect(css).not.toContain("--mobile-tab-surface: color-mix(");

  const floatingHeader = appHeader({ detail: false, floating: true });
  expect(floatingHeader).not.toContain("]:bg-surface");
  expect(floatingHeader).toContain(
    "phone:[.app:has(.session-tabs)_&]:before:h-full",
  );

  // Glass is an enhancement: both opt-outs collapse the fill back to opaque.
  const optOuts = css.match(/--mobile-header-control-surface: var\(--bg\);/g);
  expect(optOuts?.length).toBe(2);
});
