/**
 * Shared Tailwind class maps for the composer family (the `composer-*` block
 * that used to live in styles/legacy.css).
 *
 * Two rules shaped how these are written, and breaking either one fails
 * silently — no build error, just the wrong pixels:
 *
 * 1. **Every class is spelled out in full, literal text.** Tailwind scans
 *    source as text, so an interpolated class (`` `text-${tone}` ``) or one
 *    assembled from a constant is never generated. Add a variant by adding a
 *    literal entry here, never by building the string.
 * 2. **A base string carries geometry only; colour lives in the variant.** Two
 *    competing colour utilities on one element do not compose — the browser
 *    takes whichever Tailwind happened to emit last, not the one written last.
 *    Same for any pair that sets the same property (which is why the card's
 *    right padding is separate from the card itself: the composer needs room
 *    for a remove button, a transcript chip does not).
 */

/* ── The composer box ──────────────────────────────────────────────
   `.composer` stays on the markup as a hook: legacy.css still reaches through
   it into controls this family does not own (`.composer.composer-min
   .palette-icon-btn`, whose ::before wash is styled from the stylesheet). The
   declarations below are what that rule used to paint. */
export const composerBox =
  "relative border border-composer-line bg-[var(--composer-surface)] shadow-composer transition-[border-color,box-shadow] " +
  "desktop:border-transparent desktop:[--smooth-ring-color:var(--composer-border)] desktop:smooth-shadow-ring-soft";

/** Resting/expanded box. `--composer-inset-left` is read by the "+" menu to
 *  line its left edge up with the composer's outer edge rather than the
 *  button's, so it travels with the padding it describes. */
export const composerBoxExpanded =
  "rounded-composer px-3.5 pt-3.5 pb-2.5 [--composer-inset-left:15px] phone:px-3 phone:pt-2.5 phone:pb-[9px] phone:[--composer-inset-left:13px]";

/** Phone resting pill: one row, even 4px inset, held well clear of the screen
 *  edges. The inset is wider than the expanded box's on purpose: at rest the
 *  composer is a short capsule floating over the transcript, and running it
 *  edge to edge made it read as a bar rather than a pill. The internal padding
 *  stays at 4px, so the pill gets smaller through width, not tighter spacing.
 *  Matches the native iOS composer, which steps its resting pill in by the
 *  same 8pt on each side.
 *
 *  Motion animates the radius between this and the expanded box; the class is
 *  here so a first paint (and any non-animated host) lands on the same shape.
 *
 *  `rounded-capsule` rather than `rounded-full`, and the difference is not
 *  cosmetic: base.css grants `corner-shape: squircle` to
 *  `[class*="rounded-"]:not([class*="rounded-full"])`, so `rounded-full` is
 *  precisely the one spelling that opts OUT of the squircle. The pill is a
 *  squircle — `.composer` used to say so with `corner-shape: var(--cs)` — and
 *  `rounded-full` silently flattened it to a plain capsule. Same radius either
 *  way; only the corner curve differs. Installed phone PWAs override that
 *  curve to `round` in base.css, while keeping this same capsule geometry. */
export const composerBoxMinimized =
  "mx-3.5 flex items-center gap-1 rounded-capsule p-1 [--composer-inset-left:5px]";

/* ── The draft field ──────────────────────────────────────────────
   `.composer-textarea` stays on the markup as a hook too: it is read as a
   class NAME by the sidebar swipe guard (lib/sidebar-swipe.ts) and by
   SessionViewer's keyboard handlers, which skip global shortcuts while the
   caret is in the composer.

   The mirror div that paints code tints behind the field (`.composer-hl`)
   shares these metrics exactly — any difference in font, padding or wrap
   desyncs the caret from the painted glyphs — so both read the same strings. */
/** The draft field and the code/mention mirror behind it both take this, which
 *  is what keeps them glyph-identical. */
export const composerTextarea =
  "block max-h-[320px] min-h-0 w-full resize-none border-none bg-transparent text-body leading-body outline-none phone:max-h-[240px] phone:text-input-phone";
