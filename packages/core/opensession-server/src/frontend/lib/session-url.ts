/**
 * Where a URL into Open Session points.
 *
 * Two surfaces have to agree about this and they sit far apart: the markdown
 * renderer, which turns a pasted session link into a chip, and the composer,
 * which shortens one to its bare id at the moment it is pasted. A second
 * parser in either would drift — over the legacy path prefixes, over which
 * hosts count as us, over the two spellings of a session path — and the drift
 * would be silent: a link the composer shortened into something the renderer
 * no longer recognises is plain text where a chip belongs.
 */

import { PUBLIC_BASE_URL } from "./brand";

/** Every minted id is `<prefix>-<uuidv7>`. */
export const UUIDV7 =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * A minted session id standing on its own. Strict, and deliberately narrower
 * than the shape a codespan accepts (`bks-ghpr-5099-review`): this is the only
 * form that chips as a bare word in prose, in the web renderer (the `sessionId`
 * extension in markdown.ts) and in the native app (SessionLinks.swift) alike.
 * A session whose id falls outside it has to keep its whole URL to stay a link.
 */
const MINTED_SESSION_ID = new RegExp(`^(?:os|bks)-${UUIDV7}$`, "i");

/**
 * Whether an id stands on its own as a reference — see `MINTED_SESSION_ID`.
 * The question anyone WRITING a reference has to ask, which is the mirror of
 * the one `pastedSessionId` asks when reading one.
 */
export function isMintedSessionId(id: string): boolean {
  return MINTED_SESSION_ID.test(id);
}

// Links into Open Session itself stay in this app. Match the complete origin,
// not only the hostname: portal previews deliberately use another port on the
// same host (`os.tella.dev:25779`), and those are external pages that must open
// in a new tab. The configured public origin remains trusted while the app is
// viewed through another entry URL (for example its ts.net address).
export const INTERNAL_ORIGINS = new Set(
  [
    typeof location === "undefined" ? "" : location.origin,
    (() => {
      try {
        return new URL(PUBLIC_BASE_URL).origin;
      } catch {
        return "";
      }
    })(),
  ].filter(Boolean),
);

/** What an internal URL opens, or null when it does not point at this app. */
export function internalUrlTarget(href: string | null | undefined): {
  sessionId?: string;
  automationId?: string;
} | null {
  if (!href) return null;
  const loc =
    typeof location !== "undefined" ? location.href : "http://127.0.0.1:3850/";
  let url: URL;
  try {
    url = new URL(String(href), loc);
  } catch {
    return null;
  }
  if (!INTERNAL_ORIGINS.has(url.origin)) return null;
  const path = url.pathname.replace(/^\/(?:opensession|backstage)(?=\/)/, "");
  // The path already says "session", so both prefixes take the loose shape here.
  const m =
    path.match(/^\/session\/((?:os|bks)-[a-z0-9][a-z0-9-]{5,})\/?$/i) ??
    path.match(
      /^\/workspace\/[^/]+\/session\/((?:os|bks)-[a-z0-9][a-z0-9-]{5,})\/?$/i,
    );
  const automation = path.match(
    new RegExp(`^/automations/(auto-${UUIDV7})/?$`, "i"),
  );
  return {
    sessionId: m ? decodeURIComponent(m[1]) : undefined,
    automationId: automation ? decodeURIComponent(automation[1]) : undefined,
  };
}

/**
 * The bare id to write into a draft in place of a pasted session link, or
 * undefined to keep what was pasted.
 *
 * A session URL is around 120 characters and wraps onto a second line of the
 * composer; the id it carries is the same reference in a third of the room,
 * and it renders as the same chip — labelled with the session's title, which
 * the URL never showed either. So the shortening loses nothing a person was
 * reading, and the pill the composer paints around it says it was understood.
 *
 * Two gates, and both of them exist to keep the rewrite from ever being the
 * wrong call rather than merely a smaller one:
 *
 *  - The paste has to be nothing BUT the link. A URL inside a paragraph, a
 *    list or an open code fence is someone's content, and rewriting content
 *    is a different act from tidying a link they just dropped in. Left alone,
 *    it still chips on send — the renderer reads the long form too.
 *  - The id has to be a minted one. `internalUrlTarget` accepts the looser
 *    legacy shape a hand-made id takes (`bks-ghpr-5099-review`), but a bare
 *    word of that shape is NOT a chip in prose, so shortening one would trade
 *    a working link for dead text.
 */
export function pastedSessionId(pasted: string): string | undefined {
  const text = pasted.trim();
  if (!text || /\s/.test(text)) return undefined;
  const id = internalUrlTarget(text)?.sessionId;
  return id && isMintedSessionId(id) ? id : undefined;
}

/**
 * Take over a paste of a bare session link, writing the id in its place.
 * Returns false when the paste is anything else, so the caller carries on
 * with it.
 *
 * The insertion goes through `execCommand` to land on the field's native undo
 * stack, which matters more here than it usually does: undo is the way back
 * from a rewrite somebody did not want. It gives back an empty field rather
 * than the URL — that never entered it — and that is the second reason the
 * rewrite only ever fires on a paste that is nothing but the link, where
 * pasting again is the whole of the repair.
 */
export function insertPastedSessionId(e: React.ClipboardEvent): boolean {
  const id = pastedSessionId(e.clipboardData?.getData("text/plain") ?? "");
  if (!id) return false;
  e.preventDefault();
  const el = e.currentTarget as HTMLTextAreaElement;
  if (document.execCommand("insertText", false, id)) return true;
  el.setRangeText(id, el.selectionStart ?? 0, el.selectionEnd ?? 0, "end");
  el.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      data: id,
      inputType: "insertFromPaste",
    }),
  );
  return true;
}
