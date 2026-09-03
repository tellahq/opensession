import { Marked, type Token, type TokenizerThis, type Tokens } from "marked";
import { BASE_PATH } from "./base";
import { sanitizeHtmlFragment } from "./html-sanitize";
import { prStatusDisplay, type PrStatusInput } from "./pr-status";
import { repoLabel } from "./repo-label";
import { cleanSessionTitle } from "./session-title";
import { INTERNAL_ORIGINS, UUIDV7, internalUrlTarget } from "./session-url";
import { sessionAssetRawUrl } from "./api/sessions";

// Dedicated marked instance for session messages so this config doesn't leak
// into other markdown (wiki, etc.). Two customisations:
//  - external links open in a new tab (target=_blank + safe rel); links into
//    OS1 itself navigate in place — session URLs become session-link
//    chips handled client-side, other internal paths load in the same tab
//  - images/videos render inline, capped in size; clicks open the media
//    lightbox (see MediaLightbox.tsx)
const md = new Marked({ async: false, breaks: true });

function attr(v: string | null | undefined): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

type AssetReferenceRegistry = {
  key: string;
  targets: Map<string, string>;
  start: RegExp;
  exact: RegExp;
};

const assetReferenceCache = new Map<string, AssetReferenceRegistry>();
const ASSET_REFERENCE_MAX_SHORT_ALIASES = 600;
let renderAssetReferences: AssetReferenceRegistry | null = null;
let renderAssetSessionId: string | undefined;

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the names a session's scratch files may be called in prose. A nested
 * `shots/before.png` may be named by its full path or `before.png`; when two
 * files share that suffix, the ambiguous short form links neither.
 */
function assetReferenceRegistry(
  paths: readonly string[] | undefined,
): AssetReferenceRegistry | null {
  const unique = [...new Set((paths ?? []).filter(Boolean))].sort();
  if (unique.length === 0) return null;
  const key = unique.join("\u0000");
  const cached = assetReferenceCache.get(key);
  if (cached) return cached;

  const targets = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const path of unique) {
    const segments = path.split("/").filter(Boolean);
    for (let start = 0; start < segments.length; start++) {
      const name = segments.slice(start).join("/");
      const existing = targets.get(name);
      if (existing && existing !== path) ambiguous.add(name);
      else targets.set(name, path);
    }
  }
  for (const name of ambiguous) targets.delete(name);

  // Every unambiguous full path remains linkable. Cap only shorthand suffixes:
  // one deeply nested 2,000-file artifact can otherwise create tens of
  // thousands of regex alternatives for every markdown parser invocation.
  const fullPaths = unique.filter((path) => targets.has(path));
  const fullPathSet = new Set(unique);
  const shortAliases = [...targets.keys()]
    .filter((name) => !fullPathSet.has(name))
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, ASSET_REFERENCE_MAX_SHORT_ALIASES);
  const aliases = [...fullPaths, ...shortAliases].sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  );
  const selected = new Set(aliases);
  for (const name of targets.keys()) {
    if (!selected.has(name)) targets.delete(name);
  }
  if (aliases.length === 0) return null;
  const group = aliases.map(regexEscape).join("|");
  // Either the whole code span (`report.html`) or a bare path. The trailing
  // guard stops a registered directory from linking the first half of a
  // longer path; sentence punctuation remains allowed.
  const candidate = "(?:`(" + group + ")`|(" + group + ")(?![\\w/-]))";
  const registry = {
    key,
    targets,
    exact: new RegExp(`^${candidate}`),
    // `start` is only marked's fast-forward hint. Return the position after
    // the guard character so tokenizer sees the complete candidate.
    start: new RegExp("(?:^|[^\\w./~`@-])(?=" + candidate + ")"),
  };
  assetReferenceCache.set(key, registry);
  if (assetReferenceCache.size > 32) {
    const oldest = assetReferenceCache.keys().next().value;
    if (oldest !== undefined) assetReferenceCache.delete(oldest);
  }
  return registry;
}

/** The chip itself: file glyph plus already-rendered label HTML. */
function assetChip(sessionId: string, path: string, label: string): string {
  const href = sessionAssetRawUrl(sessionId, path);
  return (
    `<a href="${attr(href)}" class="asset-ref" data-asset-path="${attr(path)}"` +
    ` title="${attr(`Open ${path}`)}" target="_blank" rel="noopener noreferrer">` +
    `<span class="asset-ref-icon" aria-hidden="true">` +
    `<svg viewBox="0 0 24 24" fill="none"><path d="M7.75 19.25H16.25C17.3546 19.25 18.25 18.3546 18.25 17.25V9L14 4.75H7.75C6.64543 4.75 5.75 5.64543 5.75 6.75V17.25C5.75 18.3546 6.64543 19.25 7.75 19.25Z"/><path d="M18 9.25H13.75V5"/><path d="M9 12.5H15M9 15.5H13"/></svg>` +
    `</span><span class="asset-ref-label">${label}</span></a>`
  );
}

function assetReferenceLink(
  path: string,
  label: string,
  coded: boolean,
): string {
  if (!renderAssetSessionId)
    return coded ? `<code>${attr(label)}</code>` : attr(label);
  const text = coded ? `<code>${attr(label)}</code>` : attr(label);
  return assetChip(renderAssetSessionId, path, text);
}

function decodeUriComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The scratch file an explicit markdown link points at, if any. Agents name an
 * artifact both ways — bare in prose and as `[label](report.html)` — and only
 * the first was ever a chip, so the explicit form rendered as an ordinary link:
 * it looked like a web link and, being same-origin, navigated the app off the
 * session instead of opening the file over it.
 */
function assetLinkTarget(href: string | null | undefined): string | null {
  const registry = renderAssetReferences;
  if (!registry || !renderAssetSessionId || !href) return null;
  const raw = String(href).trim();
  if (!raw || raw.startsWith("#")) return null;
  // A relative href is written the way prose names the file, so it resolves
  // through the same alias table (`before.png` → `shots/before.png`).
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw) && !raw.startsWith("/")) {
    const name = decodeUriComponentSafe(
      raw.replace(/^\.\//, "").split(/[?#]/)[0],
    );
    return registry.targets.get(name) ?? null;
  }
  // Or the raw-file URL this renderer itself hands out, pasted back verbatim.
  let url: URL;
  try {
    url = new URL(
      raw,
      typeof location !== "undefined"
        ? location.href
        : "http://127.0.0.1:3850/",
    );
  } catch {
    return null;
  }
  if (!INTERNAL_ORIGINS.has(url.origin)) return null;
  const match = /\/api\/sessions\/([^/]+)\/assets\/raw\/(.+)$/.exec(
    url.pathname,
  );
  if (!match) return null;
  // Another session's scratch folder is not this session's to open over.
  if (decodeUriComponentSafe(match[1]) !== renderAssetSessionId) return null;
  const path = match[2].split("/").map(decodeUriComponentSafe).join("/");
  return registry.targets.get(path) ?? null;
}

// Open Session session ids (`os-<uuidv7>`, and the pre-rename `bks-<uuidv7>` +
// legacy `bks-<slug>`), as they appear in agent output — usually in a codespan,
// e.g. a create_session result or an orchestrator saying "delegated to `os-…`".
// Rendered as a clickable link so you can jump from an orchestrator into the
// worker it spawned (and back). A container-level click handler (SessionViewer)
// navigates on data-session-id, since dangerouslySetInnerHTML can't carry React
// handlers.
// Every minted id is `<prefix>-<uuidv7>`; only the pre-rename `bks-` prefix also
// covers hand-made slug ids (`bks-ghpr-5099-review`), so it alone keeps the
// looser shape — `os-` is short enough that a loose form would turn ordinary
// codespans like `os-release` into session links.
const SESSION_ID_EXACT = new RegExp(
  `^(?:os-${UUIDV7}|bks-[a-z0-9][a-z0-9-]{5,})$`,
  "i",
);
// Bare (non-code) uuidv7-shaped ids in prose — strict so it can't misfire on
// ordinary text.
const SESSION_ID_BARE = new RegExp(`(?:os|bks)-${UUIDV7}`, "i");
const AUTOMATION_ID_EXACT = new RegExp(`^auto-${UUIDV7}$`, "i");
const AUTOMATION_ID_BARE = new RegExp(`(?:^|[^\\w/-])(?=auto-${UUIDV7})`, "i");

// Chip labels. A raw `bks-<uuid>` is 40 characters of noise in the middle of a
// sentence, so a chip shows the name of the work it points at when we know it.
// The app shell registers what it already polls (App.tsx); anything not in that
// list (archived, deleted, not yet polled) falls back to a shortened id.
interface SessionName {
  /** What the chip shows: a human session's workspace, or a worker's task. */
  label: string;
  /** The session's own title, when it differs from the label. Tooltip only:
   *  a workspace can hold multiple human conversations, so its label alone
   *  cannot say which conversation a chip opens. Worker labels already use
   *  the session title and do not need this distinction. */
  tab?: string;
  /** On-demand metadata carries this for references outside the live list. */
  archived?: boolean;
}
let sessionTitles = new Map<string, SessionName>();
/** Names resolved on demand for archived references. Kept separate because
 *  each live-list poll replaces `sessionTitles` wholesale. */
