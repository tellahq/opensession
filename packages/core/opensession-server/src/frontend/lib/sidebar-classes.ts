/**
 * Class strings shared by the sidebar's row families, kept out of the
 * components so Sidebar, SidebarItem, FeedRows and PrRow can all wear the same
 * geometry without one of them drifting.
 *
 * Everything here is written out in full on purpose. Tailwind scans source
 * TEXT, so a class assembled at runtime — `` `sidebar-status-${tone}` `` and
 * its Tailwind equivalent alike — compiles to nothing at all. A lookup of
 * complete literals is the only shape that survives.
 *
 * ── The two signals (desktop) ───────────────────────────────────────────────
 * Two properties carry the whole rail, and they are INDEPENDENT. Read them as
 * separate questions, and do not bundle them into one "kind" again.
 *
 * HEIGHT says how prominent a line is. There are exactly three, and the middle
 * one has a single tenant:
 *
 *   36px  a FULL LINE. Session/PR/support/archived rows, and the headings
 *         that title a set of rows and lead with a mark: a repo or feed band,
 *         an automation group, Archived. See the `item` heading.
 *   32px  the tool rows, and only them. They lead with the same 22px glyph on
 *         the same rail as a full line, so the column reads unbroken, but the
 *         strip is a short list of places above the work rather than part of
 *         it, and four full lines of it opened the sidebar with more chrome
 *         than content. Nothing else takes this height: it is a tighter
 *         version of the full line, not a third kind of row.
 *   28px  a CAPTION, leading with no mark at all. Band headings (Tools /
 *         Workspaces / Automations / People), the status lanes (Needs action /
 *         Recent / Yesterday / Urgent), and the top-level groupings that read
 *         as lanes over the whole list: Needs review, Approved, Awaiting
 *         review, Pinned.
 *         See the `lane` heading and {@link SIDEBAR_BAND_TOGGLE}.
 *
 * The HOVER FILL says whether clicking takes you somewhere. Only a line that
 * NAVIGATES paints one ({@link SIDEBAR_HOVER_LAYER}): the rows, the tool rows,
 * and Archived. Everything that merely collapses a group takes none, whatever
 * its height — a repo band, a feed band, an automation group, every caption.
 * They still show the ink brightening on hover, which is what says a heading
 * is a control at all; a full-width pill says something stronger and untrue,
 * and a rail where most lines offer one teaches that the pill means nothing.
 *
 * Neither question is answered by where a heading sits. Needs review and
 * Pinned are top-level and used to lead with a coloured 22px glyph on the full
 * line height, which made the headings that go nowhere the loudest things in
 * the rail; they name a group exactly the way Yesterday does, so they are
 * captions. A repo band does title real rows, so it keeps the full line, but
 * it is still only a toggle, so it lost its pill.
 *
 * Before this the same rail ran 44 / 40 / 32 / 30 / 28 down one column — five
 * heights for four kinds of thing, with the tallest box (a band caption at 44)
 * on the QUIETEST content and tool rows 12px shorter than the session rows
 * directly under them. Hierarchy now comes from type, mark and the hover pill,
 * which are the things that actually differ; height is free to be regular.
 *
 * Phone layouts are deliberately NOT on this scale — a 36px row is not a touch
 * target, so `phone:` keeps its own taller padding throughout.
 *
 * The tier-1 sticky SLOT is a third number, 32, and it is not a third row
 * height: it is the 28px band caption plus its air, which is what everything
 * below pins under. Two offsets are sums of these, so change a height here and
 * fix them in the same edit: a lane pins under one band at 32, and a lane
 * nested under a band plus a repo band at 32 + 36 = 68.
 *
 * Every one of those numbers is a custom property now, set once by
 * {@link SIDEBAR_DENSITY_VARS} — which is what lets "Compact sidebar" retune
 * the whole scale from one element, and what keeps the two sums above correct
 * without anyone re-deriving them.
 */

import * as stylex from "@stylexjs/stylex";
import { cn } from "../ui/cn";
import {
  sidebarBandMarker,
  sidebarHeaderMarker,
  sidebarRowMarker,
  sidebarWorkspacesHeadMarker,
} from "../ui/markers.stylex";
import { classString as sx, type Styles } from "../ui/sx";
import {
  color,
  corner,
  leading,
  media,
  motion,
  radius,
  shadow,
  sidebarScale as scale,
  space,
  text,
  weight,
} from "../ui/tokens.stylex";

/** A row's right padding: at rest, at rest on a phone, and under a pointer. */
const rowRight = (rest: string, restPhone: string, hover: string) => ({
  default: rest,
  [media.phone]: restPhone,
  ":hover": { default: null, [media.hover]: hover },
});

/**
 * The pieces of the rail that are StyleX. The constants below that read
 * `stylex.props(...)` are these styles as class strings, for call sites that
 * still compose strings; the rest are Tailwind until their families move.
 */
