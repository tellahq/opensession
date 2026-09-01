import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { newStylexCollector, stylexCss, stylexTransform } from "./stylex-build";

const ROOT = resolve(import.meta.dir, "../frontend");

function compile(
  name: string,
  source: string,
  collector = newStylexCollector(),
) {
  stylexTransform(`${ROOT}/${name}.tsx`, source, collector);
  return collector;
}

describe("StyleX build", () => {
  test("orders rules by StyleX priority rather than module traversal", () => {
    const collector = newStylexCollector();
    compile(
      "hover-first",
      `import * as stylex from "@stylexjs/stylex";
			 const sx = stylex.create({ a: { ":hover": { color: "blue" } } });
			 export const a = stylex.props(sx.a);`,
      collector,
    );
    compile(
      "base-second",
      `import * as stylex from "@stylexjs/stylex";
			 const sx = stylex.create({ a: { color: "red" } });
			 export const a = stylex.props(sx.a);`,
      collector,
    );
    const css = stylexCss(collector);
    expect(css.indexOf("color:red")).toBeLessThan(css.indexOf(":hover"));
  });

  test("deduplicates identical atomic rules", () => {
    const collector = newStylexCollector();
    const source = `import * as stylex from "@stylexjs/stylex";
		 const sx = stylex.create({ a: { display: "flex" } });
		 export const a = stylex.props(sx.a);`;
    compile("one", source, collector);
    compile("two", source, collector);
    expect(stylexCss(collector).match(/display:flex/g)).toHaveLength(1);
  });
});
