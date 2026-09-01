/**
 * Just enough OKLCH to light a colour without greying it.
 *
 * Mixing white into a fill is the obvious way to make a highlight, and it is
 * wrong for a saturated plate: white has no chroma, so every step toward it
 * pulls the colour toward the grey axis. A 15% white mix of the teal accent
 * lands at #4d9ba4, which is a full third of its chroma gone, and a plate lit
 * that way reads hazy rather than lit.
 *
 * OKLCH separates the three questions. Lightness moves, chroma holds, hue
 * holds, so a ramp brightens the colour while it stays the same colour.
 *
 * `oklch()` is a CSS colour function Chrome and Safari both ship, so this could
 * live in a stylesheet. It stays here because the useful part is not the
 * notation, it is `maxChroma`: sRGB holds wildly different amounts of each hue
 * (at the accent band, cyan tops out at chroma 0.099 while violet reaches
 * 0.288), and a ramp that does not know its own ceiling either clips to
 * something the screen cannot show or leaves half the colour unused. CSS has
 * no way to ask.
 *
 * The transform is Björn Ottosson's, unmodified.
 */

export interface Oklch {
  /** Perceptual lightness, 0 to 1. */
  L: number;
  /** Distance from grey. See `maxChroma`: the sRGB ceiling is per hue. */
  C: number;
  /** Degrees. */
  h: number;
}

const srgbToLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

const linearToSrgb = (c: number) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;

function linearFromHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  return [0, 2, 4].map((i) =>
    srgbToLinear(parseInt(full.slice(i, i + 2), 16) / 255),
  ) as [number, number, number];
}

function oklabFromLinear(r: number, g: number, b: number) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ] as const;
}

function linearFromOklch({ L, C, h }: Oklch) {
  const rad = (h * Math.PI) / 180;
  const a = C * Math.cos(rad);
  const b = C * Math.sin(rad);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ] as const;
}

export function hexToOklch(hex: string): Oklch {
  const [L, a, b] = oklabFromLinear(...linearFromHex(hex));
  // Normalised to 0 to 360 rather than atan2's -180 to 180, so a hue can be
  // compared against a literal without the caller thinking about the seam.
  const h = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return { L, C: Math.hypot(a, b), h };
}

/**
 * WCAG relative luminance, which is a different question from OKLCH's L and
 * cannot be substituted for it. L is perceptual lightness, so equal L across
 * hues looks equally light; luminance is physical, so at one L a yellow
 * carries far more of it than a blue. Contrast is defined on the physical one.
 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = linearFromHex(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  ) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

const IN_GAMUT_EPSILON = 1e-4;

function inGamut(color: Oklch): boolean {
  return linearFromOklch(color).every(
    (c) => c >= -IN_GAMUT_EPSILON && c <= 1 + IN_GAMUT_EPSILON,
  );
}

/**
 * The most chroma this hue can carry at this lightness inside sRGB.
 *
 * Bisection rather than a closed form: the sRGB gamut boundary in OKLCH has no
 * simple one, and 24 halvings of a 0.4 range settle it to 2e-8, far under a
 * step anyone can see. It costs about 24 matrix multiplies, so memoize if you
 * are calling it per frame rather than per palette.
 */
export function maxChroma(L: number, h: number): number {
  let low = 0;
  let high = 0.4;
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    if (inGamut({ L, C: mid, h })) low = mid;
    else high = mid;
  }
  return low;
}

/**
 * Hex, gamut mapped by giving up CHROMA rather than by clipping the channels.
 *
 * Clipping is what a naive conversion does, and it moves hue: an out of range
 * blue clips its red channel to 0 and comes back visibly more cyan than it was
 * asked for. Holding L and h and walking chroma back in keeps the colour the
 * one that was requested, at the most saturation the screen can actually show.
 */
export function oklchToHex(color: Oklch): string {
  const safe = inGamut(color)
    ? color
    : { ...color, C: maxChroma(color.L, color.h) };
  return `#${linearFromOklch(safe)
    .map((c) =>
      Math.round(Math.min(1, Math.max(0, linearToSrgb(Math.max(0, c)))) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
