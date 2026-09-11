import {
  deskShowTargetSchema,
  type DeskShowTarget,
} from "../../shared/desk-navigation";
import type { Route } from "./app-route";
export type { DeskShowTarget } from "../../shared/desk-navigation";

export function deskShowRoute(target: DeskShowTarget): Route {
  return { view: target.kind, id: target.id };
}

// Local to this browser's voice client, not a server WebSocket broadcast.
const SHOW_EVENT = "opensession:desk-show";
export function showDeskTarget(target: DeskShowTarget): boolean {
  return !window.dispatchEvent(
    new CustomEvent(SHOW_EVENT, { detail: target, cancelable: true }),
  );
}

export function onDeskShow(show: (route: Route) => void): () => void {
  const listener = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const parsed = deskShowTargetSchema.safeParse(event.detail);
    if (!parsed.success) return;
    show(deskShowRoute(parsed.data));
    event.preventDefault();
  };
  window.addEventListener(SHOW_EVENT, listener);
  return () => window.removeEventListener(SHOW_EVENT, listener);
}
