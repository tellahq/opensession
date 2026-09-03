import { describe, expect, test } from "bun:test";
import { readBaseCss } from "./base-css-test-support";
const HTML = new URL("../index.html", import.meta.url);

describe("app viewport", () => {
  test("the app fills its viewport-locked body without remeasuring viewport units", async () => {
    const css = await readBaseCss();
    const root = css.match(/#root\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(css).toMatch(/body\s*\{\s*position:\s*fixed;\s*inset:\s*0;/);
    expect(root).toMatch(/height:\s*100%/);
    expect(root).not.toMatch(/height:\s*100(?:d|l|s)?vh/);
  });

  test("focused text fields release the physical-screen override for keyboard panning", async () => {
    const css = await readBaseCss();

    expect(css).toMatch(
      /html:has\(body\.kb-open\),\s*body\.kb-open\s*\{[^}]*height:\s*100%\s*!important/,
    );
  });

  test("standalone iPhones expand both document roots to the physical screen", async () => {
    const html = await Bun.file(HTML).text();

    expect(html).toContain('matchMedia("(display-mode: standalone)").matches');
    expect(html).toContain('setRootHeight(height + "px")');
    expect(html).toContain("window.screen.height");
  });

  test("a window that stays short gives the forced height back", async () => {
    const html = await Bun.file(HTML).text();

    // Forcing the roots past the visible window is only safe while WebKit
    // answers by growing that window. Without this check the composer sits
    // below the fold on every launch, unreachable by scrolling.
    expect(html).toContain("window.innerHeight >= height - 1");
    expect(html).toContain("standaloneFillTaken = false");
    expect(html).toContain('setRootHeight("")');
    // An open keyboard shrinks the window deliberately, so it must not be
    // read as the correction having failed.
    expect(html).toContain("keyboardOpen()");
  });
});
