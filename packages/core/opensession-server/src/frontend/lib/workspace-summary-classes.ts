/**
 * The workspace summary: the session header's floating stand-in for the right
 * Workspace panel, and the smaller version of it.
 *
 * It is a list of quiet rows, not a dashboard. One glyph, one label, and a
 * value or an action parked at the right edge. Nothing inside it carries a
 * fill of its own: no plates, no cards, no boxed sections. On first sight it
 * is text on one surface, and the only paint that ever appears is the hover
 * pill under the pointer. That is what lets the labels do the work, and it is
 * why the one row that has something to report (a failing check, a diff's
 * +/−) is the only thing in the card with colour.
 *
 * Rows are full-width buttons rather than text with a link inside: the whole
 * row is the target, which is what makes a 300px card usable without aiming.
 *
 * The grammar is the left sidebar's, deliberately. A shared leading rail, a
 * band label over its own rows, and the same `rounded-row` pill under the
 * pointer. This is the sidebar's shape at the other edge of the window, so it
 * should not need learning twice.
 */

/**
 * The summary's complete surface treatment. Review's changed-file tree reuses
 * it so the two adjacent containers have the same glass, soft ring, and corner.
 */
export const WS_SUMMARY_SURFACE =
  "[--popup-glass:color-mix(in_srgb,var(--popup-surface)_58%,transparent)] " +
  "[--popup-blur:blur(32px)_saturate(1.6)_brightness(1.12)] " +
  "[--smooth-ring-color:color-mix(in_srgb,var(--popup-ring)_65%,var(--popup-surface))] " +
  "[border-radius:calc(18px*var(--rf))]! [corner-shape:squircle] " +
  "bg-popup-glass [backdrop-filter:var(--popup-blur)] smooth-shadow-ring-sm";

/**
 * The popup body. Fixed width, so the rows truncate rather than reflow and a
 * long branch name cannot make the card wider than the header it hangs from.
 *
 * It caps its own height and scrolls, because the list is open-ended at the
 * bottom: a session with a dozen assets would otherwise grow the card past
 * the window. Everything above the assets is short and never scrolls in
 * practice.
 *
 * This is broader and taller than the compact menus that use `rounded-popup`,
 * so its corner takes one small step up. The inner PR band inherits that step
 * below, keeping the two surfaces visually concentric.
 *
 * Its 8px top and bottom padding keeps the first plate close to the card edge
 * without pressing against it.
 */
export const WS_SUMMARY_CARD =
  "flex max-h-[min(72vh,640px)] w-[300px] flex-col overflow-y-auto py-2 " +
  WS_SUMMARY_SURFACE;

/** Wide Review keeps its scroller full width so the native scrollbar stays at
 * the window edge, beyond the summary card. These child clearances reserve the
 * summary column with an 8px visible gap. They stay 8px apart because the file
 * canvas supplies its own 8px inner gutter, keeping its border aligned with the
 * toolbar. */
export const WS_SUMMARY_REVIEW_BAR_CLEARANCE = "desktop:mr-[320px]";
export const WS_SUMMARY_REVIEW_CANVAS_CLEARANCE = "desktop:mr-[312px]";

/**
 * Band label ("Assets"), taken from the sidebar so the card heads its lists
 * the way the sidebar heads its own. It shares the rows' 16px content rail,
 * but not their 31px pitch: a label belongs to the rows under it, so it keeps
 * the gap above and gives up most of the one below.
 *
 * It opens its band with the gap a hairline used to hold. A label set apart by
 * space already reads as the start of something, so the line under it was
 * drawing a boundary the layout had drawn first, and the card says elsewhere
 * that nothing in it carries a rule.
 *
 * Quiet ink, medium weight. The label names a band, it does not compete with
 * the rows in it: a bold, darker heading over four grey rows made the heading
 * the loudest thing in a card whose subject is the rows.
 *
 * The band above it has no label. It holds the state of the work itself, which
 * is what the card IS, and a heading over it could only repeat the card's own
 * name back at you.
 */
export const WS_SUMMARY_SECTION =
  "mt-3 flex h-[22px] shrink-0 items-center px-4 text-label font-medium text-faint first:mt-1";