let resolvedSessionTitles = new Map<string, SessionName>();
let unavailableSessionIds = new Set<string>();
const queuedSessionTitleRequests = new Set<string>();
const inFlightSessionTitleRequests = new Set<string>();
const sessionTitleRequestListeners = new Set<(ids: string[]) => void>();
let sessionTitleRequestFlushQueued = false;
let workspaceTitles = new Map<string, string>();
const sessionTitleListeners = new Set<() => void>();
/** Sessions whose agent is mid-run, for the chip's live dot. */
let runningSessions = new Set<string>();
const SESSION_TITLE_MAX = 38;
const SESSION_ID_SHORT = 12; // `os-019fb3ad2` / `bks-019fb3ad`

function knownSessionName(id: string): SessionName | undefined {
  return sessionTitles.get(id) ?? resolvedSessionTitles.get(id);
}

function flushSessionTitleRequests(): void {
  sessionTitleRequestFlushQueued = false;
  if (!queuedSessionTitleRequests.size || !sessionTitleRequestListeners.size)
    return;
  const ids = [...queuedSessionTitleRequests];
  queuedSessionTitleRequests.clear();
  for (const id of ids) inFlightSessionTitleRequests.add(id);
  for (const listener of sessionTitleRequestListeners) listener(ids);
}

function queueSessionTitleRequest(id: string): void {
  if (
    knownSessionName(id) ||
    unavailableSessionIds.has(id) ||
    queuedSessionTitleRequests.has(id) ||
    inFlightSessionTitleRequests.has(id)
  )
    return;
  queuedSessionTitleRequests.add(id);
  if (sessionTitleRequestFlushQueued) return;
  sessionTitleRequestFlushQueued = true;
  queueMicrotask(flushSessionTitleRequests);
}

/** Ask the app shell to resolve ids omitted from its deliberately live-only list. */
export function onSessionTitleResolutionRequested(
  listener: (ids: string[]) => void,
): () => void {
  sessionTitleRequestListeners.add(listener);
  // A transcript can render before App's effect subscribes. Requeue any work a
  // Strict Mode effect cleanup may also have left in flight.
  for (const id of inFlightSessionTitleRequests)
    queuedSessionTitleRequests.add(id);
  inFlightSessionTitleRequests.clear();
  if (queuedSessionTitleRequests.size && !sessionTitleRequestFlushQueued) {
    sessionTitleRequestFlushQueued = true;
    queueMicrotask(flushSessionTitleRequests);
  }
  return () => sessionTitleRequestListeners.delete(listener);
}

export interface ResolvedSessionTitle {
  requestedId: string;
  /** Canonical id when the request used an alias. */
  id?: string;
  title?: string | null;
  tabTitle?: string | null;
  aliases?: readonly string[];
  archived?: boolean;
}

/** Publish lightweight metadata fetched for references outside the live list.
 *  A missing title marks a deleted/unknown id so it keeps the honest id label. */
export function setResolvedSessionTitles(
  entries: Iterable<ResolvedSessionTitle>,
): void {
  let changed = false;
  for (const entry of entries) {
    inFlightSessionTitleRequests.delete(entry.requestedId);
    queuedSessionTitleRequests.delete(entry.requestedId);
    const label = cleanSessionTitle(String(entry.title ?? "").trim());
    if (!label) {
      unavailableSessionIds.add(entry.requestedId);
      continue;
    }
    const tab = cleanSessionTitle(String(entry.tabTitle ?? "").trim());
    const name: SessionName = { label };
    if (tab && tab !== label) name.tab = tab;
    if (entry.archived) name.archived = true;
    const ids = [entry.requestedId, entry.id, ...(entry.aliases ?? [])].filter(
      (id): id is string => !!id,
    );
    for (const id of ids) {
      unavailableSessionIds.delete(id);
      const had = resolvedSessionTitles.get(id);
      if (
        !had ||
        had.label !== name.label ||
        had.tab !== name.tab ||
        had.archived !== name.archived
      ) {
        resolvedSessionTitles.set(id, name);
        changed = true;
      }
    }
  }
  if (!changed) return;
  syncRenderedSessionTitles();
  mdCache.clear();
  for (const listener of sessionTitleListeners) listener();
}

/** A failed request may be attempted again on a later render. */
export function retrySessionTitleResolution(id: string): void {
  inFlightSessionTitleRequests.delete(id);
}

/** Test isolation for the module-level on-demand cache. */
export function resetResolvedSessionTitles(): void {
  resolvedSessionTitles = new Map();
  unavailableSessionIds = new Set();
  queuedSessionTitleRequests.clear();
  inFlightSessionTitleRequests.clear();
  sessionTitleRequestFlushQueued = false;
  mdCache.clear();
}

/**
 * Register id → name (whether that session is running, and its own tab title
 * for the tooltip) for session chips. Cheap no-op when nothing a chip renders
 * changed; the running set never clears the cache, because a run starting
 * somewhere else is not a reason to re-render every transcript. Rendered chips
 * pick that up through the DOM sync below.
 */
export function setSessionTitles(
  entries: Iterable<
    readonly [
      string,
      string | null | undefined,
      boolean?,
      (string | null)?,
      (readonly string[])?,
    ]
  >,
): void {
  const next = new Map<string, SessionName>();
  const running = new Set<string>();
  for (const [id, title, isRunning, tabTitle, aliases] of entries) {
    const label = cleanSessionTitle(String(title ?? "").trim());
    const tab = cleanSessionTitle(String(tabTitle ?? "").trim());
    const ids = [id, ...(aliases ?? [])].filter(Boolean);
    const name: SessionName = { label };
    if (tab && tab !== label) name.tab = tab;
    if (label)
      for (const knownId of ids) {
        next.set(knownId, name);
        queuedSessionTitleRequests.delete(knownId);
        inFlightSessionTitleRequests.delete(knownId);
        unavailableSessionIds.delete(knownId);
      }
    if (isRunning) for (const knownId of ids) running.add(knownId);
  }
  runningSessions = running;
  // Unconditional: a chip rendered from the markdown cache carries whatever
  // was true when it was cached, and this is what corrects it. One
  // querySelectorAll over a handful of anchors, once per session poll.
  syncRenderedSessionRuns();
  if (next.size === sessionTitles.size) {
    let same = true;
    for (const [id, name] of next) {
      const had = sessionTitles.get(id);
      if (!had || had.label !== name.label || had.tab !== name.tab) {
        same = false;
        break;
      }
    }
    if (same) return; // the common case: a poll that only moved lastActivity
  }
  sessionTitles = next;
  // A transcript can mount from the same session-list render that supplies its
  // names. The registry updates in an effect after that render, while the
  // markdown HTML is memoized, so correct chips already in the DOM directly
  // rather than waiting for an unrelated transcript render.
  syncRenderedSessionTitles();
  // Labels are baked into the cached HTML, so future renders need fresh HTML.
  mdCache.clear();
  for (const listener of sessionTitleListeners) listener();
}

/** Register id to name for workspace mentions in composer drafts. */
export function setWorkspaceTitles(
  entries: Iterable<readonly [string, string | null | undefined]>,
): void {
  const next = new Map<string, string>();
  for (const [id, name] of entries) {
    const label = String(name ?? "").trim();
    if (id && label) next.set(id, label);
  }
  if (
    next.size === workspaceTitles.size &&
    [...next].every(([id, name]) => workspaceTitles.get(id) === name)
  )
    return;
  workspaceTitles = next;
  for (const listener of sessionTitleListeners) listener();
}

/** Re-render draft projections when a referenced session or workspace is renamed. */
export function onSessionTitlesChanged(listener: () => void): () => void {
  sessionTitleListeners.add(listener);
  return () => sessionTitleListeners.delete(listener);
}

// ── @-mentions of teammates ────────────────────────────────────────────────
// `@Kent` in a prompt or a note is a message to a person, so it renders as
// that person: their face, their name, and a click that puts the sidebar on
// their sessions (App.tsx delegates it, like the PR and session chips).
//
// Only names on the roster become chips. Prose is full of `@` that means
// nothing to us — an email address, a handle on another service, `@media` in
// quoted CSS — and turning those into a person would invent a teammate.

/** Lowercased first name → GitHub login (absent when they have none). */
let knownPeople = new Map<string, { name: string; github?: string }>();

/** Publish the mentionable roster (lib/people.ts owns fetching it). */
export function setKnownPeople(
  people: Iterable<{ name: string; github?: string }>,
): void {
  const next = new Map<string, { name: string; github?: string }>();
  for (const person of people)
    if (person.name)
      next.set(person.name.toLowerCase(), {
        name: person.name,
        github: person.github,
      });
  if (
    next.size === knownPeople.size &&
    [...next].every(([key, p]) => knownPeople.get(key)?.github === p.github)
  )
    return;
  knownPeople = next;
  // Chips are baked into the cached HTML, so it has to go when they change.
  mdCache.clear();
}

