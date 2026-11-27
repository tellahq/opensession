import * as React from "react";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import * as stylex from "@stylexjs/stylex";
import { ExclusivePopupProvider } from "./exclusive-popups";
import { popup } from "./popup-styles";
import { sx } from "./sx";
import {
  color,
  geometry,
  leading,
  motion,
  radius,
  corner,
  shadow,
  space,
  text,
  weight,
} from "./tokens.stylex";
import { usePopupsArmed } from "./popup-arming";

/**
 * Tooltip on Base UI (Tooltip.Root/Trigger/Positioner/Popup), styled in
 * StyleX on the shared tokens: Base UI parts for behavior (positioning,
 * collision flip, focus/hover semantics, a11y), our styles on top.
 *
 * Keeps the exact API of the old hand-rolled components/Tooltip.tsx
 * (label/side/offset/shortcut, single-element child, no wrapper DOM) so call
 * sites didn't change. Open delay + instant group hand-off between adjacent
 * triggers come from <TooltipProvider> at the app root.
 *
 * Inside an unarmed PopupArmingRegion (ui/popup-arming.ts) the child renders
 * alone until the region arms, which happens before the pointer reaches it.
 *
 * Animation follows Base UI's lifecycle attributes. In particular,
 * data-instant disables transitions while the provider hands off between two
 * triggers, so the outgoing tooltip cannot remain visible beside the new one.
 */

const STARTING = ":is([data-starting-style])";
const ENDING = ":is([data-ending-style])";

/** `color-mix` ink at a fixed strength over whatever surface is behind it. */
const ink = (c: string, pct: number) =>
  `color-mix(in oklab, ${c} ${pct}%, transparent)`;

const styles = stylex.create({
  // 13px medium text on a near-black chip, with its soft drop and the
  // theme's ring.
  chip: {
    pointerEvents: "none",
    display: "flex",
    alignItems: "center",
    gap: space.s8,
    transformOrigin: "var(--transform-origin)",
    transitionProperty: {
      default: "scale, opacity",
      ":is([data-instant])": "none",
    },
    transitionDuration: motion.popup,
    transitionTimingFunction: motion.easeOut,
    scale: { default: null, [STARTING]: motion.tooltipScale },
    opacity: { default: null, [STARTING]: 0, [ENDING]: 0 },
    borderRadius: radius.lg,
    ["cornerShape"]: corner.squircle,
    backgroundColor: color.tooltip,
    paddingInline: space.s8,
    paddingBlock: space.s4,
    fontSize: text.label,
    lineHeight: leading.snug,
    fontWeight: weight.medium,
    color: color.tooltipFg,
    boxShadow: shadow.tooltip,
  },
  // One line is centred on its CAP BAND (see `capBand`), so the chip keeps
  // the height an untrimmed line gave it and centres the trimmed one in it.
  single: {
    maxWidth: geometry.tooltipMax,
    whiteSpace: "nowrap",
    minHeight: `calc(${text.label} * ${leading.snug} + 2 * ${space.s4})`,
    paddingBlock: 0,
  },
  multiline: {
    maxWidth: geometry.tooltipMaxMultiline,
    alignItems: "flex-start",
    whiteSpace: "pre-wrap",
  },
  labelSingle: { overflow: "hidden", textOverflow: "ellipsis" },
  // The line box carries the font's descender space, so flex centring put
  // the label and keycap letters about 1.75px high. `text-box` trims the box
  // to cap height and baseline, the same fix as the Button label. Browsers
  // without it keep the untrimmed line, centred as before.
  capBand: { textBox: "trim-both cap alphabetic" },
  // The single-line label also clips to truncate, which would cut off the
  // ascenders and descenders the trim leaves outside its box. Equal padding
  // gives the ink room inside the clip, and the matching negative margin
  // keeps it out of the layout, so the cap band stays the centre.
  inkRoom: {
    paddingBlock: geometry.inkRoom,
    marginBlock: `calc(-1 * ${geometry.inkRoom})`,
  },
  labelMultiline: { maxHeight: geometry.tooltipMaxHeight, overflowY: "auto" },
  keys: {
    display: "inline-flex",
    alignItems: "center",
    gap: geometry.keyCapPad,
  },
  key: {
    display: "inline-flex",
    height: geometry.keyCap,
    minWidth: geometry.keyCap,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    ["cornerShape"]: corner.squircle,
    paddingInline: geometry.keyCapPad,
    fontSize: text.label,
    lineHeight: leading.small,
    fontWeight: weight.medium,
    fontFamily: "inherit",
    backgroundColor: ink(color.onScrim, 20),
    color: ink(color.onScrim, 75),
  },
});

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

/** Mount once at the app root: shared 200ms open delay, and for 300ms after a
 * tooltip closes, neighbouring triggers open instantly (toolbar sweep). */
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <BaseTooltip.Provider delay={200} timeout={300}>
      <ExclusivePopupProvider>{children}</ExclusivePopupProvider>
    </BaseTooltip.Provider>
  );
}

export function Tooltip({
  label,
  side = "top",
  align = "center",
  offset = 8,
  shortcut,
  multiline,
  popupClassName,
  children,
}: {
  label: React.ReactNode;
  side?: Side;
  /** Where along `side` the popup sits. "start" keeps it by the trigger's
   *  leading edge — right for a wide block trigger, where centering would
   *  float the tip far from whatever the cursor is actually over. */
  align?: Align;
  offset?: number;
  /** Optional keyboard-shortcut badges, e.g. ["⌘", "S"]. */
  shortcut?: string[];
  /** Wrap long content instead of the default single nowrap line. */
  multiline?: boolean;
  /** Extend the shared popup surface for richer tooltip content. */
  popupClassName?: string;
  children: React.ReactElement;
}) {
  const armed = usePopupsArmed();
  if (!label || !armed) return children;

  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal
        // Base UI otherwise inherits a containing popup's portal target. Mount
        // tooltips at the page root so their floating layer can sit above that
        // popup instead of being trapped inside its stacking context.
        container={typeof document !== "undefined" ? document.body : undefined}
      >
        <BaseTooltip.Positioner
          side={side}
          align={align}
          sideOffset={offset}
          collisionPadding={6}
          {...stylex.props(popup.layer)}
        >
          <BaseTooltip.Popup
            {...sx(
              [styles.chip, multiline ? styles.multiline : styles.single],
              popupClassName,
            )}
          >
            <span
              {...stylex.props(
                multiline
                  ? styles.labelMultiline
                  : [styles.labelSingle, styles.capBand, styles.inkRoom],
              )}
            >
              {label}
            </span>
            {shortcut && shortcut.length > 0 && (
              <span {...stylex.props(styles.keys)}>
                {shortcut.map((k, i) => (
                  <kbd key={i} {...stylex.props(styles.key)}>
                    <span {...stylex.props(styles.capBand)}>{k}</span>
                  </kbd>
                ))}
              </span>
            )}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
