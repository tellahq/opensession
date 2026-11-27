import * as stylex from "@stylexjs/stylex";
import {
  color,
  controlHeight,
  corner,
  leading,
  media,
  motion,
  opacity,
  radius,
  shadow,
  space,
  text,
} from "./tokens.stylex";

/** An `<input>`, as opposed to a textarea or a native select sharing the
 *  field. Zero specificity on the element part, like the class it replaces. */
const INPUT = ":where(input)";

/**
 * The field well every text input, textarea, native select and select
 * trigger shares: the soft `control` corner (a field is a well, a button is a
 * capsule), the page's own surface, a hairline that turns accent on focus
 * instead of growing a ring, and Button's heights step for step.
 */
export const field = stylex.create({
  base: {
    width: "100%",
    borderRadius: radius.control,
    ["cornerShape"]: corner.squircle,
    borderStyle: "solid",
    borderWidth: 1,
    borderColor: { default: color.line, ":focus": color.accent },
    backgroundColor: color.page,
    color: { default: color.fg, "::placeholder": color.faint },
    outlineStyle: "none",
    cursor: { default: null, ":disabled": "default" },
    opacity: { default: null, ":disabled": opacity.disabled },
    transitionProperty:
      "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
    // One line in a box of the step's height centres an input's text in
    // Chromium and WebKit alike (each size sets the matching line height).
    // Textareas and native selects keep their own.
    paddingBlock: { default: null, [INPUT]: space.s0 },
  },
  sm: {
    minHeight: controlHeight.sm,
    height: { default: null, [INPUT]: controlHeight.sm },
    paddingInline: space.s8,
    fontSize: text.label,
    lineHeight: { default: leading.small, [INPUT]: leading.none },
  },
  md: {
    minHeight: controlHeight.md,
    height: { default: null, [INPUT]: controlHeight.md },
    paddingInline: space.s10,
    fontSize: text.label,
    lineHeight: { default: leading.label, [INPUT]: leading.none },
  },
  lg: {
    minHeight: controlHeight.lg,
    height: { default: null, [INPUT]: controlHeight.lg },
    paddingInline: space.s12,
    fontSize: text.body,
    lineHeight: { default: leading.body, [INPUT]: leading.none },
  },
  /** Multi-line entry, padded like a paragraph. */
  textarea: { resize: "vertical", paddingBlock: space.s8 },
  /** A native select. */
  select: { cursor: { default: "pointer", ":disabled": "default" } },
  /**
   * The field-shaped trigger `ui/select` and `ui/combobox` share. The chevron
   * sits in flow in its own grid column, so the field's padding is what
   * separates it from the edge. It lifts slightly under the pointer; an open
   * popup reads like focus, with the border carrying that state.
   */
  trigger: {
    display: "inline-grid",
    cursor: { default: "pointer", ":disabled": "default" },
    alignItems: "center",
    gap: space.s8,
    paddingRight: space.s8,
    textAlign: "left",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    transitionProperty: "border-color, box-shadow",
    // Hover is scoped off a focused or open trigger: StyleX emits the hover
    // media query after every plain state, so a bare hover would grey the
    // accent border under the pointer.
    borderColor: {
      default: color.line,
      ":not([data-popup-open]):not(:focus):hover": {
        default: null,
        [media.hover]: color.lineStrong,
      },
      ":focus": color.accent,
      ":is([data-popup-open])": color.accent,
    },
    boxShadow: {
      default: null,
      ":enabled:hover": { default: null, [media.hover]: shadow.xs },
    },
  },
  triggerWithIcon: { gridTemplateColumns: "auto minmax(0, 1fr) auto" },
  // The trigger's parts. Every child sits on row 1 so the `sizeTo` copies
  // stack under the value and widen the column instead of the row.
  triggerIcon: {
    display: "flex",
    gridColumnStart: 1,
    gridRowStart: 1,
    width: space.s16,
    height: space.s16,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    color: color.dim,
  },
  triggerLabel: {
    gridRowStart: 1,
    gridColumnStart: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  /** The label after a leading icon. */
  triggerLabelAfterIcon: { gridColumnStart: 2 },
  /** A width-reserving copy of an option the trigger can show. */
  triggerSizer: { visibility: "hidden" },
  triggerChevron: {
    gridRowStart: 1,
    gridColumnStart: 2,
    flexShrink: 0,
    color: color.faint,
  },
  triggerChevronAfterIcon: { gridColumnStart: 3 },
});
