/**
 * Report theming — makes an agent-authored report readable in whichever theme
 * the app is in, without asking 300 already-published documents to change.
 *
 * A report is a standalone HTML document written by an automation run
 * (src/server/reports.ts), and almost every one of them ships its own palette
 * in an inline <style>. That was fine while the app was light. It is a white
 * slab in a dark window.
 *
 * The document is adapted at SERVE time, not in the browser: the raw route
 * carries `?theme=`, so the bytes arrive already in the right scheme and there
 * is no flash of the wrong one. The iframe cannot help us here anyway — its
 * CSP is `sandbox allow-same-origin` with no scripts, so nothing inside the
 * report can adapt itself, and the parent can only reach in after first paint.
 *
 * Three paths, in the order they are tried:
 *
 *   1. The document handles both schemes itself (it wrote a
 *      `prefers-color-scheme` block). Its media queries resolve against the OS,
 *      which is not what the app's theme pref says, so the branch it should
 *      take is FORCED and its colours are left exactly as authored.
 *   2. The document is already in the target scheme. Nothing to do.
 *   3. The document is light and dark was asked for. Every colour it authored
 *      is flipped in lightness (OKLCH: keep hue and chroma, invert L), which
 *      keeps a red chip red and a green chip green where a page-level
 *      `filter: invert()` would turn them into each other's opposites and take
 *      every screenshot with them.
 *
 * The flip is deliberately ALL-OR-NOTHING. A half-converted document — muddy
 * chips, a light card floating on a dark page — reads as a bug, while an
 * honest light document on dark chrome reads as a document. So anything the
 * transform is not confident about bails out to the authored bytes in their
 * own scheme, and the only thing that is always injected is the house baseline
 * below.
 *
 * Light is never rewritten. A report is evidence, and the default response
 * stays the bytes the agent published.
 */

/** The two schemes a report can be served in. */
export type ReportTheme = "light" | "dark";

/**
 * Values resolved from src/frontend/styles/base.css. A report is its own
 * document and cannot see the app's custom properties, so they are baked in
 * here — keep them in sync with the token blocks in base.css.
 */
const PALETTE = {
  light: {
    bg: "#ffffff",
    text: "#1a1a1a",
    dim: "#646464",
    faint: "#949494",
    border: "#e2e2e2",
    panel: "#f6f6f6",
    well: "#f6f8fa",
    wellLine: "#d8dee4",
    green: "#009740",
    yellow: "#9a6700",
    red: "#de3334",
    greenSoft: "rgba(0, 151, 64, 0.12)",
    yellowSoft: "rgba(154, 103, 0, 0.12)",
    redSoft: "rgba(222, 51, 52, 0.1)",
  },
  dark: {
    bg: "#1c1c1c",
    text: "#e9e9e9",
    dim: "#a2a2a2",
    faint: "#767676",
    border: "#333333",
    panel: "#262626",
    well: "#0d0f13",
    wellLine: "rgba(255, 255, 255, 0.06)",
    green: "#00bc52",
    yellow: "#d29922",
    red: "#fc4a47",
    greenSoft: "rgba(0, 188, 82, 0.14)",
    yellowSoft: "rgba(210, 153, 34, 0.14)",
    redSoft: "rgba(252, 74, 71, 0.12)",
  },
} as const;

/**
 * The house baseline: what a report looks like when it brings no styling of
 * its own. It is injected FIRST, so anything the document authored still wins,
 * and it is what the publish tool points agents at so new reports can be plain
 * semantic HTML and be correct in both schemes for free.
 *
 * `plain` withholds the page itself — the measure, the margins, the vertical
 * rhythm — from a document that wrote its own CSS. Those are the properties a
 * document sets somewhere OTHER than on `body` (a `.wrap` with its own
 * max-width is the usual shape), so they are the ones a baseline can quietly
 * win by default and reflow a report that was laid out to be wide. Colours and
 * element styling stay in both cases: those a document either states, and
 * wins, or never had.
 */
