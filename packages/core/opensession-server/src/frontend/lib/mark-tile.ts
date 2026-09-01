import { getAccentThemeOption, type AccentTheme } from "./accent-theme";
import { contrastRatio, hexToOklch, maxChroma, oklchToHex } from "./oklch";

/**
 * The mark a thing is led by: the small tile at the head of a library entry, a
 * connection row, a setup card. It carries either a service's real logo or, for
 * the things that are ours, a glyph on a coloured plate.
 *
 * Two decisions live here rather than at the call sites.
 *
 * **The corner keys off the box.** A tile is rendered anywhere from 20px (a
 * chip in the new-session sheet) to 40px (a setup card), and one radius across
 * that range cannot be right twice: the step that is a soft corner at 40 is a
 * circle at 20. The scale in styles/tailwind.css multiplies every radius by
 * `--rf` (1.35 where the browser can draw squircles), so the numbers here are
 * larger than they look. `rounded-lg` is ~19px, which a 30px tile clamps to a
 * blob. Picking the step by size is also why this cannot be an inline
 * `border-radius`: base.css grants `corner-shape: squircle` to elements
 * carrying a `rounded-*` CLASS, so a computed radius would quietly opt the tile
 * out of the app's corner.
 *
 * **The hues are the accent palette's.** The tones are not a colour set of
 * their own: each one names an entry in `ACCENT_THEME_OPTIONS` and reads its
 * value at render, so a mark follows when that table is retuned. This file
 * held copied hex for about an hour once, and the app's green and red moved
 * underneath it in that time.
 *
 * What it takes from the table is the HUE, and the lightness to sit around.
 * Saturation is this file's, because the two surfaces want opposite things
 * from it. An accent has to survive as chrome behind text and beside content,
 * so that table caps every hue at 80% of what it can physically hold. A 36px
 * plate on paper carrying one white glyph is the other case, and at 80% it
 * reads as a swatch of something rather than a mark. `CHROMA_CEILING` below is
 * where the two part company.
 *
 * Every tone works from the accent's LIGHT value in both appearances. That is
 * the one picked to carry white text, and a mark does not answer to the theme
 * in any case: the plate stays a saturated colour on both, exactly as `BRANDS`
 * in brand-logos.ts holds GitHub's black and Slack's aubergine. Re-toning per
 * appearance would take the dark side pale, where white ink needs it not to be.
 * White holds at least 3:1 against every point of every ramp, which is the
 * floor for a glyph. See `WHITE_INK_FLOOR`: a hue whose light end would go
 * under gives that part of its ramp back.
 */

/** Sizes are px, and the boundaries are where a step stops being a corner and
 *  starts being a circle. Proportions land at ~25% / ~31% / ~45% of the box. */
export function markTileClass(size: number): string {
  const radius =
    size <= 24 ? "rounded-sm" : size <= 32 ? "rounded-md" : "rounded-control";
  return `flex shrink-0 items-center justify-center overflow-hidden font-semibold ${radius}`;
}

/**
 * A tile's lift: a hairline contact shadow plus a wider glow in the tile's own
 * colour. The tinted half is what makes a mark read as lit rather than as a
 * sticker. A neutral drop shadow under a saturated plate greys the air around
 * it. Kept under 30% so a grid of marks does not haze.
 */
export function markTileShadow(color: string): string {
  return [
    "0 1px 2px rgba(0, 0, 0, 0.08)",
    `0 5px 14px -6px color-mix(in srgb, ${color} 50%, transparent)`,
  ].join(", ");
}

/**
 * How far the ramp travels either side of the accent's own lightness. At 0.07
 * the two ends are about a fifth of the lightness range apart, which reads as
 * a lit object; much wider and the tile reads as two colours meeting.
 */
const RAMP_LIGHTNESS = 0.07;

/**
 * A shared chroma ceiling, and the reason the plates can be pushed at all
 * without one of them running away.
 *
 * The accent table caps every hue at 80% of what it can physically reach, so
 * the ten read as one family in the chrome they were tuned for. A 36px plate
 * on paper is not that job: at 80% the fills land as muted swatches, which is
 * the complaint. But taking every hue to its own ceiling is not the fix
 * either, because the ceilings are nothing alike. In this lightness band cyan
 * holds chroma 0.099 and violet holds 0.288, so "everyone to the edge" is a
 * grid where the violet shouts and the teal cannot answer.
 *
 * A fixed ceiling is what makes them comparable. The hues with headroom stop
 * here; the ones without take their own edge and are the quietest tiles in the
 * grid, which is physics rather than a choice anyone can undo.
 */
