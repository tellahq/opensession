import { expect, test } from "bun:test";
import { SETTINGS_PAGE } from "./settings-classes";

test("desktop settings keeps an explicit full-height viewport", () => {
  expect(SETTINGS_PAGE.split(" ")).toContain("h-full");
  expect(SETTINGS_PAGE.split(" ")).toContain("flex-1");
});
