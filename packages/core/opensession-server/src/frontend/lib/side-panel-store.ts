import type { PanelBrowserTarget } from "./portal-pin";
import {
  SIDE_PANEL_BROWSERS_KEY,
  SIDE_PANEL_DOCK_KEY,
  SIDE_PANEL_PAGE_KEY,
  SIDE_PANEL_TABS_KEY,
  SIDE_PANEL_VIEWS_KEY,
  sidePanelBrowsers,
  sidePanelDock,
  sidePanelPage,
  sidePanelTabs,
  sidePanelViewFor,
  sidePanelViews,
  storeSidePanelBrowsers,
  storeSidePanelDock,
  storeSidePanelPage,
  storeSidePanelTabs,
  storeSidePanelViews,
  withSidePanelTab,
  withoutSidePanelTab,
  type SidePanelDock,
  type SidePanelDockable,
  type SidePanelPage,
  type SidePanelTab,
  type SidePanelView,
} from "./side-panel-open";

/**
 * The right side panel's state, one copy for the whole window.
 *
 * Each session (keyed by its id; a session-less workspace by `workspace:<id>`)
 * has its own view: whether the panel is open, the selected page, and the
 * page its Browser tab shows. The tab strip and where Review and Browser open
 * are shared. Every write goes to localStorage, and another browser tab's
 * write arrives as a storage event.
 *
 * It is a module store rather than component state because opening a tab is
 * something the app shell does too (a Review or Browser request routed to the
 * panel), not only the session viewer that renders it.
 */
export interface SidePanelState {
  views: Record<string, SidePanelView>;
  browsers: Record<string, PanelBrowserTarget>;
  /** The page a session nobody has chosen one for opens on. */
  lastPage: SidePanelPage;
  tabs: SidePanelTab[];
  dock: SidePanelDock;
  /** A main-strip tab is being dragged over the open panel. Never stored. */
  dropHover: boolean;
  /** The session whose panel an action just opened, so it can slide in
   *  rather than appear. A panel shown by switching sessions does not. */
  opening: string | null;
}

let state: SidePanelState | null = null;
const listeners = new Set<() => void>();

/**
 * Whether the panel is one for the whole window rather than each session's
 * own: the new layout's rule, so switching tabs leaves the panel as it is
 * (open or closed, its page, its Browser page). Only its content follows the
 * session on screen. lib/new-layout-pref registers the getter, which keeps
 * this store free of the user-pref module.
 */
let windowWide: () => boolean = () => false;

export function setSidePanelWindowWide(getter: () => boolean): void {
  windowWide = getter;
}

/** The key one window-wide panel is stored under. */
const WINDOW_KEY = "window";

/** The key `key`'s panel state lives under: its own, or the window's. */
export function sidePanelKey(key: string): string {
  return windowWide() ? WINDOW_KEY : key;
}

function load(): SidePanelState {
  try {
    return {
      views: sidePanelViews(),
      browsers: sidePanelBrowsers(),
      lastPage: sidePanelPage(),
      tabs: sidePanelTabs(),
      dock: sidePanelDock(),
      dropHover: false,
      opening: null,
    };
  } catch {
    return {
      views: {},
      browsers: {},
      lastPage: "changes",
      tabs: ["changes"],
      dock: { review: "panel", browser: "panel" },
      dropHover: false,
      opening: null,
    };
  }
}

export function getSidePanelState(): SidePanelState {
  state ??= load();
  return state;
}

const STORED_KEYS = new Set([
  SIDE_PANEL_VIEWS_KEY,
  SIDE_PANEL_BROWSERS_KEY,
  SIDE_PANEL_PAGE_KEY,
  SIDE_PANEL_TABS_KEY,
  SIDE_PANEL_DOCK_KEY,
]);

function onStorage(event: StorageEvent) {
  if (!event.key || !STORED_KEYS.has(event.key)) return;
  // Another browser tab's browsers map has no Portals in it; keep ours.
  const portals = Object.entries(getSidePanelState().browsers).filter(
    ([, target]) => target.kind === "portal",
  );
  const next = load();
  state = {
    ...next,
    browsers: { ...next.browsers, ...Object.fromEntries(portals) },
  };
  for (const listener of listeners) listener();
}

