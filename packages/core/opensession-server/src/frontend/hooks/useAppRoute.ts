import { useEffect, useLayoutEffect, useState } from "react";
import {
  firstMileRequested,
  isSettingsRoute,
  parseRoute,
  routePath,
  samePanel,
  type Route,
} from "../lib/app-route";
import { BASE_PATH, stripBasePath } from "../lib/base";
import { onPushNavigate } from "../lib/push";
import { pushRecent } from "../lib/recents";
import {
  settingsReturnForNavigation,
  type SettingsReturn,
} from "../lib/settings-navigation";

const LAST_SESSION_KEY = "opensession-last-session";
const LAST_SESSION_USER_KEY = "opensession-last-session-user";
const POP_FALLBACK_MS = 150;

type NavState = {
  d: number | null;
  settingsReturn?: SettingsReturn;
  /** Identifies a session opened automatically during a PWA cold restore. */
  restoredSession?: string;
} | null;

type RouteLocation = {
  readonly href: string;
  readonly origin: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
};

type RouteHistory = {
  readonly state: unknown;
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
  go(delta?: number): void;
};

type RouteStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Browser capabilities used by the route controller. Kept narrow so history
 * behavior can be exercised without a DOM implementation. */
export type AppRouteBrowser = {
  location: RouteLocation;
  history: RouteHistory;
  storage: RouteStorage;
  currentUser(): string;
  recordRecent(sessionId: string): void;
  listenForPopState(listener: () => void): () => void;
  listenForPushNavigate(listener: (url: string) => void): () => void;
  schedule(callback: () => void, delay: number): void;
};

type RouteSnapshot = {
  route: Route;
  forceFirstMile: boolean;
};

function currentNavState(browser: AppRouteBrowser): NavState {
  const state = browser.history.state as NavState;
  return state && (typeof state.d === "number" || state.d === null)
    ? state
    : null;
}

function entryDepth(browser: AppRouteBrowser): number | null {
  return currentNavState(browser)?.d ?? null;
}

function navState(
  depth: number | null,
  settingsReturn?: SettingsReturn,
): NavState {
  return depth === null && !settingsReturn
    ? null
    : { d: depth, ...(settingsReturn ? { settingsReturn } : {}) };
}

/** Owns the logical route and the metadata carried by browser history entries. */
export class AppRouteController {
  private route: Route;
  private firstMile: boolean;
  private readonly listeners = new Set<(snapshot: RouteSnapshot) => void>();

  constructor(private readonly browser: AppRouteBrowser) {
    // Capture both before initialization can replace or push a URL.
    const landingPath = browser.location.pathname;
    const landingSearch = browser.location.search;
    const parsed = parseRoute(landingPath);
    this.firstMile = firstMileRequested(landingPath, landingSearch);

    if (parsed.view === "prs" && !this.firstMile) {
      browser.history.replaceState(navState(0), "", browser.location.pathname);
      const rememberedUser = browser.storage.getItem(LAST_SESSION_USER_KEY);
      const lastSessionId =
        rememberedUser === browser.currentUser()
          ? browser.storage.getItem(LAST_SESSION_KEY)
          : null;
      if (lastSessionId) {
        this.route = { view: "session", id: lastSessionId };
        browser.history.pushState(
          {
            d: 1,
            restoredSession: lastSessionId,
          } satisfies NonNullable<NavState>,
          "",
          routePath(this.route),
        );
        return;
      }
    }

    this.route = parsed;
  }

  snapshot(): RouteSnapshot {
    return { route: this.route, forceFirstMile: this.firstMile };
  }

