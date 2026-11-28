import {
  composerBox,
  composerSend,
  composerSendDefault,
} from "./composer-classes";
import { paletteIconBtn, palettePill } from "./palette-classes";
import { isApple } from "./platform";
import { cn } from "../ui/cn";

/* ── Palette chrome ───────────────────────────────────────────────────────
   Every class is written out in full: Tailwind scans source TEXT, so a name
   assembled from a variable compiles to nothing. Variants that differ in
   colour or corner carry a COMPLETE string rather than stacking a second
   colour utility onto a shared base — two competing colour utilities on one
   element don't compose, the compiled sheet's order picks the winner.

   The icon button and the model pill are shared with the composer toolbar, so
   they live in lib/palette-classes.ts rather than being restated here. */

/** The hairline is a cutoff for content passing under the header, so it stays
 *  transparent until the prompt has actually scrolled beneath it. The border
 *  itself is always present: switching the colour keeps the height steady,
 *  where toggling `border-b` would jog the layout by a pixel.
 *
 *  Padding is asymmetric for the same reason the footer's is: the top is the
 *  card's own edge, the bottom only a hairline. The picker is a 32px box that
 *  fills on hover, so 16px above it matches the 16px beside it.
 *
 *  One control wide on a desktop, since the branch moved into the footer's
 *  overflow menu. On a phone this row IS the sheet's title bar: dismiss on the
 *  left, the project in the middle, commit on the right. It used to be a
 *  second row under that bar, and the two rows together pushed the sheet taller
 *  than the strip a keyboard leaves visible, which cut the bar off the top of
 *  the screen as soon as an attachment took its own space. */
export const HEADER =
  "flex items-center gap-2 border-b border-transparent px-4 pt-4 pb-[11px] phone:h-auto phone:px-[18px] phone:pb-3 phone:pt-[18px]";
/** Merged onto HEADER/FOOTER by `cn()`, which drops the transparent colour. */
export const EDGE_DIVIDER = "border-line";
/** The header's picker, which doubles as the palette's title: bigger, solid,
 *  heavier than a footer control.
 *
 *  `relative` is load-bearing — PaletteSelect's phone branch stacks an
 *  invisible native <select> over the trigger. So is `min-w-0`: the label
 *  already truncates, but a flex item whose own overflow is visible cannot be
 *  sized below its content, so a long repo name would push the row wider than
 *  the card instead of ellipsizing. */
export const TRIGGER_STRONG =
  "relative inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-control px-2 py-[5px] text-item-title font-semibold text-fg transition-colors hover:bg-hover disabled:cursor-default disabled:opacity-55";
export const CHEVRON = "-ml-0.5 shrink-0 text-faint phone:size-4";
/** A pass-through on a desktop, where the picker is the header's one control.
 *  On a phone it is the middle slot of the title bar: it takes the space the
 *  two discs leave and centres the title inside it, so the row reads as one
 *  balanced bar rather than a label pushed against the close button. */
export const MOBILE_PICKER =
  "desktop:contents phone:flex phone:min-w-0 phone:flex-1 phone:justify-center";
/** On a phone the trigger is the sheet's title: the row's name, centred
 *  between the two discs that dismiss and commit. It carries no fill and no
 *  edge of its own. Those discs are the bar's only surfaces, and a third one
 *  between them read as an empty field rather than as the heading it is. The
 *  label and its chevron are the whole control; pressing it still paints the
 *  shared hover wash from `TRIGGER_STRONG`.
 *
 *  Smaller than the header's desktop title: between two 44px discs it is the
 *  quiet one of the three, so it drops to the label size and medium weight the
 *  rest of the chrome's chips wear. It keeps the full 44px height as a touch
 *  target, and it has to fit the row it shares, which is what `max-w-full`
 *  plus the label's own truncation buy. */
export const MOBILE_TRIGGER =
  "phone:min-h-11 phone:gap-1 phone:rounded-[999px] phone:px-2.5 phone:py-1.5 phone:text-label phone:font-medium phone:[&_svg:first-child]:size-4";
/** The composer's own send disc, so the gesture that commits a prompt looks the
 *  same in the palette as it does in a session. Sized up to the 44px target the
 *  rest of this bar keeps. */
export const PHONE_SEND = cn(
  composerSend,
  composerSendDefault,
  "phone:size-11",
);

/* (The prompt's own surface — the scroller and the field — moved to
   NewSessionPrompt, with the draft state it belongs to.) */
export const ERROR =
  "mx-4 mb-2 rounded-md bg-red-soft px-2.5 py-[7px] text-supporting text-red";

/* Single-line footer: the model pill is the only flexible item — it gives way
   (its label ellipsizes) while the icon buttons and Create keep their size.
   Phones let the row wrap instead of crushing every pill to one letter.

   The bottom pad is deeper than the top one because it is measured against a
   different thing: the top is a hairline, the bottom is the card's own edge,
   rounded-xs at ~30px. Create is a 36px plate inside a 40px row, so 14px here
   leaves it the same 16px clearance the side padding gives it. The safe-area
   inset clears the home indicator at rest, but the keyboard covers that edge
   while a field is focused, so the ordinary 12px pad takes over then. */
