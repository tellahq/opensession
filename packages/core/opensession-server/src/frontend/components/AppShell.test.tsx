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

function KeptFrameLayerStub() {
  return null;
}

mock.module("./TitleBar", () => ({ TitleBar: TitleBarStub }));
mock.module("./KeptFrameLayer", () => ({ KeptFrameLayer: KeptFrameLayerStub }));
afterAll(() => mock.restore());
const { AppShell } = await import("./AppShell");

type ElementProps = {
  "aria-hidden"?: string;
  "data-testid"?: string;
  children?: React.ReactNode;
  className?: string;
  pane?: boolean;
  panel?: boolean;
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
  test("keeps pane chrome, content, the right-panel slot, and its kept pages in shell order", () => {
    const paneRef = (_node: HTMLElement | null) => {};
    const rightPanelRef = (_node: HTMLDivElement | null) => {};
    const tree = AppShell({
      paneRef,
      rightPanelRef,
      collapsedControls: <button data-testid="reopen" />,
      children: <section data-testid="pane-child" />,
    });
    if (!React.isValidElement<ElementProps>(tree)) {
      throw new Error("AppShell did not return a React element");
    }

    expect(tree.type).toBe("div");
    expect(tree.props.className).toBe(WORKSPACE_SHELL);

    const shellChildren = elementChildren(tree.props.children);
    expect(shellChildren).toHaveLength(3);
    const [main, rightPanel, panelFrames] = shellChildren;
    expect(main.type).toBe("main");
    expect(main.props.className).toBe(DETAIL_PANE);
    expect(main.props.ref).toBe(paneRef);
    expect(rightPanel.type).toBe("div");
    expect(rightPanel.props.className).toBe(RIGHT_PANEL_SLOT);
    expect(rightPanel.props.ref).toBe(rightPanelRef);
    // After the panel's slot, so the panel's kept pages paint over it.
    expect(panelFrames.type).toBe(KeptFrameLayerStub);
    expect(panelFrames.props.panel).toBe(true);

    const paneChildren = elementChildren(main.props.children);
    expect(paneChildren).toHaveLength(4);
    const [child, reopen, titleBar, keptFrames] = paneChildren;
    expect(child.props["data-testid"]).toBe("pane-child");
    // Floating controls follow the draggable header in document order, so
    // Electron applies their no-drag regions after the header's drag region.
    expect(reopen.props["data-testid"]).toBe("reopen");
    expect(titleBar.type).toBe(TitleBarStub);
    expect(titleBar.props.pane).toBe(true);
    // Last, so kept Browser and Portal pages paint over their slots.
    expect(keptFrames.type).toBe(KeptFrameLayerStub);
  });
});
