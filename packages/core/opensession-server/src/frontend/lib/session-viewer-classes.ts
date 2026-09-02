/**
 * The session viewer's own chrome, as finished utility classes — what used to
 * be the `viewer-*` family in legacy.css, plus the banner row and the
 * delete-in-flight label that sit with it.
 *
 * Everything that used to be keyed off an ancestor is an arbitrary variant on
 * the element itself, so the whole subtree moves in one step: a compound
 * legacy selector outranks a single utility, and a half-migrated element
 * quietly keeps its old styling.
 *
 * Three class names stay on the markup as bare hooks with no styling of their
 * own, because things outside this family name them:
 *
 *   · `viewer-header` — base.css insets the row past the traffic lights and the
 *     floating nav cluster when the desktop sidebar is collapsed
 *     (`html.wco .app-body.sidebar-collapsed .viewer-header`), a rule about an
 *     element in a platform state that cannot be a utility. Dragging the window
 *     by the row comes from `wco-chrome` beside it, the one name every
 *     top-of-pane row wears;
 *   · `viewer-header-actions` — lib/pr-tone-classes.ts spaces the PR chip off
 *     the row with `[.viewer-header-actions_&]:mx-1.5`;
 *   · `viewer-messages` — base.css's selection policy opts the whole transcript
 *     in, and MarkdownBody, VirtualTranscriptList and CodeHighlight all find
 *     their scroll container with `closest(".viewer-messages")`.
 *
 * One more joins them from the row's contents:
 *
 *   · `session-link` — lib/markdown.ts writes it into rendered agent output,
 *     where base.css styles the chip form (`.session-link[data-session-id]`).
 *     There is no JSX there to hang utilities on. The header's own links are a
 *     different element wearing the same name, and they carry their styling as
 *     utilities (SESSION_LINK below).
 *
 * `presence` used to be a fourth: the only rule that named it spaced the
 * facepile off the ⋯ cluster, and that margin now sits on VIEWER_PRESENCE
 * itself, so the name is gone from the markup rather than kept as a hook for
 * nothing.
 */

import { RAIL_GUTTER_CLASS } from "./message-rail";

/* ── Top bar ────────────────────────────────────────────────────────────── */

/**
 * Fixed height so the bar lines up with the sidebar's brand row instead of
 * growing with its tallest button — including when a tab strip follows, where
 * trimming the row to pull the labels together cost that alignment. The session
 * body's colour rather than the lifted topbar tint keeps the whole top region
 * reading as one surface — the PR strip sharing the row takes the same one.
 *
 * Nothing divides the bar from the content. The two share one fill, so the
 * transcript simply runs up under the row as it scrolls instead of meeting a
 * line, and the top of the session reads as one surface. A drawn hairline used
 * to close the bar off, and a scroll-driven wash before that. Both marked a
 * seam that did not need marking. The tab strip, when it follows the bar, still
 * carries its own baseline rule: that line is what the active tab's underline
 * rests on.
 */
export const VIEWER_HEADER =
  "viewer-header wco-chrome flex h-[var(--desktop-header-h)] min-w-0 shrink-0 items-center justify-between gap-3 " +
  "bg-surface px-4 " +
  // Collapsed desktop sidebar: the floating re-open + nav cluster overlays the
  // pane's left edge, so the row's text starts past it.
  "desktop:[.app-body.sidebar-collapsed_&]:pl-[148px] " +
  // On phones the bar is a set of floating pills inside the app header, not a
  // row of its own.
  "phone:[.app-header-actions_&]:h-auto phone:[.app-header-actions_&]:gap-1.5 " +
  "phone:[.app-header-actions_&]:bg-transparent " +
  "phone:[.app-header-actions_&]:p-0";

/** Workspace name + origin chip + status. Hidden on phones, where the ⋯ menu
 *  carries what it holds. */
export const VIEWER_TITLE =
  "flex min-w-0 items-center gap-2.5 font-medium phone:hidden";

/**
 * The workspace name. Capped so a long one clips instead of eating the whole
 * bar; OverflowFadeText softens that clipped edge. The shell makes the
 * surrounding header a native window drag region, so this opts out — its text
 * stays selectable and copyable.
 */
export const VIEWER_BRANCH =
  "min-w-0 max-w-[420px] -translate-y-px select-text overflow-hidden whitespace-nowrap text-item-title " +
  "[-webkit-touch-callout:default] " +
  "[html.wco_&]:[-webkit-app-region:no-drag] [html.wco_&]:[app-region:no-drag] " +
  "[html.desktop-shell_&]:[-webkit-app-region:no-drag] [html.desktop-shell_&]:[app-region:no-drag]";

