// Live styling for the composer draft: code markup, and @-mentions of
// teammates. The draft stays a plain <textarea> (native caret, selection,
// undo, IME); a metrics-identical mirror div behind it paints this HTML.
// Because the mirror must line up glyph-for-glyph with the textarea, styling
// is COLOR/BACKGROUND ONLY, plus the mention pill's outline, which paints
// outside the box. The markup here never adds padding, font, or size changes.

import type { Person } from "./people";
import { UUIDV7 } from "./session-url";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One finished @-mention of a teammate, as offsets into the draft. */
export interface MentionRange {
  start: number;
  /** Exclusive: the character after the name. */
  end: number;
  /** Roster spelling, which may differ in case from what was typed. */
  name: string;
  /** GitHub login, when they have one — the pill's face comes from it. */
  github?: string;
}

/** One model-readable selected-area reference added from an attachment preview. */
export interface ImageAttachmentRange {
  start: number;
  end: number;
  attachmentIndex: number;
}

const IMAGE_ATTACHMENT_RE = /\[Image (\d+) · \d+–\d+% × \d+–\d+%\]/g;

export function composerImageAttachmentRanges(
  text: string,
): ImageAttachmentRange[] {
  if (!text.includes("[Image ")) return [];
  const ranges: ImageAttachmentRange[] = [];
  IMAGE_ATTACHMENT_RE.lastIndex = 0;
  for (
    let match = IMAGE_ATTACHMENT_RE.exec(text);
    match;
    match = IMAGE_ATTACHMENT_RE.exec(text)
  ) {
    ranges.push({
      start: match.index,
      end: match.index + match[0].length,
      attachmentIndex: Number(match[1]) - 1,
    });
  }
  return ranges;
}

/** An `@` that starts a word, and the name after it. */
const MENTION_RE = /(^|[\s(\[])@([A-Za-z][\w.-]*)/g;
/** What may follow a name for it to count as finished. */
const TERMINATOR = /[\s.,;:!?)\]]/;

/**
 * The finished mentions in a draft. "Finished" is the whole point: a name only
 * chips once something terminates it, so `@Kent` doesn't pill while someone is
 * still typing `@Kentucky` and no name flashes mid-word. The picker inserts a
 * trailing space, so a picked mention chips the moment it lands; a typed one
 * chips on the next space.
 *
 * Only roster names count. Prose is full of `@` that means nothing to us — an
 * email address, a handle on another service — and chipping those would invent
 * a teammate (same rule as lib/mention-text.ts and the markdown renderer).
 */
export function composerMentionRanges(
  text: string,
  people: Person[],
): MentionRange[] {
  if (!people.length || !text.includes("@")) return [];
  const out: MentionRange[] = [];
  MENTION_RE.lastIndex = 0;
  for (let m = MENTION_RE.exec(text); m; m = MENTION_RE.exec(text)) {
    // Trailing punctuation belongs to the sentence, not to the name.
    const name = m[2]!.replace(/[.,;:!?]+$/, "");
    if (!name) continue;
    const start = m.index + m[1]!.length;
    const end = start + 1 + name.length;
    const after = text[end];
    if (after === undefined || !TERMINATOR.test(after)) continue;
    const person = people.find(
      (p) =>
        p.name.toLowerCase() === name.toLowerCase() ||
        p.fullName.toLowerCase() === name.toLowerCase(),
    );
    if (person)
      out.push({ start, end, name: person.name, github: person.github });
  }
  return out;
}

/**
 * The room a named session's chat glyph is painted into, prepended to the
 * title by the projection (lib/composer-session-projection.ts).
 *
 * The mirror may not take a pixel of width, so a glyph can only go where the
 * text already is. An id lends the slot its `os-` prefix occupies; a title has
 * no characters to spare, so the projection reserves two of them. Figure
 * spaces, for two reasons: they are non-breaking, so a wrapped reference never
 * leaves its glyph stranded at the end of a line, and unlike an ordinary space
 * they are not word separators, so the composer's wider word spacing does not
 * stretch the slot out from under the glyph.
 */
export const SESSION_GLYPH_SLOT = "\u2007\u2007";

/**
 * Display-only room outside a session pill. It lives in the textarea value as
 * well as the mirror, so the painted chip gains real margin without moving its
 * text away from the native caret. The projection omits it at a field edge.
 */
export const SESSION_PILL_MARGIN = "\u2009";

