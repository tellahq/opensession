/**
 * The Feed page's scope row: the team and its organizations, as chips.
 *
 * They were cards in a grid when this page was called People and the roster
 * was the point. The feed is the point now, so the roster shrinks to what it
 * always was in practice — a row you pick from — and gets out of the way of
 * the thing you came to read.
 */

/** The row itself. It wraps rather than scrolling sideways: a hidden teammate
 *  is a teammate you never pick, and there are not enough of them to justify
 *  a scroll affordance. */
export const PEOPLE_CHIP_ROW = "mb-6 flex flex-wrap items-center gap-1.5";

/** One scope: everyone, a person, or an organization. */
export const PEOPLE_CHIP =
  "focus-ring inline-flex min-w-0 cursor-pointer items-center gap-2 rounded-capsule " +
  "border-0 bg-panel py-1 pr-3 pl-1 text-control-label font-medium text-dim " +
  "transition-colors duration-micro ease-standard " +
  "hover:bg-hover hover:text-fg";

/** The scope the feed is on. A wash the strength of a hover state read as one
 *  more chip you happened to be pointing at, on a row where the pick also
 *  decides what the sidebar holds. It takes the accent plate instead, which is
 *  the same mark the rest of the app puts on a chosen thing. */
export const PEOPLE_CHIP_SELECTED =
  "bg-accent font-semibold text-on-accent hover:bg-accent-hover hover:text-on-accent";

/** The glyph slot in a chip that has no face of its own (Everyone). */
export const PEOPLE_CHIP_GLYPH =
  "flex size-[26px] shrink-0 items-center justify-center rounded-avatar bg-hover text-dim";

/** The same slot on the accent plate: the wash is ink, which disappears into a
 *  dark fill, so it inverts with the chip. */
export const PEOPLE_CHIP_GLYPH_SELECTED =
  "bg-[color-mix(in_srgb,var(--on-accent)_22%,transparent)] text-on-accent";

/** "Shipped" and any other heading on the page. A step above the interface
 *  label it started as: it heads the whole list under it, so it reads as a
 *  heading rather than as the caption on a control. */
export const PEOPLE_SECTION_LABEL = "m-0 mb-2 text-body font-semibold text-fg";