/**
 * A row. 31px tall on a 300px card, which is the proportion a dense list needs
 * before it stops reading as a cramped menu. Anything under about 28 and the
 * glyph column and the labels start to crowd.
 *
 * The glyph sits 6px from its label. A row is one thing being named, so the
 * mark and the words it belongs to should read as a pair rather than as two
 * columns; the wider gap it used to carry left the rail floating away from the
 * text it introduces.
 *
 * `group/ws` lets a trailing action fade in on hover without reserving its own
 * hover state.
 */
/** What a row gives up once it sits inside the band: its own gutter, since the
 *  band supplies one for the whole group. Declared before its first use: these
 *  are module-scope consts, so a reference from a line above would evaluate in
 *  the temporal dead zone and throw at import. */
const BAND_ROW = " [.ws-summary-band_&]:mx-0 [.ws-summary-band_&]:w-full";

export const WS_SUMMARY_ROW =
  "group/ws mx-2 flex h-[31px] w-[calc(100%_-_16px)] min-w-0 shrink-0 cursor-pointer items-center gap-1.5 " +
  "rounded-row border-none bg-transparent px-2 text-left text-item-title text-fg " +
  "hover:bg-hover focus-ring " +
  // Inside the PR band the row is already inset by the band, and the neutral
  // hover plate would sit as a grey patch on a tinted surface. Give up the
  // gutter and wash with the row's own ink instead, so the hover reads as the
  // band getting darker rather than as a second colour landing on it.
  BAND_ROW +
  " [.ws-summary-band_&]:hover:bg-[color-mix(in_srgb,currentColor_8%,transparent)]";

/**
 * The one row that holds a real control: the PR headline and its action
 * (Merge, Push, Pull, Resolve). Taller than a plain row because a button has
 * its own height, and unhoverable because it is not one target: the label goes
 * to the PR, the button does the thing.
 */
export const WS_SUMMARY_STATUS_ROW =
  "mx-2 flex min-h-[38px] w-[calc(100%_-_16px)] min-w-0 shrink-0 items-center gap-1.5 " +
  "rounded-row pr-2 pl-2.5 text-left text-item-title text-fg" +
  BAND_ROW;

/**
 * The PR band: the card's one plate, at the top, holding everything about the
 * pull request. Where it stands with its action, and the preview environment
 * that PR deployed.
 *
 * It is the single exception to "nothing in this card carries a fill", and it
 * earns it the same way the one coloured row does: the state of the work is
 * what the card is for, so it is the thing that should be visible before the
 * card is read. The fill is the strip's own tone band (`PR_SUMMARY_BAND_BG`),
 * which is what makes the card and the panel's strip the same object seen
 * twice rather than two designs for one fact. A muted state gets no fill at
 * all: a PR with nothing to report has no colour to lend, and a grey plate
 * would only draw a box around two rows.
 *
 * Its 8px outer gutter keeps its rows on the card's 16px content rail. Its
 * radius stays near the popup's own: subtracting the full gutter left a plate
 * this short reading as a rectangle, so it gives up 2px instead of 8.
 */
export const WS_SUMMARY_BAND =
  "ws-summary-band mx-2 mb-1 flex min-w-0 shrink-0 flex-col " +
  "[border-radius:calc(16px*var(--rf))] [corner-shape:squircle]";

/** The band's inner padding, once it has a fill to hold. An untinted band is
 *  invisible, so it stays flush and the rows keep the list's own pitch. */
export const WS_SUMMARY_BAND_PAD = "py-1";

/**
 * The leading column every row opens with, whatever it holds: a glyph, an
 * asset's thumbnail, or nothing at all. It is the sidebar's rail at this
 * card's scale, and for the same reason: sized once here, so the marks share a
 * centre line AND the labels after them share a left edge.
 *
 * Measured before it existed: an icon, a 16px thumbnail and a bare spacer
 * came out 20, 16 and 15 wide, which fanned the labels of one list across
 * three different left edges. 20px because that is what the icon set actually
 * draws — `Svg` in components/icons.tsx clamps `size` up to a 20px minimum, so
 * a row asking for 15 was never getting it.
 */
export const WS_SUMMARY_RAIL = "grid size-5 shrink-0 place-items-center";

/** A glyph in that rail. Faint: the label is the content, the icon only says
 *  which kind of thing the row is. */
export const WS_SUMMARY_ICON = "text-faint";

