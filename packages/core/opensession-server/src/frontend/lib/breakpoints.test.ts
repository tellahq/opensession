import { describe, expect, test } from "bun:test";
import { readBaseCss } from "../styles/base-css-test-support";
import { PHONE_QUERY } from "./breakpoints";

const TAILWIND = new URL("../styles/tailwind.css", import.meta.url);

/** The number inside `(max-width: 720px)`, whatever it has been moved to. */
const boundary = Number(PHONE_QUERY.match(/(\d+)px/)?.[1]);

describe("the phone breakpoint is one boundary", () => {
  test("the constant is a max-width query", () => {
    expect(PHONE_QUERY).toMatch(/^\(max-width: \d+px\)$/);
    expect(boundary).toBeGreaterThan(0);
  });

  test("`phone:` markup flips where matchMedia does", async () => {
    const css = await Bun.file(TAILWIND).text();

    expect(css).toContain(`@custom-variant phone (@media ${PHONE_QUERY});`);
  });

  test("`desktop:` is the exact complement, so no width wears neither value", async () => {
    const css = await Bun.file(TAILWIND).text();

    expect(css).toContain(
      `@custom-variant desktop (@media (min-width: ${boundary + 1}px));`,
    );
  });

  test("base.css's own phone blocks agree with the constant", async () => {
    const css = await readBaseCss();
    const widths = [
      ...css.matchAll(/@media[^{]*\(max-width:\s*(\d+)px\)/g),
    ].map((m) => Number(m[1]));

    // Every max-width block in the stylesheet is the page-stack boundary.
    // A new one at a different width is not automatically wrong, but it is a
    // second breakpoint, and this file is the record that the app has one.
    expect(widths.length).toBeGreaterThan(0);
    expect([...new Set(widths)]).toEqual([boundary]);
  });
});
