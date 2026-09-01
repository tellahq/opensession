import { describe, expect, test } from "bun:test";
import { AppRouteController, type AppRouteBrowser } from "./useAppRoute";

type HistoryCall =
  | { type: "push" | "replace"; state: unknown; path: string }
  | { type: "go"; delta: number };

type FakeBrowser = {
  browser: AppRouteBrowser;
  calls: HistoryCall[];
  recent: string[];
  scheduledDelays: number[];
  storage: Map<string, string>;
  emitPop(path: string, state?: unknown): void;
  emitPush(url: string): void;
  runTimers(): void;
  setAutoPop(value: boolean): void;
};

function fakeBrowser({
  path = "/",
  state = null,
  user = "Ada",
  stored = {},
}: {
  path?: string;
  state?: unknown;
  user?: string;
  stored?: Record<string, string>;
} = {}): FakeBrowser {
  const origin = "https://app.test";
  const calls: HistoryCall[] = [];
  const recent: string[] = [];
  const storage = new Map(Object.entries(stored));
  const popListeners = new Set<() => void>();
  const timers: Array<{ callback: () => void; delay: number }> = [];
  let pushListener: ((url: string) => void) | undefined;
  let autoPop = false;
  let entries = [{ url: new URL(path, origin), state }];
  let index = 0;

  const location = {
    get href() {
      return entries[index]!.url.href;
    },
    get origin() {
      return origin;
    },
    get pathname() {
      return entries[index]!.url.pathname;
    },
    get search() {
      return entries[index]!.url.search;
    },
    get hash() {
      return entries[index]!.url.hash;
    },
  };
  const applyUrl = (value?: string | URL | null) =>
    value === undefined || value === null
      ? new URL(location.href)
      : new URL(String(value), origin);
  const emitCurrentPop = () => {
    for (const listener of [...popListeners]) listener();
  };

  const history = {
    get state() {
      return entries[index]!.state;
    },
    pushState(
      nextState: unknown,
      _unused: string,
      value?: string | URL | null,
    ) {
      const url = applyUrl(value);
      calls.push({
        type: "push",
        state: nextState,
        path: `${url.pathname}${url.search}${url.hash}`,
      });
      entries = entries.slice(0, index + 1);
      entries.push({ url, state: nextState });
      index += 1;
    },
    replaceState(
      nextState: unknown,
      _unused: string,
      value?: string | URL | null,
    ) {
      const url = applyUrl(value);
      calls.push({
        type: "replace",
        state: nextState,
        path: `${url.pathname}${url.search}${url.hash}`,
      });
      entries[index] = { url, state: nextState };
    },
    go(delta = 0) {
      calls.push({ type: "go", delta });
      const target = index + delta;
      if (!autoPop || target < 0 || target >= entries.length) return;
      index = target;
      emitCurrentPop();
    },
  };

  const browser: AppRouteBrowser = {
    location,
    history,
    storage: {
      getItem(key) {
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        storage.set(key, value);
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    currentUser: () => user,
    recordRecent: (sessionId) => recent.push(sessionId),
    listenForPopState(listener) {
      popListeners.add(listener);
      return () => {
        popListeners.delete(listener);
      };
    },
    listenForPushNavigate(listener) {
      pushListener = listener;
      return () => {
        if (pushListener === listener) pushListener = undefined;
      };
    },
    schedule(callback, delay) {
      timers.push({ callback, delay });
    },
  };

  return {
    browser,
    calls,
    recent,
    get scheduledDelays() {
      return timers.map((timer) => timer.delay);
    },
    storage,
    emitPop(nextPath, nextState = null) {
      const url = new URL(nextPath, origin);
      entries[index] = { url, state: nextState };
      emitCurrentPop();
    },
    emitPush(url) {
      pushListener?.(url);
    },
    runTimers() {
      for (const timer of timers.splice(0)) timer.callback();
    },
    setAutoPop(value) {
      autoPop = value;
    },
  };
}

const remembered = {
  "opensession-last-session": "session-last",
  "opensession-last-session-user": "Ada",
};

describe("initial route", () => {
  test("stamps an unremembered home landing at depth zero", () => {
    const fake = fakeBrowser();
    const controller = new AppRouteController(fake.browser);

    expect(controller.snapshot()).toEqual({
      route: { view: "prs" },
      forceFirstMile: false,
    });
    expect(fake.calls).toEqual([
      { type: "replace", state: { d: 0 }, path: "/" },
    ]);
  });

  test("keeps home beneath a same-user cold restore", () => {
    const fake = fakeBrowser({ stored: remembered });
    const controller = new AppRouteController(fake.browser);

    expect(controller.getCurrentRoute()).toEqual({
      view: "session",
      id: "session-last",
    });
    expect(fake.calls).toEqual([
      { type: "replace", state: { d: 0 }, path: "/" },
      {
        type: "push",
        state: { d: 1, restoredSession: "session-last" },
        path: "/session/session-last",
      },
    ]);
    expect(controller.restoredSessionId).toBe("session-last");
  });

  test("does not restore another user's session", () => {
    const fake = fakeBrowser({ user: "Grace", stored: remembered });
    const controller = new AppRouteController(fake.browser);

    expect(controller.getCurrentRoute()).toEqual({ view: "prs" });
    expect(fake.calls).toHaveLength(1);
  });

  test.each([
    ["/welcome", true],
    ["/?firstmile=1", true],
  ])("preserves first-mile landing %s", (path, forceFirstMile) => {
    const fake = fakeBrowser({ path, stored: remembered });
    const controller = new AppRouteController(fake.browser);

    expect(controller.snapshot()).toEqual({
      route: { view: "prs" },
      forceFirstMile,
    });
    expect(fake.calls).toEqual([]);
  });

  test("treats an unknown path that parses as home as a restorable landing", () => {
    const fake = fakeBrowser({ path: "/unknown", stored: remembered });
    const controller = new AppRouteController(fake.browser);

    expect(controller.getCurrentRoute()).toEqual({
      view: "session",
      id: "session-last",
    });
    expect(fake.calls[0]).toEqual({
      type: "replace",
      state: { d: 0 },
      path: "/unknown",
    });
  });

  test.each([
    "/session/explicit",
    "/workspace/work-1/review",
    "/pr/repo/42",
    "/support/thread-1",
    "/settings/preferences",
    "/archived",
  ])("never replaces explicit deep link %s", (path) => {
    const fake = fakeBrowser({ path, stored: remembered });
    new AppRouteController(fake.browser);
    expect(fake.calls).toEqual([]);
  });
});

describe("navigation history", () => {
  test("pushes different panels and replaces an exact route", () => {
    const fake = fakeBrowser();
    const controller = new AppRouteController(fake.browser);
    fake.calls.length = 0;

    controller.navigate({ view: "session", id: "one" });
    controller.navigate({ view: "session", id: "two" });
    controller.navigate({ view: "session", id: "two" });

    expect(fake.calls).toEqual([
      { type: "push", state: { d: 1 }, path: "/session/one" },
      { type: "push", state: { d: 2 }, path: "/session/two" },
      { type: "replace", state: { d: 2 }, path: "/session/two" },
    ]);
  });

  test("replaces canonical sessions and same-panel refinements", () => {
    const sessionFake = fakeBrowser({
      path: "/workspace/work-1/session/one",
      state: { d: 3 },
    });
    const sessionController = new AppRouteController(sessionFake.browser);
    sessionController.navigate({ view: "session", id: "one" });
    sessionController.navigate({
      view: "session",
      id: "one",
      subagent: ["agent-a"],
    });

    expect(sessionFake.calls).toEqual([
      { type: "replace", state: { d: 3 }, path: "/session/one" },
      {
        type: "replace",
        state: { d: 3 },
        path: "/session/one/subagent/agent-a",
      },
    ]);

    const workspaceFake = fakeBrowser({ path: "/workspace/work-1" });
    const workspaceController = new AppRouteController(workspaceFake.browser);
    workspaceController.navigate({
      view: "workspace",
      id: "work-1",
      tab: "review",
    });
    expect(workspaceFake.calls.at(-1)?.type).toBe("replace");
  });

  test("honors explicit replacement and records root depth zero", () => {
    const fake = fakeBrowser({ path: "/session/one", state: { d: 4 } });
    const controller = new AppRouteController(fake.browser);

    controller.navigate({ view: "session", id: "two" }, { replace: true });
    controller.navigate({ view: "prs" });

    expect(fake.calls).toEqual([
      { type: "replace", state: { d: 4 }, path: "/session/two" },
      { type: "push", state: { d: 0 }, path: "/" },
    ]);
  });

  test("keeps null depth for panels entered without an app root", () => {
    const fake = fakeBrowser({ path: "/session/one" });
    const controller = new AppRouteController(fake.browser);

    controller.navigate({ view: "session", id: "two" });
    expect(fake.calls).toEqual([
      { type: "push", state: null, path: "/session/two" },
    ]);

    controller.goBack();
    expect(fake.calls.at(-1)).toEqual({
      type: "replace",
      state: { d: 0 },
      path: "/",
    });
  });

  test("treats malformed history metadata as a cold deep link", () => {
    const fake = fakeBrowser({
      path: "/session/one",
      state: { d: "3", restoredSession: "one" },
    });
    const controller = new AppRouteController(fake.browser);

    expect(controller.restoredSessionId).toBeUndefined();
    controller.navigate({ view: "session", id: "two" });
    expect(fake.calls.at(-1)).toEqual({
      type: "push",
      state: null,
      path: "/session/two",
    });
  });
});

describe("settings history", () => {
  test("carries the exact opening URL and counts section entries", () => {
    const fake = fakeBrowser({ path: "/session/one?mode=review#reply" });
    const controller = new AppRouteController(fake.browser);

    controller.navigate({ view: "settings" });
    expect(fake.browser.history.state).toEqual({
      d: null,
      settingsReturn: {
        path: "/session/one?mode=review#reply",
        depth: null,
        steps: 1,
      },
    });
    controller.navigate({ view: "settings", section: "preferences" });
    expect(fake.browser.history.state).toEqual({
      d: null,
      settingsReturn: {
        path: "/session/one?mode=review#reply",
        depth: null,
        steps: 2,
      },
    });
    controller.navigate({ view: "settings", section: "preferences" });
    expect(fake.browser.history.state).toEqual({
      d: null,
      settingsReturn: {
        path: "/session/one?mode=review#reply",
        depth: null,
        steps: 2,
      },
    });
  });

  test("restores a settings run in one multi-step pop", () => {
    const fake = fakeBrowser();
    const controller = new AppRouteController(fake.browser);
    controller.start(false);
    controller.navigate({ view: "session", id: "one" });
    controller.navigate({ view: "settings" });
    controller.navigate({ view: "settings", section: "preferences" });
    fake.setAutoPop(true);

    controller.leaveSettings();
    fake.runTimers();

    expect(fake.calls.at(-1)).toEqual({ type: "go", delta: -2 });
    expect(controller.getCurrentRoute()).toEqual({
      view: "session",
      id: "one",
    });
  });

  test("restores exact search and hash immediately after a replaced entry", () => {
    const fake = fakeBrowser({ path: "/session/one?mode=review#reply" });
    const controller = new AppRouteController(fake.browser);
    controller.navigate({ view: "settings" }, { replace: true });

    controller.leaveSettings();

    expect(fake.calls.at(-1)).toEqual({
      type: "replace",
      state: null,
      path: "/session/one?mode=review#reply",
    });
    expect(controller.getCurrentRoute()).toEqual({
      view: "session",
      id: "one",
    });
  });
});

describe("back behavior", () => {
  test("opens a worker session's parent before considering the root", () => {
    const fake = fakeBrowser({ path: "/session/worker", state: { d: 2 } });
    const controller = new AppRouteController(fake.browser);

    controller.goBack("parent");

    expect(controller.getCurrentRoute()).toEqual({
      view: "session",
      id: "parent",
    });
    expect(fake.calls).toEqual([
      { type: "push", state: { d: 3 }, path: "/session/parent" },
    ]);
  });

  test("pops the complete depth to root while leaveDeck pops one entry", () => {
    const rootFake = fakeBrowser();
    const rootController = new AppRouteController(rootFake.browser);
    rootController.start(false);
    rootController.navigate({ view: "session", id: "one" });
    rootController.navigate({ view: "session", id: "two" });
    rootFake.setAutoPop(true);
    rootController.goBack();
    rootFake.runTimers();
    expect(rootFake.calls.at(-1)).toEqual({ type: "go", delta: -2 });
    expect(rootController.getCurrentRoute()).toEqual({ view: "prs" });

    const deckFake = fakeBrowser();
    const deckController = new AppRouteController(deckFake.browser);
    deckController.start(false);
    deckController.navigate({ view: "session", id: "one" });
    deckController.navigate({ view: "catchup" });
    deckFake.setAutoPop(true);
    deckController.leaveDeck();
    deckFake.runTimers();
    expect(deckFake.calls.at(-1)).toEqual({ type: "go", delta: -1 });
    expect(deckController.getCurrentRoute()).toEqual({
      view: "session",
      id: "one",
    });
  });

  test("falls back after 150 ms when a pruned target does not pop", () => {
    const fake = fakeBrowser();
    const controller = new AppRouteController(fake.browser);
    controller.navigate({ view: "session", id: "one" });
    fake.calls.length = 0;

    controller.goBack();
    expect(fake.calls).toEqual([{ type: "go", delta: -1 }]);
    expect(fake.scheduledDelays).toEqual([150]);
    fake.runTimers();

    expect(fake.calls.at(-1)).toEqual({
      type: "replace",
      state: { d: 0 },
      path: "/",
    });
  });
});

describe("external navigation and canonicalization", () => {
  test("reparses popstate and toggles first-mile visibility", () => {
    const fake = fakeBrowser({ path: "/session/one" });
    const controller = new AppRouteController(fake.browser);
    controller.start(false);

    fake.emitPop("/welcome", { d: 0 });
    expect(controller.snapshot()).toEqual({
      route: { view: "prs" },
      forceFirstMile: true,
    });
    fake.emitPop("/workspace/work-1/review", { d: 7 });
    expect(controller.snapshot()).toEqual({
      route: { view: "workspace", id: "work-1", tab: "review" },
      forceFirstMile: false,
    });
    expect(fake.browser.history.state).toEqual({ d: 7 });
  });

  test("routes valid push URLs by pathname and ignores malformed URLs", () => {
    const fake = fakeBrowser();
    const controller = new AppRouteController(fake.browser);
    controller.start(true);

    fake.emitPush("https://notify.test/session/pushed?ignored=1");
    expect(controller.getCurrentRoute()).toEqual({
      view: "session",
      id: "pushed",
    });
    const callCount = fake.calls.length;
    fake.emitPush("http://[");
    expect(fake.calls).toHaveLength(callCount);
  });

  test("does not subscribe to push routing when disabled", () => {
    const fake = fakeBrowser();
    const controller = new AppRouteController(fake.browser);
    controller.start(false);
    fake.emitPush("/session/pushed");
    expect(controller.getCurrentRoute()).toEqual({ view: "prs" });
  });

  test("canonicalizes without replacing the history state object", () => {
    const state = { d: 4, restoredSession: "one", extra: { keep: true } };
    const fake = fakeBrowser({ path: "/session/one", state });
    const controller = new AppRouteController(fake.browser);

    controller.canonicalizePath("/workspace/work-1/session/one");

    expect(fake.browser.history.state).toBe(state);
    expect(fake.calls.at(-1)).toEqual({
      type: "replace",
      state,
      path: "/workspace/work-1/session/one",
    });
    expect(controller.getCurrentRoute()).toEqual({
      view: "session",
      id: "one",
    });
  });
});

describe("first-mile transitions", () => {
  test("required onboarding replaces a deep link and cannot be escaped", () => {
    const fake = fakeBrowser({ path: "/session/one" });
    const controller = new AppRouteController(fake.browser);

    controller.requireFirstMile();

    expect(fake.calls).toEqual([
      { type: "replace", state: { d: 0 }, path: "/welcome" },
    ]);
    expect(controller.snapshot()).toEqual({
      route: { view: "session", id: "one" },
      forceFirstMile: true,
    });
  });

  test("settings-launched onboarding preserves the entry below it", () => {
    const state = { d: 2, settingsReturn: { path: "/", depth: 0, steps: 2 } };
    const fake = fakeBrowser({ path: "/settings", state });
    const controller = new AppRouteController(fake.browser);

    controller.openFirstMile();

    expect(fake.calls).toEqual([{ type: "push", state, path: "/welcome" }]);
    expect(fake.browser.history.state).toBe(state);
  });

  test("completion removes firstmile while preserving other search and hash", () => {
    const fake = fakeBrowser({
      path: "/welcome?firstmile=1&keep=yes#done",
    });
    const controller = new AppRouteController(fake.browser);

    controller.finishFirstMileNavigation();

    expect(fake.calls).toEqual([
      {
        type: "replace",
        state: { d: 0 },
        path: "/?keep=yes#done",
      },
    ]);
    expect(controller.snapshot()).toEqual({
      route: { view: "prs" },
      forceFirstMile: false,
    });
  });

  test("completion keeps a non-welcome route and unrelated URL data", () => {
    const fake = fakeBrowser({
      path: "/session/one?firstmile=1&keep=yes#done",
    });
    const controller = new AppRouteController(fake.browser);

    controller.finishFirstMileNavigation();

    expect(fake.calls).toEqual([
      {
        type: "replace",
        state: { d: 0 },
        path: "/session/one?keep=yes#done",
      },
    ]);
    expect(controller.getCurrentRoute()).toEqual({
      view: "session",
      id: "one",
    });
  });
});

describe("session memory", () => {
  test("records open sessions and clears both keys on home", () => {
    const fake = fakeBrowser({ path: "/session/one" });
    const controller = new AppRouteController(fake.browser);

    controller.rememberRoute();
    expect(fake.storage.get("opensession-last-session")).toBe("one");
    expect(fake.storage.get("opensession-last-session-user")).toBe("Ada");
    expect(fake.recent).toEqual(["one"]);

    controller.navigate({ view: "prs" }, { replace: true });
    controller.rememberRoute();
    expect(fake.storage.has("opensession-last-session")).toBe(false);
    expect(fake.storage.has("opensession-last-session-user")).toBe(false);
  });

  test("distinguishes an automatic archived restore from an explicit link", () => {
    const automaticFake = fakeBrowser({ stored: remembered });
    const automatic = new AppRouteController(automaticFake.browser);
    expect(automatic.restoredSessionId).toBe("session-last");
    automatic.forgetLastSession();
    automatic.navigate({ view: "prs" }, { replace: true });
    expect(automaticFake.storage.has("opensession-last-session")).toBe(false);

    const explicitFake = fakeBrowser({
      path: "/session/session-last",
      stored: remembered,
    });
    const explicit = new AppRouteController(explicitFake.browser);
    expect(explicit.restoredSessionId).toBeUndefined();
    expect(explicit.getCurrentRoute()).toEqual({
      view: "session",
      id: "session-last",
    });
    expect(explicitFake.storage.get("opensession-last-session")).toBe(
      "session-last",
    );
  });

  test("only forgets an archived session when it matches memory", () => {
    const fake = fakeBrowser({ path: "/session/one", stored: remembered });
    const controller = new AppRouteController(fake.browser);

    controller.forgetLastSession(["another"]);
    expect(fake.storage.get("opensession-last-session")).toBe("session-last");
    controller.forgetLastSession(["session-last", "another"]);
    expect(fake.storage.has("opensession-last-session")).toBe(false);
    expect(fake.storage.has("opensession-last-session-user")).toBe(false);
  });
});