/** A mention starts at an `@` that isn't inside a word or an email address. */
const PERSON_MENTION_START = /(^|[\s(\[])@([A-Za-z][\w.-]*)/g;
const PERSON_MENTION_EXACT = /^@([A-Za-z][\w.-]*)/;

/** Trailing punctuation belongs to the sentence, not to the name. */
function mentionName(typed: string): string {
  return typed.replace(/[.,;:!?]+$/, "");
}

/**
 * Where the next real mention begins, or undefined. This has to resolve the
 * name against the roster, not just find an `@`: `start` cuts the text token
 * at the index it reports, and a cut in front of an `@` that turns out to be
 * nobody hands the following word to the other inline extensions as if it
 * stood alone — which is how `@report.html` briefly became an asset link.
 */
function personMentionStart(src: string): number | undefined {
  PERSON_MENTION_START.lastIndex = 0;
  for (
    let m = PERSON_MENTION_START.exec(src);
    m;
    m = PERSON_MENTION_START.exec(src)
  ) {
    if (knownPeople.has(mentionName(m[2]!).toLowerCase()))
      return m.index + m[0].indexOf("@");
  }
  return undefined;
}

function personChip(person: { name: string; github?: string }): string {
  const face = person.github
    ? `<img class="person-chip-face" src="https://github.com/${attr(person.github)}.png?size=36" alt="" loading="lazy" />`
    : `<span class="person-chip-face person-chip-initial" aria-hidden="true">${attr(person.name.slice(0, 1).toUpperCase())}</span>`;
  return (
    `<a role="button" tabindex="0" class="person-chip" data-person="${attr(person.name)}"` +
    ` title="Show ${attr(person.name)}'s sidebar">` +
    `${face}<span class="person-chip-label">${attr(person.name)}</span></a>`
  );
}

/** Keep already-rendered session chips in step with who is running now. */
function syncRenderedSessionRuns(): void {
  if (typeof document === "undefined") return;
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>(
    "a.session-link[data-session-id]",
  )) {
    const id = anchor.dataset.sessionId;
    if (!id) continue;
    if (runningSessions.has(id)) anchor.dataset.sessionRunning = "";
    else delete anchor.dataset.sessionRunning;
  }
}

/** Name chips that mounted before the polled session registry was published. */
function syncRenderedSessionTitles(): void {
  if (typeof document === "undefined") return;
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>(
    "a.session-link[data-session-id]",
  )) {
    const id = anchor.dataset.sessionId;
    if (!id) continue;
    const name = knownSessionName(id);
    if (!name) {
      queueSessionTitleRequest(id);
      continue;
    }
    const label = anchor.querySelector<HTMLElement>(".session-link-label");
    if (!label) continue;
    label.textContent = sessionLabel(name.label);
    delete anchor.dataset.sessionLabel;
    if (name.archived) anchor.dataset.sessionArchived = "";
    else delete anchor.dataset.sessionArchived;
    const icon = anchor.querySelector<HTMLElement>(".session-link-icon");
    if (icon) icon.innerHTML = sessionIconSvg(name.archived);
    anchor.title = sessionTip(id);
  }
}

/**
 * The title we know for a session id. The composer and sent-message chips use
 * the same registry, so a reference keeps one name before and after sending.
 */
export function sessionTitleFor(id: string): string | undefined {
  const name = knownSessionName(id);
  if (!name) queueSessionTitleRequest(id);
  return name?.label;
}

/** Whether a resolved session reference points into archived history. */
export function sessionArchivedFor(id: string): boolean {
  return knownSessionName(id)?.archived === true;
}

/** The name shown for a stable workspace mention in a composer draft. */
export function workspaceTitleFor(id: string): string | undefined {
  return workspaceTitles.get(id);
}

export function shortSessionId(id: string): string {
  // Legacy `bks-<slug>` ids are already short and cutting them mid-word reads
  // worse than showing the whole thing; only uuid-shaped ids get abbreviated.
  // The trailing-dash trim keeps the cut off a segment boundary — the two
  // prefixes differ in length, so a fixed cut lands mid-separator for one.
  return id.length <= 20
    ? id
    : `${id.slice(0, SESSION_ID_SHORT).replace(/-+$/, "")}…`;
}

// The chip's leading glyph names the destination state: a conversation for
// live work, the shared archive crate for archived history. Same 24-grid, 1.5
// stroke and 18px box as the PR chip's branch glyph.
const SESSION_CONVERSATION_SVG =
  `<svg viewBox="0 0 24 24" fill="none"><path d="M6.75 5.25H17.25C18.3546 5.25` +
  ` 19.25 6.14543 19.25 7.25V14.25C19.25 15.3546 18.3546 16.25 17.25 16.25H11.25` +
  `L7.25 19.25V16.25H6.75C5.64543 16.25 4.75 15.3546 4.75 14.25V7.25C4.75 6.14543` +
  ` 5.64543 5.25 6.75 5.25Z"/></svg>`;
const SESSION_ARCHIVE_SVG =
  `<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="4.75" width="16" height="4" rx="1"/>` +
  `<path d="M5.5 8.75V17.25C5.5 18.3546 6.39543 19.25 7.5 19.25H16.5C17.6046` +
  ` 19.25 18.5 18.3546 18.5 17.25V8.75"/><path d="M10 12.25H14"/></svg>`;

function sessionIconSvg(archived?: boolean): string {
  return archived ? SESSION_ARCHIVE_SVG : SESSION_CONVERSATION_SVG;
}

function sessionChipIcon(archived?: boolean): string {
  return `<span class="session-link-icon" aria-hidden="true">${sessionIconSvg(archived)}</span>`;
}

/**
 * The chip markup shared by both ways a session reference is written: a bare
 * id or pasted URL (labelled from the title here) and an explicit
 * `[label](url)`, which keeps the author's own words. `label` is HTML.
 */
function sessionChip(
  id: string,
  label: string,
  opts: { href?: string; tip?: string; idLabel?: boolean; archived?: boolean },
): string {
  // With an href it's a real link (cmd/middle-click open a tab); without one
  // the delegated click handler is the only way in, so it needs the button role
  // and a tab stop.
  const anchor = opts.href
    ? `href="${attr(opts.href)}" `
    : `role="button" tabindex="0" `;
  return (
    `<a ${anchor}class="session-link" data-session-id="${attr(id)}"` +
    `${opts.idLabel ? ' data-session-label="id"' : ""}` +
    `${opts.archived ? " data-session-archived" : ""}` +
    // Baked from the current set so a fresh chip is right on first paint;
    // syncRenderedSessionRuns corrects it from then on.
    `${runningSessions.has(id) ? " data-session-running" : ""}` +
    `${opts.tip ? ` title="${attr(opts.tip)}"` : ""}>` +
    `${sessionChipIcon(opts.archived)}<span class="session-link-label">${label}</span></a>`
  );
}

function sessionLabel(title: string): string {
  return title.length > SESSION_TITLE_MAX
    ? `${title.slice(0, SESSION_TITLE_MAX - 1).trimEnd()}…`
    : title;
}

function sessionLink(id: string, href?: string): string {
  const name = knownSessionName(id);
  if (!name) queueSessionTitleRequest(id);
  const label = name ? sessionLabel(name.label) : shortSessionId(id);
  // The label is lossy either way (truncated title, abbreviated id), so the
  // full id always stays in the tooltip. data-session-label marks the id
  // fallback for the monospace treatment.
  return sessionChip(id, attr(label), {
    href,
    tip: sessionTip(id),
    idLabel: !name,
    archived: name?.archived,
  });
}

const AUTOMATION_CHIP_ICON =
  `<span class="automation-link-icon" aria-hidden="true">` +
  `<svg viewBox="0 0 24 24" fill="none"><path d="M12 6.25V12L15.5 14"/>` +
  `<path d="M18.75 8.25V4.75H15.25"/><path d="M18.1 5.4A8 8 0 1 0 19.65 15"/></svg></span>`;

function automationChip(id: string, label?: string, href?: string): string {
  const text = label ?? `${id.slice(0, 13).replace(/-+$/, "")}…`;
  const target = href ?? `${BASE_PATH}/automations/${encodeURIComponent(id)}`;
  return (
    `<a href="${attr(target)}" class="automation-link" data-automation-id="${attr(id)}"` +
    `${label ? "" : ' data-automation-label="id"'}` +
    ` title="${attr(`Open automation ${id}`)}">${AUTOMATION_CHIP_ICON}` +
    `<span class="automation-link-label">${label ?? attr(text)}</span></a>`
  );
}

/** What the chip promises: which session opens, and whether it is working.
 *  The label names the workspace, so the session's own title goes here when it
 *  differs. That is the only thing separating two chips into one workspace. */
