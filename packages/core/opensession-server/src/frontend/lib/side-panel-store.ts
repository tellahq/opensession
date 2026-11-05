import {
  SIDE_PANEL_DOCK_KEY,
  SIDE_PANEL_OPEN_KEY,
  SIDE_PANEL_PAGE_KEY,
  SIDE_PANEL_TABS_KEY,
  sidePanelDock,
  sidePanelOpen,
  sidePanelPage,
  sidePanelTabs,
  storeSidePanelDock,
  storeSidePanelOpen,
  storeSidePanelPage,
  storeSidePanelTabs,
  withSidePanelTab,
  withoutSidePanelTab,
  type SidePanelDock,
  type SidePanelDockable,
  type SidePanelPage,
  type SidePanelTab,
} from "./side-panel-open";

/**
 * The right side panel's state, one copy for the whole window: whether it is
 * open, its tabs, the selected one, and where Review and Browser open.
 *
 * It is a module store rather than component state because opening a tab is
 * something the app shell does too (a Review or Browser request routed to the
 * panel), not only the session viewer that renders it. Every write goes to
 * localStorage, and another browser tab's write arrives as a storage event.
 */
export interface SidePanelState {
  open: boolean;
  page: SidePanelPage;
  tabs: SidePanelTab[];
  dock: SidePanelDock;
}

let state: SidePanelState | null = null;
const listeners = new Set<() => void>();

function load(): SidePanelState {
  try {
    const tabs = sidePanelTabs();
    const stored = sidePanelPage();
    const page = stored === "new" || tabs.includes(stored) ? stored : tabs[0];
    return {
      open: sidePanelOpen(),
      page: page ?? "new",
      tabs,
      dock: sidePanelDock(),
    };
  } catch {
    return {
      open: false,
      page: "changes",
      tabs: ["changes"],
      dock: { review: "panel", browser: "panel" },
    };
  }
}

export function getSidePanelState(): SidePanelState {
  state ??= load();
  return state;
}

function onStorage(event: StorageEvent) {
  if (
    event.key !== SIDE_PANEL_OPEN_KEY &&
    event.key !== SIDE_PANEL_PAGE_KEY &&
    event.key !== SIDE_PANEL_TABS_KEY &&
    event.key !== SIDE_PANEL_DOCK_KEY
  )
    return;
  state = load();
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
    if (next.open !== prev.open) storeSidePanelOpen(next.open);
    if (next.page !== prev.page) storeSidePanelPage(next.page);
    if (next.tabs !== prev.tabs) storeSidePanelTabs(next.tabs);
    if (next.dock !== prev.dock) storeSidePanelDock(next.dock);
  } catch {
    /* private mode / quota: the in-memory state still works */
  }
  for (const listener of listeners) listener();
}

export function setSidePanelOpen(open: boolean): void {
  if (getSidePanelState().open !== open) update({ open });
}

/** Select a page, adding its tab to the strip first if it is not there. */
export function selectSidePanelPage(page: SidePanelPage): void {
  const { tabs, page: current } = getSidePanelState();
  if (page === "new") {
    if (current !== "new") update({ page });
    return;
  }
  if (current === page && tabs.includes(page)) return;
  update({ page, tabs: withSidePanelTab(tabs, page) });
}

/** Open the panel on `tab`, adding the tab when it is not open yet. */
export function openSidePanelTab(tab: SidePanelTab): void {
  const { tabs, page, open } = getSidePanelState();
  if (open && page === tab && tabs.includes(tab)) return;
  update({ open: true, page: tab, tabs: withSidePanelTab(tabs, tab) });
}

export function closeSidePanelTab(tab: SidePanelTab): void {
  const { tabs, page } = getSidePanelState();
  if (!tabs.includes(tab)) return;
  update(withoutSidePanelTab(tabs, page, tab));
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
 * How many viewers can show a panel right now: a focused desktop session
 * whose panel is available. Review and Browser only route to the panel while
 * one is, so a request from a phone, or from a session with no panel, still
 * opens in the main strip instead of disappearing into a panel nobody sees.
 */
let hosts = 0;

export function registerSidePanelHost(): () => void {
  hosts += 1;
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    hosts -= 1;
  };
}

/** Whether `kind` should open in the side panel rather than the main strip. */
export function opensInSidePanel(kind: SidePanelDockable): boolean {
  return hosts > 0 && sidePanelDockOf(kind) === "panel";
}

/** Test seam: forget the loaded state so the next read reloads storage. */
export function resetSidePanelStateForTest(): void {
  state = null;
  hosts = 0;
}
