/**
 * The notification inbox: the bell's popover on desktop and the Inbox page at
 * both widths (components/notifications/). Rows follow the Archived list
 * (lib/archived-classes.ts): an open-button stretched over the whole row, a
 * hairline separator, hover actions on desktop and a labelled swipe action on
 * phones.
 */

/** The popover. Wide enough for a title and a reason line side by side. */
export const INBOX_POPUP =
  "flex max-h-[min(640px,calc(100vh-96px))] w-[420px] flex-col overflow-hidden";

export const INBOX_POPUP_HEADER =
  "flex shrink-0 items-center gap-2 px-4 pt-3.5 pb-2.5";

export const INBOX_POPUP_TITLE =
  "mr-auto text-control-label font-semibold text-fg";

export const INBOX_POPUP_LIST = "min-h-0 flex-1 overflow-y-auto px-1 pb-1.5";

export const INBOX_POPUP_FOOTER =
  "flex shrink-0 items-center justify-between gap-2 border-t border-line px-3 py-2";

/** The page's list reaches past the content edge so the hover wash can
 *  breathe, as Archived's does; rows put their text back on the edge. */
export const INBOX_PAGE_LIST = "-mx-3";

export const INBOX_LIST = "m-0 list-none p-0";

/** Swipe frame: the actions sit behind the row's opaque surface. */
export const INBOX_SWIPE_ROW = "relative overflow-hidden rounded-control";

const INBOX_SWIPE_ACTION_BASE =
  "absolute inset-y-0 hidden items-center justify-center gap-1.5 border-none px-3 " +
  "text-label font-semibold opacity-0 data-[open]:opacity-100 " +
  "phone:flex phone:min-h-11 phone:touch-manipulation phone:[&_svg]:shrink-0";

/** Revealed by swiping right: read or unread. */
export const INBOX_SWIPE_READ = `${INBOX_SWIPE_ACTION_BASE} left-0 w-[var(--swipe-read-w,0px)] bg-accent text-on-accent`;

/** Revealed by swiping left: done. */
export const INBOX_SWIPE_DONE = `${INBOX_SWIPE_ACTION_BASE} right-0 w-[var(--swipe-done-w,0px)] bg-green text-on-accent`;

/**
 * A row. Its content edge lines up with the heading above the list; the
 * unread dot rides at the other end, beside the time.
 */
export const INBOX_ROW =
  "group relative flex items-start gap-3 rounded-control py-2.5 pr-3 pl-3 " +
  "transition-[color,background-color,transform] duration-micro ease-standard " +
  "hover:bg-hover focus-within:bg-hover " +
  "after:pointer-events-none after:absolute after:right-3 after:bottom-0 after:left-12 " +
  "after:h-px after:bg-line after:transition-opacity after:duration-micro " +
  "hover:after:opacity-0 focus-within:after:opacity-0 " +
  "phone:z-1 phone:touch-pan-y phone:bg-surface phone:py-3.5 phone:pr-3.5 phone:pl-3.5 " +
  "phone:transform-[translateX(var(--swipe-x,0))] phone:after:left-[50px]";

/** The last row, and the row above a lit one, drop their separator. */
export const INBOX_ROW_ITEM =
  "last:[&_.inbox-row]:after:opacity-0 [&:has(+li:hover)_.inbox-row]:after:opacity-0 " +
  "[&:has(+li:focus-within)_.inbox-row]:after:opacity-0";

/** Beside the time, as GitHub's inbox has it, so the content edge is free. */
export const INBOX_UNREAD_DOT = "size-2 shrink-0 rounded-full bg-accent";

export const INBOX_KIND_ICON =
  "mt-0.5 flex size-6 shrink-0 items-center justify-center [&_svg]:size-5";

/** Stretched over the row, so a click anywhere opens the notification. */
export const INBOX_ROW_OPEN =
  "focus-ring min-w-0 flex-1 cursor-pointer rounded-sm border-none bg-transparent p-0 " +
  "text-left after:absolute after:inset-0 after:content-['']";

export const INBOX_ROW_CONTEXT =
  "flex min-w-0 items-center gap-1.5 text-meta text-faint";

export const INBOX_ROW_TITLE =
  "mt-0.5 block min-w-0 truncate text-item-title text-dim group-data-[unread]:font-semibold group-data-[unread]:text-fg";

export const INBOX_ROW_REASON =
  "mt-0.5 block min-w-0 truncate text-supporting text-dim";

/** Desktop actions replace the timestamp on hover or keyboard focus. */
export const INBOX_ROW_ACTIONS =
  "absolute top-1.5 right-2 z-1 flex items-center gap-0.5 opacity-0 transition-opacity " +
  "duration-micro ease-standard group-hover:opacity-100 " +
  "group-focus-within:opacity-100 phone:hidden";

export const INBOX_ROW_TIME =
  "ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-meta tabular-nums text-faint transition-opacity " +
  "duration-micro group-hover:opacity-0 group-focus-within:opacity-0 " +
  "phone:group-hover:opacity-100 phone:group-focus-within:opacity-100";

/** The count on the bell. */
export const INBOX_BADGE =
  "pointer-events-none absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center " +
  "rounded-[999px] bg-accent px-1 text-meta font-semibold leading-none text-on-accent tabular-nums " +
  "phone:top-0.5 phone:right-1.5 phone:h-[18px] phone:min-w-[18px] " +
  "ring-2 ring-[var(--bg)]";

/** The desktop bell, sized with its chrome-row neighbours. */
export const INBOX_BELL =
  "relative inline-flex size-[30px] cursor-pointer items-center justify-center rounded-md border-none " +
  "bg-transparent p-0 text-dim hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg " +
  "[-webkit-app-region:no-drag] [app-region:no-drag]";
