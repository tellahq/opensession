/**
 * A plain list rather than a bordered card. At 200 rows an outer border is a
 * box around the page itself; inset row separators carry the useful structure.
 */
export const ARCHIVED_LIST = "-mx-3";

/**
 * Phone Search lives at the thumb edge instead of spending permanent room
 * under the navigation bar. The fade keeps rows legible as they pass behind
 * the floating field without drawing a hard toolbar divider.
 */
export const ARCHIVED_PHONE_SEARCH_DOCK =
  "pointer-events-none fixed inset-x-0 bottom-0 z-30 hidden px-3.5 pt-6 " +
  "pb-[max(12px,env(safe-area-inset-bottom,0px))] phone:block " +
  "phone:[body.kb-open_&]:pb-3 " +
  "before:pointer-events-none before:absolute before:inset-0 before:-z-[1] " +
  "before:bg-[linear-gradient(to_bottom,transparent_0%,var(--bg)_48%)] " +
  "[&>input]:pointer-events-auto";

/** Section labels and row contents share the page's content edge. The list
 * itself extends 12px beyond it so the hover wash has room to breathe. */
export const ARCHIVED_SECTION_LABEL =
  "m-0 px-3 pb-1.5 text-body font-semibold text-faint";

export const ARCHIVED_SECTION_ROWS = "m-0 list-none p-0";

/** Mobile swipe frame. The Restore action sits behind the opaque row surface. */
export const ARCHIVED_SWIPE_ROW =
  "relative overflow-hidden rounded-control [--swipe-action-w:0px] " +
  "last:[&>.archived-row]:after:opacity-0 " +
  "[&:has(+li:hover)>.archived-row]:after:opacity-0 " +
  "[&:has(+li:focus-within)>.archived-row]:after:opacity-0";

export const ARCHIVED_SWIPE_ACTION =
  "absolute inset-y-0 right-0 hidden w-[var(--swipe-action-w)] items-center justify-center gap-1.5 " +
  "border-none bg-accent px-3 text-label font-semibold text-on-accent opacity-0 " +
  "data-[open]:opacity-100 phone:flex phone:min-h-11 phone:touch-manipulation phone:[&_svg]:shrink-0";

/**
 * A row. `relative` positions three things: the separator below it, the
 * open-button's full-bleed overlay (see ROW_OPEN) and the action that has to
 * sit above that overlay.
 *
 * `focus-within:bg-hover` matters as much as the hover: with the whole row
 * clickable through an overlay, keyboard focus lands on a button whose visible
 * text is only the title — lighting the row is what says how far the target
 * reaches.
 *
 * The separator is the row's own `::after`, inset past the repo tile and gone
 * on the last row. It also clears out around the highlight: the
 * hovered row hides its own, and `:has(+ li:hover)` hides the one above it, so
 * a lit row is a clean slab rather than a strip with a line cutting its corner
 * — the same tidying an iOS list does around a highlighted cell.
 */
export const ARCHIVED_ROW =
  "archived-row group relative flex items-start gap-3 rounded-control px-3 py-2.5 " +
  "transition-[color,background-color,transform] duration-[var(--dur-micro)] ease-[var(--ease)] " +
  "hover:bg-hover focus-within:bg-hover " +
  "after:pointer-events-none after:absolute after:right-3 after:bottom-0 after:left-[42px] " +
  "after:h-px after:bg-line after:transition-opacity after:duration-[var(--dur-micro)] " +
  "hover:after:opacity-0 focus-within:after:opacity-0 " +
  "phone:z-[1] phone:gap-2.5 phone:touch-pan-y phone:bg-surface phone:px-[18px] phone:py-4 " +
  "phone:transform-[translateX(var(--swipe-x,0))] phone:after:left-[46px]";

/**
 * The open action, stretched over the whole row by its own `::after` so a click
 * anywhere opens the session — including on the repo tile and the timestamp,
 * which are not themselves interactive. The ring stays on the title (the thing
 * a reader is aiming at); the row's `focus-within` wash carries the rest.
 */
export const ARCHIVED_ROW_OPEN =
  "focus-ring min-w-0 flex-1 cursor-pointer rounded-sm border-none bg-transparent p-0 " +
  "text-left after:absolute after:inset-0 after:content-['']";

/** The title line: the name, then the origin chip trailing it. The chip sits
 *  here rather than on the meta line under the title so a row with nothing
 *  else to say stays one line tall. */
export const ARCHIVED_ROW_TITLE_ROW = "flex min-w-0 items-center gap-2";

export const ARCHIVED_ROW_TITLE =
  "block min-w-0 truncate text-label text-fg phone:text-body";

/** The line under the title, and only when it has something to say — see the
 *  meta rules in the component: a field the current filter already fixes is
 *  the same word on every row. */
export const ARCHIVED_ROW_META =
  "mt-1 flex min-w-0 items-center gap-2.5 text-meta text-faint";

/** The timestamp and disclosure affordance step aside for Restore on hover. */
export const ARCHIVED_ROW_TRAIL =
  "flex shrink-0 items-center gap-0.5 text-faint transition-opacity " +
  "duration-[var(--dur-micro)] ease-[var(--ease)] group-hover:opacity-0 " +
  "group-focus-within:opacity-0 phone:hidden";

export const ARCHIVED_ROW_TIME =
  "w-[62px] text-right text-meta leading-none tabular-nums";

/**
 * Desktop Restore replaces the timestamp on hover or keyboard focus. Phones
 * reveal the labelled swipe action instead, so every row stays visually quiet.
 */
export const ARCHIVED_ROW_ACTION =
  "absolute right-3 top-1.5 z-[1] opacity-0 transition-opacity " +
  "duration-[var(--dur-micro)] ease-[var(--ease)] group-hover:opacity-100 " +
  "focus-visible:opacity-100 phone:hidden";

/** The page column. The archive top bar uses the same width so its search,
 *  count, and filter align with the list below, the way Pull requests does. */
export const ARCHIVED_PAGE_COLUMN = "mx-auto w-full max-w-[860px] px-6";
