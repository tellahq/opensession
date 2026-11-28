import * as stylex from "@stylexjs/stylex";
import {
  color,
  controlHeight,
  corner,
  geometry,
  layer,
  media,
  motion,
  opacity,
  radius,
  shadow,
  space,
  text,
  tracking,
  weight,
} from "./tokens.stylex";

const STARTING = ":is([data-starting-style])";
const ENDING = ":is([data-ending-style])";

/**
 * The chrome every floating list wears: the menu, the right-click menu, the
 * select and the combobox. One style so a select popup cannot drift from a
 * menu popup: same glass, same ring, same corner, same enter and exit, same
 * row.
 */
export const popup = stylex.create({
  /** The floating surface. `overflow: hidden` keeps the inner scrollbar's
   *  ends clipped to the corner; the transition rides Base UI's lifecycle
   *  attributes, so exit animates too. */
  surface: {
    minWidth: geometry.popupMinWidth,
    overflow: "hidden",
    borderRadius: radius.popup,
    ["cornerShape"]: corner.squircle,
    backgroundColor: color.popupGlass,
    backdropFilter: "var(--popup-blur)",
    // The ring tier, tinted to the popup's own ring colour.
    "--smooth-ring-color": color.popupRing,
    boxShadow: shadow.ringMd,
    outline: {
      default: "none",
      // Windows High Contrast strips every shadow, the ring with it.
      [media.forcedColors]: shadow.ringForced,
    },
    outlineOffset: {
      default: null,
      [media.forcedColors]: shadow.ringForcedOffset,
    },
    transformOrigin: "var(--transform-origin)",
    transitionProperty: "scale, opacity",
    transitionDuration: motion.popup,
    transitionTimingFunction: motion.easeOut,
    scale: { default: null, [STARTING]: motion.popupScale },
    opacity: { default: null, [STARTING]: 0, [ENDING]: 0 },
  },
  /** The scroller inside the surface: a long list scrolls, the padding stays.
   *  `pan-y` keeps nested rows from claiming an iOS swipe as a press. */
  scroll: {
    maxHeight: {
      default: geometry.popupMaxHeight,
      [media.phone]: geometry.popupMaxHeightPhone,
    },
    touchAction: "pan-y",
    overflowY: "auto",
    overflowX: "hidden",
    overscrollBehavior: "contain",
    padding: space.s6,
  },
  /** One row. Lit by Base UI's `data-highlighted`, so the keyboard lights
   *  rows the way the pointer does. */
  item: {
    display: "flex",
    width: "100%",
    cursor: { default: "pointer", ":is([data-disabled])": "default" },
    userSelect: "none",
    alignItems: "center",
    gap: space.s8,
    borderRadius: radius.popupRow,
    ["cornerShape"]: corner.squircle,
    paddingInline: space.s8,
    paddingBlock: space.s6,
    // A finger's row on a phone, the way the platform's own menus size it.
    minHeight: { default: null, [media.phone]: controlHeight.touch },
    textAlign: "left",
    fontSize: text.label,
    color: color.fg,
    textDecoration: "none",
    outline: "none",
    backgroundColor: { default: null, ":is([data-highlighted])": color.hover },
    // A row that cannot act stays in place, quieter, rather than vanishing.
    opacity: { default: null, ":is([data-disabled])": opacity.disabled },
  },
  /** A destructive row: red ink, and a red wash when lit, so the row reads
   *  as a warning before the press rather than after it. */
  itemDanger: {
    color: color.red,
    backgroundColor: {
      default: null,
      ":is([data-highlighted])": color.redSoft,
    },
  },
  /** A submenu trigger stays lit while its submenu is open. */
  itemOpen: {
    backgroundColor: {
      default: null,
      ":is([data-highlighted])": color.hover,
      ":is([data-popup-open])": color.hover,
    },
  },
  /** A combobox's popup: wider than its trigger, search on top. */
  searchSurface: {
    display: "flex",
    minWidth: geometry.searchPopupMinWidth,
    flexDirection: "column",
  },
  /** A row, not a field: the popup surface is the well here, so the search
   *  sits on it with a divider rather than in a second box. */
  searchRow: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s8,
    borderBottomStyle: "solid",
    borderBottomWidth: geometry.hairline,
    borderBottomColor: color.line,
    paddingInline: space.s12,
    paddingBlock: space.s8,
    minHeight: { default: null, [media.phone]: controlHeight.touch },
  },
  searchIcon: { flexShrink: 0, color: color.faint },
  searchInput: {
    minWidth: 0,
    flex: "1",
    borderWidth: 0,
    backgroundColor: color.transparent,
    padding: space.s0,
    fontSize: { default: text.label, [media.phone]: text.inputPhone },
    color: { default: color.fg, "::placeholder": color.faint },
    outline: "none",
  },
  empty: {
    display: { default: null, ":empty": "none" },
    paddingInline: space.s12,
    paddingBlock: space.s10,
    fontSize: text.label,
    color: color.dim,
  },
  /** The app's top interaction layer. Keep it on the portaled positioner
   *  rather than the surface: Base UI creates the stacking box there. */
  layer: { zIndex: layer.floating },
  /** The positioner: the top layer, and no focus outline of its own. */
  positioner: { zIndex: layer.floating, outline: "none" },
  /** A popup with a docked footer: the list flexes, the footer stays. */
  withFooter: {
    display: "flex",
    maxHeight: geometry.popupMaxHeightFooter,
    flexDirection: "column",
  },
  scrollAboveFooter: { minHeight: 0, maxHeight: "none", flex: "1" },
  /** A popup with a docked side panel: the list column, then the panel. */
  withAside: {
    display: "flex",
    maxHeight: geometry.popupMaxHeightFooter,
    flexDirection: "row",
    alignItems: "stretch",
  },
  /** The list column beside an aside: it takes the width the panel leaves. */
  asideList: { minWidth: 0, flex: "1" },
  /** A select's popup: never narrower than its trigger. */
  anchorWidth: { minWidth: geometry.anchorWidth },
  /** Inset to the rows' own edges, so it splits groups without cutting the
   *  popup in two. */
  separator: {
    marginInline: space.s8,
    marginBlock: space.s6,
    height: geometry.hairline,
    backgroundColor: color.line,
  },
  groupLabel: {
    paddingInline: space.s8,
    paddingBottom: space.s4,
    fontSize: text.meta,
    fontWeight: weight.strong,
    letterSpacing: tracking.tight,
    color: color.faint,
  },
  groupLabelSpaced: { paddingTop: space.s6 },
  /** Right-aligned shortcut hint ("⌘ W"). */
  shortcut: {
    flexShrink: 0,
    paddingLeft: space.s16,
    fontSize: text.label,
    color: color.faint,
  },
  /** The tick on a selectable row. It holds its column whether or not the
   *  row is picked, so the popup's width doesn't depend on the selection. */
  check: { flexShrink: 0, color: color.accentInk },
  checkOff: { visibility: "hidden" },
  /** A select row: label left, tick right. */
  selectItem: {
    justifyContent: "space-between",
    gap: space.s12,
  },
  itemLead: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    gap: space.s8,
  },
  itemIcon: {
    display: "flex",
    width: geometry.rowIcon,
    height: geometry.rowIcon,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    color: color.dim,
  },
  truncate: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  tickSlot: {
    display: "flex",
    width: geometry.tick,
    height: geometry.tick,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    color: color.accentInk,
  },
});