const CHROMA_CEILING = 0.18;

/** Just off the gamut edge. Exactly at it, a browser rounding the last step
 *  differently paints a flat clipped band along the light end. */
const CHROMA_HEADROOM = 0.97;

/**
 * A few degrees of hue between the ends, warmer where the light falls. Real
 * light does this and a flat ramp does not, which is most of why a two stop
 * gradient can still look like printed vinyl. Small enough to stay one colour.
 */
const HUE_TILT = 5;

/**
 * The glyph is white on every plate, so the light end of a ramp is the one
 * place legibility can be lost. 3:1 is the floor for a graphic, and a hue
 * reaches it at a different lightness than its neighbours: at one perceptual
 * lightness a warm hue carries far more luminance than a cool one, which is
 * why orange gives up part of its ramp here and teal does not.
 *
 * Trimming the light end rather than shortening every ramp keeps the guard
 * where the problem is. A single span short enough for orange would flatten
 * the other six for a reason none of them have.
 */
const WHITE_INK_FLOOR = 3.05;

/** Bisecting the gamut per stop is cheap but not free, and there are seven
 *  tones for the life of the process. */
const rampCache = new Map<MarkTone, { top: string; bottom: string }>();

function markTileRamp(tone: MarkTone) {
  const cached = rampCache.get(tone);
  if (cached) return cached;

  const base = hexToOklch(getAccentThemeOption(tone).light);
  const stop = (lightness: number, hue: number) =>
    oklchToHex({
      L: lightness,
      C: Math.min(maxChroma(lightness, hue) * CHROMA_HEADROOM, CHROMA_CEILING),
      h: hue,
    });

  const litHue = base.h + HUE_TILT;
  let lit = base.L + RAMP_LIGHTNESS;
  while (
    lit > base.L &&
    contrastRatio("#ffffff", stop(lit, litHue)) < WHITE_INK_FLOOR
  )
    lit -= 0.005;

  const ramp = {
    top: stop(lit, litHue),
    bottom: stop(base.L - RAMP_LIGHTNESS, base.h - HUE_TILT),
  };
  rampCache.set(tone, ramp);
  return ramp;
}

/**
 * Lit from the top left, along the same diagonal the sheen on every other
 * plate in the app runs.
 *
 * The light is LIGHTNESS, not white. Mixing white in is the obvious way to
 * make a highlight and it is what this used to do; white carries no chroma, so
 * every step toward it walks the colour toward grey. That is what made a grid
 * of these read hazy: the top half of each tile was a third less saturated
 * than the colour it was meant to be. Moving L in OKLCH and holding C at the
 * hue's own ceiling brightens the plate while it stays the same colour.
 */
export function markTileGradient(tone: MarkTone): string {
  const { top, bottom } = markTileRamp(tone);
  return `linear-gradient(155deg, ${top}, ${bottom})`;
}

/** The deep end of the ramp. It is what `markTileShadow` wants: the glow
 *  belongs under the weight of the plate, not under the light on it. */
export function markTileInk(tone: MarkTone): string {
  return markTileRamp(tone).bottom;
}

export type MarkTone = (typeof MARK_TONES)[number];

/**
 * Every hue the accent palette has, because the thing these distinguish is a
 * grid of otherwise identical rows. Two tones would put the same plate on half
 * the catalog and give a person nothing to aim at.
 *
 * Every id here is an accent, so `satisfies` is the guard: retire one from the
 * palette and this stops compiling rather than falling back to a colour nobody
 * chose. It has already done that job once. The palette was curated down from
 * ten to seven and Teal, Pink and Violet went with it, which is why this list
 * is five rather than the seven it opened with. The two accents left out are
 * left out on their own terms: `mono` is not a hue, and `lime` is a yellow that
 * only exists above the lightness where white ink works.
 *
 * Five is the floor for this to still be a set. If the palette loses another
 * hue, this stops borrowing and gets its own table, because a mark's colour is
 * an identity for a row rather than a preference someone chose.
 */
export const MARK_TONES = [
  "sky",
  "indigo",
  "green",
  "orange",
  "coral",
] as const satisfies readonly AccentTheme[];
