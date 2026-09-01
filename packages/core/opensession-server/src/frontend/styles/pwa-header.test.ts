import { expect, test } from "bun:test";
import { MOBILE_BACK } from "../lib/app-header-classes";
import { VIEWER_HEADER_ACTIONS } from "../lib/session-viewer-classes";

const CSS = new URL("./base.css", import.meta.url);

test("installed phone header controls use larger foreground icons", async () => {
  const css = await Bun.file(CSS).text();
  const mediaStart = css.indexOf(
    "@media (display-mode: standalone) and (max-width: 720px)",
  );
  const mediaEnd = css.indexOf("\n}\n", mediaStart) + 3;
  const standalonePhone = css.slice(mediaStart, mediaEnd);

  expect(MOBILE_BACK).toContain("pwa-header-back");
  expect(VIEWER_HEADER_ACTIONS).toContain("pwa-header-actions");
  expect(standalonePhone).toContain(".app .pwa-header-back");
  expect(standalonePhone).toContain(".app .pwa-header-actions button");
  expect(standalonePhone).toContain("color: var(--text)");
  expect(standalonePhone).toContain("width: 34px");
  expect(standalonePhone).toContain("width: 25px");
});
