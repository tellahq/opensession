import { afterAll, describe, expect, mock, test } from "bun:test";
import React, { type ReactElement } from "react";
import {
  DETAIL_PANE,
  RIGHT_PANEL_SLOT,
  WORKSPACE_SHELL,
} from "../lib/app-shell-classes";

function TitleBarStub({ pane }: { pane?: boolean }) {
  return <div data-pane={pane} />;
}

mock.module("./TitleBar", () => ({ TitleBar: TitleBarStub }));
afterAll(() => mock.restore());
const { AppShell } = await import("./AppShell");

type ElementProps = {
  "aria-hidden"?: string;
  "data-testid"?: string;
  children?: React.ReactNode;
  className?: string;
  pane?: boolean;
  ref?: unknown;
};

function elementChildren(
  children: React.ReactNode,
): ReactElement<ElementProps>[] {
  return React.Children.toArray(children).filter(
    (child): child is ReactElement<ElementProps> =>
      React.isValidElement<ElementProps>(child),
  );
}

describe("AppShell", () => {
  test("keeps pane chrome, content, and the right-panel slot in shell order", () => {
    const paneRef = (_node: HTMLElement | null) => {};
    const rightPanelRef = (_node: HTMLDivElement | null) => {};
    const tree = AppShell({
      paneRef,
      rightPanelRef,
      children: <section data-testid="pane-child" />,
    });
    if (!React.isValidElement<ElementProps>(tree)) {
      throw new Error("AppShell did not return a React element");
    }

    expect(tree.type).toBe("div");
    expect(tree.props.className).toBe(WORKSPACE_SHELL);

    const shellChildren = elementChildren(tree.props.children);
    expect(shellChildren).toHaveLength(2);
    const [main, rightPanel] = shellChildren;
    expect(main.type).toBe("main");
    expect(main.props.className).toBe(DETAIL_PANE);
    expect(main.props.ref).toBe(paneRef);
    expect(rightPanel.type).toBe("div");
    expect(rightPanel.props.className).toBe(RIGHT_PANEL_SLOT);
    expect(rightPanel.props.ref).toBe(rightPanelRef);

    const paneChildren = elementChildren(main.props.children);
    expect(paneChildren).toHaveLength(3);
    const [titleBar, dragHandle, child] = paneChildren;
    expect(titleBar.type).toBe(TitleBarStub);
    expect(titleBar.props.pane).toBe(true);
    expect(dragHandle.type).toBe("div");
    expect(dragHandle.props.className).toBe("wco-collapsed-drag-handle");
    expect(dragHandle.props["aria-hidden"]).toBe("true");
    expect(child.props["data-testid"]).toBe("pane-child");
  });
});
