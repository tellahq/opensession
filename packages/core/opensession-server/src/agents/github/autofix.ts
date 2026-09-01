/**
 * Behavior 2: the `os-auto-fix` label. Checks out the PR head branch in a dedicated
 * worktree, fixes merge conflicts + review findings + failing CI, pushes to the PR branch,
 * polls CI, and re-fixes until green AND a fresh review of the pushed
 * code finds nothing blocking — bounded so it can never run away. The loop is
 * gated on that fresh review rather than the fixer's own self-report, so it can't
 * stop while the agent's review would still flag a P0/P1. Removes the label when it
 * finishes.
 */
import {
  getPrAutomationDetails,
  getPrDetailsFresh,
  type PrDetails,
} from "../../server/pr-info";
import { ghBackoffUntil } from "../../server/github-limit";
import { createWorktreeForPrBranch } from "../../server/worktree";
import { claimLock, releaseLock, updatePrState, readPrState } from "./state";
import {
  announceGithubRun,
  runGithubAgent,
  authorForLogin,
  sessionUrl,
} from "./run";
import {
  buildAutoFixPrompt,
  mergeabilityState,
  type MergeabilityState,
} from "./prompts";
import { checkRegistrationPending } from "./autofix-gates";
import {
  postIssueComment,
  editIssueComment,
  removeLabel,
  resolveAddressedThreads,
  fetchReviewFindings,
  AUTOFIX_MARKER,
} from "./github-rest";
import { LABEL_AUTOFIX, labelAliases, repoForFullName } from "./constants";
import { personaName } from "../../server/config";
import type { PrRef, ReviewResult } from "./review";
import { defaultRepo } from "../../server/config";

const MAX_ITERATIONS = 5;
const WALL_CLOCK_MS = 60 * 60 * 1000; // abandon a loop running longer than an hour
// Scope guard: stop when the PR diff has grown past 2x the size it had when the
// loop started (plus a flat allowance so small PRs can absorb legitimate fixes).
// A fixer that doubles the diff isn't converging on the review — it's rewriting
// the PR, and that's a human decision.
const SCOPE_GROWTH_FACTOR = 2;
const SCOPE_GROWTH_FLAT_LINES = 200;
const CHECK_POLL_MS = 30 * 1000;
const CHECK_TIMEOUT_MS = 15 * 60 * 1000;
const CHECK_REGISTRATION_GRACE_MS = 30 * 1000;
const MERGEABILITY_POLL_MS = 5 * 1000;
const MERGEABILITY_TIMEOUT_MS = 2 * 60 * 1000;

const REPO = defaultRepo().ghRepo;

async function headSha(
  headRef: string,
  ghRepo: string = REPO,
): Promise<string> {
  try {
    return (await getPrAutomationDetails(headRef, ghRepo))?.headRefOid || "";
  } catch {
    return "";
  }
}

interface CiState {
  settled: boolean;
  green: boolean;
  failing: string[];
}

function evaluateChecks(details: PrDetails | null): CiState {
  const checks = details?.checks || [];
  if (!checks.length) return { settled: true, green: true, failing: [] }; // no CI configured
  const pending = checks.filter((c) => c.status !== "COMPLETED");
  const failing = checks
    .filter(
      (c) =>
        c.status === "COMPLETED" &&
        !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion),
    )
    .map((c) => `${c.name}${c.conclusion ? ` (${c.conclusion})` : ""}`);
  return {
    settled: pending.length === 0,
    green: pending.length === 0 && failing.length === 0,
    failing,
  };
}

