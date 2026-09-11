/**
 * Which session a click in a transcript wants to open, if any.
 *
 * Session references in a transcript carry `data-session-id` and no handler
 * of their own: markdown chips come from `dangerouslySetInnerHTML` (lib/
 * markdown.ts) and cannot carry React handlers, and the tool row's spawned
 * session pill (ToolCallBlock) stays a plain span so it can live inside the
 * row's button. Every pane that renders a transcript therefore has to
 * delegate the click from its scroll container. There are two such panes,
 * the session viewer and the Desk, and one reading of the click keeps them
 * from drifting: a pill that opens in one place must open in the other.
 */

interface TranscriptClick {
  target: EventTarget | null;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}

/**
 * The session id the click should open in place, or null to leave the event
 * alone. A modified click on a chip with an href is left to the browser, so
 * cmd/ctrl-click still opens a tab and shift-click a window. Pure: the caller
 * prevents the default once it knows it can open the session.
 */
export function sessionIdFromTranscriptClick(
  e: TranscriptClick,
): string | null {
  const target = e.target;
  if (!(target instanceof Element)) return null;
  const candidate = target.closest("[data-session-id]");
  const el = candidate instanceof HTMLElement ? candidate : null;
  const id = el?.dataset.sessionId;
  if (!id) return null;
  if ((e.metaKey || e.ctrlKey || e.shiftKey) && el?.getAttribute("href"))
    return null;
  return id;
}
