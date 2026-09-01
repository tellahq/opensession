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

let pref: typeof import("./next-chat-pref");

beforeAll(async () => {
  pref = await import("./next-chat-pref");
});

beforeEach(() => store.clear());

describe("Next chat button preference", () => {
  test("defaults on for accounts without a stored preference", () => {
    expect(pref.getNextChatButtonPref()).toBe(true);
  });

  test("an explicit off value hides the button and notifies mounted views", () => {
    let changed = 0;
    const unsubscribe = pref.onNextChatButtonChanged(() => changed++);
    pref.setNextChatButtonPref(false);
    unsubscribe();

    expect(pref.getNextChatButtonPref()).toBe(false);
    expect(store.get("opensession-next-chat-button")).toBe("off");
    expect(changed).toBe(1);
  });
});
