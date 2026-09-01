import { utilityClassName } from "../ui/cn";
/**
 * Class strings shared by the sidebar's row families, kept out of the
 * components so Sidebar, SidebarItem, FeedRows and PrRow can all wear the same
 * geometry without one of them drifting.
 *
 * Everything here is written out in full on purpose. Tailwind scans source
 * TEXT, so a class assembled at runtime — `` `sidebar-status-${tone}` `` and
 * its Tailwind equivalent alike — compiles to nothing at all. A lookup of
 * complete literals is the only shape that survives.
 *
 * ── The two signals (desktop) ───────────────────────────────────────────────
 * Two properties carry the whole rail, and they are INDEPENDENT. Read them as
 * separate questions, and do not bundle them into one "kind" again.
 *
 * HEIGHT says how prominent a line is. There are exactly three, and the middle
 * one has a single tenant:
 *
 *   36px  a FULL LINE. Session/PR/support/archived rows, and the headings
 *         that title a set of rows and lead with a mark: a repo or feed band,
 *         an automation group, Archived. See {@link SIDEBAR_HEADER_ROW}.
 *   32px  the tool rows, and only them. They lead with the same 22px glyph on
 *         the same rail as a full line, so the column reads unbroken, but the
 *         strip is a short list of places above the work rather than part of
 *         it, and four full lines of it opened the sidebar with more chrome
 *         than content. Nothing else takes this height: it is a tighter
 *         version of the full line, not a third kind of row.
 *   28px  a CAPTION, leading with no mark at all. Band headings (Tools /
 *         Workspaces / Automations / People), the status lanes (Needs action /
 *         Recent / Yesterday / Urgent), and the top-level groupings that read
 *         as lanes over the whole list: Needs review, Approved, Awaiting
 *         review, Pinned.
 *         See {@link SIDEBAR_LANE_HEADER} and {@link SIDEBAR_BAND_TOGGLE}.
 *
 * The HOVER FILL says whether clicking takes you somewhere. Only a line that
 * NAVIGATES paints one ({@link SIDEBAR_HOVER_LAYER}): the rows, the tool rows,
 * and Archived. Everything that merely collapses a group takes none, whatever
 * its height — a repo band, a feed band, an automation group, every caption.
 * They still show the ink brightening on hover, which is what says a heading
 * is a control at all; a full-width pill says something stronger and untrue,
 * and a rail where most lines offer one teaches that the pill means nothing.
 *
 * Neither question is answered by where a heading sits. Needs review and
 * Pinned are top-level and used to lead with a coloured 22px glyph on the full
 * line height, which made the headings that go nowhere the loudest things in
 * the rail; they name a group exactly the way Yesterday does, so they are
 * captions. A repo band does title real rows, so it keeps the full line, but
 * it is still only a toggle, so it lost its pill.
 *
 * Before this the same rail ran 44 / 40 / 32 / 30 / 28 down one column — five
 * heights for four kinds of thing, with the tallest box (a band caption at 44)
 * on the QUIETEST content and tool rows 12px shorter than the session rows
 * directly under them. Hierarchy now comes from type, mark and the hover pill,
 * which are the things that actually differ; height is free to be regular.
 *
 * Phone layouts are deliberately NOT on this scale — a 36px row is not a touch
 * target, so `phone:` keeps its own taller padding throughout.
 *
 * The tier-1 sticky SLOT is a third number, 32, and it is not a third row
 * height: it is the 28px band caption plus its air, which is what everything
 * below pins under. Two offsets are sums of these, so change a height here and
 * fix them in the same edit: a lane pins under one band at 32, and a lane
 * nested under a band plus a repo band at 32 + 36 = 68.
 *
 * Every one of those numbers is a custom property now, set once by
 * {@link SIDEBAR_DENSITY_VARS} — which is what lets "Compact sidebar" retune
 * the whole scale from one element, and what keeps the two sums above correct
 * without anyone re-deriving them.
 */

/**
 * The rail's vertical scale, as one set of custom properties on the sidebar's
 * scroll root. The default column is the scale described above; the compact
 * column is the same rail with the air taken out of it, which is the whole of
 * what the "Compact sidebar" preference does.
 *
 *              default   compact
 *   full line     36px      30px   rows, and the headings that title rows
 *   tool row      32px      30px   the tool strip
 *   caption       28px      24px   band headings and status lanes
 *   band slot     32px      28px   the tier-1 sticky slot
 *   group gap     14px       8px   the air after a top-level group
 *   row action    26px      24px   the pin/archive chip inside a row
 *
 * The 22px leading rail does NOT move. Its marks are 18px (a repo tile, a
 * status mark), so a narrower slot would leave them 1px of margin, and the
 * shared left edge every title sits on is the one thing a density change must
 * not touch — a compact list that also re-rags the titles reads as a different
 * sidebar rather than a tighter one. 30px around a 22px rail is 4px of margin,
 * the tool row's own margin today.
 *
 * The row action is the one box that HAS to follow the line height, because it
 * is painted inside it: it is a hover wash sitting on the row's own hover pill,
 * so anything at or above the line height reads as a second row rather than a
 * button on one. It stays 5px inside a full line and 3px inside a compact one.
 *
 * Two rules ride on this. Compact is gated on `desktop:`, because a phone row
 * is a tap target and its `phone:` padding is deliberately off this scale.
 * And the compact values sit on the SAME element as `data-density`, so they
 * out-rank the defaults on specificity (0,2,0 against 0,1,0) rather than on
 * Tailwind's output order, which two utilities setting one property would
 * otherwise be settled by.
 */
export const SIDEBAR_DENSITY_VARS =
  "[--sidebar-row-pad:7px] [--sidebar-tool-pad:5px] [--sidebar-line-h:36px] [--sidebar-cap-h:28px] [--sidebar-band-slot:32px] [--sidebar-group-gap:14px] [--sidebar-row-action:26px] " +
  "desktop:data-[density=compact]:[--sidebar-row-pad:4px] desktop:data-[density=compact]:[--sidebar-tool-pad:4px] desktop:data-[density=compact]:[--sidebar-line-h:30px] desktop:data-[density=compact]:[--sidebar-cap-h:24px] desktop:data-[density=compact]:[--sidebar-band-slot:28px] desktop:data-[density=compact]:[--sidebar-group-gap:8px] desktop:data-[density=compact]:[--sidebar-row-action:24px]";

