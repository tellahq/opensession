import type { PrCheck, PrDetails } from "./types";

/** One-line derived status: the state label + a tone + an optional qualifier. */
interface StatusLine {
  key: string;
  label: string; // Open / Merged / Closed / Draft
  qualifier: string | null; // Ready to merge / Blocked / Changes requested / …
  tone: "green" | "purple" | "red" | "yellow" | "muted";
}

export function deriveStatus(pr: PrDetails): StatusLine {
  if (pr.state === "MERGED")
    return { key: "merged", label: "Merged", qualifier: null, tone: "purple" };
  if (pr.state === "CLOSED")
    return { key: "closed", label: "Closed", qualifier: null, tone: "muted" };
  if (pr.isDraft)
    return { key: "draft", label: "Draft", qualifier: null, tone: "muted" };
  if (pr.mergeable === "CONFLICTING")
    return {
      key: "conflicts",
      label: "Open",
      qualifier: "Merge conflicts",
      tone: "red",
    };
  const checks = summarize(pr.checks);
  if (checks.failed > 0)
    return {
      key: "failing",
      label: "Open",
      qualifier: "Checks failed",
      tone: "red",
    };
  if (pr.reviewDecision === "CHANGES_REQUESTED")
    return {
      key: "changes",
      label: "Open",
      qualifier: "Changes requested",
      tone: "red",
    };
  if (checks.pending > 0)
    return {
      key: "running",
      label: "Open",
      qualifier: "Checks running",
      tone: "yellow",
    };
  if (pr.reviewDecision === "REVIEW_REQUIRED")
    return {
      key: "review",
      label: "Open",
      qualifier: "Review required",
      tone: "yellow",
    };
  return {
    key: "ready",
    label: "Open",
    qualifier: "Ready to merge",
    tone: "green",
  };
}

export function summarize(checks: PrCheck[]) {
  let passed = 0,
    failed = 0,
    pending = 0;
  for (const c of checks) {
    const cls = checkClass(c.status, c.conclusion);
    if (cls === "check-success") passed++;
    else if (cls === "check-failure") failed++;
    else if (cls === "check-pending") pending++;
  }
  return { passed, failed, pending, total: checks.length };
}

type PrCheckRank =
  | "check-success"
  | "check-failure"
  | "check-pending"
  | "check-neutral";

export function checkClass(status: string, conclusion: string): PrCheckRank {
  if (status !== "COMPLETED" && status !== "") return "check-pending";
  // StatusContexts (Vercel deploys) report a state, not a status — a pending
  // deploy is "COMPLETED"/PENDING here and must not read as neutral.
  if (conclusion === "PENDING" || conclusion === "EXPECTED")
    return "check-pending";
  switch (conclusion) {
    case "SUCCESS":
      return "check-success";
    case "FAILURE":
    case "TIMED_OUT":
    case "ERROR":
      return "check-failure";
    default:
      return "check-neutral";
  }
}

// Two shapes reach us, and "has a workflow" does NOT separate them. Vercel's
// git integration posts StatusContexts named "Vercel – <project>" / the older
// "vercel/<project>"; but a repo can also run its preview deploy as an ordinary
// Actions job ("Deploy Vercel App / Build and deploy" under a workflow named
// "Preview"), and GitHub Apps post check runs with an EMPTY workflowName
// ("Vercel Agent Review", "Vercel Preview Comments") that merely mention Vercel
// without deploying anything. So match the separator-suffixed status contexts,
// and otherwise insist the job actually says it deploys — a name that only
// contains "vercel" or "preview" is not evidence of a deploy.
//
// This decides more than a label: StagingLink treats a pending deployment as
// "the preview is rebuilding" and ambers the globe. Missing the real deploy
// leaves it green while the branch alias still serves the previous push.
export function isDeployment(check: PrCheck): boolean {
  if (!check.workflowName && /^(preview|vercel)\s*([–—-]|\/)/i.test(check.name))
    return true;
  return /^deploy\b/i.test(check.name);
}

export function formatCheckDuration(check: PrCheck): string | null {
  if (!check.startedAt || !check.completedAt) return null;
  const secs = Math.round(
    (new Date(check.completedAt).getTime() -
      new Date(check.startedAt).getTime()) /
      1000,
  );
  if (secs <= 0) return null;
  if (secs < 60) return `${secs}s`;
  return `${Math.round(secs / 60)}m`;
}
