import { getLane } from "./lanes";
import { personKey } from "./review-queue";
import { sessionPrApproved, sessionPrMerged } from "./session-prs";
import type { MineStatus } from "./sidebar-types";
import type { UnifiedSession } from "./types";
import {
  IconCheck,
  IconClock,
  IconGitMerge,
  IconInbox,
  IconMessageQuestion,
} from "../components/icons";

// The status glyphs, sized + colored for a menu row (no group className, so
// the menu controls sizing) — used by the "Set status" flyout. The lane and
// band headers carry no glyph of their own: they're dividers, and the rows
// under them already wear the status marks.
export function statusMenuIcon(status: MineStatus, color: string) {
  const style = { color };
  if (status === "needsinput")
    return <IconMessageQuestion size={20} style={style} />;
  if (status === "inprogress") return <IconClock size={20} style={style} />;
  if (status === "review") return <IconGitMerge size={20} style={style} />;
  if (status === "merged") return <IconCheck size={20} style={style} />;
  return <IconInbox size={20} style={style} />;
}

// A run that died on a terminal failure (usage limits/credits exhausted, API
// errors) needs a human to act, exactly like a blocked question — it must not
// sink quietly into the Backlog. A live run means a retry is underway, so the
// stale flag doesn't override "In progress".
export function runNeedsAttention(s: UnifiedSession): boolean {
  return !!s.safety || (!!s.lastRunError && !s.isRunning);
}

// A workspace reflects its top-level sessions, not implementation-detail
// workers. A failed subagent must not make recovered parent work look failed.
// Keep the child-only fallback for the unusual workspace whose parent is not
// present in the current list, where hiding the only actionable run is worse.
export function workspaceRunNeedingAttention(
  sessions: UnifiedSession[],
): UnifiedSession | undefined {
  const topLevel = sessions.filter((session) => !session.parentSessionId);
  return (topLevel.length > 0 ? topLevel : sessions).find(runNeedsAttention);
}

// Whether this session lives in YOUR sidebar lanes. Your own sessions always do;
// automation runs and teammates' workspaces only once you claim them (the
// lane entry is the claim — see lib/lanes.ts).
export function isClaimed(s: UnifiedSession): boolean {
  return !!getLane(s.id) || !!s.manualStatus;
}

// The effective human-pinned lane for a session: YOUR per-user lane
// (lib/lanes.ts) first, then the legacy global override as a fallback for
// entries set before lanes went per-user. A "mine" claim forces nothing — the
// row keeps following its live state — so it reads as no pin at all.
export function pinnedLane(s: UnifiedSession): MineStatus | undefined {
  const lane = getLane(s.id);
  if (lane === "mine") return undefined;
  return lane ?? s.manualStatus;
}

// A row you started yourself (automation runs are never "yours" — they arrive
// in the Automations band and need claiming to join your lanes). Session origins
// can write a full display name while the picker stores its person key.
export function ownedBy(s: UnifiedSession, user: string): boolean {
  return (
    !s.automation && !!s.startedBy && personKey(s.startedBy) === personKey(user)
  );
}

export function mineStatus(s: UnifiedSession): MineStatus {
  // A blocked question (or a run that died on an error) needs a human right
  // now — surface it above everything else, even a manual pin or an open PR, so
  // it never hides inside another bucket. This state is transient (it clears the
  // moment the question is answered / the run recovers), so it doesn't stomp the
  // manual pin permanently — it just floats above it while live.
  if (s.waitingForInput || runNeedsAttention(s)) return "needsinput";
  // Live execution is authoritative. A pinned lane parks idle work; it must
  // never leave a visibly working chat filed under Backlog or another stage.
  if (s.isRunning) return "inprogress";
  const lane = pinnedLane(s);
  if (lane) return lane;
  // Everything else is idle. A single session knows nothing about the PR
  // lifecycle — the workspace row reads that across its sessions
  // (prLaneForSessions), because a session that shipped one feature as three
  // PRs has only landed once they all have. Leaving the sidebar stays an
  // explicit act (Archive), never inferred from a merged PR or inactivity.
  return "pending";
}

// PR state overrides the manual review bands. A merged PR means the work is
// done and falls into the "Done" status lane. An approved-but-unmerged PR means
// the review has landed, so the row leaves the sidebar until another review is
// requested. Without this a session you sent out sits in "Awaiting review"
// forever, since the band otherwise only clears on a manual accept.
// A session that shipped one feature as several PRs has only landed once they all
// have: keying off the primary branch's PR alone drops the row into Done with
// three PRs still open. Single-PR sessions keep the exact old behaviour.
export function wsPrMerged(r: { sessions: UnifiedSession[] }): boolean {
  return r.sessions.some(sessionPrMerged);
}
export function wsPrApproved(r: { sessions: UnifiedSession[] }): boolean {
  return !wsPrMerged(r) && r.sessions.some(sessionPrApproved);
}
// Has `person` (lowercase person key) already given their review on the row's
// PR? Their latest submitted review counts whatever the outcome — approve,
// request changes, or comment — unless the author re-requested them since:
// a pending re-request puts the PR back in their queue, matching GitHub's own
// requested-reviewers behavior. Keeps "Needs review" honest when the reviewer
// reviewed on GitHub instead of clicking "Mark as reviewed".
export function wsPrReviewGivenBy(
  r: { sessions: UnifiedSession[] },
  person: string,
): boolean {
  const has = (list?: string[]) =>
    (list || []).some((p) => p.toLowerCase() === person);
  return (
    r.sessions.some((c) => has(c.prReviewedBy)) &&
    !r.sessions.some((c) => has(c.prReviewRequested))
  );
}

// Since the PR-queue dissolution the status lanes carry the PR lifecycle too.
// A landed PR parks its idle row in Done ("merged"): the work shipped, so it
// reads as finished rather than sinking into Backlog beside work that hasn't
// started. Done is still a lane and not a hiding place — archiving stays the
// explicit act it always was. Of the PRs still open only one promotes: a
// green, mergeable, non-draft one parks its row in Ready to merge ("review").
// Every other open PR — conflicts, failing checks, changes requested, drafts,
// awaiting review — stays in Backlog with the red/yellow PR glyph carrying the
// problem, so In progress keeps meaning "a run is live". Returns null to leave
// the derived lane alone.
export function prLaneForSessions(
  sessions: UnifiedSession[],
): MineStatus | null {
  // Same "the workspace has landed" rule the review bands use (wsPrMerged),
  // so a row can't be done here and still awaiting review there.
  if (sessions.some(sessionPrMerged)) return "merged";
  const session = frontingPrSession(sessions);
  if (!session || session.prState !== "OPEN" || session.prIsDraft) return null;
  const checks = session.prChecks;
  const ready =
    (!checks ||
      checks.total === 0 ||
      (checks.failed === 0 && checks.pending === 0)) &&
    session.prMergeable !== "CONFLICTING" &&
    session.prReviewDecision !== "CHANGES_REQUESTED";
  return ready ? "review" : null;
}

// Workspaces adopted from a PR inherit names like "PR #3662: Rehome setup
// controls" — in the sidebar the PR icon already carries that identity, so the
// row shows just the human title. Display-only: the tooltip, rename field and
// hovercard keep the full name (and the PR number lives there + in the PR tab).
export function stripPrTitlePrefix(name: string): string {
  return name.replace(/^PR\s*#\d+(:|\s*[—–-])\s*/i, "");
}

export function frontingPrSession(
  sessions: UnifiedSession[],
): UnifiedSession | undefined {
  return [...sessions]
    .sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""))
    .find((session) => session.prUrl);
}
