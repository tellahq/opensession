import { expect, test } from "bun:test";
import { readBaseCss } from "./base-css-test-support";

test("supporting text is selectable outside controls", async () => {
  const css = await readBaseCss();

  expect(css).toMatch(
    /\.text-supporting,\s*input,[^{]+\{[^}]*user-select:\s*text;/,
  );
});
