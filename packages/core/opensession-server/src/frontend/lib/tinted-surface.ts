/**
 * The writing surface for an input that is not in its ordinary state.
 *
 * It is a wash of the mode's ink and nothing else, the shape a team note
 * already takes in the transcript (components/NoteBubble.tsx). No hatch, no
 * coloured edge: a surface you read and write over all day cannot carry a
 * texture, which at that duty cycle lands as damage to the box rather than as
 * a state.
 *
 * A wash cannot carry a state on its own, and the session composer is where
 * that shows: ask at 7% green and note at 10% yellow land one faint tint apart
 * (8.6 dE in light, less in dark), and you never see the two side by side to
 * compare, so a tinted composer said that something was different without
 * saying which. Every mode that paints a surface therefore also names itself
 * in a chip on it (components/ComposerContextChip.tsx). The wash is the state's
 * colour and its reach; the chip is its name. Neither does the job alone.
 *
 * Strength follows duty cycle. Ask mode is ambient, on for the session's whole
 * life, so it is the lighter of the two; note mode is one message, so it is
 * allowed to be louder, and it paints OVER ask in the composer that has both.
 *
 * The base is the surface the wash actually covers, and it matters:
 *
 * · The composer and the Plain reply box pass `--composer-surface`, which is
 *   white in light mode. `--control-surface` is a grey there, so mixing into it
 *   sank the box a step darker than its resting state and the tint read as
 *   dirt rather than as colour.
 * · The new-session palette is glass over a dimmed page, so it mixes into
 *   `transparent` — an opaque tint would paint the blur out.
 * · A note bubble in the transcript is also `transparent`: it tints the page it
 *   sits on.
 *
 * Returned as a raw colour rather than a utility because every caller hands the
 * value to inline style or a custom property, and Tailwind cannot compile a
 * colour it only sees at runtime.
 */

function tint(ink: string, percent: number, base: string): string {
  return `color-mix(in srgb, ${ink} ${percent}%, ${base})`;
}

/** Read-only mode, wherever you meet it: the session composer, the palette. */
export function askSurface(base: string): string {
  return tint("var(--green)", 7, base);
}

/** A message the agent never sees: the note bubble, the composer in note mode,
 *  a Plain internal note. `--yellow-tint`, not `--yellow` — the ink is a dark
 *  ochre in light mode and turns warm grey at these percentages (base.css). */
export function noteSurface(base: string): string {
  return tint("var(--yellow-tint)", 10, base);
}
