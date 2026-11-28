import { expect, test } from "bun:test";
import { newestTs, unseenCount } from "./channel-activity-model";

const items = ["5.0", "9.5", "7.1"].map((ts) => ({ message: { ts } }));

test("counts the mentions after the last one seen", () => {
  expect(unseenCount(items, null)).toBe(3);
  expect(unseenCount(items, "7.0")).toBe(2);
  expect(unseenCount(items, "9.5")).toBe(0);
  expect(unseenCount(items, null, 2)).toBe(2);
});

test("the newest mention is what Activity marks seen", () => {
  expect(newestTs(items)).toBe("9.5");
  expect(newestTs([])).toBeUndefined();
});