/** One stable session or workspace reference in the draft. */
export interface SessionRange {
  start: number;
  /** Exclusive. */
  end: number;
  id: string;
  kind?: "session" | "workspace";
  /** Visible title when the textarea is projecting this id as a named token. */
  label?: string;
  /** The resolved session is archived, so its glyph names that state. */
  archived?: boolean;
}

/**
 * A minted session id standing on its own. The leading guard is what keeps the
 * pill off the tail of a session URL still sitting in the draft: the renderer
 * chips that URL whole, so painting a pill over its last forty characters
 * would promise a chip in a place no chip appears.
 */
const SESSION_RE = new RegExp(`(^|[^\\w/-])((?:os|bks)-${UUIDV7})`, "gi");
const WORKSPACE_RE =
  /(^|[\s(\[])@workspace:(ws-[A-Za-z0-9_-]{1,61})(?=$|[\s.,;:!?)\]])/gi;

/**
 * Stable references in a draft. Session ids use the minted shape that the
 * renderer chips as a bare word. Workspaces use the explicit
 * `@workspace:<id>` token inserted by the mention palette.
 *
 * This is also where a pasted session link ends up: `pastedSessionId` shortens
 * the URL to the id it carries, and the pill is what says so.
 */
export function composerSessionRanges(text: string): SessionRange[] {
  if (!text.includes("-")) return [];
  const out: SessionRange[] = [];
  SESSION_RE.lastIndex = 0;
  for (
    let match = SESSION_RE.exec(text);
    match;
    match = SESSION_RE.exec(text)
  ) {
    const start = match.index + match[1]!.length;
    out.push({ start, end: start + match[2]!.length, id: match[2]! });
  }
  WORKSPACE_RE.lastIndex = 0;
  for (
    let match = WORKSPACE_RE.exec(text);
    match;
    match = WORKSPACE_RE.exec(text)
  ) {
    const start = match.index + match[1]!.length;
    out.push({
      start,
      end: start + match[0].length - match[1]!.length,
      id: match[2]!,
      kind: "workspace",
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Both kinds of pill, in the order they appear in the draft. */
type DraftRange = MentionRange | SessionRange | ImageAttachmentRange;

function draftRanges(
  text: string,
  people: Person[],
  sessions: SessionRange[],
): DraftRange[] {
  const ranges: DraftRange[] = [
    ...composerMentionRanges(text, people),
    ...sessions,
    ...composerImageAttachmentRanges(text),
  ];
  // A person mention and a stable reference cannot overlap. Sorting by start
  // is enough to walk them as one list.
  return ranges.sort((a, b) => a.start - b.start);
}

/** Hide title backticks from the code scanner without changing offsets. */
function syntaxText(text: string, sessions: SessionRange[]): string {
  let out = text;
  for (const session of sessions) {
    if (!session.label) continue;
    const title = out.slice(session.start, session.end).replaceAll("`", " ");
    out = out.slice(0, session.start) + title + out.slice(session.end);
  }
  return out;
}

/**
 * One mention pill. The face is the tricky part: the mirror may not take a
 * pixel of width, so there is nowhere to PUT a picture — the pill is exactly
 * as wide as `@Michiel` is in the field behind it. So the face is painted, not
 * laid out: it replaces the `@`, which goes transparent and hands over its
 * slot, and it leans left into the space before the name (base.css). An
 * `<img>` would be wrong here for a second reason: this HTML is rewritten on
 * every keystroke, so the element would be destroyed and re-decoded sixty
 * times a minute; a background image is fetched once and stays painted.
 *
 * Nobody's face is a fallback: a teammate with no GitHub login keeps a plain
 * `@` and just gets the pill.
 */
function mentionHtml(text: string, range: MentionRange): string {
  const at = esc(text.slice(range.start, range.start + 1));
  const name = esc(text.slice(range.start + 1, range.end));
  if (!range.github) return `<span class="cmp-mention">${at}${name}</span>`;
  const face = `https://github.com/${encodeURIComponent(range.github)}.png?size=48`;
  return (
    `<span class="cmp-mention cmp-faced" style="--cmp-face:url(&quot;${face}&quot;)">` +
    `<span class="cmp-at">${at}</span>${name}</span>`
  );
}

/**
 * One stable-reference pill. A known reference already arrives as its
 * projected title, so the mirror paints around those same characters. An
 * unknown session keeps its id and lends its prefix to the chat glyph. An
 * unknown workspace keeps its explicit token intact.
 */
function imageAttachmentHtml(
  text: string,
  range: ImageAttachmentRange,
): string {
  return `<span class="cmp-image-attachment">${esc(text.slice(range.start, range.end))}</span>`;
}

function sessionHtml(text: string, range: SessionRange): string {
  const shown = text.slice(range.start, range.end);
  const leadingMargin = shown.startsWith(SESSION_PILL_MARGIN)
    ? SESSION_PILL_MARGIN
    : "";
  const trailingMargin = shown.endsWith(SESSION_PILL_MARGIN)
    ? SESSION_PILL_MARGIN
    : "";
  const token = shown.slice(
    leadingMargin.length,
    shown.length - trailingMargin.length,
  );
  const before = esc(leadingMargin);
  const after = esc(trailingMargin);
  if (range.label) {
    const slot = token.startsWith(SESSION_GLYPH_SLOT)
      ? SESSION_GLYPH_SLOT.length
      : 0;
    return (
      before +
      `<span class="cmp-session cmp-session-named${range.kind === "workspace" ? " cmp-workspace" : ""}${range.archived ? " cmp-archived" : ""}">` +
      (slot
        ? `<span class="cmp-sglyph">${esc(token.slice(0, slot))}</span>`
        : "") +
      `${esc(token.slice(slot))}</span>` +
      after
    );
  }
  if (range.kind === "workspace") {
    return (
      before +
      `<span class="cmp-session cmp-workspace">${esc(token)}</span>` +
      after
    );
  }
  const prefixEnd = token.indexOf("-") + 1;
  const prefix = esc(token.slice(0, prefixEnd));
  const rest = esc(token.slice(prefixEnd));
  return (
    before +
    `<span class="cmp-session"><span class="cmp-sid">${prefix}</span>` +
    `${rest}</span>` +
    after
  );
}

/** Pills inside a plain (non-code) run of the draft. */
function chips(
  text: string,
  from: number,
  to: number,
  ranges: DraftRange[],
): string {
  let out = "";
  let last = from;
  for (const range of ranges) {
    if (range.start < last || range.end > to) continue;
    out += esc(text.slice(last, range.start));
    out +=
      "attachmentIndex" in range
        ? imageAttachmentHtml(text, range)
        : "id" in range
          ? sessionHtml(text, range)
          : mentionHtml(text, range);
    last = range.end;
  }
  return out + esc(text.slice(last, to));
}

/** Wrap `inline code` spans within a non-fence segment. A pill inside code
 * stays plain — it is quoted text, not somebody being addressed or a place
 * being pointed at. */
function inlineCode(
  text: string,
  syntax: string,
  from: number,
  to: number,
  ranges: DraftRange[],
): string {
  const seg = syntax.slice(from, to);
  let out = "";
  let last = from;
  const re = /`[^`\n]+`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg))) {
    const at = from + m.index;
    out += chips(text, last, at, ranges);
    out += `<span class="cmp-code">${esc(text.slice(at, at + m[0].length))}</span>`;
    last = at + m[0].length;
  }
  return out + chips(text, last, to, ranges);
}

/**
 * Render a composer draft to mirror HTML: ``` fences (closed, or open-ended
 * while still being typed) become .cmp-fence, `inline code` becomes .cmp-code,
 * a finished @-mention becomes .cmp-mention, and a session id becomes
 * .cmp-session. Inline backticks inside a fence are left alone. A trailing
 * zero-width space keeps the mirror's last line from collapsing when the draft
 * ends in \n.
 */
export function composerHighlightHtml(
  text: string,
  people: Person[] = [],
  sessions: SessionRange[] = composerSessionRanges(text),
): string {
  const ranges = draftRanges(text, people, sessions);
  const syntax = syntaxText(text, sessions);
  let out = "";
  let last = 0;
  const re = /```[\s\S]*?```|```[\s\S]*$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(syntax))) {
    out += inlineCode(text, syntax, last, m.index, ranges);
    out += `<span class="cmp-fence">${esc(text.slice(m.index, m.index + m[0].length))}</span>`;
    last = m.index + m[0].length;
  }
  out += inlineCode(text, syntax, last, text.length, ranges);
  return out + "​";
}

/** The frame each caller's hit test is waiting on, plus the point to run it
 *  with. Keyed by the caller's `hovered` ref, which is per composer. */
const pendingHover = new WeakMap<
  object,
  {
    frame: number;
    mirror: HTMLElement;
    field: HTMLTextAreaElement;
    x: number;
    y: number;
  }
>();

/**
 * A pill that can be pressed has to look it, and the field on top owns the
 * cursor, so hover is hit-tested against the mirror's own spans and painted
 * by a data attribute on the one under the pointer. Both composers paint it
 * the same way, so the hit test lives here beside the markup it reads.
 *
 * `hovered` carries the span between calls; it belongs to the caller because
 * the mirror's innerHTML is rewritten on every keystroke, which leaves the
 * previous span dangling.
 *
 * The hit test reads every pill's rects and then writes an attribute and the
 * field's cursor, so running it per `mousemove` forces a layout per event.
 * Coalescing to one frame keeps it to one: the pointer only has one position
 * per frame, and nothing here is painted before the frame anyway. The pending
 * point is parked on the caller's own `hovered` ref so two composers on one
 * page schedule independently.
 */
export function paintPillHover(
  mirror: HTMLElement | null,
  field: HTMLTextAreaElement | null,
  x: number,
  y: number,
  hovered: { current: HTMLElement | null },
): void {
  if (!mirror || !field) return;
  const queued = pendingHover.get(hovered);
  if (queued) {
    queued.mirror = mirror;
    queued.field = field;
    queued.x = x;
    queued.y = y;
    return;
  }
  const next = { frame: 0, mirror, field, x, y };
  next.frame = requestAnimationFrame(() => {
    pendingHover.delete(hovered);
    hitTestPillHover(next.mirror, next.field, next.x, next.y, hovered);
  });
  pendingHover.set(hovered, next);
}

/**
 * The box of the pill under a point, for anchoring the menu a press on one
 * opens (Composer.tsx). Per FRAGMENT, like the hover hit test below: a pill
 * that wrapped has a box on each line, and the menu belongs against the half
 * that was actually pressed rather than against the union of the two.
 *
 * Null when the point is not on a pill, including when the mirror isn't
 * mounted, which is every draft short of one (`needsComposerHighlight`).
 */
export function pillRectAt(
  mirror: HTMLElement | null,
  x: number,
  y: number,
): DOMRect | null {
  if (!mirror) return null;
  for (const span of mirror.querySelectorAll<HTMLElement>(
    ".cmp-mention, .cmp-session",
  ))
    for (const rect of span.getClientRects())
      if (
        x >= rect.left &&
        x <= rect.right &&
        y >= rect.top &&
        y <= rect.bottom
      )
        return rect;
  return null;
}

function hitTestPillHover(
  mirror: HTMLElement,
  field: HTMLTextAreaElement,
  x: number,
  y: number,
  hovered: { current: HTMLElement | null },
): void {
  let hit: HTMLElement | null = null;
  for (const span of mirror.querySelectorAll<HTMLElement>(
    ".cmp-mention, .cmp-session",
  )) {
    // Per fragment, not per span: a name that wraps has two boxes.
    for (const rect of span.getClientRects())
      if (
        x >= rect.left &&
        x <= rect.right &&
        y >= rect.top &&
        y <= rect.bottom
      )
        hit = span;
    if (hit) break;
  }
  if (hovered.current === hit) return;
  hovered.current?.removeAttribute("data-hover");
  hit?.setAttribute("data-hover", "");
  hovered.current = hit;
  field.style.cursor = hit ? "pointer" : "";
}

/**
 * Where the mirror stops being worth it. Its whole innerHTML is rebuilt and
 * re-parsed on every keystroke, and that cost is linear in the draft: measured
 * in the app's own Chrome, the parse plus layout is 1.3ms at 1k characters,
 * 3.6ms at 8k, 11.5ms at 32k and 22.5ms at 64k, against an 8.3ms frame. So a
 * draft past this length keeps the plain opaque textarea instead: no tint and
 * no pills, but a field that types at frame rate.
 */
export const COMPOSER_HIGHLIGHT_MAX_CHARS = 8000;

/** Only mount the mirror when the draft has something to paint — code markup,
 * a finished mention, or a session id. Plain drafts keep the stock opaque
 * textarea (zero desync risk). */
export function needsComposerHighlight(
  text: string,
  people: Person[] = [],
  sessions: SessionRange[] = composerSessionRanges(text),
): boolean {
  if (text.length > COMPOSER_HIGHLIGHT_MAX_CHARS) return false;
  return (
    text.includes("`") ||
    composerMentionRanges(text, people).length > 0 ||
    composerImageAttachmentRanges(text).length > 0 ||
    sessions.length > 0
  );
}
