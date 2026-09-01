import { expect, test } from "bun:test";

const CSS = new URL("./base.css", import.meta.url);

test("supporting text is selectable outside controls", async () => {
  const css = await Bun.file(CSS).text();

  expect(css).toMatch(
    /\.text-supporting,\s*input,[^{]+\{[^}]*user-select:\s*text;/,
  );
});
