import { expect, test } from "bun:test";
import { readBaseCss } from "./base-css-test-support";

const HTML = new URL("../index.html", import.meta.url);
const USER_PICKER = new URL("../components/UserPicker.tsx", import.meta.url);
const APP_SHELL = new URL("../components/AppShell.tsx", import.meta.url);
const FIRST_MILE = new URL("../components/FirstMile.tsx", import.meta.url);
const SETTINGS = new URL("../components/Settings.tsx", import.meta.url);
const SETTINGS_CLASSES = new URL("../lib/settings-classes.ts", import.meta.url);

test("Electron titlebar drag regions do not depend on WCO visibility", async () => {
  const [
    html,
    css,
    userPicker,
    appShell,
    firstMile,
    settings,
    settingsClasses,
  ] = await Promise.all([
    Bun.file(HTML).text(),
    readBaseCss(),
    Bun.file(USER_PICKER).text(),
    Bun.file(APP_SHELL).text(),
    Bun.file(FIRST_MILE).text(),
    Bun.file(SETTINGS).text(),
    Bun.file(SETTINGS_CLASSES).text(),
  ]);

  expect(html).toContain("window.os1.desktop === true");
  expect(html).toContain('classList.add("desktop-shell")');
  expect(css).toMatch(
    /html:is\(\.wco, \.desktop-shell\) \.wco-chrome \{\s*-webkit-app-region: drag;/,
  );
  expect(css).toContain(
    "html:is(.wco, .desktop-shell):has(.app-menu-popup:not([hidden])) .wco-chrome",
  );
  expect(css).not.toContain("html.wco:has(.app-menu-popup) .wco-chrome");
  expect(css).toMatch(
    /html:is\(\.wco, \.desktop-shell\)\s+\.app-body\.sidebar-collapsed\s+\.detail-pane\s+\.wco-nav-pane/,
  );
  expect(userPicker).toContain(
    "[html.desktop-shell_&]:[-webkit-app-region:drag]",
  );
  expect(appShell).toContain('className="wco-collapsed-drag-handle"');
  expect(css).toMatch(
    /\.app-body\.sidebar-collapsed\s+\.wco-collapsed-drag-handle/,
  );
  expect(firstMile).toContain(
    'className="wco-chrome relative z-20 flex h-11 shrink-0 items-start justify-center"',
  );
  expect(settings).toContain("!TOOL_SECTIONS.has(active) && (");
  expect(settings).toContain("className={SETTINGS_DRAG_HANDLE}");
  expect(settingsClasses).toContain(
    '"settings-drag-handle wco-chrome absolute inset-x-0 top-0 z-10 h-[var(--desktop-header-h)]"',
  );
  expect(settingsClasses).toContain("`settings-nav flex");
  expect(settingsClasses).toContain('"settings-content flex');
  expect(css).toMatch(
    /html:is\(\.wco, \.desktop-shell\) \.settings-drag-handle \{\s*display: block;/,
  );
  expect(css).toMatch(
    /html:is\(\.wco, \.desktop-shell\) \.settings-nav,\s*html:is\(\.wco, \.desktop-shell\) \.settings-content:not\(\.settings-content-tool\) \{\s*padding-top: var\(--desktop-header-h\);/,
  );
});
