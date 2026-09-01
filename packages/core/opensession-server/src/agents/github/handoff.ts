/**
 * Review → owning-session handoff. When an automatic PR review finishes
 * unsatisfied (blocking findings, or open findings at low confidence), the
 * findings are delivered straight into the live Open Session session working on
 * that PR's branch — the agent that wrote the code fixes it with full context,
 * no `os-auto-fix` label needed. Its push re-triggers the normal review cycle,
 * closing the loop.
 *
 * Bounds: SHA dedup + a per-PR round cap (state.handoff), a TTL on the active
 * window, and the shared "code" lock — a running label auto-fix/simplify wins
 * and suppresses the handoff. PRs with no live owning session keep today's
 * label-driven flow, so the agent never pushes to a human's branch uninvited.
 * Kill switch: OPENSESSION_REVIEW_HANDOFF=0.
 */
import { defaultRepo } from "../../server/config";
import { audit } from "../../server/audit";
import { tryGetSessionControl } from "../../server/session-control";
import {
  editIssueComment,
  fetchReviewFindings,
  getComment,
} from "./github-rest";
import {
  getOrInitPrState,
  isLockHeld,
  readPrState,
  updatePrState,
} from "./state";
import { matchSessions, workspaceIdForRepo } from "./session-notify";
import {
  handoffActive,
  handoffDecision,
  reviewSatisfied,
} from "./handoff-gates";
import { buildHandoffMessage } from "./prompts";
import { uiSessionUrl } from "./run";
import type { PrRef, ReviewResult } from "./review";

const MAX_ROUNDS = parseInt(
  process.env.OPENSESSION_REVIEW_HANDOFF_ROUNDS || "6",
);
/** An abandoned round stops holding the bot-push review carve-out open after this. */
const ACTIVE_TTL_MS = 24 * 60 * 60 * 1000;

export function handoffEnabled(): boolean {
  return process.env.OPENSESSION_REVIEW_HANDOFF !== "0";
}

/**
 * Sync probe for webhook.ts: is a fix round in flight for this PR? Bot-authored
 * pushes during a round are the fixes themselves and must still be re-reviewed
 * (the webhook normally skips bot `synchronize` events).
 */
export function isHandoffActive(prNumber: number, ghRepo?: string): boolean {
  if (!handoffEnabled()) return false;
  return handoffActive(
    readPrState(prNumber, ghRepo)?.handoff,
    Date.now(),
    ACTIVE_TTL_MS,
  );
}

/** Drop round tracking (PR closed, or a review came back satisfied). */
export function clearHandoff(prNumber: number, ghRepo?: string): void {
  const s = readPrState(prNumber, ghRepo);
  if (!s?.handoff) return;
  updatePrState(
    prNumber,
    s.headRef,
    (st) => {
      st.handoff = undefined;
    },
    ghRepo,
  );
}

/**
 * Called after every webhook-triggered review with its result. Decides whether
 * to start (or stop) a fix round in the PR's owning session. Never throws.
 */
