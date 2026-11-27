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
import { onConversationDeleted } from "../lib/conversation-deleted";
import { keepsSingleHistoryEntry } from "../lib/history-mode";
import { onPushNavigate } from "../lib/push";
import { pushRecent } from "../lib/recents";
import {
  settingsReturnForNavigation,
  type SettingsReturn,
} from "../lib/settings-navigation";
import {
  sessionReturnForNavigation,
  type SessionReturn,
} from "../lib/session-return";

import {
  defaultPlaceOf,
  isConversationRoute,
  placeOfRoute,
  placeOverride,
  type Place,
  type PlaceOverride,
} from "../lib/new-layout-place";

const LAST_SESSION_KEY = "opensession-last-session";
const LAST_SESSION_USER_KEY = "opensession-last-session-user";
const POP_FALLBACK_MS = 150;

type NavState = {
  d: number | null;
  /** The entry's place when its route alone does not give it
   *  (lib/new-layout-place.ts). */
  place?: PlaceOverride;
  settingsReturn?: SettingsReturn;
  /** The session a PR or workspace link was followed from. */
  sessionReturn?: SessionReturn;
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

type RouteHistoryState = History["state"];

type RouteHistory = {
  readonly state: RouteHistoryState;
  pushState(
    data: RouteHistoryState,
    unused: string,
    url?: string | URL | null,
  ): void;
  replaceState(
    data: RouteHistoryState,
    unused: string,
    url?: string | URL | null,
  ): void;
  go(delta?: number): void;
};

type RouteStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Browser capabilities used by the route controller. Kept narrow so history
 * behavior can be exercised without a DOM implementation. */
export type AppRouteBrowser = {
  location: RouteLocation;
  history: RouteHistory;
  storage: RouteStorage;
  /**
   * Replace the current entry on every navigation instead of pushing, so the
   * history never grows a back entry. See lib/history-mode.
   */
  singleHistoryEntry: boolean;
  currentUser(): string;
  recordRecent(sessionId: string): void;
  listenForPopState(listener: () => void): () => void;
  listenForPushNavigate(listener: (url: string) => void): () => void;
  /** A conversation was deleted (lib/conversation-deleted.ts). */
  listenForConversationDeleted(listener: (route: Route) => void): () => void;
  schedule(callback: () => void, delay: number): void;
};

type RouteSnapshot = {
  route: Route;
  forceFirstMile: boolean;
};

function currentNavState(browser: AppRouteBrowser): NavState {
  const state = browser.history.state;
  return state && (Number.isFinite(state.d) || state.d === null) ? state : null;
}

function entryDepth(browser: AppRouteBrowser): number | null {
  return currentNavState(browser)?.d ?? null;
}

function navState(
  depth: number | null,
  settingsReturn?: SettingsReturn,
  sessionReturn?: SessionReturn,
  place?: PlaceOverride,
): NavState {
  if (depth === null && !settingsReturn && !sessionReturn && !place)
    return null;
  const state: NonNullable<NavState> = { d: depth };
  if (place) state.place = place;
  if (settingsReturn) state.settingsReturn = settingsReturn;
  if (sessionReturn) state.sessionReturn = sessionReturn;
  return state;
}

/** Owns the logical route and the metadata carried by browser history entries. */
export class AppRouteController {
  // Assigned by `commit`, which the constructor always reaches.
  private route!: Route;
  /** The place the current route shows in (lib/new-layout-place.ts). */
  private currentPlace: Place = "sessions";
  /** The conversation last shown in Sessions, which its button returns to. */
  private sessionsReturn: Route | null = null;
  /** The return target the server is being asked about, if any, and the
   *  page the Sessions button was last clicked on while it was. */
  private returnLookup: { target: Route; from: Route } | null = null;
  private firstMile: boolean;
  private readonly listeners = new Set<(snapshot: RouteSnapshot) => void>();

  constructor(private readonly browser: AppRouteBrowser) {
    // Capture both before initialization can replace or push a URL.
    const landingPath = browser.location.pathname;
    const landingSearch = browser.location.search;
    const parsed = parseRoute(landingPath);
    this.firstMile = firstMileRequested(landingPath, landingSearch);

    if (parsed.view === "prs" && !this.firstMile) {
      // Keep a place chosen on this entry (the Sessions list beside Pull
      // requests), so a reload of / still shows it.
      browser.history.replaceState(
        navState(0, undefined, undefined, currentNavState(browser)?.place),
        "",
        browser.location.pathname,
      );
      const rememberedUser = browser.storage.getItem(LAST_SESSION_USER_KEY);
      const lastSessionId =
        rememberedUser === browser.currentUser()
          ? browser.storage.getItem(LAST_SESSION_KEY)
          : null;
      if (lastSessionId) {
        this.commit({ view: "session", id: lastSessionId }, "sessions");
        this.pushEntry(
          {
            d: browser.singleHistoryEntry ? 0 : 1,
            restoredSession: lastSessionId,
          } satisfies NonNullable<NavState>,
          routePath(this.route),
        );
        return;
      }
    }

    this.commit(parsed, this.entryPlace(parsed));
  }

  /** The place the current route shows in. */
  get place(): Place {
    return this.currentPlace;
  }

  /**
   * The Sessions button. It shows your own list: beside the conversation on
   * screen when there is one, else with the conversation you last had open
   * there. With neither, only the list changes and the page stays until you
   * pick a session from it.
   *
   * `stillThere` says whether a remembered conversation can still be opened.
   * One that was deleted or archived since is forgotten instead. When it
   * has to ask the server, the list shows at once and the conversation
   * opens once confirmed, unless you have moved on by then.
   *
   * Clicking it again while your list is already beside a page asks again,
   * so a lookup that failed (the connection dropped) is not the last word.
   * One still in flight answers the click instead of a second request.
   */
  openSessions(
    stillThere: (route: Route) => boolean | Promise<boolean> = () => true,
  ): void {
    const shown = this.currentPlace === "sessions";
    const target = isConversationRoute(this.route) ? null : this.sessionsReturn;
    if (target && target === this.returnLookup?.target) {
      // Already asking. The answer returns you from here instead.
      this.returnLookup.from = this.route;
    } else if (target) {
      const verdict = stillThere(target);
      if (verdict === true) {
        // Set first, so the conversation lands in Sessions even when the
        // page being left is one of Activity's.
        this.currentPlace = "sessions";
        this.navigate(target);
        return;
      }
      if (verdict === false) this.sessionsReturn = null;
      else this.returnOnceConfirmed(target, verdict);
    }
    if (shown) return;
    // The page stays, so its entry records the choice: Back to it, a reload,
    // or closing Settings over it then shows your list again.
    const state = currentNavState(this.browser);
    this.browser.history.replaceState(
      navState(
        state?.d ?? null,
        state?.settingsReturn,
        state?.sessionReturn,
        placeOverride(this.route, "sessions"),
      ),
      "",
      `${this.browser.location.pathname}${this.browser.location.search}${this.browser.location.hash}`,
    );
    this.commit(this.route, "sessions");
    this.publish();
  }

  private returnOnceConfirmed(target: Route, verdict: Promise<boolean>): void {
    const lookup = { target, from: this.route };
    this.returnLookup = lookup;
    const settle = () => {
      if (this.returnLookup === lookup) this.returnLookup = null;
    };
    verdict.then(
      (there) => {
        settle();
        // Forgotten or replaced meanwhile.
        if (this.sessionsReturn !== target) return;
        if (!there) this.sessionsReturn = null;
        // Only from the page the button was clicked on, with your list
        // still beside it. Anything opened since (a session, Archived,
        // another place) is where you chose to be.
        else if (this.route === lookup.from && this.currentPlace === "sessions")
          this.navigate(target);
      },
      // Unknown, not gone: it stays remembered, and the next click asks again.
      settle,
    );
  }

  /**
   * Called once a conversation is deleted, before navigating away from it, so
   * the Sessions button does not return to it while the lists still hold it.
   */
  forgetConversation(route: Route): void {
    const remembered = this.sessionsReturn;
    if (
      remembered &&
      remembered.view === route.view &&
      "id" in remembered &&
      "id" in route &&
      remembered.id === route.id
    )
      this.sessionsReturn = null;
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
      const route = parseRoute(this.browser.location.pathname);
      this.commit(route, this.entryPlace(route));
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
    // Every delete ends in the delete API, which announces it. Heard here,
    // the conversation stops being a place to return to before the lists
    // that still hold it refresh.
    const stopDeleted = this.browser.listenForConversationDeleted((route) =>
      this.forgetConversation(route),
    );
    return () => {
      stopPop();
      stopPush();
      stopDeleted();
    };
  }

  getCurrentRoute(): Route {
    return this.route;
  }

  get restoredSessionId(): string | undefined {
    return currentNavState(this.browser)?.restoredSession;
  }

  /** Back returns to the session this page was opened from. */
  get returnsToSession(): boolean {
    return !!currentNavState(this.browser)?.sessionReturn;
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
    const logicalReplace = opts?.replace ?? samePath;
    const replace = this.browser.singleHistoryEntry || logicalReplace;
    const depth = entryDepth(this.browser);
    const currentPlace = placeOverride(current, this.currentPlace);
    const settingsReturn = settingsReturnForNavigation({
      currentIsSettings: isSettingsRoute(current),
      nextIsSettings: isSettingsRoute(next),
      currentReturn: currentNavState(this.browser)?.settingsReturn,
      currentPath: `${this.browser.location.pathname}${this.browser.location.search}${this.browser.location.hash}`,
      currentDepth: depth,
      currentPlace,
      replace,
    });
    const sessionReturn = sessionReturnForNavigation({
      current,
      next,
      currentReturn: currentNavState(this.browser)?.sessionReturn,
      // The session itself, not a pane its URL was canonicalized to: Back
      // should land on the conversation the link was in.
      currentPath: routePath(current),
      currentDepth: depth,
      currentPlace,
      logicalReplace,
      pushed: !replace,
    });
    const nextPlace = placeOfRoute(next, this.currentPlace);
    const nextState = (nextDepth: number | null) =>
      navState(
        nextDepth,
        settingsReturn,
        sessionReturn,
        placeOverride(next, nextPlace),
      );

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
    this.commit(next, nextPlace);
    this.publish();
  }

  goBack(parentSessionId?: string): void {
    if (this.route.view === "session" && parentSessionId) {
      this.navigate({ view: "session", id: parentSessionId });
      return;
    }
    const sessionReturn = currentNavState(this.browser)?.sessionReturn;
    if (sessionReturn) {
      this.returnTo(sessionReturn);
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
    this.returnTo(settingsReturn);
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
    this.pushEntry(this.browser.history.state, `${BASE_PATH}/welcome`);
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
    if (leavingWelcome) {
      const home: Route = { view: "prs" };
      this.commit(home, defaultPlaceOf(home));
    }
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

  // Pop the entries pushed since `target` was left, or rewrite this entry to
  // it when they are gone (single-entry history, or a pruned stack). The
  // rewrite takes its place from the target too: the pages opened since can
  // have moved it (Settings to Goals is Library), and it is the page being
  // returned to that is on screen.
  private returnTo(target: SettingsReturn | SessionReturn): void {
    const restore = () => {
      const url = new URL(target.path, this.browser.location.origin);
      const route = parseRoute(url.pathname);
      const place = target.place ?? defaultPlaceOf(route);
      this.browser.history.replaceState(
        navState(target.depth, undefined, undefined, target.place),
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
      this.commit(route, place);
      this.publish();
    };
    if (target.steps > 0) this.popOr(target.steps, restore);
    else restore();
  }

  // A push everywhere a back entry is wanted; a replace where the history is
  // kept to one entry.
  private pushEntry(state: RouteHistoryState, path: string): void {
    if (this.browser.singleHistoryEntry) {
      this.browser.history.replaceState(state, "", path);
    } else {
      this.browser.history.pushState(state, "", path);
    }
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

  /** The place the current history entry shows `route` in. */
  private entryPlace(route: Route): Place {
    return currentNavState(this.browser)?.place ?? defaultPlaceOf(route);
  }

  /** Every route change ends here, so the place can never lag the route. */
  private commit(route: Route, place: Place): void {
    this.route = route;
    this.currentPlace = place;
    if (this.currentPlace === "sessions" && isConversationRoute(route))
      this.sessionsReturn = route;
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
    singleHistoryEntry: keepsSingleHistoryEntry({
      standalone: "standalone" in navigator && navigator.standalone === true,
    }),
    currentUser,
    recordRecent: pushRecent,
    listenForPopState(listener) {
      window.addEventListener("popstate", listener);
      return () => window.removeEventListener("popstate", listener);
    },
    listenForPushNavigate: onPushNavigate,
    listenForConversationDeleted: onConversationDeleted,
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
    forgetConversation: (route: Route) => controller.forgetConversation(route),
    openSessions: (stillThere?: (route: Route) => boolean | Promise<boolean>) =>
      controller.openSessions(stillThere),
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
    returnsToSession: controller.returnsToSession,
    restoredSessionId: controller.restoredSessionId,
    // The new layout's place: read at render like the two above, since every
    // change to it publishes a snapshot.
    places: { current: controller.place, openSessions: actions.openSessions },
    ...actions,
  };
}
