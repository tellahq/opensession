import { z } from "zod";
import { fetchHealthStatus } from "./health";

/**
 * Stale-bundle detection for already-open windows.
 *
 * A frontend-only hot rebuild reuses the server process: the socket never
 * drops and bootId does not change, so a long-lived browser tab or Electron
 * renderer that missed the `frontend_updated` broadcast has no other way to
 * learn its content-hashed bundle is stale. This polls the build version and
 * tells subscribers — it deliberately does NOT reload: this server rebuilds
 * many times an hour while people are working, and yanking a phone or a
 * half-typed composer out from under someone is worse than a stale bundle.
 * Subscribers surface the same non-blocking "Update" nudge as the broadcast.
 */
const POLL_MS = 30_000;
const frontendVersionSchema = z.string().min(1);

let seen: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<(version: string) => void>();

async function check() {
  // Backgrounded tabs learn on their next foreground poll — no phone radio
  // wakeups for a nudge nobody can see.
  if (document.hidden) return;
  try {
    const data = await fetchHealthStatus();
    const versionResult = frontendVersionSchema.safeParse(
      data?.frontendVersion,
    );
    if (!versionResult.success) return;
    const version = versionResult.data;
    if (seen === null) {
      seen = version;
      return;
    }
    if (version === seen) return;
    seen = version;
    for (const notify of subscribers) notify(version);
  } catch {}
}

/** Subscribe to "a newer frontend build is live". Returns an unsubscribe. */
export function subscribeFrontendVersion(onChange: (version: string) => void) {
  subscribers.add(onChange);
  if (!timer) {
    timer = setInterval(() => void check(), POLL_MS);
    void check();
  }
  return () => {
    subscribers.delete(onChange);
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