function sessionTip(id: string): string {
  const name = knownSessionName(id);
  const status = runningSessions.has(id)
    ? " · running"
    : name?.archived
      ? " · archived"
      : "";
  if (!name) return `Open session ${id}${status}`;
  const tab = name.tab ? ` · ${name.tab}` : "";
  return `Open ${name.label}${tab} (${id})${status}`;
}

// Agents write pull requests the GitHub way — a bare `#5528`, sometimes
// qualified (`webapp#5528`, `acme/webapp#5528`) — and those
// references are the most-followed link in a transcript. They render as chips
// into OS1's OWN review surface (`/pr/<repo>/<number>`, which resolves to the
// PR's workspace Review tab), not to github.com: the review is here.
//
// A bare `#5528` says nothing about its repo, so it only links when the caller
// renders with one (`renderMarkdown(src, { repo })` — the session's repo in a
// transcript). A qualified mention carries its own, but only links when that
// name is a repo this instance actually has: `getRepo` throws on an unknown id
// server-side, and a chip pointing at a repo we can't resolve is worse than
// plain text.
const PR_NUMBER_MAX_DIGITS = 5;
// A bare mention has nothing but its digits to argue it is a PR at all, and
// short `#numbers` in prose are usually something else. Measured over 120k
// transcript entries: 4+ digits are overwhelmingly PRs, while 1-3 digit runs
// are mostly stream and step indices (`stream #0`), CSS hex colours
// (`color: #333`, `#111`), and rankings (`#29`).
//
// Repos numbered under a thousand are the reason this can't just be a length
// floor: a young repo can be at #92, or #14. A short number links when
// something other than its digits says PR: the word in front of it (`PR #92`,
// the dominant form in practice), a qualifier (`backstage#92`), or a PR the
// session list already knows for that repo.
const BARE_PR_MIN_DIGITS = 4;
// The qualifier is part of the match so it can be vetted (or rejected) rather
// than left dangling in front of a chip — that also means a word glued to the
// `#` can never be mistaken for a bare mention (`abc#1` is a qualified
// mention by `abc`, not PR #1). 6+ digit runs and `&#8212;`-style entities
// fall out of the pattern instead of needing their own guard.
//
// The `PR` cue is matched here rather than read off the preceding text: a
// tokenizer only sees the source from its own match position on. It must be
// followed by a space or the `#` itself, so a repo whose id merely starts
// with those letters (`prisma#12`) is read as the qualifier it is.
const PR_MENTION_SRC =
  `([Pp][Rr]s?(?:\\s+|(?=#)))?` +
  `((?:[A-Za-z0-9][\\w.-]*/)?[A-Za-z0-9][\\w.-]*)?` +
  `#(\\d{1,${PR_NUMBER_MAX_DIGITS}})(?!\\w)`;
const PR_MENTION_EXACT = new RegExp(`^${PR_MENTION_SRC}`);
// Where a mention may START in a run of text. The leading guard is only
// expressible here (a tokenizer is handed the source from the match position
// on, with no view of what precedes it), and marked cuts the text token at
// exactly the index this returns — so an unguarded `#` stays plain text.
const PR_MENTION_START = new RegExp(`(?:^|[^\\w#&/])(?=${PR_MENTION_SRC})`);

/**
 * The repos this instance serves, id → `owner/name` on GitHub. The ids decide
 * which qualified mentions can link at all; the GitHub names ride along on the
 * chip so a cmd/ctrl-click can leave for github.com (App.tsx) without a
 * second lookup at click time.
 */
let knownRepos = new Map<string, string | undefined>();

type PrStateInput = PrStatusInput & {
  repo?: string;
  number?: number;
};

type PrDisplayState = {
  label: string;
  state: string;
  tone: PrTone;
  terminal: boolean;
};

type PrTone = "green" | "purple" | "red" | "yellow" | "muted";

let knownPrStates = new Map<string, PrDisplayState>();
let sessionPrStates = new Map<string, PrDisplayState>();
let repoPrStates = new Map<string, PrDisplayState>();

function prStateKey(repo: string, number: string | number): string {
  return `${repo}\u0000${number}`;
}

function displayPrState(pr: PrStateInput): PrDisplayState | null {
  return pr.state
    ? {
        ...prStatusDisplay(pr),
        terminal: pr.state === "MERGED" || pr.state === "CLOSED",
      }
    : null;
}

function prRefTitle(
  repo: string,
  number: string,
  state?: PrDisplayState,
): string {
  return `Open the review for ${repoLabel(repo)} #${number}${
    state ? ` · ${state.label}` : ""
  }`;
}

/**
 * A bare number normally belongs to the rendering repo. If that repo has no
 * such known PR and exactly one other configured repo does, use the unique
 * match instead. This repairs agent shorthand without guessing when numbers
 * overlap across repos.
 */
function resolveBarePrRepo(contextRepo: string, number: string): string {
  if (knownPrStates.has(prStateKey(contextRepo, number))) return contextRepo;
  const suffix = `\u0000${number}`;
  let match: string | null = null;
  for (const key of knownPrStates.keys()) {
    if (!key.endsWith(suffix)) continue;
    const repo = key.slice(0, -suffix.length);
    if (match && match !== repo) return contextRepo;
    match = repo;
  }
  return match ?? contextRepo;
}

function syncPrAnchorTarget(
  anchor: HTMLAnchorElement,
  repo: string,
  number: string,
): void {
  anchor.dataset.prRepo = repo;
  anchor.setAttribute(
    "href",
    `${BASE_PATH}/pr/${encodeURIComponent(repo)}/${number}`,
  );
  const ghRepo = knownRepos.get(repo);
  if (ghRepo) anchor.dataset.prGh = ghRepo;
  else delete anchor.dataset.prGh;
}

/** Keep already-rendered transcript chips in sync with the bulk PR cache. */
function syncRenderedPrStates(): void {
  if (typeof document === "undefined") return;
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>(
    "a.pr-ref[data-pr-repo][data-pr-number]",
  )) {
    let repo = anchor.dataset.prRepo;
    const number = anchor.dataset.prNumber;
    if (!repo || !number) continue;
    const contextRepo = anchor.dataset.prContextRepo;
    if (contextRepo) {
      const resolvedRepo = resolveBarePrRepo(contextRepo, number);
      if (resolvedRepo !== repo) {
        syncPrAnchorTarget(anchor, resolvedRepo, number);
        repo = resolvedRepo;
      }
    }
    const state = knownPrStates.get(prStateKey(repo, number));
    if (!state) {
      delete anchor.dataset.prState;
      delete anchor.dataset.prTone;
      anchor.title = prRefTitle(repo, number);
      continue;
    }
    anchor.dataset.prState = state.state;
    anchor.dataset.prTone = state.tone;
    anchor.title = prRefTitle(repo, number, state);
  }
}

function collectPrStates(
  prs: Iterable<PrStateInput>,
): Map<string, PrDisplayState> {
  const next = new Map<string, PrDisplayState>();
  for (const pr of prs) {
    if (!pr.repo || !pr.number) continue;
    const state = displayPrState(pr);
    const key = prStateKey(pr.repo, pr.number);
    if (state && !next.has(key)) next.set(key, state);
  }
  return next;
}

function syncKnownPrStates(): void {
  // Session state carries richer checks/conflict data. A terminal repo-wide
  // state is the exception: an older live-session snapshot must not resurrect
  // a PR that recent history already knows was merged or closed.
  const next = new Map(repoPrStates);
  for (const [key, state] of sessionPrStates) {
    if (next.get(key)?.terminal && !state.terminal) continue;
    next.set(key, state);
  }
  if (
    next.size === knownPrStates.size &&
    [...next].every(
      ([key, state]) =>
        knownPrStates.get(key)?.label === state.label &&
        knownPrStates.get(key)?.state === state.state &&
        knownPrStates.get(key)?.tone === state.tone,
    )
  )
    return;
  knownPrStates = next;
  mdCache.clear();
  syncRenderedPrStates();
}

/** Register live PR state from the session list for transcript references. */
export function setKnownPrStates(prs: Iterable<PrStateInput>): void {
  sessionPrStates = collectPrStates(prs);
  syncKnownPrStates();
}

/** Register repo-wide PRs, including PRs no loaded session owns. */
export function setKnownRepoPrStates(prs: Iterable<PrStateInput>): void {
  repoPrStates = collectPrStates(prs);
  syncKnownPrStates();
}

/** Register the repos, so `<repo>#123` mentions link and chips know GitHub. */
export function setKnownRepos(
  repos: Iterable<{ id: string; ghRepo?: string }>,
): void {
  const next = new Map<string, string | undefined>();
  for (const repo of repos) if (repo.id) next.set(repo.id, repo.ghRepo);
  if (
    next.size === knownRepos.size &&
    [...next].every(
      ([id, gh]) => knownRepos.has(id) && knownRepos.get(id) === gh,
    )
  )
    return;
  knownRepos = next;
  mdCache.clear(); // repo ids are baked into the cached HTML
}

