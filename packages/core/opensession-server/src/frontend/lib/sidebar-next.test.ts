import { describe, expect, test } from "bun:test";
import {
  SIDEBAR_ITEM_KEY_ATTRIBUTE,
  nextRenderedSidebarChat,
  nextRenderedSidebarItem,
  nextUnreadRenderedWorkspaceItem,
} from "./sidebar-next";

function item(key?: string) {
  return {
    key,
    getAttribute(name: string) {
      return name === SIDEBAR_ITEM_KEY_ATTRIBUTE ? (key ?? null) : null;
    },
  };
}

describe("nextRenderedSidebarItem", () => {
  test("uses rendered order", () => {
    const current = item("workspace:current");
    const next = item("workspace:next");
    const later = item("workspace:later");

    expect(
      nextRenderedSidebarItem(
        [current, next, later],
        current,
        "workspace:current",
      ),
    ).toBe(next);
  });

  test("skips another rendered copy of the archived item", () => {
    const current = item("workspace:current");
    const duplicate = item("workspace:current");
    const next = item("workspace:next");

    expect(
      nextRenderedSidebarItem(
        [current, duplicate, next],
        current,
        "workspace:current",
      ),
    ).toBe(next);
  });

  test("falls back to the previous item at the end", () => {
    const previous = item("workspace:previous");
    const current = item("workspace:current");

    expect(
      nextRenderedSidebarItem(
        [previous, current],
        current,
        "workspace:current",
      ),
    ).toBe(previous);
  });

  test("finds the current item by key when its element is unavailable", () => {
    const current = item("session:current");
    const next = item();

    expect(
      nextRenderedSidebarItem([current, next], null, "session:current"),
    ).toBe(next);
  });
});

function renderedItem(key: string, selected = false, running = false) {
  return {
    getAttribute(name: string) {
      return name === SIDEBAR_ITEM_KEY_ATTRIBUTE ? key : null;
    },
    hasAttribute(name: string) {
      return (
        (name === "data-selected" && selected) ||
        (name === "data-running" && running)
      );
    },
  };
}

describe("nextRenderedSidebarChat", () => {
  test("continues after the selected session when its workspace is also selected", () => {
    const workspace = renderedItem("workspace:current", true);
    const session = renderedItem("session:current", true);
    const next = renderedItem("workspace:next");

    expect(nextRenderedSidebarChat([workspace, session, next])).toBe(next);
  });

  test("wraps from the last chat to the first", () => {
    const first = renderedItem("workspace:first");
    const last = renderedItem("workspace:last", true);

    expect(nextRenderedSidebarChat([first, last])).toBe(first);
  });

  test("skips a chat whose turn is still running", () => {
    const selected = renderedItem("workspace:current", true);
    const running = renderedItem("workspace:running", false, true);
    const ready = renderedItem("workspace:ready");

    expect(nextRenderedSidebarChat([selected, running, ready])).toBe(ready);
  });

  test("returns null when every other chat is running", () => {
    const selected = renderedItem("workspace:current", true);
    const running = renderedItem("workspace:running", false, true);

    expect(nextRenderedSidebarChat([selected, running])).toBeNull();
  });

  test("returns null when no rendered chat is selected", () => {
    expect(
      nextRenderedSidebarChat([
        renderedItem("workspace:first"),
        renderedItem("workspace:second"),
      ]),
    ).toBeNull();
  });
});

function attentionItem({
  selected = false,
  unread = false,
  running = false,
}: {
  selected?: boolean;
  unread?: boolean;
  running?: boolean;
} = {}) {
  return {
    hasAttribute(name: string) {
      return (
        (name === "data-selected" && selected) ||
        (name === "data-unread" && unread) ||
        (name === "data-running" && running)
      );
    },
  };
}

describe("nextUnreadRenderedWorkspaceItem", () => {
  test("skips the selected workspace even when it has an unread session", () => {
    const selected = attentionItem({ selected: true, unread: true });
    const next = attentionItem({ unread: true });

    expect(nextUnreadRenderedWorkspaceItem([selected, next])).toBe(next);
  });

  test("scans forward from the selected workspace and wraps", () => {
    const before = attentionItem({ unread: true });
    const selected = attentionItem({ selected: true });
    const after = attentionItem({ unread: true });

    expect(nextUnreadRenderedWorkspaceItem([before, selected, after])).toBe(
      after,
    );
    expect(
      nextUnreadRenderedWorkspaceItem([before, selected, attentionItem()]),
    ).toBe(before);
  });

  test("uses the first unread workspace when nothing is selected", () => {
    const read = attentionItem();
    const unread = attentionItem({ unread: true });

    expect(nextUnreadRenderedWorkspaceItem([read, unread])).toBe(unread);
  });

  test("skips unread workspaces that are still running", () => {
    const running = attentionItem({ unread: true, running: true });
    const ready = attentionItem({ unread: true });

    expect(nextUnreadRenderedWorkspaceItem([running, ready])).toBe(ready);
    expect(nextUnreadRenderedWorkspaceItem([running])).toBeNull();
  });

  test("returns null when only the selected workspace is unread", () => {
    expect(
      nextUnreadRenderedWorkspaceItem([
        attentionItem(),
        attentionItem({ selected: true, unread: true }),
      ]),
    ).toBeNull();
  });
});