/**
 * The rail's HORIZONTAL scale, the counterpart to the vertical one above, on
 * the same element.
 *
 * `--sidebar-nav-x` is the air between the column's own edges and the boxes
 * inside it: the hover/selected pill, the tool rows, the band sections. It is
 * not the text's inset — that is `--sidebar-icon-left` (16px, set on the
 * sidebar container), the rail every leading mark and every title after it
 * lines up on, at both densities and in every family.
 *
 * The two were previously one hand-summed pair per family (list 6 + row 10,
 * list 6 + heading 10, section 6 + band 10, and the tool row's calc), so the
 * outer air could not be changed without re-deriving four inner values and
 * getting the shared rail wrong in whichever one was missed. Only the tool row
 * ever expressed it as the subtraction it is; now they all do, through
 * {@link SIDEBAR_RAIL_PAD}, and the air is one number.
 *
 * 10px, not the 6 it was. At 6 the pill sat all but against both edges of the
 * column — a window edge on one side, the seam with the reading pane on the
 * other — and a truncating title faded out 14px short of that seam, which read
 * as the sidebar running out of room rather than as a margin.
 */
export const SIDEBAR_NAV_X = utilityClassName(
  "[--sidebar-nav-x:6px] desktop:[--sidebar-nav-x:10px]",
);

/**
 * The left padding a box inside that inset takes to put its leading mark back
 * on the shared rail. Fallbacks are today's numbers, so a row rendered outside
 * the sidebar's own root still lands where it always did.
 *
 * Two spellings of one value, both written out: Tailwind compiles the class
 * names it can FIND, variant and all, so a `desktop:` prefix glued on at a
 * call site would compile to nothing. Rows take the bare one (their phone
 * padding overrides it); the headings, which only re-inset on desktop, take
 * the prefixed one.
 */
export const SIDEBAR_RAIL_PAD = utilityClassName(
  "pl-[calc(var(--sidebar-icon-left,16px)-var(--sidebar-nav-x,6px))]",
);
export const SIDEBAR_RAIL_PAD_DESKTOP = utilityClassName(
  "desktop:pl-[calc(var(--sidebar-icon-left,16px)-var(--sidebar-nav-x,6px))]",
);

/**
 * The sidebar's leading column. Every row and group header opens with one of
 * these, whatever it holds — a 22px glyph, a 20px one, a 7px status dot, a
 * repo tile — so the marks share a centre line AND the text after them shares
 * a left rail. Before this the slot was whatever its content measured
 * (7 / 17 / 20 / 22), which fanned the titles out across seven different left
 * edges in the same list. Wrap shared marks at the call site rather than
 * resizing them: the group dot and RepoTile are also dropdown option icons,
 * where a 22px box would be wrong.
 */
export const SIDEBAR_RAIL = utilityClassName(
  "relative flex size-[22px] flex-[0_0_22px] items-center justify-center",
);

/**
 * The air between that rail and the title after it — one value, shared by
 * every family that opens with a rail (session rows, workspace rows, group
 * headings, the tool strip). It has to be shared: the left edge the titles
 * sit on is rail width plus this gap, so a family that sets its own number
 * rags its list against the others.
 *
 * 7px, not 9. The rail is sized for an 18px mark, so a 7px status dot already
 * carries 7px of its own margin inside the slot, and at 9 the gap read as a
 * hole in front of the dot rows while the icon rows next to them looked
 * closed up. Tightening the shared gap keeps that difference where it belongs
 * (inside the rail, centred) instead of adding to it.
 */
export const SIDEBAR_RAIL_GAP = utilityClassName("gap-[7px]");

/**
 * ── Containers ──────────────────────────────────────────────────────────────
 * The boxes the row families sit in. Written phone-first with a `desktop:`
 * desktop override, which is the exact complement of the `max-width: 720px`
 * these rules came from — `phone:` compiles to `< 720` and would leave a
 * viewport exactly 720px wide wearing neither value.
 */

/**
 * The workspace list. Horizontal padding is tight on desktop so the
 * active/hover pill sits close to the sidebar edges (it "overflows" past the
 * content inset, Conductor-style) and row content lands on the shared columns:
 * leading icons under the group-header icons, trailing times/numbers
 * flush-right under the header's filter/＋ buttons. On phones the surfaces
 * breathe past their content rail instead, while the content stays aligned
 * with the tool cards' 16px edge (12px outer + 4px inner below).
 *
 * `data-sidebar-list` rides alongside it: the ArrowUp/ArrowDown row navigation
 * queries this box for its candidate rows, and an attribute says "hook" where a
 * class name would read as styling.
 */
export const SIDEBAR_LIST = utilityClassName(
  "flex-none overflow-y-visible px-3 pt-px pb-0 desktop:px-[var(--sidebar-nav-x)]",
);

/**
 * Bands that are siblings of the workspace list (Automations, People) but
 * participate in the sidebar's single scroll flow rather than creating nested
 * scroll panes.
 */
export const SIDEBAR_INDEPENDENT_SECTION = utilityClassName(
  "block min-w-0 flex-none mx-3 desktop:mx-[var(--sidebar-nav-x)]",
);

/** The scroll flow inside one of those bands — visible, not a nested pane. */
export const SIDEBAR_INDEPENDENT_SCROLL = utilityClassName(
  "min-w-0 overflow-y-visible pb-1.5",
);

/**
 * A hover painted as a background LAYER rather than a background colour — the
 * sidebar's hover, for anything that also carries a state fill of its own.
 *
 * Every state in here is translucent ink: selected is `bg-selected`, a pinned
 * action is `bg-pressed` ("needs you" carries no fill at all — it is a mark in
 * the rail and a bold title, so it composites with any of these). That
 * is what lets each of them pick up the sidebar material (and, on the desktop
 * shell, the wallpaper) underneath instead of cutting an opaque patch out of
 * it — but it also means a colour-based hover REPLACES that fill instead of
 * adding to it. Pointing at a selected row would then swap 0.065 of ink for
 * 0.055 and the row would go QUIETER under the pointer, which reads as
 * deselecting; on an element whose two states are the same token (a pinned
 * pin) it does nothing at all. Both were worked around by withholding the
 * hover while the other state was on — see the filter button — which just
 * moves the missing feedback somewhere else.
 *
 * As a layer the hover composites over whatever the element already carries,
 * which is what a hover is, so one class covers every state including none.
 *
 * The one thing this is NOT for is an action chip floating over a row — see
 * {@link SIDEBAR_ROW_CHIP}.
 */
export const SIDEBAR_HOVER_LAYER = utilityClassName(
  "hover:bg-[image:linear-gradient(var(--hover),var(--hover))]",
);