export const sidebarStyles = stylex.create({
  // See SIDEBAR_DENSITY_VARS. Compact is desktop-only and keyed on the same
  // element's `data-density`.
  density: {
    "--sidebar-row-pad": {
      default: scale.rowPad,
      [media.desktop]: {
        default: null,
        ":is([data-density=compact])": scale.rowPadCompact,
      },
    },
    "--sidebar-tool-pad": {
      default: scale.toolPad,
      [media.desktop]: {
        default: null,
        ":is([data-density=compact])": scale.toolPadCompact,
      },
    },
    "--sidebar-line-h": {
      default: scale.lineHeight,
      [media.desktop]: {
        default: null,
        ":is([data-density=compact])": scale.lineHeightCompact,
      },
    },
    "--sidebar-cap-h": {
      default: scale.caption,
      [media.desktop]: {
        default: null,
        ":is([data-density=compact])": scale.captionCompact,
      },
    },
    "--sidebar-band-slot": {
      default: scale.bandSlot,
      [media.desktop]: {
        default: null,
        ":is([data-density=compact])": scale.bandSlotCompact,
      },
    },
    "--sidebar-group-gap": {
      default: scale.groupGap,
      [media.desktop]: {
        default: null,
        ":is([data-density=compact])": scale.groupGapCompact,
      },
    },
    "--sidebar-row-action": {
      default: scale.rowAction,
      [media.desktop]: {
        default: null,
        ":is([data-density=compact])": scale.rowActionCompact,
      },
    },
  },
  rail: {
    position: "relative",
    display: "flex",
    width: scale.rail,
    height: scale.rail,
    flex: `0 0 ${scale.rail}`,
    alignItems: "center",
    justifyContent: "center",
  },
  railGap: { gap: scale.railGap },
  // A layer, not a colour: see SIDEBAR_HOVER_LAYER.
  hoverLayer: {
    backgroundImage: {
      default: null,
      ":hover": {
        default: null,
        [media.hover]: `linear-gradient(${color.hover}, ${color.hover})`,
      },
    },
  },
  group: { marginBottom: scale.groupGapVar },
  navX: {
    "--sidebar-nav-x": {
      default: scale.navX,
      [media.desktop]: scale.navXDesktop,
    },
  },
  list: {
    flex: "none",
    overflowY: "visible",
    paddingInline: { default: space.s12, [media.desktop]: scale.navXVar },
    paddingTop: scale.listTop,
    paddingBottom: space.s0,
  },
  independentSection: {
    display: "block",
    minWidth: 0,
    flex: "none",
    marginInline: { default: space.s12, [media.desktop]: scale.navXVar },
  },
  independentScroll: {
    minWidth: 0,
    overflowY: "visible",
    paddingBottom: space.s6,
  },
  // A lid, not a wash: see SIDEBAR_ROW_CHIP.
  rowChip: {
    backgroundColor: {
      default: null,
      ":hover": { default: null, [media.hover]: color.rowChip },
    },
  },

  // ── Headings: see sidebarHeader ──
  header: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: scale.railGap,
    borderRadius: scale.headerRadius,
    ["cornerShape"]: corner.squircle,
    borderStyle: "none",
    backgroundColor: color.transparent,
    fontWeight: weight.medium,
    letterSpacing: 0,
    color: {
      default: color.dim,
      ":hover": { default: null, [media.hover]: color.fg },
    },
    paddingTop: { default: scale.headerPadPhone, [media.desktop]: space.s4 },
    paddingRight: { default: space.s4, [media.desktop]: space.s6 },
    paddingBottom: { default: scale.headerPadPhone, [media.desktop]: space.s4 },
    paddingLeft: { default: space.s4, [media.desktop]: scale.railPadVar },
  },
  headerItem: {
    fontSize: { default: text.body, [media.desktop]: text.itemTitle },
    height: { default: null, [media.desktop]: scale.lineHeightVar },
    minHeight: { default: null, [media.desktop]: scale.lineHeightVar },
  },
  headerLane: {
    gap: scale.laneGap,
    paddingTop: { default: scale.lanePadTopPhone, [media.desktop]: space.s4 },
    paddingBottom: {
      default: scale.lanePadBottomPhone,
      [media.desktop]: space.s4,
    },
    fontSize: text.label,
    fontWeight: weight.heading,
    height: { default: null, [media.desktop]: scale.captionVar },
    minHeight: { default: null, [media.desktop]: scale.captionVar },
  },
  headerSelected: { backgroundColor: color.selected, color: color.fg },
  headerInert: { cursor: "default", color: color.dim },
  stickyLane: {
    position: { default: null, [media.desktop]: "sticky" },
    top: { default: null, [media.desktop]: scale.bandSlotVar },
    zIndex: { default: null, [media.desktop]: scale.laneLayer },
  },
  stickyLaneNested: {
    top: {
      default: null,
      [media.desktop]: `calc(${scale.bandSlotVar} + ${scale.lineHeightVar})`,
    },
    zIndex: { default: null, [media.desktop]: scale.nestedLaneLayer },
  },
  groupName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "left",
  },
  laneName: { paddingLeft: { default: space.s2, [media.desktop]: space.s0 } },
  count: { fontWeight: weight.medium, color: color.faint },
  dot: {
    width: scale.dot,
    height: scale.dot,
    flexShrink: 0,
    borderRadius: radius.pill,
    opacity: scale.dotOpacity,
  },
  chevron: {
    flexShrink: 0,
    color: {
      default: color.faint,
      [stylex.when.ancestor(":hover", sidebarHeaderMarker)]: {
        default: null,
        [media.hover]: color.fg,
      },
    },
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover", sidebarHeaderMarker)]: {
        default: null,
        [media.hover]: 1,
      },
    },
    transitionProperty: "transform, opacity",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
  },
  chevronCollapsed: { opacity: 1 },

  // ── Rows: see sidebarRow ──
  row: {
    position: "relative",
    marginTop: space.s2,
    width: "100%",
    borderRadius: radius.control,
    ["cornerShape"]: corner.squircle,
    borderWidth: 0,
    backgroundColor: color.transparent,
    paddingBlock: {
      default: scale.rowPadVar,
      [media.phone]: scale.rowPadPhone,
    },
    paddingLeft: {
      default: scale.railPadVar,
      [media.phone]: scale.rowInsetPhone,
    },
    textAlign: "left",
    color: color.fg,
  },
  rowRail: { display: "flex", alignItems: "center", gap: scale.railGap },
  rowBlock: { display: "block" },
  rowSwipe: { zIndex: 1, marginTop: space.s0, touchAction: "pan-y" },
  rowSelected: { backgroundColor: color.selected },
  reserve1: { paddingRight: rowRight(space.s8, space.s8, scale.reserve1) },
  reserve2: { paddingRight: rowRight(space.s8, space.s8, scale.reserve2) },
  reserve3: { paddingRight: rowRight(space.s8, space.s8, scale.reserve3) },
  reserve4: { paddingRight: rowRight(space.s8, space.s8, scale.reserve4) },
  standing1: {
    paddingRight: rowRight(
      scale.reserve1,
      scale.reserveStandingPhone,
      scale.reserve1,
    ),
  },
  standing2: {
    paddingRight: rowRight(
      scale.reserve1,
      scale.reserveStandingPhone,
      scale.reserve2,
    ),
  },
  title: {
    minWidth: 0,
    flex: "1 1 0%",
    overflow: "hidden",
    whiteSpace: "nowrap",
    WebkitMaskImage: `linear-gradient(to right, ${color.mask} ${scale.titleFade}, transparent)`,
    maskImage: `linear-gradient(to right, ${color.mask} ${scale.titleFade}, transparent)`,
    fontSize: { default: text.body, [media.desktop]: text.itemTitle },
    lineHeight: scale.titleLeading,
    fontWeight: {
      default: weight.medium,
      [stylex.when.ancestor(":is([data-waiting])", sidebarRowMarker)]:
        weight.heading,
      [stylex.when.ancestor(":is([data-finished-unread])", sidebarRowMarker)]:
        weight.heading,
    },
    color: {
      default: color.dim,
      [stylex.when.ancestor(":is([data-selected])", sidebarRowMarker)]:
        color.fg,
      [stylex.when.ancestor(":is([data-unread])", sidebarRowMarker)]: color.fg,
    },
  },
  // A session row's positioned chip (pin, archive, keep).
  chip: {
    position: "absolute",
    top: "50%",
    translate: "0 -50%",
    display: {
      default: "none",
      [stylex.when.ancestor(":hover", sidebarRowMarker)]: {
        default: null,
        [media.hover]: "flex",
      },
    },
    width: scale.rowActionVar,
    height: scale.rowActionVar,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    ["cornerShape"]: corner.squircle,
    fontSize: scale.chipGlyph,
    lineHeight: leading.none,
    color: {
      default: color.faint,
      ":hover": { default: null, [media.hover]: color.fg },
    },
  },
  chipEdge: { right: scale.chipEdge },
  chipSecond: { right: scale.chipSecond },
  chipOn: { backgroundColor: color.pressed, color: color.fg },
  chipStanding: {
    display: "flex",
    right: { default: scale.chipEdge, [media.phone]: space.s0 },
    width: { default: scale.rowActionVar, [media.phone]: scale.touchTarget },
    height: { default: scale.rowActionVar, [media.phone]: scale.touchTarget },
  },
  // A rail row's chip cluster, and one chip in it.
  rowActions: {
    position: "absolute",
    top: "50%",
    right: scale.chipEdge,
    translate: "0 -50%",
    display: {
      default: "none",
      [stylex.when.ancestor(":hover", sidebarRowMarker)]: {
        default: null,
        [media.hover]: "inline-flex",
      },
    },
    alignItems: "center",
    gap: space.s4,
    borderRadius: radius.sm,
    ["cornerShape"]: corner.squircle,
  },
  rowActionsHidden: { display: "none" },
  rowAction: {
    display: "inline-flex",
    width: scale.rowActionVar,
    height: scale.rowActionVar,
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    ["cornerShape"]: corner.squircle,
  },
  time: {
    marginLeft: "auto",
    minWidth: { default: scale.timeMin, [media.desktop]: scale.timeMinDesktop },
    flex: "0 0 auto",
    justifyContent: "flex-end",
    paddingRight: { default: space.s6, [media.desktop]: space.s4 },
    textAlign: "right",
    fontSize: text.meta,
    fontWeight: weight.regular,
    color: color.faint,
  },
  timeReveal: {
    display: {
      default: "none",
      [stylex.when.ancestor(":hover", sidebarRowMarker)]: {
        default: null,
        [media.hover]: "inline-flex",
      },
    },
  },
  timeRevealTouch: {
    display: {
      default: "none",
      [stylex.when.ancestor(":hover", sidebarRowMarker)]: {
        default: null,
        [media.hover]: "inline-flex",
      },
      [media.touch]: "inline-flex",
    },
  },
  timeHidden: { display: "none" },
  ticker: {
    marginLeft: "auto",
    minWidth: { default: scale.timeMin, [media.desktop]: scale.timeMinDesktop },
    flex: "0 0 auto",
    justifyContent: "flex-end",
    paddingRight: { default: space.s2, [media.desktop]: space.s4 },
    textAlign: "right",
    fontSize: text.meta,
    fontWeight: weight.regular,
    fontVariantNumeric: "tabular-nums",
    color: color.yellow,
    display: {
      default: null,
      [stylex.when.ancestor(":hover", sidebarRowMarker)]: {
        default: null,
        [media.hover]: "none",
      },
    },
  },
  snooze: {
    marginLeft: "auto",
    display: {
      default: "inline-flex",
      [stylex.when.ancestor(":hover", sidebarRowMarker)]: {
        default: null,
        [media.hover]: "none",
      },
    },
    flex: "0 0 auto",
    alignItems: "center",
    gap: space.s4,
    fontSize: text.meta,
    fontWeight: weight.regular,
    fontVariantNumeric: "tabular-nums",
    color: color.faint,
  },
  draft: {
    display: "inline-flex",
    flex: "0 0 auto",
    alignItems: "center",
    color: color.dim,
  },
  // The facepile's avatars ring themselves in the row's own fill, so it
  // follows the row's hover and selection.
  faces: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    "--sidebar-face-ring": {
      default: scale.faceRing,
      [stylex.when.ancestor(":not([data-selected]):hover", sidebarRowMarker)]: {
        default: null,
        [media.hover]: scale.faceRingHover,
      },
      [stylex.when.ancestor(":is([data-selected])", sidebarRowMarker)]:
        scale.faceRingSelected,
      [stylex.when.ancestor(":is([data-selected]):hover", sidebarRowMarker)]: {
        default: null,
        [media.hover]: scale.faceRingSelectedHover,
      },
    },
  },
  face: {
    marginLeft: { default: null, ":not(:first-child)": scale.faceOverlap },
  },

  // ── Swipe rows: the phone swipe shell and the actions behind it ──
  // The shell carries the 2px gap between rows, so the row inside it adds
  // none; its corner clips the revealed actions to the row's own.
  swipeRow: {
    position: "relative",
    marginTop: space.s2,
    overflow: "hidden",
    borderRadius: radius.control,
    ["cornerShape"]: corner.squircle,
  },
  swipeAction: {
    position: "absolute",
    top: space.s0,
    bottom: space.s0,
    zIndex: 0,
    display: "none",
    width: scale.swipeActionWidth,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s2,
    borderStyle: "none",
    fontSize: text.meta,
    fontWeight: weight.heading,
    willChange: "width",
  },
  swipeOpen: { display: { default: "none", [media.touch]: "flex" } },
  swipeEase: {
    transitionProperty: "width",
    transitionDuration: motion.standard,
    transitionTimingFunction: motion.ease,
  },
  swipeArchive: {
    right: space.s0,
    backgroundColor: color.red,
    color: color.onRed,
  },
  swipeStar: {
    left: space.s0,
    backgroundColor: color.yellow,
    color: color.onYellow,
  },
  swipeStarOn: {
    left: space.s0,
    backgroundColor: color.accent,
    color: color.onAccent,
  },
  swipeUnsnooze: {
    left: space.s0,
    backgroundColor: color.accent,
    color: color.onAccent,
  },

  // ── Lanes and pinned entries ──
  laneEmpty: { opacity: scale.laneEmpty },
  laneDropHover: {
    borderRadius: radius.control,
    ["cornerShape"]: corner.squircle,
    backgroundColor: color.pressed,
    opacity: 1,
    boxShadow: shadow.dropRing,
  },
  pinEntry: { position: "relative" },
  pinEntryDragging: {
    zIndex: scale.dragLayer,
    borderRadius: radius.control,
    ["cornerShape"]: corner.squircle,
    backgroundColor: color.page,
    boxShadow: shadow.ringSm,
  },
  attnCount: {
    minWidth: space.s16,
    flex: "0 0 auto",
    borderRadius: radius.pill,
    paddingInline: space.s4,
    textAlign: "center",
    fontSize: scale.attnText,
    lineHeight: scale.attnLeading,
    fontWeight: weight.heading,
    color: color.onRed,
  },
  attnBlue: { backgroundColor: color.blue },
  attnRed: { backgroundColor: color.red },
  automationRuns: { "--sidebar-icon-left": scale.nestedIconLeft },

  // ── Bands: see sidebarBandHeading ──
  bandHeading: {
    fontSize: text.label,
    fontWeight: weight.heading,
    color: color.dim,
    paddingBlock: space.s0,
    paddingLeft: space.s0,
    paddingRight: { default: space.s8, [media.desktop]: space.s0 },
  },
  stickyBand: {
    position: { default: null, [media.desktop]: "sticky" },
    top: { default: null, [media.desktop]: space.s0 },
    zIndex: { default: null, [media.desktop]: scale.bandLayer },
    display: { default: null, [media.desktop]: "flex" },
    height: { default: null, [media.desktop]: scale.bandSlotVar },
    minHeight: { default: null, [media.desktop]: scale.bandSlotVar },
    alignItems: { default: null, [media.desktop]: "center" },
    marginTop: { default: null, [media.desktop]: space.s0 },
  },
  bandToggle: {
    margin: space.s0,
    display: "flex",
    minHeight: scale.captionVar,
    width: "100%",
    cursor: "pointer",
    alignItems: "center",
    gap: scale.laneGap,
    borderRadius: scale.bandRadius,
    ["cornerShape"]: corner.squircle,
    // `none`, not a zero width: that is what the `border: none` this
    // replaced computed to.
    borderStyle: "none",
    backgroundColor: color.transparent,
    paddingBlock: space.s4,
    paddingRight: { default: space.s4, [media.desktop]: space.s8 },
    paddingLeft: { default: space.s8, [media.desktop]: scale.railPadVar },
    textAlign: "left",
    fontFamily: "inherit",
    fontSize: "inherit",
    fontStyle: "inherit",
    fontWeight: "inherit",
    lineHeight: "inherit",
    color: {
      default: "inherit",
      ":hover": { default: null, [media.hover]: color.fg },
    },
  },
  bandChevron: {
    flexShrink: 0,
    visibility: {
      default: "hidden",
      [stylex.when.ancestor(":hover", sidebarBandMarker)]: {
        default: null,
        [media.hover]: "visible",
      },
    },
    color: color.faint,
  },
  bandChevronBrighten: {
    color: {
      default: color.faint,
      [stylex.when.ancestor(":hover", sidebarBandMarker)]: {
        default: null,
        [media.hover]: color.dim,
      },
    },
  },
  bandChevronCollapsed: { visibility: "visible" },
  workspacesBand: {
    paddingTop: space.s0,
    paddingBottom: { default: space.s2, [media.desktop]: space.s0 },
    paddingLeft: space.s16,
    paddingRight: scale.chipEdge,
  },
  workspacesBandBorrowed: {
    paddingTop: { default: space.s16, [media.desktop]: space.s0 },
    paddingInline: space.s8,
  },
  placeTitle: {
    fontSize: text.dialogTitle,
    fontWeight: weight.heading,
    color: color.fg,
  },
  placeTitleGap: { marginBottom: space.s8 },
  workspacesTitle: {
    flexShrink: 0,
    fontSize: text.label,
    fontWeight: weight.heading,
    color: {
      default: color.dim,
      [stylex.when.ancestor(":hover", sidebarWorkspacesHeadMarker)]: {
        default: null,
        [media.hover]: color.fg,
      },
    },
  },
  workspacesTitlePlace: {
    fontSize: text.dialogTitle,
    color: color.fg,
  },
  hidden: { display: "none" },

  // ── Chrome and header buttons ──
  chromeButton: {
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
    ["cornerShape"]: corner.squircle,
    color: {
      default: color.faint,
      ":hover": { default: null, [media.hover]: color.fg },
    },
    backgroundColor: {
      default: null,
      ":hover": { default: null, [media.hover]: color.hover },
    },
    transitionProperty: "color, background",
    transitionDuration: motion.micro,
    transitionTimingFunction: motion.ease,
  },
  headerButton: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
    ["cornerShape"]: corner.squircle,
    width: scale.headerButton,
    height: scale.headerButton,
    fontSize: scale.headerGlyph,
    fontWeight: weight.medium,
    lineHeight: leading.none,
    color: {
      default: color.dim,
      ":hover": { default: null, [media.hover]: color.fg },
    },
  },
  headerButtonPhone: {
    width: scale.headerButtonPhone,
    height: scale.headerButtonPhone,
    fontSize: scale.headerGlyphPhone,
  },
  headerButtonWash: {
    backgroundColor: {
      default: null,
      ":hover": { default: null, [media.hover]: color.hover },
    },
  },
  headerButtonOpen: {
    borderColor: color.lineStrong,
    backgroundColor: color.pressed,
    color: color.fg,
  },
  bandAction: {
    marginLeft: "auto",
    display: "inline-flex",
    width: scale.bandAction,
    height: scale.bandAction,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
    ["cornerShape"]: corner.squircle,
    backgroundColor: {
      default: null,
      ":hover": { default: null, [media.hover]: color.hover },
    },
    color: {
      default: color.dim,
      ":hover": { default: null, [media.hover]: color.fg },
    },
  },
  bandActionActive: {
    position: "relative",
    color: {
      default: color.accent,
      ":hover": { default: null, [media.hover]: color.fg },
    },
    "::after": {
      content: "''",
      position: "absolute",
      top: scale.filterDotInset,
      right: scale.filterDotInset,
      width: scale.filterDot,
      height: scale.filterDot,
      borderRadius: radius.pill,
      backgroundColor: color.accent,
    },
  },
  autoCog: {
    position: "relative",
    marginBlock: scale.cogBleed,
    marginLeft: "auto",
    display: {
      default: "none",
      [stylex.when.ancestor(":hover", sidebarHeaderMarker)]: {
        default: null,
        [media.hover]: "inline-flex",
      },
    },
    width: scale.cogWidth,
    flexShrink: 0,
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "stretch",
    color: {
      default: color.dim,
      ":hover": { default: null, [media.hover]: color.fg },
    },
  },
});

