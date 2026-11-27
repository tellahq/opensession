import { expect, test } from "bun:test";
import { isDesignSystemRoute } from "./design-system-route";

test("matches /design-system and rejects unrelated routes", () => {
  expect(isDesignSystemRoute("/design-system")).toBe(true);
  expect(isDesignSystemRoute("/design-system/")).toBe(true);
  expect(isDesignSystemRoute("/")).toBe(false);
  expect(isDesignSystemRoute("/settings")).toBe(false);
  expect(isDesignSystemRoute("/design-system/extra")).toBe(false);
});
