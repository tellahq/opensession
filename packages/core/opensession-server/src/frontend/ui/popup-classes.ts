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
export const FLOATING_OVERLAY_LAYER = "z-[2147483647]";

/** The floating surface itself. `overflow-hidden` keeps the inner scrollbar's
 *  ends clipped to the rounded corner instead of poking past it; the
 *  transition rides Base UI's lifecycle attributes, so exit animates too. */
export const popupSurfaceClasses =
	"min-w-[180px] overflow-hidden rounded-popup [corner-shape:squircle] bg-popup-glass [backdrop-filter:var(--popup-blur)] [--smooth-ring-color:var(--popup-ring)] smooth-shadow-ring-md outline-none origin-[var(--transform-origin)] transition-[transform,opacity] duration-[120ms] ease-out data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0";

/** The scroller inside the surface: a long list scrolls, the padding stays. */
export const popupScrollClasses =
	"max-h-[min(60vh,420px,var(--available-height))] overflow-y-auto overflow-x-hidden overscroll-contain p-2";

/** One row. Highlight via Base UI's `data-highlighted` so keyboard navigation
 *  lights rows up the same way the pointer does. */
export const popupItemClasses =
	"flex w-full cursor-pointer select-none items-center gap-2 rounded-[calc(8px*var(--rf))] px-2 py-1.5 text-left text-control-label text-fg no-underline outline-none data-[highlighted]:bg-hover";
