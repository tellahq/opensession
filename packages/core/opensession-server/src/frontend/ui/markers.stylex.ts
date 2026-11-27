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
