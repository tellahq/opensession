/**
 * The Settings shell — what used to be the `settings-page` / `settings-back` /
 * `settings-content` / `settings-panel-frame` rules in legacy.css.
 *
 * Settings renders twice from one component file: a full-window page with a
 * side nav (desktop) and a bottom sheet with an iOS-style paged header
 * (phones, `MobileSettings`). The old sheet expressed the second as three
 * descendant overrides under `.settings-sheet`; here each surface names its
 * own finished string, because a descendant override is exactly the shape
 * that breaks when half a subtree migrates.
 *
 * `.settings-sheet` itself is NOT migrated and stays on the BottomSheet: it is
 * a hook, not styling — ui/settings.tsx reads it as `[.settings-sheet_&]:hidden`
 * to drop the page heading the sheet's own header already carries.
 *
 * One inherited quirk is preserved deliberately. A tool section (Automations,
 * Goals, Actions, Security) goes edge-to-edge on desktop, because those panels
 * bring their own padding and scrolling. Inside the sheet it does NOT: the old
 * `.settings-sheet .settings-content` was two class selectors and outranked
 * the single `.settings-content-tool`, so a tool section kept the sheet's 8px
 * gutter. That is almost certainly not what the override intended, but it is
 * what phones have been rendering, so SETTINGS_CONTENT_SHEET is the same
 * string either way rather than quietly re-cutting a layout this change is not
 * about.
 *
 * The desktop nav is not a cousin of the app's sidebar, it is the same design:
 * it takes that rail's surface, vertical scale, 22px glyph rail, hover layer
 * and selected wash from lib/sidebar-classes rather than re-deriving them
 * here. Anything below that reads as a settings-only number is a number the
 * two navs genuinely differ on, and says why.
 */

import * as stylex from "@stylexjs/stylex";
import { cn } from "../ui/cn";
import { settingsNavRowMarker } from "../ui/markers.stylex";
import { SELECTABLE } from "../ui/dialog-styles";
import { classString as sx } from "../ui/sx";
import {
  blur,
  color,
  geometry,
  layer,
  media,
  radius,
  corner,
  sidebarScale,
  space,
  text,
  weight,
} from "../ui/tokens.stylex";
import { SCROLL_EDGE_DIVIDER } from "./app-shell-classes";
import { sidebarStyles } from "./sidebar-classes";

/**
 * The class `Settings` sets a compact (1.1) leading on, from the page down
 * (`SETTINGS_LEADING` in components/Settings.tsx): a row title here carries no
 * `text-item-title` class for that rule to find. A hook, not styling.
 */
const TITLE_HOOK = "settings-title";