/**
 * The pin/archive chip's hover — the deliberate exception to the wash.
 *
 * These float ON a row that is itself already hovered, and they are lids
 * rather than tints: a translucent one shows the row's wash, and anything the
 * row still has under that spot, through the glyph. So it takes `--row-chip`,
 * which is the hover wash pre-composited onto whatever surface the sidebar is
 * painted with (see base.css) — the background bleeds into its COLOUR instead
 * of through its alpha, and it is never more see-through than the sidebar it
 * sits on.
 */
export const SIDEBAR_ROW_CHIP = utilityClassName("hover:bg-[var(--row-chip)]");

/** A top-level group in the workspace list, and the gap after it. */
export const SIDEBAR_GROUP = utilityClassName("mb-[var(--sidebar-group-gap)]");

/**
 * A status lane. Consecutive lanes open with 8px of their own, which was an
 * adjacent-sibling rule and stays one: `data-status-group` is what the variant
 * matches, because the margin depends on what precedes the element and no
 * amount of `:not(:first-child)` says the same thing when other kinds of
 * sibling can sit between two lanes.
 */
export const SIDEBAR_STATUS_GROUP = "[[data-status-group]+&]:mt-2";

/**
 * A lane acting as a drop target while a Pinned row is mid-drag: the one under
 * the pointer wears a pill + accent ring, and lanes that only materialized for
 * the drag (they were empty) sit dimmed.
 */
export const SIDEBAR_LANE_EMPTY = utilityClassName("opacity-55");
export const SIDEBAR_LANE_DROP_HOVER = utilityClassName(
  "rounded-row bg-pressed opacity-100 shadow-[inset_0_0_0_1px_var(--accent,#6b8afd)]",
);

/** The drag-to-reorder wrapper around each Pinned row (Motion Reorder.Item). */
export const SIDEBAR_PIN_ENTRY = utilityClassName("relative");

/**
 * While a row is being dragged it floats over its neighbours, so it needs a
 * solid background (rows are transparent over the app bg) and to win the
 * stacking order; the radius matches the row's own so the backdrop doesn't poke
 * out. `[&>*]:pointer-events-none` is the other half of the same state and used
 * to key off the LIST (`.sidebar-pin-list.is-drag-active`): rows sliding under
 * the pointer would otherwise fire mouseenter and pop their hover preview
 * cards, so the row content is muted and only the drag gesture sees the
 * pointer. Every entry wears it while any drag is in flight, which is what the
 * list-level selector did — so the list needs no class of its own.
 */
export const SIDEBAR_PIN_ENTRY_DRAGGING = utilityClassName(
  "z-[5] rounded-row bg-bg smooth-shadow-ring-sm",
);
export const SIDEBAR_PIN_DRAG_ACTIVE = "[&>*]:pointer-events-none";

/**
 * The RepoTile a repo/feed band header leads with. It rides centred in the 22px
 * leading slot rather than filling it: the tile is a SOLID block of colour
 * where every other mark on that column is a stroke glyph or a small dot, so at
 * the slot's full size it outweighed them all and the band read as shouting.
 * 18px is the same box the session rows' own marks (WsStatusMark) wear one row
 * below, so the tile now sits in a column of equal-sized marks — the 2px it
 * gives up against the 22px Pinned/Needs-review glyphs costs less than the
 * weight did, and the band's label still starts on the shared text rail either
 * way (the rail sets that, not the tile).
 *
 * Passed as RepoTile's `className`, NOT as its `size`: `size` also recomputes
 * the tile's radius (round(18 * 0.28) = 5px) as inline style, where the band
 * header's tile keeps the `.repo-tile` base radius of 4px. The type size is
 * arbitrary rather than `text-xs` because it is the tile's geometry — it tracks
 * the 18px box, not the sidebar's type scale.
 */
export const SIDEBAR_REPO_TILE = utilityClassName(
  "size-[18px] shrink-0 text-meta",
);

/**
 * ── Group headers ───────────────────────────────────────────────────────────
 * The collapsible headings INSIDE the workspace list: Needs review, Pinned,
 * Archived, the repo bands, the automation groups. `group/gh` is what the
 * chevron and the automation cog key their reveal off, so it has to ride on
 * every one of them.
 *
 * Padding is deliberately not here — the Archived heading wears its own,
 * and two utilities from the same group in one string would leave the winner
 * to Tailwind's internal ordering rather than to the call site.
 *
 * Neither is the hover FILL, nor a height: those are what separate the two
 * families that share this base. An item heading adds
 * {@link SIDEBAR_HEADER_ROW}; a caption adds {@link SIDEBAR_LANE_HEADER} and
 * takes neither. The ink brightening on hover stays on both — it is what says
 * a caption is still a toggle once the pill is gone.
 */
/* Desktop sits one step under the transcript, phone keeps the body step.
   Beside the work the sidebar is a denser column than the reading one, and the
   pixel between them is what says so; taken all the way down to the label step
   it stopped reading as the same app as the transcript. On a phone the sidebar
   IS the page, so its rows are the thing being read and stay at body. */
export const SIDEBAR_GROUP_HEADER = utilityClassName(
  `group/gh flex w-full items-center ${SIDEBAR_RAIL_GAP} rounded-[calc(10px*var(--rf))] border-none bg-transparent font-medium tracking-[0px] text-dim hover:text-fg`,
);

/**
 * A FULL-LINE heading — a repo or feed band, an automation group, Archived.
 * Each leads with a mark in the rail and titles the rows under it, so it wears
 * the row's 36px box and sits in one regular column with them rather than as a
 * third size between them and the captions.
 *
 * The height and the row size. The hover fill is NOT here, because it answers a different
 * question — see the height scale at the top of this file: a repo band is a
 * full line but it is a collapse toggle, so it takes no fill, while Archived
 * looks identical and navigates, so it adds {@link SIDEBAR_HOVER_LAYER} at its
 * call site. Bundling the two here is what put a pill on three headings that
 * go nowhere.
 *
 * Desktop only. On phones the heading keeps the taller tap box its own inset
 * gives it.
 */
export const SIDEBAR_HEADER_ROW = utilityClassName(
  "text-body desktop:h-[var(--sidebar-line-h)] desktop:min-h-[var(--sidebar-line-h)] desktop:text-item-title",
);

/** Left pad puts the icon on the shared rail, whatever the list's inset is. */
export const SIDEBAR_GROUP_HEADER_INSET = utilityClassName(
  `pt-[11px] pr-1 pb-[11px] pl-1 desktop:pt-1 desktop:pr-1.5 desktop:pb-1 ${SIDEBAR_RAIL_PAD_DESKTOP}`,
);

