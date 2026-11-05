import { z } from "zod";

/** The workspace side panel is a browser-wide view choice. */
export const SIDE_PANEL_OPEN_KEY = "opensession-panel-open";
export const SIDE_PANEL_PAGE_KEY = "opensession-panel-page";
export const SIDE_PANEL_TABS_KEY = "opensession-panel-tabs";
export const SIDE_PANEL_DOCK_KEY = "opensession-panel-dock";

/**
 * What the side panel can hold, one tab each. Review and Browser are the two
 * that can also live in the main tab strip (see SidePanelDock).
 */
export const SIDE_PANEL_TABS = [
  "changes",
  "review",
  "browser",
  "portals",
  "agents",
  "terminal",
] as const;

export type SidePanelTab = (typeof SIDE_PANEL_TABS)[number];

/** A tab, or `new`: the panel's own new-tab page listing what it can open. */
export type SidePanelPage = SidePanelTab | "new";

/** Surfaces that open in the side panel by default and can move to the strip. */
export type SidePanelDockable = "review" | "browser";
export type SidePanelDock = Record<SidePanelDockable, "panel" | "main">;

type Read = Pick<Storage, "getItem">;
type Write = Pick<Storage, "setItem">;

export function isSidePanelTab(value: string | null): value is SidePanelTab {
  return SIDE_PANEL_TABS.some((tab) => tab === value);
}

export function isSidePanelPage(value: string | null): value is SidePanelPage {
  return value === "new" || isSidePanelTab(value);
}

/** The strip as stored: a list of names, unknown or repeated ones dropped. */
const storedTabsSchema = z.array(z.string());

const placeSchema = z.enum(["panel", "main"]).optional().catch(undefined);
const storedDockSchema = z.object({
  review: placeSchema,
  browser: placeSchema,
});

/** The panel's open tabs and the selected page, as one change. */
export interface SidePanelTabsState {
  tabs: SidePanelTab[];
  page: SidePanelPage;
}

/** Review and Browser are wide surfaces; the panel opens wider for them. */
export function isWideSidePanelPage(page: SidePanelPage): boolean {
  return page === "review" || page === "browser";
}

/**
 * The summary card is the default workspace view. Once the person opens or
 * closes the side panel, keep that choice across workspaces and reloads.
 */
export function sidePanelOpen(storage: Read = localStorage): boolean {
  return storage.getItem(SIDE_PANEL_OPEN_KEY) === "true";
}

export function storeSidePanelOpen(
  open: boolean,
  storage: Write = localStorage,
): void {
  storage.setItem(SIDE_PANEL_OPEN_KEY, String(open));
}

/** The selected tab follows the panel while sessions change. */
export function sidePanelPage(storage: Read = localStorage): SidePanelPage {
  const stored = storage.getItem(SIDE_PANEL_PAGE_KEY);
  return isSidePanelPage(stored) ? stored : "changes";
}

export function storeSidePanelPage(
  page: SidePanelPage,
  storage: Write = localStorage,
): void {
  storage.setItem(SIDE_PANEL_PAGE_KEY, page);
}

/**
 * The panel's open tabs, in strip order. Before the panel had tabs of its own
 * it showed a fixed set of tools, so a browser with no list yet starts on
 * Changes plus whichever tool it last had selected.
 */
export function sidePanelTabs(storage: Read = localStorage): SidePanelTab[] {
  try {
    const stored = storage.getItem(SIDE_PANEL_TABS_KEY);
    const parsed = stored
      ? storedTabsSchema.safeParse(JSON.parse(stored))
      : null;
    if (parsed?.success)
      return [...new Set(parsed.data.filter(isSidePanelTab))];
  } catch {
    /* fall through to the default */
  }
  const page = sidePanelPage(storage);
  return page !== "new" && page !== "changes" ? ["changes", page] : ["changes"];
}

export function storeSidePanelTabs(
  tabs: SidePanelTab[],
  storage: Write = localStorage,
): void {
  storage.setItem(SIDE_PANEL_TABS_KEY, JSON.stringify(tabs));
}

/** Where Review and Browser open. Both start in the side panel. */
export function sidePanelDock(storage: Read = localStorage): SidePanelDock {
  try {
    const parsed = storedDockSchema.safeParse(
      JSON.parse(storage.getItem(SIDE_PANEL_DOCK_KEY) ?? "{}"),
    );
    if (parsed.success)
      return {
        review: parsed.data.review ?? "panel",
        browser: parsed.data.browser ?? "panel",
      };
  } catch {
    /* defaults */
  }
  return { review: "panel", browser: "panel" };
}

export function storeSidePanelDock(
  dock: SidePanelDock,
  storage: Write = localStorage,
): void {
  storage.setItem(SIDE_PANEL_DOCK_KEY, JSON.stringify(dock));
}

/** Add `tab` to the strip (at the end) if it is not there yet. */
export function withSidePanelTab(
  tabs: readonly SidePanelTab[],
  tab: SidePanelTab,
): SidePanelTab[] {
  return tabs.includes(tab) ? [...tabs] : [...tabs, tab];
}

/**
 * Remove `tab`. When it was the selected one, select its right neighbour, else
 * its left one, and the new-tab page once the strip is empty.
 */
export function withoutSidePanelTab(
  tabs: readonly SidePanelTab[],
  page: SidePanelPage,
  tab: SidePanelTab,
): SidePanelTabsState {
  const index = tabs.indexOf(tab);
  const next = tabs.filter((candidate) => candidate !== tab);
  const state: SidePanelTabsState = {
    tabs: next,
    page:
      index < 0 || page !== tab
        ? page
        : (next[index] ?? next[index - 1] ?? "new"),
  };
  return state;
}
