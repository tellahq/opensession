/**
 * Behavior 1: PR review. Runs an ask-mode agent that reads the diff and emits
 * structured findings. The module posts a fresh summary comment per review (the
 * previous one collapses under an "Outdated review" <details>) plus a formal GitHub
 * review carrying inline comments (GitHub auto-outdates stale ones across commits).
 * Deduped on head SHA so the same commit isn't reviewed twice.
 */
import { isGithubBotLogin, personaName } from "../../server/config";
import { isShuttingDown } from "../../server/shutdown-state";
import {
  getPrAutomationDetails,
  getPrDiff,
  type PrAutomationDetails,
} from "../../server/pr-info";
import {
  activeRunCancellationRequested,
  claimLock,
  releaseLock,
  getOrInitPrState,
  updatePrState,
  recordReviewed,
  clearActiveRun,
} from "./state";
import {
  announceGithubRun,
  bksIdFor,
  discardRecoverableGithubRun,
  GithubRunRecoveryUncertainError,
  runGithubAgent,
  sessionUrl,
  type GithubRunResult,
} from "./run";
import { buildReviewPrompt, DEFAULT_REVIEW_PROMPT } from "./prompts";
import {
  getComment,
  postIssueComment,
  postOrEditComment,
  editIssueComment,
  supersedeReviewComment,
  findActiveReviewComment,
  findReviewProgressComment,
  isReviewProgressForHead,
  submitReview,
  listReviewThreads,
  resolveReviewThread,
  REVIEW_MARKER,
  type ReviewInlineComment,
} from "./github-rest";
import { defaultRepo } from "../../server/config";
import { audit } from "../../server/audit";
import { modelLabel } from "../../server/models";
import { createReviewWorktreeForPrHead } from "../../server/worktree";
import { inverseReviewModel, authorFamilyFor } from "./model-inversion";
import {
  runTestOnBaseCheck,
  testOnBaseSection,
  type TestOnBaseResult,
} from "./test-on-base";
import {
  runSecretScanCheck,
  secretScanSection,
  type SecretScanResult,
} from "./secret-scan";
import {
  loadReviewOptions,
  pathIgnored,
  severityRank,
  REVIEW_OPTION_DEFAULTS,
  type ReviewOptions,
} from "./review-options";
import {
  recordPostedFindings,
  shouldSuppressFinding,
  harvestThreadOutcomes,
  harvestReplySignals,
  readFeedback,
} from "./feedback";
import {
  prIntentSection,
  prDiscussionSection,
  classifyPriorFindings,
  openHumanThreadLines,
  priorReviewSection,
} from "./review-context";
import { learnedRulesSection } from "./learned-rules";
import { repoForFullName } from "./constants";
import {
  admitPublicReview,
  isExternalPullRequest,
  publicReviewIsolationAvailable,
  publicReviewLimits,
  publicReviewSizeError,
  runToollessPublicReview,
  verifyPublicPrInDisposableExecutor,
} from "./public-review";

const DEFAULT_REPO_DIR = defaultRepo().repo;

const REVIEW_OUTPUT_REPAIR_PROMPT = `Your previous response was only a progress update, not a usable review result. Do not continue investigating unless a missing fact is essential. Synthesize the inspection already completed and end this turn with the required single fenced JSON review object now.`;

export interface PrRef {
  number: number;
  headRef: string;
  headSha: string;
  title: string;
  /** owner/name when the PR lives outside the default repo (multi-repo). */
  ghRepo?: string;
}

export interface ReviewConfig {
  prompt: string;
  model?: string;
}

export interface Finding {
  path: string;
  line: number;
  side?: "RIGHT" | "LEFT";
  severity?: string;
  title?: string;
  body: string;
  suggestion?: string;
}

interface ReviewOutput {
  verdict?: string;
  confidence?: number;
  summary_markdown?: string;
  /** Optional mermaid diagram for changes that warrant one (schema/flow). */
  diagram?: { type?: string; mermaid?: string };
  findings?: Finding[];
}

/**
 * Derive the contract's 1-5 merge-safety score when a model returns a usable
 * review in another schema. Codex's `overall_confidence_score` is a 0-1 measure
 * of certainty, not merge safety, so severity + verdict are the honest fallback.
 */
function deriveMergeSafetyScore(
  verdict: string | undefined,
  findings: Finding[],
): number | undefined {
  if (!verdict) return undefined;

  let score = verdict === "approve" ? 5 : verdict === "comment" ? 4 : 2;
  for (const finding of findings) {
    switch ((finding.severity || "").toLowerCase()) {
      case "p0":
        score = Math.min(score, 1);
        break;
      case "p1":
      case "high":
        score = Math.min(score, 2);
        break;
      case "p2":
      case "medium":
        score = Math.min(score, 3);
        break;
      case "p3":
      case "low":
        score = Math.min(score, 4);
        break;
      default:
        // A structured finding with unknown severity is still an unresolved risk.
        score = Math.min(score, 3);
    }
  }
  return score;
}

/** What a review concluded, so callers (e.g. auto-fix) can gate on it. */
export interface ReviewResult {
  verdict?: string;
  confidence?: number;
  findings: number;
  /** Findings that should block merge: P0/P1 severity, or a request_changes verdict. */
  blocking: number;
  /** The reviewed source was an external fork and used the isolated public path. */
  publicReview?: true;
  error?: string;
}

/** Count merge-blocking findings (P0/P1, with request_changes as a floor of 1). */
function reviewBlockingCount(parsed: ReviewOutput | null): number {
  const n = (parsed?.findings || []).filter((f) => {
    const s = (f.severity || "").toLowerCase();
    return s === "p0" || s === "p1" || s === "high";
  }).length;
  if (n === 0 && parsed?.verdict === "request_changes") return 1;
  return n;
}

