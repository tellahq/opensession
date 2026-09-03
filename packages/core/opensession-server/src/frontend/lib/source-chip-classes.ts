import type { SessionSource } from "./types";

/**
 * Source chips — the small pill naming where a session came from (slack,
 * linear, ask).
 *
 * The tone is a LOOKUP, not a built class name. The markup used to spell
 * `` `source-chip source-${session.source}` ``, which works for a stylesheet
 * but cannot work for utilities: Tailwind only compiles class names it can
 * find in the source, so a name assembled at runtime compiles to nothing at
 * all. Every tone below is a literal string for that reason — do not
 * reintroduce interpolation here.
 *
 * The tints themselves are tokens in base.css (`--chip-*`), so they re-tone
 * for the light theme on their own; see the note there.
 */
export const SOURCE_CHIP =
  "shrink-0 rounded-full px-2 py-0.5 text-meta font-bold tracking-[-0.01em]";

/** Neutral pill — the origins that get no hue of their own. */
const NEUTRAL = "bg-active text-dim";

const TONE = {
  slack: "bg-[var(--chip-slack-bg)] text-[var(--chip-slack-fg)]",
  linear: "bg-[var(--chip-linear-bg)] text-[var(--chip-linear-fg)]",
  // Green is what ask means across the product (the composer's Ask toggle,
  // the ask band in the sidebar), so the chip says it in the same colour.
  ask: "bg-green-soft text-green",
  cli: NEUTRAL,
};

const TONE_BY_SOURCE = new Map(Object.entries(TONE));

/**
 * The tone for a session origin. `opensession` deliberately resolves to no
 * tone: the chip is only rendered for origins that are worth calling out, and
 * an untinted chip is what the app shipped. (The teal `.source-backstage`
 * rule this replaced had been unreachable since the rename — no session
 * carries that source any more.)
 */
export function sourceChipTone(source: SessionSource | "ask" | string): string {
  return TONE_BY_SOURCE.get(source) ?? "";
}
