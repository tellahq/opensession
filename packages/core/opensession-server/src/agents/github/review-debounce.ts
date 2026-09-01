export interface ReviewDebounceTiming {
  firstPushAt: number;
  dueAt: number;
}

export interface ReviewDebounceProgress {
  firstPushAt?: number;
  attempts: number;
}

/** A push joins only a quiet, never-attempted burst. Running/retried work gets a new burst. */
export function reviewBurstStart(
  existing: ReviewDebounceProgress | undefined,
  now: number,
): number {
  const firstPushAt = existing?.firstPushAt;
  return existing &&
    existing.attempts === 0 &&
    typeof firstPushAt === "number" &&
    Number.isFinite(firstPushAt)
    ? firstPushAt
    : now;
}

/** Preserve both the quiet period after the latest push and the burst's max wait. */
export function nextReviewDebounce(
  firstPushAt: number | undefined,
  now: number,
  quietMs: number,
  maxWaitMs: number,
): ReviewDebounceTiming {
  const first =
    typeof firstPushAt === "number" && Number.isFinite(firstPushAt)
      ? firstPushAt
      : now;
  return {
    firstPushAt: first,
    dueAt: Math.min(now + quietMs, first + maxWaitMs),
  };
}

export function reviewDebounceDelay(dueAt: number, now: number): number {
  return Math.max(0, dueAt - now);
}

export function reviewRetryDelay(
  attempts: number,
  baseMs: number,
  maxMs: number,
): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempts - 1));
}
