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
  "relative border border-[color:color-mix(in_srgb,var(--composer-border)_35%,transparent)] bg-[var(--composer-surface)] shadow-[var(--composer-shadow)] transition-[border-color,box-shadow] " +
  "desktop:border-transparent desktop:[--smooth-ring-color:var(--composer-border)] desktop:smooth-shadow-ring-soft";

/** Resting/expanded box. `--composer-inset-left` is read by the "+" menu to
 *  line its left edge up with the composer's outer edge rather than the
 *  button's, so it travels with the padding it describes. */
export const composerBoxExpanded =
  "rounded-[var(--composer-radius)] px-3.5 pt-3.5 pb-2.5 [--composer-inset-left:15px] phone:px-3 phone:pt-2.5 phone:pb-[9px] phone:[--composer-inset-left:13px]";

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
 *  `rounded-[999px]` rather than `rounded-full`, and the difference is not
 *  cosmetic: base.css grants `corner-shape: squircle` to
 *  `[class*="rounded-"]:not([class*="rounded-full"])`, so `rounded-full` is
 *  precisely the one spelling that opts OUT of the squircle. The pill is a
 *  squircle — `.composer` used to say so with `corner-shape: var(--cs)` — and
 *  `rounded-full` silently flattened it to a plain capsule. Same radius either
 *  way; only the corner curve differs. Installed phone PWAs override that
 *  curve to `round` in base.css, while keeping this same capsule geometry. */
export const composerBoxMinimized =
  "mx-3.5 flex items-center gap-1 rounded-[999px] p-1 [--composer-inset-left:5px]";

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
  "block max-h-[320px] min-h-0 w-full resize-none border-none bg-transparent text-body leading-[1.55] outline-none phone:max-h-[240px] phone:text-input-phone";
/** The only room a mention pill can take is the space character beside it: its
 *  wash is painted rather than laid out, and 3.7px of natural space has to
 *  cover both the pill's own padding and the gap to the next word. Widening
 *  the space is the only way to give that chip a margin, and it goes on the
 *  field as well as the mirror, so the painted text stays under the caret it
 *  belongs to.
 *
 *  It is worn only while the draft actually holds a mention (Composer.tsx),
 *  because every space pays it, not just the two beside the pill. A sentence
 *  set this way on its own reads as broken word spacing, which is what a
 *  permanent 3.5px did. Scoped, the cost lands on the draft that wanted the
 *  chip and ordinary prose keeps the type's own spacing.
 *
 *  Session pills deliberately do not wear it. A pasted link often sits inside
 *  a full sentence, where widening every space is more distracting than the
 *  extra pixel of air buys the pill. */
export const composerMentionSpacing = "[word-spacing:3.5px]";
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
 *  composer and pushed the send button off its right edge on phones. Phones
 *  also pull it to the front of the row, next to the "+". */
export const composerToolbarSelect =
  "inline-flex min-w-0 shrink phone:order-[-1]";
/** The pill's toolbar-only metrics: it may shrink to a 34px stub here (the
 *  new-session footer lets it go to 0 instead), and phones tighten its
 *  padding and cap it so the whole row fits without clipping the send. */
export const composerToolbarPill =
  "shrink min-w-[34px] phone:max-w-[136px] phone:px-[9px]";

/* ── Toolbar popover menus ─────────────────────────────────────────
   The popup surface for the "+" add menu and the send-later menu, and the
   rows that go in them. */
/** One row in those menus. The row used to stay in the stylesheet because
 *  SessionViewer contributes one through the composer's `menuExtra` and
 *  SchedulePrompt contributes two more — but all three hosts are components,
 *  so the row lives here and they import it.
 *
 *  Only the deviations from the base button reset in styles/base.css are
 *  written: that already supplies `cursor: pointer`, `background: none`,
 *  `border: none` and zero padding. */
export const composerMenuItem =
  "flex w-full items-center gap-[9px] rounded-control px-[9px] py-[7px] text-left text-control-label text-fg hover:bg-hover";
/** The row's leading glyph. A fixed 20px column so the labels line up however
 *  wide the icons draw. */