export const FOOTER =
  "flex items-center justify-between gap-x-2 gap-y-2 border-t border-transparent px-4 pt-[9px] pb-3.5 phone:flex-wrap phone:px-3 phone:pb-[calc(0.75rem+env(safe-area-inset-bottom))] phone:[body.kb-open_&]:pb-3 max-[560px]:gap-x-1.5";
export const FOOTER_LEFT =
  "flex min-w-0 items-center gap-1.5 phone:flex-1 max-[560px]:gap-1";
export const FOOTER_RIGHT =
  "flex min-w-0 items-center gap-1.5 phone:contents max-[560px]:gap-1";
/** Round like every icon button: the shape comes from `paletteIconBtn`. */
export const FOOTER_ICON_BTN = cn(paletteIconBtn, "shrink-0 phone:size-11");
/** Ask mode, once it is on. Off, it is a row in the footer's overflow menu.
 *  On, it surfaces in the footer wearing the same green marker the session
 *  composer's toolbar shows for the same mode, so one mode reads identically in
 *  both places. It names itself, because the mode governs the whole session
 *  and read-only running behind a menu would be silent. Pressing it turns the
 *  mode back off.
 *
 *  32px tall on a desktop,
 *  the size the icon buttons' hover wash paints, so the row keeps one rhythm;
 *  44px on a phone, where the whole row is thumb-sized. */
export const ASK_BTN_ON =
  "inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-label font-medium transition-colors phone:min-h-11 phone:px-3.5 bg-[color-mix(in_srgb,var(--green)_18%,transparent)] text-green hover:bg-[color-mix(in_srgb,var(--green)_26%,transparent)] disabled:cursor-default disabled:opacity-50";
/** Ask mode paints the whole card, not just its toggle — the same thing the
 *  session composer does for ask and for note mode, because the mode governs
 *  everything you are about to type rather than one control in the corner.
 *
 *  A pseudo-element rather than a background on the card, because the palette
 *  is glass over a dimmed page: the tint has to sit ON the blur and fade in and
 *  out with it intact. Children are lifted above it, and the shell's own
 *  `overflow-hidden` clips it to the rounded-xs corner. */
export const ASK_SURFACE =
  "isolate " +
  "before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-[inherit] before:[corner-shape:inherit] before:bg-[var(--palette-ask-bg)] before:opacity-0 before:transition-opacity before:duration-micro before:ease-standard " +
  "[&>*]:relative [&>*]:z-1";
/** The one flexible footer item, last on the left beside the attach and
 *  overflow buttons. The palette has room for the model's full name, so it
 *  opts out of palettePill's generic 180px cap. On phones the effort suffix
 *  steps aside first and leaves that room to the model. */
export const MODEL_PILL = cn(
  palettePill,
  "shrink min-w-0 max-w-none phone:min-h-11 phone:[&_[data-effort]]:hidden max-[560px]:px-[9px]",
);

// A dropped socket is recoverable: the same idempotent create is replayed as
// soon as the connection returns. "failed" is reserved for a server response.
export type CreateStatus =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "reconnecting" }
  | { kind: "failed"; message: string };
/** Held while picking a repo, it adds one instead of replacing the choice. */
export const MULTI_MODIFIER = isApple ? "⌘" : "Ctrl";

/* One Create button, round like the composer's send disc and the model pill
   beside it. It used to be half of a split button whose caret picked between
   opening the new session, staying put, or keeping the palette up for another;
   a create now always opens what it made.

   The phone overlay moves Create into its title bar and does not render this.
   Only the inline card reaches the phone classes, where it spans the row. */
export const CREATE_BTN =
  "inline-flex shrink-0 cursor-pointer items-center gap-[7px] rounded-full border-none bg-accent py-[7px] pl-4 pr-3.5 text-label font-semibold text-on-accent transition-[background-color,opacity] enabled:hover:bg-accent-hover disabled:cursor-default disabled:opacity-40 phone:order-2 phone:mt-0.5 phone:min-h-11 phone:w-full phone:justify-center max-[560px]:pl-3.5 max-[560px]:pr-3";
export const CREATE_KBD = "opacity-70";
/** The card's corner, shared by the palette and the inline card. Round enough
 *  to sit concentric with the pill-shaped Create and model controls at its
 *  bottom edge: an 18px pill radius plus the 16px clearance around it. */
export const CARD_RADIUS = "rounded-[calc(34px*var(--rf))]";

/**
 * The same card rendered on the page rather than over a dimmed one: what the
 * empty state shows when there is no session to open yet.
 *
 * Not the palette's glass: `--palette-glass` is mixed to composite over a
 * backdrop, and on the pane's own surface there is little behind it to blur
 * (nothing at all under the mac shell's vibrancy, where the app's layers go
 * transparent). So it takes the composer's lift instead, the tokens for the
 * surface you type into, which is also what the workspace home's first-session
 * composer already wears.
 *
 * The layout half is the palette's and is load-bearing, not decoration: BODY is
 * `min-h-0 flex-1` and only scrolls inside a bounded column, and the header and
 * footer hairlines are keyed off that scroll. `relative` anchors the dictation
 * HUD; `overflow-hidden` keeps the rows' dividers inside the rounded shell.
 */
export const INLINE_CARD = cn(
  "relative flex w-full flex-col overflow-hidden",
  CARD_RADIUS,
  "max-h-[min(560px,68dvh)]",
  composerBox,
);
