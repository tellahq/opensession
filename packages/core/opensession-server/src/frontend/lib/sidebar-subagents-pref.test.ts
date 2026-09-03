import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

const store = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
  window: {
    addEventListener(type: string, handler: () => void) {
      const handlers = listeners.get(type) ?? new Set();
      handlers.add(handler);
      listeners.set(type, handlers);
    },
    removeEventListener(type: string, handler: () => void) {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent(event: { type: string }) {
      for (const handler of listeners.get(event.type) ?? []) handler();
    },
  },
  Event: class {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  },
  fetch: () => Promise.reject(new Error("offline in tests")),
});

let pref: typeof import("./sidebar-subagents-pref");

beforeAll(async () => {
  pref = await import("./sidebar-subagents-pref");
});

beforeEach(() => store.clear());

describe("sidebar sub-agents preference", () => {
  test("defaults to showing sub-agents", () => {
    expect(pref.getSidebarSubagentsPref()).toBe(true);
  });

  test("can hide sub-agents and notifies mounted views", () => {
    let changed = 0;
    const unsubscribe = pref.onSidebarSubagentsChanged(() => changed++);
    pref.setSidebarSubagentsPref(false);
    unsubscribe();

    expect(pref.getSidebarSubagentsPref()).toBe(false);
    expect(store.get("opensession-sidebar-subagents")).toBe("hide");
    expect(changed).toBe(1);
  });
});