/**
 * A crumb BEFORE the session's own name: the session a worker was spawned from.
 * It reads as the level above (dim, like the repo before it) and lights up on
 * hover because clicking it is the way back up. Narrower than the name it
 * precedes, since the name is what the bar is about.
 */
export const VIEWER_CRUMB_UP =
  "-mx-2 -my-[5px] max-w-[240px] shrink cursor-pointer overflow-hidden text-ellipsis rounded-[calc(6px*var(--rf))] px-2 py-[5px] " +
  "text-label font-medium text-dim transition-colors duration-[var(--dur-micro)] ease-[var(--ease)] " +
  "hover:bg-hover hover:text-fg";

/** Double-clickable to rename — hinted on hover without shifting the row. */
export const VIEWER_BRANCH_EDITABLE =
  "-mx-2 -my-[5px] cursor-text rounded-[calc(6px*var(--rf))] px-2 py-[5px] hover:bg-hover";

/** Inline rename input, sized to sit in place of the name. */
export const VIEWER_BRANCH_RENAME =
  "my-[-2px] min-w-0 max-w-[280px] rounded-[calc(8px*var(--rf))] border border-accent bg-surface " +
  "px-1 py-px font-[inherit] text-item-title text-[inherit] outline-none";

/**
 * The trailing controls. Icon buttons sit in a tight cluster so they read as
 * one group; the labelled items in the row (the Linear/Plain links, the
 * presence facepile, the PR chip) space themselves.
 *
 * `pwa-header-actions` lets base.css tune these controls only in an installed
 * PWA.
 */
export const VIEWER_HEADER_ACTIONS =
  // The tab strip overlaps the header's lower edge to tighten the two rows.
  // Keep every header action above that overlap so its bottom edge and hit area
  // remain intact.
  "viewer-header-actions pwa-header-actions relative z-[1] flex shrink-0 items-center gap-0.5 phone:justify-end " +
  // Phones give every control in the row a 44px touch target. Keyed off the
  // row rather than written on each control because these are shared
  // primitives (Button, and the source links below). A descendant selector also
  // lets this outrank the primitive's own padding, exactly as the legacy rule
  // did. `inline-flex` and `items-center` are not carried because the primitive
  // is already both on every viewport.
  "phone:[&_button]:min-h-11 phone:[&_button]:px-[11px] phone:[&_button]:py-[7px] " +
  "phone:[&_button]:text-label";

/** The presence facepile (Figma/Notion-style), just before Share. Labelled
 *  items in the row space themselves off the icon cluster; the icons keep the
 *  row's tight 2px gap. */
export const VIEWER_PRESENCE = "mx-1.5 flex items-center";

/**
 * One face in it. They overlap by 8px, while the call site matches Feed's
 * front-to-back order and full squircle ring. The first face keeps the row's
 * own left edge.
 */
export const VIEWER_PRESENCE_AVATAR = "-ml-2 first:ml-0";

/**
 * The Linear / Plain / feed links in the header: quiet outlined pills that
 * carry their source's hue. Each variant only re-tints the ink and the edge, so
 * it must come after the base string through `cn()` — two `text-*` utilities on
 * one element resolve by Tailwind's output order, not by the order written.
 *
 * The hues stay literal. They are the sources' brand colours (Linear's indigo,
 * Plain's teal), not steps of the app's palette, so there is no token to reach
 * for and swapping in one would be a redesign.
 */
export const SESSION_LINK =
  "session-link mr-1.5 rounded-control border border-line-strong px-[11px] py-[5px] " +
  "text-label font-semibold text-dim no-underline " +
  // Phones give it the same 44px touch target as the buttons beside it. These
  // sit on the link rather than on the row, where the buttons' copy lives,
  // because this is the element's own styling and nothing else wears the class
  // in this row. Only the declarations that actually change are written: the
  // 11px sides are already the resting value. A `phone:` variant beats the
  // unprefixed `py-[5px]` and `text-label` on the same element because Tailwind
  // emits every breakpoint variant after the unprefixed utilities.
  "phone:inline-flex phone:min-h-11 phone:items-center phone:py-[7px] phone:text-label";
export const SESSION_LINK_LINEAR =
  "border-[rgba(94,106,210,0.5)] text-[#7b86e8]";
export const SESSION_LINK_PLAIN =
  "border-[rgba(13,148,136,0.5)] text-[#5eead4]";

/** ⋯ overflow: the secondary actions collapse into the shared Menu popup when
 *  they would otherwise crowd the title. */
export const VIEWER_OVERFLOW = "relative inline-flex";

/**
 * A rule between two groups of the ⋯ menu. Most of that menu is conditional, so
 * a whole group can render nothing on a given session and a separator written
 * between groups lands doubled, or at the very top. Some rows decide their own
 * emptiness at runtime (Spin off needs an assistant turn, Preview needs its
 * status), so rather than predict it, each rule hides when it has no group
 * above it. `session-menu-sep` is the hook for that adjacent-sibling test and
 * carries nothing else.
 */
