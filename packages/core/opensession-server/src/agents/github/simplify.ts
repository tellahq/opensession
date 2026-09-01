/**
 * Behavior 3: the `os-simplify` label. One `/simplify` pass on the PR's changes in a
 * PR-branch worktree, push, post a summary, then re-run the review on the result.
 * Removes the label when done.
 */
import { personaName } from "../../server/config";
import { getPrDetails, getPrDiff } from "../../server/pr-info";
import { createWorktreeForPrBranch } from "../../server/worktree";
import { claimLock, releaseLock, readPrState, updatePrState } from "./state";
import {
  announceGithubRun,
  runGithubAgent,
  authorForLogin,
  finalSummary,
  sessionUrl,
} from "./run";
import { buildSimplifyPrompt } from "./prompts";
import { postOrEditComment, removeLabel, SIMPLIFY_MARKER } from "./github-rest";
import { LABEL_SIMPLIFY, labelAliases, repoForFullName } from "./constants";
import { runReview, type PrRef } from "./review";
import { resolveReviewConfig } from "./webhook";

export async function runSimplify(
  pr: PrRef,
  requestedBy: string,
  onSessionCreated?: (bksId: string) => void,
  steer?: string,
): Promise<void> {
  if (!claimLock("code", pr.number, pr.ghRepo)) {
    console.log(
      `[github] a code action (fix/simplify) is already running for PR #${pr.number}, skipping simplify`,
    );
    return;
  }
  const author = authorForLogin(requestedBy);
  try {
    // By number, not branch — by-branch lookups lag for fresh PRs (see runReview).
    const details = await getPrDetails(
      pr.number ? String(pr.number) : pr.headRef,
      pr.ghRepo || undefined,
    );
    if (!details) {
      console.warn(
        `[github] no PR details for #${pr.number} (${pr.headRef}); skipping simplify`,
      );
      return;
    }
    if (details.state !== "OPEN") return;

    const startedAt = new Date().toISOString();
    const link = `[📺 open session](${sessionUrl(pr.number, "simplify", pr.ghRepo)})`;
    const title = `Simplify · PR #${pr.number} ${details.title}`.slice(0, 100);
    const bksId = await announceGithubRun({
      prNumber: pr.number,
      ghRepo: pr.ghRepo,
      kind: "simplify",
      branch: pr.headRef,
      title,
      mode: "code",
    });
    onSessionCreated?.(bksId);

    const prior = readPrState(pr.number, pr.ghRepo);
    // Reuse this run's comment only when recovering an interrupted run; a fresh
    // trigger (no activeRun) posts a new comment.
    const reuseId =
      prior?.activeRun?.kind === "simplify"
        ? prior.activeRun.progressCommentId
        : undefined;
    const progressId = await postOrEditComment(
      pr.number,
      reuseId,
      `${SIMPLIFY_MARKER}\n✨ **${personaName()} simplify** — working on PR #${pr.number}… · ${link}`,
      pr.ghRepo,
    );
    updatePrState(
      pr.number,
      pr.headRef,
      (s) => {
        s.activeRun = {
          kind: "simplify",
          requestedBy,
          startedAt,
          progressCommentId: progressId ?? undefined,
          steer,
        };
      },
      pr.ghRepo,
    );

    const worktreeDir = await createWorktreeForPrBranch(
      pr.headRef,
      pr.ghRepo ? repoForFullName(pr.ghRepo)?.id : undefined,
    );
    console.log(`[github] Simplifying PR #${pr.number}`);

    const result = await runGithubAgent({
      prNumber: pr.number,
      ghRepo: pr.ghRepo,
      kind: "simplify",
      prompt: buildSimplifyPrompt(details, steer),
      cwd: worktreeDir,
      mode: "code",
      branch: pr.headRef,
      title,
      author,
    });

    const summary = finalSummary(result.text).slice(0, 2000) || "Done.";
    await postOrEditComment(
      pr.number,
      progressId ?? undefined,
      `${SIMPLIFY_MARKER}\n✨ **${personaName()} simplify** — ${result.error ? `errored: ${result.error}` : summary} · ${link}`,
      pr.ghRepo,
    );

    updatePrState(
      pr.number,
      pr.headRef,
      (s) => {
        if (s.activeRun?.kind === "simplify") s.activeRun = undefined;
      },
      pr.ghRepo,
    );

    // Re-review the simplified result (per the "simplify then re-review" decision).
    if (!result.error) {
      const fresh = await getPrDetails(pr.headRef, pr.ghRepo || undefined);
      const diff = await getPrDiff(pr.headRef, pr.ghRepo || undefined);
      const ref: PrRef = {
        number: pr.number,
        headRef: pr.headRef,
        headSha: diff?.headRefOid || pr.headSha,
        title: fresh?.title || pr.title,
        ...(pr.ghRepo ? { ghRepo: pr.ghRepo } : {}),
      };
      await runReview(
        ref,
        resolveReviewConfig().config,
        onSessionCreated,
      ).catch((e) =>
        console.error(
          `[github] post-simplify review failed for PR #${pr.number}:`,
          e,
        ),
      );
    }
  } catch (e) {
    console.error(`[github] simplify error for PR #${pr.number}:`, e);
  } finally {
    // Clear the recovery flag on any completion (success/handled error). If the
    // process is KILLED mid-run, finally doesn't run → activeRun persists → the
    // github agent re-runs it on startup.
    // Kind-scoped: the re-review above may own activeRun by now, and clearing
    // its marker would lose that run's crash recovery.
    updatePrState(
      pr.number,
      pr.headRef,
      (s) => {
        if (s.activeRun?.kind === "simplify") s.activeRun = undefined;
      },
      pr.ghRepo,
    );
    for (const name of labelAliases(LABEL_SIMPLIFY)) {
      await removeLabel(pr.number, name, pr.ghRepo).catch(() => {});
    }
    releaseLock("code", pr.number, pr.ghRepo);
  }
}
