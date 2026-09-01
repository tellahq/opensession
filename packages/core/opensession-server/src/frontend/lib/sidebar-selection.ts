/**
 * Paint a workspace selection before the route render finishes.
 *
 * The sidebar is intentionally one large inventory, and a route change can take
 * more than a frame to reconcile it. React still owns the attributes: this only
 * bridges the pointer/keyboard interaction until that render commits.
 */
export function previewSidebarSelection(
  root: HTMLElement | null,
  row: HTMLButtonElement,
): void {
  if (!root || row.hasAttribute("data-selected")) return;
  for (const selected of root.querySelectorAll<HTMLButtonElement>(
    "button[data-sidebar-row][data-selected]",
  )) {
    selected.removeAttribute("data-selected");
    selected.classList.remove("bg-selected");
  }
  row.setAttribute("data-selected", "");
  row.classList.add("bg-selected");
}
