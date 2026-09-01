import type { SessionSource } from "./types";
import * as stylex from "@stylexjs/stylex";
import { mergeStylexClassName } from "../ui/cn";
import { type as typography } from "../styles/typography.stylex";

const sx = stylex.create({
  shrink0: {
    flexShrink: "0",
  },
  roundedFull: {
    borderRadius: "3.40282e38px",
    cornerShape: "round",
  },
  px2: {
    paddingInline: "8px",
  },
  py05: {
    paddingBlock: "2px",
  },
  fontBold: {
    "--tw-font-weight": "var(--font-weight-bold)",
    fontWeight: "var(--font-weight-bold)",
  },
  tracking001em: {
    "--tw-tracking": "-.01em",
    letterSpacing: "-.01em",
  },
  bgActive: {
    backgroundColor: "var(--bg-active)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  bgVarChipSlackBg: {
    backgroundColor: "var(--chip-slack-bg)",
  },
  textVarChipSlackFg: {
    color: "var(--chip-slack-fg)",
  },
  bgVarChipLinearBg: {
    backgroundColor: "var(--chip-linear-bg)",
  },
  textVarChipLinearFg: {
    color: "var(--chip-linear-fg)",
  },
  bgVarChipAskBg: {
    backgroundColor: "var(--chip-ask-bg)",
  },
  textVarChipAskFg: {
    color: "var(--chip-ask-fg)",
  },
});

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
export const SOURCE_CHIP = mergeStylexClassName(
  "",
  sx.shrink0,
  sx.roundedFull,
  sx.px2,
  sx.py05,
  typography.meta,
  sx.fontBold,
  sx.tracking001em,
);

/** Neutral pill — the origins that get no hue of their own. */
const NEUTRAL = mergeStylexClassName("", sx.bgActive, sx.textDim);

const TONE: Record<string, string> = {
  slack: mergeStylexClassName("", sx.bgVarChipSlackBg, sx.textVarChipSlackFg),
  linear: mergeStylexClassName(
    "",
    sx.bgVarChipLinearBg,
    sx.textVarChipLinearFg,
  ),
  ask: mergeStylexClassName("", sx.bgVarChipAskBg, sx.textVarChipAskFg),
  cli: NEUTRAL,
};

/**
 * The tone for a session origin. `opensession` deliberately resolves to no
 * tone: the chip is only rendered for origins that are worth calling out, and
 * an untinted chip is what the app shipped. (The teal `.source-backstage`
 * rule this replaced had been unreachable since the rename — no session
 * carries that source any more.)
 */
export function sourceChipTone(source: SessionSource | "ask" | string): string {
  return TONE[source] ?? "";
}