/**
 * The repo a bare `#5528` belongs to, for the duration of one `md.parse()`.
 * Parsing is synchronous (`async: false`), so a module variable is the whole
 * mechanism a renderer needs to see its caller's context.
 */
let renderRepo: string | undefined;

/** What the renderer does with raw HTML for the duration of one `md.parse()`. */
let renderRawHtml: "escape" | "sanitize" = "escape";

/** Whether the renderer is inside an explicit link's own text, where a chip
 *  would nest one anchor in another. Scoped to that link, not to the parse. */
let renderInLink = false;

// GitHub user-attachment media (the canonical assets URL, or an already
// expired signed private-user-images URL copied out of rendered HTML). The
// canonical URL answers only to GitHub cookie auth, which an <img>/<video>
// on our origin never has, so these render as broken media or dead links —
// reroute them through the server's /gh-asset redirect (routes/media.ts),
// which resolves a fresh signed URL with the bot credential. Resolution is
// authorized through the context repo, so no repo means no rewrite.
const GH_ATTACHMENT_URL =
  /^https:\/\/github\.com\/user-attachments\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const GH_SIGNED_ATTACHMENT_URL =
  /^https:\/\/private-user-images\.githubusercontent\.com\/\d+\/\d+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.\w+/i;

function ghAttachmentProxyHref(href: string | undefined | null): string | null {
  if (!href || !renderRepo) return null;
  const m = GH_ATTACHMENT_URL.exec(href) || GH_SIGNED_ATTACHMENT_URL.exec(href);
  if (!m) return null;
  return `/gh-asset/${m[1].toLowerCase()}?repo=${encodeURIComponent(renderRepo)}`;
}

/** The repo a mention points at, or null when it can't be placed. */
function prMentionRepo(qualifier: string | undefined): string | null {
  if (!qualifier) return renderRepo ?? null;
  // `owner/repo` and a bare `repo` both identify the repo by its last segment:
  // ids are instance-local, and the owner is noise we already know.
  const id = qualifier.slice(qualifier.lastIndexOf("/") + 1);
  return knownRepos.has(id) ? id : null;
}

/** Whether an uncued, unqualified `#123` reads as a PR rather than prose. */
function bareMentionLinks(repo: string, number: string): boolean {
  return (
    number.length >= BARE_PR_MIN_DIGITS ||
    knownPrStates.has(prStateKey(repo, number))
  );
}

function prMentionLink(
  repo: string,
  number: string,
  label: string,
  unqualified = false,
): string {
  const contextRepo = repo;
  if (unqualified) repo = resolveBarePrRepo(contextRepo, number);
  const href = `${BASE_PATH}/pr/${encodeURIComponent(repo)}/${number}`;
  // `data-pr-gh` is the escape hatch, not the destination: a plain click
  // stays in the review here, cmd/ctrl-click leaves for github.com.
  const ghRepo = knownRepos.get(repo);
  const state = knownPrStates.get(prStateKey(repo, number));
  return (
    `<a href="${attr(href)}" class="pr-ref" data-pr-repo="${attr(repo)}"` +
    ` data-pr-number="${attr(number)}"` +
    (unqualified ? ` data-pr-context-repo="${attr(contextRepo)}"` : "") +
    (ghRepo ? ` data-pr-gh="${attr(ghRepo)}"` : "") +
    (state
      ? ` data-pr-state="${state.state}" data-pr-tone="${state.tone}"`
      : "") +
    ` title="${attr(prRefTitle(repo, number, state))}">` +
    `<span class="pr-ref-icon" aria-hidden="true">` +
    `<svg viewBox="0 0 24 24" fill="none">` +
    `<circle cx="7" cy="6.5" r="1.75"/><circle cx="7" cy="17.5" r="1.75"/>` +
    `<circle cx="17" cy="17.5" r="1.75"/><path d="M7 8.25V15.75"/>` +
    `<path d="M12.25 6.5H15C16.1046 6.5 17 7.39543 17 8.5V15.75"/>` +
    `</svg></span><span class="pr-ref-label">${attr(label)}</span></a>`
  );
}

/** A GitHub PR page that belongs to a repo this instance serves. */
function githubPrTarget(
  href: string | null | undefined,
): { repo: string; number: string } | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(String(href));
  } catch {
    return null;
  }
  if (
    !["github.com", "www.github.com"].includes(url.hostname.toLowerCase()) ||
    url.search ||
    url.hash
  )
    return null;
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d{1,5})\/?$/.exec(url.pathname);
  if (!match) return null;
  const githubRepo = `${match[1]}/${match[2]}`.toLowerCase();
  for (const [repo, configuredGithubRepo] of knownRepos) {
    if (configuredGithubRepo?.toLowerCase() === githubRepo)
      return { repo, number: match[3] };
  }
  return null;
}

// The same pull request, written twice on one line. The house style asks for a
// qualified reference and the link gets pasted next to it anyway, so
// "**webapp#5832** — https://github.com/acme/webapp/pull/5832" is everyday
// output. Both forms are references and both chip, so the line renders as two
// identical pills joined by a separator that only ever existed to introduce
// the URL. One reference written twice is still one reference: keep the form
// that was written first and drop the duplicate with its separator.
//
// Two DIFFERENT pull requests side by side are two references and stay two
// chips — the repo and the number both have to match, resolved through the
// same helpers the chips themselves resolve through.
const DUPLICATE_PR_PAIR = new RegExp(
  // The character in front, captured rather than looked behind: a mention glued
  // to a word (or to another `#`) is not a mention, and re-emitting the guard
  // keeps the rewrite lossless.
  `(?<lead>^|[^\\w#&/-])` +
    // Bold wraps a mention without changing what it is. A code span does: a
    // mention in backticks renders as code and never chips, so collapsing
    // there would delete the only linkable form. It is left alone.
    `(?<mention>(?<cue>[Pp][Rr]s?[ \\t]+)?(?<wrap>\\*\\*)?` +
    `(?<qualifier>(?:[A-Za-z0-9][\\w.-]*/)?[A-Za-z0-9][\\w.-]*)?` +
    `#(?<number>\\d{1,${PR_NUMBER_MAX_DIGITS}})\\k<wrap>?)` +
    // What joins the two: a dash/middot/colon, an opening paren, or just space.
    `(?<sep>[ \\t]*[—–·:|-][ \\t]*|[ \\t]*\\([ \\t]*|[ \\t]+)` +
    `<?(?<url>https?://(?:www\\.)?github\\.com/[\\w.-]+/[\\w.-]+/pull/\\d{1,${PR_NUMBER_MAX_DIGITS}})/?>?` +
    `(?<close>[ \\t]*\\))?`,
  "gm",
);

/** Run a rewrite over prose only, leaving fenced code blocks verbatim. */
function outsideCodeFences(src: string, fn: (chunk: string) => string): string {
  if (!src.includes("```")) return fn(src);
  return src
    .split(/(```[\s\S]*?```)/g)
    .map((part) => (part.startsWith("```") ? part : fn(part)))
    .join("");
}

/** Collapse `repo#123 — https://github.com/owner/repo/pull/123` to one chip. */
function collapseDuplicatePrReferences(src: string): string {
  if (!src.includes("/pull/")) return src;
  return outsideCodeFences(src, (chunk) =>
    chunk.replace(
      DUPLICATE_PR_PAIR,
      (
        match: string,
        lead: string | undefined,
        mention: string | undefined,
        cue: string | undefined,
        _wrap: string | undefined,
        qualifier: string | undefined,
        number: string | undefined,
        sep: string | undefined,
        url: string | undefined,
        close: string | undefined,
      ) => {
        if (!mention || !number || !url) return match;
        const target = githubPrTarget(url);
        if (!target) return match;
        const repo = prMentionRepo(qualifier);
        if (repo !== target.repo || number !== target.number) return match;
        // A mention that wouldn't chip on its own is prose, and dropping the URL
        // next to it would leave the reference with nothing to open.
        if (!qualifier && !cue && !bareMentionLinks(repo, number)) return match;
        // An unbalanced parenthesis means the separator wasn't one.
        if (sep?.includes("(") && !close) return match;
        const trailing = sep?.includes("(") ? "" : (close ?? "");
        return `${lead ?? ""}${mention}${trailing}`;
      },
    ),
  );
}

