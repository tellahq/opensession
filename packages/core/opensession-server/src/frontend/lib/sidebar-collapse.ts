/** Desktop sidebar visibility for this browser. */
export const SIDEBAR_COLLAPSED_KEY = "opensession-sidebar-collapsed";

/**
 * New browsers lead with the sidebar open. Once someone opens or closes it,
 * that explicit choice persists.
 */
export function sidebarStartsCollapsed(): boolean {
  return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
}

export function storeSidebarCollapsed(collapsed: boolean): void {
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
}
