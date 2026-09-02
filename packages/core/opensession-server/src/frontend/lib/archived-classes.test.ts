import { expect, test } from "bun:test";
import {
  ARCHIVED_PHONE_SEARCH_DOCK,
  ARCHIVED_ROW,
  ARCHIVED_ROW_ACTION,
  ARCHIVED_SECTION_LABEL,
  ARCHIVED_SWIPE_ACTION,
  ARCHIVED_SWIPE_ROW,
} from "./archived-classes";

test("archived phone search stays at the thumb edge", () => {
  expect(ARCHIVED_PHONE_SEARCH_DOCK).toContain("fixed");
  expect(ARCHIVED_PHONE_SEARCH_DOCK).toContain("bottom-0");
  expect(ARCHIVED_PHONE_SEARCH_DOCK).toContain("safe-area-inset-bottom");
  expect(ARCHIVED_PHONE_SEARCH_DOCK).toContain("phone:block");
});

test("archived day headings sit above the row title scale", () => {
  expect(ARCHIVED_SECTION_LABEL).toContain("text-body");
});

test("archived phone rows reveal Restore instead of reserving a button", () => {
  expect(ARCHIVED_ROW_ACTION).toContain("phone:hidden");
  expect(ARCHIVED_ROW).toContain("phone:px-[18px]");
  expect(ARCHIVED_ROW).toContain("phone:py-4");
  expect(ARCHIVED_ROW).not.toContain("phone:pr-[54px]");
  expect(ARCHIVED_SWIPE_ROW).toContain("[--swipe-action-w:0px]");
  expect(ARCHIVED_SWIPE_ACTION).toContain("data-[open]:opacity-100");
  expect(ARCHIVED_SWIPE_ACTION).toContain("phone:flex");
});
