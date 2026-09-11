/**
 * ```ansi and ```terminal fences: terminal output rendered with its SGR
 * colours and styles (`\x1b[...m`) as styled spans. A bash, sh, console or
 * text fence that actually carries an escape byte renders the same way
 * (`claims`). Every other escape (cursor movement, erase, OSC titles) is
 * stripped, and everything else is escaped as text: a transcript is
 * untrusted input.
 *
 * The block stays a <pre> inside the copy control's wrapper, so copy reads
 * the text without its escape codes and the wrap toggle keeps working.
 *
 * The parser is a pure function over the string (see ansi-block.test.ts);
 * the DOM part below is one element swap.
 */

import type { FenceUpgrader } from "./fence-upgraders";

/** Info-string languages that always render as terminal output. */
export const ANSI_LANGS = ["ansi", "terminal"] as const;
const ANSI_LANG_SET: ReadonlySet<string> = new Set(ANSI_LANGS);

/** Fences that render as terminal output only when they carry an escape. */
const ESCAPE_CLAIM_LANGS = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "console",
  "text",
  "log",
]);

const ESC = "\u001b";

/**
 * Whether a fence of `lang` should render as terminal output. An explicit
 * ansi/terminal fence always does; a shell or text fence only when its
 * source holds a real escape byte followed by `[`.
 */
export function claimsAnsi(lang: string, source: string): boolean {
  if (ANSI_LANG_SET.has(lang)) return true;
  return ESCAPE_CLAIM_LANGS.has(lang) && source.includes(`${ESC}[`);
}

/**
 * The text to parse. An explicit ansi/terminal fence written by a model
 * usually spells the escape rather than emitting the byte (`\x1b[31m`,
 * `\e[31m`, `\033[31m`, `\u001b[31m`), so those spellings are decoded when
 * the fence carries no real escape at all. A shell fence is left alone: it
 * only claimed because it has the real byte.
 */
export function terminalSource(lang: string, source: string): string {
  if (!ANSI_LANG_SET.has(lang)) return source;
  if (source.includes(ESC)) return source;
  return source.replace(/\\(?:x1[bB]|u001[bB]|033|e)(?=\[)/g, ESC);
}

export type AnsiColor =
  /** One of the 16 base colours, themed through `--ansi-*` tokens. */
  | { kind: "base"; index: number }
  /** A 256-colour or 24-bit colour: data, emitted as a literal rgb(). */
  | { kind: "rgb"; r: number; g: number; b: number };

export interface AnsiStyle {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
  hidden: boolean;
  fg: AnsiColor | null;
  bg: AnsiColor | null;
}

export interface AnsiSpan {
  text: string;
  style: AnsiStyle;
}

const DEFAULT_STYLE: AnsiStyle = {
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strike: false,
  inverse: false,
  hidden: false,
  fg: null,
  bg: null,
};

/** CSI: ESC [ parameter bytes, intermediate bytes, one final byte. */
const CSI_RE = /^\u001b\[([0-?]*)([ -/]*)([@-~])/;
/** OSC: ESC ] ... terminated by BEL or ST (ESC \). Unterminated runs to the end. */
const OSC_RE = /^\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/;
/** Charset and other two-byte escapes: ESC ( B, ESC ) 0, ESC # 8, ESC % G. */
const TWO_BYTE_RE = /^\u001b[()*+#%][\s\S]?/;

/** Index in the 256-colour cube to its rgb. 0-15 stay base colours. */
export function color256(n: number): AnsiColor | null {
  if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  if (n < 16) return { kind: "base", index: n };
  if (n < 232) {
    const i = n - 16;
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return {
      kind: "rgb",
      r: level(Math.floor(i / 36)),
      g: level(Math.floor(i / 6) % 6),
      b: level(i % 6),
    };
  }
  const grey = 8 + (n - 232) * 10;
  return { kind: "rgb", r: grey, g: grey, b: grey };
}

function channel(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
}

interface ExtendedColor {
  /** Null when the parameters were malformed. */
  color: AnsiColor | null;
  /** How many parameters after the introducer were consumed. */
  used: number;
}

/**
 * The colour after a 38/48 introducer. `args` are the parameters that follow
 * it: `5;n`, `2;r;g;b`, or the colon form `2::r:g:b` with an empty colour
 * space id.
 */
function extendedColor(args: string[]): ExtendedColor {
  if (args[0] === "5") {
    const n = channel(args[1]);
    return { color: n === null ? null : color256(n), used: 2 };
  }
  if (args[0] === "2") {
    const offset = args.length >= 5 && args[1] === "" ? 2 : 1;
    const r = channel(args[offset]);
    const g = channel(args[offset + 1]);
    const b = channel(args[offset + 2]);
    const color =
      r === null || g === null || b === null
        ? null
        : { kind: "rgb" as const, r, g, b };
    return { color, used: offset + 3 };
  }
  return { color: null, used: 1 };
}

/** Apply one SGR parameter string (`1;31`, `38;5;208`, empty = reset). */
export function applySgr(params: string, style: AnsiStyle): AnsiStyle {
  const next = { ...style };
  const parts = params === "" ? ["0"] : params.split(";");
  for (let i = 0; i < parts.length; i++) {
    const sub = parts[i]!.split(":");
    const code = sub[0] === "" ? 0 : Number(sub[0]);
    if (!Number.isInteger(code)) continue;
    if (code === 0) Object.assign(next, DEFAULT_STYLE);
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 8) next.hidden = true;
    else if (code === 9) next.strike = true;
    else if (code === 22) next.bold = next.dim = false;
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code === 28) next.hidden = false;
    else if (code === 29) next.strike = false;
    else if (code >= 30 && code <= 37)
      next.fg = { kind: "base", index: code - 30 };
    else if (code === 39) next.fg = null;
    else if (code >= 40 && code <= 47)
      next.bg = { kind: "base", index: code - 40 };
    else if (code === 49) next.bg = null;
    else if (code >= 90 && code <= 97)
      next.fg = { kind: "base", index: code - 90 + 8 };
    else if (code >= 100 && code <= 107)
      next.bg = { kind: "base", index: code - 100 + 8 };
    else if (code === 38 || code === 48) {
      // Colon form carries its arguments inside this parameter; the
      // semicolon form spreads them over the ones that follow.
      const inline = sub.length > 1;
      const { color, used } = extendedColor(
        inline ? sub.slice(1) : parts.slice(i + 1),
      );
      if (!inline) i += used;
      if (code === 38) next.fg = color;
      else next.bg = color;
    }
  }
  return next;
}

/**
 * Split terminal output into runs of text that share one style. SGR
 * sequences change the style; every other escape is dropped.
 */
export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let style = DEFAULT_STYLE;
  let text = "";
  const flush = () => {
    if (text) spans.push({ text, style });
    text = "";
  };
  let i = 0;
  while (i < input.length) {
    const at = input.indexOf(ESC, i);
    if (at < 0) {
      text += input.slice(i);
      break;
    }
    text += input.slice(i, at);
    const rest = input.slice(at);
    const csi = CSI_RE.exec(rest);
    if (csi) {
      if (csi[3] === "m" && csi[2] === "") {
        const next = applySgr(csi[1]!, style);
        flush();
        style = next;
      }
      i = at + csi[0].length;
      continue;
    }
    const other = OSC_RE.exec(rest) ?? TWO_BYTE_RE.exec(rest);
    // A lone ESC and whatever single byte follows it (ESC 7, ESC =, ...).
    i = at + (other ? other[0].length : Math.min(2, rest.length));
  }
  flush();
  return spans;
}

