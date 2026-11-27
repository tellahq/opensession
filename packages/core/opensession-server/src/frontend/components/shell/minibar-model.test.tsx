import { expect, test } from "bun:test";
import {
  DEFAULT_MINIBAR_ITEMS,
  MINIBAR_ITEM_IDS,
} from "../../lib/minibar-items";
import { MINIBAR_ITEMS } from "./minibar-model";

test("every minibar item has one entry, in the order the bar shows them", () => {
  expect(MINIBAR_ITEMS.map((item) => item.id)).toEqual([...MINIBAR_ITEM_IDS]);
});

test("the bar starts with the places and no pinned page", () => {
  const places = MINIBAR_ITEMS.filter((item) => item.place).map(
    (item) => item.id,
  );
  expect([...DEFAULT_MINIBAR_ITEMS]).toEqual(places);
});

test("a place lights from the place, a page from its route", () => {
  for (const item of MINIBAR_ITEMS) {
    expect(Boolean(item.place) !== Boolean(item.onPage)).toBe(true);
  }
  const prs = MINIBAR_ITEMS.find((item) => item.id === "prs")!;
  expect(prs.onPage?.({ view: "pr", repo: "acme/app", number: 1 })).toBe(true);
  expect(prs.onPage?.({ view: "issues" })).toBe(false);
});