export const VIEWER_MENU_SEP =
  "session-menu-sep first:hidden [.session-menu-sep+&]:hidden";

/* ── Panes ──────────────────────────────────────────────────────────────── */

/**
 * Full-width review host: a flex child of the session column that stretches, so
 * the PrPanel (whose split is `height: 100%`) fills the whole area. Unlike the
 * transcript it doesn't self-pad for the phone's fixed header and docked tab
 * bar, so it is pushed below them instead.
 */
export const VIEWER_REVIEW_MAIN =
  "flex min-h-0 flex-1 flex-col " +
  "phone:pt-[calc(var(--pane-header-h)+var(--strip-clearance,0px))]";

/* ── Transcript ─────────────────────────────────────────────────────────── */

/**
 * Holds the scroll area plus the floating "Jump to latest" pill.
 *
 * Nothing is drawn between this and the bar above it on desktop. The transcript
 * runs up under the row and stops there, on the same fill, which is what makes
 * the top of the session read as one surface. Two earlier answers to the same
 * seam are gone: a scroll-edge wash driven by a CSS scroll timeline, which
 * dimmed the first legible rows, and the hairline that replaced it. Phones
 * still fade the transcript under their floating pills with a mask (see
 * VIEWER_MESSAGES), where the chrome overlays the content instead of sitting
 * above it.
 */
export const VIEWER_MESSAGES_REGION = "relative flex min-h-0 flex-1 flex-col";

/**
 * The scroll container.
 *
 * Never a sideways-pannable session: anything internally wide (code, tables)
 * scrolls inside its own pane. A flex column rather than block flow, because
 * WebKit paints cross-block selection as full-width bands across a block
 * container — it skips flex containers, so selection hugs the text. That is
 * also why the children need an explicit width: auto side margins centre them,
 * and in a flex container auto cross-axis margins disable `align-items:
 * stretch`, so they would size to their content and overflow sideways.
 *
 * Bottom padding pays for the composer's overlap plus 16px of clear resting
 * space. Older rows can still scroll directly underneath the input instead of
 * stopping above it.
 *
 * `--suggestions-under` is the third term, and it is 0 almost always: the
 * quick-reply row floats on these last rows instead of taking flow height, so
 * while it is up the transcript keeps its own height clear of it (set on the
 * session column by SessionViewer, sized by SUGGESTIONS_CLEARANCE).
 */
export const VIEWER_MESSAGES =
  "viewer-messages flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain " +
  // Keep the reader's place when content loads or expands above them.
  "[overflow-anchor:auto] px-5 pt-0 " +
  "pb-[calc(var(--session-under)_+_var(--suggestions-under,0px)_+_16px)] " +
  // A focused phone composer is fixed and no longer reserves flow height,
  // while the transcript's layout viewport still extends behind the keyboard.
  // Clear both measured obstructions so even a tall draft and the last live
  // status row can scroll completely into the visible strip above them.
  "phone:[body.kb-open_&]:pb-[calc(var(--kb-inset,0px)_+_var(--viewer-input-height,64px)_+_var(--suggestions-under,0px)_+_8px)] " +
  // Wider side padding where the message rail lives, so its ticks have a
  // gutter of their own instead of sitting on the bubbles (lib/message-rail.ts).
  `${RAIL_GUTTER_CLASS} ` +
  "[&>*]:w-full [&>*]:shrink-0 " +
  // 12px of clear space under the bar so the first row starts below it rather
  // than against it, and so a tab strip's baseline rule (the only line that
  // still sits above the transcript) has nothing resting on it. Only at rest:
  // scrolled content still runs right up under the chrome.
  "desktop:pt-3 " +
  // Phone: clear the floating pills at rest, then scroll under them.
  // --strip-clearance is 0 by default and the docked tab bar's height on a
  // multi-session workspace.
  "phone:px-3 " +
  "phone:pt-[calc(var(--pane-header-h)+var(--strip-clearance,0px)+8px)] " +
  // Dissolve the transcript into the header as it scrolls up under the pills.
  // A non-linear fade mirrored into mask alpha:
  // hidden for the first fifth, 45% by three fifths, full at the bar height.
  "phone:[-webkit-mask-image:linear-gradient(to_bottom,transparent_0,transparent_calc(var(--pane-header-h)*0.2),rgba(0,0,0,0.45)_calc(var(--pane-header-h)*0.6),#000_var(--pane-header-h))] " +
  "phone:[mask-image:linear-gradient(to_bottom,transparent_0,transparent_calc(var(--pane-header-h)*0.2),rgba(0,0,0,0.45)_calc(var(--pane-header-h)*0.6),#000_var(--pane-header-h))]";

