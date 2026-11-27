import { IconCopy } from "../components/icons";
import * as stylex from "@stylexjs/stylex";
import { CopyCheck, useCopy } from "./copy";
import { focusStyles } from "./focus-styles";
import { deviceCodeMarker } from "./markers.stylex";
import { sx } from "./sx";
import {
  color,
  corner,
  font,
  geometry,
  media,
  motion,
  opacity,
  radius,
  shadow,
  space,
  text,
  weight,
} from "./tokens.stylex";

const styles = stylex.create({
  button: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s6,
    borderRadius: radius.control,
    ["cornerShape"]: corner.squircle,
    borderStyle: "solid",
    borderWidth: geometry.hairline,
    borderColor: {
      default: color.line,
      ":hover": { default: null, [media.hover]: color.lineStrong },
    },
    backgroundColor: {
      default: color.control,
      ":hover": { default: null, [media.hover]: color.hover },
    },
    paddingInline: space.s10,
    paddingBlock: space.s4,
    fontFamily: font.mono,
    fontSize: text.itemTitle,
    fontWeight: weight.bold,
    color: color.fg,
    boxShadow: shadow.sm,
    transitionProperty: "background-color, border-color, scale",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
    scale: { default: null, ":active": motion.pressPlateScale },
  },
  // Cap-band centred against the copy glyph: `text-box` trims the line box
  // to cap height and baseline, so the code's own ink sits on the button's
  // middle whatever font the platform picks, plus the half pixel the PR
  // strip's labels carry.
  code: {
    translate: geometry.opticalNudge,
    letterSpacing: geometry.codeTracking,
    marginRight: geometry.codeTrackingBack,
    textBox: "trim-both cap alphabetic",
  },
  glyph: {
    transitionProperty: "opacity",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
    opacity: {
      default: opacity.glyphResting,
      [stylex.when.ancestor(":hover", deviceCodeMarker)]: {
        default: null,
        [media.hover]: opacity.glyphOnTone,
      },
    },
  },
});
import { Tooltip } from "./tooltip";

/**
 * A one-time device code (GitHub, ChatGPT) that someone has to enter on
 * another site — rendered as the button it always wanted to be. Retyping
 * `4A56-C7AE` by hand is most of what a device flow costs the person doing it,
 * and the code was previously plain text on three separate surfaces, so the
 * copy affordance lives here rather than being re-invented per flow.
 *
 * Wide tracking is what keeps an ambiguous code readable (0/O, 1/I), but
 * letter-spacing also pads the glyph *after* the last character; the negative
 * margin pulls that phantom column back off the copy glyph so the pair isn't
 * lopsided.
 */
export function DeviceCode({
  code,
  className,
  /** Accessible/tooltip verb — override only if "code" is the wrong noun. */
  label = "Copy code",
}: {
  code: string;
  className?: string;
  label?: string;
}) {
  const { copied, copy } = useCopy();
  return (
    <Tooltip label={copied ? "Copied" : label}>
      <button
        type="button"
        aria-label={`${label} ${code}`}
        onClick={() => copy(code, { toast: "Code copied" })}
        {...sx([styles.button, focusStyles.ring, deviceCodeMarker], className)}
      >
        <span {...stylex.props(styles.code)}>{code}</span>
        <CopyCheck
          copied={copied}
          size={20}
          idle={<IconCopy size={20} {...stylex.props(styles.glyph)} />}
        />
      </button>
    </Tooltip>
  );
}
