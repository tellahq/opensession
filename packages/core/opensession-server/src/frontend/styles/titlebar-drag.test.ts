import { expect, test } from "bun:test";
import { readBaseCss } from "./base-css-test-support";

const HTML = new URL("../index.html", import.meta.url);
const USER_PICKER = new URL("../components/UserPicker.tsx", import.meta.url);
const APP_SHELL = new URL("../components/AppShell.tsx", import.meta.url);
const FIRST_MILE = new URL("../components/FirstMile.tsx", import.meta.url);
const SETTINGS_CLASSES = new URL("../lib/settings-classes.ts", import.meta.url);

test("Electron titlebar drag regions do not depend on WCO visibility", async () => {
  const [html, css, userPicker, appShell, firstMile, settingsClasses] =
    await Promise.all([
      Bun.file(HTML).text(),
      readBaseCss(),
      Bun.file(USER_PICKER).text(),
      Bun.file(APP_SHELL).text(),
      Bun.file(FIRST_MILE).text(),
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
  // The header stays draggable with the sidebar collapsed; the floating
  // controls carve themselves out by following it in document order.
  expect(css).not.toMatch(/\.sidebar-collapsed\s+\.wco-chrome\s*\{/);
  expect(appShell.indexOf("{children}")).toBeLessThan(
    appShell.indexOf("<TitleBar pane />"),
  );
  expect(firstMile).toContain(
    'className="wco-chrome relative z-float flex h-11 shrink-0 items-start justify-center"',
  );
  // Settings is a modal inset under the titlebar row, so the window stays
  // draggable above it; base-platform.css reads the plain class hook.
  expect(settingsClasses).toContain('cn("settings-modal", sx(styles.modal))');
  expect(css).toMatch(
    /html:is\(\.wco, \.desktop-shell\) \.settings-modal \{\s*padding-top: var\(--desktop-header-h\);/,
  );
});