/**
 * Status lanes, inbox bands and Snoozed — the groups nested inside a list or a
 * project band. They label the rows rather than lead anywhere, so they read as
 * captions: a size down from the rows, semibold to hold their own at that size,
 * and no leading glyph at all (the rows under them already carry the status
 * marks, and the lane's own name says what it is). Size and weight are what
 * separate a caption from a title, not a third left edge. One size at both
 * widths: a caption a step under the rows it heads still reads as a caption,
 * and at the meta step it fell in with the count beside it instead.
 *
 * It takes the 28px LABEL height and — pointedly — no hover fill, which is the
 * pairing that makes it read as a caption at all. Given the pill it looked
 * like an item, and a list of five lanes then presented five clickable-looking
 * rows that lead nowhere between the rows that do.
 */
export const SIDEBAR_LANE_HEADER = utilityClassName(
  "gap-[5px] pt-[9px] pb-[5px] text-label font-semibold desktop:h-[var(--sidebar-cap-h)] desktop:min-h-[var(--sidebar-cap-h)] desktop:pt-1 desktop:pb-1",
);

/**
 * The heading's own name. `truncate` before any width utility: it is the pair
 * of overflow rules that makes the ellipsis, and a min-width of 0 is what lets
 * a flex child shrink far enough to need one.
 */
export const SIDEBAR_GROUP_NAME = utilityClassName(
  "min-w-0 truncate text-left",
);

/**
 * Phone lane captions keep a slight 2px inset for arm's-length reading.
 * Desktop captions sit directly on the header's content rail, while the hover
 * pill still runs the sidebar's full width.
 */
export const SIDEBAR_LANE_NAME = utilityClassName("pl-0.5 desktop:pl-0");

/**
 * The collapse chevron. Revealed by the header's hover, and rotated to mark the
 * collapsed state by the call site's inline transform.
 */
export const SIDEBAR_GROUP_CHEVRON = utilityClassName(
  "shrink-0 text-faint opacity-0 transition-[transform,opacity] group-hover/gh:text-fg group-hover/gh:opacity-100",
);

/**
 * A collapsed heading keeps its chevron out of hover. Expanded, the rows below
 * already say the group is open, so the affordance can stay quiet; collapsed,
 * nothing on screen distinguishes a group holding fifteen hidden rows from one
 * that simply has none, and the count alone reads as decoration. The chevron is
 * the state, so it is what shows.
 *
 * It shows at the resting `text-faint`, not the hover colour — present, not
 * loud. Muting the label instead would say the opposite of what is true: a
 * collapsed group is hiding work, which is worth more attention, not less.
 */
export const SIDEBAR_GROUP_CHEVRON_COLLAPSED = utilityClassName("opacity-100");

/**
 * The count on a group or band heading. Written phone-first for the same
 * reason the containers above are: the rule this replaces bumped to 13px under
 * `max-width: 720px`, and `phone:` compiles to `< 720`.
 *
 * Horizontal spacing is deliberately NOT here. The old rule pinned every count
 * to the right with `margin-left: auto` and a 4px inset, and every call site
 * turned both back off. A count belongs to the name it counts: every heading
 * now reads "Docs Spell-Check, 5" with the number against the label, and the
 * right end of the row is left to whatever acts on the row.
 *
 * Nor is a size. A count is part of the heading it belongs to, so it inherits
 * that heading's step and is set apart by colour alone. Given a step of its
 * own it read as dropped out of the phrase rather than as part of it: a
 * numeral has no ascender, so the same nominal gap costs it more than it costs
 * a word.
 */
export const SIDEBAR_GROUP_COUNT = utilityClassName("font-medium text-faint");

/**
 * The same count on a status-lane heading. Identical to
 * {@link SIDEBAR_GROUP_COUNT} today and kept as its own name because the two
 * headings are free to diverge; neither sets a size.
 */
export const SIDEBAR_LANE_COUNT = utilityClassName("font-medium text-faint");

/** The 7px liveness dot a lane or automation heading leads with. */
export const SIDEBAR_GROUP_DOT = utilityClassName(
  "size-[7px] shrink-0 rounded-full opacity-85",
);

/* The 22px glyph a top-level heading used to lead with is gone: Needs review,
   Approved, Awaiting review and Pinned are groupings rather than
   destinations, so they are labels now (see the height scale above) and carry
   no mark, exactly like the Yesterday / Earlier lanes they sit among. The
   marks that remain in the rail — a repo tile, a lane dot — belong to things
   you can open. */

/**
 * The sliders glyph at the end of an automation heading, jumping to that
 * automation's settings. `ml-auto` puts it at the right end, which is now its
 * own: the run count sits with the name, so nothing has to be swapped out to
 * make room for this. Hover-device only, like the row action clusters — on
 * touch there is no hover to reveal it with, and the heading falls back to
 * Settings for reaching an automation.
 *
 * The target is the full height of the row (`self-stretch` plus the negative
 * margins that eat the heading's own padding) and 4px wider than the box on
 * each side, because the thing being aimed at is 20px of glyph at the end of a
 * 36px row and the cursor arrives along the row rather than at its centre
 * line. The width comes from `::after` rather than from the box: a pseudo is
 * hit-tested as part of its element, so the target grows while the LAYOUT
 * still reserves 24px, and the heading's name truncates at the same
 * character it did before. The wash is its own 28px pseudo, because filling
 * the target would paint a slab the height of the row for a control that is
 * not the row (`paletteIconBtn` insets its own for the same reason).
 *
 * The wash belongs to the glyph, so it waits for the glyph. Hovering the row
 * reveals the control and nothing more; the fill and the brighter ink arrive
 * together once the pointer is actually on it. Painted with the row instead,
 * a heading you were only reading carried a filled box at its end, which read
 * as a second, already-lit control rather than as the row's own hover.
 */
export const SIDEBAR_AUTO_COG =
  utilityClassName(
    "relative -my-1 ml-auto hidden w-6 shrink-0 cursor-pointer items-center justify-center self-stretch text-dim group-hover/gh:inline-flex hover:text-fg ",
  ) +
  utilityClassName(
    "before:absolute before:top-1/2 before:left-1/2 before:z-0 before:size-7 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-[calc(6px*var(--rf))] before:[corner-shape:var(--cs)] before:transition-[background] before:content-[''] hover:before:bg-pressed ",
  ) +
  utilityClassName(
    "after:absolute after:-inset-x-1 after:inset-y-0 after:content-[''] ",
  ) +
  "[&>svg]:relative [&>svg]:z-[1]";