export const composerMenuIcon =
  "inline-flex w-5 items-center justify-center text-label text-dim";
/** The surface those rows sit on. Edge and cast come from the same ring the
 *  Base UI menus use (ui/menu.tsx) rather than a `border-line-strong` hairline:
 *  that line is drawn for a control resting IN the page, and on a floating
 *  popup it read a step darker than every other menu on screen. */
export const composerMenuPopup =
  "absolute bottom-[calc(100%+6px)] z-40 rounded-lg bg-popup-glass [backdrop-filter:var(--popup-blur)] [--smooth-ring-color:var(--popup-ring)] p-1 smooth-shadow-ring-md";
/** The menu's own floor width. Kept out of the surface above because a second
 *  `min-w-*` on the same element would not compose — the send-later menu is
 *  wider (it lists pending messages), and whichever Tailwind emitted last would
 *  win rather than the one written last. */
export const composerMenuWidth = "min-w-[172px]";
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
  "inline-flex size-8 shrink-0 items-center justify-center rounded-full leading-none transition-[background-color,border-color,color,filter,scale] enabled:active:scale-[0.96] disabled:cursor-default disabled:opacity-35 phone:size-10";
/** Ordinary send: the accent plate. Hover takes `--accent-hover` rather than
 *  brightening — brightening a wash read as a disabled state. */
export const composerSendDefault =
  "bg-accent text-on-accent enabled:hover:bg-accent-hover";
/** Busy + queue keeps the send plate and changes the glyph. The old 2px ring
 *  read like a selected toggle, then hovered to dark-on-dark because its ink
 *  did not invert with the fill. */
export const composerSendQueue = composerSendDefault;
/** Busy + steer keeps the full accent plate too; its up-arrow glyph separates
 *  it from queue's return arrow without making the action look secondary. */
export const composerSendSteer = composerSendDefault;
/** Stop: the only full-strength red plate. */
export const composerSendStop =
  "bg-red text-white enabled:hover:brightness-[1.12]";
/** Inside the 50px resting pill a 40px disc is a blob against the hairline
 *  glyphs beside it. Keep the target, shrink the fill: padding plus
 *  background-clip paints a 32px disc without moving the hit area. */
export const composerSendMinimizedFill = "phone:bg-clip-content phone:p-1";

/* ── File attachment chips ────────────────────────────────────────
   Shared by the composer's staged attachments (removable) and a user turn's
   download chips in the transcript (a link). The right padding is deliberately
   not part of the card: the composer needs room for its × button. */
export const fileChipRow = "mb-2 flex flex-wrap gap-2";
export const fileChipCard =
  "relative inline-flex max-w-[240px] items-center gap-[9px] rounded-lg border border-line-strong bg-[var(--bg-hover)] py-1.5 pl-1.5";
/** Composer: leaves room for the absolutely-placed remove button. */
export const fileChipCardPaddingRemovable = "pr-[26px]";
/** Transcript: nothing to remove there, and `.msg-file-card` asked for 10px —
 *  but that rule sat ABOVE `.composer-file-card`'s padding shorthand in the
 *  stylesheet at equal specificity, so it never applied. This keeps what the
 *  chip has always rendered; closing it up is a design change, not a migration. */
export const fileChipCardPadding = "pr-[26px]";
export const fileChipThumb =
  "inline-flex size-[34px] shrink-0 items-center justify-center rounded-control bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[10px] font-bold tracking-[0.02em] text-accent";
export const fileChipMeta = "flex min-w-0 flex-col gap-px";
/** The chip's title. 13px (text-label) rather than the stylesheet's off-scale
 *  12px — it is interface copy, and the card's height comes from the 34px
 *  badge, so nothing reflows. */
export const fileChipName = "truncate text-label text-fg";
export const fileChipSub = "text-meta text-faint";

/* ── Flap edges ───────────────────────────────────────────────────
   Shared by both flaps that tuck under the composer (the queue flap below and
   the run-status flap in components/ComposerAgents.tsx). */
/** The hairline a flap draws, matched to the edge the composer actually paints.
 *
 *  The composer carries the border token at 35% strength: through a smooth
 *  ring on desktop and a solid hairline on phone. Drawing the flap at full
 *  strength made the panel behind it about three times darker than the input
 *  in front. Use the same mix everywhere so the two layers keep one edge. */
