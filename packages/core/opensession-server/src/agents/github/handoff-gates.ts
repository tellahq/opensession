/**
 * Pure decision helpers for the review → owning-session handoff (handoff.ts).
 * Zero imports (like autofix-gates.ts) so the test can load this file without
 * dragging in server modules.
 */

/** The slice of runReview's ReviewResult the handoff gates on (structural). */
export interface ReviewGateInput {
  findings: number;
  blocking: number;
  confidence?: number;
}

/**
 * Same bar the auto-fix loop uses to stop: no blocking findings AND either
 * nothing open or the reviewer calls it safe (confidence ≥ 4/5). A satisfied
 * review never starts a fix round.
 */
export function reviewSatisfied(r: ReviewGateInput): boolean {
  return (
    r.blocking === 0 &&
    (r.findings === 0 ||
      (typeof r.confidence === "number" && r.confidence >= 4))
  );
}

/** Per-PR handoff round tracking, persisted on GithubPrState. */
export interface HandoffState {
  /** Fix rounds delivered so far. */
  rounds: number;
  /** Head SHA whose review triggered the last delivery (dedup). */
  lastSha?: string;
  /** Session the last round went to. */
  sessionId?: string;
  deliveredAt?: string;
  /** The round-cap notice was posted on the PR (post it once). */
  cappedAnnounced?: boolean;
}

export type HandoffDecision = "deliver" | "duplicate" | "capped";

/** Should an unsatisfied review of `sha` start another fix round? */
export function handoffDecision(
  prior: HandoffState | undefined,
  sha: string,
  cap: number,
): HandoffDecision {
  if (prior && sha && prior.lastSha === sha) return "duplicate";
  if ((prior?.rounds || 0) >= cap) return "capped";
  return "deliver";
}

/**
 * Is a fix round in flight? While one is, a bot-authored push to the PR is the
 * fix itself and must still be re-reviewed (webhook.ts normally skips bot
 * `synchronize` events). TTL-bounded so an abandoned round can't keep the
 * carve-out open forever.
 */
export function handoffActive(
  prior: HandoffState | undefined,
  nowMs: number,
  ttlMs: number,
): boolean {
  if (!prior?.rounds || !prior.deliveredAt) return false;
  const at = Date.parse(prior.deliveredAt);
  return Number.isFinite(at) && nowMs - at < ttlMs;
}