/**
 * The rail's vertical scale, as one set of custom properties on the sidebar's
 * scroll root. The default column is the scale described above; the compact
 * column is the same rail with the air taken out of it, which is the whole of
 * what the "Compact sidebar" preference does.
 *
 *              default   compact
 *   full line     36px      30px   rows, and the headings that title rows
 *   tool row      32px      30px   the tool strip
 *   caption       28px      24px   band headings and status lanes
 *   band slot     32px      28px   the tier-1 sticky slot
 *   group gap     14px       8px   the air after a top-level group
 *   row action    26px      24px   the pin/archive chip inside a row
 *
 * The 22px leading rail does NOT move. Its marks are 18px (a repo tile, a
 * status mark), so a narrower slot would leave them 1px of margin, and the
 * shared left edge every title sits on is the one thing a density change must
 * not touch — a compact list that also re-rags the titles reads as a different
 * sidebar rather than a tighter one. 30px around a 22px rail is 4px of margin,
 * the tool row's own margin today.
 *
 * The row action is the one box that HAS to follow the line height, because it
 * is painted inside it: it is a hover wash sitting on the row's own hover pill,
 * so anything at or above the line height reads as a second row rather than a
 * button on one. It stays 5px inside a full line and 3px inside a compact one.
 *
 * Two rules ride on this. Compact is gated on `desktop:`, because a phone row
 * is a tap target and its `phone:` padding is deliberately off this scale.
 * And the compact values sit on the SAME element as `data-density`, so they
 * out-rank the defaults on specificity rather than on stylesheet order.
 */