  subscribe(listener: (snapshot: RouteSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(serviceWorker: boolean): () => void {
    const stopPop = this.browser.listenForPopState(() => {
      this.firstMile = firstMileRequested(
        this.browser.location.pathname,
        this.browser.location.search,
      );
      this.route = parseRoute(this.browser.location.pathname);
      this.publish();
    });
    const stopPush = serviceWorker
      ? this.browser.listenForPushNavigate((url) => {
          try {
            const pathname = new URL(url, this.browser.location.origin)
              .pathname;
            this.navigate(parseRoute(pathname));
          } catch {
            // A malformed URL is not worth throwing away the current focus.
          }
        })
      : () => {};
    return () => {
      stopPop();
      stopPush();
    };
  }

  getCurrentRoute(): Route {
    return this.route;
  }

  get restoredSessionId(): string | undefined {
    return currentNavState(this.browser)?.restoredSession;
  }

  navigate(next: Route, opts?: { replace?: boolean }): void {
    const path = routePath(next);
    const current = this.route;
    const toRoot = next.view === "prs";
    // A session URL may already have been canonicalized into its workspace.
    const samePath =
      path === this.browser.location.pathname ||
      routePath(current) === path ||
      samePanel(current, next);
    const replace = opts?.replace ?? samePath;
    const depth = entryDepth(this.browser);
    const settingsReturn = settingsReturnForNavigation({
      currentIsSettings: isSettingsRoute(current),
      nextIsSettings: isSettingsRoute(next),
      currentReturn: currentNavState(this.browser)?.settingsReturn,
      currentPath: `${this.browser.location.pathname}${this.browser.location.search}${this.browser.location.hash}`,
      currentDepth: depth,
      replace,
    });
    const nextState = (nextDepth: number | null) =>
      navState(nextDepth, settingsReturn);

    if (replace) {
      this.browser.history.replaceState(
        nextState(toRoot ? 0 : depth),
        "",
        path,
      );
    } else if (toRoot) {
      this.browser.history.pushState(nextState(0), "", path);
    } else {
      this.browser.history.pushState(
        nextState(depth === null ? null : depth + 1),
        "",
        path,
      );
    }
    this.route = next;
    this.publish();
  }

  goBack(parentSessionId?: string): void {
    if (this.route.view === "session" && parentSessionId) {
      this.navigate({ view: "session", id: parentSessionId });
      return;
    }
    const depth = entryDepth(this.browser);
    if (depth !== null && depth > 0) {
      this.popOr(depth, () =>
        this.navigate({ view: "prs" }, { replace: true }),
      );
    } else {
      this.navigate({ view: "prs" }, { replace: true });
    }
  }

  leaveDeck(): void {
    const depth = entryDepth(this.browser);
    if (depth !== null && depth > 0) {
      this.popOr(1, () => this.navigate({ view: "prs" }, { replace: true }));
    } else {
      this.navigate({ view: "prs" }, { replace: true });
    }
  }

  leaveSettings(): void {
    const settingsReturn = currentNavState(this.browser)?.settingsReturn;
    if (!settingsReturn) {
      this.goBack();
      return;
    }
    const restore = () => {
      const url = new URL(settingsReturn.path, this.browser.location.origin);
      this.browser.history.replaceState(
        navState(settingsReturn.depth),
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
      this.route = parseRoute(url.pathname);
      this.publish();
    };
    if (settingsReturn.steps > 0) this.popOr(settingsReturn.steps, restore);
    else restore();
  }

  requireFirstMile(): void {
    if (this.firstMile) return;
    this.browser.history.replaceState(
      this.browser.history.state ?? navState(0),
      "",
      `${BASE_PATH}/welcome`,
    );
    this.firstMile = true;
    this.publish();
  }

  openFirstMile(): void {
    this.browser.history.pushState(
      this.browser.history.state,
      "",
      `${BASE_PATH}/welcome`,
    );
    this.firstMile = true;
    this.publish();
  }

  finishFirstMileNavigation(): void {
    if (!this.firstMile) return;
    const url = new URL(this.browser.location.href);
    url.searchParams.delete("firstmile");
    const leavingWelcome = stripBasePath(url.pathname) === "/welcome";
    const path = leavingWelcome ? routePath({ view: "prs" }) : url.pathname;
    this.browser.history.replaceState(
      this.browser.history.state ?? navState(0),
      "",
      `${path}${url.search}${url.hash}`,
    );
    this.firstMile = false;
    if (leavingWelcome) this.route = { view: "prs" };
    this.publish();
  }

  rememberRoute(route: Route = this.route): void {
    if (route.view === "session") {
      this.browser.storage.setItem(LAST_SESSION_KEY, route.id);
      this.browser.storage.setItem(
        LAST_SESSION_USER_KEY,
        this.browser.currentUser(),
      );
      this.browser.recordRecent(route.id);
    } else if (route.view === "prs") {
      this.forgetLastSession();
    }
  }

  forgetLastSession(expected?: string | readonly string[]): void {
    if (expected !== undefined) {
      const remembered = this.browser.storage.getItem(LAST_SESSION_KEY);
      const matches = Array.isArray(expected)
        ? expected.includes(remembered ?? "")
        : expected === remembered;
      if (!matches) return;
    }
    this.browser.storage.removeItem(LAST_SESSION_KEY);
    this.browser.storage.removeItem(LAST_SESSION_USER_KEY);
  }

  canonicalizePath(path: string): void {
    this.browser.history.replaceState(this.browser.history.state, "", path);
  }

  private popOr(steps: number, fallback: () => void): void {
    let popped = false;
    const stop = this.browser.listenForPopState(() => {
      popped = true;
    });
    this.browser.history.go(-steps);
    this.browser.schedule(() => {
      stop();
      if (!popped) fallback();
    }, POP_FALLBACK_MS);
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function browserAdapter(currentUser: () => string): AppRouteBrowser {
  return {
    location: window.location,
    history: window.history,
    storage: window.localStorage,
    currentUser,
    recordRecent: pushRecent,
    listenForPopState(listener) {
      window.addEventListener("popstate", listener);
      return () => window.removeEventListener("popstate", listener);
    },
    listenForPushNavigate: onPushNavigate,
    schedule(callback, delay) {
      window.setTimeout(callback, delay);
    },
  };
}

export function useAppRoute({
  serviceWorker,
  currentUser,
  browser,
}: {
  serviceWorker: boolean;
  currentUser: () => string;
  browser?: AppRouteBrowser;
}) {
  const [controller] = useState(
    () => new AppRouteController(browser ?? browserAdapter(currentUser)),
  );
  const [snapshot, setSnapshot] = useState(() => controller.snapshot());
  // These callbacks are dependencies of App effects. A lazy state value keeps
  // them stable in the uncompiled development build as well as production.
  const [actions] = useState(() => ({
    getCurrentRoute: () => controller.getCurrentRoute(),
    navigate: (next: Route, opts?: { replace?: boolean }) =>
      controller.navigate(next, opts),
    goBack: (parentSessionId?: string) => controller.goBack(parentSessionId),
    leaveDeck: () => controller.leaveDeck(),
    leaveSettings: () => controller.leaveSettings(),
    requireFirstMile: () => controller.requireFirstMile(),
    openFirstMile: () => controller.openFirstMile(),
    finishFirstMileNavigation: () => controller.finishFirstMileNavigation(),
    forgetLastSession: (expected?: string | readonly string[]) =>
      controller.forgetLastSession(expected),
    canonicalizePath: (path: string) => controller.canonicalizePath(path),
  }));

  useLayoutEffect(() => controller.subscribe(setSnapshot), [controller]);
  useEffect(() => controller.start(serviceWorker), [controller, serviceWorker]);
  useEffect(
    () => controller.rememberRoute(snapshot.route),
    [controller, snapshot.route],
  );

  return {
    route: snapshot.route,
    forceFirstMile: snapshot.forceFirstMile,
    restoredSessionId: controller.restoredSessionId,
    ...actions,
  };
}