/**
 * What sits under an automation heading: its latest report, then its runs.
 *
 * A run is named after the automation that produced it, then the time it ran,
 * so on one rail the band read as a column of rows repeating two names rather
 * than as two automations with their work under them. The step is what says
 * which rows belong to which heading.
 *
 * It holds for a COLLAPSED group too, where the one row that can be there is
 * an owned automation's latest report. The step says "belongs to the heading
 * above", which is as true of a report as of a run; what says the group is
 * closed is the heading's own chevron, which is why that chevron shows at rest
 * rather than on hover (see {@link SIDEBAR_GROUP_CHEVRON_COLLAPSED}). Flatten
 * the report onto the heading's rail instead and it stops reading as that
 * automation's finding and starts reading as another automation.
 *
 * It moves the CONTENT rail, not the row. `--sidebar-icon-left` is the column
 * every leading mark and every title lines up on, so overriding it here
 * indents the marks and the names together while the hover and selected fills
 * keep the sidebar's own edges, the way they do in every other family. That is
 * also how a nested row reads in Finder and the Xcode navigator. Indenting the
 * row box instead would leave one ragged left edge in a column of pills.
 */
export const SIDEBAR_AUTOMATION_RUNS = "[--sidebar-icon-left:28px]";

/**
 * ── Sticky machinery ────────────────────────────────────────────────────────
 * The desktop sidebar is ONE scroll rail, and two tiers of heading pin inside
 * it: a band heading (Tools / Workspaces / Automations / People) holds the top
 * slot, and the lane, repo and status headers under it pin one row lower.
 * Every pinning element also carries `data-sticky-head`, which is what
 * Sidebar's scroll listener queries. CSS has no interoperable `:stuck`, so JS
 * toggles `data-stuck` and only then does a header paint its backing. This must
 * be a dedicated attribute rather than an imperative class: React owns
 * `className` and rewrites it on a sidebar rerender, even while the scroll
 * position stays put.
 *
 * Everything here is gated on `min-[721px]`: on phones the whole sidebar is a
 * page that scrolls as one, and nothing pins.
 */

/** Tier 1 — a band heading pinned at the top of the rail. */
export const SIDEBAR_STICKY_BAND = utilityClassName(
  "desktop:sticky desktop:top-0 desktop:z-20",
);

/**
 * One invariant row height for the tier-1 headings, which is what stops the
 * outgoing and incoming labels peeking around each other while one section
 * pushes the next away. It overrides whatever vertical padding/margin the
 * heading wears in the phone layout, so it is written at the same `min-[721px]`
 * breakpoint the pinning is.
 *
 * 32px rather than a 44px box of its own: a band caption carries the least on
 * the rail (a 12px faint word) and had the tallest box on it, which read as a
 * gap in the list rather than as a heading of it. This is a SLOT, not a third
 * row height — the caption inside it keeps the 28px label height, and the 4px
 * left over is the air a heading wants above the rows it names. It is also
 * what every tier-2 header pins under, so the offsets below start from it.
 */
export const SIDEBAR_STICKY_BAND_ROW = utilityClassName(
  "desktop:mt-0 desktop:flex desktop:h-[var(--sidebar-band-slot)] desktop:min-h-[var(--sidebar-band-slot)] desktop:items-center desktop:py-0",
);

/**
 * Tier 2: a lane / repo / status header, pinned one band-row lower. Once
 * pinned, its trailing fade makes the rows passing underneath remain visible
 * without leaving a hard edge below the caption.
 *
 * Position only — this used to pin a 30px height on everything it touched,
 * which is where the rail's third and fourth heights came from: a repo band
 * (an item) and a status lane (a caption) are structurally the same tier and
 * so were forced to the same box despite being different kinds of thing. Each
 * now brings its own height from its family class, and the two agree with the
 * rows around them instead of with each other.
 */
export const SIDEBAR_STICKY_LANE =
  utilityClassName(
    "desktop:sticky desktop:top-[var(--sidebar-band-slot)] desktop:z-[15] ",
  ) +
  "desktop:data-[stuck]:after:pointer-events-none desktop:data-[stuck]:after:absolute desktop:data-[stuck]:after:top-[calc(100%-8px)] desktop:data-[stuck]:after:left-[-400px] desktop:data-[stuck]:after:right-[-400px] desktop:data-[stuck]:after:z-[-1] desktop:data-[stuck]:after:h-5 desktop:data-[stuck]:after:content-[''] desktop:data-[stuck]:after:[background:linear-gradient(to_bottom,var(--sidebar-material),transparent),linear-gradient(to_bottom,var(--sidebar-bg),transparent)]";

/**
 * A status lane nested inside a repo band sits one row lower again — its repo
 * header already occupies the first sub-header slot — and must pass UNDER that
 * header, hence the lower z-index. Pass it after {@link SIDEBAR_STICKY_LANE}
 * through `cn()`, which resolves the pair to this one.
 *
 * The offset is the band slot above it plus the repo header above it (an item):
 * 32 + 36 = 68 by default, 28 + 30 = 58 compact. Both of those heights are fixed
 * by their own class rather than by padding, which is what lets this be a sum
 * instead of a measurement; spelling it as the sum rather than as either
 * number is what keeps it right at both densities.
 */
export const SIDEBAR_STICKY_LANE_NESTED = utilityClassName(
  "desktop:top-[calc(var(--sidebar-band-slot)+var(--sidebar-line-h))] desktop:z-[14]",
);

/**
 * ── Band headings ───────────────────────────────────────────────────────────
 * The top-level bands (Workspaces / Automations / People) behave like Notion's:
 * the whole heading is a full-width hover row that toggles the band, the
 * collapse chevron sits by the label (revealed on hover), and the count or any
 * actions live on the right.
 *
 * The type is the CAPTION: the same 13px semibold ink a status lane wears (see
 * {@link SIDEBAR_LANE_HEADER}), at both widths. A band and a lane are the same
 * kind of thing on this rail, a glyphless word naming the rows under it, so the
 * sidebar carries ONE label rather than one per nesting level. This used to
 * step down to 11px faint on desktop and up to 15px on phones, which left a
 * top-level heading smaller and quieter than the lanes nested inside it, and
 * made Automations and Earlier read as two different kinds of thing in the same
 * column.
 */
export const SIDEBAR_BAND_LABEL = utilityClassName(
  "text-label font-semibold text-dim",
);

/**
 * The heading's toggle button. Horizontal padding is NOT here: each band sits
 * at a different inset, and two utilities from the same group in one string
 * would leave the winner to Tailwind's internal ordering rather than to the
 * call site. Give it `group/band` so the chevron can key off its hover.
 */
