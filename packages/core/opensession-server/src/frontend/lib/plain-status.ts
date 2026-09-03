/**
 * A Plain thread's status, as the app draws it: label, tone and glyph.
 *
 * Three statuses come out of Plain: TODO, SNOOZED, DONE. Anything else the
 * API sends falls through to a grey unknown rather than rendering a raw enum
 * name in a coloured chip.
 *
 * It was a word in a coloured pill until 2026-08. The pill's width was its
 * label's, so the three were 40/42/60px and the badge moved the layout around
 * it as a ticket changed state; now the badge is a fixed square, which is what
 * lets it lead a row (ConversationPane's top bar) instead of trailing the
 * title. The word survives as the tooltip and the accessible name, because a
 * glyph on a tint is quick to scan but not self-naming.
 *
 * A lookup rather than the old `plain-status-${status.toLowerCase()}`: a class
 * assembled at render time can never be proven unused, so it pins its rules in
 * the stylesheet permanently, and the whole point of the migration is to be
 * able to delete what nothing reaches.
 *
 * Snoozed was authored against `var(--amber, #d29922)`, and `--amber` is not a
 * token this app defines, so it always resolved to the literal fallback and
 * stayed the dark-theme yellow even in light mode. It uses the real `--yellow`
 * token now, which does re-resolve per theme.
 */
import {
  IconCheck,
  IconInbox,
  IconMoon,
  IconStatusRing,
} from "../components/icons";

export const STATUS_LABEL = Object.fromEntries([
  ["TODO", "Todo"],
  ["SNOOZED", "Snoozed"],
  ["DONE", "Done"],
]);

/**
 * The box. 26px is the `sm` Button's height, so in the Support bar the badge
 * sits level with the Done / Snooze / priority controls beside it rather than
 * setting a second height, and `rounded-control` is their corner. The glyph
 * inside is the icon set's own 20px floor, which draws ~12px of ink and leaves
 * the tint reading as a disc around it.
 */
const BASE =
  "inline-flex size-[26px] shrink-0 items-center justify-center rounded-control";

const TONES = Object.fromEntries([
  ["todo", "bg-[color-mix(in_srgb,var(--blue)_18%,transparent)] text-blue"],
  ["done", "bg-[color-mix(in_srgb,var(--green)_18%,transparent)] text-green"],
  [
    "snoozed",
    "bg-[color-mix(in_srgb,var(--yellow)_20%,transparent)] text-yellow",
  ],
]);

/**
 * The glyphs. None of them is a circle: the badge is a rounded tint and a ring
 * or a clock face inside it reads as two concentric circles rather than as a
 * state. Todo is the inbox the queue is named after, Snoozed is asleep rather
 * than the clock its own Snooze button wears, and Done is the bare check.
 */
const ICONS = Object.fromEntries([
  ["todo", IconInbox],
  ["done", IconCheck],
  ["snoozed", IconMoon],
]);

export function plainStatusClass(status: string): string {
  const tone = TONES[status.toLowerCase()] ?? "bg-active text-faint";
  return `${BASE} ${tone}`;
}

export function plainStatusIcon(status: string): typeof IconCheck {
  return ICONS[status.toLowerCase()] ?? IconStatusRing;
}