const BASE_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
] as const;

/** The token suffix for a base colour: `red`, `bright-red`. */
export function baseColorName(index: number): string {
  const name = BASE_NAMES[index % 8]!;
  return index >= 8 ? `bright-${name}` : name;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function colorAttrs(
  color: AnsiColor | null,
  role: "fg" | "bg",
  classes: string[],
  styles: string[],
): void {
  if (!color) return;
  if (color.kind === "base") {
    classes.push(`ansi-${role}-${baseColorName(color.index)}`);
    return;
  }
  const value = `rgb(${color.r},${color.g},${color.b})`;
  styles.push(`${role === "fg" ? "color" : "background-color"}:${value}`);
}

/** One span's opening tag attributes, or null when it carries no style. */
export function spanAttributes(style: AnsiStyle): string | null {
  const classes: string[] = [];
  const styles: string[] = [];
  if (style.bold) classes.push("ansi-bold");
  if (style.dim) classes.push("ansi-dim");
  if (style.italic) classes.push("ansi-italic");
  if (style.underline) classes.push("ansi-underline");
  if (style.strike) classes.push("ansi-strike");
  if (style.hidden) classes.push("ansi-hidden");
  if (style.inverse) {
    // Swap the two. The class supplies the defaults for whichever side had
    // none; an explicit colour lands on the other side.
    classes.push("ansi-inverse");
    colorAttrs(style.bg, "fg", classes, styles);
    colorAttrs(style.fg, "bg", classes, styles);
  } else {
    colorAttrs(style.fg, "fg", classes, styles);
    colorAttrs(style.bg, "bg", classes, styles);
  }
  if (classes.length === 0 && styles.length === 0) return null;
  let attrs = "";
  if (classes.length) attrs += ` class="${classes.join(" ")}"`;
  if (styles.length) attrs += ` style="${styles.join(";")}"`;
  return attrs;
}

/** The spans as HTML for the block's <code>. Text is escaped; colours from
 *  the data are integers, so the inline style cannot carry anything else. */
export function renderAnsiHtml(spans: AnsiSpan[]): string {
  let html = "";
  for (const span of spans) {
    const text = escapeHtml(span.text);
    const attrs = spanAttributes(span.style);
    html += attrs === null ? text : `<span${attrs}>${text}</span>`;
  }
  return html;
}

export const ansiUpgrader: FenceUpgrader = {
  langs: [...ANSI_LANGS],
  claims: claimsAnsi,
  keepsCodeControls: true,
  async upgrade({ pre, source, lang, root, alive }) {
    const html = renderAnsiHtml(parseAnsi(terminalSource(lang, source)));
    // Replace the fence only once the copy control's wrapper is around it
    // (see fence-upgraders.ts): the new <pre> takes the fence's place inside
    // that wrapper, so the controls read the escape-free text from it.
    await Promise.resolve();
    if (!alive() || !root.contains(pre)) return false;
    const block = document.createElement("pre");
    block.className = "md-ansi";
    const code = document.createElement("code");
    code.innerHTML = html;
    block.append(code);
    pre.replaceWith(block);
    return true;
  },
};