export const SIDEBAR_DENSITY_VARS = sx(sidebarStyles.density);

/**
 * The rail's HORIZONTAL scale, the counterpart to the vertical one above, on
 * the same element.
 *
 * `--sidebar-nav-x` is the air between the column's own edges and the boxes
 * inside it: the hover/selected pill, the tool rows, the band sections. It is
 * not the text's inset — that is `--sidebar-icon-left` (16px, set on the
 * sidebar container), the rail every leading mark and every title after it
 * lines up on, at both densities and in every family.
 *
 * The two were previously one hand-summed pair per family (list 6 + row 10,
 * list 6 + heading 10, section 6 + band 10, and the tool row's calc), so the
 * outer air could not be changed without re-deriving four inner values and
 * getting the shared rail wrong in whichever one was missed. Only the tool row
 * ever expressed it as the subtraction it is; now they all do, through
 * `sidebarScale.railPadVar`, and the air is one number.
 *
 * 10px, not the 6 it was. At 6 the pill sat all but against both edges of the
 * column — a window edge on one side, the seam with the reading pane on the
 * other — and a truncating title faded out 14px short of that seam, which read
 * as the sidebar running out of room rather than as a margin.
 */
export const SIDEBAR_NAV_X = sx(sidebarStyles.navX);

/* The left padding a box inside that inset takes to put its leading mark back
   on the shared rail is `sidebarScale.railPadVar`, which rows and headings
   read. Its fallbacks are today's numbers, so a row rendered outside the
   sidebar's own root still lands where it always did. */
/**
 * The sidebar's leading column. Every row and group header opens with one of
 * these, whatever it holds — a 22px glyph, a 20px one, a 7px status dot, a
 * repo tile — so the marks share a centre line AND the text after them shares
 * a left rail. Before this the slot was whatever its content measured
 * (7 / 17 / 20 / 22), which fanned the titles out across seven different left
 * edges in the same list. Wrap shared marks at the call site rather than
 * resizing them: the group dot and RepoTile are also dropdown option icons,
 * where a 22px box would be wrong.
 */
export const SIDEBAR_RAIL = sx(sidebarStyles.rail);

/**
 * The air between that rail and the title after it — one value, shared by
 * every family that opens with a rail (session rows, workspace rows, group
 * headings, the tool strip). It has to be shared: the left edge the titles
 * sit on is rail width plus this gap, so a family that sets its own number
 * rags its list against the others.
 *
 * 7px, not 9. The rail is sized for an 18px mark, so a 7px status dot already
 * carries 7px of its own margin inside the slot, and at 9 the gap read as a
 * hole in front of the dot rows while the icon rows next to them looked
 * closed up. Tightening the shared gap keeps that difference where it belongs
 * (inside the rail, centred) instead of adding to it.
 */
export const SIDEBAR_RAIL_GAP = sx(sidebarStyles.railGap);

/**
 * ── Containers ──────────────────────────────────────────────────────────────
 * The boxes the row families sit in. Written phone-first with a `desktop:`
 * desktop override, which is the exact complement of the `max-width: 720px`
 * these rules came from — `phone:` compiles to `< 720` and would leave a
 * viewport exactly 720px wide wearing neither value.
 */

/**
 * The workspace list. Horizontal padding is tight on desktop so the
 * active/hover pill sits close to the sidebar edges (it "overflows" past the
 * content inset, Conductor-style) and row content lands on the shared columns:
 * leading icons under the group-header icons, trailing times/numbers
 * flush-right under the header's filter/＋ buttons. On phones the surfaces
 * breathe past their content rail instead, while the content stays aligned
 * with the tool cards' 16px edge (12px outer + 4px inner below).
 *
 * `data-sidebar-list` rides alongside it: the ArrowUp/ArrowDown row navigation
 * queries this box for its candidate rows, and an attribute says "hook" where a
 * class name would read as styling.
 */
export const SIDEBAR_LIST = sx(sidebarStyles.list);

/**
 * Bands that are siblings of the workspace list (Automations, People) but
 * participate in the sidebar's single scroll flow rather than creating nested
 * scroll panes.
 */
export const SIDEBAR_INDEPENDENT_SECTION = sx(sidebarStyles.independentSection);

/** The scroll flow inside one of those bands — visible, not a nested pane. */
export const SIDEBAR_INDEPENDENT_SCROLL = sx(sidebarStyles.independentScroll);

/**
 * A hover painted as a background LAYER rather than a background colour — the
 * sidebar's hover, for anything that also carries a state fill of its own.
 *
 * Every state in here is translucent ink: selected is `bg-selected`, a pinned
 * action is `bg-pressed` ("needs you" carries no fill at all — it is a mark in
 * the rail and a bold title, so it composites with any of these). That
 * is what lets each of them pick up the sidebar material (and, on the desktop
 * shell, the wallpaper) underneath instead of cutting an opaque patch out of
 * it — but it also means a colour-based hover REPLACES that fill instead of
 * adding to it. Pointing at a selected row would then swap 0.065 of ink for
 * 0.055 and the row would go QUIETER under the pointer, which reads as
 * deselecting; on an element whose two states are the same token (a pinned
 * pin) it does nothing at all. Both were worked around by withholding the
 * hover while the other state was on — see the filter button — which just
 * moves the missing feedback somewhere else.
 *
 * As a layer the hover composites over whatever the element already carries,
 * which is what a hover is, so one class covers every state including none.
 *
 * The one thing this is NOT for is an action chip floating over a row — see
 * {@link SIDEBAR_ROW_CHIP}.
 */
export const SIDEBAR_HOVER_LAYER = sx(sidebarStyles.hoverLayer);

/**
 * The pin/archive chip's hover — the deliberate exception to the wash.
 *
 * These float ON a row that is itself already hovered, and they are lids
 * rather than tints: a translucent one shows the row's wash, and anything the
 * row still has under that spot, through the glyph. So it takes `--row-chip`,
 * which is the hover wash pre-composited onto whatever surface the sidebar is
 * painted with (see base.css) — the background bleeds into its COLOUR instead
 * of through its alpha, and it is never more see-through than the sidebar it
 * sits on.
 */
export const SIDEBAR_ROW_CHIP = sx(sidebarStyles.rowChip);

/** A top-level group in the workspace list, and the gap after it. */
export const SIDEBAR_GROUP = sx(sidebarStyles.group);

/**
 * A status lane. Consecutive lanes open with 8px of their own, which was an
 * adjacent-sibling rule and stays one: `data-status-group` is what the variant
 * matches, because the margin depends on what precedes the element and no
 * amount of `:not(:first-child)` says the same thing when other kinds of
 * sibling can sit between two lanes.
 */
export const SIDEBAR_STATUS_GROUP = "[[data-status-group]+&]:mt-2";

/**
 * A lane acting as a drop target while a Pinned row is mid-drag: the one under
 * the pointer wears a pill + accent ring, and lanes that only materialized for
 * the drag (they were empty) sit dimmed.
 */
export interface SidebarLaneOptions {
  /** Materialized only for the drag: dimmed. */
  empty?: boolean;
  /** The lane under the pointer: a pill with an accent ring. */
  dropHover?: boolean;
}

/** A status lane, as a drop target or not. One StyleX call, so the drop
 *  target's full opacity beats the empty lane's dim. */
export function sidebarLane(options: SidebarLaneOptions = {}): string {
  return cn(
    SIDEBAR_STATUS_GROUP,
    sx(
      options.empty === true && sidebarStyles.laneEmpty,
      options.dropHover === true && sidebarStyles.laneDropHover,
    ),
  );
}

/* The drag-to-reorder wrapper around each Pinned row (Motion Reorder.Item). */
export interface SidebarPinEntryOptions {
  /** Some drag is in flight. */
  dragActive: boolean;
  /** This entry is the one being dragged. */
  dragging: boolean;
}

/**
 * While a row is being dragged it floats over its neighbours, so it needs a
 * solid background (rows are transparent over the app bg) and to win the
 * stacking order; the radius matches the row's own so the backdrop doesn't poke
 * out. Muting the content's pointer events is the other half of the same state and used
 * to key off the LIST (`.sidebar-pin-list.is-drag-active`): rows sliding under
 * the pointer would otherwise fire mouseenter and pop their hover preview
 * cards, so the row content is muted and only the drag gesture sees the
 * pointer. Every entry wears it while any drag is in flight, which is what the
 * list-level selector did — so the list needs no class of its own.
 */
export function sidebarPinEntry(options: SidebarPinEntryOptions): string {
  return cn(
    // A child reach: the entry's content, not the entry.
    options.dragActive && "[&>*]:pointer-events-none",
    sx(
      sidebarStyles.pinEntry,
      options.dragging && sidebarStyles.pinEntryDragging,
    ),
  );
}