export const composerTextareaPadding = "px-0 pt-0.5 pb-1";
/** In the resting pill the field is one row inside a 4px-inset box, so it
 *  carries the horizontal breathing room and no vertical padding at all. */
export const composerTextareaPaddingMinimized = "px-1 py-0";

/* ── The toolbar row ──────────────────────────────────────────────
   The row under the draft: "+", the mode marker, a spacer, the model pill,
   the mic and the send disc.

   The stylesheet pinned every DIRECT child at `flex-shrink: 0` from here, so
   that when the row ran out of room the model/effort pill gave way (its label
   ellipsizes) and never the icon buttons or the send button, which would
   otherwise be pushed past the composer's edge on phones. That is now written
   on the children themselves rather than as `[&>*]:shrink-0`: a descendant
   utility and a child's own `shrink` are the same specificity, so the pill's
   opt-back-in would have depended on the compiled sheet's order. */
export const composerToolbar =
  "relative mt-2.5 flex items-center gap-2 phone:mt-1.5 phone:gap-1.5";
/** The seam a scrolling draft earns.
 *
 *  Past the field's cap the draft scrolls inside the composer, and the last
 *  visible line is cut mid-glyph a few pixels above the toolbar — text and
 *  controls read as one run, with the cut looking like a rendering fault. The
 *  hairline says the two are different regions and that the text continues
 *  under it. It is the same rule the palette draws over its footer
 *  (NewSession) and the app draws under its top bars (SCROLL_EDGE_DIVIDER),
 *  earned on the same terms: only while content actually sits beyond the edge,
 *  so a draft that fits keeps an undivided box.
 *
 *  A pseudo-element rather than a `border-t`, because a border that appears
 *  would push the toolbar down a pixel each time you scrolled past the fold.
 *  It bleeds past the composer's own padding to the box's inner edges — inset
 *  to the text column it reads as a rule under a paragraph rather than as the
 *  floor of the scrolling region.
 *
 *  It is hung at the FIELD's bottom edge (the toolbar's whole top margin,
 *  negated) rather than at the toolbar's own top, so it lands on the floor of
 *  the scrolling text and hands the entire gap to the controls below it. Sat
 *  at the toolbar's edge instead, the gap was split: the line stood off the
 *  text it belongs to and pressed against the send disc, whose fill reaches
 *  much closer than the hairline glyphs beside it do. Where it is now the
 *  toolbar keeps equal air above and below — the composer's own bottom padding
 *  is the same 10px (9px on phones) — so the row reads as its own strip.
 *
 *  `data-scroll-under` is written imperatively by the composer's scroll
 *  handler, for the reason the fade at the other edge is: a state round-trip
 *  lands the line a frame late, which during momentum scroll reads as a
 *  flicker. */
export const composerToolbarScrollDivider =
  "before:pointer-events-none before:absolute before:-inset-x-3.5 before:-top-2.5 " +
  "before:h-px before:bg-divider before:opacity-0 before:transition-opacity " +
  "before:content-[''] data-[scroll-under]:before:opacity-100 " +
  "phone:before:-inset-x-3 phone:before:-top-1.5";
/** Resting phone pill: `display: contents` lifts the toolbar's buttons into
 *  the composer's own flex row, so the textarea can sit between the "+" and
 *  the mic/send and `order` can sequence them. Combine through `cn()` —
 *  tailwind-merge is what drops the `flex` above. */
export const composerToolbarMinimized = "contents";
/** The one flexible item in the row, and the wrapper it has to be granted to:
 *  the model pill sits inside a Motion layout box, and pinning the shrink on
 *  the pill itself left the WRAPPER rigid — the row stayed wider than the
 *  composer and pushed the send button off its right edge on phones. It
 *  follows the "+" in source order, on every width. */
