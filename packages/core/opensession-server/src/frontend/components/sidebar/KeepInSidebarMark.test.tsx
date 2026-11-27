import { expect, test } from "bun:test";
import { SIDEBAR_WS_ACTION_STYLES } from "../../lib/sidebar-classes";
import { KeepInSidebarMark } from "./KeepInSidebarMark";

test("visible but unclaimed rows offer an inline keep action", () => {
  let kept = 0;
  const action = KeepInSidebarMark({
    onKeep: () => kept++,
    xstyle: SIDEBAR_WS_ACTION_STYLES,
  });
  const trigger = action.props.children;
  const event = {
    preventDefault: () => {},
    stopPropagation: () => {},
  };

  expect(action.props.label).toBe("Keep in sidebar");
  expect(trigger.props.role).toBe("button");
  expect(trigger.props["aria-label"]).toBe("Keep in sidebar");
  expect(trigger.props["data-sidebar-keep"]).toBe("");
  // StyleX names a class `<file>__<styles>.<key>` under test: the mark's own
  // look and the row chip it was handed, in one call.
  expect(trigger.props.className).toContain("KeepInSidebarMark__styles.mark");
  expect(trigger.props.className).toContain("sidebarStyles.rowAction");
  trigger.props.onClick(event);
  trigger.props.onKeyDown({ ...event, key: "Enter" });
  expect(kept).toBe(2);
});

test("the inline action can describe adding a teammate's session", () => {
  const action = KeepInSidebarMark({
    onKeep: () => {},
    label: "Add to your sidebar",
    xstyle: SIDEBAR_WS_ACTION_STYLES,
  });

  expect(action.props.label).toBe("Add to your sidebar");
  expect(action.props.children.props["aria-label"]).toBe("Add to your sidebar");
});
