/** The workspace side panel is a browser-wide view choice. */
export const SIDE_PANEL_OPEN_KEY = "opensession-panel-open";
export const SIDE_PANEL_PAGE_KEY = "opensession-panel-page";

const SIDE_PANEL_PAGES = ["changes", "portals", "agents", "terminal"] as const;

export type SidePanelPage = (typeof SIDE_PANEL_PAGES)[number];

/**
 * The summary card is the default workspace view. Once the person opens or
 * closes the side panel, keep that choice across workspaces and reloads.
 */
export function sidePanelOpen(
  storage: Pick<Storage, "getItem"> = localStorage,
): boolean {
  return storage.getItem(SIDE_PANEL_OPEN_KEY) === "true";
}

export function storeSidePanelOpen(
  open: boolean,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  storage.setItem(SIDE_PANEL_OPEN_KEY, String(open));
}

/** The selected tool follows the panel while sessions change. */
export function sidePanelPage(
  storage: Pick<Storage, "getItem"> = localStorage,
): SidePanelPage {
  const stored = storage.getItem(SIDE_PANEL_PAGE_KEY);
  return SIDE_PANEL_PAGES.find((page) => page === stored) ?? "changes";
}

export function storeSidePanelPage(
  page: SidePanelPage,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  storage.setItem(SIDE_PANEL_PAGE_KEY, page);
}
