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
  return sidePanelViewFor(
    current.views[key],
    !!current.browsers[key],
    current.lastPage,
  );
}

/** Write `key`'s view, moving it to the newest end of the stored map. */
function withView(
  key: string,
  view: SidePanelView,
): Pick<SidePanelState, "views" | "opening"> {
  const current = getSidePanelState();
  const was = sidePanelViewOf(current, key);
  const views = { ...current.views };
  delete views[key];
  views[key] = view;
  return {
    views,
    opening: view.open && !was.open ? key : current.opening,
  };
}

export function setSidePanelOpen(key: string, open: boolean): void {
  const current = getSidePanelState();
  const view = sidePanelViewOf(current, key);
  if (view.open === open && current.views[key]) return;
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

/** Close `tab` in the strip; `key`'s page moves to a neighbour. */
export function closeSidePanelTab(key: string, tab: SidePanelTab): void {
  const current = getSidePanelState();
  if (!current.tabs.includes(tab)) return;
  const view = sidePanelViewOf(current, key);
  const next = withoutSidePanelTab(current.tabs, view.page, tab);
  update({ ...withView(key, { ...view, page: next.page }), tabs: next.tabs });
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
  const browsers = { ...current.browsers };
  delete browsers[key];
  if (!target) {
    if (!current.browsers[key]) return;
    update({ browsers });
    return;
  }
  browsers[key] = target;
  update({
    ...withView(key, { open: true, page: "browser" }),
    browsers,
    lastPage: "browser",
    tabs: withSidePanelTab(current.tabs, "browser"),
  });
}

/** The panel finished sliding in. */
export function finishSidePanelOpening(key: string): void {
  if (getSidePanelState().opening === key) update({ opening: null });
}

export function sidePanelDockOf(kind: SidePanelDockable): "panel" | "main" {
  return getSidePanelState().dock[kind];
}

export function setSidePanelDock(
  kind: SidePanelDockable,
  place: "panel" | "main",
): void {
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

/** Whether a viewer can show the panel right now (see registerSidePanelHost). */
export function sidePanelHostOnScreen(): boolean {
  return hosts.length > 0;
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
}