// P0/P1 are blocking-ish (red), P2 should-fix (orange), P3 minor (white).
// Legacy high/medium/low kept as aliases in case a prompt variant emits them.
const SEV_EMOJI: Record<string, string> = {
  p0: "🔴",
  p1: "🔴",
  p2: "🟠",
  p3: "⚪",
  high: "🔴",
  medium: "🟠",
  low: "⚪",
};

export async function runReview(
  pr: PrRef,
  config: ReviewConfig,
  onSessionCreated?: (bksId: string) => void,
  force = false,
  steer?: string,
  preflightDetails?: PrAutomationDetails,
): Promise<ReviewResult | null> {
  if (isShuttingDown()) {
    console.log(`[github] PR #${pr.number} review parked during shutdown`);
    return null;
  }
  if (!claimLock("review", pr.number, pr.ghRepo)) {
    console.log(
      `[github] review already running for PR #${pr.number}, skipping`,
    );
    return null;
  }
  let preserveRecovery = false;
  try {
    const prRepo = pr.ghRepo ? repoForFullName(pr.ghRepo) : null;
    const state = getOrInitPrState(pr.number, pr.headRef, pr.ghRepo);
    const priorRun =
      state.activeRun?.kind === "review" ? state.activeRun : undefined;
    const recovering = Boolean(priorRun);
    // Manual triggers review an already-reviewed SHA. Restart recovery does not:
    // if the prior run completed its durable commit point before the process died,
    // its leftover marker only needs clearing.
    const forceFreshReview = force && !recovering;
    if (
      !forceFreshReview &&
      pr.headSha &&
      state.reviewedShas.includes(pr.headSha)
    ) {
      console.log(
        `[github] PR #${pr.number} @ ${pr.headSha.slice(0, 7)} already reviewed`,
      );
      return null;
    }
    // Concurrent deliveries are coalesced by the in-process "review" lock above;
    // the SHA is recorded only AFTER a successful run (below) so a transient
    // failure can be retried rather than permanently suppressed.
    // `state` stays a read-only snapshot of what the PREVIOUS review left behind
    // (lastReview / lastReviewedSha below); every mutation goes through updatePrState.
    const isUpdate = state.reviewedShas.length > 0;
    const startedAt = new Date().toISOString();
    const sameHeadRecovery = Boolean(
      priorRun?.headSha && pr.headSha && priorRun.headSha === pr.headSha,
    );
    const legacyRecovery = recovering && !priorRun?.headSha;
    const recoveredReviewResult = sameHeadRecovery
      ? priorRun?.reviewResult
      : undefined;
    updatePrState(
      pr.number,
      pr.headRef,
      (s) => {
        s.activeRun = {
          kind: "review",
          requestedBy: "",
          startedAt,
          headSha: pr.headSha || priorRun?.headSha,
          progressCommentId: sameHeadRecovery
            ? priorRun?.progressCommentId
            : undefined,
          reviewResult: recoveredReviewResult,
          steer,
        };
      },
      pr.ghRepo,
    );
    const cancellationRequested = () =>
      activeRunCancellationRequested(pr.number, "review", pr.ghRepo);
    const finishCancelled = async (commentId?: number): Promise<null> => {
      if (commentId)
        await editIssueComment(
          commentId,
          `${REVIEW_MARKER}\n### 🤖 ${personaName()} review\n\nReview cancelled.`,
          pr.ghRepo,
        ).catch(() => {});
      audit({
        msg: "review_cancelled",
        pr_number: pr.number,
        repo: pr.ghRepo || defaultRepo().ghRepo,
      });
      return null;
    };

    // Look up by number before publishing progress. Fork identity comes from
    // GitHub, never from the contributor-controlled branch name.
    const details =
      preflightDetails?.number === pr.number &&
      (!pr.headSha || preflightDetails.headRefOid === pr.headSha)
        ? preflightDetails
        : await getPrAutomationDetails(
            pr.number ? String(pr.number) : pr.headRef,
            pr.ghRepo || undefined,
          );
    if (!details) {
      console.warn(
        `[github] no PR details for #${pr.number} (${pr.headRef}); review not started`,
      );
      return null;
    }
    const baseGhRepo = pr.ghRepo || defaultRepo().ghRepo;
    const publicReview = isExternalPullRequest(details, baseGhRepo);
    if (publicReview && (!pr.headSha || details.headRefOid !== pr.headSha)) {
      console.log(
        `[github] public PR #${pr.number} moved before isolated review admission`,
      );
      return null;
    }
    if (cancellationRequested()) return finishCancelled();
    const title = `Review · PR #${pr.number} ${details.title}`.slice(0, 100);
    const bksId = publicReview
      ? bksIdFor(pr.number, "review", pr.ghRepo)
      : await announceGithubRun({
          prNumber: pr.number,
          ghRepo: pr.ghRepo,
          kind: "review",
          branch: pr.headRef,
          title,
          mode: "ask",
        });
    if (!publicReview) onSessionCreated?.(bksId);

    // A fresh review posts a new placeholder and collapses the previous summary.
    // Public reviews intentionally expose no private Open Session URL.
    let reuseId = sameHeadRecovery ? priorRun?.progressCommentId : undefined;
    if (!reuseId && (sameHeadRecovery || legacyRecovery)) {
      const candidateId = priorRun?.progressCommentId ?? state.summaryCommentId;
      const candidate = candidateId
        ? await getComment(candidateId, pr.ghRepo)
        : null;
      if (candidate && isReviewProgressForHead(candidate.body, pr.headSha)) {
        reuseId = candidateId;
      } else {
        reuseId =
          (await findReviewProgressComment(pr.number, pr.headSha, pr.ghRepo)) ??
          undefined;
      }
    }
    const prevId =
      state.summaryCommentId ??
      (await findActiveReviewComment(pr.number, pr.ghRepo)) ??
      undefined;
    const shortSha0 = (pr.headSha || "").slice(0, 7);
    const progressSuffix = publicReview
      ? " · isolated public review"
      : ` · [📺 open session](${sessionUrl(pr.number, "review", pr.ghRepo)})`;
    const placeholderId = await postOrEditComment(
      pr.number,
      reuseId,
      `${REVIEW_MARKER}\n### 🤖 ${personaName()} review\n\n🔄 Reviewing${shortSha0 ? ` \`${shortSha0}\`` : ""}…${progressSuffix}`,
      pr.ghRepo,
    );
    if (placeholderId) {
      let ownsRun = false;
      updatePrState(
        pr.number,
        pr.headRef,
        (s) => {
          if (
            s.activeRun?.kind !== "review" ||
            s.activeRun.startedAt !== startedAt
          )
            return;
          ownsRun = true;
          s.summaryCommentId = placeholderId;
          s.activeRun.progressCommentId = placeholderId;
        },
        pr.ghRepo,
      );
      if (ownsRun && prevId && prevId !== placeholderId) {
        await supersedeReviewComment(prevId, pr.ghRepo).catch(() => {});
      }
    }
    if (cancellationRequested())
      return finishCancelled(placeholderId || undefined);

    // Internal PRs keep the rich local agent worktree. A fork is never placed
    // in a host worktree: its exact refs are verified in a disposable MicroVM
    // and the host model receives only a bounded immutable patch with no tools.
    let cwd = prRepo?.repo || DEFAULT_REPO_DIR;
    if (!publicReview) {
      try {
        cwd = await createReviewWorktreeForPrHead(
          pr.headRef,
          prRepo?.id,
          details.baseRefName,
        );
      } catch (e) {
        console.warn(`[github] review worktree for ${pr.headRef} failed:`, e);
        if (placeholderId)
          await editIssueComment(
            placeholderId,
            `${REVIEW_MARKER}\n### 🤖 ${personaName()} review\n\n⚠️ Couldn't prepare the PR checkout to review the diff. It will retry on the next push.`,
            pr.ghRepo,
          ).catch(() => {});
        return {
          findings: 0,
          blocking: 0,
          error: "Could not prepare the PR review worktree",
        };
      }
    }
    if (cancellationRequested())
      return finishCancelled(placeholderId || undefined);

    // Public contributors cannot change review policy. Their options come from
    // the configured base checkout and deterministic host-side execution stays off.
    const reviewOpts = loadReviewOptions(
      publicReview ? prRepo?.repo || DEFAULT_REPO_DIR : cwd,
    );
    const summaryOnly = details.changedFiles > reviewOpts.summaryOnlyOverFiles;
    const author = publicReview ? null : authorFamilyFor(pr);
    const testOnBase: Promise<TestOnBaseResult | null> =
      !publicReview && reviewOpts.testOnBase
        ? runTestOnBaseCheck({
            cwd,
            baseRefName: details.baseRefName,
            mainCheckout: prRepo?.repo || DEFAULT_REPO_DIR,
            sharedCheckout: prRepo?.sharedCheckout,
            prNumber: pr.number,
            ghRepo: pr.ghRepo,
          }).catch((e) => {
            console.warn(
              `[github] test-on-base check failed for PR #${pr.number}:`,
              e,
            );
            return null;
          })
        : Promise.resolve(null);
    const secretScan: Promise<SecretScanResult | null> =
      !publicReview && reviewOpts.secretScan
        ? runSecretScanCheck({
            cwd,
            baseRefName: details.baseRefName,
            prNumber: pr.number,
            ghRepo: pr.ghRepo,
          }).catch((e) => {
            console.warn(
              `[github] secret scan failed for PR #${pr.number}:`,
              e,
            );
            return null;
          })
        : Promise.resolve(null);

    // Continuity context — the "same reviewer returning" inputs: the PR's
    // stated intent and human conversation on every round; on re-reviews, a
    // digest of our prior findings joined with live thread state so round N+1
    // converges instead of re-deriving the PR from scratch. Learned rules are
    // the cross-PR channel (learned-rules.ts). All best-effort: a failed
    // thread fetch degrades to the old stateless prompt, never blocks the run.
    const preThreads = isUpdate
      ? await listReviewThreads(pr.number, pr.ghRepo).catch(() => [])
      : [];
    const priorReview = isUpdate
      ? priorReviewSection({
          lastReview: state.lastReview,
          priorFindings: classifyPriorFindings(
            readFeedback(pr.ghRepo),
            pr.number,
            preThreads,
            isGithubBotLogin,
          ),
          humanThreadLines: openHumanThreadLines(preThreads, isGithubBotLogin),
        })
      : "";

    const base = (config.prompt || "").trim() || DEFAULT_REVIEW_PROMPT;
    const prompt = buildReviewPrompt(
      base,
      details,
      isUpdate,
      steer,
      pr.ghRepo,
      {
        authorFamily: author?.family,
        ignoreGlobs: reviewOpts.ignoreGlobs,
        summaryOnly,
        intent: prIntentSection(details),
        discussion: prDiscussionSection(
          details,
          isGithubBotLogin,
          REVIEW_MARKER,
        ),
        priorReview,
        learnedRules: learnedRulesSection(pr.ghRepo),
        lastReviewedSha:
          isUpdate &&
          state.lastReviewedSha &&
          state.lastReviewedSha !== pr.headSha
            ? state.lastReviewedSha
            : undefined,
      },
    );

    // Model inversion: never review code with the model family that wrote it
    // (shared blind spots — see model-inversion.ts). Falls back to the
    // configured model for human-authored PRs.
    let reviewModel = config.model;
    const inversion = publicReview ? null : inverseReviewModel(pr, reviewModel);
    if (inversion) {
      reviewModel = inversion.model;
      console.log(
        `[github] model inversion for PR #${pr.number}: ${inversion.family}-authored (${inversion.source}) → reviewing with ${reviewModel}`,
      );
      audit({
        msg: "review_model_inversion",
        pr_number: pr.number,
        repo: pr.ghRepo || defaultRepo().ghRepo,
        author_family: inversion.family,
        review_model: reviewModel,
        source: inversion.source,
      });
    }

    const persistReviewResult = (result: GithubRunResult) => {
      updatePrState(
        pr.number,
        pr.headRef,
        (s) => {
          if (
            s.activeRun?.kind !== "review" ||
            s.activeRun.startedAt !== startedAt
          )
            return;
          s.activeRun.reviewResult = {
            text: result.text,
            error: result.error,
            model: result.model,
          };
        },
        pr.ghRepo,
      );
    };

    if (cancellationRequested())
      return finishCancelled(placeholderId || undefined);
    if (isShuttingDown()) {
      preserveRecovery = true;
      console.log(`[github] PR #${pr.number} review parked for restart`);
      return null;
    }
    console.log(
      `[github] Reviewing PR #${pr.number} @ ${pr.headSha.slice(0, 7)} (${isUpdate ? "update" : "initial"})`,
    );
    let finalResult: GithubRunResult;
    if (recoveredReviewResult) {
      finalResult = { bksId, ...recoveredReviewResult };
      console.log(
        `[github] Reusing the durable model result for PR #${pr.number} after restart`,
      );
    } else {
      if (publicReview) {
        const sizeError = publicReviewSizeError(details);
        if (sizeError) {
          if (placeholderId)
            await editIssueComment(
              placeholderId,
              `${REVIEW_MARKER}\n### 🤖 ${personaName()} review\n\n⚠️ ${sizeError}`,
              pr.ghRepo,
            ).catch(() => {});
          return {
            findings: 0,
            blocking: 0,
            publicReview: true,
            error: sizeError,
          };
        }
        const limits = publicReviewLimits();
        const diff = await getPrDiff(
          String(pr.number),
          baseGhRepo,
          limits.maxPatchBytes,
        );
        if (
          !diff ||
          diff.skippedFiles ||
          !diff.baseRefOid ||
          diff.headRefOid !== pr.headSha
        ) {
          const error =
            "GitHub could not provide one complete immutable patch within the isolated review limit.";
          if (placeholderId)
            await editIssueComment(
              placeholderId,
              `${REVIEW_MARKER}\n### 🤖 ${personaName()} review\n\n⚠️ ${error}`,
              pr.ghRepo,
            ).catch(() => {});
          return { findings: 0, blocking: 0, publicReview: true, error };
        }
        const isolatedInput = {
          repoId: prRepo?.id || defaultRepo().id,
          ghRepo: baseGhRepo,
          prNumber: pr.number,
          author: details.author,
          baseRef: details.baseRefName,
          baseSha: diff.baseRefOid,
          headSha: pr.headSha,
          prompt,
          model: reviewModel,
          diff,
        };
        if (!publicReviewIsolationAvailable()) {
          const message =
            "The isolated review environment is unavailable. No contributor code was run.";
          if (placeholderId)
            await editIssueComment(
              placeholderId,
              `${REVIEW_MARKER}\n### 🤖 ${personaName()} review\n\n⚠️ ${message}`,
              pr.ghRepo,
            ).catch(() => {});
          return {
            findings: 0,
            blocking: 0,
            publicReview: true,
            error: message,
          };
        }
        const admission = admitPublicReview({
          repo: baseGhRepo,
          prNumber: pr.number,
          headSha: pr.headSha,
          author: details.author,
        });
        if (!admission.ok) {
          const error =
            "The automatic public-review budget is exhausted for this contribution.";
          if (placeholderId)
            await editIssueComment(
              placeholderId,
              `${REVIEW_MARKER}\n### 🤖 ${personaName()} review\n\n⚠️ ${error}`,
              pr.ghRepo,
            ).catch(() => {});
          audit({
            msg: "public_review_rate_limited",
            pr_number: pr.number,
            repo: baseGhRepo,
            author: details.author,
            reason: admission.reason,
          });
          return { findings: 0, blocking: 0, publicReview: true, error };
        }
        try {
          await verifyPublicPrInDisposableExecutor(isolatedInput);
        } catch (error) {
          const message =
            "The isolated review environment is unavailable. No contributor code was run.";
          if (placeholderId)
            await editIssueComment(
              placeholderId,
              `${REVIEW_MARKER}\n### 🤖 ${personaName()} review\n\n⚠️ ${message}`,
              pr.ghRepo,
            ).catch(() => {});
          console.error(
            `[github] isolated public review failed for PR #${pr.number}:`,
            error,
          );
          return {
            findings: 0,
            blocking: 0,
            publicReview: true,
            error: message,
          };
        }
        const isolated = await runToollessPublicReview(isolatedInput);
        finalResult = {
          bksId,
          text: isolated.text,
          error: isolated.error,
          model: isolated.model,
        };
      } else {
        finalResult = await runGithubAgent({
          prNumber: pr.number,
          ghRepo: pr.ghRepo,
          kind: "review",
          prompt,
          cwd,
          mode: "ask",
          model: reviewModel,
          branch: pr.headRef,
          title,
          // Each review is self-contained and reads the current full diff from
          // the pinned internal worktree. Never resume across pushed SHAs.
          resume: false,
          detached: true,
          recoverDetached: sameHeadRecovery || legacyRecovery,
        });
        if (finalResult.uncertain) {
          preserveRecovery = true;
          throw new Error(
            finalResult.error || "Detached review ownership is uncertain",
          );
        }
      }
      persistReviewResult(finalResult);
    }

    if (cancellationRequested())
      return finishCancelled(placeholderId || undefined);
    let parsed = parseReviewOutput(
      finalResult.text,
      publicReview ? undefined : cwd,
    );
    // Internal reviews get one bounded continuation. Public reviews are
    // intentionally tool-less and self-contained, so they never reopen a guest
    // or resume a credential-bearing engine to repair malformed output.
    if (
      !publicReview &&
      !finalResult.error &&
      !isCompleteReviewOutput(parsed)
    ) {
      if (isShuttingDown()) {
        preserveRecovery = true;
        console.log(
          `[github] PR #${pr.number} review repair parked for restart`,
        );
        return null;
      }
      console.warn(
        `[github] PR #${pr.number} review ended without structured output; repairing once`,
      );
      finalResult = await runGithubAgent({
        prNumber: pr.number,
        ghRepo: pr.ghRepo,
        kind: "review",
        prompt: REVIEW_OUTPUT_REPAIR_PROMPT,
        cwd,
        mode: "ask",
        model: finalResult.model || reviewModel,
        branch: pr.headRef,
        title,
        resume: true,
        detached: true,
        // If the process died during this bounded repair turn, the initial
        // result above is durable and the surviving host belongs to the repair.
        recoverDetached: recovering,
      });
      if (finalResult.uncertain) {
        preserveRecovery = true;
        throw new Error(
          finalResult.error || "Detached review ownership is uncertain",
        );
      }
      persistReviewResult(finalResult);
      if (cancellationRequested())
        return finishCancelled(placeholderId || undefined);
      parsed = parseReviewOutput(finalResult.text, cwd);
    }
    const reviewError =
      finalResult.error ||
      (isCompleteReviewOutput(parsed)
        ? undefined
        : publicReview
          ? "The isolated review did not produce the required structured verdict."
          : "The review did not produce the required structured verdict after one continuation.");
    const tob = await testOnBase;
    const secrets = await secretScan;
    if (cancellationRequested())
      return finishCancelled(placeholderId || undefined);

    // Never publish an assessment against a different commit from the one the
    // worktree and prompt were pinned to. A push while the review was running
    // gets its own webhook/reconcile review; this result is now stale.
    const latestPr = await getPrAutomationDetails(
      pr.number ? String(pr.number) : pr.headRef,
      pr.ghRepo || undefined,
    );
    if (
      pr.headSha &&
      latestPr?.headRefOid &&
      latestPr.headRefOid !== pr.headSha
    ) {
      console.log(
        `[github] PR #${pr.number} moved from ${pr.headSha.slice(0, 7)} to ${latestPr.headRefOid.slice(0, 7)} during review; discarding the stale result`,
      );
      if (placeholderId) {
        await editIssueComment(
          placeholderId,
          `${REVIEW_MARKER}\n### 🤖 ${personaName()} review\n\nNew commits arrived before this review finished. Waiting for the updated review.`,
          pr.ghRepo,
        ).catch(() => {});
      }
      audit({
        msg: "review_superseded_during_run",
        pr_number: pr.number,
        repo: pr.ghRepo || defaultRepo().ghRepo,
        reviewed_sha: pr.headSha,
        current_sha: latestPr.headRefOid,
      });
      return null;
    }

    // A leaked credential blocks regardless of what the model concluded: the
    // verdict drops to request_changes and confidence caps at 2/5. (Not counted
    // as a "blocking finding" for the auto-fix gate — rotation is human work a
    // fixer loop can't do.)
    if (parsed && secrets?.findings.length) {
      parsed.verdict = "request_changes";
      parsed.confidence = Math.min(
        typeof parsed.confidence === "number" ? parsed.confidence : 2,
        2,
      );
    }
    await postReview(
      pr,
      details,
      parsed,
      finalResult.text,
      reviewError,
      forceFreshReview,
      finalResult.model,
      reviewOpts,
      summaryOnly,
      testOnBaseSection(tob) + secretScanSection(secrets),
      publicReview,
    );

    const outcome: ReviewResult = {
      verdict: parsed?.verdict,
      confidence: parsed?.confidence,
      findings: parsed?.findings?.length || 0,
      blocking: reviewBlockingCount(parsed),
      ...(publicReview ? { publicReview: true as const } : {}),
      error: reviewError,
    };

    // Per-review telemetry for the Analytics review-quality trend.
    if (!reviewError) {
      audit({
        msg: "review_completed",
        pr_number: pr.number,
        repo: pr.ghRepo || defaultRepo().ghRepo,
        verdict: outcome.verdict,
        confidence: outcome.confidence,
        findings: outcome.findings,
        blocking: outcome.blocking,
        is_update: isUpdate,
        public_review: publicReview,
        isolation: publicReview
          ? "disposable_executor_toolless"
          : "host_worktree",
        model: finalResult.model,
      });
    }

    // Record the SHA as reviewed only on a successful run, so a transient failure
    // (model error/timeout) leaves it eligible for retry on the next delivery.
    if (!reviewError && pr.headSha) {
      // The verdict is kept alongside the SHA so the sidebar can show the score
      // without reading the PR's comments back off GitHub.
      recordReviewed(
        pr.number,
        pr.headRef,
        pr.headSha,
        {
          verdict: outcome.verdict,
          confidence: outcome.confidence,
          findings: outcome.findings,
          blocking: outcome.blocking,
          sha: pr.headSha,
          at: new Date().toISOString(),
        },
        pr.ghRepo,
      );
    }

    return outcome;
  } catch (e) {
    console.error(`[github] review failed for PR #${pr.number}:`, e);
    return null;
  } finally {
    if (!preserveRecovery) {
      // Any detached host still present here belongs to a workflow that returned
      // before consuming it. Clear the marker only after absence is proven.
      try {
        await discardRecoverableGithubRun(pr.number, "review", pr.ghRepo);
      } catch (error) {
        if (error instanceof GithubRunRecoveryUncertainError)
          preserveRecovery = true;
        else
          console.warn(
            `[github] failed to stop orphaned review host for PR #${pr.number}:`,
            error,
          );
      }
      if (!preserveRecovery)
        clearActiveRun(pr.number, pr.headRef, "review", pr.ghRepo);
    }
    releaseLock("review", pr.number, pr.ghRepo);
  }
}

