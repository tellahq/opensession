/**
 * Polls after a delay while visible and refreshes immediately on foregrounding.
 * Background PWA windows and unfocused tabs avoid spending shared API budget.
 */
export function pollWhileVisible(fn: () => void, ms: number): () => void {
  let active = true;
  const tick = () => {
    if (active && !document.hidden) fn();
  };
  const interval = window.setInterval(tick, ms);
  document.addEventListener("visibilitychange", tick);
  return () => {
    active = false;
    window.clearInterval(interval);
    document.removeEventListener("visibilitychange", tick);
  };
}

/** GitHub webhooks are the primary PR refresh path; this only recovers missed events. */
export const PR_WEBHOOK_FALLBACK_POLL_MS = 5 * 60_000;