/**
 * The composer floats up over the transcript so the session scrolls UNDER it,
 * in normal flow — a negative top margin only shifts it visually, which is what
 * keeps the iOS keyboard handling untouched. Its top padding is deliberately
 * smaller than that margin, so the box rises a few px above where the
 * transcript ends and the last row tucks slightly under it.
 *
 * The input's background is transparent at the top of that overlap and solid
 * by the composer's edge. Content therefore remains crisp as it enters beneath
 * the input, then disappears behind the composer itself without a blank band.
 */
export const VIEWER_INPUT =
  "relative z-[1] mt-[calc(-1*var(--session-under))] shrink-0 px-5 pt-1 pb-3.5 " +
  // The same gutter the transcript keeps, so the input stays on the column's
  // edges rather than reaching past them.
  `${RAIL_GUTTER_CLASS} ` +
  // The fade is a later sibling of the native scroller, so painting it edge to
  // edge also fades an overlay scrollbar. Leave its narrow gutter unpainted;
  // raising the scroller would incorrectly lift transcript content too.
  "[background:linear-gradient(to_bottom,transparent_0,var(--bg)_var(--session-under))_left_top/calc(100%_-_14px)_100%_no-repeat] " +
  // Phone: clear the home indicator rather than jamming the composer against
  // the very bottom edge. That gap is also all the room the composer's shadow
  // gets in mobile Safari, where there is no safe-area inset.
  "phone:px-3 phone:pb-[max(16px,env(safe-area-inset-bottom,0px))] " +
  // Keyboard up: pin the input to Safari's fixed viewport instead of relying on
  // its focus pan, which can stop with the toolbar floating above the keyboard.
  // Fixed bottom already follows the visible keyboard edge on iOS Safari, so do
  // not add `--kb-inset` again: that double-counts the keyboard and lifts the
  // composer by hundreds of pixels. The painted wrapper keeps the solid tail of
  // the fade behind a compact 8px gap down to the keyboard.
  "phone:[body.kb-open_&]:fixed phone:[body.kb-open_&]:inset-x-0 phone:[body.kb-open_&]:bottom-0 " +
  "phone:[body.kb-open_&]:pb-2";

/**
 * The step the transcript and the composer take while the workspace summary
 * card is up.
 *
 * The distance is a variable rather than a fixed utility because it depends on
 * how much pane is left beside the card: on a wide window it is zero and the
 * reading column stays centred (`workspaceSummaryShift`).
 *
 * It moves the children, not the scroller, so the scroll container keeps its
 * own box, its padding and its overflow exactly where they were.
 */
export const VIEWER_SUMMARY_STEP =
  "desktop:[&>*]:translate-x-[var(--ws-summary-step,0px)]";

/**
 * The session's floating actions on the composer's own width. Desktop keeps
 * quick replies and Next on one row. Phone stacks quick replies above a centered
 * action bar with Archive, More, New workspace, and Next.
 *
 * The band already repeats the input's side padding, so `--session-col` + 40px
 * here is the composer's own box. Desktop keeps the input's 20px right inset.
 */
export const VIEWER_ACTION_ROW =
  "flex w-full max-w-[calc(var(--session-col)+40px)] items-center justify-end gap-3 pr-5 " +
  "phone:flex-col phone:gap-2 phone:pr-0";

/** Keep the reading action centred between replies and Next when all three
 * share the desktop row. Equal side tracks let either side yield and scroll
 * without moving the middle control off the conversation's centre line. */
export const VIEWER_ACTION_ROW_WITH_SCROLL =
  "desktop:grid desktop:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]";

/**
 * The band the session's own offers hang in: the quick-reply chips and the
 * Next action (VIEWER_ACTION_ROW).
 *
 * `bottom-full` lifts it off the top of the input box, so the band lies on the
 * transcript's last rows and costs the input no height: it arrives and retires
 * without moving the composer under your hands. The transcript pays for what it
 * covers in bottom padding instead (`--suggestions-under`, above).
 *
 * It stands off the composer by 10px: 6px of its own plus the input's 4px of
 * top padding. The row is an offer about the message you are being invited to
 * write, so it stays close enough to belong to it rather than opening a band
 * of empty page between the two. On the input's padding alone, though, the
 * pills' cast shadow landed on the composer's own top edge and the two rounded
 * shapes read as one stuck to the other. `--suggestions-under` pays the
 * transcript back for this standoff as well as for the row.
 *
 * It repeats the input's own side padding rather than insetting by the 20px
 * that padding reads as, because the rail gutter widens it to 37px on a
 * pointer. Measured, a hand-written `inset-x-5` put the pills 17px outside the
 * composer's left edge. Nothing here may take a click but the pills: the rest
 * of the band is transcript you should still be able to select.
 */