export function subscribeSidePanel(listener: () => void): () => void {
  if (!listeners.size) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", onStorage);
  };
}

function update(patch: Partial<SidePanelState>) {
  const prev = getSidePanelState();
  const next = { ...prev, ...patch };
  state = next;
  try {
    if (next.views !== prev.views) storeSidePanelViews(next.views);
    if (next.browsers !== prev.browsers) storeSidePanelBrowsers(next.browsers);
    if (next.lastPage !== prev.lastPage) storeSidePanelPage(next.lastPage);
    if (next.tabs !== prev.tabs) storeSidePanelTabs(next.tabs);
    if (next.dock !== prev.dock) storeSidePanelDock(next.dock);
  } catch {
    /* private mode / quota: the in-memory state still works */
  }
  for (const listener of listeners) listener();
}

/** `key`'s panel as it shows now (see sidePanelViewFor). */
export function sidePanelViewOf(
  current: SidePanelState,
  key: string,
): Required<SidePanelView> {
  const own = sidePanelKey(key);
  return sidePanelViewFor(
    current.views[own],
    !!current.browsers[own],
    current.lastPage,
  );
}

/** The page attached to `key`'s Browser tab, if any. */
export function sidePanelBrowserOf(
  current: SidePanelState,
  key: string,
): PanelBrowserTarget | null {
  return current.browsers[sidePanelKey(key)] ?? null;
}

/** Whether anyone has opened or closed `key`'s panel yet. */
export function sidePanelTouched(current: SidePanelState, key: string) {
  return !!current.views[sidePanelKey(key)];
}

/** An action just opened `key`'s panel (see SidePanelState.opening). */
export function sidePanelOpening(current: SidePanelState, key: string) {
  return current.opening === sidePanelKey(key);
}

/** Write `key`'s view, moving it to the newest end of the stored map. */
function withView(
  key: string,
  view: SidePanelView,
): Pick<SidePanelState, "views" | "opening"> {
  const current = getSidePanelState();
  const was = sidePanelViewOf(current, key);
  const own = sidePanelKey(key);
  const views = { ...current.views };
  delete views[own];
  views[own] = view;
  return {
    views,
    opening: view.open && !was.open ? own : current.opening,
  };
}

export function setSidePanelOpen(key: string, open: boolean): void {
  const current = getSidePanelState();
  const view = sidePanelViewOf(current, key);
  if (view.open === open && sidePanelTouched(current, key)) return;
  update(withView(key, { ...view, open }));
}

/** Select a page, adding its tab to the strip first if it is not there. */
export function selectSidePanelPage(key: string, page: SidePanelPage): void {
  const current = getSidePanelState();
  const view = sidePanelViewOf(current, key);
  if (view.page === page && (page === "new" || current.tabs.includes(page)))
    return;
  update({
    ...withView(key, { ...view, page }),
    lastPage: page,
    tabs: page === "new" ? current.tabs : withSidePanelTab(current.tabs, page),
  });
}

/** The panel the app shell's requests land in: the focused viewer's. */
let hosts: string[] = [];

/**
 * Open `key`'s panel on `tab`, adding the tab when it is not open yet. Without
 * a key it is the panel on screen, if any.
 */
export function openSidePanelTab(tab: SidePanelTab, key = hosts.at(-1)): void {
  if (!key) return;
  const current = getSidePanelState();
  const view = sidePanelViewOf(current, key);
  if (view.open && view.page === tab && current.tabs.includes(tab)) return;
  update({
    ...withView(key, { open: true, page: tab }),
    lastPage: tab,
    tabs: withSidePanelTab(current.tabs, tab),
  });
}

/**
 * Open `key`'s panel on its overview: Changes, the workspace summary with the
 * diff under it. A coordinating session's overview is its Threads tab when
 * that is where it was left. The side panel toggle opens this, whatever page
 * was showing when the panel closed, so it never opens onto a tool page or
 * the new-tab list.
 */