/** The label. It truncates, because a PR title or a worktree path is routinely
 *  longer than the card. */
export const WS_SUMMARY_LABEL = "min-w-0 flex-1 truncate";

/** Right-edge action word ("Fix", "Pull", "Commit"). Reads as text until the
 *  row is hovered, then takes the accent, because the row itself is the
 *  button. */
export const WS_SUMMARY_ACTION =
  "shrink-0 text-meta font-medium text-dim group-hover/ws:text-accent";

/** A count parked at a place row's right edge (live portals, working agents).
 *  Tone comes from the caller; a number that only reports gets `text-faint`,
 *  one that means something is running gets `text-yellow`, exactly as the
 *  panel's own tab strip reads them. */
export const WS_SUMMARY_COUNT = "shrink-0 text-meta tabular-nums";

/** The PR row's trailing state word ("Draft", "Merged", "Changes requested").
 *  Tone comes from the caller; this is only the shape. */
export const WS_SUMMARY_STATE = "shrink-0 text-meta font-medium";

/* A reviewer's face is drawn by `UserAvatar`, not by a class here: it resolves
 * the roster picture, the GitHub fallback and the initials tile, and it wears
 * the person mark the sidebar and the presence pile already use. A local
 * avatar class was tried and only produced a second shape for the same thing.
 */

/**
 * The screenshot strip.
 *
 * Pictures are the one thing in this card a row cannot say: `contact-dark.png`
 * names a file without describing what was captured, and the 16px tile that
 * used to sit in the row's rail was too small to answer it either. So they are
 * shown at the width the card has, and scroll sideways rather than growing the
 * list past the window.
 *
 * No plate under them, unlike the panel's own strip: nothing in this card
 * carries a fill, and each frame's own border is enough to hold the row
 * together. It keeps the rows' 16px content rail, so a frame starts at the
 * same left edge as every label above it.
 *
 * `pt-2` is what makes its label sit like every other one. A row band gets the
 * gap under its heading for free: the row is 31px around a 15px line, so its
 * text starts 8px below the label's box. A frame has no such slack and would
 * butt straight up against the heading, which reads as a tighter label than
 * the ones over Review and Changes. Pay the 8px here instead.
 *
 * `shrink-0` because the card is a capped-height flex column and the strip is
 * the only child that can shrink: a full card squashed the frames to a
 * hairline instead of scrolling past them.
 */
export const WS_SUMMARY_STRIP =
  "mx-2 flex shrink-0 snap-x snap-mandatory gap-2 overflow-x-auto overflow-y-hidden px-2 pt-2 pb-1 " +
  "[scroll-padding-left:8px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/** One frame in that strip: the picture, with its filename under it. */
export const WS_SUMMARY_FRAME =
  "group/frame flex shrink-0 cursor-pointer snap-start flex-col gap-1 border-none " +
  "bg-transparent p-0 text-left focus-ring";

/** The picture itself. It carries a hairline because a capture's own edge is
 *  whatever it happened to end on, so a light screenshot would otherwise have
 *  no edge at all. `border-line`, not `border-line-strong`: the frame only has
 *  to hold the picture's shape, and at the strong step the outline read as the
 *  loudest thing in a card that has no other lines in it. `object-contain`,
 *  because a screenshot is only worth showing whole. */
export const WS_SUMMARY_FRAME_MEDIA =
  "relative block aspect-video w-full overflow-hidden rounded-md border border-line " +
  "bg-surface transition-colors group-hover/frame:bg-hover";

/** The filename under a frame. The picture is the content, but the name is how
 *  you refer to it ("use the dark one"), so it stays. */
export const WS_SUMMARY_FRAME_CAPTION =
  "block w-full truncate text-meta text-dim";

/** A picture in the list, centred in the rail the glyphs use. A 16px tile
 *  inside a 20px slot, the same inset the sidebar gives its repo tiles: a
 *  filled image next to line art wants to sit a little smaller than the
 *  glyphs, or it reads as the heaviest thing in the list. It cannot say what
 *  the capture is at this size, which is what the frames are for. What it does
 *  is tell two rows apart at a glance once you already know them. */
export const WS_SUMMARY_THUMB =
  "size-4 overflow-hidden rounded-sm border border-line bg-panel object-cover";
