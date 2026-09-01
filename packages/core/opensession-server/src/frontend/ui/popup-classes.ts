import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "./cn";
import { type as typography } from "../styles/typography.stylex";

const sx = stylex.create({
  z2147483647: {
    zIndex: "2147483647",
  },
  minW180px: {
    minWidth: "180px",
  },
  overflowHidden: {
    overflow: "hidden",
  },
  roundedPopup: {
    borderRadius: "calc(16px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  CornerShapeSquircle: {
    cornerShape: "squircle",
  },
  bgPopupGlass: {
    backgroundColor: "var(--popup-glass)",
  },
  BackdropFilterVarPopupBlur: {
    WebkitBackdropFilter: "var(--popup-blur)",
    backdropFilter: "var(--popup-blur)",
  },
  SmoothRingColorVarPopupRing: {
    "--smooth-ring-color": "var(--popup-ring)",
  },
  outlineNone: {
    "--tw-outline-style": "none",
    outlineStyle: "none",
  },
  originVarTransformOrigin: {
    transformOrigin: "var(--transform-origin)",
  },
  transitionTransformOpacity: {
    transitionProperty: "transform,opacity",
    transitionTimingFunction: "var(--tw-ease,var(--ease))",
    transitionDuration: "var(--tw-duration,var(--dur-micro))",
  },
  duration120ms: {
    "--tw-duration": ".12s",
    transitionDuration: ".12s",
  },
  easeOut: {
    "--tw-ease": "var(--ease)",
    transitionTimingFunction: "var(--ease)",
  },
  maxHMin60vh420pxVarAvailableHeight: {
    maxHeight: "min(60vh, 420px, var(--available-height))",
  },
  overflowYAuto: {
    overflowY: "auto",
  },
  overflowXHidden: {
    overflowX: "hidden",
  },
  overscrollContain: {
    overscrollBehavior: "contain",
  },
  p15: {
    padding: "6px",
  },
  flex: {
    display: "flex",
  },
  wFull: {
    width: "100%",
  },
  cursorPointer: {
    cursor: "pointer",
  },
  selectNone: {
    WebkitUserSelect: "none",
    userSelect: "none",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap2: {
    gap: "8px",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  px2: {
    paddingInline: "8px",
  },
  py15: {
    paddingBlock: "6px",
  },
  textLeft: {
    textAlign: "left",
  },
  textFg: {
    color: "var(--text)",
  },
  noUnderline: {
    textDecorationLine: "none",
  },
});

/**
 * The chrome every floating list in the app wears: the menu, the right-click
 * menu, and the select. One module so a select popup cannot drift from a menu
 * popup: same glass, same ring, same corner, same enter and exit transition,
 * same row.
 *
 * These are class strings rather than a component because the three popups
 * assemble different Base UI parts (Menu.Popup, ContextMenu.Popup,
 * Select.Popup) around the same surface.
 */

/**
 * A hook name, not styling. Three places ask "is a popup open?" through it:
 * `base.css` hands the Electron title-bar drag region back to the page while
 * a visible popup carries this hook, so an outside press can dismiss, and
 * `ui/sheet.tsx` plus `components/AssetView.tsx` step out of the way of
 * Escape and the arrow keys while a popup owns them. Any popup that owns
 * those keys wears it.
 */
export const POPUP_HOOK = "app-menu-popup";

/** The app's top interaction layer. The pinned workspace summary deliberately
 * sits one step below this, so any menu, select, tooltip, or hover preview a
 * person opens paints above the card regardless of where its trigger lives.
 * Keep this on the portaled positioner rather than the popup surface: Base UI
 * owns positioning and creates the stacking box there. */
export const FLOATING_OVERLAY_LAYER = mergeStylexClassName("", sx.z2147483647);

/** The floating surface itself. `overflow-hidden` keeps the inner scrollbar's
 *  ends clipped to the rounded corner instead of poking past it; the
 *  transition rides Base UI's lifecycle attributes, so exit animates too. */
export const popupSurfaceClasses = mergeStylexClassName(
  "smooth-shadow-ring-md data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
  sx.minW180px,
  sx.overflowHidden,
  sx.roundedPopup,
  sx.CornerShapeSquircle,
  sx.bgPopupGlass,
  sx.BackdropFilterVarPopupBlur,
  sx.SmoothRingColorVarPopupRing,
  sx.outlineNone,
  sx.originVarTransformOrigin,
  sx.transitionTransformOpacity,
  sx.duration120ms,
  sx.easeOut,
);

/** The scroller inside the surface: a long list scrolls, the padding stays. */
export const popupScrollClasses = mergeStylexClassName(
  "",
  sx.maxHMin60vh420pxVarAvailableHeight,
  sx.overflowYAuto,
  sx.overflowXHidden,
  sx.overscrollContain,
  sx.p15,
);

/** One row. Highlight via Base UI's `data-highlighted` so keyboard navigation
 *  lights rows up the same way the pointer does. */
export const popupItemClasses = mergeStylexClassName(
  "data-[highlighted]:bg-hover",
  sx.flex,
  sx.wFull,
  sx.cursorPointer,
  sx.selectNone,
  sx.itemsCenter,
  sx.gap2,
  sx.roundedMd,
  sx.px2,
  sx.py15,
  sx.textLeft,
  typography.controlLabel,
  sx.textFg,
  sx.noUnderline,
  sx.outlineNone,
);