export const VIEWER_SUGGESTIONS =
  "pointer-events-none absolute inset-x-0 bottom-full flex justify-center px-5 pb-1.5 " +
  `${RAIL_GUTTER_CLASS} phone:px-3`;

/**
 * The room the transcript keeps clear while that band is up, set on the session
 * column as `--suggestions-under` and 0 the rest of the time.
 *
 * The band floats ON the last rows of the transcript rather than sitting in
 * flow above the composer, so it costs the conversation no height while it is
 * up and none of it back when it retires. What it does cost is cover: without
 * this the answer's own last line ends underneath it, and no amount of
 * scrolling brings it out. One pill tall (28px) plus the band's standoff, so
 * the reading stops the same 16px clear of the pills that it normally stops
 * clear of the input. ReplySuggestions.test.tsx holds the two together.
 */
export const SUGGESTIONS_CLEARANCE = "[--suggestions-under:34px]";

/** A 32px reading action plus the action band's 6px standoff. */
export const SCROLL_ACTION_CLEARANCE = "[--suggestions-under:38px]";

/**
 * The same clearance once Next shares the band and gives it its height: a 40px
 * button, or the phone action bar at 48px, plus the same standoff. The phone
 * toolbar hides while the keyboard is open, so its clearance retires too.
 * Written out rather than derived, because Tailwind compiles the class names it
 * can find spelled in the source.
 */
export const ACTION_CLEARANCE =
  "[--suggestions-under:46px] phone:[--suggestions-under:54px] phone:[body.kb-open_&]:[--suggestions-under:0px]";

/** Phone stacks quick replies above the 48px action bar. With the keyboard up,
 * only the 28px reply row and its 6px standoff remain. */
export const ACTION_WITH_REPLIES_CLEARANCE =
  "[--suggestions-under:46px] phone:[--suggestions-under:90px] phone:[body.kb-open_&]:[--suggestions-under:34px]";

/**
 * The chips themselves, filling the action row beside Next.
 *
 * The 4px of padding, and the negative margins that pay it back, are for the
 * pills' cast shadow. The row scrolls sideways, and a scroll container clips:
 * `overflow-x: auto` forces the other axis to `auto` too, so at the row's own
 * height the lift under each pill was cut off square, and the first pill lost
 * the left edge of its hairline.
 *
 * The left side carries that allowance plus an indent, so the first pill
 * starts on the composer's own content rail rather than on its outer edge:
 * 15px in, where the draft you are being offered starts (13px on a phone).
 * Flush with the box, the row read as another edge of the input. Only the
 * left: the pills are a short row that never reaches the other side, so
 * padding that one too would just take room off the end of the scroll.
 *
 * 19 and 17 rather than the sum spelled out: Tailwind compiles the class names
 * it can find written out, and `--composer-inset-left` is declared on the
 * composer box itself, so it is not in scope here. ReplySuggestions.test.tsx
 * holds the two together.
 */
export const VIEWER_SUGGESTIONS_ROW =
  "min-w-0 flex-1 -my-1 -ml-1 py-1 pr-1 pl-[19px] phone:pl-[17px]";

/**
 * The same chips once Next shares the row with them.
 *
 * They keep the desktop shadow allowance and content-rail indent exactly as
 * above. On a phone they start on the composer's outer edge instead. That gives
 * the rail enough room to finish ordinary two-chip choices before Next, rather
 * than clipping the final capsule for an indent the narrow row cannot afford.
 * `min-w-0` still lets longer choices scroll sideways instead of pushing Next.
 */
export const VIEWER_SUGGESTIONS_ROW_INLINE =
  "min-w-0 flex-1 -my-1 -ml-1 py-1 pr-1 pl-[19px] phone:pl-[10px]";

/* ── Banners and the delete overlay ─────────────────────────────────────── */

export const SESSION_BANNERS =
  "flex flex-wrap gap-2 border-b border-divider bg-raised px-4 py-[7px]";

/** A single notice pill. It carries no ink of its own: the caller supplies the
 *  tone, because two text-colour utilities on one element are resolved by
 *  Tailwind's output order rather than the order they are written. 12px in the
 *  old sheet; it is interface copy, so it snaps to `text-label`. */
export const SESSION_BANNER =
  "inline-flex max-w-full items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap " +
  "rounded-full border border-line bg-panel px-3 py-[3px] text-label";

/** Shown while a delete (optionally + worktree) is in flight — worktree
 *  cleanup can take a few seconds, so the view shows progress instead of
 *  looking frozen. */
export const SESSION_DELETE_LABEL = "text-label text-dim";