/** Render one finding as an inline comment: severity badge + title, body, optional suggestion block. */
function composeInlineBody(f: Finding): string {
  const sev = (f.severity || "").toUpperCase();
  const emoji = SEV_EMOJI[(f.severity || "").toLowerCase()] || "";
  const head = [emoji, sev && `**${sev}**`, f.title && `— ${f.title}`]
    .filter(Boolean)
    .join(" ")
    .trim();
  let out = [head, f.body?.trim()].filter(Boolean).join("\n\n");
  if (f.suggestion?.trim()) {
    out += `\n\n\`\`\`suggestion\n${f.suggestion.replace(/\n+$/, "")}\n\`\`\``;
  }
  return out.trim();
}

async function postReview(
  pr: PrRef,
  details: PrAutomationDetails,
  parsed: ReviewOutput | null,
  rawText: string,
  runError?: string,
  force = false,
  modelUsed?: string,
  opts: ReviewOptions = REVIEW_OPTION_DEFAULTS,
  summaryOnly = false,
  extraSummary = "",
  publicReview = false,
): Promise<void> {
  const knownCommentId = getOrInitPrState(
    pr.number,
    pr.headRef,
    pr.ghRepo,
  ).summaryCommentId;
  const shortSha = (pr.headSha || "").slice(0, 7);

  // Summary comment (single, edited in place).
  let summaryBody =
    parsed?.summary_markdown?.trim() || fallbackSummary(rawText, runError);
  // Optional change diagram (schema/flow PRs) — GitHub renders mermaid natively.
  const mermaid = parsed?.diagram?.mermaid?.trim();
  if (mermaid && mermaid.length <= 4000) {
    summaryBody += `\n\n<details><summary>📈 Change diagram</summary>\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n\n</details>`;
  }
  // Deterministic checks (test-on-base) append below the model's assessment.
  summaryBody += extraSummary;
  // Before anything posts, findings pass the repo/config/feedback filter chain:
  // ignored paths, the per-repo severity floor, giant-PR P0/P1-only mode, and
  // the learned feedback filter (recurring-nit suppression — never P0/P1).
  const allFindings = parsed?.findings || [];
  let withheld = 0;
  const findings = allFindings.filter((f) => {
    if (pathIgnored(f.path, opts)) return (withheld++, false);
    if (severityRank(f.severity) > severityRank(opts.minInlineSeverity))
      return (withheld++, false);
    if (summaryOnly && severityRank(f.severity) > 1) return (withheld++, false);
    if (
      shouldSuppressFinding(pr.ghRepo, {
        severity: f.severity,
        title: f.title,
        body: f.body,
      })
    )
      return (withheld++, false);
    return true;
  });
  if (withheld > 0) {
    console.log(
      `[github] withheld ${withheld} finding(s) on PR #${pr.number} (config/feedback filters)`,
    );
    audit({
      msg: "review_findings_withheld",
      pr_number: pr.number,
      repo: pr.ghRepo || defaultRepo().ghRepo,
      withheld,
      posted: findings.length,
    });
  }

  const verdict = parsed?.verdict
    ? ` · **${parsed.verdict.replace(/_/g, " ")}**`
    : "";
  const confidence =
    typeof parsed?.confidence === "number"
      ? ` · confidence ${parsed.confidence}/5`
      : "";
  const findingCount = findings.length;
  // Next-steps footer pointing at the action labels.
  const tip = publicReview
    ? "> 🔒 Reviewed from an immutable patch after the fork commits were verified in a disposable MicroVM. No contributor code ran on Open Session's host."
    : findingCount
      ? "> 💡 Labels: **`os-auto-fix`** — I fix these and push until CI passes · **`os-adversarial`** — deeper two-pass review · **`os-simplify`** — quality cleanup pass."
      : "> 💡 Labels: **`os-adversarial`** — deeper two-pass review · **`os-simplify`** — quality cleanup pass · **`os-auto-fix`** — fix anything outstanding and push until CI passes.";
  const footer = publicReview
    ? `<sub>Reviewed \`${shortSha}\`${modelUsed ? ` · ${modelLabel(modelUsed)}` : ""} · isolated public review</sub>`
    : `<sub>Reviewed \`${shortSha}\`${modelUsed ? ` · ${modelLabel(modelUsed)}` : ""} · earlier reviews collapse above · [open session](${sessionUrl(pr.number, "review", pr.ghRepo)})</sub>`;
  const composed = [
    REVIEW_MARKER,
    `### 🤖 ${personaName()} review${verdict}${confidence}`,
    "",
    summaryBody,
    "",
    findingCount
      ? `_${findingCount} inline comment${findingCount === 1 ? "" : "s"} below._`
      : "",
    withheld
      ? `<sub>${withheld} low-signal finding${withheld === 1 ? "" : "s"} withheld by repo config / feedback history.</sub>`
      : "",
    tip,
    footer,
  ]
    .filter((l) => l !== "")
    .join("\n");

  // Edit the placeholder posted at the start; fall back to a new comment if it's gone.
  let id: number | null = knownCommentId ?? null;
  if (id) {
    const ok = await editIssueComment(id, composed, pr.ghRepo);
    if (!ok) id = await postIssueComment(pr.number, composed, pr.ghRepo);
  } else {
    id = await postIssueComment(pr.number, composed, pr.ghRepo);
  }
  if (id && id !== knownCommentId) {
    const postedId = id;
    updatePrState(
      pr.number,
      pr.headRef,
      (s) => {
        s.summaryCommentId = postedId;
      },
      pr.ghRepo,
    );
  }

  // Existing inline threads on the PR: used to (a) resolve our own threads GitHub
  // has marked outdated (their code moved with this push) so they collapse instead
  // of piling up, and (b) dedup — a re-review after a push must NOT re-post a
  // finding we already have an open comment on. GitHub only auto-outdates an inline
  // comment when its anchored line changes, so a finding on an unchanged line
  // (e.g. Dockerfile:96) would otherwise get a fresh duplicate every single push.
  const existingThreads = await listReviewThreads(pr.number, pr.ghRepo).catch(
    () => [],
  );

  // Learning pass over the threads we already fetched: pick up 👍/👎 reactions
  // on our comments and mark outdated/resolved ones "addressed" (the author
  // acted). The "ignored" verdict only lands at PR close (webhook.ts).
  try {
    harvestThreadOutcomes(pr.ghRepo, pr.number, existingThreads, false);
  } catch (e) {
    console.warn(`[github] feedback harvest failed for PR #${pr.number}:`, e);
  }
  // Classify new human replies in our threads ("intentional" vs "good catch")
  // into replySignal — async model call, fire-and-forget.
  void harvestReplySignals(pr.ghRepo, pr.number, existingThreads).catch((e) =>
    console.warn(
      `[github] reply-signal harvest failed for PR #${pr.number}:`,
      e,
    ),
  );

  // Anchors (path:line) where we already have an open, still-current bot comment.
  // Skip re-posting these — the existing comment already covers the same spot.
  // `force` (manual "review again") bypasses dedup so an explicit re-review is fresh.
  const openBotAnchors = new Set<string>();
  if (!force) {
    for (const t of existingThreads) {
      if (
        isGithubBotLogin(t.rootAuthor) &&
        !t.isResolved &&
        !t.isOutdated &&
        t.path &&
        t.line != null
      ) {
        openBotAnchors.add(`${t.path}:${t.line}`);
      }
    }
  }

  // Formal review with inline comments, anchored to the diff.
  if (findings.length && pr.headSha) {
    const diff = await getPrDiff(String(pr.number), pr.ghRepo || undefined);
    const commitId = diff?.headRefOid || pr.headSha;
    const onDiff = diff ? filterToDiff(findings, diff.patch) : findings;
    const fresh = onDiff.filter(
      (f) => !openBotAnchors.has(`${f.path}:${f.line}`),
    );
    const inline: ReviewInlineComment[] = fresh.map((f) => ({
      path: f.path,
      line: f.line,
      side: f.side === "LEFT" ? "LEFT" : "RIGHT",
      body: composeInlineBody(f),
    }));
    const deduped = onDiff.length - fresh.length;
    if (deduped > 0) {
      console.log(
        `[github] skipped ${deduped} finding(s) already commented on PR #${pr.number}`,
      );
    }
    if (inline.length) {
      const ok = await submitReview(
        pr.number,
        commitId,
        `${personaName()} review · \`${shortSha}\``,
        inline,
        pr.ghRepo,
      );
      if (!ok)
        console.warn(`[github] submitReview failed for PR #${pr.number}`);
      // Remember what we posted so future reactions/outcomes can be joined
      // back to it (the feedback filter's training data).
      if (ok) {
        try {
          recordPostedFindings(pr.ghRepo, pr.number, fresh);
        } catch (e) {
          console.warn(
            `[github] recording findings failed for PR #${pr.number}:`,
            e,
          );
        }
      }
      if (inline.length < onDiff.length - deduped) {
        console.log(
          `[github] dropped ${onDiff.length - deduped - inline.length} off-diff finding(s) for PR #${pr.number}`,
        );
      }
    }
  }

  // Auto-resolve our own inline threads GitHub has marked outdated — their code
  // moved or vanished with this push, so the finding no longer anchors anywhere
  // useful. Collapsing them keeps the PR clean without a human resolving by hand.
  // Only ever touches bot-rooted threads; human threads are never resolved here.
  for (const t of existingThreads) {
    if (!t.isResolved && t.isOutdated && isGithubBotLogin(t.rootAuthor)) {
      await resolveReviewThread(t.id).catch(() => {});
    }
  }
}

