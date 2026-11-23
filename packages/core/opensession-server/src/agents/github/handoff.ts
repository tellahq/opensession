/**
 * Review → owning-session handoff. When an automatic PR review finishes
 * unsatisfied (blocking findings, or open findings at low confidence), the
 * findings are delivered straight into the live Open Session session that owns
 * the PR (named in its attribution footer, else working on its branch) — the agent that wrote the code fixes it with full context,
 * no `os-auto-fix` label needed. Its push re-triggers the normal review cycle,
 * closing the loop. A review that passes with non-blocking findings still open
 * sends that session one notice for the reviewed commit, without a fix round.
 * Once the round cap is reached, the session gets the final review's open
 * findings with its wrap-up, and each later reviewed push still reports its
 * findings once, as information rather than another fix round.
 *
 * Bounds: SHA dedup + a per-PR round cap (state.handoff), a TTL on the active
 * window, and the shared "code" lock — a running label auto-fix/simplify wins
 * and suppresses the handoff. PRs with no live owning session keep today's
 * label-driven flow, so the agent never pushes to a human's branch uninvited.
 * Kill switch: OPENSESSION_REVIEW_HANDOFF=0.
 */
import {
  configuredRepos,
  defaultRepo,
  getConfigAsync,
} from "../../server/config";
import { audit } from "../../server/audit";
import {
  getPrsByRepo,
  sessionRefFromPrBody,
  trustedPrSessionId,
  type PrInfo,
} from "../../server/pr-cache";
import { getPrAutomationDetails } from "../../server/pr-info";
import { tryGetSessionControl } from "../../server/session-control";
import type { UnifiedSession } from "../../server/types";
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
  openFindingsCount,
  openFindingsNoticeNeeded,
  type HandoffState,
  pickHandoffOwner,
  reviewSatisfied,
} from "./handoff-gates";
import { canFixOwnPr } from "./pr-conflict";
import {
  buildHandoffMessage,
  buildOpenFindingsMessage,
  buildPostCapFindingsMessage,
  buildReviewSettledMessage,
  type ReviewSettledOutcome,
} from "./prompts";
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
 * Probe for webhook.ts: is a fix round in flight for this PR? Bot-authored
 * pushes during a round are the fixes themselves and must still be re-reviewed
 * (the webhook normally skips bot `synchronize` events).
 */
export async function isHandoffActive(
  prNumber: number,
  ghRepo?: string,
): Promise<boolean> {
  if (!handoffEnabled()) return false;
  return handoffActive(
    (await readPrState(prNumber, ghRepo))?.handoff,
    Date.now(),
    ACTIVE_TTL_MS,
  );
}

/** Drop round tracking (PR closed, or a review came back satisfied). */
export async function clearHandoff(
  prNumber: number,
  ghRepo?: string,
): Promise<void> {
  const s = await readPrState(prNumber, ghRepo);
  if (!s?.handoff) return;
  await updatePrState(
    prNumber,
    s.headRef,
    (st) => {
      st.handoff = undefined;
    },
    ghRepo,
  );
}

export interface HandoffOwnerDeps {
  /** The bulk PR cache row for `headRef`, if any. */
  cachedPr(workspaceId: string, headRef: string): PrInfo | undefined;
  /** The session the PR's trusted attribution footer names, read from GitHub. */
  footerSessionRef(
    prNumber: number,
    ghRepo?: string,
  ): Promise<string | undefined>;
  getSession(id: string): (UnifiedSession & { state?: string }) | undefined;
  branchOwners(workspaceId: string, headRef: string): Promise<UnifiedSession[]>;
}

const defaultOwnerDeps: HandoffOwnerDeps = {
  cachedPr: (workspaceId, headRef) =>
    getPrsByRepo().get(workspaceId)?.get(headRef),
  footerSessionRef: async (prNumber, ghRepo) => {
    const pr = await getPrAutomationDetails(String(prNumber), ghRepo);
    if (!pr) return undefined;
    return trustedPrSessionId({
      author: pr.author,
      sessionRef: sessionRefFromPrBody(pr.body),
    });
  },
  getSession: (id) => tryGetSessionControl()?.getSession(id),
  branchOwners: async (workspaceId, headRef) =>
    await matchSessions(workspaceId, headRef, { order: "activity" }),
};
/**
 * The session a review's findings go to. The session named in the PR footer
 * opened the PR, so it owns it whichever branch its checkout is on now, and
 * even when an automation started it. A session can open several PRs from one
 * worktree, so its current branch alone misses most of them. A PR opened
 * moments ago may not be in the bulk cache yet, so the footer is read from
 * GitHub then. Otherwise the session working on the branch: one with the
 * branch checked out wins over one that only linked the PR.
 */
