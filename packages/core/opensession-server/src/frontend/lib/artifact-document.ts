/**
 * The pure half of an ```artifact / ```svg block: what goes into the
 * sandboxed frame's `srcdoc`, and the sandbox and CSP that keep it there.
 *
 * An artifact is untrusted by definition: it is whatever the agent wrote,
 * and the frame exists so it can be anything without touching the page.
 * Three layers hold that line, and every one of them is decided here so a
 * test can read the strings:
 *
 * - The `sandbox` attribute (artifactSandbox): never `allow-same-origin`,
 *   so the document has an opaque origin and no reach into the app's DOM,
 *   storage or cookies; never `allow-top-navigation`, `allow-forms` or
 *   `allow-popups`. `allow-scripts` only when the fence asked.
 * - A `<meta http-equiv="Content-Security-Policy">` in the document head
 *   (artifactCsp): `default-src 'none'`, so nothing inside the frame can
 *   fetch, load or phone home; inline styles allowed; `data:` images, so a
 *   diagram can carry its own pictures; inline scripts only with scripts on.
 * - The document is written by `srcdoc` and the app never reads back into
 *   it. With scripts on, the only channel out is a `postMessage` carrying
 *   the document's height (ARTIFACT_HEIGHT_MESSAGE), which the block clamps.
 *
 * A fragment is wrapped in a minimal document that takes the app's own
 * background and text colour, so a snippet reads as native in both themes;
 * a complete document keeps its own head and gets the CSP and the base
 * style prepended, where the author's later rules win. An SVG becomes an
 * `<img src="data:image/svg+xml,…">` inside the same frame: an image never
 * runs script, never loads anything external, and sizes itself.
 */

import { z } from "zod";
import { readDiagramSvg } from "./diagram-media";

export interface ArtifactOptions {
  /** `artifact scripts` in the fence info string. */
  scripts: boolean;
}

export interface ArtifactTheme {
  /** The page's --bg, resolved. */
  bg: string;
  /** The page's --text, resolved. */
  text: string;
  /** The page's --link, resolved. */
  link: string;
  /** The page's --sans font stack. */
  font: string;
  scheme: "light" | "dark";
}

/** The frame's default height before anything reports one, and the range a
 *  report or a drag is clamped to. In CSS pixels. */
export const ARTIFACT_DEFAULT_HEIGHT = 320;
export const ARTIFACT_MIN_HEIGHT = 120;
export const ARTIFACT_MAX_HEIGHT = 900;

/** The `type` of the height message a scripted artifact posts to its parent.
 *  Kept obscure enough that a stray postMessage from elsewhere is not read
 *  as one; the height itself is clamped regardless. */
export const ARTIFACT_HEIGHT_MESSAGE = "opensession-artifact-height";

/** `artifact scripts` turns scripts on. Any other word is ignored. */
export function artifactOptionsFromInfo(
  info: string | undefined,
): ArtifactOptions {
  const words = (info ?? "").trim().toLowerCase().split(/\s+/).slice(1);
  return { scripts: words.includes("scripts") };
}

/** The frame's `sandbox` attribute. An empty string is the fully locked
 *  sandbox, which is what a static artifact gets. */
export function artifactSandbox(options: ArtifactOptions): string {
  return options.scripts ? "allow-scripts" : "";
}

/** The policy written into the document head. `default-src 'none'` is the
 *  whole point; the rest re-opens exactly what an inline document needs. */
export function artifactCsp(options: ArtifactOptions): string {
  const directives = [
    "default-src 'none'",
    "img-src data:",
    "style-src 'unsafe-inline'",
    "font-src data:",
    "form-action 'none'",
    "base-uri 'none'",
  ];
  if (options.scripts) directives.push("script-src 'unsafe-inline'");
  return directives.join("; ");
}

/** The one message the app reads from inside a frame. Parse `event.data`
 *  with this at the window listener, then clamp what it carries. */
export const artifactHeightMessageSchema = z.object({
  type: z.literal(ARTIFACT_HEIGHT_MESSAGE),
  height: z.number(),
});