export function reportBaselineCss(theme: ReportTheme, plain = true): string {
  const c = PALETTE[theme];
  const page = plain
    ? `body{margin:0 auto;padding:2rem 1.25rem 4rem;max-width:72ch}
h1,h2,h3,h4{line-height:1.25;font-weight:600;margin:2rem 0 .5rem}
h1{font-size:1.5rem;margin-top:0}
h2{font-size:1.2rem}
h3{font-size:1rem}
p,ul,ol,table,pre,blockquote{margin:0 0 1rem}
li{margin-bottom:.35rem}
table{width:100%}
`
    : "";
  // Nothing here paints `html`. A background on the root element stops the
  // body's own from propagating to the canvas, which would leave any document
  // with a paper of its own — a dark report, a warm off-white one — painting
  // only as far as its measure and showing a seam past the last line.
  return `:root{color-scheme:${theme};--report-bg:${c.bg};--report-text:${c.text};--report-dim:${c.dim};--report-line:${c.border};--report-panel:${c.panel};--report-green:${c.green};--report-yellow:${c.yellow};--report-red:${c.red}}
body{background:${c.bg};color:${c.text};font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
${page}a{color:${c.text};text-underline-offset:2px}
small,.meta,.quiet-text{color:${c.dim};font-size:.85em}
hr{border:0;border-top:1px solid ${c.border};margin:2rem 0}
code,kbd{background:${c.well};color:${c.text};border-radius:4px;padding:.1em .3em;font-size:.9em}
pre{background:${c.well};border:1px solid ${c.wellLine};border-radius:8px;padding:.75rem 1rem;overflow:auto}
pre code{background:none;padding:0}
blockquote{border-left:3px solid ${c.border};margin-left:0;padding:.1rem 0 .1rem 1rem;color:${c.dim}}
table{border-collapse:collapse}
th,td{border-bottom:1px solid ${c.border};padding:.4rem .6rem;text-align:left;vertical-align:top}
th{font-weight:600;color:${c.dim};font-size:.85em}
img,video{max-width:100%;height:auto;border-radius:8px}
.card,.panel{background:${c.panel};border-radius:12px;padding:1rem 1.25rem}
.chip{display:inline-block;border-radius:6px;padding:.1em .5em;font-size:.85em;font-weight:500}
.chip.positive{background:${c.greenSoft};color:${c.green}}
.chip.warning{background:${c.yellowSoft};color:${c.yellow}}
.chip.negative{background:${c.redSoft};color:${c.red}}`;
}

/* ------------------------------------------------------------------ *
 * Colour maths: sRGB <-> OKLCH, enough to flip a lightness in place.
 * ------------------------------------------------------------------ */

interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

function rgbToOklch(c: Rgb): { l: number; c: number; h: number } {
  const r = srgbToLinear(c.r);
  const g = srgbToLinear(c.g);
  const b = srgbToLinear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const okL = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const okA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const okB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return {
    l: okL,
    c: Math.hypot(okA, okB),
    h: Math.atan2(okB, okA),
  };
}

