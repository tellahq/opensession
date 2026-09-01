import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  newStylexCollector,
  stylexCss,
  stylexTransform,
} from "../../server/stylex-build";
import { PageLoader } from "./page-loader";

const source = new URL("./spinner.tsx", import.meta.url).pathname;
const motionSource = new URL("../styles/animations.stylex.ts", import.meta.url)
  .pathname;
const collector = newStylexCollector();
stylexTransform(motionSource, readFileSync(motionSource, "utf8"), collector);
stylexTransform(source, readFileSync(source, "utf8"), collector);
const css = stylexCss(collector);

test("page loading uses the larger round spinner", () => {
  const html = renderToStaticMarkup(<PageLoader className="loader-hook" />);
  // The size geometry (size-5 = 20px, the ring's border and shape) rides the
  // utility compatibility map, so it surfaces as source spellings in markup
  // at test time rather than as collector CSS declarations.
  expect(html).toContain("size-5");
  expect(html).toContain("border-2");
  expect(html).toContain("rounded-full");
  expect(css).toContain("animation-duration:1s");
  expect(css).toContain("animation-timing-function:linear");
  expect(html).toContain("loader-hook");
  expect(html.match(/<span/g)).toHaveLength(1);
});
