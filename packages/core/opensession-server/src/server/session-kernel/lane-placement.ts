/**
 * Sticky two-choice lane placement for session actors.
 *
 * A session picks its execution lane once, when it activates (its service
 * mailbox is created), and keeps that lane until the mailbox drains. Stable
 * affinity keeps one logical actor's process-local reducer caches on one lane
 * while it is active; the durable database remains the authority and is
 * rehydrated after restart or LRU passivation, so a later activation may pick
 * a different lane safely.
 *
 * Placement uses two rendezvous candidates from independent hashes and takes
 * the one with the lower live load. Ties keep the primary candidate, so a
 * quiet service places exactly like the previous pure-hash affinity. An
 * active mailbox is never moved: only activation chooses.
 */

/** FNV-1a over the session id, with an optional seed for a second candidate. */
export function laneHash(sessionId: string, seed = 0): number {
  let hash = (2_166_136_261 ^ seed) >>> 0;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export type LaneLoad = {
  /** Turns waiting in the lane queue. */
  queued: number;
  /** Turns currently executing on the lane worker. */
  executing: number;
};

const SECOND_CANDIDATE_SEED = 0x9e37_79b9;

/**
 * Choose the lane index for a session activating now. Deterministic given the
 * same loads; equal-load ties resolve to the primary hash candidate.
 */
export function chooseSessionLane(
  sessionId: string,
  lanes: readonly LaneLoad[],
): number {
  if (lanes.length === 0) throw new Error("No session lanes to place on");
  const first = laneHash(sessionId, 0) % lanes.length;
  if (lanes.length === 1) return first;
  const second = laneHash(sessionId, SECOND_CANDIDATE_SEED) % lanes.length;
  if (second === first) return first;
  const load = (index: number) =>
    lanes[index]!.queued + lanes[index]!.executing;
  return load(second) < load(first) ? second : first;
}
