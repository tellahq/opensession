import { createContext, useContext } from "react";
import { absoluteLink, sessionPath } from "./share-link";

/**
 * Links to one message in a session: the session's own URL with the entry id
 * in the hash, `…/session/<id>#message-<entryId>`. A hash rather than a path
 * segment or query, so the link is still an ordinary session URL to every
 * route, share target and older client that does not know about messages: at
 * worst it opens the session at its live edge.
 */
const PREFIX = "#message-";

export function messageLinkHash(entryId: string): string {
  return PREFIX + encodeURIComponent(entryId);
}

/** The entry id a `#message-…` hash names, or null for any other hash. */
export function linkedMessageId(hash: string): string | null {
  if (!hash.startsWith(PREFIX)) return null;
  try {
    return decodeURIComponent(hash.slice(PREFIX.length)) || null;
  } catch {
    return null;
  }
}

/** Absolute link to one message of a session. */
export function messageLink(
  session: { id: string; workspaceId?: string | null },
  entryId: string,
): string {
  return absoluteLink(sessionPath(session)) + messageLinkHash(entryId);
}

/**
 * Builds the link for a message in the transcript being read. Context rather
 * than a prop for the same reason as the open-asset one: the callers are a
 * bubble and a turn footer several memoized layers down. Null where a link
 * would point somewhere else than what is on screen (a sub-agent pane, the
 * Desk overlay), and the caller then offers no "Copy link".
 */
const MessageLinkContext = createContext<((entryId: string) => string) | null>(
  null,
);
export const MessageLinkProvider = MessageLinkContext.Provider;

export function useMessageLink(): ((entryId: string) => string) | null {
  return useContext(MessageLinkContext);
}
