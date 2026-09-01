/**
 * Reconcile sweep: the safety net under the webhook-driven review/auto-fix flow.
 *
 * The webhook path is fire-once — GitHub delivers an event, we consume it, and
 * it never redelivers. Several things can eat the work AFTER the event was
 * received: a restart kills the in-memory review debounce timer, a review dies
 * with both account pools dry (no retry until the next push), a lock race drops
 * a non-debounced trigger, or the whole delivery is missed while the server is
 * down. This sweep periodically compares desired state ("every opted-in open
 * PR's head is reviewed; every os-auto-fix-labeled PR has a fix loop") against
 * the per-PR disk state and re-fires the same paths the webhook would have.
 *
 * Deliberately conservative — it must never cause a review storm (#4913):
 *  - only PRs updated within RECONCILE_WINDOW_MS (a stall means a RECENT push
 *    got dropped; dormant PRs never qualify),
 *  - at most MAX_FIRES_PER_CYCLE fires per cycle (backlog drains gradually),
 *  - at most MAX_ATTEMPTS_PER_SHA sweep-initiated attempts per head SHA (a
 *    permanently-failing PR is given up on, not retried forever),
 *  - skips anything with a live lock, active run/loop, or pending debounce.
 * Kill switch: OPENSESSION_REVIEW_RECONCILE=0.
 */
import { configuredRepos, isGithubBotLogin } from "../../server/config";
import { isTrustedGithubLogin } from "../../server/shared/user-mappings";
import { audit } from "../../server/audit";
import { ghRateLimited } from "../../server/github-limit";
import { listOpenPrs, type OpenPrSummary } from "./github-rest";
import { LABEL_AUTOFIX, LABEL_REVIEW, labelMatches, prKey } from "./constants";
import { isLockHeld, readPrState, updatePrState } from "./state";
import { loadReviewOptions, titleHasSkipKeyword } from "./review-options";
import type { PrRef } from "./review";
import { desiredReviewOutstanding } from "./desired-review";

const RECONCILE_MS = parseInt(
  process.env.OPENSESSION_REVIEW_RECONCILE_MS || String(10 * 60 * 1000),
);
/** Only PRs updated this recently are eligible — a stall is always recent. */
const RECONCILE_WINDOW_MS = parseInt(
  process.env.OPENSESSION_REVIEW_RECONCILE_WINDOW_MS ||
    String(72 * 60 * 60 * 1000),
);
/** Hard cap on fires per cycle so a backlog can never become a review storm. */
const MAX_FIRES_PER_CYCLE = 2;
const MAX_ATTEMPTS_PER_SHA = 2;
/** First sweep waits this long after boot so startup recovery (index.ts) runs first. */
const BOOT_DELAY_MS = 3 * 60 * 1000;

export function reconcileEnabled(): boolean {
  return process.env.OPENSESSION_REVIEW_RECONCILE !== "0";
}