export const composerFlapBorder =
  "pwa-composer-edge border-[color:color-mix(in_srgb,var(--composer-border)_35%,transparent)]";

/* ── The queue flap ───────────────────────────────────────────────
   The flap that folds out from behind the composer: a dimmer panel flush with
   the composer's edges, rounded only on top, its bottom tucked under the
   composer box. The negative bottom margin is what does the tucking — the
   composer is a later positioned sibling, so it paints over the seam.

   Its top corner reads `--composer-radius` rather than a `rounded-*` step,
   so the flap keeps matching the box it is flush with when that token moves.

   `border-x border-t` rather than `border` + `border-b-0`: the bottom edge has
   to be `border-bottom-style: none`, not a zero-width solid, because the
   composer's own hairline continues it. `border-b-0` leaves the style behind. */
export const composerQueue =
  "relative -mb-3.5 flex flex-col gap-2 rounded-t-[var(--composer-radius)] border-x border-t " +
  composerFlapBorder +
  " bg-[color-mix(in_srgb,var(--bg-panel)_80%,var(--composer-surface))] px-3.5 pt-2.5 pb-[26px]";
export const composerQueueTitle = "text-meta font-semibold text-faint";
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
/** In flow at the row's trailing edge, so each row reserves exactly the width
 *  its own actions need — it used to be absolutely positioned over a fixed
 *  128px of padding, which clipped the rows carrying a pill into the text.
 *  Written before the message in the markup (it owns the row's controls) and
 *  painted after it, hence `order-1`. The negative block margins keep the 36px
 *  cluster from setting the height of a one-line row. */
export const composerQueueActions =
  "order-1 z-[1] -mt-[11px] -mb-2.5 inline-flex shrink-0 items-center gap-0.5";
/** A compact 36px action with the same `rounded-control` corner and inset
 *  hover wash as the composer's toolbar buttons. It remains a separate
 *  constant because the wash sits 3px in rather than 4px, there is no
 *  transparent border holding layout, and disabled actions fade further. */
export const composerQueueAction =
  "relative inline-flex size-9 items-center justify-center rounded-control text-dim disabled:cursor-default disabled:opacity-35 enabled:hover:text-fg " +
  "before:absolute before:inset-[3px] before:z-0 before:rounded-[calc(9px*var(--rf))] before:[corner-shape:var(--cs)] before:transition-[background] before:content-[''] enabled:hover:before:bg-hover " +
  "[&>*]:relative [&>*]:z-[1]";
/** Destructive action: the wash goes red rather than neutral. */
export const composerQueueActionDanger =
  "enabled:hover:text-red enabled:hover:before:bg-red-soft";
/** Steer stays accent at rest AND under the cursor — it is the one action on
 *  the row that is not a correction, and the shared hover would have dropped
 *  it back to plain ink. */
export const composerQueueActionSteer = "text-accent enabled:hover:text-accent";
/** A status readout, not a control: "Steered". Genuinely
 *  round (the stylesheet spelled a bare 999px with no `corner-shape`), so
 *  `rounded-full` rather than `rounded-[999px]`. */
export const composerQueuePill =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-transparent bg-accent-soft px-[13px] text-label font-semibold text-accent";
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
  "block size-full rounded-[calc(8px*var(--rf))] border border-line object-cover";
export const composerQueueImageCount =
  "absolute -right-1 -bottom-1 h-[18px] min-w-[18px] rounded-full border border-line bg-raised px-1 text-center text-[10px] font-bold leading-4 text-dim";
/** The message itself, one line with an ellipsis. It is genuine user content,
 *  so `.selectable` opts it back in from the app chrome's global selection
 *  block and restores the touch copy callout. Size and leading stay in one
 *  string with leading last: tailwind-merge files `leading` as a conflict of
 *  `font-size`, so a later `text-*` would drop an earlier `leading-*`. */
export const composerQueueBody =
  "selectable min-w-0 flex-1 cursor-text truncate text-label leading-[1.45]";
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
