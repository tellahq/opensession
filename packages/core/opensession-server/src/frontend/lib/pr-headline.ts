import type { GitStatusInfo, PrDetails } from "./types";
import { stackMergePlan } from "./pr-stack";

export interface PrHeadline {
  key:
    | "merged"
    | "closed"
    | "conflicts"
    | "failing"
    | "running"
    | "draft"
    | "changes-requested"
    | "stack-blocked"
    | "ready"
    | "ahead"
    | "behind"
    | "behind-base"
    | "no-pr"
    | "unavailable"
    | "clean";
  label: string;
  tone: "green" | "purple" | "red" | "yellow" | "muted";
}

interface CheckSummary {
  passed: number;
  failed: number;
  pending: number;
  total: number;
}

export function summarizeChecks(pr: PrDetails | null): CheckSummary {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const check of pr?.checks || []) {
    // StatusContexts (Vercel deploys) report a state, not a status. PENDING
    // there means running and must not read as done.
    if (
      (check.status !== "COMPLETED" && check.status !== "") ||
      check.conclusion === "PENDING" ||
      check.conclusion === "EXPECTED"
    )
      pending++;
    else if (check.conclusion === "SUCCESS") passed++;
    else if (["FAILURE", "TIMED_OUT", "ERROR"].includes(check.conclusion))
      failed++;
  }
  return { passed, failed, pending, total: (pr?.checks || []).length };
}

/**
 * Roll PR and local git state up into the one line the header shows.
 *
 * `prUnavailable` is the difference between "this branch has no PR" and "we
 * could not find out". Both arrive here as a null `pr`, and without the flag
 * the strip confidently says "No PR open" and offers Create PR on a branch
 * that already has one — the state the GitHub App's missing actions:read scope
 * put every PR surface into, and one that never corrects itself because
 * nothing about it looks like an error worth retrying.
 */
export function deriveHeadline(
  pr: PrDetails | null,
  git: GitStatusInfo | null,
  prUnavailable = false,
): PrHeadline {
  const sharedCheckout = git?.sharedCheckout ?? false;
  const ahead = git?.ahead ?? 0;
  const behind = git?.behind ?? 0;
  if (pr) {
    if (pr.state === "MERGED")
      return { key: "merged", label: "Merged", tone: "purple" };
    if (pr.state === "CLOSED")
      return { key: "closed", label: "Closed", tone: "muted" };
    if (!sharedCheckout && ahead > 0)
      return {
        key: "ahead",
        label: `Ahead by ${ahead} commit${ahead === 1 ? "" : "s"}`,
        tone: "yellow",
      };
    // A local checkout behind the PR's remote head does not block the remote
    // merge. GitHub's mergeability is authoritative here: offering Pull hid
    // the Merge CTA even when the complete remote PR was conflict-free.
    if (pr.mergeable === "CONFLICTING")
      return { key: "conflicts", label: "Merge conflicts", tone: "red" };
    const checks = summarizeChecks(pr);
    if (checks.failed > 0)
      return { key: "failing", label: "Checks failed", tone: "red" };
    if (checks.pending > 0)
      return {
        key: "running",
        label: `${checks.pending} check${checks.pending === 1 ? "" : "s"} pending…`,
        tone: "yellow",
      };
    if (pr.isDraft) return { key: "draft", label: "Draft", tone: "muted" };
    if (pr.reviewDecision === "CHANGES_REQUESTED")
      return {
        key: "changes-requested",
        label: "Changes requested",
        tone: "red",
      };
    const draftBelow = stackMergePlan(pr)?.blockedBy;
    if (draftBelow)
      return {
        key: "stack-blocked",
        label: `Draft #${draftBelow.number} below it`,
        tone: "yellow",
      };
    return { key: "ready", label: "Ready to merge", tone: "green" };
  }
  // This branch state belongs to the instance as a whole. It cannot safely be
  // pulled, rebased or reset from one session. A failed PR probe does not make
  // PR status relevant here: shared checkouts do not create per-session PRs.
  if (sharedCheckout)
    return { key: "clean", label: "Up to date", tone: "muted" };
  if (prUnavailable)
    return {
      key: "unavailable",
      label: "PR status unavailable",
      tone: "yellow",
    };
  if (behind > 0)
    return {
      key: "behind",
      label: `Behind by ${behind} commit${behind === 1 ? "" : "s"}`,
      tone: "yellow",
    };
  if (ahead > 0 || (git?.uncommittedFiles ?? 0) > 0)
    return { key: "no-pr", label: "No PR open", tone: "muted" };
  if ((git?.behindBase ?? 0) > 0)
    return {
      key: "behind-base",
      label: `${git!.behindBase} commit${git!.behindBase === 1 ? "" : "s"} behind ${git!.baseBranch}`,
      tone: "muted",
    };
  if (git?.branch) return { key: "no-pr", label: "No PR open", tone: "muted" };
  return { key: "clean", label: "Up to date", tone: "muted" };
}