/* ── Floating transcript pills ──────────────────────────────────────────────
 *
 * "Load all" at the top of the transcript, "Scroll to bottom" at its foot, the
 * support thread's own agent rail, and the loading state each of them swaps
 * to. They float over live content, so they are a floating surface rather than
 * a panel, and they stay small: this is chrome the eye should pass over, not a
 * primary action. Glass over a transcript, an opaque lid over prose that runs
 * the full column — see PILL_LID for which is which and why.
 *
 * The padding is asymmetric on purpose. Every one of these carries a leading
 * icon, and an icon brings its own whitespace to the edge, so matching the
 * label's padding on that side reads as a gap. Trimming the leading side by
 * 4px puts the two ends back in optical balance, the usual trim for an
 * icon+label button.
 */

/** Everything but the fill and the gap — the two values these pills disagree
 *  on. Both are composed in rather than overridden on top: two utilities for
 *  one property resolve by Tailwind's output order, not by the order they are
 *  written in. */
const PILL_CHROME =
  "inline-flex min-h-8 items-center rounded-[999px] pr-3.5 pl-2.5 " +
  "text-label font-semibold text-fg " +
  "[--smooth-ring-color:var(--popup-ring)] smooth-shadow-ring-sm";

const PILL_BASE = `${PILL_CHROME} bg-popup-glass [backdrop-filter:var(--popup-blur)]`;

/**
 * The same pill, opaque — a lid rather than glass.
 *
 * Glass works over a transcript because a turn is a narrow column with margins
 * either side, so the pill mostly hangs over the page rather than over words.
 * Where the text under it runs the full width of the reading column — the
 * support thread, whose customer messages take no surface at all — the words
 * read straight through it and the pill looks broken. A control that floats on
 * content is a lid: the surface reaches its colour, it does not pass through
 * its alpha.
 *
 * The fill is part of the base rather than an override on top of it, for the
 * same reason the gap is: two `bg-*` utilities on one element resolve by
 * Tailwind's output order, and `bg-popup` is emitted BEFORE `bg-popup-glass`,
 * so writing it after would silently lose.
 */
const PILL_LID = `${PILL_CHROME} bg-popup`;

export const TRANSCRIPT_PILL = `${PILL_BASE} gap-1.5`;
export const FLOATING_PILL = `${PILL_LID} gap-1.5`;

/**
 * The button form. The hover wash paints on a pseudo-element so it layers over
 * the glass instead of replacing it — which means the pseudo needs the pill's
 * corner treatment too: base.css grants `corner-shape: squircle` by matching
 * `rounded-*` on the ELEMENT, and a pseudo-element matches no selector, so
 * `rounded-[inherit]` alone left a round wash sitting inside a squircle pill
 * with a pale sliver showing at each corner. `corner-shape: inherit` follows
 * whatever the pill resolved to, including the PWA's round-cornered phone case.
 *
 * `after` is the hit target, held a few pixels out past the visible edge so a
 * small pill is still easy to hit; it must not paint anything, or it would
 * square off the corners it extends past.
 */
const PILL_PRESSABLE =
  "group relative cursor-pointer transition-[scale] " +
  "before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] " +
  "before:[corner-shape:inherit] before:bg-transparent before:transition-colors before:content-[''] " +
  "after:absolute after:content-[''] hover:before:bg-hover " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg active:scale-[0.96]";

export const TRANSCRIPT_PILL_BUTTON = `${TRANSCRIPT_PILL} ${PILL_PRESSABLE} after:-inset-1`;
export const FLOATING_PILL_BUTTON = `${FLOATING_PILL} ${PILL_PRESSABLE} after:-inset-1`;

/** A compact transcript action whose visible surface is only the glyph. */
export const TRANSCRIPT_ICON_BUTTON =
  "inline-flex size-8 items-center justify-center rounded-full bg-popup-glass text-fg " +
  "[backdrop-filter:var(--popup-blur)] [--smooth-ring-color:var(--popup-ring)] smooth-shadow-ring-sm " +
  `${PILL_PRESSABLE} after:-inset-1.5`;

/**
 * Centring for a pill that floats over the transcript.
 *
 * `left-1/2` centres on the PANE, and the reading column is not always in the
 * middle of it: while the workspace summary card is up, the transcript and the
 * composer step left by `--ws-summary-step` (VIEWER_SUMMARY_STEP) while these
 * pills are siblings of the scroller, so a pane-centred pill is left hanging
 * over the card's side of the composition. Folding the step into the same
 * translate keeps the pill on the column it belongs to.
 *
 * One utility rather than `-translate-x-1/2` with an override beside it: two
 * translate utilities on one element resolve by Tailwind's output order, not
 * by the order they are written. The variable is only ever set while the card
 * is up, which never happens on a phone, so its default leaves every other
 * case at a plain -50%.
 */