// Commit shas are the other reference agents write constantly ("this reverts
// `4ed1ef09`"), and they were dead text: to see what one was you left for
// GitHub and searched. They become references you can hover instead, answered
// from the checkout (server/commit-lookup.ts) so an unpushed commit on some
// other session's branch resolves too.
//
// Which hex runs are shas was measured over 130,715 transcript entries,
// resolved against every checkout: a CODESPAN of 7-12 or 40 hex characters is
// a real commit 98% of the time once all-digit runs are excluded (those are
// GitHub run ids and epoch milliseconds, and a real sha is almost never all
// digits). Bare hex in prose is the opposite at 18%, so it stays plain text
// unless a cue word introduces it (`commit 4ed1ef09`), which measured 100%
// across 2,427 mentions. Length is capped at 12 for the abbreviated form
// because the 13-39 range held no commits at all, only md5s and 16-hex ids.
const COMMIT_SHA_SRC = "(?:[0-9a-f]{7,12}|[0-9a-f]{40})";
const COMMIT_CUE_SRC = "(?:commits?|sha)";
const COMMIT_REF_SRC = `(?:\`(${COMMIT_SHA_SRC})\`|(${COMMIT_CUE_SRC} +)(${COMMIT_SHA_SRC})(?![\\w-]))`;
const COMMIT_REF_EXACT = new RegExp(`^${COMMIT_REF_SRC}`, "i");
// The leading guard, which only a `start` can express (a tokenizer is handed
// the source from its own match position on): a backtick in front means this
// is the inside of a longer code span, and a word character in front of the
// cue means another word ends in it (`precommit 4ed…`).
const COMMIT_REF_START = new RegExp(
  `(?:^|[^\\w\`-])(?=${COMMIT_REF_SRC})`,
  "i",
);

/** Whether an abbreviation can identify a commit rather than a number. */
function isCommitSha(sha: string): boolean {
  return sha.length === 40 || /[a-f]/i.test(sha);
}

/**
 * A commit reference. Deliberately not a pill like the chips above: a sha IS a
 * code identifier, it stays in the monospace capsule it was written in, and a
 * sentence naming two or three commits would otherwise become a row of boxes.
 * The dotted underline base.css gives it is the whole affordance, and it is
 * the one a term with a definition has always had.
 */
function commitRefChip(repo: string, sha: string): string {
  const ghRepo = knownRepos.get(repo);
  const href = ghRepo ? `https://github.com/${ghRepo}/commit/${sha}` : "";
  const short = sha.slice(0, 8);
  const data = `class="commit-ref" data-commit-repo="${attr(repo)}" data-commit-sha="${attr(sha)}"`;
  // Without a GitHub page there is nothing to open, so it is a term you can
  // read rather than a link that goes nowhere. It stays focusable: the hover
  // card is what it has to say, and the keyboard has to reach it.
  return href
    ? `<a href="${attr(href)}" ${data}` +
        ` title="${attr(`Open ${repoLabel(repo)} commit ${short} on GitHub`)}"` +
        ` target="_blank" rel="noopener noreferrer">${attr(sha)}</a>`
    : `<span ${data} tabindex="0"` +
        ` title="${attr(`Commit ${short} · ${repoLabel(repo)}`)}">${attr(sha)}</span>`;
}

/** A GitHub commit page in a repo this instance serves. */
function githubCommitTarget(
  href: string | null | undefined,
): { repo: string; sha: string } | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(String(href));
  } catch {
    return null;
  }
  if (
    !["github.com", "www.github.com"].includes(url.hostname.toLowerCase()) ||
    url.search ||
    url.hash
  )
    return null;
  const match = /^\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{7,40})\/?$/i.exec(
    url.pathname,
  );
  if (!match) return null;
  const githubRepo = `${match[1]}/${match[2]}`.toLowerCase();
  for (const [repo, configuredGithubRepo] of knownRepos) {
    if (configuredGithubRepo?.toLowerCase() === githubRepo)
      return { repo, sha: match[3].toLowerCase() };
  }
  return null;
}

/**
 * Turn chip tokens back into the literal text they were written as, in place.
 * Only used inside an explicit link, where a chip would nest an anchor; the
 * raw text of all chip kinds is plain (ids, digits, `#`, `/`, `.`, `-`), so
 * it needs no escaping the text renderer wouldn't already skip.
 */
function flattenChips(tokens: Token[] | undefined): void {
  for (const token of tokens ?? []) {
    if (token.type === "assetPath") {
      token.type = token.coded ? "codespan" : "text";
      token.text = token.label;
      token.raw = token.coded ? `\`${token.label}\`` : token.label;
      token.tokens = undefined;
    } else if (token.type === "commitRef") {
      // The codespan form goes back to being a codespan, not to text: it was
      // written in backticks and must still read as code inside the link.
      token.type = token.coded ? "codespan" : "text";
      token.text = token.coded ? token.sha : token.raw;
      token.tokens = undefined;
    } else if (
      token.type === "prMention" ||
      token.type === "sessionId" ||
      token.type === "automationId"
    ) {
      token.type = "text";
      token.text = token.raw;
      token.tokens = undefined;
    } else if ("tokens" in token && Array.isArray(token.tokens)) {
      flattenChips(token.tokens);
    }
  }
}

// An auto-linked (or <bracketed>) bare URL: marked hands the raw URL over as
// the link text. Trailing-slash tolerant so `…/session/bks-x/` still counts.
function isBareUrlLink(token: Tokens.Link): boolean {
  const strip = (v: string) => String(v ?? "").replace(/\/+$/, "");
  const text = strip(token.text);
  return text.length > 0 && text === strip(token.href);
}

