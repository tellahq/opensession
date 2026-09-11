/**
 * Is this pull request ready to merge? One deterministic verdict from the
 * PR's live GitHub state: open/merged/closed, draft, mergeability, the latest
 * run of every check by name, the review decision and who made it, and the
 * base branch's rulesets where the token can read them. The verdict is a
 * sentence the Desk can say aloud plus the detail behind it, never raw API
 * JSON.
 *
 * Read-only. The fetch runs `gh` as the bot for the PR's repository, the same
 * credential path pr-info uses, so it works for any registered repo whether
 * or not the session has it checked out.
 */

import {
  resolveGithubCredential,
  serviceGithubCredential,
  type GithubCredential,
} from "./github-auth";
import type { PrCheck } from "./pr-contract";
import {
  isNoPrError,
  latestWorkflowChecks,
  prApiErrorMessage,
} from "./pr-info";

export interface PrReadinessTarget {
  /** Registered repo id. */
  repoId: string;
  /** GitHub owner/name. */
  ghRepo: string;
  number: number;
}

/** What the base branch's rulesets demand of a PR before it can merge. */
export interface PrBranchRules {
  /** Names (contexts) of checks a ruleset requires. */
  requiredChecks: string[];
  /** Approving reviews a ruleset requires; 0 when none does. */
  requiredApprovals: number;
  /** A ruleset requires the head to be up to date with the base. */
  strictUpToDate: boolean;
}

/** Everything the verdict is computed from. */
export interface PrReadinessSource {
  repoId: string;
  ghRepo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** GitHub's mergeStateStatus: CLEAN, DIRTY, BLOCKED, BEHIND, UNSTABLE, DRAFT, HAS_HOOKS, UNKNOWN. */
  mergeStateStatus: string;
  /** GitHub's reviewDecision; empty when no rule requires a review. */
  reviewDecision: string;
  /** Latest run of every check, already collapsed by latestWorkflowChecks. */
  checks: PrCheck[];
  /** The latest review per reviewer. */
  latestReviews: Array<{ login: string; state: string }>;
  /** Reviewers asked who have not answered. */
  reviewRequests: string[];
  /** Null when the rules endpoint was not readable with this token. */
  rules: PrBranchRules | null;
}

export type PrCheckOutcome = "passing" | "failing" | "pending" | "skipped";

export interface PrReadinessCheck {
  name: string;
  outcome: PrCheckOutcome;
  /** GitHub's conclusion or status-context state, upper-cased; empty while running. */
  conclusion: string;
  required: boolean;
  url?: string;
}

export type PrReviewVerdict =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEW_REQUIRED"
  | "NONE";

export interface PrMergeVerdict {
  ready: boolean;
  /** One sentence a voice assistant can say as-is. */
  summary: string;
  /** Why it cannot merge, in the order they should be fixed. Empty when ready. */
  blockers: string[];
  /** Worth knowing, but not blocking. */
  warnings: string[];
  pr: {
    repo: string;
    ghRepo: string;
    number: number;
    title: string;
    url: string;
    author: string;
    base: string;
    head: string;
    headSha: string;
  };
  state: "OPEN" | "MERGED" | "CLOSED";
  draft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
  checks: {
    total: number;
    passing: PrReadinessCheck[];
    failing: PrReadinessCheck[];
    pending: PrReadinessCheck[];
    skipped: PrReadinessCheck[];
    /** Required by a ruleset but absent from the PR's rollup. */
    missingRequired: string[];
  };
  review: {
    decision: PrReviewVerdict;
    approvedBy: string[];
    changesRequestedBy: string[];
    awaiting: string[];
    requiredApprovals: number;
  };
  rules: {
    /** False when the rulesets endpoint was not readable; the verdict then leans on mergeStateStatus. */
    readable: boolean;
    requiredChecks: string[];
    requiredApprovals: number;
    strictUpToDate: boolean;
  };
}

