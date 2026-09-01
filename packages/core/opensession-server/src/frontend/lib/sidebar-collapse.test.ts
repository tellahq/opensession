import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  SIDEBAR_COLLAPSED_KEY,
  sidebarStartsCollapsed,
  storeSidebarCollapsed,
} from "./sidebar-collapse";

const stored = new Map<string, string>();
let previous: PropertyDescriptor | undefined;

beforeEach(() => {
  stored.clear();
  previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    },
  });
});

afterEach(() => {
  if (previous) Object.defineProperty(globalThis, "localStorage", previous);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("desktop sidebar preference", () => {
  test("defaults open for a new browser", () => {
    expect(sidebarStartsCollapsed()).toBe(false);
  });

  test("preserves an explicit open or closed choice", () => {
    storeSidebarCollapsed(false);
    expect(stored.get(SIDEBAR_COLLAPSED_KEY)).toBe("0");
    expect(sidebarStartsCollapsed()).toBe(false);

    storeSidebarCollapsed(true);
    expect(stored.get(SIDEBAR_COLLAPSED_KEY)).toBe("1");
    expect(sidebarStartsCollapsed()).toBe(true);
  });
});