export const PILL_CENTRED =
  "translate-x-[calc(-50%+var(--ws-summary-step,0px))]";

/** The loading state's leading spinner, and the wider gap it asks for: an arrow
 *  glyph carries side bearing of its own, a bare 12px ring carries none, so at
 *  the label's own spacing the two sit on top of each other. */
export const TRANSCRIPT_PILL_LOADING = `${PILL_BASE} gap-2`;
export const FLOATING_PILL_LOADING = `${PILL_LID} gap-2`;
export const TRANSCRIPT_PILL_SPINNER =
  "size-3 shrink-0 animate-spin rounded-full border border-current/25 border-t-current text-dim";

/**
 * Where the top pill ("Load all", and the loading state it swaps to) floats.
 *
 * It is a sibling of the scroll area rather than a row inside it, so it does
 * not inherit the transcript's own top padding. On a phone that padding is the
 * only thing holding content clear of the chrome: the bar there is a fixed
 * `z-40` overlay across the top of the pane, with the docked tab strip under
 * it on a multi-session workspace. 12px therefore put the pill behind both,
 * rendered and covered and untappable at every scroll position. It clears the
 * same chrome the transcript clears.
 *
 * SessionViewer shows it only within a screenful of the head of the
 * transcript. Its phone position clears the fixed navigation and tab chrome.
 */
export const TRANSCRIPT_PILL_TOP =
  `pointer-events-none absolute top-3 left-1/2 z-[5] ${PILL_CENTRED} ` +
  "phone:top-[calc(var(--pane-header-h)+var(--strip-clearance,0px)+8px)]";

/* ── Session info page (phone) ──────────────────────────────────────────────
 *
 * Tapping the top-bar title opens this as a deeper page, WhatsApp-style: a
 * full-screen sheet with the session identity up top and every action below,
 * with its own chevron-back to the session.
 *
 * The whole page renders only when `useIsPhone()` is true, so none of it is
 * written as a `phone:` override — which also keeps it clear of the
 * one-pixel disagreement between Tailwind's `max-[720px]` (`width < 720px`)
 * and the `max-width: 720px` that `useIsPhone` and the old sheet mean.
 *
 * `session-info-topbar` and `session-info-status` stay on the markup as bare
 * hooks: the scroll handler finds the bar with `querySelector`, and
 * lib/pr-tone-classes.ts fits the PR strip to the status card with
 * `[.session-info-status_&]`.
 */

/** The page is a scrolling column, so nothing in it may flex.
 *
 *  `[&>*]:shrink-0` is load-bearing rather than defensive: a column flex
 *  container still lays its children out to its own height, and a child whose
 *  overflow is not `visible` has an automatic minimum size of zero — so on any
 *  session with enough below it, the PR strip's frame (INFO_STATUS, which
 *  clips) was the one child free to absorb the whole overflow. It gave up its
 *  height first and clipped the strip inside it, down to nothing on a short
 *  viewport, while the sections that cannot shrink kept theirs. */
export const INFO_PAGE =
  "fixed inset-0 z-[60] flex flex-col gap-0.5 overflow-y-auto overscroll-contain bg-surface " +
  "pb-[max(16px,env(safe-area-inset-bottom,0px))] [&>*]:shrink-0 " +
  "[animation:session-info-in_var(--dur)_var(--ease)]";

const INFO_TOPBAR =
  "session-info-topbar sticky top-0 z-[4] flex items-center " +
  "min-h-[calc(env(safe-area-inset-top,0px)+52px)] " +
  "pt-[env(safe-area-inset-top,0px)] px-2 pb-0 " +
  "[transition:background-color_var(--dur)_var(--ease)]";

/** Transparent until the page scrolls, then a frosted surface. The fill and
 *  blur separate the fixed chrome without drawing a grey rule across it. */
export const infoTopbarClass = (scrolled: boolean) =>
  `${INFO_TOPBAR} ` +
  (scrolled
    ? "bg-[color-mix(in_srgb,var(--bg)_92%,transparent)] " +
      "backdrop-blur-[18px] backdrop-saturate-[1.35]"
    : "bg-transparent");

const INFO_TOPBAR_TITLE =
  "pointer-events-none absolute right-14 bottom-0 left-14 block h-[52px] " +
  "overflow-hidden text-ellipsis whitespace-nowrap text-center text-item-title font-semibold leading-[52px] tracking-[-0.01em] text-fg " +
  // `transform`, not Tailwind's `translate` property: that is what the
  // transition beside it names.
  "[transition:opacity_var(--dur)_var(--ease),transform_var(--dur)_var(--ease)]";

