import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readBaseCss } from "./base-css-test-support";

/**
 * Guards the one scrollbar rule that cannot be checked by looking at the app
 * on this machine.
 *
 * Chrome on a Mac that draws overlay scrollbars reserves no width for them, so
 * the app has no gutter there. `::-webkit-scrollbar` replaces the platform
 * scrollbar with a custom one, and a custom scrollbar is never an overlay:
 * giving it a width takes 8px out of every panel for those users, while every
 * Linux and Windows browser (and every screenshot taken on this VPS) looks
 * exactly the same before and after. Hiding through that pseudo-element stays
 * fine, because a hidden bar reserves nothing.
 */
const ROOT = new URL("..", import.meta.url).pathname;

async function frontendSources() {
  const glob = new Glob("**/*.{ts,tsx,css}");
  const files: { path: string; text: string }[] = [];
  for await (const rel of glob.scan({ cwd: ROOT })) {
    if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
    files.push({ path: rel, text: await Bun.file(`${ROOT}${rel}`).text() });
  }
  return files;
}

describe("scrollbar policy", () => {
  test("base.css thins every scrollbar with the standard properties", async () => {
    const css = await readBaseCss();
    expect(css).toMatch(/\*\s*\{[^}]*scrollbar-width:\s*thin/);
    expect(css).toMatch(
      /scrollbar-color:\s*var\(--scrollbar-thumb\)\s+transparent/,
    );
    // Both themes have to name a thumb, or one of them falls back to the
    // platform grey and reads as a foreign patch.
    expect(css).toMatch(/--scrollbar-thumb:\s*rgba\(255, 255, 255/);
    expect(css).toMatch(/--scrollbar-thumb:\s*rgba\(0, 0, 0/);
  });

  test("nothing gives a -webkit-scrollbar a size", async () => {
    const offenders: string[] = [];
    for (const { path, text } of await frontendSources()) {
      // Utility form: [&::-webkit-scrollbar]:<utility>
      for (const match of text.matchAll(
        /\[&::-webkit-scrollbar(?:-[a-z]+)?\]:([\w[\]().%-]+)/g,
      )) {
        if (match[1] !== "hidden") offenders.push(`${path}: ${match[0]}`);
      }
      // Stylesheet form: ::-webkit-scrollbar { … width/height … }
      for (const match of text.matchAll(
        /::-webkit-scrollbar(?:-[a-z]+)?[^{]*\{([^}]*)\}/g,
      )) {
        if (
          /(?:^|;|\s)(?:width|height|min-width|min-height)\s*:/.test(match[1])
        )
          offenders.push(`${path}: ${match[0].replace(/\s+/g, " ").trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