/** Poll CI until it settles (or times out). */
async function waitForChecks(
  headRef: string,
  expectedHeadSha: string,
  emptyGraceMs = CHECK_REGISTRATION_GRACE_MS,
  ghRepo?: string,
): Promise<CiState> {
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  let last: CiState = { settled: false, green: false, failing: [] };
  let matchingHeadSeenAt = 0;
  while (Date.now() < deadline) {
    let details: PrDetails | null;
    try {
      details = await getPrDetailsFresh(headRef, ghRepo || undefined);
    } catch {
      // Rate-limited — wait out the backoff (or at least one poll interval) and retry.
      await new Promise((r) =>
        setTimeout(
          r,
          Math.min(
            deadline,
            Math.max(ghBackoffUntil(), Date.now() + CHECK_POLL_MS),
          ) - Date.now(),
        ),
      );
      continue;
    }
    if (details?.headRefOid !== expectedHeadSha) {
      await new Promise((r) => setTimeout(r, CHECK_POLL_MS));
      continue;
    }
    if (!matchingHeadSeenAt) matchingHeadSeenAt = Date.now();
    if (
      checkRegistrationPending(
        details.checks.length,
        matchingHeadSeenAt,
        Date.now(),
        emptyGraceMs,
      )
    ) {
      const remainingGrace = emptyGraceMs - (Date.now() - matchingHeadSeenAt);
      await new Promise((r) =>
        setTimeout(r, Math.min(CHECK_POLL_MS, remainingGrace)),
      );
      continue;
    }
    last = evaluateChecks(details);
    if (last.settled) return last;
    await new Promise((r) => setTimeout(r, CHECK_POLL_MS));
  }
  return last; // timed out — return whatever we last saw
}

interface MergeabilityProbe {
  state: MergeabilityState;
  details: PrDetails | null;
}

/** Wait for GitHub's asynchronous conflict calculation on one exact head SHA. */
async function waitForMergeability(
  headRef: string,
  expectedHeadSha: string,
  ghRepo?: string,
): Promise<MergeabilityProbe> {
  const deadline = Date.now() + MERGEABILITY_TIMEOUT_MS;
  let probe: MergeabilityProbe = { state: "pending", details: null };
  while (Date.now() < deadline) {
    let details: PrDetails | null;
    try {
      details = await getPrDetailsFresh(headRef, ghRepo || undefined);
    } catch {
      // Rate-limited — wait out the backoff (or at least one poll interval) and retry.
      await new Promise((r) =>
        setTimeout(
          r,
          Math.min(
            deadline,
            Math.max(ghBackoffUntil(), Date.now() + MERGEABILITY_POLL_MS),
          ) - Date.now(),
        ),
      );
      continue;
    }
    probe = { state: mergeabilityState(details, expectedHeadSha), details };
    if (probe.state !== "pending") return probe;
    await new Promise((r) => setTimeout(r, MERGEABILITY_POLL_MS));
  }
  return probe;
}

