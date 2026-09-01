import { elapsedSince } from "./time";

const STILL_WORKING_MS = 10_000;

export interface BusyActivityStatus {
  label: "Working" | "Still working";
  elapsed: string | null;
}

/** Honest fallback copy for a live run when the provider has no visible event.
 * We only know that the request remains active, so the wording never claims a
 * specific model or tool phase. */
export function busyActivityStatus(elapsedMs: number): BusyActivityStatus {
  const safeElapsedMs = Math.max(0, elapsedMs);
  if (safeElapsedMs < STILL_WORKING_MS) {
    return { label: "Working", elapsed: null };
  }
  return {
    label: "Still working",
    elapsed: elapsedSince(0, safeElapsedMs),
  };
}