/** One sweep pass over every configured repo. Exported for tests/manual runs. */
export async function reconcileOpenPrs(): Promise<void> {
  if (!reconcileEnabled() || ghRateLimited("rest")) return;
  const { resolveReviewConfig, fireReview, fireAutoFix } =
    await import("./webhook");
  const { autoEnabled } = resolveReviewConfig();
  let fires = 0;

  for (const repo of Object.values(configuredRepos())) {
    if (!repo.ghRepo) continue;
    if (fires >= MAX_FIRES_PER_CYCLE) break;
    const prs = await listOpenPrs(repo.ghRepo).catch(
      () => [] as OpenPrSummary[],
    );
    const repoOpts = loadReviewOptions(repo.repo);
    for (const pr of prs) {
      if (fires >= MAX_FIRES_PER_CYCLE) break;
      if (titleHasSkipKeyword(pr.title, repoOpts)) continue;
      // The list is updated-desc; past the window means everything after is too.
      const updatedAt = Date.parse(pr.updatedAt || "");
      if (!updatedAt || Date.now() - updatedAt > RECONCILE_WINDOW_MS) break;
      if (pr.draft) continue;
      const externalFork =
        !!pr.headRepoFullName &&
        pr.headRepoFullName.toLowerCase() !== repo.ghRepo.toLowerCase();

      const state = readPrState(pr.number, repo.ghRepo);
      // Anything in flight (or already scheduled) owns this PR — never race it.
      const busy =
        isLockHeld("review", pr.number, repo.ghRepo) ||
        isLockHeld("code", pr.number, repo.ghRepo) ||
        desiredReviewOutstanding(state) ||
        !!state?.activeRun ||
        !!state?.activeMention ||
        !!state?.autoFix?.active;
      if (busy) continue;

      const ref: PrRef = {
        number: pr.number,
        headRef: pr.headRef,
        headSha: pr.headSha,
        title: pr.title,
        ...(prKey(pr.number, repo.ghRepo) !== String(pr.number)
          ? { ghRepo: repo.ghRepo }
          : {}),
      };

      // ── Auto-fix reconcile: label still on, no loop running ──
      // Covers a transient failure only when the persisted requester still
      // resolves to this instance's team. A label with no trusted receipt is
      // not enough: on a public repo it may have been applied outside Open
      // Session's trust roster while this process was down.
      if (
        !externalFork &&
        pr.labels.some((l) => labelMatches(l, LABEL_AUTOFIX))
      ) {
        const requestedBy =
          state?.pendingAutoFix?.requestedBy ||
          state?.autoFix?.requestedBy ||
          "";
        if (!isTrustedGithubLogin(requestedBy)) continue;
        const attempts =
          state?.reconcile?.autofixSha === pr.headSha
            ? state.reconcile.autofixAttempts || 0
            : 0;
        if (attempts >= MAX_ATTEMPTS_PER_SHA) continue;
        updatePrState(
          pr.number,
          pr.headRef,
          (s) => {
            s.reconcile = {
              ...s.reconcile,
              autofixSha: pr.headSha,
              autofixAttempts: attempts + 1,
            };
          },
          ref.ghRepo,
        );
        fires++;
        audit({
          msg: "review_reconcile",
          kind: "autofix",
          pr_number: pr.number,
          repo: repo.ghRepo,
          sha: pr.headSha,
          attempt: attempts + 1,
        });
        console.log(
          `[github] reconcile: re-firing auto-fix for PR #${pr.number} @ ${pr.headSha.slice(0, 7)} (attempt ${attempts + 1}/${MAX_ATTEMPTS_PER_SHA})`,
        );
        void fireAutoFix(ref, requestedBy);
        continue;
      }

      // ── Review reconcile: opted in, head SHA never successfully reviewed ──
      // Same-repository review recovery remains roster-gated. External forks
      // are admitted only to runReview's isolated, read-only public path.
      if (
        !externalFork &&
        !isGithubBotLogin(pr.authorLogin) &&
        !isTrustedGithubLogin(pr.authorLogin)
      )
        continue;
      const optedIn =
        autoEnabled || pr.labels.some((l) => labelMatches(l, LABEL_REVIEW));
      if (!optedIn || !pr.headSha) continue;
      if (state?.reviewedShas?.includes(pr.headSha)) continue;
      // `updated_at` bumps on comments/labels too, so recency alone would walk
      // the sweep through every old open PR that gets any activity (seen live
      // 2026-07-25: #4227/#4643 fired off comment bumps). Only two shapes are
      // genuine drops: we reviewed this PR before and a NEW head appeared (a
      // push we lost), or the PR itself is newly created (an `opened` event we
      // missed). Old never-reviewed PRs keep the label-only path.
      const reviewedBefore = (state?.reviewedShas?.length || 0) > 0;
      const createdAt = Date.parse(pr.createdAt || "");
      const createdRecently =
        createdAt && Date.now() - createdAt <= RECONCILE_WINDOW_MS;
      if (!reviewedBefore && !createdRecently) continue;
      const attempts =
        state?.reconcile?.reviewSha === pr.headSha
          ? state.reconcile.reviewAttempts || 0
          : 0;
      if (attempts >= MAX_ATTEMPTS_PER_SHA) continue;
      updatePrState(
        pr.number,
        pr.headRef,
        (s) => {
          s.reconcile = {
            ...s.reconcile,
            reviewSha: pr.headSha,
            reviewAttempts: attempts + 1,
          };
        },
        ref.ghRepo,
      );
      fires++;
      audit({
        msg: "review_reconcile",
        kind: "review",
        pr_number: pr.number,
        repo: repo.ghRepo,
        sha: pr.headSha,
        attempt: attempts + 1,
      });
      console.log(
        `[github] reconcile: firing missed review for PR #${pr.number} @ ${pr.headSha.slice(0, 7)} (attempt ${attempts + 1}/${MAX_ATTEMPTS_PER_SHA})`,
      );
      void fireReview(ref, false);
    }
  }
}

/** Start the periodic sweep. Parked on globalThis so `--hot` reloads don't
 *  double-arm; runner-adjacent, so a code change here needs a real restart. */
export function startReconcileSweep(): void {
  if (!reconcileEnabled()) {
    console.log(
      "[github] reconcile sweep disabled (OPENSESSION_REVIEW_RECONCILE=0)",
    );
    return;
  }
  const g = globalThis as any;
  if (g.__githubReconcileTimer) return;
  g.__githubReconcileTimer = setTimeout(function tick() {
    reconcileOpenPrs()
      .catch((e) => console.error("[github] reconcile sweep failed:", e))
      .finally(() => {
        g.__githubReconcileTimer = setTimeout(tick, RECONCILE_MS);
      });
  }, BOOT_DELAY_MS);
  console.log(
    `[github] reconcile sweep armed (every ${Math.round(RECONCILE_MS / 60000)}m, window ${Math.round(RECONCILE_WINDOW_MS / 3600000)}h, ≤${MAX_FIRES_PER_CYCLE} fires/cycle)`,
  );
}