const styles = stylex.create({
  page: {
    position: "relative",
    display: "flex",
    height: "100%",
    minHeight: 0,
    flex: "1 1 0%",
    backgroundColor: color.sidebar,
  },
  dragHandle: {
    position: "absolute",
    insetInline: space.s0,
    top: space.s0,
    zIndex: layer.sticky,
    height: geometry.desktopHeaderHeight,
  },
  nav: {
    display: "flex",
    width: geometry.settingsNavWidth,
    flexShrink: 0,
    flexDirection: "column",
    paddingInline: space.s12,
    paddingBlock: space.s16,
  },
  navList: {
    marginInline: `calc(-1 * ${space.s6})`,
    display: "flex",
    minHeight: 0,
    flex: "1 1 0%",
    flexDirection: "column",
    overflowX: "hidden",
    overflowY: "auto",
    paddingTop: space.s8,
    scrollbarWidth: "none",
    "::-webkit-scrollbar": { display: "none" },
  },
  navGroup: { display: "flex", flexDirection: "column" },
  navCaption: {
    display: "flex",
    height: sidebarScale.captionVar,
    flexShrink: 0,
    alignItems: "center",
    paddingInline: space.s10,
    fontSize: text.label,
    fontWeight: weight.heading,
    color: color.dim,
  },
  // Back and the section rows: one box, so the chevron and the section
  // glyphs share a centre line.
  navRow: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    borderRadius: radius.control,
    ["cornerShape"]: corner.squircle,
    borderStyle: "none",
    backgroundColor: {
      default: color.transparent,
      ":is([data-active])": color.selected,
    },
    paddingBlock: sidebarScale.rowPadVar,
    paddingRight: space.s8,
    paddingLeft: space.s10,
    textAlign: "left",
    fontSize: text.itemTitle,
    fontWeight: weight.medium,
    color: {
      default: color.dim,
      ":hover": { default: null, [media.hover]: color.fg },
      ":is([data-active])": color.fg,
    },
  },
  back: { marginInline: `calc(-1 * ${space.s6})`, marginBottom: space.s8 },
  section: { marginTop: space.s2, width: "100%" },
  navIcon: {
    color: {
      default: color.faint,
      [stylex.when.ancestor(":hover", settingsNavRowMarker)]: {
        default: null,
        [media.hover]: color.fg,
      },
      [stylex.when.ancestor(":is([data-active])", settingsNavRowMarker)]:
        color.fg,
    },
  },
  content: {
    display: "flex",
    minWidth: 0,
    flex: "1 1 0%",
    justifyContent: "center",
    overflowY: "auto",
    borderLeftWidth: geometry.hairline,
    borderLeftStyle: "solid",
    borderLeftColor: color.divider,
    backgroundColor: color.page,
    paddingInline: space.s32,
    paddingTop: geometry.settingsContentTop,
    boxShadow: { default: null, [media.desktop]: geometry.contentEdgeShadow },
  },
  contentTool: {
    minHeight: 0,
    paddingInline: space.s0,
    paddingTop: space.s0,
    paddingBottom: space.s0,
  },
  contentSheet: {
    display: "flex",
    minHeight: 0,
    minWidth: 0,
    flex: "1 1 0%",
    justifyContent: "center",
    overflowY: "auto",
    paddingInline: space.s8,
    paddingTop: space.s16,
  },
  frame: {
    width: "100%",
    maxWidth: geometry.settingsColumn,
    alignSelf: "flex-start",
    paddingBottom: geometry.settingsPanelBottom,
  },
  frameGallery: { maxWidth: geometry.settingsColumnWide },
  frameSheet: { paddingBottom: space.s48 },
  sheetList: {
    height: "100%",
    overflowY: "auto",
    paddingInline: space.s16,
    paddingBottom: geometry.settingsSheetListBottom,
  },
  // Glass in the phone app header's terms: a layer that blurs what passes
  // behind, tinted with the page colour and masked so the blur ends softly.
  // The layer's `zIndex: -1` needs the bar's own stacking context.
  sheetSearchBar: {
    position: "absolute",
    insetInline: space.s0,
    bottom: space.s0,
    zIndex: layer.overPreview,
    paddingInline: space.s16,
    paddingBottom: space.s10,
    paddingTop: space.s8,
    "::before": {
      content: "''",
      pointerEvents: "none",
      position: "absolute",
      insetInline: space.s0,
      bottom: space.s0,
      top: "auto",
      zIndex: -1,
      height: geometry.settingsSheetGlassReach,
      // Translucent all the way down, not opaque at the base: glass that
      // admits nothing is just a panel. It only firms up (88%) at the very
      // bottom edge, where a row would otherwise read THROUGH the field.
      backgroundImage: `linear-gradient(to top, color-mix(in srgb, ${color.page} 88%, transparent) 0%, color-mix(in srgb, ${color.page} 76%, transparent) 55%, color-mix(in srgb, ${color.page} 45%, transparent) 78%, transparent 100%)`,
      backdropFilter: blur.sheetSearch,
      WebkitBackdropFilter: blur.sheetSearch,
      WebkitMaskImage: `linear-gradient(to top, ${color.mask} 0%, ${color.mask} 62%, transparent 100%)`,
      maskImage: `linear-gradient(to top, ${color.mask} 0%, ${color.mask} 62%, transparent 100%)`,
    },
  },
  sheetCaption: {
    marginBottom: space.s8,
    marginTop: space.s20,
    paddingInline: space.s4,
    fontSize: text.label,
    fontWeight: weight.heading,
    color: color.faint,
  },
  sheetRow: {
    position: "relative",
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.s12,
    borderStyle: "none",
    backgroundColor: { default: color.transparent, ":active": color.hover },
    paddingInline: space.s14,
    paddingBlock: space.s12,
    textAlign: "left",
  },
  sheetGlyph: {
    display: "flex",
    width: geometry.settingsSheetGlyph,
    height: geometry.settingsSheetGlyph,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    color: color.dim,
  },
  sheetLabel: {
    minWidth: 0,
    flex: "1 1 0%",
    fontSize: text.itemTitle,
    fontWeight: weight.medium,
    color: color.fg,
  },
  sheetHint: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.meta,
    fontWeight: weight.regular,
    color: color.faint,
  },
  sheetEmpty: {
    marginTop: space.s24,
    paddingInline: space.s4,
    fontSize: text.label,
    fontWeight: weight.regular,
    color: color.faint,
  },
  accountFooter: {
    position: "sticky",
    bottom: space.s0,
    marginInline: `calc(-1 * ${space.s12})`,
    marginBottom: `calc(-1 * ${space.s16})`,
    marginTop: "auto",
    display: "flex",
    flexDirection: "column",
    borderTopWidth: geometry.hairline,
    borderTopStyle: "solid",
    borderTopColor: color.divider,
    backgroundColor: color.sidebar,
    paddingInline: space.s6,
    paddingBottom: space.s16,
    paddingTop: space.s12,
  },
  accountRow: {
    display: "flex",
    alignItems: "center",
    paddingBlock: sidebarScale.rowPadVar,
    paddingLeft: space.s10,
    paddingRight: space.s8,
  },
  accountSwitch: {
    width: "100%",
    minWidth: 0,
    borderRadius: radius.control,
    ["cornerShape"]: corner.squircle,
    borderStyle: "none",
    backgroundColor: {
      default: color.transparent,
      ":is([data-popup-open])": color.selected,
    },
    textAlign: "left",
  },
});