/**
 * The RepoTile a repo/feed band header leads with. It rides centred in the 22px
 * leading slot rather than filling it: the tile is a SOLID block of colour
 * where every other mark on that column is a stroke glyph or a small dot, so at
 * the slot's full size it outweighed them all and the band read as shouting.
 * 18px is the same box the session rows' own marks (WsStatusMark) wear one row
 * below, so the tile now sits in a column of equal-sized marks — the 2px it
 * gives up against the 22px Pinned/Needs-review glyphs costs less than the
 * weight did, and the band's label still starts on the shared text rail either
 * way (the rail sets that, not the tile).
 *
 * Passed as RepoTile's `className`, NOT as its `size`: `size` also recomputes
 * the tile's radius (round(18 * 0.28) = 5px) as inline style, where the band
 * header's tile keeps the `.repo-tile` base radius of 4px. The type size is
 * arbitrary rather than `text-xs` because it is the tile's geometry — it tracks
 * the 18px box, not the sidebar's type scale.
 */
export const SIDEBAR_REPO_TILE = "size-[18px] shrink-0 text-meta";

/**
 * ── Group headers ───────────────────────────────────────────────────────────
 * The collapsible headings INSIDE the workspace list: Needs review, Pinned,
 * Archived, the repo bands, the automation groups. sidebarHeaderMarker is
 * what the chevron and the automation cog key their reveal off, so it rides
 * on every one of them.
 *
 * Padding is deliberately not here — the Archived heading wears its own,
 * and two utilities from the same group in one string would leave the winner
 * to Tailwind's internal ordering rather than to the call site.
 *
 * Neither is the hover FILL, nor a height: those are what separate the two
 * families that share this base. An item heading adds
 * the `item` heading; a caption adds the `lane` heading and
 * takes neither. The ink brightening on hover stays on both — it is what says
 * a caption is still a toggle once the pill is gone.
 */
/* Desktop sits one step under the transcript, phone keeps the body step.
   Beside the work the sidebar is a denser column than the reading one, and the
   pixel between them is what says so; taken all the way down to the label step
   it stopped reading as the same app as the transcript. On a phone the sidebar
   IS the page, so its rows are the thing being read and stay at body. */
const HEADER = sidebarStyles.header;

/**
 * A FULL-LINE heading — a repo or feed band, an automation group, Archived.
 * Each leads with a mark in the rail and titles the rows under it, so it wears
 * the row's 36px box and sits in one regular column with them rather than as a
 * third size between them and the captions.
 *
 * The height and the row size. The hover fill is NOT here, because it answers a different
 * question — see the height scale at the top of this file: a repo band is a
 * full line but it is a collapse toggle, so it takes no fill, while Archived
 * looks identical and navigates, so it adds {@link SIDEBAR_HOVER_LAYER} at its
 * call site. Bundling the two here is what put a pill on three headings that
 * go nowhere.
 *
 * Desktop only. On phones the heading keeps the taller tap box its own inset
 * gives it.
 */
const HEADER_ITEM = sidebarStyles.headerItem;

/** Left pad puts the icon on the shared rail, whatever the list's inset is. */
// Folded into HEADER: the left pad puts the mark on the shared rail, whatever
// the list's inset is.

/**
 * Status lanes, inbox bands and Snoozed — the groups nested inside a list or a
 * project band. They label the rows rather than lead anywhere, so they read as
 * captions: a size down from the rows, semibold to hold their own at that size,
 * and no leading glyph at all (the rows under them already carry the status
 * marks, and the lane's own name says what it is). Size and weight are what
 * separate a caption from a title, not a third left edge. One size at both
 * widths: a caption a step under the rows it heads still reads as a caption,
 * and at the meta step it fell in with the count beside it instead.
 *
 * It takes the 28px LABEL height and — pointedly — no hover fill, which is the
 * pairing that makes it read as a caption at all. Given the pill it looked
 * like an item, and a list of five lanes then presented five clickable-looking
 * rows that lead nowhere between the rows that do.
 */
const HEADER_LANE = sidebarStyles.headerLane;

/**
 * Under a place title the captions take the rows' own size and weight, set
 * apart by their muted ink alone. Regular weight read too thin beside the
 * medium rows; the Channels sidebar's section headings match this. A
 * sibling reach (the new layout is keyed off a `[data-minibar]` earlier in
 * the body), so it stays a utility.
 */
const LANE_NEW_LAYOUT = "new-layout:text-item-title new-layout:font-medium";

/**
 * The heading's own name. `truncate` before any width utility: it is the pair
 * of overflow rules that makes the ellipsis, and a min-width of 0 is what lets
 * a flex child shrink far enough to need one.
 */
export const SIDEBAR_GROUP_NAME = sx(sidebarStyles.groupName);

/**
 * Phone lane captions keep a slight 2px inset for arm's-length reading.
 * Desktop captions sit directly on the header's content rail, while the hover
 * pill still runs the sidebar's full width.
 */
export const SIDEBAR_LANE_NAME = sx(sidebarStyles.laneName);

/**
 * The collapse chevron. Revealed by the header's hover, and rotated to mark the
 * collapsed state by the call site's inline transform.
 */
const CHEVRON = sidebarStyles.chevron;

/**
 * A collapsed heading keeps its chevron out of hover. Expanded, the rows below
 * already say the group is open, so the affordance can stay quiet; collapsed,
 * nothing on screen distinguishes a group holding fifteen hidden rows from one
 * that simply has none, and the count alone reads as decoration. The chevron is
 * the state, so it is what shows.
 *
 * It shows at the resting `text-faint`, not the hover colour — present, not
 * loud. Muting the label instead would say the opposite of what is true: a
 * collapsed group is hiding work, which is worth more attention, not less.
 */
const CHEVRON_COLLAPSED = sidebarStyles.chevronCollapsed;

/** The collapse chevron on a group heading, in its open or collapsed state. */
export function sidebarChevron(collapsed: boolean): string {
  return sx(CHEVRON, collapsed && CHEVRON_COLLAPSED);
}

/**
 * The count on a group or band heading. Written phone-first for the same
 * reason the containers above are: the rule this replaces bumped to 13px under
 * `max-width: 720px`, and `phone:` compiles to `< 720`.
 *
 * Horizontal spacing is deliberately NOT here. The old rule pinned every count
 * to the right with `margin-left: auto` and a 4px inset, and every call site
 * turned both back off. A count belongs to the name it counts: every heading
 * now reads "Docs Spell-Check, 5" with the number against the label, and the
 * right end of the row is left to whatever acts on the row.
 *
 * Nor is a size. A count is part of the heading it belongs to, so it inherits
 * that heading's step and is set apart by colour alone. Given a step of its
 * own it read as dropped out of the phrase rather than as part of it: a
 * numeral has no ascender, so the same nominal gap costs it more than it costs
 * a word.
 */
export const SIDEBAR_GROUP_COUNT = sx(sidebarStyles.count);

/**
 * The same count on a status-lane heading. Identical to
 * {@link SIDEBAR_GROUP_COUNT} today and kept as its own name because the two
 * headings are free to diverge; neither sets a size.
 */
export const SIDEBAR_LANE_COUNT = sx(sidebarStyles.count);

/** The 7px liveness dot a lane or automation heading leads with. */
export const SIDEBAR_GROUP_DOT = sx(sidebarStyles.dot);

/* The 22px glyph a top-level heading used to lead with is gone: Needs review,
   Approved, Awaiting review and Pinned are groupings rather than
   destinations, so they are labels now (see the height scale above) and carry
   no mark, exactly like the Yesterday / Earlier lanes they sit among. The
   marks that remain in the rail — a repo tile, a lane dot — belong to things
   you can open. */

/**
 * The sliders glyph at the end of an automation heading, jumping to that
 * automation's settings. `ml-auto` puts it at the right end, which is now its
 * own: the run count sits with the name, so nothing has to be swapped out to
 * make room for this. Hover-device only, like the row action clusters — on
 * touch there is no hover to reveal it with, and the heading falls back to
 * Settings for reaching an automation.
 *
 * The target is the full height of the row (`self-stretch` plus the negative
 * margins that eat the heading's own padding) and 4px wider than the box on
 * each side, because the thing being aimed at is 20px of glyph at the end of a
 * 36px row and the cursor arrives along the row rather than at its centre
 * line. The width comes from `::after` rather than from the box: a pseudo is
 * hit-tested as part of its element, so the target grows while the LAYOUT
 * still reserves 24px, and the heading's name truncates at the same
 * character it did before. The wash is its own 28px pseudo, because filling
 * the target would paint a slab the height of the row for a control that is
 * not the row (`paletteIconBtn` insets its own for the same reason).
 *
 * The wash belongs to the glyph, so it waits for the glyph. Hovering the row
 * reveals the control and nothing more; the fill and the brighter ink arrive
 * together once the pointer is actually on it. Painted with the row instead,
 * a heading you were only reading carried a filled box at its end, which read
 * as a second, already-lit control rather than as the row's own hover.
 */
export const SIDEBAR_AUTO_COG = cn(
  // The wash and the wider target are pseudo-elements, and the glyph rides
  // above the wash through a child reach: utilities.
  "before:absolute before:top-1/2 before:left-1/2 before:z-0 before:size-7 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-[calc(6px*var(--rf))] before:[corner-shape:var(--cs)] before:transition-[background] before:content-[''] hover:before:bg-pressed " +
    "after:absolute after:-inset-x-1 after:inset-y-0 after:content-[''] " +
    "[&>svg]:relative [&>svg]:z-1",
  sx(sidebarStyles.autoCog),
);