export async function resolveHandoffOwner(
  pr: Pick<PrRef, "number" | "headRef" | "ghRepo">,
  workspaceId: string,
  deps: HandoffOwnerDeps = defaultOwnerDeps,
): Promise<UnifiedSession | undefined> {
  const cached = deps.cachedPr(workspaceId, pr.headRef);
  const sessionRef =
    cached?.number === pr.number
      ? cached.sessionRef
      : await deps
          .footerSessionRef(pr.number, pr.ghRepo)
          .catch(() => undefined);
  // The PR's own review/fix runs also sit on this branch; never hand off to
  // those.
  const owners = (await deps.branchOwners(workspaceId, pr.headRef)).filter(
    (s) => !s.id.startsWith("bks-ghpr-"),
  );
  return pickHandoffOwner(
    sessionRef ? deps.getSession(sessionRef) : undefined,
    canFixOwnPr,
    owners,
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
      const prior = (await readPrState(pr.number, pr.ghRepo))?.handoff;
      // The cap stands until the PR closes: a pass after it neither clears
      // the rounds nor goes only to the round session. The current owner
      // hears it once per commit, with any findings it left open. Judged by
      // the round count, not cappedAnnounced: that is set only once a capped
      // wrap-up is delivered, and a failed delivery must not reopen the cap.
      if ((prior?.rounds || 0) >= MAX_ROUNDS) {
        await passedAfterCap(pr, review);
        return;
      }
      await settlePassedReview({
        settle: () => settleHandoff(pr, review, "passed"),
        noticeNeeded: (settled) =>
          openFindingsNoticeNeeded(review, prior, settled),
        notify: () => notifyOpenFindings(pr, review),
        clear: () => clearHandoff(pr.number, pr.ghRepo),
      });
      return;
    }
    // A fixer (label auto-fix / simplify / mention reply) already owns the
    // branch worktree — auto-fix runs its own review-gated loop.
    if (isLockHeld("code", pr.number, pr.ghRepo)) return;

    const control = tryGetSessionControl();
    if (!control) return;
    const repoFull =
      pr.ghRepo || defaultRepo(configuredRepos(await getConfigAsync())).ghRepo;
    const workspaceId = await workspaceIdForRepo(repoFull);
    if (!workspaceId) return;

    const target = await resolveHandoffOwner(pr, workspaceId);
    if (!target) {
      // No live owning session — the os-auto-fix label remains the path, but
      // say so on the PR instead of silently stopping (each review posts a
      // fresh summary comment, so this lands once per review, not per sweep).
      await appendToSummary(
        pr,
        (await getOrInitPrState(pr.number, pr.headRef, pr.ghRepo))
          .summaryCommentId,
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

    const state = await getOrInitPrState(pr.number, pr.headRef, pr.ghRepo);
    const sha = state.lastReviewedSha || pr.headSha;
    const decision = handoffDecision(state.handoff, sha, MAX_ROUNDS);
    if (decision === "duplicate") return;
    if (decision === "capped" || decision === "post-cap") {
      await afterCap(pr, review, decision, sha, repoFull, target.id, false);
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
    const delivered = await updatePrState(
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
      `🔁 ${review.findings} finding${review.findings === 1 ? "" : "s"} → [owning session](${uiSessionUrl(target.id)}) · fix round ${round}/${MAX_ROUNDS}`,
    );
  } catch (e) {
    console.error(`[github] review handoff failed for PR #${pr.number}:`, e);
  }
}

export interface PassedReviewDeps {
  /** Send the passed wrap-up to the round session; whether it went out. */
  settle(): Promise<boolean>;
  noticeNeeded(settled: boolean): boolean;
  /** Send the open-findings notice; false only when a delivery failed. */
  notify(): Promise<boolean>;
  /** Drop the round state. */
  clear(): Promise<void>;
}

/**
 * A review passed below the cap. A delivered wrap-up carries the open
 * findings; when none went out (no rounds, or the round session is gone), the
 * owner gets the notice. The round state is dropped only once one of them got
 * through or nothing was owed, so a failed fallback stays eligible on the next
 * review of the same commit instead of losing the earlier rounds' threads.
 */
export async function settlePassedReview(
  deps: PassedReviewDeps,
): Promise<void> {
  const settled = await deps.settle();
  if (deps.noticeNeeded(settled) && !(await deps.notify())) return;
  await deps.clear();
}

/**
 * Tell the owning session about findings a passing review left open. Not a fix
 * round: no round state, no bot-push re-review carve-out, no round cap. One
 * delivery per reviewed commit. PRs with no live owner get nothing extra, since
 * nothing blocks them. Returns false only when a delivery was attempted and
 * failed (or session control is down), so the caller can retry later. Never
 * throws past the caller's guard.
 */
async function notifyOpenFindings(
  pr: PrRef,
  review: ReviewResult,
): Promise<boolean> {
  // A fixer already owns the branch worktree and will see the same comments.
  if (isLockHeld("code", pr.number, pr.ghRepo)) return true;
  const control = tryGetSessionControl();
  if (!control) return false;
  const repoFull =
    pr.ghRepo || defaultRepo(configuredRepos(await getConfigAsync())).ghRepo;
  const workspaceId = await workspaceIdForRepo(repoFull);
  if (!workspaceId) return true;
  const target = await resolveHandoffOwner(pr, workspaceId);
  if (!target) return true;

  const state = await getOrInitPrState(pr.number, pr.headRef, pr.ghRepo);
  const sha = state.lastReviewedSha || pr.headSha;
  const findingsBlock = await fetchReviewFindings(pr.number, pr.ghRepo).catch(
    () => "",
  );
  // A pass that filed nothing new is reported only for threads still open.
  const findings = openFindingsCount(review.findings, findingsBlock);
  if (!findings) return true;
  const message = buildOpenFindingsMessage({
    prNumber: pr.number,
    title: pr.title,
    headRef: pr.headRef,
    reviewedSha: sha,
    repoFull,
    findings,
    confidence: review.confidence,
    findingsBlock,
  });
  const res = await control.deliverToSession(target.id, message, "GitHub", {
    busy: "queue",
    reviewHandoff: true,
    deliveryId: `github-review-open-findings:${repoFull}:${pr.number}:${sha}`,
  });
  if (res.status === "error") {
    console.error(
      `[github] open findings → ${target.id} failed for PR #${pr.number}: ${res.message}`,
    );
    return false;
  }
  audit({
    msg: "review_open_findings_handoff",
    pr_number: pr.number,
    repo: repoFull,
    session_id: target.id,
    findings,
    deliver_status: res.status,
  });
  // No session link: the owner may be a branch match the PR never named, and
  // the summary comment can be public.
  await appendToSummary(
    pr,
    state.summaryCommentId,
    `💬 ${findings} non-blocking finding${findings === 1 ? "" : "s"} → owning session`,
  );
  return true;
}

/**
 * Close the loop in the session that did the fix rounds. The verdict lives on
 * the PR, so without this the session's last word is its report on the final
 * round and a person returning to the thread has to work out whether the PR
 * is done. Asks that session for one wrap-up; a PR that never had a round
 * handed off has no loop to close. Returns whether the wrap-up went out.
 * Never throws past the caller's guard.
 */
async function settleHandoff(
  pr: PrRef,
  review: ReviewResult,
  outcome: ReviewSettledOutcome,
): Promise<boolean> {
  const state = await readPrState(pr.number, pr.ghRepo);
  const handoff = state?.handoff;
  if (!handoff?.rounds || !handoff.sessionId) return false;
  const control = tryGetSessionControl();
  // A deleted round session cannot take the wrap-up.
  if (!control?.getSession(handoff.sessionId)) return false;
  const repoFull =
    pr.ghRepo || defaultRepo(configuredRepos(await getConfigAsync())).ghRepo;
  const sha = state?.lastReviewedSha || pr.headSha;
  // A review can pass with findings open: its own non-blocking ones, or an
  // earlier trusted thread it did not repeat (review.findings counts only its
  // own output). The fix-round session gets no separate notice for them
  // (openFindingsNoticeNeeded), so the wrap-up carries every unresolved thread.
  const findingsBlock = await fetchReviewFindings(pr.number, pr.ghRepo).catch(
    () => "",
  );
  const message = buildReviewSettledMessage({
    prNumber: pr.number,
    title: pr.title,
    headRef: pr.headRef,
    repoFull,
    rounds: handoff.rounds,
    outcome,
    confidence: review.confidence,
    findingsBlock,
  });
  // Same lane as the rounds themselves: behind any active human turn, alone.
  const res = await control.deliverToSession(
    handoff.sessionId,
    message,
    "GitHub",
    {
      busy: "queue",
      reviewHandoff: true,
      deliveryId: `github-review-settled:${repoFull}:${pr.number}:${outcome}:${sha}`,
    },
  );
  if (res.status === "error") {
    console.error(
      `[github] review settle → ${handoff.sessionId} failed for PR #${pr.number}: ${res.message}`,
    );
    return false;
  }
  audit({
    msg: "review_settled",
    pr_number: pr.number,
    repo: repoFull,
    session_id: handoff.sessionId,
    outcome,
    rounds: handoff.rounds,
    deliver_status: res.status,
  });
  console.log(
    `[github] review settled (${outcome}) → session ${handoff.sessionId} for PR #${pr.number} after ${handoff.rounds} round(s), ${res.status}`,
  );
  return true;
}

export interface CapFollowUpDeps {
  fetchFindings(): Promise<string>;
  /** Does this session still exist to receive a message? */
  sessionExists(sessionId: string): boolean;
  deliver(
    sessionId: string,
    message: string,
    deliveryId: string,
  ): Promise<{ status: string; message?: string }>;
  /** Record that `sha`'s findings reached the session after the cap. */
  recordCapped(sha: string): Promise<void>;
}

/**
 * Tell the session about a review once the round cap is reached. `capped` is
 * the wrap-up for the round that hit the cap; `post-cap` is a later push's
 * review, which starts no fix round: a findings notice, or a passed wrap-up
 * when that review passed. Each carries the review's open findings, so the
 * session can say what is left or fix it when a person asks.
 * Records the commit only after a successful delivery, so a failed one is
 * retried by the next review of the same commit. Returns the recipient, or
 * undefined when nothing was delivered.
 */
export async function deliverCapFollowUp(
  input: {
    pr: Pick<PrRef, "number" | "title" | "headRef">;
    review: Pick<ReviewResult, "verdict" | "confidence" | "findings">;
    decision: "capped" | "post-cap";
    /** The review passed (only after the cap, when the rounds stay). */
    passed?: boolean;
    sha: string;
    repoFull: string;
    handoff: HandoffState;
    ownerId: string;
  },
  deps: CapFollowUpDeps,
): Promise<string | undefined> {
  const { pr, review, decision, sha, repoFull, handoff } = input;
  const passed = decision === "post-cap" && !!input.passed;
  // Always read the threads: a pass with no findings of its own can still
  // leave an earlier trusted thread unresolved.
  const findingsBlock = await deps.fetchFindings().catch(() => "");
  const common = {
    prNumber: pr.number,
    title: pr.title,
    headRef: pr.headRef,
    repoFull,
    rounds: handoff.rounds,
    confidence: review.confidence,
    findingsBlock,
  };
  // The wrap-up closes the loop in the session that did the rounds, while it
  // still exists; a later notice goes to whoever owns the PR now. A deleted
  // round session would fail every delivery and so never record the cap.
  const recipient =
    decision === "capped" &&
    handoff.sessionId &&
    deps.sessionExists(handoff.sessionId)
      ? handoff.sessionId
      : input.ownerId;
  const message =
    decision === "capped"
      ? buildReviewSettledMessage({ ...common, outcome: "capped" })
      : passed
        ? buildReviewSettledMessage({ ...common, outcome: "passed" })
        : buildPostCapFindingsMessage({
            ...common,
            reviewedSha: sha,
            verdict: review.verdict,
          });
  const deliveryId =
    decision === "capped"
      ? `github-review-settled:${repoFull}:${pr.number}:capped:${sha}`
      : passed
        ? `github-review-settled:${repoFull}:${pr.number}:passed:${sha}`
        : `github-review-post-cap:${repoFull}:${pr.number}:${sha}`;
  const res = await deps.deliver(recipient, message, deliveryId);
  if (res.status === "error") {
    console.error(
      `[github] review ${decision} → ${recipient} failed for PR #${pr.number}: ${res.message}`,
    );
    return undefined;
  }
  await deps.recordCapped(sha);
  return recipient;
}

/**
 * A passing review of a PR whose fix rounds hit the cap: the same per-commit
 * follow-up as a failing one, to the current owner, leaving the cap in place.
 */
async function passedAfterCap(pr: PrRef, review: ReviewResult): Promise<void> {
  // A fixer already owns the branch worktree and will see the same comments.
  if (isLockHeld("code", pr.number, pr.ghRepo)) return;
  if (!tryGetSessionControl()) return;
  const repoFull =
    pr.ghRepo || defaultRepo(configuredRepos(await getConfigAsync())).ghRepo;
  const workspaceId = await workspaceIdForRepo(repoFull);
  if (!workspaceId) return;
  const target = await resolveHandoffOwner(pr, workspaceId);
  if (!target) return;
  const state = await getOrInitPrState(pr.number, pr.headRef, pr.ghRepo);
  const sha = state.lastReviewedSha || pr.headSha;
  // "capped" here means the capped wrap-up never got through; this pass
  // stands in for it and records the cap.
  if (handoffDecision(state.handoff, sha, MAX_ROUNDS) === "duplicate") return;
  await afterCap(pr, review, "post-cap", sha, repoFull, target.id, true);
}

async function afterCap(
  pr: PrRef,
  review: ReviewResult,
  decision: "capped" | "post-cap",
  sha: string,
  repoFull: string,
  ownerId: string,
  passed: boolean,
): Promise<void> {
  const state = await readPrState(pr.number, pr.ghRepo);
  if (!state?.handoff) return;
  const control = tryGetSessionControl();
  if (!control) return;
  const recipient = await deliverCapFollowUp(
    {
      pr,
      review,
      decision,
      passed,
      sha,
      repoFull,
      handoff: state.handoff,
      ownerId,
    },
    {
      fetchFindings: () => fetchReviewFindings(pr.number, pr.ghRepo),
      sessionExists: (id) => !!control.getSession(id),
      // Same lane as the rounds themselves: behind any active human turn, alone.
      deliver: (sessionId, message, deliveryId) =>
        control.deliverToSession(sessionId, message, "GitHub", {
          busy: "queue",
          reviewHandoff: true,
          deliveryId,
        }),
      recordCapped: async (reviewed) => {
        await updatePrState(
          pr.number,
          pr.headRef,
          (s) => {
            if (!s.handoff) return;
            s.handoff.cappedAnnounced = true;
            s.handoff.cappedSha = reviewed;
          },
          pr.ghRepo,
        );
      },
    },
  );
  if (!recipient) return;
  audit({
    msg:
      decision === "capped" || passed
        ? "review_settled"
        : "review_post_cap_findings",
    pr_number: pr.number,
    repo: repoFull,
    session_id: recipient,
    outcome: passed ? "passed-after-cap" : decision,
    rounds: state.handoff.rounds,
    findings: review.findings,
    blocking: review.blocking,
  });
  if (passed && review.findings === 0) return;
  // No session link after the cap: the recipient may be a branch match the PR
  // never named, so its URL is not for a possibly public PR.
  await appendToSummary(
    pr,
    state.summaryCommentId,
    decision === "capped"
      ? `🔁 Still not merge-ready after ${state.handoff.rounds} handed-off fix round(s) — over to humans. (The \`os-auto-fix\` label still works for another automated pass.)`
      : passed
        ? `💬 ${review.findings} non-blocking finding${review.findings === 1 ? "" : "s"} → owning session`
        : `📋 ${review.findings} finding${review.findings === 1 ? "" : "s"} → owning session · no fix round after the cap`,
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