export function clampArtifactHeight(height: number): number {
  if (!Number.isFinite(height)) return ARTIFACT_DEFAULT_HEIGHT;
  return Math.min(
    ARTIFACT_MAX_HEIGHT,
    Math.max(ARTIFACT_MIN_HEIGHT, Math.round(height)),
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A CSS value is written into a style attribute inside the frame; strip
 *  anything that could close the declaration or the tag. */
function cssValue(s: string): string {
  return s.replace(/[<>"{};]/g, "").trim();
}

function metaCsp(options: ArtifactOptions): string {
  return `<meta http-equiv="Content-Security-Policy" content="${artifactCsp(options)}">`;
}

/**
 * The app's own colours as the document's base style. First in the head, so
 * anything the author wrote after it wins; a document that never mentions
 * its background still reads as part of the page.
 */
function baseStyle(theme: ArtifactTheme): string {
  return (
    "<style>" +
    `:root{color-scheme:${theme.scheme};background:${cssValue(theme.bg)};color:${cssValue(theme.text)};` +
    `font-family:${cssValue(theme.font)};font-size:15px;line-height:1.5}` +
    "body{margin:16px}" +
    `a{color:${cssValue(theme.link)}}` +
    "img,svg,video,canvas{max-width:100%}" +
    "</style>"
  );
}

/**
 * With scripts on the frame can measure itself. The root element's box is
 * the content height (the root's margins never collapse with body's, so
 * body's margin sits inside it), which lets the frame shrink as well as
 * grow, unlike scrollHeight, which never drops below the viewport.
 */
function heightReporter(): string {
  return (
    "<script>(function(){" +
    "var last=-1;" +
    "function post(){var h=Math.ceil(document.documentElement.getBoundingClientRect().height);" +
    `if(h!==last){last=h;parent.postMessage({type:${JSON.stringify(ARTIFACT_HEIGHT_MESSAGE)},height:h},"*")}}` +
    'if(typeof ResizeObserver!=="undefined"){new ResizeObserver(post).observe(document.documentElement);' +
    'document.addEventListener("DOMContentLoaded",function(){if(document.body)new ResizeObserver(post).observe(document.body)})}' +
    'window.addEventListener("load",post);post();' +
    "})()</script>"
  );
}

/** Whether the source is already a complete document rather than a fragment. */
export function isCompleteHtmlDocument(source: string): boolean {
  return /^\s*(<!doctype\b|<html\b)/i.test(source);
}

const HEAD_OPEN = /<head\b[^>]*>/i;
const HTML_OPEN = /<html\b[^>]*>/i;

/**
 * The `srcdoc` for an HTML artifact. A fragment gets a whole document
 * around it; a complete one gets the policy and base style spliced into
 * its head. Both work while the fence is still streaming: HTML tolerates a
 * document that stops mid-tag.
 */
export function artifactHtmlDocument(
  source: string,
  options: ArtifactOptions,
  theme: ArtifactTheme,
): string {
  const head =
    metaCsp(options) +
    baseStyle(theme) +
    (options.scripts ? heightReporter() : "");
  if (isCompleteHtmlDocument(source)) {
    if (HEAD_OPEN.test(source))
      return source.replace(HEAD_OPEN, (open) => `${open}${head}`);
    if (HTML_OPEN.test(source))
      return source.replace(HTML_OPEN, (open) => `${open}<head>${head}</head>`);
    return `<!doctype html><html><head>${head}</head>${source.replace(/^\s*<!doctype\b[^>]*>/i, "")}`;
  }
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${source}</body></html>`;
}

/** Strip an XML prolog, doctype and leading comments so the root <svg> is
 *  the first tag, which is what the size reader expects. */
function svgRoot(source: string): string {
  return source.replace(
    /^\s*(?:<\?xml[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->)\s*/gi,
    "",
  );
}

/** The SVG's own size, when it declares one, so the frame can be sized to
 *  its aspect ratio before anything loads: a static frame cannot report. */
export function svgArtifactSize(
  source: string,
): { w: number; h: number } | null {
  return readDiagramSvg(svgRoot(source))?.size ?? null;
}

/**
 * The `srcdoc` for an SVG artifact: the drawing as an image on the app's
 * background, at the frame's width. Scripts are never on for an SVG; an
 * `<img>` would not run them anyway.
 */
export function artifactSvgDocument(
  source: string,
  theme: ArtifactTheme,
): string {
  const options: ArtifactOptions = { scripts: false };
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgRoot(source))}`;
  return (
    `<!doctype html><html><head><meta charset="utf-8">${metaCsp(options)}${baseStyle(theme)}` +
    "<style>body{margin:0;display:grid;place-items:center;min-height:100vh}img{display:block;width:100%;height:auto}</style>" +
    `</head><body><img src="${escapeHtml(dataUrl)}" alt=""></body></html>`
  );
}
