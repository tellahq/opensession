import { utilityClassName } from "../ui/cn";
/**
 * The Reports page's list column: the automations down the left, and the
 * header band that column shares with the report beside it.
 *
 * The column used to be the odd surface in the app. It painted `bg-panel`
 * (#f0f0f0) inside DETAIL_PANE, which is already white paper (see
 * app-shell-classes: WORKSPACE_SHELL declares "paper starts here" with a seam
 * and a shadow), so one window read chrome, seam, chrome, paper, and the least
 * important column was the heaviest thing on screen. It is paper now, and a
 * hairline is the only thing between the two. What separates them is the
 * density difference between a list of rows and a document, which is how Mail
 * and Linear separate the same two panes.
 *
 * The rows are the app's own row grammar rather than a second one invented
 * here: the 22px leading rail, its 7px gap, the hover LAYER and the
 * translucent `bg-selected` all come from lib/sidebar-classes, so a report row
 * on this page and the one in the sidebar (components/sidebar/
 * AutomationReportRow) sit on the same left edge and light up the same way.
 * Only the two-line box is local, because a sidebar row is one line.
 *
 * Everything is written as complete literals, and nothing here re-states a
 * property another string in the same `className` already sets. Two utilities
 * for one property are settled by Tailwind's output order rather than by the
 * order they are written, so the time badge below spells its own box instead
 * of appending an override to SIDEBAR_WS_TIME.
 */

import { SIDEBAR_HOVER_LAYER, SIDEBAR_RAIL_GAP } from "./sidebar-classes";

/**
 * The column. Paper, like the pane it sits in, separated by the chrome seam
 * token. Not `border-line`, which it had: that is the token for the edge of a
 * control, and it is part of why the column read as a form field.
 *
 * Phones render this same element as the whole page (the report is a separate
 * pushed page there), so both widths are variants rather than a branch in the
 * component.
 */
export const REPORTS_COLUMN =
  utilityClassName("flex min-h-0 flex-col ") +
  utilityClassName("phone:w-full phone:flex-1 ") +
  utilityClassName(
    "desktop:w-[300px] desktop:shrink-0 desktop:border-r desktop:border-divider",
  );

/**
 * The column's heading, at both widths: a title bar, not a label over a list.
 * It names the page, which nothing else does on this route (App.tsx leaves the
 * top bar empty here), and its right side is a slot for what acts on the whole
 * list.
 *
 * It sits ABOVE the scroller rather than inside it, so it is fixed by
 * construction and the rows disappear under it as they travel. That is the
 * whole reason it is a sibling. Inside the list it could only be as wide as
 * the list's content box, which left the rows showing past both of its ends
 * and read as a label that had been left behind rather than as a bar.
 *
 * `--desktop-header-h` is the app's own bar height, the one DETAIL_TOPBAR_TITLE
 * takes, and the chat header, and the sidebar's brand row. Taking it lines this
 * bar up with them across the top of the window and gives the title its air
 * from a number the app already agrees on rather than from a guess. Desktop
 * keeps its pane divider. On a phone this is the full page surface, so a rule
 * underneath it only cuts the page into two grey bands.
 */
export const REPORTS_COLUMN_HEADER =
  // `wco-chrome`: a row across the top of a pane is where the desktop shell
  // expects to drag the window from, and base.css hangs that off this one name.
  utilityClassName(
    "wco-chrome flex h-[var(--desktop-header-h)] shrink-0 items-center gap-2 ",
  ) +
  utilityClassName("bg-surface px-4 desktop:border-b desktop:border-divider");

/**
 * What the column can say about itself, on the heading's right. `text-meta` is
 * the step the scale reserves for a count, and `tabular-nums` keeps it from
 * shifting width as reports land.
 */
export const REPORTS_COLUMN_COUNT = utilityClassName(
  "ml-auto shrink-0 text-meta font-medium tabular-nums text-faint",
);