export function openSidePanelOverview(key: string): void {
  const view = sidePanelViewOf(getSidePanelState(), key);
  openSidePanelTab(view.page === "threads" ? "threads" : "changes", key);
}

/** Add `tab` to the strip without selecting it or opening any panel. */
export function addSidePanelTab(tab: SidePanelTab): void {
  const current = getSidePanelState();
  if (current.tabs.includes(tab)) return;
  update({ tabs: withSidePanelTab(current.tabs, tab) });
}

/**
 * Close `tab` in the strip; `key`'s page moves to a neighbour. Changes, the
 * overview, stays (see withOverviewTab).
 */
export function closeSidePanelTab(key: string, tab: SidePanelTab): void {
  const current = getSidePanelState();
  if (tab === "changes" || !current.tabs.includes(tab)) return;
  const view = sidePanelViewOf(current, key);
  const next = withoutSidePanelTab(current.tabs, view.page, tab);
  const open = view.open && next.tabs.length > 0;
  update({ ...withView(key, { open, page: next.page }), tabs: next.tabs });
}

/**
 * Attach a page to `key`'s Browser tab and open the panel on it, or detach
 * it. An attached page is what makes a session open with its panel up.
 */
export function setSidePanelBrowser(
  key: string,
  target: PanelBrowserTarget | null,
): void {
  const current = getSidePanelState();
  const own = sidePanelKey(key);
  const browsers = { ...current.browsers };
  delete browsers[own];
  if (!target) {
    if (!current.browsers[own]) return;
    update({ browsers });
    return;
  }
  browsers[own] = target;
  update({
    ...withView(key, { open: true, page: "browser" }),
    browsers,
    lastPage: "browser",
    tabs: withSidePanelTab(current.tabs, "browser"),
  });
}

/** The panel finished sliding in. */
export function finishSidePanelOpening(key: string): void {
  if (sidePanelOpening(getSidePanelState(), key)) update({ opening: null });
}

/**
 * Where `kind` opens. In the new layout Review and Browser pages always open
 * in the main tabs, where a pull request gets the full width a review needs;
 * moving one to the panel (tab menu, or dragging it over) is for that page
 * only, and does not make the next one open there.
 */
export function sidePanelDockOf(kind: SidePanelDockable): "panel" | "main" {
  if (windowWide()) return "main";
  return getSidePanelState().dock[kind];
}

export function setSidePanelDock(
  kind: SidePanelDockable,
  place: "panel" | "main",
): void {
  if (windowWide()) return;
  const { dock } = getSidePanelState();
  if (dock[kind] !== place) update({ dock: { ...dock, [kind]: place } });
}

/**
 * Register `key`'s viewer as one that can show a panel right now: a focused
 * desktop session whose panel is available. Review and Browser only route to
 * the panel while one is, so a request from a phone, or from a session with
 * no panel, still opens in the main strip instead of disappearing into a
 * panel nobody sees.
 */
export function registerSidePanelHost(key: string): () => void {
  hosts = [...hosts, key];
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const index = hosts.lastIndexOf(key);
    if (index >= 0) hosts = hosts.filter((_, i) => i !== index);
  };
}

/** Whether a viewer can show the panel right now (see registerSidePanelHost):
 *  any viewer, or the one for `key`. */
export function sidePanelHostOnScreen(key?: string): boolean {
  return key
    ? hosts.some((host) => sidePanelKey(host) === sidePanelKey(key))
    : hosts.length > 0;
}

/** Light the open panel up as a drop target while a tab is dragged over it. */
export function setSidePanelDropHover(dropHover: boolean): void {
  if (getSidePanelState().dropHover !== dropHover) update({ dropHover });
}

/** Whether `kind` should open in the side panel rather than the main strip. */
export function opensInSidePanel(kind: SidePanelDockable): boolean {
  return hosts.length > 0 && sidePanelDockOf(kind) === "panel";
}

/** Test seam: forget the loaded state so the next read reloads storage. */
export function resetSidePanelStateForTest(): void {
  state = null;
  hosts = [];
  windowWide = () => false;
}
