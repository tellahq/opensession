/**
 * HTML renders: self-contained pages an agent publishes into a session with
 * the `opensession-html` server's `html_render` tool. The server stores each
 * page as a session asset with a small bootstrap in its head, and every
 * client shows it inline, under the turn that made it, in a frame that may
 * run script but has an opaque origin: no cookies, storage or API of the app.
 *
 * This module is the contract the server and the clients share: the
 * reference a tool result carries, how tall a frame should be, the theme
 * variables a page styles against, and the postMessage protocol (the MCP
 * Apps JSON-RPC subset) a page and its client speak.
 */

import {
  canonicalToolName,
  parseMcpTool,
  unwrapMcpDispatcher,
} from "./tool-presentation";

export const HTML_RENDER_SERVER = "opensession-html";
export const HTML_RENDER_TOOL = "html_render";
export const HTML_PREVIEW_TOOL = "html_preview";

export const HTML_RENDER_MIN_HEIGHT = 80;
export const HTML_RENDER_MAX_HEIGHT = 2000;
export const HTML_RENDER_MAX_TITLE_LENGTH = 200;
/** Where pages land in the session's assets. */
export const HTML_RENDER_ASSET_DIR = "html-renders";

/** Frame widths the server measures a page at, phone to the widest column. */
export const HTML_RENDER_MEASURE_WIDTHS = [
  320, 360, 390, 430, 520, 640, 744, 860, 1000, 1160,
] as const;

/** The reply column's width at the default session width (the 780px column
 *  less its padding). Previews default to it, and it picks a measured height
 *  when a client cannot know its width. */
export const HTML_RENDER_COLUMN_WIDTH = 744;

/** What an `html_render` result carries so a client can show the page. */
export interface HtmlRenderReference {
  /** Root-relative URL of the stored page (the session's raw asset route). */
  url: string;
  /** The asset path inside the session's assets. */
  path: string;
  title: string;
  /** The agent's frame height in CSS pixels: the cap on any measured height
   *  when it is below the page's own height. */
  height: number;
  /** `[width, contentHeight]` pairs measured at publish, ascending by width.
   *  Absent when the server had no browser to measure with. */
  heights?: Array<[number, number]>;
}

export function clampHtmlRenderHeight(height: number): number {
  if (!Number.isFinite(height)) return HTML_RENDER_MIN_HEIGHT;
  return Math.min(
    HTML_RENDER_MAX_HEIGHT,
    Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)),
  );
}

const MAX_MEASURED = 24;
const RENDER_URL_RE = new RegExp(
  `^/api/sessions/[^/?#]+/assets/raw/${HTML_RENDER_ASSET_DIR}/[^?#]+\\.html$`,
);

function readHeights(value: unknown): Array<[number, number]> | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_MEASURED
  )
    return undefined;
  const out: Array<[number, number]> = [];
  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      !Number.isInteger(entry[0]) ||
      entry[0] < 1 ||
      entry[0] > 10_000 ||
      typeof entry[1] !== "number" ||
      !Number.isFinite(entry[1])
    )
      return undefined;
    out.push([entry[0], clampHtmlRenderHeight(entry[1])]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** A reference, validated. The URL must be a stored render of some session,
 *  so a client never frames anything else from a tool result. */
export function readHtmlRenderReference(
  value: unknown,
): HtmlRenderReference | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.url !== "string" ||
    !RENDER_URL_RE.test(v.url) ||
    typeof v.path !== "string" ||
    typeof v.title !== "string" ||
    typeof v.height !== "number" ||
    !Number.isFinite(v.height)
  )
    return undefined;
  const heights = readHeights(v.heights);
  return {
    url: v.url,
    path: v.path,
    title:
      v.title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || "HTML render",
    height: clampHtmlRenderHeight(v.height),
    ...(heights ? { heights } : {}),
  };
}

/**
 * Whether a tool call may be `html_render`: named so directly, a call
 * through an `mcp_call` dispatcher, or a codemode script, which reaches the
 * tool through `tools.mcp_call` and prints its answer in the script's report.
 * A dispatcher's inner name can be gone from a large call's stored input, so
 * a dispatcher or script call counts and its result decides
 * (htmlRendersFromResult only accepts a stored render's URL).
 */
export function mayBeHtmlRenderTool(
  rawName: string,
  rawInput?: unknown,
): boolean {
  const { toolName } = unwrapMcpDispatcher(rawName, rawInput);
  const mcp = parseMcpTool(toolName);
  if (mcp?.server === HTML_RENDER_SERVER && mcp.tool === HTML_RENDER_TOOL)
    return true;
  if (canonicalToolName(toolName) === "Codemode" || mcp?.tool === "codemode")
    return true;
  return toolName.toLowerCase() === "mcp_call" || mcp?.tool === "mcp_call";
}

