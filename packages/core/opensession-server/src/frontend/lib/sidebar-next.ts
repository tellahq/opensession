export const SIDEBAR_ITEM_KEY_ATTRIBUTE = "data-sidebar-item-key";

interface SidebarItemElement {
  getAttribute(name: string): string | null;
}

interface SidebarAttentionElement {
  hasAttribute(name: string): boolean;
}

interface RenderedSidebarElement
  extends SidebarItemElement, SidebarAttentionElement {}

/**
 * Pick the next rendered sidebar item, falling back to the previous item when
 * the current item is last. Repeated copies of the current item are skipped.
 */
export function nextRenderedSidebarItem<T extends SidebarItemElement>(
  items: readonly T[],
  current: T | null,
  currentKey: string,
): T | null {
  let index = current ? items.indexOf(current) : -1;
  if (index < 0) {
    index = items.findIndex(
      (item) => item.getAttribute(SIDEBAR_ITEM_KEY_ATTRIBUTE) === currentKey,
    );
  }
  if (index < 0) return null;

  for (let i = index + 1; i < items.length; i += 1) {
    if (items[i].getAttribute(SIDEBAR_ITEM_KEY_ATTRIBUTE) !== currentKey)
      return items[i];
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    if (items[i].getAttribute(SIDEBAR_ITEM_KEY_ATTRIBUTE) !== currentKey)
      return items[i];
  }
  return null;
}

/**
 * Pick the chat after the selected chat in rendered sidebar order, skipping
 * chats whose turn is still running: this control moves you to work you can
 * actually read, not to an agent mid-answer.
 */
export function nextRenderedSidebarChat<T extends RenderedSidebarElement>(
  items: readonly T[],
): T | null {
  const selected =
    items.find(
      (item) =>
        item.hasAttribute("data-selected") &&
        item.getAttribute(SIDEBAR_ITEM_KEY_ATTRIBUTE)?.startsWith("session:"),
    ) ?? items.find((item) => item.hasAttribute("data-selected"));
  if (!selected) return null;
  const selectedIndex = items.indexOf(selected);
  const selectedKey = selected.getAttribute(SIDEBAR_ITEM_KEY_ATTRIBUTE);
  for (let offset = 1; offset < items.length; offset += 1) {
    const item = items[(selectedIndex + offset) % items.length];
    if (item.getAttribute(SIDEBAR_ITEM_KEY_ATTRIBUTE) === selectedKey) continue;
    if (item.hasAttribute("data-running")) continue;
    return item;
  }
  return null;
}

/**
 * Pick the next ready, unread workspace in rendered sidebar order. The selected
 * row is skipped even when another session in it is unread: this control moves
 * between workspaces and waits until the sidebar's running state has cleared.
 */
export function nextUnreadRenderedWorkspaceItem<
  T extends SidebarAttentionElement,
>(items: readonly T[]): T | null {
  if (items.length === 0) return null;
  const selected = items.findIndex((item) =>
    item.hasAttribute("data-selected"),
  );
  const start = selected >= 0 ? selected + 1 : 0;
  for (let offset = 0; offset < items.length; offset += 1) {
    const index = (start + offset) % items.length;
    if (index === selected) continue;
    if (
      items[index].hasAttribute("data-unread") &&
      !items[index].hasAttribute("data-running")
    )
      return items[index];
  }
  return null;
}
