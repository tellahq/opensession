/**
 * Shared entry point for triggering the GitHub PR behaviors from a PR number —
 * used by both the Slack @mention intercept (handlers.ts) and the opensession-github
 * MCP tools (slack/github-tools.ts). Resolves the PR, fires the behavior
 * fire-and-forget, and returns a human message to relay.
 */
import { defaultRepo } from "../../server/config";
import { getPrAutomationDetails, getPrDiff } from "../../server/pr-info";
import { runReview, type PrRef } from "./review";
import { maybeHandoffFindings } from "./handoff";
import { runAutoFix } from "./autofix";
import { runSimplify } from "./simplify";
import { runAdversarial } from "./adversarial";
import { resolveReviewConfig } from "./webhook";
import { isExternalPullRequest } from "./public-review";

export type PrActionKind = "review" | "autofix" | "simplify" | "adversarial";

/** Extract a PR number from "4296", "#4296", "pr 4296", or a GitHub PR URL. */
export function parsePrNumber(input: number | string): number | null {
  if (typeof input === "number")
    return Number.isFinite(input) ? Math.trunc(input) : null;
  const s = String(input);
  const m =
    s.match(/\/pull\/(\d+)/) || s.match(/#?(\d+)\s*$/) || s.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

const LABELS: Record<PrActionKind, string> = {
  review: "reviewing",
  autofix: "auto-fixing",
  simplify: "running a simplify pass on",
  adversarial: "running an adversarial review of",
};

export interface TriggerResult {
  ok: boolean;
  message: string;
  url?: string;
  /** Open Session session id for this run (for an "Open in Open Session" link + Stop button). */
  bksId?: string;
  /** Resolves when the behavior finishes — lets the caller update a control card (drop Stop). */
  done?: Promise<unknown>;
}

/**
 * Resolve the PR and start the requested behavior. `requestedBy` is the requester
 * (Slack id or GitHub login) — used for commit attribution on fix/simplify/adversarial.
 * `steer` is the free text of the message that triggered this (PR comment / Slack
 * message), so a mixed-intent request ("…drop the Update.call change. /simplify")
 * carries its specific guidance into the run instead of being reduced to just the
 * verb. Label-triggered paths pass nothing, behaving exactly as before.
 */
export async function triggerPrAction(
  kind: PrActionKind,
  prNumber: number,
  requestedBy: string,
  steer?: string,
  ghRepo?: string,
): Promise<TriggerResult> {
  const details = await getPrAutomationDetails(
    String(prNumber),
    ghRepo || undefined,
  );
  if (!details) {
    return {
      ok: false,
      message: `I couldn't find PR #${prNumber} on ${ghRepo || defaultRepo().ghRepo}.`,
    };
  }
  const baseGhRepo = ghRepo || defaultRepo().ghRepo;
  const external = isExternalPullRequest(details, baseGhRepo);
  if (external && kind !== "review") {
    return {
      ok: false,
      url: details.url,
      message: `External PR #${prNumber} is read-only. Only isolated review is available.`,
    };
  }
  const diff = await getPrDiff(String(prNumber), baseGhRepo);
  const ref: PrRef = {
    number: prNumber,
    headRef: details.headRefName,
    headSha: diff?.headRefOid || "",
    title: details.title,
    ...(ghRepo ? { ghRepo } : {}),
  };

  let resolveSessionCreated: (id: string) => void = () => {};
  const sessionCreated = new Promise<string>((resolve) => {
    resolveSessionCreated = resolve;
  });

  const fail = (e: unknown) =>
    console.error(`[github] ${kind} trigger failed for PR #${prNumber}:`, e);
  let done: Promise<unknown>;
  switch (kind) {
    case "review":
      // force=true lets a fresh explicit request review an already-reviewed SHA.
      // runReview recognizes a persisted activeRun as restart recovery and keeps
      // SHA/comment dedup enabled there. This branch also serves that recovery,
      // and needs the same handoff tail as webhook.ts's fireReview: without it an
      // unsatisfied recovered review reached nobody (PR #5055, 2026-07-19).
      done = runReview(
        ref,
        resolveReviewConfig().config,
        resolveSessionCreated,
        true,
        steer,
      )
        .then((result) =>
          result?.publicReview ? undefined : maybeHandoffFindings(ref, result),
        )
        .catch(fail);
      break;
    case "autofix":
      done = runAutoFix(
        ref,
        requestedBy,
        resolveSessionCreated,
        false,
        steer,
      ).catch(fail);
      break;
    case "simplify":
      done = runSimplify(ref, requestedBy, resolveSessionCreated, steer).catch(
        fail,
      );
      break;
    case "adversarial":
      done = runAdversarial(
        ref,
        requestedBy,
        resolveSessionCreated,
        steer,
      ).catch(fail);
      break;
  }

  // Public reviews deliberately have no private session link. The isolated
  // result is posted to GitHub when the background promise completes.
  if (external) {
    return {
      ok: true,
      url: details.url,
      done,
      message: `running an isolated review of PR #${prNumber} (“${details.title}”). I'll post the results on the PR: ${details.url}`,
    };
  }

  // Each internal behavior announces only after it owns the relevant lock. If
  // it exits first, another action won the lock or setup failed, do not hand
  // the UI an id for a worker that never started.
  const bksId = await Promise.race([sessionCreated, done.then(() => "")]);
  if (!bksId) {
    return {
      ok: false,
      url: details.url,
      done,
      message: `Couldn't start ${kind} for PR #${prNumber}. Another PR action may already be running.`,
    };
  }

  return {
    ok: true,
    url: details.url,
    bksId,
    done,
    message: `${LABELS[kind]} PR #${prNumber} (“${details.title}”). I'll post the results on the PR: ${details.url}`,
  };
}