function oklchToRgb(l: number, chroma: number, h: number): Rgb {
  const a = Math.cos(h) * chroma;
  const b = Math.sin(h) * chroma;
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: linearToSrgb(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    g: linearToSrgb(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    b: linearToSrgb(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
    a: 1,
  };
}

function inGamut(c: Rgb): boolean {
  const e = 0.0005;
  return (
    c.r >= -e &&
    c.r <= 1 + e &&
    c.g >= -e &&
    c.g <= 1 + e &&
    c.b >= -e &&
    c.b <= 1 + e
  );
}

/**
 * Where a lightness lands after the flip, as a curve through the app's own
 * palette rather than a straight `1 - L`.
 *
 * A straight inversion gets two things wrong at once. It sends paper to pure
 * black and ink to pure white, which is harsher than any theme in the app; and
 * it collapses the near-white end, where a light document does most of its
 * work — page #ffffff, card #f4f6f9 and rule #e3e6ee are three steps a reader
 * can see, and inverted they land within a hundredth of each other and the
 * card disappears into the page.
 *
 * So the ends are anchored on the tokens those surfaces mean (base.css `--bg`,
 * `--bg-panel`, `--border`, `--text-dim`, `--text`) and the near-white end is
 * given room to spread. Between the anchors it interpolates.
 */
const LIGHTNESS_CURVE: Array<[from: number, to: number]> = [
  [0.0, 0.97], // pure black ink -> the brightest ink the app uses
  [0.26, 0.933], // near-black body text -> --text #e9e9e9
  [0.55, 0.712], // mid grey secondary text -> --text-dim #a2a2a2
  [0.75, 0.47], // mid tone -> mid tone, roughly where it started
  [0.92, 0.322], // hairline grey -> --border #333333
  [0.97, 0.268], // card / code wash -> --bg-panel #262626
  [1.0, 0.222], // paper -> --bg #1c1c1c
];

function flipLightness(l: number): number {
  const x = Math.min(1, Math.max(0, l));
  for (let i = 1; i < LIGHTNESS_CURVE.length; i++) {
    const [x1, y1] = LIGHTNESS_CURVE[i];
    if (x > x1) continue;
    const [x0, y0] = LIGHTNESS_CURVE[i - 1];
    const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
    return y0 + t * (y1 - y0);
  }
  return LIGHTNESS_CURVE[LIGHTNESS_CURVE.length - 1][1];
}

function flipColor(c: Rgb): Rgb {
  const { l, c: chroma, h } = rgbToOklch(c);
  const targetL = flipLightness(l);
  let lo = 0;
  let hi = chroma;
  let best = oklchToRgb(targetL, 0, h);
  // Grey stays grey; only search when there is chroma to preserve.
  if (chroma > 0.0001) {
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      const candidate = oklchToRgb(targetL, mid, h);
      if (inGamut(candidate)) {
        best = candidate;
        lo = mid;
      } else {
        hi = mid;
      }
    }
  }
  const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v * 255)));
  return {
    r: clamp(best.r) / 255,
    g: clamp(best.g) / 255,
    b: clamp(best.b) / 255,
    a: c.a,
  };
}

/* ------------------------------------------------------------------ *
 * Colour literals in CSS text.
 * ------------------------------------------------------------------ */

/** The CSS named colours that turn up in authored reports, plus the greys. */
const NAMED: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  whitesmoke: "#f5f5f5",
  ghostwhite: "#f8f8ff",
  snow: "#fffafa",
  ivory: "#fffff0",
  silver: "#c0c0c0",
  gainsboro: "#dcdcdc",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  gray: "#808080",
  grey: "#808080",
  darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9",
  dimgray: "#696969",
  dimgrey: "#696969",
  red: "#ff0000",
  crimson: "#dc143c",
  firebrick: "#b22222",
  darkred: "#8b0000",
  tomato: "#ff6347",
  orange: "#ffa500",
  orangered: "#ff4500",
  gold: "#ffd700",
  yellow: "#ffff00",
  green: "#008000",
  darkgreen: "#006400",
  forestgreen: "#228b22",
  seagreen: "#2e8b57",
  lime: "#00ff00",
  limegreen: "#32cd32",
  teal: "#008080",
  blue: "#0000ff",
  navy: "#000080",
  royalblue: "#4169e1",
  steelblue: "#4682b4",
  dodgerblue: "#1e90ff",
  cornflowerblue: "#6495ed",
  slategray: "#708090",
  slategrey: "#708090",
  purple: "#800080",
  indigo: "#4b0082",
  violet: "#ee82ee",
  magenta: "#ff00ff",
  pink: "#ffc0cb",
  brown: "#a52a2a",
  tan: "#d2b48c",
  beige: "#f5f5dc",
};