export async function maybeHandoffFindings(
  pr: PrRef,
  review: ReviewResult | null,
): Promise<void> {
  try {
    // null = the review was skipped (dedup/lock) or died before producing a result.
    if (!handoffEnabled() || !review || review.error) return;
    if (reviewSatisfied(review)) {
      clearHandoff(pr.number, pr.ghRepo);
      return;
    }
    // A fixer (label auto-fix / simplify / mention reply) already owns the
    // branch worktree — auto-fix runs its own review-gated loop.
    if (isLockHeld("code", pr.number, pr.ghRepo)) return;

    const control = tryGetSessionControl();
    if (!control) return;
    const repoFull = pr.ghRepo || defaultRepo().ghRepo;
    const workspaceId = workspaceIdForRepo(repoFull);
    if (!workspaceId) return;

    // The PR's own review/fix runs also sit on this branch — never hand off to
    // those; deliver to the most recently active real session.
    const owners = matchSessions(control, workspaceId, pr.headRef)
      .filter((s) => !s.id.startsWith("bks-ghpr-"))
      .sort(
        (a, b) =>
          Date.parse(b.lastActivity || "0") - Date.parse(a.lastActivity || "0"),
      );
    const target = owners[0];
    if (!target) {
      // No live owning session — the os-auto-fix label remains the path, but
      // say so on the PR instead of silently stopping (each review posts a
      // fresh summary comment, so this lands once per review, not per sweep).
      await appendToSummary(
        pr,
        getOrInitPrState(pr.number, pr.headRef, pr.ghRepo).summaryCommentId,
        `🔁 Not merge-ready and no live session owns this branch — add the \`os-auto-fix\` label and I'll fix the findings automatically.`,
      );
      audit({
        msg: "review_handoff_no_owner",
        pr_number: pr.number,
        repo: repoFull,
        findings: review.findings,
        blocking: review.blocking,
      });
      return;
    }

    const state = getOrInitPrState(pr.number, pr.headRef, pr.ghRepo);
    const sha = state.lastReviewedSha || pr.headSha;
    const decision = handoffDecision(state.handoff, sha, MAX_ROUNDS);
    if (decision === "duplicate") return;
    if (decision === "capped") {
      await announceCap(pr);
      return;
    }

    const round = (state.handoff?.rounds || 0) + 1;
    const findingsBlock = await fetchReviewFindings(pr.number, pr.ghRepo).catch(
      () => "",
    );
    const message = buildHandoffMessage({
      prNumber: pr.number,
      title: pr.title,
      headRef: pr.headRef,
      reviewedSha: sha,
      repoFull,
      round,
      cap: MAX_ROUNDS,
      verdict: review.verdict,
      confidence: review.confidence,
      findingsBlock,
    });

    // Review findings must not steer into a person's active request. Queue the
    // handoff behind it and mark it as a phase boundary so the queue drains it
    // alone, after the user's turn has settled.
    const res = await control.deliverToSession(target.id, message, "GitHub", {
      busy: "queue",
      reviewHandoff: true,
      deliveryId: `github-handoff:${repoFull}:${pr.number}:${sha}:${round}`,
    });
    if (res.status === "error") {
      console.error(
        `[github] review handoff → ${target.id} failed for PR #${pr.number}: ${res.message}`,
      );
      return;
    }

    // Re-read here: the delivery above is a network round-trip, and a mention
    // webhook landing in that window writes to the same file.
    const delivered = updatePrState(
      pr.number,
      pr.headRef,
      (s) => {
        s.handoff = {
          rounds: round,
          lastSha: sha,
          sessionId: target.id,
          deliveredAt: new Date().toISOString(),
        };
      },
      pr.ghRepo,
    );
    audit({
      msg: "review_handoff",
      pr_number: pr.number,
      repo: repoFull,
      session_id: target.id,
      round,
      findings: review.findings,
      blocking: review.blocking,
      deliver_status: res.status,
    });
    console.log(
      `[github] review handoff → session ${target.id} for PR #${pr.number} (round ${round}/${MAX_ROUNDS}, ${res.status})`,
    );
    await appendToSummary(
      pr,
      delivered.summaryCommentId,
      `🔁 Handed ${review.findings} finding(s) to the owning session — fix round ${round}/${MAX_ROUNDS} · [open session](${uiSessionUrl(target.id)})`,
    );
  } catch (e) {
    console.error(`[github] review handoff failed for PR #${pr.number}:`, e);
  }
}

/** One-time "over to humans" notice once the round cap is hit. */
async function announceCap(pr: PrRef): Promise<void> {
  const state = readPrState(pr.number, pr.ghRepo);
  if (!state?.handoff || state.handoff.cappedAnnounced) return;
  await appendToSummary(
    pr,
    state.summaryCommentId,
    `🔁 Still not merge-ready after ${state.handoff.rounds} handed-off fix round(s) — over to humans. (The \`os-auto-fix\` label still works for another automated pass.)`,
  );
  updatePrState(
    pr.number,
    pr.headRef,
    (s) => {
      if (s.handoff) s.handoff.cappedAnnounced = true;
    },
    pr.ghRepo,
  );
}

/** Append a status line to the current review summary comment (best-effort). */
async function appendToSummary(
  pr: PrRef,
  id: number | undefined,
  line: string,
): Promise<void> {
  if (!id) return;
  try {
    const existing = await getComment(id, pr.ghRepo);
    if (!existing || existing.body.includes(line)) return;
    await editIssueComment(id, `${existing.body}\n\n${line}`, pr.ghRepo);
  } catch (e) {
    console.error(
      `[github] appending handoff note to PR #${pr.number} summary failed:`,
      e,
    );
  }
}
