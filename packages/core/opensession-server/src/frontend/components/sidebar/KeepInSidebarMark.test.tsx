import { expect, test } from "bun:test";
import type { ReactElement } from "react";
import { KeepInSidebarMark } from "./KeepInSidebarMark";

type ActivationEvent = {
  key?: string;
  preventDefault: () => void;
  stopPropagation: () => void;
};
type KeepTriggerProps = {
  role: string;
  "aria-label": string;
  "data-sidebar-keep": string;
  className: string;
  onClick: (event: ActivationEvent) => void;
  onKeyDown: (event: ActivationEvent) => void;
};

test("visible but unclaimed rows offer an inline keep action", () => {
  let kept = 0;
  const action = KeepInSidebarMark({ onKeep: () => kept++ }) as ReactElement<{
    label: string;
    children: ReactElement<KeepTriggerProps>;
  }>;
  const trigger = action.props.children;
  const event = {
    preventDefault: () => {},
    stopPropagation: () => {},
  };

  expect(action.props.label).toBe("Keep in sidebar");
  expect(trigger.props.role).toBe("button");
  expect(trigger.props["aria-label"]).toBe("Keep in sidebar");
  expect(trigger.props["data-sidebar-keep"]).toBe("");
  expect(trigger.props.className).toContain("text-faint");
  trigger.props.onClick(event);
  trigger.props.onKeyDown({ ...event, key: "Enter" });
  expect(kept).toBe(2);
});

test("the inline action can describe adding a teammate's session", () => {
  const action = KeepInSidebarMark({
    onKeep: () => {},
    label: "Add to your sidebar",
  }) as ReactElement<{
    label: string;
    children: ReactElement<KeepTriggerProps>;
  }>;

  expect(action.props.label).toBe("Add to your sidebar");
  expect(action.props.children.props["aria-label"]).toBe("Add to your sidebar");
});