/**
 * What sits under an automation heading: its latest report, then its runs.
 *
 * A run is named after the automation that produced it, then the time it ran,
 * so on one rail the band read as a column of rows repeating two names rather
 * than as two automations with their work under them. The step is what says
 * which rows belong to which heading.
 *
 * It holds for a COLLAPSED group too, where the one row that can be there is
 * an owned automation's latest report. The step says "belongs to the heading
 * above", which is as true of a report as of a run; what says the group is
 * closed is the heading's own chevron, which is why that chevron shows at rest
 * rather than on hover (see the collapsed `sidebarChevron`). Flatten
 * the report onto the heading's rail instead and it stops reading as that
 * automation's finding and starts reading as another automation.
 *
 * It moves the CONTENT rail, not the row. `--sidebar-icon-left` is the column
 * every leading mark and every title lines up on, so overriding it here
 * indents the marks and the names together while the hover and selected fills
 * keep the sidebar's own edges, the way they do in every other family. That is
 * also how a nested row reads in Finder and the Xcode navigator. Indenting the
 * row box instead would leave one ragged left edge in a column of pills.
 */
export const SIDEBAR_AUTOMATION_RUNS = sx(sidebarStyles.automationRuns);

/**
 * ── Sticky machinery ────────────────────────────────────────────────────────
 * The desktop sidebar is ONE scroll rail, and two tiers of heading pin inside
 * it: a band heading (Tools / Workspaces / Automations / People) holds the top
 * slot, and the lane, repo and status headers under it pin one row lower.
 * Every pinning element also carries `data-sticky-head`, which is what
 * Sidebar's scroll listener queries. CSS has no interoperable `:stuck`, so JS
 * toggles `data-stuck`, and masks the rows under a stuck header
 * (hooks/useSidebarStickyHeadings.ts): a header paints no fill. This must
 * be a dedicated attribute rather than an imperative class: React owns
 * `className` and rewrites it on a sidebar rerender, even while the scroll
 * position stays put.
 *
 * Everything here is gated on `min-[721px]`: on phones the whole sidebar is a
 * page that scrolls as one, and nothing pins.
 */

/*
 * Tier 1: a band heading pinned at the top of the rail. `stickyBand` (worn
 * through sidebarBandHeading and sidebarWorkspacesBand) gives the tier-1
 * headings one invariant row height, which is what stops the
 * outgoing and incoming labels peeking around each other while one section
 * pushes the next away. It overrides whatever vertical padding/margin the
 * heading wears in the phone layout, so it is written at the same `min-[721px]`
 * breakpoint the pinning is.
 *
 * 32px rather than a 44px box of its own: a band caption carries the least on
 * the rail (a 12px faint word) and had the tallest box on it, which read as a
 * gap in the list rather than as a heading of it. This is a SLOT, not a third
 * row height — the caption inside it keeps the 28px label height, and the 4px
 * left over is the air a heading wants above the rows it names. It is also
 * what every tier-2 header pins under, so the offsets below start from it.
 */
/**
 * Tier 2: a lane / repo / status header, pinned one band-row lower. Once
 * pinned, the rows passing underneath are masked out and fade back in just
 * under the caption.
 *
 * Position only — this used to pin a 30px height on everything it touched,
 * which is where the rail's third and fourth heights came from: a repo band
 * (an item) and a status lane (a caption) are structurally the same tier and
 * so were forced to the same box despite being different kinds of thing. Each
 * now brings its own height from its family class, and the two agree with the
 * rows around them instead of with each other.
 */
const STICKY_LANE = sidebarStyles.stickyLane;

/**
 * A status lane nested inside a repo band sits one row lower again — its repo
 * header already occupies the first sub-header slot — and must pass UNDER that
 * header, hence the lower z-index.
 *
 * The offset is the band slot above it plus the repo header above it (an item):
 * 32 + 36 = 68 by default, 28 + 30 = 58 compact. Both of those heights are fixed
 * by their own class rather than by padding, which is what lets this be a sum
 * instead of a measurement; spelling it as the sum rather than as either
 * number is what keeps it right at both densities.
 */
const STICKY_LANE_NESTED = sidebarStyles.stickyLaneNested;

export interface SidebarHeaderOptions {
  /** `item`: a full-line heading that titles rows (a repo band, an
   *  automation group, Archived). `lane`: a caption (a status lane, an inbox
   *  band, Snoozed). */
  kind: "item" | "lane";
  /** Pins under the band slot on desktop, masking the rows under it. */
  sticky?: boolean;
  /** Pins one item lower again, under its repo band's own heading. */
  nested?: boolean;
  /** The one heading that navigates (Archived) paints the hover layer. */
  navigates?: boolean;
  /** The navigating heading's selected state. */
  selected?: boolean;
  /** A caption that toggles nothing: no hover ink, no pointer. */
  inert?: boolean;
}

/**
 * A group heading in the workspace list, as one class string. Every heading
 * shares the base box (the rail gap, the inset that puts its mark on the
 * shared rail, the ink that brightens on hover); `kind` picks the item's
 * line height or the caption's. One StyleX call, so the caption's tighter gap
 * and padding beat the base's by argument order.
 */
export function sidebarHeader(options: SidebarHeaderOptions): string {
  const { kind, sticky = false, nested = false } = options;
  return cn(
    kind === "lane" && LANE_NEW_LAYOUT,
    sx(
      HEADER,
      kind === "item" ? HEADER_ITEM : HEADER_LANE,
      options.navigates === true && sidebarStyles.hoverLayer,
      options.selected === true && sidebarStyles.headerSelected,
      options.inert === true && sidebarStyles.headerInert,
      sticky && STICKY_LANE,
      sticky && nested && STICKY_LANE_NESTED,
      sidebarHeaderMarker,
    ),
  );
}

/**
 * ── Band headings ───────────────────────────────────────────────────────────
 * The top-level bands (Workspaces / Automations / People) behave like Notion's:
 * the whole heading is a full-width hover row that toggles the band, the
 * collapse chevron sits by the label (revealed on hover), and the count or any
 * actions live on the right.
 *
 * The type is the CAPTION: the same 13px semibold ink a status lane wears (see
 * the `lane` heading), at both widths. A band and a lane are the same
 * kind of thing on this rail, a glyphless word naming the rows under it, so the
 * sidebar carries ONE label rather than one per nesting level. This used to
 * step down to 11px faint on desktop and up to 15px on phones, which left a
 * top-level heading smaller and quieter than the lanes nested inside it, and
 * made Automations and Earlier read as two different kinds of thing in the same
 * column.
 */
/**
 * The Automations and Team band headings: the caption, pinned in the band
 * slot on desktop. A band heading carries no leading
 * mark, so on phones it takes the 8px a 22px glyph spends on its own padding
 * before the ink starts.
 */
export function sidebarBandHeading(): string {
  return sx(sidebarStyles.bandHeading, sidebarStyles.stickyBand);
}

export interface SidebarWorkspacesBandOptions {
  /** Someone else's sidebar: this row is the lens bar, a filled strip on
   *  the rows' 8px inset, with air on phones to clear the floating top
   *  bar's fade. */
  borrowedLens: boolean;
  /** The place title's gap under it, as PlaceNav sets it. */
  newLayout: boolean;
}

/**
 * The Workspaces band row in the sidebar's chrome. A caption starts on the
 * rail's 16px text column. Phones drop its top air: with the caption hidden
 * and the chevron invisible but in layout, it was a near-empty band between
 * the tool cards and the first project.
 */
export function sidebarWorkspacesBand(
  options: SidebarWorkspacesBandOptions,
): string {
  return sx(
    sidebarStyles.workspacesBand,
    options.borrowedLens && sidebarStyles.workspacesBandBorrowed,
    sidebarStyles.stickyBand,
    options.newLayout && sidebarStyles.placeTitleGap,
  );
}

/** The Workspaces header row, as the hook its caption brightens with. */
export const SIDEBAR_WORKSPACES_HEAD = sx(sidebarWorkspacesHeadMarker);

export interface SidebarWorkspacesTitleOptions {
  /** The new layout's place title instead of the band caption. */
  newLayout: boolean;
  hidden: boolean;
}

/** The Workspaces caption, or the new layout's place title in its place. */
export function sidebarWorkspacesTitle(
  options: SidebarWorkspacesTitleOptions,
): string {
  return sx(
    sidebarStyles.workspacesTitle,
    options.newLayout && sidebarStyles.workspacesTitlePlace,
    options.hidden && sidebarStyles.hidden,
  );
}

/**
 * The new layout names each place (Sessions, Activity, Support, Library) at the
 * top of its sidebar. It is the sidebar's title, not a caption over a band, so
 * it is set a clear step above the rows in full ink.
 */
export const SIDEBAR_PLACE_TITLE = sx(sidebarStyles.placeTitle);

/**
 * The air between a place title and the first row under it. The title's slot
 * centers a 19px line in 32px, which left only a few pixels above the first
 * row's pill, so the title read as stuck to the list.
 */
