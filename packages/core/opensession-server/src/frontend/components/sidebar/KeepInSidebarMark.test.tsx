import { expect, test } from "bun:test";
import { KeepInSidebarMark } from "./KeepInSidebarMark";

test("visible but unclaimed rows offer an inline keep action", () => {
  let kept = 0;
  const action = KeepInSidebarMark({ onKeep: () => kept++ });
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
  });

  expect(action.props.label).toBe("Add to your sidebar");
  expect(action.props.children.props["aria-label"]).toBe("Add to your sidebar");
});
