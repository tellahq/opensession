/**
 * Per-user sidebar lanes. Like pins.ts, each user (the self-selected
 * `backstage-user` name from the UserPicker — not an auth identity) gets one
 * JSON file under `~/.opensession-lanes/` of shape
 * `{ lanes: { [sessionId]: lane } }`, where `lane` is one of the sidebar's
 * status-lane keys (needsinput/inprogress/review/merged/pending) or "mine".
 * Filename, directory resolution and legacy-name fallback come from
 * shared/user-store.ts.
 *
 * An entry means "this session belongs in MY sidebar" — that's what pulls an
 * automation run or a teammate's workspace out of its own band and into your
 * lanes. The value then says where it sits: a status key forces that lane,
 * while "mine" leaves it to follow its live state.
 *
 * Lanes are personal triage, not workspace state: two teammates can each hold
 * the same workspace in their own Backlog, and moving it in your sidebar
 * never moves it in theirs. The legacy status-overrides.ts registry (one
 * global lane per session) remains as a read-only fallback for entries set
 * before lanes went per-user; new writes land here.
 */

import { userStore } from "./shared/user-store";

/**
 * Allowed lane keys — the frontend's MineStatus, plus the "mine" sentinel: a
 * claim with no forced lane, so the row sits in your sidebar and follows its
 * own live state (In progress while running, Backlog once idle).
 */
const ALLOWED = new Set([
  "needsinput",
  "inprogress",
  "review",
  "merged",
  "pending",
  "mine",
]);

export type Lanes = Record<string, string>;

/** Keep only string-id → allowed-lane entries. */
function clean(input: unknown): Lanes {
  const out: Lanes = {};
  if (input && typeof input === "object") {
    for (const [id, lane] of Object.entries(input as Record<string, unknown>)) {
      if (
        typeof id === "string" &&
        id.length > 0 &&
        id.length <= 128 &&
        typeof lane === "string" &&
        ALLOWED.has(lane)
      ) {
        out[id] = lane;
      }
    }
  }
  return out;
}

const store = userStore<Lanes>({ name: "lanes", field: "lanes", clean });

export function getLanes(user: string): Lanes {
  return store.get(user);
}

/** Replace a user's lanes (validated). Returns the stored map. */
export function setLanes(user: string, lanes: unknown): Lanes {
  return store.set(user, lanes);
}
