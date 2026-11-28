import * as stylex from "@stylexjs/stylex";
import { titlePillMarker } from "./markers.stylex";
import {
  blur,
  color,
  controlHeight,
  focus,
  geometry,
  leading,
  media,
  motion,
  opacity,
  radius,
  shadow,
  space,
  text,
  weight,
} from "./tokens.stylex";

/**
 * The phone top bar, in StyleX. `lib/app-header-classes.ts` reads these as
 * class strings and documents each piece; this file only holds the values.
 *
 * Almost all of it applies at phone width alone, so `phone()` wraps a value in
 * that query. Hooks that stylesheets and other modules read stay plain class
 * names on the markup (`app-header-actions`, `header-sessionbar`,
 * `pwa-header-back`, `app-header-overlay`).
 */
const phone = <T>(value: T) => ({ default: null, [media.phone]: value });

export const appHeaderStyles = stylex.create({
  bar: {
    display: { default: "none", [media.phone]: "flex" },
    height: geometry.headerHeight,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: color.sidebar,
    paddingInline: { default: space.s16, [media.phone]: space.s12 },
    paddingTop: {
      default: geometry.headerSafeTop,
      [media.phone]: geometry.headerSafeTopPhone,
    },
    paddingBottom: space.s0,
  },
  inFlow: { position: phone("relative") },
  // A pushed page lets the content show through behind its controls. The
  // default restates the bar's: merged after it, this replaces the whole
  // property, desktop value included.
  detail: {
    backgroundColor: {
      default: color.sidebar,
      [media.phone]: color.transparent,
    },
  },

  // What every floating control in this bar is made of. The `-webkit-`
  // spelling is what iOS Safari, and the installed PWA, still ship.
  glassEffects: {
    backdropFilter: phone(blur.headerControl),
    WebkitBackdropFilter: phone(blur.headerControl),
  },
  glassFill: { backgroundColor: phone(color.headerControl) },
  // The capsule shared by Back, the title pill and the grouped actions.
  capsule: {
    borderRadius: phone(radius.pill),
    borderWidth: phone(geometry.hairline),
    borderStyle: phone("solid"),
    borderColor: phone(color.headerControlEdge),
    boxShadow: phone(shadow.headerControl),
  },

  control: {
    margin: phone(space.s0),
    display: phone("inline-flex"),
    width: phone(controlHeight.touch),
    height: phone(controlHeight.touch),
    minHeight: phone(controlHeight.touch),
    alignItems: phone("center"),
    justifyContent: phone("center"),
    // Longhands, to outrank Button's own paddingInline on the bar's Buttons.
    paddingInline: phone(space.s0),
    paddingBlock: phone(space.s0),
    color: phone(color.fg),
    cursor: phone("pointer"),
    touchAction: phone("manipulation"),
    WebkitTapHighlightColor: phone(color.transparent),
    transitionProperty: phone("opacity"),
    transitionDuration: {
      default: null,
      [media.phone]: { default: motion.standard, ":active": "0s" },
    },
    transitionTimingFunction: phone(motion.ease),
    scale: { default: null, [media.phone]: { default: null, ":active": 1 } },
    opacity: {
      default: null,
      [media.phone]: { default: null, ":active": opacity.pressedGlass },
    },
  },

  titlePill: {
    display: phone("flex"),
    minHeight: phone(controlHeight.touch),
    flex: phone("0 1 auto"),
    minWidth: phone(0),
    alignItems: phone("center"),
    justifyContent: phone("flex-start"),
    gap: phone(geometry.headerPillGap),
    marginLeft: phone(space.s8),
    marginRight: phone("auto"),
    paddingBlock: phone(geometry.headerPillPadBlock),
    paddingRight: phone(space.s16),
    paddingLeft: phone(geometry.headerPillPadStart),
    color: phone(color.fg),
    pointerEvents: phone("auto"),
  },
  /**
   * On a session the pill is the tap target for the settings menu, and the name
   * dims on press to say so. `titlePillMarker` is what carries that press down to
   * the name; it is only on the markup when the pill is actually tappable, so
   * the plain title can't dim on a stray press.
   */
  titlePillTappable: {
    cursor: phone("pointer"),
    WebkitTapHighlightColor: phone(color.transparent),
  },
  /** Center a plain page title independently of the leading and trailing controls. */
  titlePillCentered: {
    position: phone("absolute"),
    left: phone("50%"),
    marginLeft: phone(space.s0),
    marginRight: phone(space.s0),
    transform: phone("translateX(-50%)"),
  },
  /**
   * The pill on a page that names itself, which is every page but a session: it
   * is not there until that name has scrolled up under the bar, and then it is.
   * The iOS large title, on the surface the pattern comes from. `data-shown` is
   * set by hooks/useLargeTitle.ts.
   *
   * The whole lozenge fades, not just the word inside it. This one is a floating
   * pill rather than a band across the top, so an empty one is a blank white
   * capsule sitting in the header with nothing in it, which is worse than the
   * duplicate title it was there to avoid.
   */
  titlePillFade: {
    translate: {
      default: null,
      [media.phone]: { default: `0 ${space.s4}`, ":is([data-shown])": "0 0" },
    },
    opacity: {
      default: null,
      [media.phone]: { default: 0, ":is([data-shown])": 1 },
    },
    transitionProperty: phone("opacity, translate"),
    transitionDuration: phone(motion.micro),
    transitionTimingFunction: phone(motion.ease),
  },
  titleRepo: {
    display: {
      default: null,
      [media.phone]: { default: "inline-flex", ":empty": "none" },
    },
    flex: phone("none"),
    alignItems: phone("center"),
    justifyContent: phone("center"),
  },
  titleColumn: {
    display: phone("flex"),
    minWidth: phone(0),
    flexDirection: phone("column"),
    alignItems: phone("flex-start"),
    justifyContent: phone("center"),
    gap: phone(geometry.hairline),
  },
  titleRow: {
    display: phone("flex"),
    minWidth: phone(0),
    maxWidth: phone("100%"),
    alignItems: phone("center"),
    gap: phone(geometry.headerTitleGap),
    fontSize: phone(text.body),
    lineHeight: phone(space.s16),
    fontWeight: phone(weight.strong),
  },
  titleText: {
    flex: phone("1 1 0%"),
    opacity: {
      default: null,
      [media.phone]: {
        default: null,
        [stylex.when.ancestor(":active", titlePillMarker)]: opacity.pressedText,
      },
    },
  },
  titleModel: {
    maxWidth: phone("100%"),
    overflow: phone("hidden"),
    textOverflow: phone("ellipsis"),
    whiteSpace: phone("nowrap"),
    fontSize: phone(text.meta),
    fontWeight: phone(weight.medium),
    lineHeight: phone(leading.title),
    color: phone(color.faint),
    pointerEvents: phone("auto"),
  },

  sessionbar: {
    outline: { default: null, ":focus-visible": focus.ring },
    outlineOffset: { default: null, ":focus-visible": focus.insetOffset },
    display: phone("inline-flex"),
    minHeight: phone(space.s16),
    minWidth: phone(0),
    maxWidth: phone("100%"),
    alignItems: phone("center"),
    justifyContent: phone("flex-start"),
    gap: phone(space.s6),
    cursor: phone("pointer"),
    pointerEvents: phone("auto"),
    WebkitTapHighlightColor: phone(color.transparent),
    opacity: {
      default: null,
      [media.phone]: { default: null, ":active": opacity.pressedText },
    },
  },
  sessionbarSep: {
    flexShrink: phone(0),
    fontSize: phone(geometry.metaDot),
    lineHeight: phone(space.s16),
    color: phone(color.dim),
  },
  sessionbarModel: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: phone(0),
    maxWidth: phone(geometry.headerModelMax),
    fontSize: phone(text.meta),
    fontWeight: phone(weight.medium),
    color: phone(color.dim),
  },

  actions: {
    display: phone("flex"),
    minWidth: phone(0),
    alignItems: phone("center"),
  },
  actionsGrouped: {
    marginLeft: phone("auto"),
    gap: phone(space.s0),
    overflow: phone("hidden"),
  },
  actionsLoose: {
    marginLeft: phone(space.s10),
    flex: phone("none"),
    gap: phone(space.s10),
  },
  segment: {
    outline: { default: null, ":focus-visible": focus.ring },
    outlineOffset: { default: null, ":focus-visible": focus.insetOffset },
    position: phone("relative"),
    display: phone("inline-flex"),
    height: phone(geometry.headerSegmentHeight),
    width: phone(geometry.headerSegmentWidth),
    flexShrink: phone(0),
    alignItems: phone("center"),
    justifyContent: phone("center"),
    borderRadius: phone(space.s0),
    borderStyle: phone("none"),
    backgroundColor: phone(color.transparent),
    padding: phone(space.s0),
    boxShadow: phone("none"),
    cursor: phone("pointer"),
    touchAction: phone("manipulation"),
    WebkitTapHighlightColor: phone(color.transparent),
    opacity: {
      default: null,
      [media.phone]: { default: null, ":active": opacity.pressedSegment },
    },
  },
  searchSegment: {
    color: phone(color.fg),
    transitionProperty: phone("opacity"),
    transitionDuration: {
      default: null,
      [media.phone]: { default: motion.standard, ":active": "0s" },
    },
    transitionTimingFunction: phone(motion.ease),
  },
  filterSegment: {
    order: phone(-1),
    transitionProperty: phone("opacity, color"),
    transitionDuration: {
      default: null,
      [media.phone]: {
        default: `${motion.standard}, ${motion.micro}`,
        ":active": "0s",
      },
    },
    transitionTimingFunction: phone(motion.ease),
    color: phone(color.dim),
  },
  filterSegmentActive: { color: phone(color.fg) },

  logoStatus: {
    position: "absolute",
    right: geometry.logoStatusOffset,
    bottom: geometry.logoStatusOffset,
    width: geometry.logoStatusDot,
    height: geometry.logoStatusDot,
    borderRadius: radius.pill,
    borderWidth: geometry.logoStatusRing,
    borderStyle: "solid",
    borderColor: color.raised,
  },
});