/** How every `html_render` answer starts: `JSON.stringify({ htmlRender, … })`.
 *  Servers keep such a result whole when they shorten tool results. */
export const HTML_RENDER_RESULT_PREFIX = '{"htmlRender":';
/** A render result longer than this is not one the server wrote. */
export const HTML_RENDER_RESULT_MAX_BYTES = 4096;

export function isHtmlRenderResultText(content: string): boolean {
  return (
    content.startsWith(HTML_RENDER_RESULT_PREFIX) &&
    content.length <= HTML_RENDER_RESULT_MAX_BYTES
  );
}

/** Most renders one result can carry: a script may show several pages. */
const MAX_RENDERS_PER_RESULT = 12;
const RENDER_OBJECT_START_RE = /\{\s*"htmlRender"\s*:/g;

/** The end of the JSON object opening at `start`, string-aware. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  const limit = Math.min(text.length, start + HTML_RENDER_RESULT_MAX_BYTES);
  for (let i = start; i < limit; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

function renderObjectsIn(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(RENDER_OBJECT_START_RE)) {
    const start = match.index ?? 0;
    const end = objectEnd(text, start);
    if (end > 0) out.push(text.slice(start, end));
    if (out.length >= MAX_RENDERS_PER_RESULT) break;
  }
  return out;
}

/**
 * The `{"htmlRender": …}` objects written into a result's text, as JSON
 * text. A codemode script prints the tool's answer inside its own report
 * ("Script completed … Output: {…} Console: …"), as an object or, when it
 * returned the answer string itself, as an escaped JSON string; a script may
 * also show several pages. Both spellings are read. Servers use this to keep
 * the references when they shorten a long result.
 */
export function htmlRenderResultObjects(content: string | undefined): string[] {
  if (!content || !content.includes("htmlRender")) return [];
  const found = renderObjectsIn(content);
  if (content.includes('\\"htmlRender\\"')) {
    // An answer string printed as a JSON string literal: undo one level of
    // escaping. A reference's fields are plain, so this is exact for them.
    const unescaped = content.replace(/\\(["\\])/g, "$1");
    for (const object of renderObjectsIn(unescaped))
      if (!found.includes(object)) found.push(object);
  }
  return found.slice(0, MAX_RENDERS_PER_RESULT);
}

/**
 * Every reference in a result's text, in order. The tool answers with one
 * JSON object, `{ htmlRender, message }`; a dispatcher may wrap it in prose,
 * and a codemode script in its report.
 */
export function htmlRendersFromResult(
  content: string | undefined,
): HtmlRenderReference[] {
  const out: HtmlRenderReference[] = [];
  const seen = new Set<string>();
  for (const object of htmlRenderResultObjects(content?.trim())) {
    try {
      const parsed = JSON.parse(object) as { htmlRender?: unknown };
      const ref = readHtmlRenderReference(parsed?.htmlRender);
      if (ref && !seen.has(ref.url)) {
        seen.add(ref.url);
        out.push(ref);
      }
    } catch {
      // not a reference
    }
  }
  return out;
}

/** The first reference in a result's text. */
export function htmlRenderFromResult(
  content: string | undefined,
): HtmlRenderReference | undefined {
  return htmlRendersFromResult(content)[0];
}

// The taller of the heights measured at the nearest widths on each side: a
// breakpoint between two measured widths can make the page as tall as either.
// Outside the measured range the nearest end stands alone.
function measuredHeight(heights: Array<[number, number]>, width: number) {
  const above = heights.findIndex(([w]) => w >= width);
  if (above === -1) return heights[heights.length - 1]![1];
  const high = above;
  const low = heights[high]![0] === width ? high : Math.max(0, high - 1);
  return Math.max(heights[low]![1], heights[high]![1]);
}

/**
 * The frame height at a frame width: the page's own reported height when the
 * client has it, else the server's measurement for that width. A frame even a
 * few pixels short scrolls inside the transcript and steals the reader's
 * scroll, so the frame fits the page. The agent's height caps it only when it
 * is below the page's height at the column width (it asked for a scrolling
 * frame) or when the page was never measured.
 */
export function htmlRenderFrameHeight(
  ref: HtmlRenderReference,
  width: number,
  contentHeight?: number,
): number {
  const heights = ref.heights;
  if (!heights?.length)
    return clampHtmlRenderHeight(
      Math.min(ref.height, contentHeight ?? ref.height),
    );
  const cap =
    measuredHeight(heights, HTML_RENDER_COLUMN_WIDTH) > ref.height
      ? ref.height
      : HTML_RENDER_MAX_HEIGHT;
  return clampHtmlRenderHeight(
    Math.min(cap, contentHeight ?? measuredHeight(heights, width)),
  );
}

// ── Theme ────────────────────────────────────────────────────────────────

export type HtmlAppearance = "light" | "dark";

/** The resolved theme a client hands a page: CSS custom properties. */
export interface HtmlTheme {
  appearance: HtmlAppearance;
  variables: Record<string, string>;
}

/**
 * Which app token each page variable reads. Clients resolve these against
 * their live stylesheet; the defaults below are the same tokens' values in
 * the stock light and dark themes, for a page opened on its own and for the
 * server's headless browser.
 */
export const HTML_THEME_TOKENS: Record<string, string> = {
  "--background": "--bg",
  "--foreground": "--text",
  "--muted": "--bg-panel",
  "--muted-foreground": "--text-dim",
  "--faint-foreground": "--text-faint",
  "--card": "--bg-raised",
  "--card-foreground": "--text",
  "--border": "--border",
  "--border-strong": "--border-strong",
  "--input": "--control-surface",
  "--primary": "--accent",
  "--primary-foreground": "--on-accent",
  "--accent": "--blue",
  "--accent-surface": "--blue-soft",
  "--link": "--link",
  "--destructive": "--red",
  "--destructive-surface": "--red-soft",
  "--warning": "--yellow",
  "--warning-surface": "--yellow-soft",
  "--success": "--green",
  "--success-surface": "--green-soft",
  "--info": "--blue",
  "--info-surface": "--blue-soft",
  "--code-background": "--code-well",
  "--code-foreground": "--code-well-ink",
  "--chart-1": "--blue",
  "--chart-2": "--green",
  "--chart-3": "--yellow",
  "--chart-4": "--red",
  "--chart-5": "--purple",
  "--chart-6": "--tool-web",
  "--font-sans": "--sans",
  "--font-mono": "--mono",
  // The reply's own body size (15px, 17px on phones), so page text matches
  // the prose around the frame.
  "--font-size": "--type-body",
};

const FONTS = {
  "--font-sans":
    '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif',
  "--font-mono":
    '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace',
  "--radius": "8px",
  "--font-size": "15px",
  // Transcript prose weight (.markdown in base-markdown.css), one step
  // under the app's medium; the browser default 400 reads thinner.
  "--font-weight": "450",
};

/** The stock themes' values, keyed by page variable. */
export const HTML_THEME_DEFAULTS: Record<HtmlAppearance, HtmlTheme> = {
  dark: {
    appearance: "dark",
    variables: {
      "--background": "#1c1c1c",
      "--foreground": "#e9e9e9",
      "--muted": "#262626",
      "--muted-foreground": "#a2a2a2",
      "--faint-foreground": "#767676",
      "--card": "#222222",
      "--card-foreground": "#e9e9e9",
      "--border": "#333333",
      "--border-strong": "#464646",
      "--input": "#292929",
      "--primary": "#e9e9e9",
      "--primary-foreground": "#1c1c1c",
      "--accent": "#58a6ff",
      "--accent-surface": "rgba(88, 166, 255, 0.13)",
      "--link": "#58a6ff",
      "--destructive": "#fc4a47",
      "--destructive-surface": "rgba(252, 74, 71, 0.12)",
      "--warning": "#d29922",
      "--warning-surface": "rgba(210, 153, 34, 0.14)",
      "--success": "#00bc52",
      "--success-surface": "rgba(0, 188, 82, 0.14)",
      "--info": "#58a6ff",
      "--info-surface": "rgba(88, 166, 255, 0.13)",
      "--code-background": "#0d0f13",
      "--code-foreground": "#b6bcc8",
      "--chart-1": "#58a6ff",
      "--chart-2": "#00bc52",
      "--chart-3": "#d29922",
      "--chart-4": "#fc4a47",
      "--chart-5": "#a371f7",
      "--chart-6": "#39c5cf",
      ...FONTS,
    },
  },
  light: {
    appearance: "light",
    variables: {
      "--background": "#ffffff",
      "--foreground": "#1a1a1a",
      "--muted": "#f0f0f0",
      "--muted-foreground": "#646464",
      "--faint-foreground": "#949494",
      "--card": "#f6f6f6",
      "--card-foreground": "#1a1a1a",
      "--border": "#e2e2e2",
      "--border-strong": "#d0d0d0",
      "--input": "#ebebeb",
      "--primary": "#1a1a1a",
      "--primary-foreground": "#ffffff",
      "--accent": "#0969da",
      "--accent-surface": "rgba(9, 105, 218, 0.1)",
      "--link": "#0969da",
      "--destructive": "#de3334",
      "--destructive-surface": "rgba(222, 51, 52, 0.1)",
      "--warning": "#9a6700",
      "--warning-surface": "rgba(154, 103, 0, 0.12)",
      "--success": "#009740",
      "--success-surface": "rgba(0, 151, 64, 0.12)",
      "--info": "#0969da",
      "--info-surface": "rgba(9, 105, 218, 0.1)",
      "--code-background": "#f6f8fa",
      "--code-foreground": "#57606a",
      "--chart-1": "#0969da",
      "--chart-2": "#009740",
      "--chart-3": "#9a6700",
      "--chart-4": "#de3334",
      "--chart-5": "#8250df",
      "--chart-6": "#1b7c83",
      ...FONTS,
    },
  },
};

/** Agent-facing list of the variables, for tool descriptions. */
export const HTML_THEME_GUIDE =
  "Open Session injects its active theme as CSS custom properties on :root, and they follow the reader's light/dark mode live: " +
  "--background (identical to the transcript around the frame), --foreground, --muted, --muted-foreground, --faint-foreground, " +
  "--card, --card-foreground, --border, --border-strong, --input, --primary, --primary-foreground (solid buttons), " +
  "--accent, --accent-surface (brand blue and its tint), --link, --destructive, --warning, --success, --info and a -surface tint of each, " +
  "--code-background, --code-foreground, --chart-1 … --chart-6 (categorical series), --radius, --font-sans, --font-mono, --font-size and --font-weight (the reply's body text; size headings relative to it). " +
  "The base stylesheet sets html background, colour and font from these, body margin 0, and hides the page's scrollbar; your own CSS overrides it.";

/** Agent-facing layout rules for a page that sits inside a reply. */
export const HTML_LAYOUT_GUIDE =
  `The frame is borderless on the transcript's background, as wide as the reply column (${HTML_RENDER_COLUMN_WIDTH}px on desktop, about 360px on phones), and its left edge lines up with your reply text. ` +
  "Leave html, body and the outermost element without a background colour, so the page reads as part of the reply. " +
  "Use a fluid width with no horizontal padding on the outermost element, and no outer card, border or banner title. " +
  "A box that needs its own background gets at least 16px of padding on every side and var(--radius) corners. " +
  "Give charts fixed pixel heights rather than heights that scale with width. " +
  "Let content set the page's height: avoid 100vh or height:100% on html or body, since the frame grows to fit the page.";

// ── Page ↔ client messages (MCP Apps JSON-RPC over postMessage) ─────────
// https://github.com/modelcontextprotocol/ext-apps

export const HTML_HOST_CONTEXT_CHANGED =
  "ui/notifications/host-context-changed";
export const HTML_OPEN_LINK = "ui/open-link";
export const HTML_SIZE_CHANGED = "ui/notifications/size-changed";

/** The content height in a page's `size-changed` notification. */
export function readHtmlContentHeight(data: unknown): number | undefined {
  if (!data || typeof data !== "object") return undefined;
  const { jsonrpc, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== HTML_SIZE_CHANGED) return undefined;
  const height =
    params && typeof params === "object"
      ? (params as { height?: unknown }).height
      : undefined;
  return typeof height === "number" && Number.isFinite(height) && height > 0
    ? height
    : undefined;
}

/** A page's `open-link` request, when it names an http(s) URL. */
export function readHtmlLinkRequest(
  data: unknown,
): { id: string | number; url: string } | undefined {
  if (!data || typeof data !== "object") return undefined;
  const { jsonrpc, id, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== HTML_OPEN_LINK) return undefined;
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  const url =
    params && typeof params === "object"
      ? (params as { url?: unknown }).url
      : undefined;
  return typeof url === "string" && /^https?:\/\//i.test(url)
    ? { id, url }
    : undefined;
}

/** The empty result a client answers a page's request with. */
export function htmlResult(id: string | number) {
  return { jsonrpc: "2.0", id, result: {} } as const;
}

export const HTML_THEME_FRAGMENT_KEY = "os-theme";

/** The URL fragment that hands a page its theme before first paint. */
export function htmlThemeFragment(theme: HtmlTheme): string {
  return `#${HTML_THEME_FRAGMENT_KEY}=${encodeURIComponent(JSON.stringify(theme))}`;
}

/** The notification a client posts into a mounted page on a theme change. */
export function htmlThemeMessage(theme: HtmlTheme) {
  return {
    jsonrpc: "2.0",
    method: HTML_HOST_CONTEXT_CHANGED,
    params: {
      theme: theme.appearance,
      styles: { variables: theme.variables },
    },
  } as const;
}
