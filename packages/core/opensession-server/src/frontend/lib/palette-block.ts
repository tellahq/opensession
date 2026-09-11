/**
 * The ```palette fence: one colour per line, rendered as a row of swatches
 * that copy their value on click. Also the one place that decides what a
 * colour is for the swatch chip a hex codespan gets (markdown.ts).
 *
 * The parser is a grammar, not the browser: a value is a colour when it
 * matches a hex form, a known colour function with a flat argument list, or
 * a CSS colour name. It never asks `CSS.supports`, so the fence resolves the
 * same way in a unit test and in the page, and the only thing that ever
 * reaches a `style` attribute is a value this grammar accepted.
 */

import type { FenceUpgrader } from "./fence-upgraders";
import { copyToClipboard } from "./share-link";

export interface PaletteEntry {
  /** The colour as written, trimmed. What the swatch shows and copies. */
  value: string;
  /** Optional label, from either `#hex Name` or `Name: #hex`. */
  name: string;
}

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`. */
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * A colour function with a flat argument list: numbers, percentages, angles,
 * `none`, a colour space name, separators. No nested parentheses, so
 * `color-mix()` and `calc()` stay out: the value is copied verbatim, and a
 * swatch should show one colour, not a computation.
 */
const COLOR_FUNCTION =
  /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(([0-9a-z.%,/+\s-]*[0-9a-z%][0-9a-z.%,/+\s-]*)\)$/i;

/** CSS Color Level 4 named colours, plus `transparent`. */
const NAMED_COLORS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black " +
    "blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse " +
    "chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan " +
    "darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta " +
    "darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
    "deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite " +
    "forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green " +
    "greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender " +
    "lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink " +
    "lightsalmon lightseagreen lightskyblue lightslategray lightslategrey " +
    "lightsteelblue lightyellow lime limegreen linen magenta maroon " +
    "mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen " +
    "mediumslateblue mediumspringgreen mediumturquoise mediumvioletred " +
    "midnightblue mintcream mistyrose moccasin navajowhite navy oldlace " +
    "olive olivedrab orange orangered orchid palegoldenrod palegreen " +
    "paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
    "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown " +
    "salmon sandybrown seagreen seashell sienna silver skyblue slateblue " +
    "slategray slategrey snow springgreen steelblue tan teal thistle tomato " +
    "turquoise violet wheat white whitesmoke yellow yellowgreen transparent"
  ).split(" "),
);

/** Whether `value` is a colour this block will paint and copy. */
export function isCssColor(value: string): boolean {
  return (
    HEX_COLOR.test(value) ||
    COLOR_FUNCTION.test(value) ||
    NAMED_COLORS.has(value.toLowerCase())
  );
}

/**
 * The colour a codespan gets a swatch chip for: exactly `#rrggbb` or
 * `#rrggbbaa`, lowercased, or null. Three and four digit forms are left out
 * on purpose: `#123` in a codespan is far more often an issue number or a
 * heading anchor than a colour, and a wrong chip is worse than a missing one.
 */
export function hexSwatchColor(text: string): string | null {
  return /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)
    ? text.toLowerCase()
    : null;
}

/** A line's leading token: hex, `fn(...)`, or a bare word, up to whitespace
 *  or the end. What the prefix form (`#hex Name`) reads its colour from. */
const LEADING_TOKEN = /^(#[0-9a-f]+|[a-z]+\([^()]*\)|[a-z]+)(?=\s|$)/i;

function parseLine(line: string): PaletteEntry | null {
  const lead = LEADING_TOKEN.exec(line);
  if (lead && isCssColor(lead[1]!)) {
    return { value: lead[1]!, name: line.slice(lead[0].length).trim() };
  }
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  const name = line.slice(0, colon).trim();
  // A trailing `;` or `,` is how a colour arrives when the line was lifted
  // from a stylesheet or an object literal.
  const value = line
    .slice(colon + 1)
    .trim()
    .replace(/[;,]$/, "")
    .trim();
  return name && isCssColor(value) ? { value, name } : null;
}

/**
 * Every non-blank line as a colour, or null when any line is not one: a
 * fence with prose in it is not a palette and stays code.
 */
export function parsePalette(source: string): PaletteEntry[] | null {
  const entries: PaletteEntry[] = [];
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const entry = parseLine(line);
    if (!entry) return null;
    entries.push(entry);
  }
  return entries.length ? entries : null;
}

const COPIED_LABEL = "Copied";
const COPIED_MS = 1600;
const flashTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function flashCopied(swatch: HTMLElement, valueEl: HTMLElement, value: string) {
  const running = flashTimers.get(swatch);
  if (running) clearTimeout(running);
  swatch.dataset.copied = "";
  valueEl.textContent = COPIED_LABEL;
  flashTimers.set(
    swatch,
    setTimeout(() => {
      delete swatch.dataset.copied;
      valueEl.textContent = value;
      flashTimers.delete(swatch);
    }, COPIED_MS),
  );
}

function swatchElement({ value, name }: PaletteEntry): HTMLButtonElement {
  const swatch = document.createElement("button");
  swatch.type = "button";
  swatch.className = "md-palette-swatch";
  swatch.title = `Copy ${value}`;
  swatch.setAttribute("aria-label", `Copy ${name ? `${name} ` : ""}${value}`);
  const tile = document.createElement("span");
  tile.className = "md-palette-tile";
  const fill = document.createElement("span");
  fill.className = "md-palette-fill";
  // `value` passed the grammar above: a hex, a flat colour function or a
  // colour name. Nothing else ever reaches a style.
  fill.style.background = value;
  tile.append(fill);
  const valueEl = document.createElement("span");
  valueEl.className = "md-palette-value";
  valueEl.textContent = value;
  swatch.append(tile);
  if (name) {
    const nameEl = document.createElement("span");
    nameEl.className = "md-palette-name";
    nameEl.textContent = name;
    swatch.append(nameEl);
  }
  swatch.append(valueEl);
  swatch.addEventListener("click", () =>
    copyToClipboard(value, () => flashCopied(swatch, valueEl, value)),
  );
  return swatch;
}

/** Source with a line that is not a colour keeps the plain code fence. */
export const paletteUpgrader: FenceUpgrader = {
  langs: ["palette"],
  async upgrade({ pre, source, root, alive }) {
    const entries = parsePalette(source);
    if (!entries || !alive() || !root.contains(pre)) return false;
    const block = document.createElement("div");
    block.className = "md-palette";
    block.append(...entries.map(swatchElement));
    pre.replaceWith(block);
    return true;
  },
};
