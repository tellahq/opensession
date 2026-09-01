import { utilityClassName } from "../ui/cn";
/**
 * The pull request list's geometry.
 *
 * Deliberately the archived list's idiom (lib/archived-classes.ts): one
 * page-wide list rather than a bordered card, inset hairlines carrying the
 * structure, and a rounded hover wash that the separators clear out of the way
 * for. This page lists the same kind of thing those pages do — a session's
 * work, one row at a time — so it should not invent a second row look.
 */

/** The shared page column. The pull-request top bar uses the same width so its
 *  title and trailing controls align with the list below. */
export const PR_PAGE_COLUMN = utilityClassName(
  "mx-auto w-full max-w-[920px] px-6",
);

/** Labels and row contents share the page's content edge; the list itself runs
 *  12px past it so a hovered row's wash has room to breathe. */
export const PR_LIST = utilityClassName("-mx-3");

/** The state a block of rows is in: Open, Merged, Closed. Sized as the heading
 *  it is. A state owns hundreds of rows across several date groups, and at the
 *  13px interface step it read as one more label in a stack of labels rather
 *  than as the thing they all hang under.
 *
 *  Weight is the page title's, not a step above it. This label and `PageTitle`
 *  sit at the same 19px, so a heavier state heading reads as the page's real
 *  title and pushes "Pull requests" into looking like a caption over it. */
export const PR_SECTION_LABEL = utilityClassName(
  "m-0 mb-3.5 flex items-baseline gap-2 px-3 text-section-title font-title tracking-[-0.01em] text-fg",
);

/** A date group: the same quiet label the archived list gives its own. The
 *  `px-3` pays back the list's outdent, so every label on the page and the row
 *  content under it share one x. */
const GROUP_LABEL = utilityClassName(
  "m-0 flex items-baseline gap-2 px-3 font-semibold text-faint",
);

/** A date belongs to the rows under it rather than to the state above it, so it
 *  stays on the content edge with them and sits tight to them: the air goes
 *  above it, under the state heading. Size is what separates the two, not an
 *  indent. */
export const PR_GROUP_LABEL = utilityClassName(
  `${GROUP_LABEL} pb-1.5 text-meta`,
);

/** The same label in the feed, one step up the scale. The feed is grouped by
 *  day and nothing else, so the day is the heading a reader navigates by; on
 *  the pull request list a date sits under Open or Merged, which is the heading
 *  there, and stays the quieter of the two. */
export const PR_FEED_GROUP_LABEL = utilityClassName(
  `${GROUP_LABEL} pb-2 text-label`,
);

/**
 * A pull request row.
 *
 * `relative` is for the separator: the row's own `::after`, inset past the
 * state glyph and the tile so it starts at the title, and gone on the last row.
 * It also clears out around the highlight — the hovered row hides its own and
 * `:has(+ button:hover)` hides the one above it — so a lit row reads as a clean
 * slab instead of a strip with a line cutting its corner.
 */
/**
 * The same row, in the People page's shipped feed.
 *
 * One column narrower: everything in the feed has merged, so the state glyph
 * would be the same mark on every line. The face takes its place, because who
 * shipped it is the one thing the feed is sorted around.
 */
/**
 * Both rows are one line now, and a one-line row wants more padding than a
 * two-line one did: `py-2.5` was set when a branch or a repo name sat under
 * every title, and once that went the rows read as a tighter list than the
 * rest of the app. `py-3` puts a row at the 44px the sidebar and the settings
 * rows already stand at. The column gap goes up with it, so the separator
 * offsets below are `px-3` plus the leading columns plus `gap-2.5`.
 */
export const PR_FEED_ROW =
  utilityClassName(
    "group focus-ring relative grid w-full grid-cols-[24px_minmax(0,1fr)_130px_44px] ",
  ) +
  utilityClassName(
    "cursor-pointer items-center gap-2.5 rounded-control border-0 bg-transparent px-3 py-3 ",
  ) +
  utilityClassName(
    "text-left transition-colors duration-[var(--dur-micro)] ease-[var(--ease)] hover:bg-hover ",
  ) +
  utilityClassName(
    "after:pointer-events-none after:absolute after:right-3 after:bottom-0 after:left-[46px] ",
  ) +
  utilityClassName(
    "after:h-px after:bg-line after:transition-opacity after:duration-[var(--dur-micro)] ",
  ) +
  utilityClassName("last:after:opacity-0 hover:after:opacity-0 ") +
  "[&:has(+button:hover)]:after:opacity-0 " +
  utilityClassName("phone:grid-cols-[24px_minmax(0,1fr)_44px]");

export const PR_ROW =
  utilityClassName(
    "group focus-ring relative grid w-full grid-cols-[22px_24px_minmax(0,1fr)_130px_44px] ",
  ) +
  utilityClassName(
    "cursor-pointer items-center gap-2.5 rounded-control border-0 bg-transparent px-3 py-3 ",
  ) +
  utilityClassName(
    "text-left transition-colors duration-[var(--dur-micro)] ease-[var(--ease)] hover:bg-hover ",
  ) +
  utilityClassName(
    "after:pointer-events-none after:absolute after:right-3 after:bottom-0 after:left-[78px] ",
  ) +
  utilityClassName(
    "after:h-px after:bg-line after:transition-opacity after:duration-[var(--dur-micro)] ",
  ) +
  utilityClassName("last:after:opacity-0 hover:after:opacity-0 ") +
  "[&:has(+button:hover)]:after:opacity-0 " +
  utilityClassName("phone:grid-cols-[22px_24px_minmax(0,1fr)_44px]");