export const SIDEBAR_BAND_TOGGLE =
  // `border-none`, not `border-0`: the latter zeroes the width but leaves the
  // style at Tailwind's `solid` default, which is not what the `border: none`
  // this replaced computed to. Width resolves to 0 under either.
  //
  // A band heading is a LABEL, so it paints no hover fill: only the ink
  // brightens, to `text-fg`, which is the same step a lane caption takes (see
  // SIDEBAR_GROUP_HEADER). `--sidebar-cap-h` is the 28px label height; it sits
  // inside the 32px slot SIDEBAR_STICKY_BAND_ROW reserves, so the caption keeps
  // a little air around it without the pinned slot growing. Compact takes the
  // pair to 24 inside 28, which is the same 4px of air.
  utilityClassName(
    "group/band m-0 flex min-h-[var(--sidebar-cap-h)] w-full cursor-pointer items-center gap-[5px] rounded-[calc(8px*var(--rf))] border-none bg-transparent py-1 text-left text-inherit [font:inherit] hover:text-fg",
  );

/**
 * The inset the Automations and People headings take. The desktop value lands
 * the glyphless labels on the same 16px rail as Tools, Workspaces and lane
 * captions. The phone layout keeps its tighter base inset.
 */
export const SIDEBAR_BAND_TOGGLE_INSET = utilityClassName(
  `pr-1 pl-2 desktop:pr-2 ${SIDEBAR_RAIL_PAD_DESKTOP}`,
);

/**
 * The chevron reveals on hover but stays IN LAYOUT at all times (visibility,
 * not display), so it always reserves its box — otherwise its 18px height,
 * taller than the 12px label line, would grow the row the moment it appears
 * and nudge the whole list below. Reserved-but-hidden costs only trailing
 * space at the row's right edge, which is invisible.
 */
export const SIDEBAR_BAND_CHEVRON = utilityClassName(
  "invisible shrink-0 text-faint",
);

/** The band heading's counterpart to {@link SIDEBAR_GROUP_CHEVRON_COLLAPSED}. */
export const SIDEBAR_BAND_CHEVRON_COLLAPSED = utilityClassName("visible");

/**
 * The full-width surface a header paints once it is actually pinned. It uses
 * the sidebar's exact material and extends one pixel below the host so rows
 * cannot show through its translucent bottom border. The ±400px overhang keeps
 * the backing edge-to-edge regardless of the heading's own inset; the sidebar
 * clips the excess horizontally.
 *
 * This deliberately avoids backdrop-filter. Toggling blur from the scroll
 * listener re-rasterized the whole sidebar mid-scroll on loaded machines.
 */
export const SIDEBAR_STUCK_BACKING =
  "desktop:data-[stuck]:before:absolute desktop:data-[stuck]:before:top-0 desktop:data-[stuck]:before:bottom-[-1px] desktop:data-[stuck]:before:left-[-400px] desktop:data-[stuck]:before:right-[-400px] desktop:data-[stuck]:before:z-[-1] desktop:data-[stuck]:before:content-[''] desktop:data-[stuck]:before:[background:linear-gradient(var(--sidebar-material),var(--sidebar-material)),var(--sidebar-bg)]";

/**
 * The live-state dot a row, group header or hover card carries, minus the
 * `size-2 shrink-0 rounded-full` box the call sites already give it.
 *
 * The reduced-motion exceptions ride on the element rather than on a class
 * name listed in base.css: that block kills every animation with `!important`
 * and then hands the genuine liveness signals back BY CLASS NAME, so dropping
 * a legacy class name silently freezes the indicator with nothing to catch it.
 * These durations match what base.css grants `.sidebar-status-running` (1.4s)
 * and `.sidebar-status-waiting` (1.2s).
 *
 * `pulse` resolves to Tailwind's keyframes, not the stylesheet's: both define
 * one, keyframes don't cascade by specificity, and Tailwind's sheet is linked
 * second — which is already what these dots animate with today.
 */
/**
 * The sidebar's collapse toggle, and the floating re-open control that stands
 * in for it once the sidebar is hidden. They share a look on purpose: the
 * affordance has to read the same whether the sidebar is open or gone.
 *
 * Size and `display` are deliberately NOT here. The in-row toggle is a padding
 * box matching `.viewer-code-icon`, so the two top bars read as one system,
 * while the floating re-open control keeps a fixed 34x34 square (what centers
 * it on the collapsed header row) and starts out `hidden`. Two utilities from
 * the same group in one string would leave the winner to Tailwind's internal
 * ordering rather than to the call site.
 */
export const SIDEBAR_CHROME_BTN = utilityClassName(
  "shrink-0 items-center justify-center rounded-control text-faint transition-[color,background] hover:bg-hover hover:text-fg",
);

/**
 * The square icon buttons in the workspace header — the filter and the new
 * session "+". 20px glyph type on a 34px box, stepped up to 22 on 38 at phone
 * widths, where the whole sidebar is a tap surface. The hover wash is applied
 * by the call site rather than baked in, because the filter button's `active`
 * state paints a stronger wash that hovering must NOT wash back out.
 */
export const SIDEBAR_HEADER_BTN = utilityClassName(
  "shrink-0 rounded-control font-medium",
);
/**
 * Size and type step together, so each viewport carries its whole pair rather
 * than overriding half of the other's. `leading-none` has to sit AFTER the
 * `text-*` in the same string: cn() is tailwind-merge, which files `leading`
 * as a conflict of `font-size`, so a later type size silently drops an earlier
 * line-height and the glyph starts riding on `normal`.
 */
export const SIDEBAR_HEADER_BTN_PHONE = utilityClassName(
  "size-[38px] text-[22px] leading-none",
);
export const SIDEBAR_HEADER_BTN_DESKTOP = utilityClassName(
  "size-[34px] text-[20px] leading-none",
);

/**
 * The trailing icon button on a band heading (the feed filter). Carries no
 * resting colour of its own: the call site picks exactly one, because two
 * `text-*` utilities on one element are decided by Tailwind's internal order,
 * not by which one you wrote last.
 */
export const SIDEBAR_BAND_ACTION = utilityClassName(
  "ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-control hover:bg-hover hover:text-fg",
);

/**
 * The dot a filter button wears while a non-default filter is applied — the
 * mark only; its accent TEXT colour is the call site's, for the reason above.
 * A bare `border-radius: 50%` with no corner-shape of its own, so
 * `rounded-full` — the one radius spelling base.css does NOT squircle — is the
 * correct spelling here.
 */
export const SIDEBAR_FILTER_DOT = utilityClassName(
  "relative after:absolute after:top-[5px] after:right-[5px] after:size-1.5 after:rounded-full after:bg-accent after:content-['']",
);

