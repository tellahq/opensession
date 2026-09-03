/**
 * A small allowlist sanitizer for the raw HTML that lives inside GitHub PR
 * prose. Bots write it constantly — Vercel's deployment table puts an
 * `<a><sup><img/></sup></a>` avatar in every row, review bots use `<details>`,
 * `<sub>` and `<kbd>` — and markdown has no syntax for any of it, so escaping
 * the tags (what session transcripts do, see markdown.ts) shows a comment as a
 * wall of angle brackets.
 *
 * The rules, since the output goes through `dangerouslySetInnerHTML`:
 *
 *  - Only tags in `ALLOWED` survive. Anything else — `<script>`, `<iframe>`,
 *    `<style>`, a stray `</div>` — is escaped back to literal text, so an
 *    unknown tag degrades to exactly the behaviour we had before.
 *  - Only the attributes listed for that tag survive, so no `on*` handler and
 *    no `style` can ever be emitted; there is no denylist to keep current.
 *  - Every emitted value is escaped, which neutralizes entities: a smuggled
 *    `&#106;avascript:` stays literal text and resolves as a relative URL.
 *  - `href`/`src` must additionally start with http, https or mailto once
 *    stripped of the whitespace and control characters browsers ignore when
 *    they parse a URL.
 *
 * This is a fragment sanitizer, not a document one: it never balances tags. An
 * unclosed `<a>` swallows the rest of the comment into the link, which is what
 * GitHub does too, and the damage stops at the container the HTML is set on.
 */

/** Tag → the attributes it may keep. */
const allowedEntries = {
  a: ["href", "title"],
  abbr: ["title"],
  b: [],
  blockquote: [],
  br: [],
  caption: [],
  cite: [],
  code: [],
  dd: [],
  del: [],
  details: ["open"],
  dfn: [],
  div: ["align"],
  dl: [],
  dt: [],
  em: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  hr: [],
  i: [],
  img: ["src", "alt", "title", "width", "height", "align"],
  ins: [],
  kbd: [],
  li: [],
  mark: [],
  ol: ["start"],
  p: ["align"],
  picture: [],
  pre: [],
  q: [],
  "relative-time": ["datetime"],
  s: [],
  samp: [],
  small: [],
  source: ["srcset", "src", "media", "type", "sizes"],
  span: [],
  strong: [],
  sub: [],
  summary: [],
  sup: [],
  table: ["align"],
  tbody: [],
  td: ["align", "colspan", "rowspan"],
  tfoot: [],
  th: ["align", "colspan", "rowspan"],
  thead: [],
  tr: [],
  ul: [],
  var: [],
} satisfies Record<string, readonly string[]>;
const ALLOWED = new Map<string, readonly string[]>(
  Object.entries(allowedEntries),
);

/** Tags with no closing tag — emitted self-closed, their end tag dropped. */
const VOID_TAGS = new Set(["br", "hr", "img", "source"]);

/** Attributes whose value is a URL, so it needs a scheme check. */
const URL_ATTRS = new Set(["href", "src"]);

const TAG =
  /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s/>"'=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`=<>]*))?)*)\s*(\/?)>/g;

const ATTR = /([^\s/>"'=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]*)))?/g;

const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

function escapeText(value: string): string {
  return value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Whether a URL is safe to emit. Browsers ignore whitespace and control
 * characters while parsing a scheme, so `java\tscript:` runs — strip them
 * before deciding, and require a known scheme rather than banning known-bad
 * ones. A value that fails resolves as a relative URL once escaped.
 */
function isSafeUrl(value: string): boolean {
  const bare = value.replace(/[\u0000-\u0020\u007f]+/g, "");
  if (/^(?:https?:|mailto:)/i.test(bare)) return true;
  // Scheme-relative and root-relative links carry no scheme to abuse.
  return /^(?:\/\/[^/]|\/[^/]|[#?])/.test(bare);
}

/** Whether every candidate in a `srcset` list is a URL we would emit alone. */
function isSafeSrcset(value: string): boolean {
  const candidates = value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter(Boolean);
  return candidates.length > 0 && candidates.every(isSafeUrl);
}

function sanitizeTag(
  raw: string,
  closing: boolean,
  tag: string,
  attrs: string,
  selfClosing: boolean,
): string {
  const allowed = ALLOWED.get(tag);
  if (!allowed) return escapeText(raw);
  const isVoid = VOID_TAGS.has(tag);
  if (closing) return isVoid ? "" : `</${tag}>`;

  let out = `<${tag}`;
  let href: string | undefined;
  if (allowed.length > 0 && attrs) {
    ATTR.lastIndex = 0;
    const seen = new Set<string>();
    for (const m of attrs.matchAll(ATTR)) {
      const name = m[1].toLowerCase();
      if (!allowed.includes(name) || seen.has(name)) continue;
      const value = m[2] ?? m[3] ?? m[4];
      if (value === undefined) {
        seen.add(name);
        out += ` ${name}`;
        continue;
      }
      if (URL_ATTRS.has(name) && !isSafeUrl(value)) continue;
      // `srcset` is a candidate list ("a.png 1x, b.png 2x"), so each URL
      // in it has to clear the same bar as a lone src.
      if (name === "srcset" && !isSafeSrcset(value)) continue;
      seen.add(name);
      if (name === "href") href = value;
      out += ` ${name}="${escapeAttr(value)}"`;
    }
  }
  // A hand-written link is still a link off this app: send it to a new tab
  // the way the markdown renderer sends its own, so a deploy table can't
  // navigate the session out from under you. An in-page `#anchor` stays put.
  if (tag === "a" && href && !href.trimStart().startsWith("#"))
    out += ' target="_blank" rel="noopener noreferrer"';
  // `.markdown img` styles markdown images as blocks with a border and a
  // margin, which is right for a pasted screenshot and wrong for the 16px
  // avatars and status badges bots put inside a table cell. Raw images keep
  // the author's own layout (base.css, `.md-inline-image`).
  if (tag === "img") out += ' class="md-inline-image" loading="lazy"';
  return isVoid || selfClosing ? `${out} />` : `${out}>`;
}

/**
 * Sanitize a raw-HTML fragment for injection. Text between tags is passed
 * through with its angle brackets escaped, so nothing that failed to parse as
 * an allowed tag can reach the DOM as markup.
 */
export function sanitizeHtmlFragment(html: string): string {
  if (!html) return "";
  // Comments can hide an unclosed `<` that would otherwise re-open the
  // scanner mid-fragment, and they render as nothing anyway.
  const src = html.replace(HTML_COMMENT, "");
  let out = "";
  let last = 0;
  TAG.lastIndex = 0;
  for (const match of src.matchAll(TAG)) {
    const start = match.index;
    out += escapeText(src.slice(last, start));
    out += sanitizeTag(
      match[0],
      match[1] === "/",
      match[2].toLowerCase(),
      match[3] ?? "",
      match[4] === "/",
    );
    last = start + match[0].length;
  }
  return out + escapeText(src.slice(last));
}