/**
 * The heading itself, set the way the app sets every other title in a bar:
 * `text-item-title` semibold, which is what DETAIL_TOPBAR_TITLE gives a page
 * and what VIEWER_BRANCH gives the chat beside it. It was the 22px page-title
 * step, the right name for what this is and the wrong size for where it sits.
 * A whole workspace is named at 14px in the bar above a chat, so a 300px
 * column announcing itself half again as large read as a poster.
 *
 * Not one value at both widths, though it was for an hour: the rows under it
 * step up to 16px on a phone, so a heading held at 14 came out SMALLER than
 * every row it titles. Whatever the desktop argument, a title cannot be the
 * smallest thing in its own column. The phone takes the section step, which
 * clears its rows and stops short of the 22px this used to be. No tracking
 * override either. The scale sets it, and a third heading style is what this
 * was trying to stop being.
 */
export const REPORTS_COLUMN_TITLE = utilityClassName(
  "m-0 text-item-title font-semibold text-fg phone:text-section-title",
);

/**
 * The scrolling list, outdented past the column's gutter so a row's pill
 * overflows the content edge, Conductor-style. SETTINGS_NAV_LIST and
 * SIDEBAR_LIST make the same move, and it is what lands the row content on the
 * app's 16px rail (6px of outdent plus the row's own 10px).
 *
 * Its scrollbar is hidden for the reason the app's sidebar and the settings
 * nav hide theirs: a track down the middle of the window cuts the list off
 * from the report it indexes. Overlay scrollbars make this invisible on a Mac
 * either way; it is the classic-scrollbar platforms this is for.
 *
 * The top padding is the gap under the title bar above it, which is a
 * sibling rather than the first thing in here: the rows have to be able to
 * travel past the top of this box and out of sight under that bar.
 */
export const REPORTS_LIST =
  utilityClassName("min-h-0 flex-1 overflow-y-auto px-1.5 pt-3 pb-3 ") +
  utilityClassName("[scrollbar-width:none] [&::-webkit-scrollbar]:hidden");

/**
 * A row: an automation, with the headline of its latest report under it.
 *
 * Two lines, so it sets its own vertical padding instead of taking the
 * sidebar's one-line `--sidebar-row-pad`, and it takes a good deal more of it
 * than a sidebar row does. This column is an index of twenty automations that
 * you read once and then leave, not a rail of fifty sessions you live in, so
 * it is paced for reading rather than for fitting. Everything else is shared:
 * the row corner, the 7px rail gap, the hover layer, and `bg-selected` for the
 * open one. Selected was `bg-active`, an opaque surface from the top of the
 * elevation ramp, which put a grey plate on the row you are already reading.
 * SETTINGS_NAV_ROW's doc has the longer version of that argument.
 */
export const REPORTS_ROW =
  utilityClassName(
    "group mt-1.5 flex w-full cursor-pointer items-start rounded-row border-0 ",
  ) +
  utilityClassName(
    "bg-transparent py-3.5 pr-3 pl-2.5 text-left data-active:bg-selected ",
  ) +
  `${SIDEBAR_RAIL_GAP} ${SIDEBAR_HOVER_LAYER}`;

/** The name and the time share the row's first line. */
export const REPORTS_ROW_HEAD = utilityClassName(
  "flex min-w-0 items-baseline gap-2",
);

export const REPORTS_ROW_NAME =
  utilityClassName(
    "min-w-0 flex-1 truncate text-item-title font-medium text-dim ",
  ) +
  utilityClassName(
    "group-hover:text-fg group-data-active:text-fg phone:text-[16px]",
  );

/**
 * The latest report's title, faint under a dim name so the row reads its name
 * first. Both step up one when the row is the open one.
 */
export const REPORTS_ROW_LATEST =
  utilityClassName("mt-1 block truncate text-label text-faint ") +
  utilityClassName("group-data-active:text-dim phone:text-[14px]");

/**
 * When it landed. SIDEBAR_WS_TIME's box without the gutter that string
 * reserves for the sidebar's pin/archive cluster: these rows have no hover
 * actions, so the digits sit on the row's own right padding.
 */
export const REPORTS_ROW_TIME = utilityClassName(
  "shrink-0 text-right text-meta tabular-nums text-faint",
);