/**
 * The attention count on a COLLAPSED band — urgent rows must not vanish inside
 * a closed group, so the band keeps a badge for them. The FILL is the call
 * site's, because it carries the meaning: a repo band counts needs-input rows
 * and wears that lane's blue, while a feed band counts its attention lane and
 * wears that lane's colour (Plain's Urgent is red — SUPPORT_PRIORITY_GROUPS).
 * `rounded-full`, not `rounded-[999px]`: the old rule set no corner-shape, and
 * rounded-full is the one radius spelling base.css leaves un-squircled.
 */
export const SIDEBAR_ATTN_COUNT = utilityClassName(
  "min-w-4 flex-[0_0_auto] rounded-full px-1 text-center text-[10px] leading-4 font-semibold text-white",
);

/**
 * ── Workspace rows: the trailing cluster ────────────────────────────────────
 * The metadata a workspace / PR / support / feed / archived row carries at its
 * right edge — count, time, run ticker, snooze countdown, draft pencil — and
 * the pin/archive actions that take their place under the pointer.
 *
 * Which of those is visible was decided by a stack of competing `display`
 * rules, three of which carried a comment about the SOURCE ORDER they depended
 * on ("must be @media-gated … it sits after the mobile override blocks",
 * "Three classes so it outranks …", "it must stay below it to win"). Utilities
 * cannot reproduce that: two utilities setting one property are settled by
 * Tailwind's internal output order, not by the order they are written on the
 * element. So the state is resolved in the components instead — every element
 * is handed exactly one `display` per variant level, and nothing needs to
 * out-rank anything. The same rule applies to the action colours below.
 */

/**
 * A workspace row: {@link SIDEBAR_ROW} laid out as one flex line, so the rail,
 * the title and the trailing cluster sit on the sidebar's shared columns. The
 * gap is {@link SIDEBAR_RAIL_GAP}, the same one every railed family takes.
 *
 * On hover the line gives up its right end to {@link SIDEBAR_WS_ACTIONS}, which
 * floats over that spot. The reserve lives here, on the row, because it is the
 * row that has to clear it: it used to be a margin on the time badge, which
 * left a row without a time (a PR row, a ticket with no status change) with its
 * title running under the icons — invisible for as long as the actions wore an
 * opaque plate to cover it, and plainly wrong once they stopped.
 * Spelled `hover:`, not `group-hover:`: the row IS the `group`, and Tailwind's
 * group variant only matches a group's DESCENDANTS. Either way it is
 * hover-device-only, so touch layouts never pay for it.
 *
 * 98px is the cluster (7px right edge + three chips + the gaps) plus a little
 * air, and it is the number the session rows reserve for the same trio, so a
 * title truncates at one place in the rail rather than 12px
 * earlier on the families that share this row.
 */
export const SIDEBAR_WS_ROW = utilityClassName(
  `flex items-center ${SIDEBAR_RAIL_GAP} hover:pr-[98px]`,
);

/**
 * Pin + snooze + archive, floated over the row's right edge so revealing them can never
 * change the row's height. The cluster used to wear an opaque plate, because a
 * long title runs under it; it doesn't need one — the row itself now reserves
 * that space on hover (see {@link SIDEBAR_WS_ROW}), so the title has
 * re-truncated clear of the actions by the time they appear. A solid chip would
 * also cut a hole in the translucent row underneath it.
 *
 * Resting `display` is the CALL SITE's, because it is the one thing that
 * differs between a live row (hover only), a row whose swipe action is open
 * (never) and an archived row on touch (always).
 */
export const SIDEBAR_WS_ACTIONS = utilityClassName(
  "absolute top-1/2 right-[7px] -translate-y-1/2 items-center gap-1 rounded-sm",
);

/**
 * The hover-only reveal. `group-hover` is gated to real hover devices by
 * Tailwind, which is exactly what the `@media (hover: hover)` around the old
 * rule was for: on touch a sticky first-tap `:hover` would otherwise expose
 * actions that live behind the swipe gesture there.
 */
export const SIDEBAR_WS_ACTIONS_HOVER = utilityClassName(
  "hidden group-hover:inline-flex",
);

/**
 * An archived row carries no swipe gesture — that is a live-row affordance —
 * so its unarchive/pin pair is the only way back from the band and has to stay
 * visible on touch. Resting rather than hover-revealed, so it drops the plate
 * (which would read as a chip on every row) and the title reserves the space
 * instead.
 */
export const SIDEBAR_WS_ACTIONS_TOUCH = "[@media(hover:none)]:inline-flex";

/**
 * One icon button in that cluster — the same box the session rows' pin and
 * archive wear (ROW_ACTION in sidebar/SidebarItem.tsx), so one hover chip
 * covers the whole rail. It was a flat 32px here while the session rows next
 * to it painted 26, which showed as two different chip heights on one column;
 * at the compact density 32 was also TALLER than the 30px row, so the chip
 * overhung the row's own hover pill by a pixel at each edge and read as a
 * second, competing pill rather than a button inside one.
 *
 * The size is {@link SIDEBAR_DENSITY_VARS}'s, so it steps down with the line
 * height and keeps its 5px / 3px margin inside the row at either setting.
 * `rounded-md` against the row's `rounded-row` is roughly concentric at both:
 * the chip's corner plus the air around it lands on the row's own.
 *
 * Its colour is the call site's: a pinned action stays accent even under the
 * pointer, and a Support row's "mark done" tints green rather than plain —
 * three `color` declarations that used to be settled by where their rules sat
 * in the sheet relative to each other.
 */
export const SIDEBAR_WS_ACTION = utilityClassName(
  `inline-flex size-[var(--sidebar-row-action,26px)] cursor-pointer items-center justify-center rounded-md ${SIDEBAR_ROW_CHIP}`,
);

/**
 * Compact last-activity time. It has no `display` of its own on purpose: as a
 * flex item it blockifies, and `text-right` is what right-aligns the digits at
 * rest, while `justify-end` is what right-aligns them once a reveal turns it
 * into a flex box. When something precedes it, that element's own
 * `margin-left: auto` has already pushed the pair right — a second auto margin
 * would split the free space and strand one of them mid-row.
 */
export const SIDEBAR_WS_TIME = utilityClassName(
  "ml-auto min-w-[28px] flex-[0_0_auto] justify-end pr-1.5 text-right text-meta text-faint desktop:min-w-[34px] desktop:pr-1",
);

/** Hidden at rest and revealed on row hover. The room for the action cluster is
 *  the row's own (see {@link SIDEBAR_WS_ROW}), so this no longer carries a
 *  margin of its own. Call sites that need an always-visible time omit this. */
export const SIDEBAR_WS_TIME_HOVER = utilityClassName(
  "hidden group-hover:inline-flex",
);

