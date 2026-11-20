import { expect, test } from "bun:test";
import { createFilterMenuStore } from "./sidebar-filter-menu";

test("starts closed and toggles open and shut", () => {
  const menu = createFilterMenuStore();
  expect(menu.get()).toBe(false);
  menu.toggle();
  expect(menu.get()).toBe(true);
  menu.toggle();
  expect(menu.get()).toBe(false);
});

test("notifies subscribers only when the value changes", () => {
  const menu = createFilterMenuStore();
  let calls = 0;
  const unsubscribe = menu.subscribe(() => calls++);
  menu.set(false);
  expect(calls).toBe(0);
  menu.set(true);
  menu.set(true);
  expect(calls).toBe(1);
  unsubscribe();
  menu.set(false);
  expect(calls).toBe(1);
});

test("each store is independent", () => {
  const a = createFilterMenuStore();
  const b = createFilterMenuStore();
  a.set(true);
  expect(b.get()).toBe(false);
});
