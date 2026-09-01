import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "../ui/cn";

const sx = stylex.create({
  flex: {
    display: "flex",
  },
  hVarDesktopHeaderH: {
    height: "var(--desktop-header-h)",
  },
  shrink0: {
    flexShrink: "0",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap2: {
    gap: "8px",
  },
  borderB: {
    borderBottomStyle: "var(--tw-border-style)",
    borderBottomWidth: "1px",
  },
  borderDivider: {
    borderColor: "var(--divider)",
  },
  px4: {
    paddingInline: "16px",
  },
  pointerEventsNone: {
    pointerEvents: "none",
  },
  absolute: {
    position: "absolute",
  },
  top3: {
    top: "12px",
  },
  left12: {
    left: "50%",
  },
  z5: {
    zIndex: "5",
  },
  maxWCalc10032px: {
    maxWidth: "calc(100% - 32px)",
  },
  TranslateX12: {
    "--tw-translate-x": "calc(calc(1 / 2 * 100%) * -1)",
    translate: "var(--tw-translate-x) var(--tw-translate-y)",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap15: {
    gap: "6px",
  },
});

/**
 * The bar across the top of each Support inbox column.
 *
 * The queue and the ticket beside it share one height, the app's own
 * `--desktop-header-h`, so the two columns and the sidebar's brand row all
 * start on one line. `wco-chrome` is what makes the row a drag region in the
 * desktop shell, which is why the box is drawn even when it has nothing in it:
 * a bar that came and went with the open ticket would take the window's top
 * edge with it, and the pane below would jump by its height.
 *
 * Shared because two components fill it. The queue puts its name and count
 * here; the open ticket puts its subject and customer here (ConversationPane's
 * `headerInBar`), which is why that pane draws its own copy rather than being
 * handed one.
 */
export const SUPPORT_COLUMN_BAR =
  mergeStylexClassName(
    "wco-chrome",
    sx.flex,
    sx.hVarDesktopHeaderH,
    sx.shrink0,
    sx.itemsCenter,
    sx.gap2,
  ) +
  " " +
  mergeStylexClassName("", sx.borderB, sx.borderDivider, sx.px4);

/**
 * Where the ticket's agent affordance floats: the offer to triage it, or the
 * session already working on it.
 *
 * It is a sibling of the scroll area, not a row in it, so the thread runs on
 * underneath — the same shape the transcript gives "Load all", which is why
 * the pills in it are that pill (in its opaque form: a support message runs
 * the full width of the column, so glass would show the words through). As a
 * block in the flow it was a full-width plate wedged between the last message
 * and the composer, which is a lot of furniture for one button and cut the
 * conversation off short of the box you answer it in.
 *
 * `pointer-events-none` so the thread under it stays selectable; each pill
 * turns them back on for itself. The thread pays for the space it occupies in
 * its own top padding, so nothing sits under the pill at rest.
 */
export const SUPPORT_TOP_RAIL =
  mergeStylexClassName(
    "",
    sx.pointerEventsNone,
    sx.absolute,
    sx.top3,
    sx.left12,
    sx.z5,
    sx.flex,
    sx.maxWCalc10032px,
  ) +
  " " +
  mergeStylexClassName(
    "",
    sx.TranslateX12,
    sx.flexCol,
    sx.itemsCenter,
    sx.gap15,
  );
