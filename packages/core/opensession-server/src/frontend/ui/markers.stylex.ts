import * as stylex from "@stylexjs/stylex";

/**
 * Named markers for `stylex.when.ancestor(...)`: a child styled off its own
 * control's hover or state, rather than off any ancestor that happens to carry
 * StyleX's shared default marker.
 */
export const tabMarker = stylex.defineMarker();
export const disclosureMarker = stylex.defineMarker();
export const deviceCodeMarker = stylex.defineMarker();
/** The preview an `OverlayAction` sits over: hovering it reveals the action. */
export const overlayActionMarker = stylex.defineMarker();
/** The tappable session title pill: its name dims while the pill is pressed. */
export const titlePillMarker = stylex.defineMarker();
/** A settings nav row: its glyph lights up with the row's hover and state. */
export const settingsNavRowMarker = stylex.defineMarker();
/** A sidebar group heading: its chevron shows with the heading's hover. */
export const sidebarHeaderMarker = stylex.defineMarker();
/** A sidebar row: its title, chips, time and facepile read its hover and its
 *  `data-selected` / `data-waiting` / `data-unread` state through this. */
export const sidebarRowMarker = stylex.defineMarker();
