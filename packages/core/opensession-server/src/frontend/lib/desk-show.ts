import {
  deskShowTargetSchema,
  type DeskShowTarget,
} from "../../shared/desk-navigation";
import type { Route } from "./app-route";
export type { DeskShowTarget } from "../../shared/desk-navigation";

/** The page a Desk target lands on. A workspace pane is part of the route; a
 * session's tab is not, so the app applies that after navigating. */
export function deskShowRoute(target: DeskShowTarget): Route {
  if (target.kind === "workspace")
    return target.tab && target.tab !== "chat"
      ? { view: "workspace", id: target.id, tab: target.tab }
      : { view: "workspace", id: target.id };
  return { view: "session", id: target.id };
}

// Local to this browser's voice client, not a server WebSocket broadcast.
const SHOW_EVENT = "opensession:desk-show";
export function showDeskTarget(target: DeskShowTarget): boolean {
  return !window.dispatchEvent(
    new CustomEvent(SHOW_EVENT, { detail: target, cancelable: true }),
  );
}

export function onDeskShow(
  show: (target: DeskShowTarget, route: Route) => void,
): () => void {
  const listener = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const parsed = deskShowTargetSchema.safeParse(event.detail);
    if (!parsed.success) return;
    show(parsed.data, deskShowRoute(parsed.data));
    event.preventDefault();
  };
  window.addEventListener(SHOW_EVENT, listener);
  return () => window.removeEventListener(SHOW_EVENT, listener);
}