/**
 * The full-window page: side nav + content, filling the app body.
 *
 * It paints the SIDEBAR's surface rather than the page's, which is what
 * APP_BODY does and the first half of why the two navs read as one design. A
 * nav is a column of chrome; what separates it from the content is the seam
 * and the shadow on the content's left edge (see SETTINGS_CONTENT), so the
 * column itself needs no fill and no border of its own.
 */
export const SETTINGS_PAGE = sx(styles.page);

/**
 * The otherwise-empty desktop titlebar strip. `wco-chrome` makes it a window
 * drag region in Electron; `settings-drag-handle` lets base.css keep this
 * platform chrome out of browser and phone layouts.
 */
export const SETTINGS_DRAG_HANDLE = cn(
  "settings-drag-handle wco-chrome",
  sx(styles.dragHandle),
);

/**
 * The nav column. No fill, no edge: the page under it is already the sidebar
 * surface, exactly as the app's own sidebar sits on APP_BODY's.
 *
 * It also sets the sidebar's vertical scale, so a settings row, its caption
 * and the app's rows run on one set of numbers instead of two copies that
 * drift. The compact overrides in that string key off a `data-density`
 * attribute this element deliberately does not carry: the preference is named
 * "Compact sidebar" and retunes the rail you work in, not a nav you visit.
 */
export const SETTINGS_NAV = cn(
  "settings-nav",
  sx(styles.nav, sidebarStyles.density),
);

/**
 * The nav's search field, and the seam it grows once the section list travels
 * under it.
 *
 * At rest there is no line: the field and the list sit on one fill, so there is
 * nothing between them to close off. Once the list has scrolled there is a cut
 * edge, a row sliced in half at the top of the scrollport, and this closes it.
 * The app's own chrome rows answer their scroller on the same terms; see
 * SCROLL_EDGE_DIVIDER, and hooks/useScrollEdge.ts for why the state arrives as
 * an attribute rather than a scroll timeline.
 *
 * The line runs to the column's own edges rather than the field's, which is
 * where SettingsAccountFooter puts its top border: a seam across the column is
 * as wide as the column. The 8px under the field is the air that keeps a
 * half-scrolled row off the field's edge, and the list's own `pt-2` matches it
 * at rest, so the line lands centred in the gap it appears in.
 */
