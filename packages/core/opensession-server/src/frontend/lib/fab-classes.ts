import { utilityClassName } from "../ui/cn";
/**
 * The two floating action buttons — what used to be `mobile-fab` and
 * `desk-fab` in legacy.css.
 *
 * They are a pair, and the numbers only make sense read together: on a phone
 * the new-session + sits 12px from the right edge at 58px across, and the Desk
 * trigger sits one 12px gutter further in — which is why its phone `right` is
 * still spelled `calc(12px + 58px + 12px)` rather than the 82px it resolves
 * to. Both ride z-500: above the content, below the action sheet (4000) and
 * the palettes (6000).
 *
 * Every phone value is a `phone:` variant rather than an unprefixed base with
 * a `desktop:` undo. The Desk FAB genuinely has two looks (a quiet 44px
 * outline on desktop, a 58px shadowed twin of the + on phones) and the
 * new-session + does not exist above the breakpoint at all, so writing the
 * phone look as the base would leave desktop reading values it never had.
 *
 * `rounded-full` is deliberate on both, and is the one radius spelling that
 * opts OUT of the app's squircle: these were authored as a bare
 * `border-radius: 50%`, i.e. a true circle, not a scaled corner. Anything in
 * the chrome that squircles wants `rounded-[999px]` instead.
 */

/**
 * Phones only: the new-session + in the thumb corner of the root list.
 * App.tsx already gates it on `!mobileDetail`; `hidden` covers desktop, where
 * the sidebar's own + does the job.
 *
 * The shadow is deliberately shallower than the ambient-occlusion stack a
 * material FAB carries: this button is solid ink on a near-white page, so a
 * 20px/0.3 spread read as a smudge under it rather than as lift. iOS floats
 * controls on a tight contact shadow plus a short soft one, which is what these
 * two layers are — and the same pair, lightened for an outlined white surface,
 * is what the Desk trigger beside it now uses.
 */
export const MOBILE_FAB =
  utilityClassName(
    "hidden phone:fixed phone:right-3 phone:bottom-[calc(18px+env(safe-area-inset-bottom,0px))] ",
  ) +
  utilityClassName(
    "phone:z-500 phone:flex phone:size-[58px] phone:items-center phone:justify-center ",
  ) +
  utilityClassName(
    "phone:rounded-full phone:border-none phone:bg-accent phone:text-on-accent ",
  ) +
  "phone:shadow-[0_4px_14px_rgba(0,0,0,0.16),0_1px_3px_rgba(0,0,0,0.10)] " +
  utilityClassName("phone:transition-transform phone:active:scale-[0.92]");

/**
 * The ⌘J Desk trigger. Desktop uses the same resting shadow and border as the
 * Next button, then lifts a pixel and warms the glyph on hover. Phones cancel
 * the lift (there is no pointer to lift under) and swap it for the same press
 * tick the + uses. `transition` lists the properties the states actually move.
 * `scale` and `translate` are their own properties in Tailwind v4, so a bare
 * `transform` in the list would animate neither.
 *
 * On phones it keeps its border, so it needs less shadow than the + to sit off
 * the page. A matched pair of deep shadows made the two read as one heavy
 * slab. This is the desktop shadow's weight, spread for the bigger circle.
 *
 * It takes the composer's surface pair rather than --bg-panel for the same
 * reason the composer does: the ramp steps away from the page, so a panel fill
 * put a grey disc on a white page, like a hole rather than a lifted control.
 * White with a firmer edge (--composer-border, not --border) is how a raised
 * surface behaves in light. In dark the pair resolves to --control-surface,
 * which is lighter than the page and lifts on its own.
 *
 * On desktop, useDeskFabPosition supplies `left` and `bottom` while a composer
 * is visible. It keeps this corner position while there is room and moves the
 * trigger directly above the composer when the pane reaches the viewport edge.
 * The default declarations below cover pages without a composer and browsers
 * before the first measurement. Phones override them with the paired FAB
 * layout from the right edge.
 */
export const DESK_FAB =
  utilityClassName(
    "fixed right-[18px] bottom-[18px] z-500 flex size-11 items-center justify-center ",
  ) +
  utilityClassName(
    "rounded-full border border-divider bg-[var(--composer-surface)] text-dim ",
  ) +
  utilityClassName("smooth-shadow-xs ") +
  utilityClassName(
    "transition-[color,border-color,translate,scale] hover:-translate-y-px hover:border-line hover:text-fg ",
  ) +
  utilityClassName("phone:left-auto ") +
  utilityClassName(
    "phone:right-[calc(12px+58px+12px)] phone:bottom-[calc(18px+env(safe-area-inset-bottom,0px))] ",
  ) +
  utilityClassName("phone:size-[58px] phone:text-fg ") +
  "phone:shadow-[0_2px_10px_rgba(0,0,0,0.10),0_1px_2px_rgba(0,0,0,0.06)] " +
  utilityClassName("phone:hover:translate-y-0 phone:active:scale-[0.92]");