export const composerToolbarSelect = "inline-flex min-w-0 shrink";
/** The pill's toolbar-only metrics: it may shrink to a 34px stub here (the
 *  new-session footer lets it go to 0 instead), and phones tighten its
 *  padding. No width cap: the toolbar pins every other child at
 *  flex-shrink 0, so the pill already gives way exactly when the row would
 *  otherwise clip the send. A fixed cap on top of that truncated the model
 *  name while the row still had room to spare. */
export const composerToolbarPill =
  "shrink min-w-[34px] max-w-none phone:px-[9px]";

/* ── Toolbar popover menus ─────────────────────────────────────────
   The popup surface for the "+" add menu and the send-later menu, and the
   rows that go in them. */
/** Where the "+" and send-later menus float: above their trigger, over the
 *  page chrome. Their surface and rows are the shared menu's (ui/popup-styles
 *  `surface`, `scroll`, `item` + `plainItem`, `itemIcon`); they are hand-built
 *  only because a Base UI menu would take focus and drop the phone keyboard. */
export const composerMenuPlacement =
  "absolute bottom-[calc(100%+6px)] z-chrome";
/** Default anchoring: the menu hangs off the right edge of its trigger. */
export const composerMenuAnchorRight = "right-0";
/** The "+" sits at the LEFT of the toolbar, so its menu grows rightward from
 *  the composer's outer left edge (not the button's — the toolbar lives inside
 *  the composer's padding, which left the menu inset and off-axis). */
export const composerMenuAnchorLeft =
  "left-[calc(-1*var(--composer-inset-left,17px))]";

/* ── The send disc ────────────────────────────────────────────────
   The one filled control in the toolbar and the one place a circle is right:
   it is the only control whose whole job is "commit this", and roundness is
   what keeps a full-strength fill from feeling heavy.

   Geometry only — each state below brings its own fill, ink and edge. The
   40px phone size is what the last of the three (!) competing phone blocks in
   legacy.css resolved to. */
export const composerSend =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-full leading-none transition-[background-color,border-color,color,filter,scale] enabled:active:scale-press disabled:cursor-default disabled:opacity-35 phone:size-10";
/** Ordinary send: the accent plate. Hover takes `--accent-hover` rather than
 *  brightening — brightening a wash read as a disabled state. */
export const composerSendDefault =
  "bg-accent text-on-accent enabled:hover:bg-accent-hover";
/** Stop: the only full-strength red plate. */
export const composerSendStop =
  "bg-red text-white enabled:hover:brightness-[1.12]";
/** Inside the 50px resting pill a 40px disc is a blob against the hairline
 *  glyphs beside it. Keep the target, shrink the fill: padding plus
 *  background-clip paints a 32px disc without moving the hit area. */
export const composerSendMinimizedFill = "phone:bg-clip-content phone:p-1";

/* ── Flap edges ───────────────────────────────────────────────────
   Shared by both flaps that tuck under the composer (the queue flap below and
   the run-status flap in components/ComposerAgents.tsx). */
/** The hairline a flap draws, matched to the edge the composer actually paints.
 *
 *  The composer carries the border token at 35% strength: through a smooth
 *  ring on desktop and a solid hairline on phone. Drawing the flap at full
 *  strength made the panel behind it about three times darker than the input
 *  in front. Use the same mix everywhere so the two layers keep one edge. */
export const composerFlapBorder = "pwa-composer-edge border-composer-line";

/* ── The queue flap ───────────────────────────────────────────────
   The flap that folds out from behind the composer: a dimmer panel flush with
   the composer's edges, rounded-xs only on top, its bottom tucked under the
   composer box. The negative bottom margin is what does the tucking — the
   composer is a later positioned sibling, so it paints over the seam.

   Its top corner reads `--composer-radius` rather than a `rounded-*` step,
   so the flap keeps matching the box it is flush with when that token moves.

   `border-x border-t` rather than `border` + `border-b-0`: the bottom edge has
   to be `border-bottom-style: none`, not a zero-width solid, because the
   composer's own hairline continues it. `border-b-0` leaves the style behind. */
