import { beforeEach, expect, mock, test } from "bun:test";

const store = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();
let currentUser = "Alex";
const serverPrefs = new Map<string, Record<string, string>>();
const saved: Array<{ user: string; prefs: Record<string, string> }> = [];

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    addEventListener: (type: string, listener: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) =>
      void listeners.get(type)?.delete(listener),
    dispatchEvent: (event: Event) => {
      for (const listener of listeners.get(event.type) ?? []) listener();
      return true;
    },
  },
});

mock.module("./api", () => ({
  fetchUiPrefs: async (user: string) => serverPrefs.get(user) ?? {},
  saveUiPrefsApi: async (user: string, prefs: Record<string, string>) => {
    saved.push({ user, prefs });
  },
}));
mock.module("../components/UserPicker", () => ({
  getCurrentUser: () => currentUser,
}));
mock.module("./auth-ready", () => ({ whenCurrentUserReady: () => {} }));

const { makeUserPref } = await import("./user-pref");

function switchUser(user: string) {
  currentUser = user;
  window.dispatchEvent(new Event("opensession-user-changed"));
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makePref(name: string, perUser: boolean) {
  return makeUserPref<boolean>({
    localKey: `test-${name}`,
    prefKey: name,
    changeEvent: `test-${name}-changed`,
    defaultValue: false,
    decode: (v) => (v === "on" ? true : v === "off" ? false : null),
    encode: (on) => (on ? "on" : "off"),
    perUser,
  });
}

beforeEach(() => {
  store.clear();
  saved.length = 0;
  serverPrefs.clear();
  currentUser = "Alex";
});

test("a per-person preference is not handed to the next person", async () => {
  const pref = makePref("scoped", true);
  pref.set(true);
  expect(pref.get()).toBe(true);
  saved.length = 0;

  await switchUser("Sam");
  expect(pref.get()).toBe(false);
  expect(saved).toEqual([]);

  await switchUser("Alex");
  expect(pref.get()).toBe(true);
});

test("a per-person preference takes the server's value for that person", async () => {
  const pref = makePref("scoped-server", true);
  serverPrefs.set("Sam", { "scoped-server": "on" });
  let changes = 0;
  pref.onChanged(() => changes++);

  await switchUser("Sam");
  expect(pref.get()).toBe(true);
  expect(changes).toBeGreaterThan(0);

  await switchUser("Alex");
  expect(pref.get()).toBe(false);
});

test("a browser-wide preference still carries its cached value up", async () => {
  const pref = makePref("shared", false);
  pref.set(true);
  saved.length = 0;

  await switchUser("Sam");
  expect(pref.get()).toBe(true);
  expect(saved).toEqual([{ user: "Sam", prefs: { shared: "on" } }]);
});
