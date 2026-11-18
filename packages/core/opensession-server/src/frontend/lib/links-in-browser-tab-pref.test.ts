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

let pref: typeof import("./links-in-browser-tab-pref");
let read: typeof import("./links-in-browser-tab");

beforeAll(async () => {
  pref = await import("./links-in-browser-tab-pref");
  read = await import("./links-in-browser-tab");
});
beforeEach(() => store.clear());

describe("Open links in the Browser tab", () => {
  test("is on until someone turns it off", () => {
    expect(pref.getLinksInBrowserTabPref()).toBe(true);
    expect(read.linksInBrowserTab()).toBe(true);
    store.set("opensession-links-in-browser-tab", "invalid");
    expect(pref.getLinksInBrowserTabPref()).toBe(true);
  });

  test("turning it off is stored and announced", () => {
    let changed = 0;
    const unsubscribe = pref.onLinksInBrowserTabChanged(() => changed++);
    pref.setLinksInBrowserTabPref(false);
    unsubscribe();

    expect(pref.getLinksInBrowserTabPref()).toBe(false);
    expect(read.linksInBrowserTab()).toBe(false);
    expect(store.get("opensession-links-in-browser-tab")).toBe("off");
    expect(changed).toBe(1);
  });

  test("turning it back on drops the stored value", () => {
    pref.setLinksInBrowserTabPref(false);
    pref.setLinksInBrowserTabPref(true);
    expect(pref.getLinksInBrowserTabPref()).toBe(true);
    expect(store.has("opensession-links-in-browser-tab")).toBe(false);
  });
});
