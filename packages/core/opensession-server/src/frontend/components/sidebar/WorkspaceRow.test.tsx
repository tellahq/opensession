import { expect, test } from "bun:test";
import React, { type ReactElement, type ReactNode } from "react";
import { SIDEBAR_SWIPE_ROW, SIDEBAR_WS_ROW } from "../../lib/sidebar-classes";
import type { WsRow } from "../../lib/sidebar-types";

Object.assign(
  ((globalThis as unknown as { window?: Record<string, unknown> }).window ??=
    {}),
  {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    matchMedia: () => ({ matches: false }),
    setInterval: () => 0,
  },
);
Object.assign(
  ((
    globalThis as unknown as { localStorage?: Record<string, unknown> }
  ).localStorage ??= {}),
  {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
);
Object.assign(
  ((
    globalThis as unknown as { document?: Record<string, unknown> }
  ).document ??= {}),
  {
    documentElement: { dataset: {}, style: { colorScheme: "" } },
    querySelector: () => null,
    addEventListener: () => {},
    visibilityState: "visible",
  },
);

const { WorkspaceDraftIndicator } = await import("./WorkspaceDraftIndicator");
const { WorkspaceRow } = await import("./WorkspaceRow");

interface ClickEvent {
  stopPropagation: () => void;
}

interface TreeProps {
  children?: ReactNode;
  className?: string;
  onClick?: (event: ClickEvent) => void;
  "data-sidebar-item-key"?: string;
  "data-swipe-action"?: string;
  "data-unread"?: boolean;
}

function collectElements(node: ReactNode, elements: ReactElement<TreeProps>[]) {
  React.Children.forEach(node, (child) => {
    if (!React.isValidElement<TreeProps>(child)) return;
    elements.push(child);
    collectElements(child.props.children, elements);
  });
}

test("renders workspace row state and wires row and swipe actions", () => {
  const row: WsRow = {
    key: "workspace:draft",
    workspace: null,
    name: "Draft workspace",
    sessions: [],
    status: "pending",
    lastActivity: "2026-09-01T08:00:00.000Z",
    createdAt: "2026-09-01T08:00:00.000Z",
    unread: true,
    running: false,
    owner: "jaap",
  };
  let activated = 0;
  let closedSwipe = 0;
  let deleted = 0;
  let pinned = 0;
  let stopped = 0;

  const rendered = WorkspaceRow({
    row,
    presentation: {
      inbox: false,
      active: true,
      isPhone: true,
      isDraft: true,
      hasSectionHeading: true,
      groupsByRepo: false,
      repoName: "opensession",
      runStartSeenMs: null,
      snoozed: false,
      snoozeIso: null,
      timePreference: "off",
      shipsDirectlyToMain: false,
      pinned: true,
    },
    context: {
      editing: null,
      currentUser: "Jaap",
      mePersonKey: "jaap",
      teamViewing: [],
    },
    swipe: { offset: 72, action: "star", dragging: false, dragSide: null },
    shortcuts: { pinShortcutKeys: ["⌘", "P"] },
    events: {
      onActivate: () => activated++,
      onMouseEnter: () => {},
      onMouseLeave: () => {},
      onMouseDown: () => {},
      onTouchStart: () => {},
      onTouchMove: () => {},
      onTouchEnd: () => {},
      onTouchCancel: () => {},
      onContextMenu: () => {},
    },
    actions: {
      onCloseSwipe: () => closedSwipe++,
      onTogglePin: () => pinned++,
      onToggleSnooze: () => {},
      onArchive: () => {},
      onDeleteDraft: () => deleted++,
      onConfirmDeleteDraft: (onConfirm) => onConfirm(),
      onOpenMention: () => {},
      onStartWorkspaceRename: () => {},
      onStartSessionRename: () => {},
      onKeepInSidebar: () => {},
    },
  });
  if (!React.isValidElement<TreeProps>(rendered))
    throw new Error("WorkspaceRow did not return a React element");
  const tree = rendered;

  const elements: ReactElement<TreeProps>[] = [tree];
  collectElements(tree.props.children, elements);
  const draftAction = elements.find(
    (element) => element.props["data-swipe-action"] === "delete",
  );
  const pinAction = elements.find(
    (element) => element.props["data-swipe-action"] === "star",
  );
  const rowButton = elements.find(
    (element) =>
      element.props["data-sidebar-item-key"] === "workspace:workspace:draft",
  );

  expect(tree.props.className).toBe(SIDEBAR_SWIPE_ROW);
  expect(rowButton?.props.className).toContain(SIDEBAR_WS_ROW);
  expect(rowButton?.props["data-unread"]).toBe(true);
  expect(
    elements.some((element) => element.type === WorkspaceDraftIndicator),
  ).toBe(true);

  const event = { stopPropagation: () => stopped++ };
  draftAction?.props.onClick?.(event);
  pinAction?.props.onClick?.(event);
  rowButton?.props.onClick?.(event);

  expect({ activated, closedSwipe, deleted, pinned, stopped }).toEqual({
    activated: 1,
    closedSwipe: 2,
    deleted: 1,
    pinned: 1,
    stopped: 2,
  });
});
