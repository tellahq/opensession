import { expect, test } from "bun:test";
import type { ReactElement } from "react";
import { Button } from "../ui/button";
import { Menu } from "../ui/menu";
import { IconUnarchive } from "./icons";
import { SessionSidebarAction } from "./SessionSidebarAction";
import { KeepInSidebarIcon } from "./sidebar/KeepInSidebarMark";

test("archived sessions render Unarchive in the desktop toolbar", () => {
  let unarchived = 0;
  const action = SessionSidebarAction({
    archived: true,
    canKeepInSidebar: false,
    inMenu: false,
    onKeepInSidebar: () => {},
    onUnarchive: () => unarchived++,
  }) as ReactElement<{
    title: string;
    icon: ReactElement;
    onClick: () => void;
    children: string;
  }>;

  expect(action.type).toBe(Button);
  expect(action.props.title).toBe("Unarchive");
  expect(action.props.children).toBe("Unarchive");
  expect(action.props.icon.type).toBe(IconUnarchive);
  action.props.onClick();
  expect(unarchived).toBe(1);
});

test("non-archived sessions keep Add to sidebar in the phone menu", () => {
  let kept = 0;
  const action = SessionSidebarAction({
    archived: false,
    canKeepInSidebar: true,
    inMenu: true,
    onKeepInSidebar: () => kept++,
    onUnarchive: () => {},
  }) as ReactElement<{
    title: string;
    onClick: () => void;
    children: [ReactElement, ReactElement<{ children: string }>];
  }>;

  expect(action.type).toBe(Menu.Item);
  expect(action.props.title).toBe("Add to sidebar");
  expect(action.props.children[0].type).toBe(KeepInSidebarIcon);
  expect(action.props.children[1].props.children).toBe("Add to sidebar");
  action.props.onClick();
  expect(kept).toBe(1);
});
