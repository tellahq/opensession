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

describe("new-session checkout preferences", () => {
  test("uses repository defaults until the person chooses otherwise", () => {
    expect(pref.sessionCheckoutDefault(pref.getSessionCheckoutPrefs())).toBe(
      "default",
    );
    expect(pref.getSessionCheckoutPref("app")).toBe("default");
    expect(pref.getSessionCheckoutPref("docs")).toBe("default");
  });

  test("applies one default to every repository", () => {
    pref.setSessionCheckoutDefault("worktree");

    expect(pref.getSessionCheckoutPrefs()).toEqual({ "*": "worktree" });
    expect(pref.getSessionCheckoutPref("app")).toBe("worktree");
    expect(pref.getSessionCheckoutPref("docs")).toBe("worktree");
  });

  test("stores independent overrides for repository ids with punctuation", () => {
    pref.setSessionCheckoutDefault("worktree");
    pref.setSessionCheckoutPref("app", "checkout");
    pref.setSessionCheckoutPref("compiler:legacy", "checkout");

    expect(pref.getSessionCheckoutPrefs()).toEqual({
      "*": "worktree",
      app: "checkout",
      "compiler:legacy": "checkout",
    });
    expect(pref.getSessionCheckoutPref("app")).toBe("checkout");
    expect(pref.getSessionCheckoutPref("compiler:legacy")).toBe("checkout");
    expect(pref.getSessionCheckoutPref("docs")).toBe("worktree");
  });

  test("resetting one override preserves the others and announces the change", () => {
    pref.setSessionCheckoutPref("app", "worktree");
    pref.setSessionCheckoutPref("docs", "checkout");
    let changed = 0;
    const unsubscribe = pref.onSessionCheckoutPrefChanged(() => changed++);
    pref.setSessionCheckoutPref("app", "default");
    unsubscribe();

    expect(pref.getSessionCheckoutPrefs()).toEqual({ docs: "checkout" });
    expect(changed).toBe(1);
  });

  test("changing the default drops overrides that now match it", () => {
    pref.setSessionCheckoutPref("app", "worktree");
    pref.setSessionCheckoutPref("docs", "checkout");
    pref.setSessionCheckoutDefault("worktree");

    expect(pref.getSessionCheckoutPrefs()).toEqual({
      "*": "worktree",
      docs: "checkout",
    });
  });

  test("keeps valid choices from the older per-repository map", () => {
    store.set(
      "opensession-session-checkouts",
      JSON.stringify({ app: "worktree", docs: "sometimes", empty: null }),
    );

    expect(pref.getSessionCheckoutPrefs()).toEqual({ app: "worktree" });
    expect(pref.getSessionCheckoutPref("app")).toBe("worktree");
    expect(pref.getSessionCheckoutPref("docs")).toBe("default");
  });
});
