/**
 * Math in session markdown, typeset by KaTeX.
 *
 * Three forms reach here. A ```math fence and a `$$` block on its own lines
 * are both display math; markdown.ts turns the `$$` block into the same
 * `<pre><code class="language-math">` marked writes for the fence, so one
 * upgrader handles both and either keeps a readable code block when KaTeX
 * declines. `$x^2$` (and `$$x^2$$` on one line) is inline: markdown.ts emits
 * the `.md-math` placeholder below with the source as its text, and
 * `upgradeMathPlaceholders` typesets it in the same post-mount pass.
 *
 * The grammar that tells `$x^2$` from `$5 to $10` lives here too, as pure
 * matchers, so it can be tested without marked.
 *
 * KaTeX (~270 KB minified) is `import()`ed inside the upgrade, never here:
 * this module is imported eagerly by the fence registry. Output is MathML
 * only, so no katex.css and no font files need serving; Chrome, Safari and
 * Firefox all lay MathML out natively.
 */

import type { FenceUpgrader } from "./fence-upgraders";

type Katex = typeof import("katex").default;

let katexPromise: Promise<Katex> | null = null;
function loadKatex(): Promise<Katex> {
  katexPromise ??= import("katex").then((m) => m.default);
  return katexPromise;
}

/** The class of an inline placeholder, and the substring of a rendered
 *  body that says one is present (MarkdownBody gates its pass on it). */
export const MATH_PLACEHOLDER_CLASS = "md-math";
export const MATH_PLACEHOLDER_MARK = `class="${MATH_PLACEHOLDER_CLASS}"`;

export interface MathMatch {
  /** The whole match, `$...$` or `$$...$$`. */
  raw: string;
  /** The TeX between the delimiters. */
  source: string;
  /** True for `$$...$$`, which typesets in display mode. */
  display: boolean;
}

// The opening delimiter must touch the expression and the closing one must
// touch it too, and no digit may follow the close. That is what keeps
// `$1.84`, `$5 to $10`, `costs $3` and `$5-$10` prose: each is missing a
// close, or has a space before it, or a digit after it. One line only, and
// no `$` inside, so nothing matches across a line break or swallows a second
// price. Code spans and fences never reach these: marked hands them to
// the codespan and fence tokenizers as a unit first.
const DISPLAY_INLINE_EXACT = /^\$\$(?![\s$])([^$\n]+?)(?<!\s)\$\$(?!\d)/;
const INLINE_EXACT = /^\$(?![\s$])([^$\n]+?)(?<!\s)\$(?!\d)/;
// A `$` that could open either form, not escaped and not glued to the word
// before it (`US$5$`, `a$b$`), for marked's fast-forward hint.
const INLINE_START = /(?<![\w$\\])\$(?=[^\s$]|\$[^\s$])/;

/** Match `$x^2$` or `$$x^2$$` at the start of `src`. */
export function matchInlineMath(src: string): MathMatch | undefined {
  const display = DISPLAY_INLINE_EXACT.exec(src);
  if (display) return { raw: display[0], source: display[1], display: true };
  const inline = INLINE_EXACT.exec(src);
  if (inline) return { raw: inline[0], source: inline[1], display: false };
  return undefined;
}

/** Where the next candidate opener sits in `src`, for marked's `start`. */
export function inlineMathStart(src: string): number | undefined {
  const m = INLINE_START.exec(src);
  return m ? m.index : undefined;
}

// `$$` alone on a line opens the block, `$$` alone on a line closes it. The
// body is everything between, verbatim.
const DISPLAY_BLOCK_EXACT = /^\$\$[ \t]*\n([\s\S]*?)\n[ \t]*\$\$[ \t]*(?=\n|$)/;
const DISPLAY_BLOCK_START =
  /\n(?=\$\$[ \t]*\n[\s\S]*?\n[ \t]*\$\$[ \t]*(?:\n|$))/;

/** Match a `$$` display block at the start of `src`. */
export function matchDisplayMathBlock(
  src: string,
): { raw: string; source: string } | undefined {
  const m = DISPLAY_BLOCK_EXACT.exec(src);
  return m ? { raw: m[0], source: m[1] } : undefined;
}

/** Index of the `$$` line that starts a complete block later in `src`. */
export function displayMathBlockStart(src: string): number | undefined {
  const m = DISPLAY_BLOCK_START.exec(src);
  return m ? m.index + 1 : undefined;
}

function escapeAttr(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * The inline placeholder markdown.ts emits: the source is escaped into an
 * attribute (it is untrusted prose) and repeated as the visible text, so a
 * body that is never upgraded (a live stream, a failed load) still reads as
 * it was written.
 */
export function mathPlaceholder(match: MathMatch): string {
  const display = match.display ? ' data-display=""' : "";
  return (
    `<span ${MATH_PLACEHOLDER_MARK}${display} data-math="${escapeAttr(match.source)}">` +
    `${escapeAttr(match.raw)}</span>`
  );
}

/**
 * KaTeX markup for `source`, or null when it does not parse. `throwOnError`
 * is off so KaTeX never throws on bad TeX; it marks the failure with a
 * `katex-error` span instead, and that is the signal to keep the plain
 * source rather than show red text. `trust` stays off: the source is
 * untrusted, and the trust option would let `\href` and `\includegraphics`
 * through.
 */
export function renderMathHtml(
  katex: Pick<Katex, "renderToString">,
  source: string,
  display: boolean,
): string | null {
  const tex = source.trim();
  if (!tex) return null;
  let html: string;
  try {
    html = katex.renderToString(tex, {
      displayMode: display,
      output: "mathml",
      throwOnError: false,
      trust: false,
      strict: "ignore",
    });
  } catch {
    return null;
  }
  return html.includes("katex-error") ? null : html;
}

/**
 * Typeset every inline placeholder under `root`. Called by MarkdownBody
 * alongside the fence loop, after the innerHTML reset that hands back the
 * pristine placeholders. One that fails keeps its source text.
 */
export async function upgradeMathPlaceholders(
  root: HTMLElement,
  alive: () => boolean,
): Promise<void> {
  const spans = Array.from(
    root.querySelectorAll<HTMLElement>(`.${MATH_PLACEHOLDER_CLASS}[data-math]`),
  );
  if (spans.length === 0) return;
  const katex = await loadKatex().catch(() => null);
  if (!katex || !alive()) return;
  for (const span of spans) {
    if (!root.contains(span)) continue;
    const html = renderMathHtml(
      katex,
      span.dataset.math ?? "",
      span.dataset.display !== undefined,
    );
    if (html === null) continue;
    span.innerHTML = html;
    span.dataset.rendered = "";
  }
}

/** A ```math fence, or the `$$` block markdown.ts writes as one. Source
 *  that does not parse keeps the plain fence. */
export const mathUpgrader: FenceUpgrader = {
  langs: ["math"],
  async upgrade({ pre, source, root, alive }) {
    const katex = await loadKatex().catch(() => null);
    if (!katex || !alive() || !root.contains(pre)) return false;
    const html = renderMathHtml(katex, source, true);
    if (html === null) return false;
    const block = document.createElement("div");
    block.className = "md-math-block";
    block.innerHTML = html;
    pre.replaceWith(block);
    return true;
  },
};
