/**
 * The Databases page. Its list column is the Reports column: the same paper,
 * the same title bar, the same two-line rows on the app's rail, because the
 * two pages are the same shape (an index down the left, the thing itself on
 * the right) and a person moving between them should not have to notice a
 * change of grammar. The REPORTS_* strings are imported as they are rather
 * than renamed, so the Reports page is untouched by this one existing.
 *
 * What is local is the detail pane: the toolbar under the header, the
 * meta line, the query editor and the pager, none of which Reports has.
 */

export {
  REPORTS_COLUMN as DATABASES_COLUMN,
  REPORTS_COLUMN_COUNT as DATABASES_COLUMN_COUNT,
  REPORTS_COLUMN_HEADER as DATABASES_COLUMN_HEADER,
  REPORTS_COLUMN_TITLE as DATABASES_COLUMN_TITLE,
  REPORTS_LIST as DATABASES_LIST,
  REPORTS_ROW as DATABASES_ROW,
  REPORTS_ROW_HEAD as DATABASES_ROW_HEAD,
  REPORTS_ROW_LATEST as DATABASES_ROW_DETAIL,
  REPORTS_ROW_NAME as DATABASES_ROW_NAME,
  REPORTS_ROW_TIME as DATABASES_ROW_TIME,
} from "./reports-classes";

/**
 * The strip under the detail header: the table picker or the query editor
 * on the left, the actions that act on what is shown on the right. One row
 * on desktop; on a phone it wraps, and every control in it is a 44px target.
 */
export const DATABASES_TOOLBAR =
  "flex shrink-0 flex-wrap items-center gap-2 border-b border-divider bg-surface px-4 py-2 phone:px-3";

/** What the database says about itself under its name: description, then
 *  provenance. Two lines at most; the schema is the picker beside it. */
export const DATABASES_META =
  "shrink-0 px-4 pt-3 pb-1 text-label leading-5 text-dim phone:px-3";

export const DATABASES_META_LINE = "m-0 truncate text-meta text-faint";

/**
 * The pager at the bottom of a rows view: a count on the left, previous and
 * next on the right. Sits on the surface, above the grid's scroller, so it
 * holds still while the rows travel.
 */
export const DATABASES_PAGER =
  // The extra right padding on desktop clears the app's floating desk
  // button, which sits over the bottom-right corner of every page.
  "flex shrink-0 items-center justify-between gap-3 border-t border-divider bg-surface px-4 py-1.5 text-meta tabular-nums text-faint phone:px-3 desktop:pr-20";

/** The query editor: a monospace well that grows with the statement. */
export const DATABASES_QUERY_EDITOR =
  "min-h-[88px] w-full font-mono text-[13px] leading-5 phone:text-input-phone";