function checkOutcome(check: PrCheck): PrCheckOutcome {
  const conclusion = (check.conclusion || "").toUpperCase();
  const status = (check.status || "").toUpperCase();
  if (/^(SUCCESS)$/.test(conclusion)) return "passing";
  if (/^(NEUTRAL|SKIPPED)$/.test(conclusion)) return "skipped";
  if (
    /^(FAILURE|CANCELLED|TIMED_OUT|ACTION_REQUIRED|ERROR|STARTUP_FAILURE|STALE)$/.test(
      conclusion,
    )
  )
    return "failing";
  // No conclusion yet, or a PENDING/EXPECTED status context, or a run that
  // is still queued or in progress.
  if (!conclusion || status !== "COMPLETED") return "pending";
  return "pending";
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "2 skipped", "1 neutral": the skipped bucket, worded by what happened. */
function noResultParts(skipped: PrReadinessCheck[]): string[] {
  const neutral = skipped.filter((c) => c.conclusion === "NEUTRAL").length;
  const parts: string[] = [];
  if (skipped.length - neutral)
    parts.push(`${skipped.length - neutral} skipped`);
  if (neutral) parts.push(`${neutral} neutral`);
  return parts;
}

/** "1 check skipped", "3 checks without a pass or fail (2 skipped and 1 neutral)". */
function noResultPhrase(skipped: PrReadinessCheck[]): string {
  const parts = noResultParts(skipped);
  const count = plural(skipped.length, "check");
  return parts.length === 1
    ? `${count} ${parts[0].replace(/^\d+ /, "")}`
    : `${count} without a pass or fail (${joinList(parts)})`;
}

/** Match a ruleset's required context against a check's reported name. */
function checkMatches(check: PrCheck, required: string): boolean {
  const name = check.name.trim().toLowerCase();
  const wanted = required.trim().toLowerCase();
  return (
    name === wanted ||
    (!!check.workflowName &&
      `${check.workflowName} / ${check.name}`.trim().toLowerCase() === wanted)
  );
}

/**
 * The verdict, computed from the source alone: same input, same answer.
 * Blockers are phrased so the summary reads aloud as one sentence.
 */
export function assessPrMergeReadiness(src: PrReadinessSource): PrMergeVerdict {
  const rules = src.rules ?? {
    requiredChecks: [],
    requiredApprovals: 0,
    strictUpToDate: false,
  };
  const requiredNames = rules.requiredChecks;
  const classified: PrReadinessCheck[] = src.checks.map((check) => ({
    name: check.workflowName
      ? `${check.workflowName} / ${check.name}`
      : check.name,
    outcome: checkOutcome(check),
    conclusion: (check.conclusion || "").toUpperCase(),
    required: requiredNames.some((r) => checkMatches(check, r)),
    ...(check.url ? { url: check.url } : {}),
  }));
  const by = (outcome: PrCheckOutcome) =>
    classified.filter((c) => c.outcome === outcome);
  const missingRequired = requiredNames.filter(
    (r) => !src.checks.some((c) => checkMatches(c, r)),
  );
  const checks = {
    total: classified.length,
    passing: by("passing"),
    failing: by("failing"),
    pending: by("pending"),
    skipped: by("skipped"),
    missingRequired,
  };

  const approvedBy = src.latestReviews
    .filter((r) => r.state.toUpperCase() === "APPROVED")
    .map((r) => r.login);
  const changesRequestedBy = src.latestReviews
    .filter((r) => r.state.toUpperCase() === "CHANGES_REQUESTED")
    .map((r) => r.login);
  // GitHub only fills reviewDecision when a rule requires a review; without
  // one, derive it from the latest review per reviewer the way pr-cache does.
  const decision: PrReviewVerdict = (() => {
    const given = src.reviewDecision.toUpperCase();
    if (
      given === "APPROVED" ||
      given === "CHANGES_REQUESTED" ||
      given === "REVIEW_REQUIRED"
    )
      return given;
    if (changesRequestedBy.length) return "CHANGES_REQUESTED";
    if (approvedBy.length) return "APPROVED";
    return "NONE";
  })();
  const review = {
    decision,
    approvedBy,
    changesRequestedBy,
    awaiting: src.reviewRequests,
    requiredApprovals: rules.requiredApprovals,
  };

  const blockers: string[] = [];
  const warnings: string[] = [];
  const base = src.baseRefName;
  // The skipped bucket holds every check without a pass/fail result. A
  // NEUTRAL check did run, so the wording keeps it apart from a SKIPPED one.

  if (src.state === "OPEN") {
    if (src.isDraft) blockers.push("it is still a draft");
    if (src.mergeable === "CONFLICTING")
      blockers.push(`it has merge conflicts with ${base}`);
    else if (src.mergeable === "UNKNOWN")
      blockers.push(
        "GitHub is still computing whether it merges cleanly, so ask again in a moment",
      );
    if (checks.failing.length)
      blockers.push(
        `${plural(checks.failing.length, "check is", "checks are")} failing (${checks.failing.map((c) => c.name).join(", ")})`,
      );
    if (checks.pending.length)
      blockers.push(
        `${plural(checks.pending.length, "check is", "checks are")} still running (${checks.pending.map((c) => c.name).join(", ")})`,
      );
    if (missingRequired.length)
      blockers.push(
        `${plural(missingRequired.length, "required check has", "required checks have")} not reported (${missingRequired.join(", ")})`,
      );
    if (decision === "CHANGES_REQUESTED")
      blockers.push(
        changesRequestedBy.length
          ? `${joinList(changesRequestedBy)} requested changes`
          : "changes were requested",
      );
    else if (decision === "REVIEW_REQUIRED")
      blockers.push("it needs an approving review");
    else if (rules.requiredApprovals > approvedBy.length)
      blockers.push(
        `it needs ${plural(rules.requiredApprovals, "approving review")} and has ${approvedBy.length}`,
      );
    const mss = src.mergeStateStatus.toUpperCase();
    if (mss === "BEHIND")
      blockers.push(`the branch is behind ${base} and needs updating`);
    else if (mss === "BLOCKED" && !blockers.length)
      // Everything readable looks fine, yet GitHub says no: a rule this
      // token cannot see (classic branch protection, code owners, a
      // deployment gate). Say so rather than call it ready.
      blockers.push(
        "GitHub reports the merge is blocked by a branch rule that is not readable here",
      );

    if (!src.rules)
      warnings.push(
        "branch rules could not be read, so the verdict leans on GitHub's merge state",
      );
    if (decision === "NONE" && !approvedBy.length && !rules.requiredApprovals)
      warnings.push(
        "nobody has approved it, and no branch rule requires a review",
      );
    if (review.awaiting.length)
      warnings.push(
        `still awaiting a review from ${joinList(review.awaiting)}`,
      );
    if (checks.skipped.length) warnings.push(noResultPhrase(checks.skipped));
  } else if (src.state === "MERGED") {
    blockers.push("it was already merged");
  } else {
    blockers.push("it was closed without merging");
  }

  const ready = src.state === "OPEN" && blockers.length === 0;
  const label = `PR #${src.number} "${src.title}"`;
  const summary = (() => {
    if (src.state === "MERGED") return `${label} was already merged.`;
    if (src.state === "CLOSED") return `${label} is closed and was not merged.`;
    if (!ready) return `${label} is not ready to merge: ${joinList(blockers)}.`;
    // A ready PR has no failing or pending checks, so every check either
    // passed, was skipped, or completed neutral; say which so the sentence
    // matches the rollup.
    const checksWhy = !checks.total
      ? "no checks reported"
      : !checks.skipped.length
        ? `all ${plural(checks.passing.length, "check")} passing`
        : !checks.passing.length
          ? `${noResultPhrase(checks.skipped)}, none failing`
          : joinList([
              `${plural(checks.passing.length, "check")} passing`,
              ...noResultParts(checks.skipped),
            ]);
    const why = [
      checksWhy,
      approvedBy.length
        ? `approved by ${joinList(approvedBy)}`
        : "no review required",
      "no conflicts",
    ];
    return `${label} is ready to merge: ${why.join(", ")}.`;
  })();

  return {
    ready,
    summary,
    blockers,
    warnings,
    pr: {
      repo: src.repoId,
      ghRepo: src.ghRepo,
      number: src.number,
      title: src.title,
      url: src.url,
      author: src.author,
      base: src.baseRefName,
      head: src.headRefName,
      headSha: src.headRefOid,
    },
    state: src.state,
    draft: src.isDraft,
    mergeable: src.mergeable,
    mergeStateStatus: src.mergeStateStatus,
    checks,
    review,
    rules: {
      readable: src.rules !== null,
      requiredChecks: rules.requiredChecks,
      requiredApprovals: rules.requiredApprovals,
      strictUpToDate: rules.strictUpToDate,
    },
  };
}

/** The tool's text: the spoken summary first, the detail under it, then the
 * verdict as JSON for anything that wants to branch on it. */
export function formatPrMergeVerdict(v: PrMergeVerdict): string {
  const mark = (c: PrReadinessCheck) =>
    c.outcome === "passing"
      ? "✓"
      : c.outcome === "failing"
        ? "✗"
        : c.outcome === "pending"
          ? "…"
          : "–";
  const lines = [
    v.summary,
    v.pr.url,
    `State: ${v.state.toLowerCase()}${v.draft ? ", draft" : ""} · mergeable ${v.mergeable}${v.mergeStateStatus ? ` (${v.mergeStateStatus})` : ""} · ${v.pr.head} → ${v.pr.base} @ ${v.pr.headSha.slice(0, 7)}`,
  ];
  if (v.blockers.length) lines.push(`Blockers: ${v.blockers.join("; ")}`);
  if (v.warnings.length) lines.push(`Notes: ${v.warnings.join("; ")}`);
  const ordered = [
    ...v.checks.failing,
    ...v.checks.pending,
    ...v.checks.passing,
    ...v.checks.skipped,
  ];
  lines.push(
    `Checks: ${v.checks.total ? [`${v.checks.passing.length} passing`, `${v.checks.failing.length} failing`, `${v.checks.pending.length} pending`, ...noResultParts(v.checks.skipped)].join(", ") : "none reported"}`,
  );
  for (const c of ordered)
    lines.push(`  ${mark(c)} ${c.name}${c.required ? " (required)" : ""}`);
  for (const name of v.checks.missingRequired)
    lines.push(`  ? ${name} (required, not reported)`);
  lines.push(
    `Review: ${v.review.decision.toLowerCase().replace(/_/g, " ")}` +
      ` · approved by ${v.review.approvedBy.join(", ") || "nobody"}` +
      (v.review.changesRequestedBy.length
        ? ` · changes requested by ${v.review.changesRequestedBy.join(", ")}`
        : "") +
      (v.review.awaiting.length
        ? ` · awaiting ${v.review.awaiting.join(", ")}`
        : ""),
  );
  lines.push(
    v.rules.readable
      ? `Branch rules on ${v.pr.base}: ${
          v.rules.requiredChecks.length || v.rules.requiredApprovals
            ? [
                v.rules.requiredChecks.length
                  ? `required checks ${v.rules.requiredChecks.join(", ")}`
                  : "",
                v.rules.requiredApprovals
                  ? `${plural(v.rules.requiredApprovals, "approval")} required`
                  : "",
                v.rules.strictUpToDate ? "must be up to date" : "",
              ]
                .filter(Boolean)
                .join(" · ")
            : "no rulesets"
        }`
      : `Branch rules on ${v.pr.base}: not readable with this token`,
  );
  lines.push("", "```json", JSON.stringify(v), "```");
  return lines.join("\n");
}

const PR_FIELDS =
  "number,title,url,state,isDraft,baseRefName,headRefName,headRefOid,author,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,latestReviews,reviewRequests";

async function gh(args: string[], credential: GithubCredential) {
  const proc = Bun.spawn(["gh", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...credential.env },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

/** Rulesets that apply to the base branch; null when the token cannot read them. */
async function fetchBranchRules(
  ghRepo: string,
  branch: string,
  credential: GithubCredential,
): Promise<PrBranchRules | null> {
  const { out, code } = await gh(
    ["api", `repos/${ghRepo}/rules/branches/${encodeURIComponent(branch)}`],
    credential,
  );
  if (code !== 0) return null;
  let rules: any[];
  try {
    rules = JSON.parse(out);
  } catch {
    return null;
  }
  if (!Array.isArray(rules)) return null;
  const result: PrBranchRules = {
    requiredChecks: [],
    requiredApprovals: 0,
    strictUpToDate: false,
  };
  for (const rule of rules) {
    const params = rule?.parameters ?? {};
    if (rule?.type === "required_status_checks") {
      for (const c of params.required_status_checks ?? [])
        if (typeof c?.context === "string" && c.context.trim())
          result.requiredChecks.push(c.context.trim());
      if (params.strict_required_status_checks_policy)
        result.strictUpToDate = true;
    } else if (rule?.type === "pull_request") {
      const n = Number(params.required_approving_review_count ?? 0);
      if (Number.isFinite(n) && n > result.requiredApprovals)
        result.requiredApprovals = n;
    }
  }
  result.requiredChecks = [...new Set(result.requiredChecks)];
  return result;
}

// GitHub computes `mergeable` lazily: after the base moves, every open PR
// answers UNKNOWN until a query triggers the recomputation, and GitHub's own
// guidance is to poll briefly. Three short waits keep the tool immediate in
// practice while an honest UNKNOWN still reaches the verdict if it persists.
const MERGEABLE_RETRY_DELAYS_MS = [1500, 2500, 3500];

async function viewPr(target: PrReadinessTarget, credential: GithubCredential) {
  const { out, err, code } = await gh(
    [
      "pr",
      "view",
      String(target.number),
      "--repo",
      target.ghRepo,
      "--json",
      PR_FIELDS,
    ],
    credential,
  );
  if (code !== 0) {
    const msg = err.trim().slice(0, 300);
    if (isNoPrError(msg))
      throw new Error(`No PR #${target.number} in ${target.ghRepo}`);
    throw new Error(
      /rate limit|authentication|bad credentials|resource not accessible/i.test(
        msg,
      )
        ? prApiErrorMessage(msg)
        : msg || `gh pr view failed for ${target.ghRepo}#${target.number}`,
    );
  }
  return JSON.parse(out);
}

/**
 * Read one PR's readiness inputs as the bot for its repository. Throws with
 * a human message when the PR does not exist or GitHub is unreachable.
 */
export async function fetchPrReadinessSource(
  target: PrReadinessTarget,
  credential: GithubCredential = serviceGithubCredential,
  retryDelaysMs: readonly number[] = MERGEABLE_RETRY_DELAYS_MS,
): Promise<PrReadinessSource> {
  const resolved = await resolveGithubCredential(credential, {
    repo: target.ghRepo,
  });
  let pr = await viewPr(target, resolved);
  for (const delay of retryDelaysMs) {
    if (pr.state !== "OPEN" || pr.mergeable !== "UNKNOWN") break;
    await new Promise((r) => setTimeout(r, delay));
    pr = await viewPr(target, resolved);
  }
  const baseRefName = String(pr.baseRefName || "");
  const rules = baseRefName
    ? await fetchBranchRules(target.ghRepo, baseRefName, resolved).catch(
        () => null,
      )
    : null;
  return {
    repoId: target.repoId,
    ghRepo: target.ghRepo,
    number: pr.number,
    title: pr.title || "",
    url: pr.url || "",
    author: pr.author?.login || "",
    state: pr.state,
    isDraft: !!pr.isDraft,
    baseRefName,
    headRefName: pr.headRefName || "",
    headRefOid: pr.headRefOid || "",
    mergeable:
      pr.mergeable === "MERGEABLE" || pr.mergeable === "CONFLICTING"
        ? pr.mergeable
        : "UNKNOWN",
    mergeStateStatus: pr.mergeStateStatus || "",
    reviewDecision: pr.reviewDecision || "",
    checks: latestWorkflowChecks(
      (pr.statusCheckRollup || []).map((c: any) => ({
        name: c.name || c.context || "check",
        status: c.status || (c.state ? "COMPLETED" : ""),
        conclusion: c.conclusion || c.state || "",
        url: c.detailsUrl || c.targetUrl || undefined,
        startedAt: c.startedAt || undefined,
        completedAt: c.completedAt || undefined,
        workflowName: c.workflowName || undefined,
      })),
    ),
    latestReviews: (pr.latestReviews || [])
      .map((r: any) => ({
        login: r.author?.login || "",
        state: String(r.state || ""),
      }))
      .filter((r: { login: string }) => r.login),
    reviewRequests: (pr.reviewRequests || [])
      .map((r: any) => r.login || r.name || r.slug || "")
      .filter(Boolean),
    rules,
  };
}
