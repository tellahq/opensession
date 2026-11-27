import { expect, test } from "bun:test";
import { SETTINGS_PAGE } from "./settings-classes";

const source = await Bun.file(
  new URL("./settings-classes.ts", import.meta.url),
).text();

test("desktop settings keeps an explicit full-height viewport", () => {
  // StyleX names a class `<file>__<styles>.<key>` under test.
  expect(SETTINGS_PAGE).toContain("settings-classes__styles.page");
  const page = source.slice(source.indexOf("  page: {"));
  const body = page.slice(0, page.indexOf("},"));
  expect(body).toContain('height: "100%"');
  expect(body).toContain('flex: "1 1 0%"');
});
