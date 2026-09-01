/**
 * Behavior: the `os-adversarial` label. Runs the repo's adversarial-code-review
 * skill (two independent hostile review passes, adjudicated) in code mode, with
 * the agent responsible for implementing the accepted findings, then pushes any
 * resulting changes to the PR branch and posts a summary. One-shot.
 */
import { personaName } from "../../server/config";
import { getPrDetails } from "../../server/pr-info";
import { createWorktreeForPrBranch } from "../../server/worktree";
import {
  claimLock,
  releaseLock,
  readPrState,
  updatePrState,
  clearActiveRun,
} from "./state";
import {
  announceGithubRun,
  runGithubAgent,
  authorForLogin,
  finalSummary,
  sessionUrl,
} from "./run";
import { buildAdversarialPrompt } from "./prompts";
import {
  postOrEditComment,
  removeLabel,
  ADVERSARIAL_MARKER,
} from "./github-rest";
import { LABEL_ADVERSARIAL, labelAliases, repoForFullName } from "./constants";
import type { PrRef } from "./review";

export async function runAdversarial(
  pr: PrRef,
  requestedBy: string,
  onSessionCreated?: (bksId: string) => void,
  steer?: string,
): Promise<void> {
  if (!claimLock("code", pr.number, pr.ghRepo)) {
    console.log(
      `[github] a code action is already running for PR #${pr.number}, skipping adversarial`,
    );
    return;
  }
  const author = authorForLogin(requestedBy);
  try {
    const details = await getPrDetails(pr.headRef, pr.ghRepo || undefined);
    if (!details) {
      console.warn(
        `[github] no PR details for ${pr.headRef}; skipping adversarial`,
      );
      return;
    }
    if (details.state !== "OPEN") return;

    const startedAt = new Date().toISOString();
    const link = `[📺 open session](${sessionUrl(pr.number, "adversarial", pr.ghRepo)})`;
    const title = `Adversarial · PR #${pr.number} ${details.title}`.slice(
      0,
      100,
    );
    const bksId = await announceGithubRun({
      prNumber: pr.number,
      ghRepo: pr.ghRepo,
      kind: "adversarial",
      branch: details.headRefName,
      title,
      mode: "code",
    });
    onSessionCreated?.(bksId);

    const prior = readPrState(pr.number, pr.ghRepo);
    const reuseId =
      prior?.activeRun?.kind === "adversarial"
        ? prior.activeRun.progressCommentId
        : undefined;
    const progressId = await postOrEditComment(
      pr.number,
      reuseId,
      `${ADVERSARIAL_MARKER}\n🔍 **${personaName()} adversarial review** — running two independent review passes on PR #${pr.number}… · ${link}`,
      pr.ghRepo,
    );
    updatePrState(
      pr.number,
      details.headRefName,
      (s) => {
        s.activeRun = {
          kind: "adversarial",
          requestedBy,
          startedAt,
          progressCommentId: progressId ?? undefined,
          steer,
        };
      },
      pr.ghRepo,
    );

    const worktreeDir = await createWorktreeForPrBranch(
      details.headRefName,
      pr.ghRepo ? repoForFullName(pr.ghRepo)?.id : undefined,
    );
    console.log(`[github] Adversarial review on PR #${pr.number}`);

    const result = await runGithubAgent({
      prNumber: pr.number,
      ghRepo: pr.ghRepo,
      kind: "adversarial",
      prompt: buildAdversarialPrompt(details, steer),
      cwd: worktreeDir,
      mode: "code",
      branch: details.headRefName,
      title,
      author,
    });

    const summary = finalSummary(result.text).slice(0, 6000) || "Done.";
    await postOrEditComment(
      pr.number,
      progressId ?? undefined,
      `${ADVERSARIAL_MARKER}\n🔍 **${personaName()} adversarial review** — ${result.error ? `errored: ${result.error}` : summary} · ${link}`,
      pr.ghRepo,
    );
  } catch (e) {
    console.error(`[github] adversarial error for PR #${pr.number}:`, e);
  } finally {
    // Clear the recovery flag on completion; a killed process leaves it set so the
    // github agent re-runs it on startup.
    clearActiveRun(pr.number, pr.headRef, "adversarial", pr.ghRepo);
    for (const name of labelAliases(LABEL_ADVERSARIAL)) {
      await removeLabel(pr.number, name, pr.ghRepo).catch(() => {});
    }
    releaseLock("code", pr.number, pr.ghRepo);
  }
}