export const SIDEBAR_PLACE_TITLE_GAP = sx(sidebarStyles.placeTitleGap);

/**
 * The heading's toggle button. A band heading is a LABEL, so it paints no
 * hover fill: only the ink brightens, to `fg`, which is the same step a lane
 * caption takes (see sidebarHeader). `--sidebar-cap-h` is the 28px label
 * height; it sits inside the 32px band slot, so the caption keeps a little
 * air around it without the pinned slot growing. Compact takes the pair to
 * 24 inside 28, which is the same 4px of air.
 *
 * The desktop inset lands the glyphless labels on the same 16px rail as
 * Tools, Workspaces and lane captions; phones keep the tighter base inset.
 * It carries sidebarBandMarker, so the chevron keys off its hover.
 */
export const SIDEBAR_BAND_TOGGLE = sx(
  sidebarStyles.bandToggle,
  sidebarBandMarker,
);

/**
 * The chevron reveals on hover but stays IN LAYOUT at all times (visibility,
 * not display), so it always reserves its box — otherwise its 18px height,
 * taller than the 12px label line, would grow the row the moment it appears
 * and nudge the whole list below. Reserved-but-hidden costs only trailing
 * space at the row's right edge, which is invisible.
 */
export interface SidebarBandChevronOptions {
  /** Stays visible while the band is folded: the counterpart to the
   *  collapsed `sidebarChevron`. */
  collapsed: boolean;
  /** Lifts its ink a step under the pointer too. */
  brighten: boolean;
}

export function sidebarBandChevron(options: SidebarBandChevronOptions): string {
  return sx(
    sidebarStyles.bandChevron,
    options.brighten && sidebarStyles.bandChevronBrighten,
    options.collapsed && sidebarStyles.bandChevronCollapsed,
  );
}

/** A toggle that is not SIDEBAR_BAND_TOGGLE (the Workspaces one) wears this
 *  so its chevron still reveals on its hover. */
export const SIDEBAR_BAND_HOOK = sx(sidebarBandMarker);

/**
 * The live-state dot a row, group header or hover card carries, minus the
 * `size-2 shrink-0 rounded-full` box the call sites already give it.
 *
 * The reduced-motion exceptions ride on the element rather than on a class
 * name listed in base.css: that block kills every animation with `!important`
 * and then hands the genuine liveness signals back BY CLASS NAME, so dropping
 * a legacy class name silently freezes the indicator with nothing to catch it.
 * These durations match what base.css grants `.sidebar-status-running` (1.4s)
 * and `.sidebar-status-waiting` (1.2s).
 *
 * `pulse` resolves to Tailwind's keyframes, not the stylesheet's: both define
 * one, keyframes don't cascade by specificity, and Tailwind's sheet is linked
 * second — which is already what these dots animate with today.
 */
/**
 * The sidebar's collapse toggle, and the floating re-open control that stands
 * in for it once the sidebar is hidden. They share a look on purpose: the
 * affordance has to read the same whether the sidebar is open or gone.
 *
 * Size and `display` are deliberately NOT here. The in-row toggle is a padding
 * box matching `.viewer-code-icon`, so the two top bars read as one system,
 * while the floating re-open control keeps a fixed 34x34 square (what centers
 * it on the collapsed header row) and starts out `hidden`. Two utilities from
 * the same group in one string would leave the winner to Tailwind's internal
 * ordering rather than to the call site.
 */
export const SIDEBAR_CHROME_BTN = sx(sidebarStyles.chromeButton);

export interface SidebarHeaderButtonOptions {
  phone: boolean;
  /** The filter button. Its open state paints the stronger wash and full
   *  ink, and its hover layers over that wash rather than replacing it. */
  filter?: { open: boolean };
}

/**
 * The square icon buttons in the workspace header: the options button and
 * the new session "+". 20px glyph type on a 34px box, stepped up to 22 on 38
 * at phone widths, where the whole sidebar is a tap surface.
 */
export function sidebarHeaderButton(
  options: SidebarHeaderButtonOptions,
): string {
  const { filter } = options;
  return sx(
    sidebarStyles.headerButton,
    options.phone && sidebarStyles.headerButtonPhone,
    filter ? sidebarStyles.hoverLayer : sidebarStyles.headerButtonWash,
    filter?.open === true && sidebarStyles.headerButtonOpen,
  );
}

/**
 * The trailing icon button on a band heading (the feed filter). While a
 * non-default filter is applied it rests in the accent and wears a dot. Its
 * hover still lifts the ink to `fg`: unlike the workspace header's filter,
 * the accent is a resting colour here, not a sticky one.
 */
export function sidebarBandAction(active: boolean): string {
  return sx(sidebarStyles.bandAction, active && sidebarStyles.bandActionActive);
}

/**
 * The attention count on a COLLAPSED band — urgent rows must not vanish inside
 * a closed group, so the band keeps a badge for them. The FILL is the call
 * site's, because it carries the meaning: a repo band counts needs-input rows
 * and wears that lane's blue, while a feed band counts its attention lane and
 * wears that lane's colour (Plain's Urgent is red — SUPPORT_PRIORITY_GROUPS).
 * A true pill: no squircle corner.
 */
export function sidebarAttnCount(tone: "blue" | "red"): string {
  return sx(
    sidebarStyles.attnCount,
    tone === "blue" ? sidebarStyles.attnBlue : sidebarStyles.attnRed,
  );
}

/**
 * ── Workspace rows: the trailing cluster ────────────────────────────────────
 * The metadata a workspace / PR / support / feed / archived row carries at its
 * right edge — count, time, run ticker, snooze countdown, draft pencil — and
 * the pin/archive actions that take their place under the pointer.
 *
 * Which of those is visible was decided by a stack of competing `display`
 * rules, three of which carried a comment about the SOURCE ORDER they depended
 * on ("must be @media-gated … it sits after the mobile override blocks",
 * "Three classes so it outranks …", "it must stay below it to win"). Utilities
 * cannot reproduce that: two utilities setting one property are settled by
 * Tailwind's internal output order, not by the order they are written on the
 * element. So the state is resolved in the components instead — every element
 * is handed exactly one `display` per variant level, and nothing needs to
 * out-rank anything. The same rule applies to the action colours below.
 */

/* A rail row (`sidebarRow({ layout: "rail" })`) is one flex line, so the
 * rail, the title and the trailing cluster sit on the sidebar's shared
 * columns. The gap is the rail gap, the same one every railed family takes.
 *
 * On hover the line gives up its right end to `sidebarRowActions`, which
 * floats over that spot. The reserve lives here, on the row, because it is the
 * row that has to clear it: it used to be a margin on the time badge, which
 * left a row without a time (a PR row, a ticket with no status change) with its
 * title running under the icons — invisible for as long as the actions wore an
 * opaque plate to cover it, and plainly wrong once they stopped.
 * The reserve is the row's own `:hover`, gated to hover devices, so touch
 * layouts never pay for it.
 *
 * 98px (`chips: 3`) is the cluster (7px right edge + three chips + the gaps) plus a little
 * air, and it is the number the session rows reserve for the same trio, so a
 * title truncates at one place in the rail rather than 12px
 * earlier on the families that share this row.
 */

/* Pin + snooze + archive, floated over the row's right edge so revealing them can never
 * change the row's height. The cluster used to wear an opaque plate, because a
 * long title runs under it; it doesn't need one — the row itself now reserves
 * that space on hover (see sidebarRow's `chips`), so the title has
 * re-truncated clear of the actions by the time they appear. A solid chip would
 * also cut a hole in the translucent row underneath it.
 *
 * The reveal is gated to real hover devices: on touch a sticky first-tap
 * `:hover` would otherwise expose actions that live behind the swipe gesture
 * there. A row whose swipe action is open hides the cluster outright.
 */

/**
 * One icon button in that cluster — the same box the session rows' pin and
 * archive wear (sidebarRowChip), so one hover chip
 * covers the whole rail. It was a flat 32px here while the session rows next
 * to it painted 26, which showed as two different chip heights on one column;
 * at the compact density 32 was also TALLER than the 30px row, so the chip
 * overhung the row's own hover pill by a pixel at each edge and read as a
 * second, competing pill rather than a button inside one.
 *
 * The size is {@link SIDEBAR_DENSITY_VARS}'s, so it steps down with the line
 * height and keeps its 5px / 3px margin inside the row at either setting.
 * `rounded-md` against the row's `rounded-control` is roughly concentric at both:
 * the chip's corner plus the air around it lands on the row's own.
 *
 * Its colour is the call site's: a pinned action stays accent even under the
 * pointer, and a Support row's "mark done" tints green rather than plain —
 * three `color` declarations that used to be settled by where their rules sat
 * in the sheet relative to each other.
 */
export const SIDEBAR_WS_ACTION_STYLES: Styles = [
  sidebarStyles.rowAction,
  sidebarStyles.rowChip,
];
export const SIDEBAR_WS_ACTION = sx(SIDEBAR_WS_ACTION_STYLES);