function parseHex(token: string): Rgb | null {
  const hex = token.slice(1);
  const expand = (s: string) => parseInt(s.length === 1 ? s + s : s, 16) / 255;
  if (hex.length === 3 || hex.length === 4) {
    return {
      r: expand(hex[0]),
      g: expand(hex[1]),
      b: expand(hex[2]),
      a: hex.length === 4 ? expand(hex[3]) : 1,
    };
  }
  if (hex.length === 6 || hex.length === 8) {
    return {
      r: parseInt(hex.slice(0, 2), 16) / 255,
      g: parseInt(hex.slice(2, 4), 16) / 255,
      b: parseInt(hex.slice(4, 6), 16) / 255,
      a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
  }
  return null;
}

function parseNumberList(body: string): number[] | null {
  const parts = body
    .split(/[\s,/]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: number[] = [];
  for (const part of parts) {
    const pct = part.endsWith("%");
    const n = Number.parseFloat(pct ? part.slice(0, -1) : part);
    if (!Number.isFinite(n)) return null;
    out.push(pct ? n / 100 : n);
    // A percentage in the alpha slot and one in a channel slot mean
    // different things; the caller scales what it knows about.
    if (pct) out[out.length - 1] = n / 100;
  }
  return out.length ? out : null;
}

function hueToRgb(p: number, q: number, t: number): number {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}

/** rgb()/rgba()/hsl()/hsla(), legacy comma form and modern space form. */
function parseFunctionalColor(fn: string, body: string): Rgb | null {
  const raw = body.split(/[\s,/]+/).filter(Boolean);
  const nums = parseNumberList(body);
  if (!nums || nums.length < 3) return null;
  const alpha = nums.length > 3 ? Math.min(1, Math.max(0, nums[3])) : 1;
  if (fn === "rgb" || fn === "rgba") {
    const scale = (i: number) =>
      raw[i]?.endsWith("%") ? nums[i] : nums[i] / 255;
    return { r: scale(0), g: scale(1), b: scale(2), a: alpha };
  }
  // hsl(): hue in degrees (or turn/rad, which reports do not use), then two
  // percentages.
  const h = (((nums[0] % 360) + 360) % 360) / 360;
  const s = Math.min(1, Math.max(0, nums[1]));
  const l = Math.min(1, Math.max(0, nums[2]));
  if (s === 0) return { r: l, g: l, b: l, a: alpha };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hueToRgb(p, q, h + 1 / 3),
    g: hueToRgb(p, q, h),
    b: hueToRgb(p, q, h - 1 / 3),
    a: alpha,
  };
}

function formatColor(c: Rgb): string {
  const hex = (v: number) =>
    Math.min(255, Math.max(0, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  if (c.a >= 0.999) return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
  const round = (v: number) => Math.min(255, Math.max(0, Math.round(v * 255)));
  return `rgba(${round(c.r)}, ${round(c.g)}, ${round(c.b)}, ${Number(
    c.a.toFixed(3),
  )})`;
}

/** Relative luminance, for deciding which scheme a document is written in. */
function luminance(c: Rgb): number {
  return (
    0.2126 * srgbToLinear(c.r) +
    0.7152 * srgbToLinear(c.g) +
    0.0722 * srgbToLinear(c.b)
  );
}

function parseColor(token: string): Rgb | null {
  const t = token.trim().toLowerCase();
  if (!t) return null;
  if (t.startsWith("#")) return parseHex(t);
  const named = NAMED[t];
  if (named) return parseHex(named);
  const fn = t.match(/^(rgba?|hsla?)\(([^()]*)\)$/);
  if (fn) return parseFunctionalColor(fn[1], fn[2]);
  return null;
}

/* ------------------------------------------------------------------ *
 * Walking the CSS.
 * ------------------------------------------------------------------ */

/**
 * Colour-bearing tokens, matched only outside strings, comments and url().
 *
 * The boundaries exclude `-`, which `\b` does not. A CSS identifier is full of
 * colour words — `--red`, `--gray-bg`, `--green` — and rewriting one turns a
 * live reference into `var(--#fa0000)`, so the chip that named it silently
 * loses its fill. A word before `(` is a function name, never a colour.
 */
const COLOR_TOKEN =
  /(?<![\w-])#[0-9a-fA-F]{3,8}(?![\w-])|(?<![\w-])(?:rgba?|hsla?)\([^()]*\)|(?<![\w-])[a-zA-Z]+(?![\w-(])/g;

/**
 * Rewrite every colour in a declaration value. Shadows are left alone: an
 * `rgba(0,0,0,.4)` shadow flipped to white is the classic smart-invert
 * artefact, a glow around every card.
 */
function flipValue(value: string): string {
  return value.replace(COLOR_TOKEN, (token) => {
    // Never touch what is inside url(...) — handled by the caller, which
    // never hands those regions here — or a bare keyword that is not a
    // colour (`solid`, `inset`, `px` fragments are excluded by parseColor).
    const color = parseColor(token);
    if (!color) return token;
    return formatColor(flipColor(color));
  });
}

interface CssRegion {
  /** Text that is copied through untouched (strings, comments, url()). */
  verbatim: boolean;
  text: string;
}

/** Split CSS into regions, isolating what must never be pattern-matched. */
function splitCss(css: string): CssRegion[] {
  const out: CssRegion[] = [];
  let buf = "";
  let i = 0;
  const push = (verbatim: boolean, text: string) => {
    if (text) out.push({ verbatim, text });
  };
  while (i < css.length) {
    const ch = css[i];
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const stop = end === -1 ? css.length : end + 2;
      push(false, buf);
      buf = "";
      push(true, css.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== ch) j += css[j] === "\\" ? 2 : 1;
      push(false, buf);
      buf = "";
      push(true, css.slice(i, Math.min(j + 1, css.length)));
      i = j + 1;
      continue;
    }
    if (/u/i.test(ch) && /^url\(/i.test(css.slice(i, i + 4))) {
      // url() can hold an unquoted data: URI with anything in it.
      let depth = 0;
      let j = i + 3;
      for (; j < css.length; j++) {
        if (css[j] === "(") depth++;
        else if (css[j] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      push(false, buf);
      buf = "";
      push(true, css.slice(i, Math.min(j + 1, css.length)));
      i = j + 1;
      continue;
    }
    buf += ch;
    i++;
  }
  push(false, buf);
  return out;
}

/** Rewrite colours across a stylesheet, declaration by declaration. */
function flipCss(css: string, target: ReportTheme): string {
  return splitCss(css)
    .map((region) => {
      if (region.verbatim) return region.text;
      // Within a non-verbatim region, only the part of a declaration after
      // its colon is a value. Selectors and at-rule preludes are left as
      // they are, so a selector like `.red` or `a` is never mistaken for a
      // colour keyword.
      return region.text.replace(
        /([-\w]+)(\s*:\s*)([^;{}]*)/g,
        (match, prop: string, sep: string, value: string) => {
          // A shadow is ink, not a surface: flipping `rgba(0,0,0,.4)`
          // paints a white glow around every card, which is the tell of
          // a naively inverted page.
          if (/shadow$/i.test(prop)) return match;
          // The document's own declaration outranks the baseline's, so
          // a page that pinned itself to light would keep a light
          // canvas and light form controls under flipped colours.
          if (prop.toLowerCase() === "color-scheme") return prop + sep + target;
          return prop + sep + flipValue(value);
        },
      );
    })
    .join("");
}

/* ------------------------------------------------------------------ *
 * Reading the document.
 * ------------------------------------------------------------------ */

const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

function styleBlocks(html: string): string[] {
  return [...html.matchAll(STYLE_BLOCK)].map((m) => m[1]);
}

/** Custom properties declared at :root / html, for resolving `var(--bg)`. */
function rootVariables(css: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(^|,)\s*(:root|html)\s*(,|$)/.test(rule[1])) continue;
    for (const decl of rule[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g))
      vars.set(decl[1], decl[2].trim());
  }
  return vars;
}

function resolveVar(value: string, vars: Map<string, string>): string {
  let v = value.trim();
  for (let i = 0; i < 3; i++) {
    const ref = v.match(/^var\(\s*(--[\w-]+)\s*(?:,([^)]*))?\)$/);
    if (!ref) return v;
    v = (vars.get(ref[1]) ?? ref[2] ?? "").trim();
  }
  return v;
}

/** The page background the document paints, resolved through one var() hop. */
function authoredBackground(css: string): Rgb | null {
  const vars = rootVariables(css);
  let found: Rgb | null = null;
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim();
    if (!/(^|,)\s*(body|html)\s*(,|$)/.test(selector)) continue;
    for (const decl of rule[2].matchAll(
      /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/g,
    )) {
      // A shorthand can carry a gradient or an image plus a colour; the
      // last colour token in it is the one that paints the page.
      const value = resolveVar(decl[1], vars);
      for (const token of value.match(COLOR_TOKEN) || []) {
        const color = parseColor(token);
        if (color && color.a > 0.5) found = color;
      }
    }
  }
  return found;
}

/** What scheme the document is written in, as far as we can tell. */
export function authoredScheme(html: string): ReportTheme | "adaptive" {
  const css = styleBlocks(html).join("\n");
  if (/@media[^{]*prefers-color-scheme/i.test(css)) return "adaptive";
  const bg = authoredBackground(css);
  if (bg) return luminance(bg) < 0.18 ? "dark" : "light";
  // No page background: a document that only declared `color-scheme: dark`
  // still paints dark, because the UA paints the canvas for it.
  const declared = css.match(/color-scheme\s*:\s*([^;}]+)/i)?.[1] || "";
  if (/\bdark\b/i.test(declared) && !/\blight\b/i.test(declared)) return "dark";
  // Otherwise the browser default: white paper.
  return "light";
}

/**
 * Force a `prefers-color-scheme` document onto one branch. Its media queries
 * would otherwise resolve against the OS, which has nothing to do with the
 * theme the app is in.
 */
function forceColorSchemeQueries(html: string, target: ReportTheme): string {
  return html.replace(STYLE_BLOCK, (block, css: string) =>
    block.replace(
      css,
      css.replace(
        /@media([^{]*)\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)([^{]*)/gi,
        (_match, before: string, scheme: string, after: string) => {
          const keep = scheme.toLowerCase() === target;
          // The rest of the prelude is dropped with the query it
          // qualified: these blocks are always the whole theme, never
          // a width-plus-scheme combination in practice, and `not all`
          // is the only reliable way to switch a block off.
          void before;
          void after;
          return keep ? "@media all" : "@media not all";
        },
      ),
    ),
  );
}

function injectBaseline(html: string, theme: ReportTheme): string {
  const plain = styleBlocks(html).length === 0;
  const style = `<style data-opensession-report-baseline>\n${reportBaselineCss(theme, plain)}\n</style>`;
  // First in <head> so the document's own rules still win at equal
  // specificity. A document with no <head> gets it up front, which is where
  // the parser would have put one anyway.
  if (/<head\b[^>]*>/i.test(html))
    return html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${style}`);
  if (/<html\b[^>]*>/i.test(html))
    return html.replace(/<html\b[^>]*>/i, (m) => `${m}\n${style}`);
  return `${style}\n${html}`;
}

/**
 * Serve a report in `theme`. Returns the document unchanged apart from the
 * injected baseline whenever it already suits the target, and falls back to
 * exactly that if the colour transform throws for any reason.
 */
export function adaptReportHtml(html: string, theme: ReportTheme): string {
  try {
    const scheme = authoredScheme(html);
    if (scheme === "adaptive")
      return injectBaseline(forceColorSchemeQueries(html, theme), theme);
    // Light is served as authored: a report is evidence, and the transform
    // only ever runs to rescue a light document from a dark window. A
    // document already in the target scheme needs nothing either — both get
    // the baseline for the scheme they are actually in.
    if (theme === "light" || scheme === "dark")
      return injectBaseline(html, scheme);
    const flipped = html.replace(STYLE_BLOCK, (block, css: string) =>
      block.replace(css, flipCss(css, "dark")),
    );
    const withInline = flipped.replace(
      /\sstyle="([^"]*)"/gi,
      (match, css: string) => {
        const next = flipCss(css, "dark");
        return next === css ? match : ` style="${next}"`;
      },
    );
    return injectBaseline(withInline, "dark");
  } catch {
    // An honest light document beats a half-converted one.
    return injectBaseline(html, "light");
  }
}