function fallbackSummary(rawText: string, runError?: string): string {
  if (runError) return `⚠️ Review run errored: ${runError}`;
  const trimmed = (rawText || "").trim();
  if (!trimmed) return "⚠️ The review produced no output.";
  // Couldn't parse the JSON contract — surface the raw text so the review isn't lost.
  return trimmed.slice(0, 4000);
}

/**
 * Extract the first balanced top-level JSON object from `s`, tracking string and
 * escape state so braces (and ``` fences) inside string values don't cut it short.
 */
export function extractBalancedJson(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Pull the JSON object out of the last fenced ```json block in the agent's text
 * and parse it. Extraction is brace-balanced rather than fence-delimited: a
 * finding's markdown `body` can legitimately contain a ``` fence inside the JSON
 * string (e.g. a suggested shell command), and a naive non-greedy ```…``` regex
 * cuts the block at that inner fence — that's exactly what dumped raw narration
 * onto PR #4388.
 */
export function parseReviewOutput(
  text: string,
  cwd?: string,
): ReviewOutput | null {
  if (!text) return null;
  const opener = text.lastIndexOf("```json");
  const candidate =
    extractBalancedJson(opener === -1 ? text : text.slice(opener)) ?? text;
  try {
    const obj = JSON.parse(candidate.trim());
    if (obj && typeof obj === "object") {
      // Models drift from the contract's exact field names. Sol has emitted both
      // summary/file/details aliases and its native code-review shape
      // (overall_correctness, overall_explanation, priority, code_location).
      // Normalize those known structured forms instead of discarding a usable
      // verdict and spending a continuation that may contradict the first pass.
      const findingPath = (f: any): string | undefined => {
        const raw =
          typeof f.path === "string"
            ? f.path
            : typeof f.file === "string"
              ? f.file
              : typeof f.code_location?.absolute_file_path === "string"
                ? f.code_location.absolute_file_path
                : undefined;
        if (!raw || !raw.startsWith("/")) return raw;
        const root = cwd?.replace(/\/+$/, "");
        return root && raw.startsWith(`${root}/`)
          ? raw.slice(root.length + 1)
          : undefined;
      };
      const findings: Finding[] = Array.isArray(obj.findings)
        ? obj.findings
            .map((f: any) => {
              if (!f || typeof f !== "object") return f;
              const priority =
                Number.isInteger(f.priority) &&
                f.priority >= 0 &&
                f.priority <= 3
                  ? `P${f.priority}`
                  : undefined;
              const title =
                typeof f.title === "string"
                  ? f.title.replace(/^\[P[0-3]\]\s*/, "")
                  : undefined;
              return {
                ...f,
                path: findingPath(f),
                line: Number.isFinite(f.line)
                  ? f.line
                  : f.code_location?.line_range?.start,
                severity:
                  typeof f.severity === "string" ? f.severity : priority,
                title,
                body:
                  typeof f.body === "string"
                    ? f.body
                    : typeof f.details === "string"
                      ? f.details
                      : f.description,
              };
            })
            .filter(
              (f: any) =>
                f &&
                typeof f.path === "string" &&
                Number.isFinite(f.line) &&
                typeof f.body === "string",
            )
            .map((f: any) => ({
              path: f.path,
              line: f.line,
              side: f.side === "LEFT" ? "LEFT" : "RIGHT",
              severity: typeof f.severity === "string" ? f.severity : undefined,
              title: typeof f.title === "string" ? f.title : undefined,
              body: f.body,
              suggestion:
                typeof f.suggestion === "string" && f.suggestion.trim()
                  ? f.suggestion
                  : undefined,
            }))
        : [];
      // Contract confidence is integer merge-safety on a 1-5 scale. An invalid
      // value (typically Codex's 0-1 self-certainty probability) measures a
      // different quantity. Derive merge safety from the normalized verdict and
      // finding severities instead, so every postable review still has a score.
      const rawConfidence =
        typeof obj.confidence === "number" ? obj.confidence : undefined;
      const verdict =
        typeof obj.verdict === "string"
          ? obj.verdict
          : obj.overall_correctness === "patch is correct"
            ? "approve"
            : obj.overall_correctness === "patch is incorrect"
              ? "request_changes"
              : undefined;
      const confidence =
        rawConfidence !== undefined &&
        Number.isInteger(rawConfidence) &&
        rawConfidence >= 1 &&
        rawConfidence <= 5
          ? rawConfidence
          : deriveMergeSafetyScore(verdict, findings);
      return {
        verdict,
        confidence,
        summary_markdown:
          typeof obj.summary_markdown === "string"
            ? obj.summary_markdown
            : typeof obj.summary === "string"
              ? obj.summary
              : typeof obj.overall_explanation === "string"
                ? obj.overall_explanation
                : undefined,
        diagram:
          obj.diagram &&
          typeof obj.diagram === "object" &&
          typeof obj.diagram.mermaid === "string"
            ? {
                type:
                  typeof obj.diagram.type === "string"
                    ? obj.diagram.type
                    : undefined,
                mermaid: obj.diagram.mermaid,
              }
            : undefined,
        findings,
      };
    }
  } catch {}
  return null;
}

/** A review is postable only when it has a supported verdict and a real summary. */
export function isCompleteReviewOutput(
  output: ReviewOutput | null,
): output is ReviewOutput {
  return (
    !!output &&
    (output.verdict === "approve" ||
      output.verdict === "comment" ||
      output.verdict === "request_changes") &&
    typeof output.summary_markdown === "string" &&
    output.summary_markdown.trim().length > 0
  );
}

// ── Unified-diff line validation ─────────────────────────────
// Keep only findings whose (path, line, side) anchor to a line present in the
// diff — GitHub rejects an entire review if any inline comment is off-diff.

interface DiffLineSet {
  right: Set<number>; // new-file line numbers in the diff (added + context)
  left: Set<number>; // old-file line numbers in the diff (removed + context)
}

export function parseDiffLineSets(patch: string): Map<string, DiffLineSet> {
  const byFile = new Map<string, DiffLineSet>();
  let current: DiffLineSet | null = null;
  let newLine = 0;
  let oldLine = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) {
      let p = line.slice(4).trim();
      if (p === "/dev/null") {
        current = null;
        continue;
      } // deleted file
      // git quotes paths with spaces/unicode as "b/foo bar.ts"
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      if (p.startsWith("b/")) p = p.slice(2);
      current = { right: new Set(), left: new Set() };
      byFile.set(p, current);
      continue;
    }
    if (line.startsWith("--- ")) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = parseInt(hunk[1], 10);
      newLine = parseInt(hunk[2], 10);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+")) {
      current.right.add(newLine);
      newLine++;
    } else if (line.startsWith("-")) {
      current.left.add(oldLine);
      oldLine++;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — not a real line.
    } else {
      // context line — valid on both sides
      current.right.add(newLine);
      current.left.add(oldLine);
      newLine++;
      oldLine++;
    }
  }
  return byFile;
}

function filterToDiff(findings: Finding[], patch: string): Finding[] {
  const sets = parseDiffLineSets(patch);
  return findings.filter((f) => {
    const set = sets.get(f.path);
    if (!set) return false;
    return f.side === "LEFT" ? set.left.has(f.line) : set.right.has(f.line);
  });
}