/** The bar's own title can fade with a page hero or stay visible when the
 * compact summary starts immediately below it. */
export const infoTopbarTitleClass = (scrolled: boolean) =>
  `${INFO_TOPBAR_TITLE} ` +
  (scrolled
    ? "opacity-100 [transform:translateY(0)]"
    : "opacity-0 [transform:translateY(5px)]");

/** Identity block: repo tile, name, and the repo · model line. The tile gets a
 *  soft key shadow here that it doesn't carry elsewhere. */
export const INFO_HERO =
  "flex flex-col items-center gap-0 px-5 pt-0.5 pb-5 text-center " +
  "[&_.repo-tile]:smooth-shadow-ring-sm";

/** 20px in the old sheet — the page's one heading, so it snaps to
 *  `text-page-title` (22px). */
export const INFO_NAME =
  "mt-[9px] max-w-full text-page-title font-semibold leading-[1.2] tracking-[-0.02em] break-words text-fg";
export const INFO_SUB =
  "flex min-h-11 w-full max-w-full items-center justify-center gap-x-1 px-6 text-label font-medium text-dim";

/** Phone PR strip frame: spacing + clipping only. The status tone itself
 * reaches the outer radius, so the row does not become a card inside a card. */
export const INFO_STATUS =
  // `empty:hidden` for the same reason as PANEL_PR_PLATE: the strip renders
  // nothing when the session has no pull request to report, and a wrapper with
  // only a margin left in it is a gap with no row above it.
  //
  // `mx-3` + `rounded-lg`, like every plate under it: the page has one edge.
  "session-info-status mx-3 mb-3 overflow-hidden rounded-lg empty:hidden";

export const INFO_CONTENT = "min-h-[320px] pb-2";

/** The phone Workspace summary's card stack. Each semantic section supplies
 * its own quiet background, so Review, Changes and media can be scanned as
 * separate groups without returning to the old bordered dashboard. */
export const INFO_SUMMARY_CARD = "mx-3 mt-2 flex flex-col gap-2.5";

/** A section rendered by a component of its own (Agents, Reports) rather than
 *  by WorkspaceInfo. It gets the page's inset and the same 16px gap the panel
 *  puts between its own sections, and no rule above it: a section is separated
 *  by its plate, never by a hairline. */
export const INFO_SECTION = "mt-4 px-3";

/**
 * The Info panel's section grammar, shared by everything that renders into it
 * (WorkspaceInfo's own blocks, plus the Portals and Agents sections beneath
 * them). One faint label over one borderless plate: the plate's `bg-panel`
 * against the panel's own surface is what separates a section, so a section
 * never takes a border — a hairline there would turn a column of them into a
 * form. Rows go straight into the plate and are divided by `gap-px`.
 */
export const INFO_SECTION_CLASS = "grid gap-[5px]";
/**
 * One inset for the whole panel: content sits 12px from the plate's edge, and
 * the label sits over it rather than over the plate. A list gets there as 4 of
 * plate padding plus 8 on the row (INFO_LIST_CLASS + a `px-2` row), a label by
 * paying the 12 itself, and anything that is its own content — a screenshot
 * frame — by taking all 12 as padding. The panel used to run five different
 * insets (8, 11, 12, 13, 16) with the label aligned to none of them, which is
 * the kind of thing nobody can name and everybody can feel.
 */
export const INFO_LABEL_CLASS =
  "px-3 text-label font-semibold tracking-[-0.01em] text-faint";
export const INFO_LIST_CLASS =
  "grid gap-px overflow-hidden rounded-lg bg-panel p-1";

/** Repo and model controls at the top of the phone summary card. They keep
 * their labelled two-line content, but give up the separate plate and border
 * now that the summary card supplies one shared surface. */
export const INFO_LIST =
  "session-info-list grid gap-px overflow-hidden rounded-2xl bg-panel p-2 " +
  "[&>button]:min-h-11 [&>button]:w-full [&>button]:justify-start [&>button]:gap-2 [&>button]:text-left " +
  "[&>button]:rounded-row [&>button]:border-0 " +
  "[&>button]:bg-transparent [&>button]:px-3 [&>button]:py-2 [&>button]:text-label [&>button]:text-fg " +
  "[&>button:hover]:bg-hover";

/** The whole-workspace view embedded below the actions.
 *
 *  The panel's own `px-2` is the desktop side panel's inset, which pays part of
 *  it through the `px-1` its mounts wrap it in. The phone page has no such
 *  wrapper, so it names its own 12px here and every plate on the page lands on
 *  the same edge as the strip and the repo list above them. */
export const INFO_OVERVIEW =
  "pt-4 [&_.workspace-info-panel]:pt-0 [&_.workspace-info-panel]:px-3";
