import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

const store = new Map<string, string>();
const events = new EventTarget();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
  window: events,
  fetch: () => Promise.reject(new Error("offline in tests")),
});

let pref: typeof import("./agentation-pref");

beforeAll(async () => {
  pref = await import("./agentation-pref");
});
beforeEach(() => store.clear());

describe("Agentation preference", () => {
  test("defaults to enabled without changing the instance opt-in", () => {
    expect(pref.getAgentationPref()).toBe(true);
  });

  test("reads stored choices and ignores invalid values", () => {
    store.set("opensession-agentation", "off");
    expect(pref.getAgentationPref()).toBe(false);
    store.set("opensession-agentation", "on");
    expect(pref.getAgentationPref()).toBe(true);
    store.set("opensession-agentation", "invalid");
    expect(pref.getAgentationPref()).toBe(true);
  });

  test("disabling notifies the mounted toolbar and settings", () => {
    let changed = 0;
    const unsubscribe = pref.onAgentationChanged(() => changed++);
    pref.setAgentationPref(false);
    unsubscribe();

    expect(pref.getAgentationPref()).toBe(false);
    expect(store.get("opensession-agentation")).toBe("off");
    expect(changed).toBe(1);
    pref.setAgentationPref(true);
    expect(changed).toBe(1);
  });

  test("re-enabling restores the default cached state", () => {
    pref.setAgentationPref(false);
    pref.setAgentationPref(true);
    expect(pref.getAgentationPref()).toBe(true);
    expect(store.has("opensession-agentation")).toBe(false);
  });
});
