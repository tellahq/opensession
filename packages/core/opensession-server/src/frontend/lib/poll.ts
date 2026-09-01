import { browserSignalStreams } from "./effect-browser-events";
import { makeEffectLifecycle } from "./effect-lifecycle";

/**
 * Polls after a delay while visible and refreshes immediately on foregrounding.
 * Background PWA windows and unfocused tabs avoid spending shared API budget.
 */
export function pollWhileVisible(fn: () => void, ms: number): () => void {
  const lifecycle = makeEffectLifecycle<"interval" | "visibility">();
  let active = true;
  const tick = () => {
    if (active && !document.hidden) fn();
  };
  lifecycle.repeat("interval", ms, tick);
  lifecycle.stream("visibility", browserSignalStreams.visibility(), tick);
  return () => {
    active = false;
    lifecycle.stop();
  };
}

/** GitHub webhooks are the primary PR refresh path; this only recovers missed events. */
export const PR_WEBHOOK_FALLBACK_POLL_MS = 5 * 60_000;
