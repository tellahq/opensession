import * as stylex from "@stylexjs/stylex";
import {
  color,
  corner,
  focus,
  geometry,
  media,
  motion,
  opacity,
  radius,
  space,
} from "./tokens.stylex";

const CHECKED = ":is([data-checked])";
const DISABLED = ":is([data-disabled])";

/**
 * The box a Checkbox and a Radio share: the same size, edge, fill and states,
 * so a form that mixes the two reads as one family. Only the corner differs.
 */
export const choice = stylex.create({
  box: {
    display: "flex",
    width: geometry.checkBox,
    height: geometry.checkBox,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    padding: space.s0,
    borderStyle: "solid",
    borderWidth: 1,
    borderColor: {
      default: color.lineStrong,
      // Hover only brightens an empty box; a checked one is already filled.
      ":not([data-checked]):hover": {
        default: null,
        [media.hover]: color.faint,
      },
      [CHECKED]: color.accentControl,
    },
    backgroundColor: { default: color.page, [CHECKED]: color.accentControl },
    cursor: { default: "pointer", [DISABLED]: "default" },
    opacity: { default: null, [DISABLED]: opacity.disabled },
    outline: { default: "none", ":focus-visible": focus.ring },
    outlineOffset: { default: null, ":focus-visible": focus.offset },
    transitionProperty: "background-color, border-color",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
  },
  square: { borderRadius: radius.sm, ["cornerShape"]: corner.squircle },
  round: { borderRadius: radius.pill },
});