export const SETTINGS_NAV_SEARCH = cn(
  SCROLL_EDGE_DIVIDER,
  "pb-2 after:-inset-x-3",
);

/**
 * The scrolling section list, and one group inside it.
 *
 * The list is outdented past the nav's gutter so a row's pill sits 6px from
 * the column edge and its content lands on the app sidebar's 16px rail
 * (6 + the row's own 10px). That overflow is what gives the rail its
 * Conductor-style pill; see SIDEBAR_LIST, which is the same move from the
 * other direction. Its scrollbar is hidden for the reason the app's is: a
 * track down the middle of the window cuts the nav off from the content.
 */
export const SETTINGS_NAV_LIST = sx(styles.navList);

export const SETTINGS_NAV_GROUP = sx(styles.navGroup, sidebarStyles.group);

/**
 * A group's caption: Personal, Organization. The app's band headings in every
 * respect that shows: the caption height, 13px semibold, and dim ink rather
 * than faint. It was 11px bold with letterspacing, which is a different
 * typographic idea (a small-caps label) from the one the sidebar uses.
 */
export const SETTINGS_NAV_CAPTION = sx(styles.navCaption);

/**
 * "Back to app" is the first row of the nav, and now a member of the row family
 * below rather than a smaller control above it: same box, same rail, so its
 * chevron and the section glyphs share a centre line.
 *
 * No `w-full`. It is outdented like the list, and a stretched flex child
 * already measures its container plus those two negative margins; `w-full`
 * would size it to the container alone and pull the pill back in on the right.
 */
export const SETTINGS_BACK = cn(
  TITLE_HOOK,
  sx(
    styles.navRow,
    sidebarStyles.railGap,
    sidebarStyles.hoverLayer,
    styles.back,
    settingsNavRowMarker,
  ),
);

/**
 * The scrolling content column beside the nav. `tool` sections fill it
 * edge-to-edge. `settings-content` and `settings-content-tool` stay on the
 * markup as hooks: base-platform.css keeps the desktop shell's titlebar clear
 * of every face but the tool one.
 *
 * The seam and the shadow are DETAIL_PANE's, the other half of the pair
 * SETTINGS_PAGE opens: the content is paper laid over the chrome, and the only
 * thing between them is that hairline plus, in light, a little depth. The
 * shadow rides `--content-edge-shadow`, which is `none` in dark.
 *
 * The page has no entrance. Opening Settings was animated twice (a fade and
 * slide, then a seam glide that started the column at the app rail's own edge)
 * and neither earned its place: Settings is somewhere you go, not something
 * that arrives, and any motion here delays a page you already asked for. It
 * cuts.
 */
export function settingsContent(tool: boolean): string {
  // One StyleX call, so the tool face's zero padding beats the column's.
  return cn(
    "settings-content",
    tool && "settings-content-tool",
    sx(styles.content, tool && styles.contentTool),
  );
}

/** Same column inside the phone sheet — a phone gutter instead of the desktop one. */
export const SETTINGS_CONTENT_SHEET = sx(styles.contentSheet);

/** The reading column a settings panel sits in, and its bottom air. */
export const SETTINGS_PANEL_FRAME = sx(styles.frame);

/**
 * The column a settings panel that BROWSES sits in. The Library is a catalog
 * rather than a form: its cards go two up, and at the reading column's 720px
 * a card is narrow enough that the sentence saying what it does gets cut off
 * mid-word. The measure that matters here is the card's, not the paragraph's.
 */
export const SETTINGS_PANEL_FRAME_GALLERY = sx(
  styles.frame,
  styles.frameGallery,
);
export const SETTINGS_PANEL_FRAME_SHEET = sx(styles.frame, styles.frameSheet);

