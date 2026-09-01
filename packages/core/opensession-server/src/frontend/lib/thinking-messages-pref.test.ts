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

let pref: typeof import("./thinking-messages-pref");

beforeAll(async () => {
  pref = await import("./thinking-messages-pref");
});

beforeEach(() => store.clear());

describe("Thinking messages preference", () => {
  test("defaults to the latest thinking message", () => {
    expect(pref.getThinkingMessagesPref()).toBe("latest");
  });

  test("stores an explicit mode and notifies mounted transcripts", () => {
    let changed = 0;
    const unsubscribe = pref.onThinkingMessagesChanged(() => changed++);
    pref.setThinkingMessagesPref("all");
    unsubscribe();

    expect(pref.getThinkingMessagesPref()).toBe("all");
    expect(store.get("opensession-thinking-messages")).toBe("all");
    expect(changed).toBe(1);
  });
});
