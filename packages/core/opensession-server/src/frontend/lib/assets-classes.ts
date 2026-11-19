/**
 * The Assets tab's file column. It is the Reports column's grammar (see
 * lib/reports-classes): paper beside the preview, a title bar, two-line rows
 * on the app's rail with the shared hover layer and `bg-selected` for the open
 * file, so the folder reads as part of the app rather than as an embedded
 * file browser. It used to be one, a third-party tree with its own icon set,
 * type size and focus ring, which is what made the tab look borrowed.
 *
 * Local here: the leading file-kind glyph and the folder captions, because an
 * index of reports has neither.
 */

import { SIDEBAR_HOVER_LAYER, SIDEBAR_RAIL_GAP } from "./sidebar-classes";

/** The column at desktop width. Phones fold the list into a row instead. */
export const ASSETS_COLUMN =
  "flex w-[300px] shrink-0 flex-col border-r border-divider";

/** The column's title bar: "Files", the count, and Refresh. */
export const ASSETS_COLUMN_HEADER =
  "flex h-[var(--desktop-header-h)] shrink-0 items-center gap-2 pr-2 pl-4";

export const ASSETS_COLUMN_TITLE = "m-0 text-item-title font-semibold text-fg";

export const ASSETS_COLUMN_COUNT =
  "text-meta font-medium tabular-nums text-faint";

/**
 * The scroller, outdented the way REPORTS_LIST is so a row's pill runs past
 * the content edge while its text stays on the title's x.
 */
export const ASSETS_LIST =
  "min-h-0 flex-1 overflow-y-auto px-1.5 pb-3 " +
  "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/**
 * A folder's caption over its files. Not a control: the folder set is small
 * and always shown whole, so there is nothing to collapse. The glyph sits in
 * the rail its rows' glyphs sit in.
 */
export const ASSETS_FOLDER =
  `flex items-center ${SIDEBAR_RAIL_GAP} px-2.5 pt-4 pb-1 ` +
  "text-label font-medium text-faint";

export const ASSETS_FOLDER_NAME = "min-w-0 truncate";

/**
 * A file. Two lines, like a report row: the name, then what the agent said it
 * is (or its size when it said nothing). Phones give it a 44px target.
 */
export const ASSETS_ROW =
  "group focus-ring mt-0.5 flex w-full cursor-pointer items-start rounded-row " +
  "border-0 bg-transparent py-2 pr-3 pl-2.5 text-left data-active:bg-selected " +
  `phone:min-h-11 ${SIDEBAR_RAIL_GAP} ${SIDEBAR_HOVER_LAYER}`;

/** The file-kind glyph, on the row's first line. */
export const ASSETS_ROW_ICON =
  "mt-px shrink-0 text-faint group-hover:text-dim group-data-active:text-dim";

export const ASSETS_ROW_BODY = "flex min-w-0 flex-1 flex-col";

/** The name has the first line to itself: asset names run long
 *  (`new-timeline-enhancement-mock.html`), and a time beside it cut them. */
export const ASSETS_ROW_NAME =
  "truncate text-item-title font-medium text-dim " +
  "group-hover:text-fg group-data-active:text-fg";

/** The second line: what it is, then when it landed. */
export const ASSETS_ROW_META = "mt-0.5 flex min-w-0 items-baseline gap-2";

export const ASSETS_ROW_DETAIL =
  "min-w-0 flex-1 truncate text-label text-faint group-data-active:text-dim";

export const ASSETS_ROW_TIME =
  "shrink-0 text-right text-meta tabular-nums text-faint";