/**
 * The phone sheet's section list and the search bar floating over its bottom
 * edge, where iOS 26 puts a list's search.
 *
 * The bar is glass, in the same terms the phone app header uses (APP_HEADER):
 * a `before:` layer that blurs what passes behind it, tinted with a gradient
 * of the page colour and masked so the blur ends softly instead of on a line.
 * That only reads as glass if there IS something behind it, so the list scrolls
 * the full height of the page and reserves the bar's height as bottom padding —
 * the last row can still be scrolled clear of it.
 *
 * The layer's negative z-index needs the bar's own: without a stacking context
 * of its own, a negative-z pseudo drops behind the list rather than sitting
 * under its parent's content.
 */
export const SETTINGS_SHEET_LIST = sx(styles.sheetList);

export const SETTINGS_SHEET_SEARCH_BAR = sx(styles.sheetSearchBar);

/**
 * A row in the settings navigation: the section list and the account block
 * under it, which are one list visually and were two copies of this string.
 *
 * This is the sidebar row (sidebarRow): the same 2px gap between rows, the same
 * `--sidebar-row-pad` box around a 22px rail, the same 7px to the title, the
 * same asymmetric 10/8 gutters.
 *
 * The two fills are the point of the exercise. Selected was `bg-active`
 * (#e0e0e0 in light), an opaque surface from the top of the elevation ramp,
 * which put a grey plate on the one row you are already reading. It takes
 * `--selected` now, the translucent ink the app marks an open session with,
 * and hover is the sidebar's LAYER rather than a colour, so pointing at the
 * selected row lifts it instead of swapping one wash for a lighter one. See
 * SIDEBAR_HOVER_LAYER, which explains why that has to be a layer.
 */
export const SETTINGS_NAV_ROW = cn(
  TITLE_HOOK,
  sx(
    styles.navRow,
    sidebarStyles.railGap,
    sidebarStyles.hoverLayer,
    styles.section,
    settingsNavRowMarker,
  ),
);

/**
 * The row's glyph well: the sidebar's 22px rail, not an 18px box. The glyphs
 * themselves use the Iconic set's standard 22px step. The rail is what puts
 * every settings label on the same left edge as every sidebar title, and it
 * centres each mark on that column.
 */
export const SETTINGS_NAV_ICON = sx(sidebarStyles.rail, styles.navIcon);

/**
 * The phone sheet's root list: a caption over each group, the group's plate
 * (SettingCard's surface, from ui/settings), and the rows on it. The account
 * card at the bottom of the list is the same object, so it takes the same
 * strings.
 */
export const SETTINGS_SHEET_CAPTION = sx(styles.sheetCaption);

/**
 * A row on the plate. Its rule is inset past the glyph and stops on the last
 * row: an `::after` that depends on the row's place among its siblings, so it
 * stays a utility string.
 */
export const SETTINGS_SHEET_ROW = cn(
  sx(styles.sheetRow),
  "after:absolute after:bottom-0 after:left-[54px] after:right-0 after:h-px after:bg-divider-soft after:content-[''] last:after:hidden",
);
export const SETTINGS_SHEET_GLYPH = sx(styles.sheetGlyph);
export const SETTINGS_SHEET_LABEL = cn(TITLE_HOOK, sx(styles.sheetLabel));
export const SETTINGS_SHEET_HINT = sx(styles.sheetHint);
// `selectable`: the message was `text-supporting`, which base-global.css
// leaves selectable.
export const SETTINGS_SHEET_EMPTY = cn(SELECTABLE, sx(styles.sheetEmpty));

/**
 * The desktop nav's account block: sticky at the bottom of the column, on the
 * nav's own surface. Its 6px gutter is the list's outdent spelled forwards,
 * so the account row and Sign out sit on the same rail as the sections.
 */
export const SETTINGS_ACCOUNT_FOOTER = sx(styles.accountFooter);
export const SETTINGS_ACCOUNT_ROW = sx(
  styles.accountRow,
  sidebarStyles.railGap,
);
export const SETTINGS_ACCOUNT_SWITCH = sx(
  styles.accountRow,
  sidebarStyles.railGap,
  styles.accountSwitch,
  sidebarStyles.hoverLayer,
);