md.use({
  tokenizer: {
    // Strikethrough requires DOUBLE tildes (~~text~~). GFM also accepts a
    // single ~, but session content is full of bare tildes that are NOT
    // strikethrough — ReScript labeled args (`foo(~storyID=…, ~error)`),
    // approximate numbers (`~350 files`), home paths (`~/.config`) — and two of
    // them on a line struck everything between. Returning undefined on a
    // single tilde lets marked fall through to plain text.
    del(this: TokenizerThis, src: string) {
      const m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(src);
      if (!m) return undefined;
      return {
        type: "del",
        raw: m[0],
        text: m[1],
        tokens: this.lexer.inlineTokens(m[1]),
      };
    },
  },
  renderer: {
    // Session content is untrusted (assistant output, tool results, pasted
    // text). marked passes raw HTML through verbatim by default, and we inject
    // the result with dangerouslySetInnerHTML — so an embedded <script> or
    // <img onerror=…> would execute. Escape every raw-HTML token (this method
    // handles both block- and inline-level HTML) so it renders as literal text.
    // All the formatting we actually want (links, images, code) is generated by
    // marked from markdown syntax, not from raw tags, so nothing is lost.
    // PR prose is the exception: bots write markup markdown has no syntax for,
    // so those callers ask for the allowlist sanitizer instead (see
    // html-sanitize.ts). Escaping stays the default everywhere else.
    html(token: Tokens.HTML | Tokens.Tag) {
      const raw = String(token.text ?? token.raw ?? "");
      return renderRawHtml === "sanitize"
        ? sanitizeHtmlFragment(raw)
        : attr(raw);
    },
    link(token: Tokens.Link) {
      // `[PR #5528](https://github.com/…)` is everyday agent output, and the
      // chip extensions fire inside a link's own text just as they do in
      // prose — which would nest an <a> inside an <a>, markup the HTML parser
      // silently tears apart. The explicit link wins: inside it, chips degrade
      // back to the text they were written as.
      flattenChips(token.tokens);
      const githubPr = githubPrTarget(token.href);
      if (githubPr) {
        const label = isBareUrlLink(token)
          ? `PR #${githubPr.number}`
          : String(token.text || `PR #${githubPr.number}`);
        return prMentionLink(githubPr.repo, githubPr.number, label);
      }
      // A pasted commit URL is the same reference written the long way, so it
      // renders as the same thing. Only a bare URL: a link someone LABELLED is
      // their prose, and prose does not belong in a monospace capsule.
      const githubCommit = githubCommitTarget(token.href);
      if (githubCommit && isBareUrlLink(token))
        return commitRefChip(githubCommit.repo, githubCommit.sha.slice(0, 8));
      const ghAsset = ghAttachmentProxyHref(token.href);
      // A bare user-attachment URL is how GitHub prose embeds a video (that
      // is also what our own PR instructions and the walkthrough mirror
      // emit), so on PR surfaces render the player GitHub would. Labelled
      // links keep their label but point at the proxy, which is the only form
      // of the URL that actually opens from here.
      if (ghAsset && renderRawHtml === "sanitize" && isBareUrlLink(token)) {
        return `<video class="md-video" src="${attr(ghAsset)}" controls playsinline preload="metadata"></video>`;
      }
      // `flattenChips` already neutralised the chip TOKENS, but the codespan
      // renderer below makes chips of its own, and an <a> inside an <a> is
      // markup the HTML parser tears apart. Inside a link, a codespan is code.
      const wasInLink = renderInLink;
      renderInLink = true;
      let text: string;
      try {
        text = this.parser.parseInline(token.tokens);
      } finally {
        renderInLink = wasInLink;
      }
      if (ghAsset) {
        return `<a href="${attr(ghAsset)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      }
      // A link to one of this session's scratch files is an asset, however it
      // was written: same chip, same overlay, so the two forms are one thing.
      const asset = assetLinkTarget(token.href);
      if (asset && renderAssetSessionId)
        return assetChip(renderAssetSessionId, asset, text);
      const title = token.title ? ` title="${attr(token.title)}"` : "";
      const internal = internalUrlTarget(token.href);
      if (internal) {
        // A pasted session URL auto-links with the whole ~90-char URL as
        // its text, which ran straight past the message bubble's edge inside
        // the nowrap chip. Label it like a bare `bks-…` in prose instead.
        if (internal.sessionId && isBareUrlLink(token)) {
          return sessionLink(internal.sessionId, token.href);
        }
        if (internal.automationId && isBareUrlLink(token)) {
          return automationChip(internal.automationId, undefined, token.href);
        }
        // Same app: navigate in place. Session URLs get the session-link
        // chip + data-session-id so the delegated handler (SessionViewer)
        // navigates client-side; href stays for middle/cmd-click and for
        // surfaces without the handler (full-page load, same tab).
        if (internal.sessionId) {
          // A label that is only the id (bare or in a codespan) repeats what
          // the chip already identifies, at full 39-char length. Label it
          // from the session's own name instead, like a bare id in prose.
          const label = (token.text ?? "").trim().replace(/^`+|`+$/g, "");
          if (SESSION_ID_EXACT.test(label))
            return sessionLink(internal.sessionId, token.href);
          return sessionChip(internal.sessionId, text, {
            href: token.href,
            tip: token.title || sessionTip(internal.sessionId),
          });
        }
        if (internal.automationId)
          return automationChip(internal.automationId, text, token.href);
        return `<a href="${attr(token.href)}"${title}>${text}</a>`;
      }
      return `<a href="${attr(token.href)}"${title} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    codespan(token: Tokens.Codespan) {
      const t = token.text ?? "";
      // A codespan that is exactly a session id becomes a link into that session.
      if (!renderInLink && SESSION_ID_EXACT.test(t)) return sessionLink(t);
      if (!renderInLink && AUTOMATION_ID_EXACT.test(t))
        return automationChip(t);
      return `<code>${attr(t)}</code>`;
    },
    image(token: Tokens.Image) {
      const title = token.title ? ` title="${attr(token.title)}"` : "";
      // Video files pasted with image syntax would render as a broken <img>
      // linking to a new tab — play them inline instead. Clicks on .md-image
      // open the media lightbox (delegated handler in MediaLightbox.tsx); the
      // wrapping <a> stays for cmd/middle-click open-in-tab.
      if (/\.(mp4|webm|mov|m4v)([?#]|$)/i.test(token.href ?? "")) {
        return `<video class="md-video" src="${attr(token.href)}"${title} controls playsinline preload="metadata"></video>`;
      }
      // Image syntax around a GitHub user attachment is an image (a video
      // attachment is always embedded as a bare URL) — swap in the proxy
      // href so it loads.
      const href = ghAttachmentProxyHref(token.href) ?? token.href;
      return (
        `<a href="${attr(href)}" target="_blank" rel="noopener noreferrer" class="md-image-link">` +
        `<img class="md-image" src="${attr(href)}" alt="${attr(token.text)}"${title} loading="lazy" />` +
        `</a>`
      );
    },
  },
  // Bare session ids in prose (not wrapped in backticks) also link. Strict
  // uuidv7 shape so it only fires on real ids.
  extensions: [
    {
      name: "assetPath",
      level: "inline",
      start(src: string) {
        const match = renderAssetReferences?.start.exec(src);
        return match ? match.index + match[0].length : undefined;
      },
      tokenizer(src: string) {
        const registry = renderAssetReferences;
        const match = registry?.exact.exec(src);
        if (!registry || !match) return undefined;
        const label = match[1] ?? match[2];
        const path = registry.targets.get(label);
        if (!path) return undefined;
        return {
          type: "assetPath",
          raw: match[0],
          label,
          path,
          coded: match[1] !== undefined,
        };
      },
      renderer(token: Tokens.Generic) {
        return assetReferenceLink(token.path, token.label, token.coded);
      },
    },
    {
      name: "personMention",
      level: "inline",
      start: personMentionStart,
      tokenizer(src: string) {
        const m = PERSON_MENTION_EXACT.exec(src);
        if (!m) return undefined;
        const typed = mentionName(m[1]!);
        const person = knownPeople.get(typed.toLowerCase());
        if (!person) return undefined;
        return { type: "personMention", raw: `@${typed}`, name: person.name };
      },
      renderer(token: Tokens.Generic) {
        const person = knownPeople.get(String(token.name).toLowerCase());
        return person ? personChip(person) : attr(`@${token.name}`);
      },
    },
    {
      name: "automationId",
      level: "inline",
      start(src: string) {
        const m = AUTOMATION_ID_BARE.exec(src);
        return m ? m.index + m[0].length : undefined;
      },
      tokenizer(src: string) {
        const m = new RegExp(`^auto-${UUIDV7}`, "i").exec(src);
        if (m) return { type: "automationId", raw: m[0], id: m[0] };
      },
      renderer(token: Tokens.Generic) {
        return automationChip(token.id);
      },
    },
    {
      name: "sessionId",
      level: "inline",
      start(src: string) {
        const m = SESSION_ID_BARE.exec(src);
        return m ? m.index : undefined;
      },
      tokenizer(src: string) {
        const m = new RegExp(`^(?:os|bks)-${UUIDV7}`, "i").exec(src);
        if (m) return { type: "sessionId", raw: m[0], id: m[0] };
      },
      renderer(token: Tokens.Generic) {
        return sessionLink(token.id);
      },
    },
    {
      name: "commitRef",
      level: "inline",
      start(src: string) {
        const m = COMMIT_REF_START.exec(src);
        // Past the guard character, which belongs to the text before it.
        return m ? m.index + m[0].length : undefined;
      },
      tokenizer(src: string) {
        const m = COMMIT_REF_EXACT.exec(src);
        if (!m) return undefined;
        const [raw, coded, cue, cued] = m;
        const sha = (coded ?? cued)!;
        // Declining has to hand back a token, not undefined: the text
        // tokenizer would otherwise walk into the middle of this match and
        // re-read its tail as something else. The codespan form goes back to
        // being a codespan so it still renders as the code it was written as.
        const asWritten = coded
          ? { type: "codespan", raw, text: sha }
          : { type: "text", raw, text: raw };
        // Nowhere to resolve it against: a sha alone doesn't say which repo,
        // the same rule a bare `#123` follows.
        if (!renderRepo || !isCommitSha(sha)) return asWritten;
        return {
          type: "commitRef",
          raw,
          sha: sha.toLowerCase(),
          cue: cue ?? "",
          coded: coded !== undefined,
          repo: renderRepo,
        };
      },
      renderer(token: Tokens.Generic) {
        // The cue stays prose, like the PR chip's: it reads as `commit` plus
        // the sha, not as a capsule that has swallowed the word.
        return attr(token.cue) + commitRefChip(token.repo, token.sha);
      },
    },
    {
      name: "prMention",
      level: "inline",
      start(src: string) {
        const m = PR_MENTION_START.exec(src);
        // `start` reports where the mention itself begins, not the guard char
        // in front of it — a text token cut one character early would swallow
        // that character into this token's slot.
        return m ? m.index + m[0].length : undefined;
      },
      tokenizer(src: string) {
        const m = PR_MENTION_EXACT.exec(src);
        if (!m) return undefined;
        const [raw, cue = "", qualifier, number] = m;
        const repo = prMentionRepo(qualifier);
        // Nowhere to point: emit the mention as the text it is. Declining the
        // match instead would hand `vercel/next.js#1234` back to the text
        // tokenizer, which walks forward a character at a time until the
        // rejected qualifier is behind it and `#1234` reads as a BARE mention —
        // linking a third party's PR number into one of our own repos.
        if (!repo) return { type: "text", raw, text: raw };
        // Same for a short number with nothing but its digits to go on.
        if (!cue && !qualifier && !bareMentionLinks(repo, number))
          return { type: "text", raw, text: raw };
        return {
          type: "prMention",
          raw,
          cue,
          repo,
          number,
          unqualified: !qualifier,
        };
      },
      renderer(token: Tokens.Generic) {
        // The cue stays prose: it reads as `PR` + a chip labelled `#92`, so a
        // chip already carrying a PR icon doesn't also spell the word out.
        return (
          attr(token.cue) +
          prMentionLink(
            token.repo,
            token.number,
            token.raw.slice(token.cue.length),
            token.unqualified,
          )
        );
      },
    },
  ],
});

// Rendered-HTML cache: every session open/switch re-renders all visible
// bubbles, and marked is the dominant cost of showing a transcript
// (superlinear on input size). Keyed by the source string, LRU-bounded, and
// only for small-to-medium inputs so a day of big transcripts can't pin
// unbounded HTML in memory (callers clamp giant contents before rendering).
const mdCache = new Map<string, string>();
const MD_CACHE_MAX = 500;
const MD_CACHE_INPUT_MAX = 32 * 1024;
/** The context key an empty context produces, which caches under `src` alone. */
const EMPTY_CONTEXT_KEY = ["", "", "", ""].join("\u0000");
// The last source rendered under each context. A streaming message renders a
// longer prefix of itself every frame, and each one is a fresh key: without
// this, one message inserts hundreds of dead entries and evicts every other
// bubble's HTML, which then re-parses on scroll-back. Dropping the prefix as
// its successor lands keeps a stream to one slot.
const mdStreamTail = new Map<string, string>();
const MD_STREAM_TAIL_MAX = 32;

export interface MarkdownContext {
  /**
   * The repo a bare `#5528` refers to — the session's repo in a transcript,
   * the PR's repo on a review surface. Without it those mentions stay plain
   * text rather than guessing a destination.
   */
  repo?: string;
  /** Session whose prose this is, used to build safe raw-file fallbacks for
   * asset links when the transcript's delegated preview handler is absent. */
  sessionId?: string;
  /** Files that currently exist in this session's scratch folder. Only these
   * names become links; file-looking prose is otherwise left untouched. */
  assetPaths?: readonly string[];
  /**
   * What to do with raw HTML in the source. The default escapes it to literal
   * text; "sanitize" runs it through the tag allowlist in html-sanitize.ts,
   * which is what PR prose needs and what only PR prose should ask for.
   */
  rawHtml?: "escape" | "sanitize";
}

/** Render session markdown to HTML (links open in a new tab, images inline). */
export function renderMarkdown(src: string, ctx?: MarkdownContext): string {
  const cacheable = src.length <= MD_CACHE_INPUT_MAX;
  const assets = assetReferenceRegistry(ctx?.assetPaths);
  // Same source, different repo/session/assets, different links. Null bytes
  // cannot occur in a repo id, session id or filesystem path.
  const contextKey = [
    ctx?.repo ?? "",
    ctx?.sessionId ?? "",
    assets?.key ?? "",
    ctx?.rawHtml ?? "",
  ].join("\u0000");
  const cacheKey =
    contextKey === EMPTY_CONTEXT_KEY ? src : `${contextKey}\u0000${src}`;
  if (cacheable) {
    const hit = mdCache.get(cacheKey);
    if (hit !== undefined) {
      // Refresh LRU position
      mdCache.delete(cacheKey);
      mdCache.set(cacheKey, hit);
      return hit;
    }
  }
  let out: string;
  const previousRepo = renderRepo;
  const previousAssets = renderAssetReferences;
  const previousAssetSessionId = renderAssetSessionId;
  const previousRawHtml = renderRawHtml;
  renderRepo = ctx?.repo;
  renderAssetReferences = assets;
  renderAssetSessionId = ctx?.sessionId;
  renderRawHtml = ctx?.rawHtml ?? "escape";
  try {
    const parsed = md.parse(collapseDuplicatePrReferences(src));
    if (parsed instanceof Promise) throw new Error("Unexpected async markdown");
    out = parsed;
  } catch {
    out = src;
  } finally {
    renderRepo = previousRepo;
    renderAssetReferences = previousAssets;
    renderAssetSessionId = previousAssetSessionId;
    renderRawHtml = previousRawHtml;
  }
  if (cacheable) {
    dropStreamedPrefix(contextKey, src);
    mdCache.set(cacheKey, out);
    if (mdCache.size > MD_CACHE_MAX) {
      const oldest = mdCache.keys().next().value;
      if (oldest !== undefined) mdCache.delete(oldest);
    }
  }
  return out;
}

/**
 * Evict the partial this render continues, and remember this one in its place.
 * Only an exact prefix counts, so two messages streaming under one context
 * simply keep their own entries rather than evicting each other's.
 */
function dropStreamedPrefix(contextKey: string, src: string) {
  const previous = mdStreamTail.get(contextKey);
  if (
    previous !== undefined &&
    previous.length < src.length &&
    src.startsWith(previous)
  )
    mdCache.delete(
      contextKey === EMPTY_CONTEXT_KEY
        ? previous
        : `${contextKey}\u0000${previous}`,
    );
  mdStreamTail.delete(contextKey);
  mdStreamTail.set(contextKey, src);
  while (mdStreamTail.size > MD_STREAM_TAIL_MAX) {
    const oldest = mdStreamTail.keys().next().value;
    if (oldest === undefined) break;
    mdStreamTail.delete(oldest);
  }
}

function withoutSingleParagraph(html: string): string {
  const trimmed = html.trim();
  const match = /^<p>([\s\S]*)<\/p>$/.exec(trimmed);
  return match ? match[1] : trimmed;
}

/**
 * A placeholder that cannot collide with the prose it is standing in for.
 * Lengthening it until the source no longer contains it keeps the token
 * deterministic, so the same comment still hits the render cache.
 */
function placeholderPrefix(src: string, base: string): string {
  let prefix = base;
  while (src.includes(prefix)) prefix += "X";
  return prefix;
}

function renderPrMarkdownWithSub(src: string, ctx?: MarkdownContext): string {
  const subs: string[] = [];
  const prefix = placeholderPrefix(src, "OPENSESSIONSUBTOKEN");
  const prepared = src.replace(
    /<sub>([\s\S]*?)<\/sub>/gi,
    (_match, content) => {
      const token = `${prefix}${subs.length}END`;
      subs.push(content);
      return token;
    },
  );
  let html = renderMarkdown(prepared, ctx);
  subs.forEach((content, index) => {
    html = html.replaceAll(
      `${prefix}${index}END`,
      `<sub>${withoutSingleParagraph(renderMarkdown(content, ctx))}</sub>`,
    );
  });
  return html;
}

/** One `<details>` block lifted out of PR prose. */
type DetailsBlock = { open: boolean; summary: string; body: string };

const DETAILS_TAG = /<(\/?)details(?:\s[^>]*)?>/gi;
const DETAILS_SUMMARY = /^\s*<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>/i;

/**
 * Find each top-level `<details>…</details>` and hand back the source with a
 * placeholder in its place. Nesting is counted rather than matched non-greedily,
 * so an inner block closes the inner tag; the body is rendered recursively, so
 * the inner one becomes its own card.
 */
function liftDetails(
  src: string,
  blocks: DetailsBlock[],
  placeholder: (index: number) => string,
): string {
  let out = "";
  let cursor = 0;
  DETAILS_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  let start = -1;
  let openTag = "";
  let depth = 0;
  while ((match = DETAILS_TAG.exec(src))) {
    const closing = match[1] === "/";
    if (!closing) {
      if (depth === 0) {
        start = match.index;
        openTag = match[0];
      }
      depth++;
      continue;
    }
    if (depth === 0) continue; // stray </details>, leave it to the sanitizer
    depth--;
    if (depth > 0) continue;
    const inner = src.slice(start + openTag.length, match.index);
    const summary = DETAILS_SUMMARY.exec(inner);
    // No summary means no card to build; leave the markup alone.
    if (!summary) continue;
    out += src.slice(cursor, start);
    out += `\n\n${placeholder(blocks.length)}\n\n`;
    blocks.push({
      open: /\sopen(?:[\s=>]|$)/i.test(openTag),
      summary: summary[1],
      body: inner.slice(summary[0].length),
    });
    cursor = match.index + match[0].length;
  }
  return out + src.slice(cursor);
}

/**
 * Render GitHub PR prose: a comment, a review, a description. Unlike a session
 * transcript this keeps the raw HTML bots write — the Vercel deployment table's
 * `<a><sup><img/></sup></a>` avatars, `<kbd>`, `<sub>` — because markdown has
 * no syntax for it and escaping shows a wall of tags. Every tag goes through
 * the allowlist in html-sanitize.ts on the way out.
 *
 * `<details>` is still lifted out first: marked stops an HTML block at the
 * blank line inside it, so rendering it in place would leave the summary and
 * the body as separate blocks instead of one collapsible card.
 */
export function renderPrCommentMarkdown(
  src: string,
  ctx?: MarkdownContext,
): string {
  ctx = { ...ctx, rawHtml: "sanitize" };
  const details: DetailsBlock[] = [];
  const prefix = placeholderPrefix(src, "OPENSESSIONDETAILSTOKEN");
  const prepared = liftDetails(src, details, (index) => `${prefix}${index}END`);
  let html = renderPrMarkdownWithSub(prepared, ctx);
  details.forEach(({ open, summary, body }, index) => {
    const token = `${prefix}${index}END`;
    const rendered =
      `<details class="md-details"${open ? " open" : ""}>` +
      `<summary>${withoutSingleParagraph(renderPrMarkdownWithSub(summary, ctx))}</summary>` +
      // Recursive, so a `<details>` inside this one becomes its own card.
      `<div class="md-details-body">${renderPrCommentMarkdown(body, ctx)}</div>` +
      `</details>`;
    html = html.replace(`<p>${token}</p>`, rendered).replace(token, rendered);
  });
  return html;
}