export async function runAutoFix(
  pr: PrRef,
  requestedBy: string,
  onSessionCreated?: (bksId: string) => void,
  resuming = false,
  steer?: string,
): Promise<void> {
  if (!claimLock("code", pr.number, pr.ghRepo)) {
    console.log(
      `[github] a code action (fix/simplify) is already running for PR #${pr.number}, skipping auto-fix`,
    );
    return;
  }

  const receivedState = readPrState(pr.number, pr.ghRepo);
  const effectiveRequestedBy =
    requestedBy ||
    receivedState?.pendingAutoFix?.requestedBy ||
    receivedState?.autoFix?.requestedBy ||
    "";
  const author = authorForLogin(effectiveRequestedBy);
  let statusCommentId: number | undefined;
  // Transient exits (engine/pool error, CI never settled, mergeability probe
  // hung) KEEP the os-auto-fix label so the reconcile sweep retries the loop;
  // only genuine terminal outcomes (success, closed PR, caps, "agent gave up")
  // remove it and hand back to humans.
  let transientExit = false;
  const link = `[📺 open session](${sessionUrl(pr.number, "autofix", pr.ghRepo)})`;

  const updateStatus = async (text: string) => {
    // Keep the session link on the header line; any extra lines (disposition
    // breakdown) render below it rather than getting glued to the link.
    const [head, ...rest] = text.split("\n");
    const tail = rest.length ? `\n${rest.join("\n")}` : "";
    const body = `${AUTOFIX_MARKER}\n🛠️ **${personaName()} auto-fix** — ${head} · ${link}${tail}`;
    if (statusCommentId) {
      await editIssueComment(statusCommentId, body, pr.ghRepo);
    } else {
      const id = await postIssueComment(pr.number, body, pr.ghRepo);
      if (id) {
        statusCommentId = id;
        updatePrState(
          pr.number,
          pr.headRef,
          (s) => {
            s.autoFix = {
              ...(s.autoFix || {
                active: true,
                iterations: 0,
                startedAt: new Date().toISOString(),
              }),
              statusCommentId: id,
            };
          },
          pr.ghRepo,
        );
      }
    }
  };

  try {
    const prior = receivedState?.autoFix;
    // Reuse the status comment only when recovering an interrupted loop; a fresh
    // re-trigger posts a new comment instead of editing the previous run's.
    statusCommentId = resuming ? prior?.statusCommentId : undefined;
    const startedAt =
      resuming && prior?.startedAt ? prior.startedAt : new Date().toISOString();
    let iterations = resuming ? prior?.iterations || 0 : 0;
    // A killed-and-recovered loop re-enters with no steer arg; pull it back from state.
    const effectiveSteer = steer ?? (resuming ? prior?.steer : undefined);

    updatePrState(
      pr.number,
      pr.headRef,
      (s) => {
        s.autoFix = {
          active: true,
          iterations,
          startedAt,
          statusCommentId,
          requestedBy: effectiveRequestedBy,
          worktreeDir: prior?.worktreeDir,
          lastPushedSha: prior?.lastPushedSha,
          steer: effectiveSteer,
        };
        delete s.pendingAutoFix;
      },
      pr.ghRepo,
    );

    const bksId = await announceGithubRun({
      prNumber: pr.number,
      ghRepo: pr.ghRepo,
      kind: "autofix",
      branch: pr.headRef,
      title: `Auto-fix · PR #${pr.number} ${pr.title}`.slice(0, 100),
      mode: "code",
    });
    onSessionCreated?.(bksId);

    // Post the first status before the slow worktree checkout. The local
    // session already exists, so a slow GitHub write cannot delay opening it.
    await updateStatus(
      resuming
        ? `resuming (iteration ${iterations + 1}/${MAX_ITERATIONS})…`
        : `starting (up to ${MAX_ITERATIONS} iterations) — setting up a worktree…`,
    );
    const worktreeDir = await createWorktreeForPrBranch(
      pr.headRef,
      pr.ghRepo ? repoForFullName(pr.ghRepo)?.id : undefined,
    );

    // Baseline to the CURRENT head so an iteration that pushes nothing compares
    // equal (no false "pushed" / false success on iteration 1).
    const baseSha =
      prior?.lastPushedSha || (await headSha(pr.headRef, pr.ghRepo || REPO));
    let lastPushedSha = baseSha;
    let outcome = "";
    let lastDisp: Dispositions | null = null;
    // Diff size (additions+deletions) at loop start; a resumed loop re-baselines
    // at its resume point, which only ever makes the guard more permissive.
    let baselineDiffLines: number | null = null;

    // Review helpers (dynamic import keeps the module graph acyclic). A fresh
    // review of each pushed SHA is what gates the loop; `lastReviewedSha` lets us
    // skip the post-loop refresh review when the last thing we did was review it.
    const { runReview } = await import("./review");
    const { resolveReviewConfig } = await import("./webhook");
    let lastReviewedSha = "";
    const reviewGate = async (sha: string): Promise<ReviewResult | null> => {
      const fresh = await getPrDetailsFresh(pr.headRef, pr.ghRepo || undefined);
      const ref: PrRef = {
        number: pr.number,
        headRef: pr.headRef,
        headSha: sha,
        title: fresh?.title || pr.title,
        ...(pr.ghRepo ? { ghRepo: pr.ghRepo } : {}),
      };
      const rr = await runReview(
        ref,
        resolveReviewConfig().config,
        onSessionCreated,
        /*force*/ true,
      ).catch((e) => {
        console.error(
          `[github] auto-fix gating review failed for PR #${pr.number}:`,
          e,
        );
        return null;
      });
      lastReviewedSha = sha;
      return rr;
    };

    while (iterations < MAX_ITERATIONS) {
      if (Date.now() - Date.parse(startedAt) > WALL_CLOCK_MS) {
        outcome =
          "⚠️ Stopped — exceeded the 1-hour time budget. Handing back to humans.";
        break;
      }
      iterations++;
      const details = await getPrDetailsFresh(
        pr.headRef,
        pr.ghRepo || undefined,
      );
      if (!details) {
        outcome = "⚠️ Could not load PR details — stopping.";
        transientExit = true;
        break;
      }
      if (details.state !== "OPEN") {
        outcome = `PR is ${details.state.toLowerCase()} — stopping.`;
        break;
      }

      const diffLines = details.additions + details.deletions;
      if (baselineDiffLines == null) {
        baselineDiffLines = diffLines;
      } else if (
        diffLines >
        baselineDiffLines * SCOPE_GROWTH_FACTOR + SCOPE_GROWTH_FLAT_LINES
      ) {
        outcome = `⚠️ Stopped — the PR diff grew from ${baselineDiffLines} to ${diffLines} changed lines during auto-fix (past the ${SCOPE_GROWTH_FACTOR}x scope guard). The fixes are drifting beyond the PR's original scope; handing back to humans.`;
        break;
      }

      const ciBefore = evaluateChecks(details);
      const reviewSummary = await fetchReviewFindings(pr.number, pr.ghRepo);
      await updateStatus(
        `iteration ${iterations}/${MAX_ITERATIONS}: working on fixes…`,
      );

      const prompt = buildAutoFixPrompt(
        details,
        reviewSummary,
        ciBefore.failing,
        iterations,
        effectiveSteer,
      );
      const result = await runGithubAgent({
        prNumber: pr.number,
        ghRepo: pr.ghRepo,
        kind: "autofix",
        prompt,
        cwd: worktreeDir,
        mode: "code",
        branch: pr.headRef,
        title: `Auto-fix · PR #${pr.number} ${details.title}`.slice(0, 100),
        resume: iterations > 1 || resuming,
        author,
      });

      const newSha = await headSha(pr.headRef, pr.ghRepo || REPO);
      const pushedSomething = !!newSha && newSha !== lastPushedSha;
      lastPushedSha = newSha || lastPushedSha;
      lastDisp = parseDispositions(result.text);
      const remaining = remainingFrom(lastDisp);

      // The loop's own locals are authoritative here. Re-reading them off disk
      // would pick up whatever a concurrent review lane last wrote.
      updatePrState(
        pr.number,
        pr.headRef,
        (s) => {
          s.autoFix = {
            active: true,
            iterations,
            startedAt,
            statusCommentId,
            requestedBy: effectiveRequestedBy,
            worktreeDir,
            lastPushedSha,
            steer: effectiveSteer,
          };
        },
        pr.ghRepo,
      );

      if (result.error) {
        outcome = `⚠️ Stopped — the fix run errored: ${result.error}`;
        transientExit = true;
        break;
      }

      if (!pushedSomething) {
        // Nothing changed this round. The fixer's dispositions (rendered below the
        // outcome) explain what it fixed vs deliberately skipped vs couldn't fix —
        // so a P3-only skip reads as a decision, not an opaque "made no changes".
        if (remaining !== "none") {
          outcome =
            "☑️ No further changes this round — the remaining items were deliberately skipped or couldn't be auto-fixed:";
          break;
        }
        const ci = await waitForChecks(
          pr.headRef,
          lastPushedSha,
          CHECK_REGISTRATION_GRACE_MS,
          pr.ghRepo,
        );
        if (!ci.settled) {
          outcome = "⏳ CI didn't settle within the timeout.";
          transientExit = true;
          break;
        }
        if (!ci.green) {
          outcome = `⚠️ CI is still failing (${ci.failing.join(", ")}) and no fixes were pushed. Handing back to humans.`;
          break;
        }
        const merge = await waitForMergeability(
          pr.headRef,
          lastPushedSha,
          pr.ghRepo,
        );
        if (merge.state === "conflicting" && iterations < MAX_ITERATIONS) {
          await updateStatus(
            `iteration ${iterations}/${MAX_ITERATIONS}: merge conflicts remain — continuing to fix…`,
          );
          continue;
        }
        if (merge.state === "conflicting") {
          outcome = `⚠️ No changes were pushed and the PR still conflicts with \`${merge.details?.baseRefName || details.baseRefName}\`. Handing back to humans.`;
          break;
        }
        if (merge.state === "pending") {
          outcome =
            "⏳ CI is green, but GitHub did not confirm mergeability for the current head.";
          transientExit = true;
          break;
        }
        outcome =
          "✅ Nothing left to fix — CI green, mergeable, and all findings addressed.";
        break;
      }

      const sha7 = lastPushedSha.slice(0, 7);
      await updateStatus(
        `iteration ${iterations}/${MAX_ITERATIONS}: pushed \`${sha7}\`, waiting for CI…`,
      );
      const ci = await waitForChecks(
        pr.headRef,
        lastPushedSha,
        CHECK_REGISTRATION_GRACE_MS,
        pr.ghRepo,
      );

      if (!ci.settled) {
        outcome = `⏳ Pushed \`${sha7}\` but CI didn't settle within the timeout.`;
        transientExit = true;
        break;
      }
      if (ci.failing.length) {
        if (iterations >= 2) {
          outcome = `⚠️ CI still failing after ${iterations} attempts (${ci.failing.join(", ")}). Handing back to humans.`;
          break;
        }
        continue; // green CI is a prerequisite for the review gate — fix the checks next round
      }

      // Mergeability is a completion gate alongside CI and review. A merge may
      // resolve one conflict while exposing another as the base branch advances,
      // so re-read GitHub after the push and let the next iteration address it.
      const merge = await waitForMergeability(
        pr.headRef,
        lastPushedSha,
        pr.ghRepo,
      );
      if (merge.state === "conflicting") {
        if (iterations >= MAX_ITERATIONS) {
          outcome = `⚠️ CI is green but the PR still conflicts with \`${merge.details?.baseRefName || details.baseRefName}\` after ${iterations} attempts. Handing back to humans.`;
          break;
        }
        await updateStatus(
          `iteration ${iterations}/${MAX_ITERATIONS}: CI green but merge conflicts remain — continuing to fix…`,
        );
        continue;
      }
      if (merge.state === "pending") {
        outcome = `⏳ Pushed \`${sha7}\`, but GitHub did not confirm mergeability for that head.`;
        transientExit = true;
        break;
      }

      // CI is green — gate on a FRESH review of the pushed code, not the fixer's
      // own self-report. Stop only when the review is satisfied — no blocking
      // findings AND either nothing left or confidence >= 4/5 ("safe to merge").
      // A ≤3/5 review with findings still open loops so the next iteration fixes
      // them (P2/P3 included — its inline comments are now the freshest, so
      // fetchReviewFindings picks them up). The loop still terminates naturally when
      // the fixer stops pushing changes, or at the iteration cap.
      await updateStatus(
        `iteration ${iterations}/${MAX_ITERATIONS}: CI green — reviewing \`${sha7}\`…`,
      );
      const review = await reviewGate(lastPushedSha);

      // Checks can change while a slow review runs. Re-read the exact head before
      // success; the earlier registration grace means an empty list is now safe.
      const finalCi = await waitForChecks(
        pr.headRef,
        lastPushedSha,
        0,
        pr.ghRepo,
      );
      if (!finalCi.settled) {
        outcome = `⏳ Review finished, but CI didn't settle for \`${sha7}\`.`;
        transientExit = true;
        break;
      }
      if (!finalCi.green) {
        if (iterations >= MAX_ITERATIONS) {
          outcome = `⚠️ CI failed after review (${finalCi.failing.join(", ")}). Handing back to humans.`;
          break;
        }
        await updateStatus(
          `iteration ${iterations}/${MAX_ITERATIONS}: CI failed during review — continuing to fix…`,
        );
        continue;
      }

      // The base branch may also advance during the review/CI wait, so every
      // successful exit gets one final fresh, SHA-aware mergeability check.
      const finalMerge = await waitForMergeability(
        pr.headRef,
        lastPushedSha,
        pr.ghRepo,
      );
      if (finalMerge.state === "conflicting") {
        if (iterations >= MAX_ITERATIONS) {
          outcome = `⚠️ The PR became conflicting with \`${finalMerge.details?.baseRefName || details.baseRefName}\` during review. Handing back to humans.`;
          break;
        }
        await updateStatus(
          `iteration ${iterations}/${MAX_ITERATIONS}: base changed during review and conflicts remain — continuing to fix…`,
        );
        continue;
      }
      if (finalMerge.state === "pending") {
        outcome =
          "⏳ Review finished, but GitHub did not confirm mergeability for the current head.";
        transientExit = true;
        break;
      }

      if (!review || review.error) {
        // No verdict (review lock contention / model error) — fall back to the
        // fixer's self-report so a flaky review can't spin the loop forever.
        if (remaining === "none") {
          outcome = `✅ Auto-fix complete — CI green, findings addressed (\`${sha7}\`); fresh review verdict unavailable.`;
          break;
        }
        outcome = `⚠️ CI green but couldn't get a fresh review verdict and work remains.`;
        transientExit = true;
        break;
      }
      const conf =
        typeof review.confidence === "number" ? review.confidence : null;
      const satisfied =
        review.blocking === 0 &&
        (review.findings === 0 || (conf != null && conf >= 4));
      if (satisfied) {
        const why =
          conf != null ? `confidence ${conf}/5` : "no blocking findings";
        outcome = `✅ Auto-fix complete — CI green and the review is satisfied (${why}, \`${sha7}\`).`;
        break;
      }
      const at =
        conf != null ? `confidence ${conf}/5` : `${review.blocking} blocking`;
      await updateStatus(
        `iteration ${iterations}/${MAX_ITERATIONS}: review at ${at} with ${review.findings} open finding(s) — continuing to fix…`,
      );
      // loop again to address the remaining findings (not just blockers)
    }

    if (!outcome && iterations >= MAX_ITERATIONS) {
      outcome = `⚠️ Reached the ${MAX_ITERATIONS}-iteration cap. Handing back to humans.`;
    }
    if (transientExit) {
      outcome = `${outcome} Keeping the \`${LABEL_AUTOFIX}\` label — I'll retry automatically.`;
    }
    const dispBlock = lastDisp ? formatDispositions(lastDisp) : "";
    await updateStatus(
      dispBlock ? `${outcome || "done."}\n\n${dispBlock}` : outcome || "done.",
    );

    updatePrState(
      pr.number,
      pr.headRef,
      (s) => {
        if (s.autoFix) {
          s.autoFix.active = false;
          s.autoFix.iterations = iterations;
          s.autoFix.lastPushedSha = lastPushedSha;
        }
      },
      pr.ghRepo,
    );

    // Refresh the pinned review against the fixed code. The auto-fix push won't
    // trigger a `synchronize` review on its own (it's authored by the bot account,
    // which the webhook guard skips), so the summary would otherwise show stale
    // findings. Skip it when the loop already reviewed this exact SHA via the gate
    // (the common success path) — only break-outs that didn't review need it.
    if (
      lastPushedSha &&
      lastPushedSha !== baseSha &&
      lastPushedSha !== lastReviewedSha
    ) {
      await reviewGate(lastPushedSha).catch((e) =>
        console.error(
          `[github] post-autofix review failed for PR #${pr.number}:`,
          e,
        ),
      );
    }

    // Mark the review threads the fixer addressed (left a "Fixed in <sha>" reply on)
    // as resolved, and sweep any of our own now-outdated review threads. Only runs
    // when the fixer actually pushed — a no-op loop resolves nothing.
    if (lastPushedSha && lastPushedSha !== baseSha) {
      const n = await resolveAddressedThreads(
        pr.number,
        /*alsoOutdatedBotThreads*/ true,
        pr.ghRepo,
      ).catch((e) => {
        console.error(
          `[github] resolving addressed threads failed for PR #${pr.number}:`,
          e,
        );
        return 0;
      });
      if (n)
        console.log(
          `[github] resolved ${n} review thread(s) on PR #${pr.number} after auto-fix`,
        );
    }
  } catch (e) {
    console.error(`[github] auto-fix error for PR #${pr.number}:`, e);
    transientExit = true; // an unexpected throw is infrastructure, not a verdict
    updatePrState(
      pr.number,
      pr.headRef,
      (s) => {
        if (s.autoFix) s.autoFix.active = false;
      },
      pr.ghRepo,
    );
    await updateStatus(
      `⚠️ Auto-fix errored: ${(e as any)?.message || e} Keeping the \`${LABEL_AUTOFIX}\` label — I'll retry automatically.`,
    ).catch(() => {});
  } finally {
    // Terminal outcomes hand back to humans by clearing the label; transient
    // ones keep it so the reconcile sweep (reconcile.ts) re-fires the loop
    // (bounded per SHA there — this can't ping-pong forever).
    if (!transientExit) {
      for (const name of labelAliases(LABEL_AUTOFIX)) {
        await removeLabel(pr.number, name, pr.ghRepo).catch(() => {});
      }
    } else {
      console.log(
        `[github] auto-fix transient exit for PR #${pr.number} — keeping ${LABEL_AUTOFIX} for the reconcile sweep`,
      );
    }
    releaseLock("code", pr.number, pr.ghRepo);
  }
}

