import type { Route } from "./app-route";

type Listener = (route: Route) => void;
const listeners = new Set<Listener>();

/**
 * Says a conversation was deleted. Every delete path (the tab menu, the
 * viewer's overflow, a discarded draft) ends in the delete API, which calls
 * this, so the route controller can forget it as a place to return to before
 * the lists refresh.
 */
export function announceConversationDeleted(route: Route): void {
  for (const listener of listeners) listener(route);
}

export function onConversationDeleted(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
