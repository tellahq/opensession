import * as stylex from "@stylexjs/stylex";
import { popup } from "./popup-styles";

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
export const FLOATING_OVERLAY_LAYER = stylex.props(popup.layer).className ?? "";

/** The surface, scroller and row as class strings, for the popups that
 *  assemble different Base UI parts around them. The look is `popup` in
 *  `ui/popup-styles.ts`. */
export const popupSurfaceClasses = stylex.props(popup.surface).className ?? "";
export const popupScrollClasses = stylex.props(popup.scroll).className ?? "";
export const popupItemClasses = stylex.props(popup.item).className ?? "";