export const composerQueue =
  "relative -mb-3.5 flex flex-col gap-2 rounded-t-composer border-x border-t " +
  composerFlapBorder +
  " bg-[var(--composer-flap-surface)] px-3.5 pt-2.5 pb-[26px]";
export const composerQueueList = "flex flex-col gap-2";
/** One queued/steered row. The floor is one line of body text, so a row whose
 *  point is a single message does not inherit the 40px action cluster's
 *  height. Centered rather than top-aligned: the body is a single truncated
 *  line, so the tallest thing in the row is whatever attachment preview it
 *  carries — top alignment left a 34px thumbnail hanging 9px below the text
 *  and the actions. Nothing here ever wraps, so there is no first-line to
 *  align to. */
export const composerQueueItem =
  "relative flex min-h-[calc(13px*1.45)] items-center gap-2";
/** The hairline between rows. The stylesheet drew it with
 *  `.composer-queue-item + .composer-queue-item`, which a utility cannot
 *  spell against itself — so each list applies it from its own index. The
 *  three groups (steered, queued, sending) are separated by non-row elements,
 *  so "not first in ITS group" is exactly what the sibling selector matched. */
export const composerQueueItemSeparated = "border-t border-line pt-2";
/** Drag-to-reorder: the whole row is the grab surface. The action buttons
 *  still take clicks — a drag only starts once the pointer actually moves. */
export const composerQueueItemDraggable =
  "cursor-grab touch-none active:cursor-grabbing";
/** Optimistic busy send: a transient readout, not a badge or control. Keeping
 *  it borderless prevents the in-flight state from reading as a pill button. */
export const composerQueueSendingStatus =
  "inline-flex h-8 shrink-0 items-center px-2 text-label font-medium text-faint";
/** The label carries its own motion instead of standing next to a spinner: a
 *  highlight crosses the word, which reads as "not settled yet" without adding
 *  a second moving thing to a row that already sits in a list. TextShimmer
 *  keeps the letters at `--text-faint` while its masked copy supplies a
 *  `--text-dim` crest. Settled states ("Queued") do not take it. */
export const composerQueueSendingShimmer =
  "text-faint [--text-shimmer-highlight:var(--text-dim)] " +
  "[--text-shimmer-duration:1.8s] [--text-shimmer-easing:linear]";
export const composerQueueContent = "flex min-w-0 flex-1 items-center gap-2";
/** The thumbnail keeps its size — shrunk to the 19px line box it stops being a
 *  recognizable preview, and the `+N` badge below is nearly as tall as the
 *  image it counts. The row centers on it instead. */
export const composerQueueImage = "relative h-[34px] w-[46px] flex-none";
export const composerQueueImageThumb =
  "block size-full rounded-md border border-line object-cover";
export const composerQueueImageCount =
  "absolute -right-1 -bottom-1 h-[18px] min-w-[18px] rounded-full border border-line bg-raised px-1 text-center text-[10px] font-bold leading-4 text-dim";
/** The message itself, one line with an ellipsis. It is genuine user content,
 *  so `.selectable` opts it back in from the app chrome's global selection
 *  block and restores the touch copy callout. Size and leading stay in one
 *  string with leading last: tailwind-merge files `leading` as a conflict of
 *  `font-size`, so a later `text-*` would drop an earlier `leading-*`. */
export const composerQueueBody =
  "selectable min-w-0 flex-1 cursor-text truncate text-label leading-body";
/** Whose message it is. `github` outranks `human` — both were equally specific
 *  in the stylesheet and github came last. */
export const composerQueueBodyTone = {
  default: "text-fg",
  human: "text-[color-mix(in_srgb,var(--text)_88%,#1f9e8a)]",
  github: "text-dim",
  sending: "text-dim",
} as const;
/** The "from" label ahead of the body — a teammate's name, or "GitHub". */
export const composerQueueFrom = "mr-1.5 font-semibold text-faint";
/** The attachment note after a queued message's text: "· Pasted text +60 lines". */
export const composerQueuePasted = "whitespace-nowrap text-faint";
