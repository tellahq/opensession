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

/**
 * A review can pass with findings still open: no blocking ones, high enough
 * confidence. That starts no fix round, but the session that wrote the code
 * should still hear about them once. After fix rounds, a delivered settled
 * message closes the loop instead. When that wrap-up could not go out (its
 * round session is gone), the owner gets the notice even if this review filed
 * nothing new, since earlier threads can still be open; notifyOpenFindings
 * then sends it only if the unresolved-thread read is nonempty.
 */
export function openFindingsNoticeNeeded(
  r: ReviewGateInput,
  prior: Pick<HandoffState, "rounds"> | undefined,
  wrapUpSent: boolean,
): boolean {
  if (!reviewSatisfied(r) || wrapUpSent) return false;
  return r.findings > 0 || !!prior?.rounds;
}

/**
 * Findings to report: the review's own count, else the open inline threads in
 * the findings block. Review summary bodies (an approval's "LGTM") are listed
 * there too but are not findings, so only thread entries count: they carry a
 * `comment <id>` or `thread <id>` handle after the author.
 */
export function openFindingsCount(
  reported: number,
  findingsBlock: string,
): number {
  if (reported > 0) return reported;
  return findingsBlock
    .split("\n")
    .filter((l) => /^- \[@\S+ · (comment|thread) /.test(l)).length;
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
  /** Head SHA of the last review whose findings reached the session after the
   * cap (the capped wrap-up or a post-cap notice). One delivery per commit. */
  cappedSha?: string;
}

/**
 * - deliver: start the next fix round.
 * - duplicate: this commit's findings already reached the session.
 * - capped: the cap was just reached; send the wrap-up with the findings.
 * - post-cap: a later push was reviewed; tell the session, start no round.
 */
/**
 * Is the round state still the one a passing review settled? Reviews of
 * different commits finish concurrently, so an older pass must not clear a
 * round a newer failing review recorded meanwhile.
 */
export function sameHandoffRound(
  current: Pick<HandoffState, "rounds" | "lastSha"> | undefined,
  expected: Pick<HandoffState, "rounds" | "lastSha">,
): boolean {
  return (
    !!current &&
    current.rounds === expected.rounds &&
    current.lastSha === expected.lastSha
  );
}

/**
 * Has a newer review of this PR finished since this one? The review lock is
 * released before the handoff runs, so reviews of two commits can reach it
 * out of order. A stale result must not deliver or touch round state: its
 * findings describe a commit the newer review already replaced.
 */
export function staleReview(
  reviewedSha: string | undefined,
  lastReviewedSha: string | undefined,
): boolean {
  return !!reviewedSha && !!lastReviewedSha && reviewedSha !== lastReviewedSha;
}

/**
 * Run `fn` after every earlier call with the same key has settled, so handoffs
 * for one PR never interleave. `queues` holds each key's tail; it is dropped
 * once the queue drains.
 */
export function serializeByKey<T>(
  queues: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

export type HandoffDecision = "deliver" | "duplicate" | "capped" | "post-cap";

/** What should an unsatisfied review of `sha` do in the owning session? */
export function handoffDecision(
  prior: HandoffState | undefined,
  sha: string,
  cap: number,
): HandoffDecision {
  if (prior && sha && prior.lastSha === sha) return "duplicate";
  if ((prior?.rounds || 0) < cap) return "deliver";
  if (!prior?.cappedAnnounced) return "capped";
  if (sha && prior.cappedSha === sha) return "duplicate";
  return "post-cap";
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

/**
 * Which session a review handoff goes to. The session named in the PR body's
 * attribution footer wins while it can take the work, matching the CI-failure
 * and conflict notices: a session can open a PR in a repo it never attached,
 * so the branch lookup alone misses it. When the footer session handed the
 * branch to a worker it started (a coordinator and its thread), that worker
 * writes and pushes the code, so it gets the findings directly instead of
 * through the coordinator. Otherwise the best branch owner.
 */
export function pickHandoffOwner<S>(
  referenced: S | undefined,
  canOwn: (session: S) => boolean,
  branchOwners: readonly S[],
  startedBy: (owner: S, referenced: S) => boolean = () => false,
): S | undefined {
  if (referenced && canOwn(referenced)) {
    const worker = branchOwners.find(
      (s) => s !== referenced && canOwn(s) && startedBy(s, referenced),
    );
    return worker ?? referenced;
  }
  return branchOwners[0];
}

/**
 * Did `ancestorId` start `id`, directly or through its own workers? Follows
 * parent links a few hops up; a missing session or a cycle ends the walk.
 */
export function descendsFrom(
  id: string,
  ancestorId: string,
  parentOf: (id: string) => string | undefined,
  maxHops = 4,
): boolean {
  let current = parentOf(id);
  for (let hop = 0; current && hop < maxHops; hop++) {
    if (current === ancestorId) return true;
    if (current === id) return false;
    current = parentOf(current);
  }
  return false;
}
