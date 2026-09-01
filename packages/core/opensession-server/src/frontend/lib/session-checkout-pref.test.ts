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

let pref: typeof import("./session-checkout-pref");

beforeAll(async () => {
  pref = await import("./session-checkout-pref");
});

beforeEach(() => store.clear());

describe("per-repository new-session checkout preferences", () => {
  test("uses each repository's default until the person chooses otherwise", () => {
    expect(pref.getSessionCheckoutPref("app")).toBe("default");
    expect(pref.getSessionCheckoutPref("docs")).toBe("default");
  });

  test("stores independent choices for repository ids with punctuation", () => {
    pref.setSessionCheckoutPref("app", "worktree");
    pref.setSessionCheckoutPref("compiler:legacy", "checkout");

    expect(pref.getSessionCheckoutPrefs()).toEqual({
      app: "worktree",
      "compiler:legacy": "checkout",
    });
    expect(pref.getSessionCheckoutPref("app")).toBe("worktree");
    expect(pref.getSessionCheckoutPref("compiler:legacy")).toBe("checkout");
    expect(pref.getSessionCheckoutPref("docs")).toBe("default");
  });

  test("resetting one repository preserves the others and announces the change", () => {
    pref.setSessionCheckoutPref("app", "worktree");
    pref.setSessionCheckoutPref("docs", "checkout");
    let changed = 0;
    const unsubscribe = pref.onSessionCheckoutPrefChanged(() => changed++);
    pref.setSessionCheckoutPref("app", "default");
    unsubscribe();

    expect(pref.getSessionCheckoutPrefs()).toEqual({ docs: "checkout" });
    expect(changed).toBe(1);
  });

  test("ignores malformed entries hydrated into the map", () => {
    store.set(
      "opensession-session-checkouts",
      JSON.stringify({ app: "worktree", docs: "sometimes", empty: null }),
    );
    expect(pref.getSessionCheckoutPrefs()).toEqual({ app: "worktree" });
  });
});
