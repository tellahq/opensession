import type { PortalTarget } from "./portals";

const PIN_EVENT = "opensession:pin-portal";

/**
 * What the side panel's Browser tab shows: a running Portal, a link, or the
 * pull request's preview deployment.
 */
export type PanelBrowserTarget =
  | { kind: "portal"; target: PortalTarget }
  | { kind: "url"; url: string }
  | { kind: "staging" };

/**
 * Ask the focused session to show `target` in its side panel's Browser tab.
 * A Portal target names its session, and only that session takes it.
 */
export function requestPanelBrowser(target: PanelBrowserTarget): void {
  window.dispatchEvent(new CustomEvent(PIN_EVENT, { detail: target }));
}

/** Ask the session that owns `target` to pin it in its side panel. */
export function requestPortalPin(target: PortalTarget): void {
  requestPanelBrowser({ kind: "portal", target });
}

export function onPanelBrowserRequest(
  listener: (target: PanelBrowserTarget) => void,
): () => void {
  const handle = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    // SAFETY: only requestPanelBrowser dispatches this event, with a target.
    listener(event.detail as PanelBrowserTarget);
  };
  window.addEventListener(PIN_EVENT, handle);
  return () => window.removeEventListener(PIN_EVENT, handle);
}