/* A row's compact last-activity time (sidebarRowTime). It has no `display`
 * of its own at rest on purpose: as a
 * flex item it blockifies, and `text-right` is what right-aligns the digits at
 * rest, while `justify-end` is what right-aligns them once a reveal turns it
 * into a flex box. When something precedes it, that element's own
 * `margin-left: auto` has already pushed the pair right — a second auto margin
 * would split the free space and strand one of them mid-row.
 *
 * Revealed, it is hidden at rest and shown on the row's hover. The room for
 * the action cluster is the row's own, so the time carries no margin for it.
 */

/**
 * Live "in progress" elapsed ticker — it sits where the time badge would, in
 * the in-progress colour, with tabular figures so the digits don't jitter as
 * they tick, and yields the slot to the hover actions.
 *
 * The phone size is its own: the run clock is text, not a glyph, so a hard
 * 28px box with centred digits overflowed on both sides. It sizes to its
 * digits and pins them to the gutter's inner edge, 6px short of the column
 * like every glyph above it. It reads in one unit ("42s", "12m", "1h 4m" —
 * see formatDuration), so it stays about as wide as the idle time badge it
 * stands in for instead of growing a clock's worth of digits.
 */
export const SIDEBAR_WS_TICKER = sx(sidebarStyles.ticker);

/**
 * Teammates focused on this row's work, as the same overlapping pile used by
 * Feed. The call site gives earlier faces the higher stack and rings every
 * squircle in this surface colour, so left-to-right reading order also stays
 * front-to-back. The solid ring follows the exact precomposited row surface,
 * including the extra layer where selection and hover meet, instead of cutting
 * a sidebar-coloured halo through it.
 */
export const SIDEBAR_WS_FACES = sx(sidebarStyles.faces);
export const SIDEBAR_WS_FACE = sx(sidebarStyles.face);

/**
 * Slack-style unsent-draft pencil. Its left margin is the call site's: on a
 * workspace row it pins itself to the right edge, unless a ticker or a snooze
 * countdown already did that pushing. It stays beside the hover actions, so
 * pointing at it reads the draft back.
 */
export const SIDEBAR_WS_DRAFT = sx(sidebarStyles.draft);

/**
 * Wake countdown on a snoozed workspace row (moon + "1h"). It stands in for
 * the idle time badge, so it rests in that same right-edge slot, matches its
 * type, and yields to the pin/archive actions like every other trailing badge.
 */
export const SIDEBAR_WS_SNOOZE = sx(sidebarStyles.snooze);

/**
 * ── Swipe rows ──────────────────────────────────────────────────────────────
 * The phone swipe shell around a workspace or session row: swipe left reveals
 * Archive, swipe right reveals Star; a long press still opens the full action
 * sheet. The wrapper carries the 2px gap between rows, so the row inside it
 * must not add its own or wrapped rows would gap twice.
 *
 * `rounded-control` is what clips the revealed actions to the row's own corner —
 * and, because base.css grants `corner-shape: squircle` to every `rounded-*`
 * class, it is also what lets this name drop out of the hand-written list of
 * legacy classes base.css squircles there.
 */
export const SIDEBAR_SWIPE_ROW = sx(sidebarStyles.swipeRow);

export interface SidebarSwipeActionOptions {
  /** `archive`: destructive, on the trailing edge because the swipe travels
   *  left. `star`: pin, on the leading edge, in dark ink because the yellow
   *  is too light for white. `starOn`: already pinned, the same action in
   *  the accent, so the swipe reads as a toggle. `unsnooze`: a snoozed row's
   *  leading edge wakes it instead (Pinned leaves snoozed rows out, so a pin
   *  there would change nothing visible). */
  side: "archive" | "star" | "starOn" | "unsnooze";
  /** The gesture opened this side. Touch only: on a hover device the same
   *  jobs are the row's hover actions, and a mouse can never open this. */
  open: boolean;
  /** The finger is down: no transition, which would lag the drag a frame. */
  dragging: boolean;
}

/**
 * One revealed action behind a swiped row, its width tracking the drag
 * through `--swipe-action-w`, written straight onto the wrapper per frame.
 * Each side carries its own fill and its own ink. The icon's `shrink-0` is a
 * child reach, so it stays a utility.
 */
export function sidebarSwipeAction(options: SidebarSwipeActionOptions): string {
  return cn(
    "[&>svg]:shrink-0",
    sx(
      sidebarStyles.swipeAction,
      options.side === "archive"
        ? sidebarStyles.swipeArchive
        : options.side === "star"
          ? sidebarStyles.swipeStar
          : options.side === "starOn"
            ? sidebarStyles.swipeStarOn
            : sidebarStyles.swipeUnsnooze,
      options.open && sidebarStyles.swipeOpen,
      !options.dragging && sidebarStyles.swipeEase,
    ),
  );
}

export interface SidebarRowOptions {
  /** `rail`: the row lays its mark, title and trailing meta out on the rail
   *  (every family but the session row). `block`: a session row, which
   *  stacks its own lines. */
  layout: "rail" | "block";
  /** Inside a swipe shell: the shell carries the 2px gap and the row the
   *  slide, above the revealed actions. */
  swipe?: boolean;
  selected?: boolean;
  /** How many chips the row's right end makes room for under the pointer:
   *  8px of edge plus 30px a chip. */
  chips: 1 | 2 | 3 | 4;
  /** One chip stands at rest (Team's add): the room for it is kept without
   *  a pointer, at its 44px touch size on phones. */
  standing?: boolean;
}

/**
 * The sidebar's selectable row: the box every list family wears (session,
 * workspace, PR, support, feed, report and draft rows), as one StyleX call.
 * State rides `data-selected` / `data-waiting` / `data-unread` on the row,
 * and its parts read it through `sidebarRowMarker`. `group` stays on as a hook
 * for the few parts that still reveal on the row's hover through Tailwind.
 * `data-sidebar-row` is the hook the row walker queries by, set at the call
 * site.
 *
 * `--sidebar-row-pad` around the 22px rail is the ITEM height (36px, 30px
 * compact), the box the tool rows and item headings take too. Phones keep a
 * 13px pad at both densities: there the row is a tap target.
 */
export function sidebarRow(options: SidebarRowOptions): string {
  const { chips, standing = false } = options;
  const reserve = standing
    ? chips === 1
      ? sidebarStyles.standing1
      : sidebarStyles.standing2
    : chips === 1
      ? sidebarStyles.reserve1
      : chips === 2
        ? sidebarStyles.reserve2
        : chips === 3
          ? sidebarStyles.reserve3
          : sidebarStyles.reserve4;
  return cn(
    "group",
    sx(
      sidebarStyles.row,
      options.layout === "rail"
        ? sidebarStyles.rowRail
        : sidebarStyles.rowBlock,
      options.swipe === true && sidebarStyles.rowSwipe,
      reserve,
      sidebarStyles.hoverLayer,
      options.selected === true && sidebarStyles.rowSelected,
      sidebarRowMarker,
    ),
  );
}

/**
 * A row's title: one line that fades out at the available edge instead of
 * ending in an ellipsis. Read conversations stay quiet; unread ones brighten,
 * then bold once the agent finishes. A blocked one bolds too, because it
 * needs a person.
 */
export const SIDEBAR_ROW_TITLE = sx(sidebarStyles.title);

export interface SidebarRowChipOptions {
  /** `edge`: the row's right end. `second`: one chip in from it. */
  slot: "edge" | "second";
  /** A pinned pin: pressed, in full ink. */
  on?: boolean;
  /** Visible at rest, at touch size on phones (Team's add). */
  standing?: boolean;
}

/**
 * A session row's positioned chip, revealed by the row's hover. A lid, not a
 * wash: its hover takes `--row-chip` (see SIDEBAR_ROW_CHIP).
 */
export function sidebarRowChipStyles(options: SidebarRowChipOptions): Styles {
  return [
    sidebarStyles.chip,
    sidebarStyles.rowChip,
    options.slot === "edge" ? sidebarStyles.chipEdge : sidebarStyles.chipSecond,
    options.on === true && sidebarStyles.chipOn,
    options.standing === true && sidebarStyles.chipStanding,
  ];
}

export function sidebarRowChip(options: SidebarRowChipOptions): string {
  return sx(sidebarRowChipStyles(options));
}

/**
 * A rail row's hover chip cluster (pin, snooze, archive, keep): it takes the
 * metadata's place at the far right on the row's hover. `hidden` keeps it out
 * entirely, for a row whose swipe action owns that edge.
 */
export function sidebarRowActions(hidden = false): string {
  return sx(sidebarStyles.rowActions, hidden && sidebarStyles.rowActionsHidden);
}

export interface SidebarRowTimeOptions {
  /** Shown only under the row's hover. */
  reveal: boolean;
  /** Revealed: also shown on a touch device, which has no hover. */
  touch?: boolean;
  /** Hidden at rest (a running row shows its duration there instead); a
   *  revealed time still takes the hover. */
  hidden?: boolean;
}

/** A row's trailing time. */
export function sidebarRowTime(options: SidebarRowTimeOptions): string {
  return sx(
    sidebarStyles.time,
    options.reveal
      ? options.touch === true
        ? sidebarStyles.timeRevealTouch
        : sidebarStyles.timeReveal
      : options.hidden === true && sidebarStyles.timeHidden,
  );
}