interface Dispositions {
  fixed: string;
  skipped: string;
  unresolved: string;
}

/**
 * Parse the fixer's end-of-turn disposition lines (FIXED / SKIPPED / UNRESOLVED),
 * falling back to the legacy `REMAINING_FINDINGS:` line for older outputs. Empty
 * string for a field means "nothing" (the fixer wrote "none" or omitted it).
 */
function parseDispositions(text: string): Dispositions {
  const grab = (key: string): string => {
    const m = (text || "").match(
      new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "im"),
    );
    const v = m ? m[1].trim() : "";
    return /^none\.?$/i.test(v) ? "" : v;
  };
  const d: Dispositions = {
    fixed: grab("FIXED"),
    skipped: grab("SKIPPED"),
    unresolved: grab("UNRESOLVED"),
  };
  if (!d.fixed && !d.skipped && !d.unresolved) {
    const m = (text || "").match(/REMAINING_FINDINGS:\s*(.+)\s*$/im);
    const rem = m ? m[1].trim() : "";
    if (rem && rem.toLowerCase() !== "none") d.unresolved = rem;
  }
  return d;
}

/** "none" when the fixer left nothing open; otherwise a short description of what remains. */
function remainingFrom(d: Dispositions): string {
  const parts = [
    d.skipped && `skipped: ${d.skipped}`,
    d.unresolved && `unresolved: ${d.unresolved}`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "none";
}

/** Markdown breakdown of what the fixer did this run, for the status comment. */
function formatDispositions(d: Dispositions): string {
  return [
    d.fixed && `**Fixed:** ${d.fixed}`,
    d.skipped && `**Skipped (deliberate):** ${d.skipped}`,
    d.unresolved && `**Couldn't fix:** ${d.unresolved}`,
  ]
    .filter(Boolean)
    .join("\n");
}
