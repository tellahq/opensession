// The repo a session files under. Four surfaces historically forked this
// helper with DIFFERENT fallbacks for repo-less sessions, and the divergence
// is user-visible, so it stays explicit at each call site instead of being
// papered over with one shared default:
//
// - lib/sidebar-filter's sessionRepo files repo-less feed/scratch sessions
//   under their feed's kind first, then DEFAULT_PROJECT (the instance's
//   default repo id, e.g. "opensession") — so they group into real project
//   lanes in the sidebar.
// - lib/review-queue matches sessions to open PRs using FALLBACK_REPO
//   ("repository"), which no real PR repo id equals — a repo-less session
//   deliberately never claims a PR that way.
// - Archived and SessionSearch group, filter and label repo-less sessions
//   under the literal "repository" bucket — NOT the sidebar's default-repo
//   lane. (Consequence: filtering Archived by the default repo does not show
//   repo-less sessions the sidebar files under that lane.)
//
// Changing a call site's fallback changes grouping/matching on its surface;
// align them only deliberately, per surface.

import type { UnifiedSession } from "./types";

/** Generic "no repo" bucket used by review-queue, Archived and SessionSearch. */
export const FALLBACK_REPO = "repository";

/**
 * Reserved repo id a CREATE sends to mean "this session has no repo" (the
 * server's `NO_REPO`, worktree.ts). Ask uses it for a repo-less conversation;
 * Code uses it for a writable Scratch session.
 *
 * Deliberately not the empty string: the create has to tell "the user turned
 * the repo off" from "the field was never set", because an unset repo still
 * means inherit-or-default — which is what every agent-created subagent
 * relies on.
 */
export const NO_REPO = "none";

export function sessionRepoOr(
  s: Pick<UnifiedSession, "repo">,
  fallback: string,
): string {
  return s.repo || fallback;
}