/**
 * Live "in progress" elapsed ticker — it sits where the time badge would, in
 * the in-progress colour, with tabular figures so the digits don't jitter as
 * they tick, and yields the slot to the hover actions.
 *
 * The phone size is its own: the run clock is text, not a glyph, so a hard
 * 28px box with centred digits overflowed on both sides. It sizes to its
 * digits and pins them to the gutter's inner edge, 6px short of the column
 * like every glyph above it. It reads in one unit ("42s", "12m", "1h 4m" —
 * see formatDuration), so it stays about as wide as the idle time badge it
 * stands in for instead of growing a clock's worth of digits.
 */
export const SIDEBAR_WS_TICKER = utilityClassName(
  "ml-auto min-w-[28px] flex-[0_0_auto] justify-end pr-0.5 text-right text-meta tabular-nums text-yellow group-hover:hidden desktop:min-w-[34px] desktop:pr-1",
);

/**
 * Teammates focused on this row's work, as the same overlapping pile used by
 * Feed. The call site gives earlier faces the higher stack and rings every
 * squircle in this surface colour, so left-to-right reading order also stays
 * front-to-back. The solid ring follows the exact precomposited row surface,
 * including the extra layer where selection and hover meet, instead of cutting
 * a sidebar-coloured halo through it.
 */
export const SIDEBAR_WS_FACES =
  utilityClassName(
    "flex shrink-0 items-center [--sidebar-face-ring:var(--sidebar-bg)] ",
  ) +
  "group-hover:[--sidebar-face-ring:var(--sidebar-row-hover)] " +
  "group-data-[selected]:[--sidebar-face-ring:var(--sidebar-row-selected)] " +
  "group-hover:group-data-[selected]:[--sidebar-face-ring:var(--sidebar-row-selected-hover)]";
export const SIDEBAR_WS_FACE = "[&:not(:first-child)]:-ml-1.5";

/**
 * Slack-style unsent-draft pencil. Its left margin is the call site's: on a
 * workspace row it pins itself to the right edge, unless a ticker or a snooze
 * countdown already did that pushing.
 */
export const SIDEBAR_WS_DRAFT = utilityClassName(
  "inline-flex flex-[0_0_auto] items-center text-dim",
);

/**
 * Wake countdown on a snoozed workspace row (moon + "1h"). It stands in for
 * the idle time badge, so it rests in that same right-edge slot, matches its
 * type, and yields to the pin/archive actions like every other trailing badge.
 */
export const SIDEBAR_WS_SNOOZE = utilityClassName(
  "ml-auto inline-flex flex-[0_0_auto] items-center gap-1 text-meta tabular-nums text-faint group-hover:hidden",
);

/**
 * ── Swipe rows ──────────────────────────────────────────────────────────────
 * The phone swipe shell around a workspace or session row: swipe left reveals
 * Archive, swipe right reveals Star; a long press still opens the full action
 * sheet. The wrapper carries the 2px gap between rows, so the row inside it
 * must not add its own or wrapped rows would gap twice.
 *
 * `rounded-row` is what clips the revealed actions to the row's own corner —
 * and, because base.css grants `corner-shape: squircle` to every `rounded-*`
 * class, it is also what lets this name drop out of the hand-written list of
 * legacy classes base.css squircles there.
 */
export const SIDEBAR_SWIPE_ROW = utilityClassName(
  "relative mt-0.5 overflow-hidden rounded-row",
);

/**
 * One revealed action behind the row. Hidden until the gesture opens its side,
 * and only on touch — on a hover device the same two jobs are the row's hover
 * actions, and a mouse can never open this. Its width tracks the drag through
 * `--swipe-action-w`, written straight onto the wrapper per frame.
 */
export const SIDEBAR_SWIPE_ACTION =
  // `border-none`, not `border-0`: the latter zeroes the width but leaves
  // the style at Tailwind's `solid` default, where the `border: 0` this
  // replaced computed to `none`. Width resolves to 0 under either.
  utilityClassName(
    "absolute top-0 bottom-0 z-0 hidden w-[var(--swipe-action-w,82px)] flex-col items-center justify-center gap-0.5 border-none text-meta font-semibold will-change-[width] [&>svg]:shrink-0",
  );

/** Revealed because the gesture opened this side. Touch only, as above. */
export const SIDEBAR_SWIPE_ACTION_OPEN = "[@media(hover:none)]:flex";

/** The action grows and shrinks with the finger, except while the finger is
 *  actually down — a transition there would lag the drag by a frame. */
export const SIDEBAR_SWIPE_ACTION_TRANSITION = utilityClassName(
  "transition-[width] duration-(--dur) ease-(--ease)",
);

/**
 * Each side carries its own fill AND its own ink, so exactly one `text-*` ever
 * lands on the button. Kept off {@link SIDEBAR_SWIPE_ACTION}: a shared
 * `text-white` there plus a per-side override is two colour utilities on one
 * element, and which of those wins is Tailwind's output order, not the order
 * they are written.
 */

/** Destructive, and on the trailing edge because the swipe travels left. */
export const SIDEBAR_SWIPE_ACTION_ARCHIVE = utilityClassName(
  "right-0 bg-red text-white",
);

/** Reversible snooze filing on the trailing edge. Quieter than Archive. */
export const SIDEBAR_SWIPE_ACTION_SNOOZE = utilityClassName(
  "right-0 bg-active text-fg",
);

/** Pin, on the leading edge. Dark ink: the yellow is too light for white. */
export const SIDEBAR_SWIPE_ACTION_STAR = utilityClassName(
  "left-0 bg-yellow text-[#17130a]",
);

/** Already pinned — the same action in the accent, so the swipe reads as a
 *  toggle rather than as a second way to pin. */
export const SIDEBAR_SWIPE_ACTION_STAR_ON = utilityClassName(
  "left-0 bg-accent text-on-accent",
);

export const SIDEBAR_STATUS_DOT = {
  /** Yellow to match the "In progress" lane — green means "In review". */
  running:
    "bg-yellow animate-[pulse_1.4s_ease-in-out_infinite] motion-reduce:[animation-duration:1.4s]! motion-reduce:[animation-iteration-count:infinite]!",
  /** A stopped run is actionable, but it is not a question for the person. */
  failed: "bg-red shadow-[0_0_6px_var(--red)]",
  waiting:
    "bg-blue shadow-[0_0_6px_var(--blue)] animate-[pulse_1.2s_ease-in-out_infinite] motion-reduce:[animation-duration:1.2s]! motion-reduce:[animation-iteration-count:infinite]!",
  idle: "bg-faint",
} as const;
