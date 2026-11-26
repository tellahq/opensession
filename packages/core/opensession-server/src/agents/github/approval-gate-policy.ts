/**
 * Approval gate policy: the pure decision behind the "OS approval gate" check
 * (approval-gate.ts posts it). A repository that requires this check in its
 * default-branch ruleset can drop the blanket "one approving review" rule
 * while keeping code-owner review:
 *
 *   - CODEOWNERS (from the default branch) names the human-review paths.
 *     Every changed file with an owner needs an approval from one of that
 *     file's owners, the same rule as GitHub's "require review from Code
 *     Owners", so the two never disagree.
 *   - A PR that touches no owned file passes when the OS review of the
 *     current head is approve, quality 5/5, with no blocking
 *     findings, or when someone with write access approves.
 *   - A PR from a fork, or one touching the review policy or CODEOWNERS
 *     itself, never passes on the model review alone.
 *   - No review of this head yet → in progress (blocks like a running check).
 *   - Anything else → action_required, with the reason in the title.
 *
 * Approvers are humans with write access, never the author or a bot, and a
 * change request from one of them blocks until they approve or it is
 * dismissed. `.os-review.json` always needs a human: its rules can override
 * the review's verdict and scores, and the review reads them from the PR
 * head, so a PR that edits them must not be able to approve itself.
 *
 * Enabled per repository from `.os-review.json` on the default branch, with
 * `"approvalGate": true` or `"approvalGate": { "checkName": "...",
 * "maxRisk": "low", "minQuality": 4 }`. `maxRisk` additionally caps the
 * review's merge risk on the automatic path; without it, risk is shown but
 * does not decide. `minQuality` (1-5, default 5) is the lowest review quality
 * the automatic path accepts.
 *
 * Human approvals survive later pushes by default, like a ruleset without
 * "dismiss stale reviews on push": the reviewer approved the change, not
 * each commit after it. `"requireApprovalOnHead": true` counts only
 * approvals of the current head. The OS review path always needs a review
 * of the current head.
 */
import type { LastReviewState } from "./state";

export const DEFAULT_GATE_CHECK_NAME = "OS approval gate";
/** Where GitHub looks for CODEOWNERS, in order; the first that exists wins. */
export const CODEOWNERS_LOCATIONS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
];
/** Always need a human: the review policy and code ownership themselves. A
 *  CODEOWNERS file counts wherever it sits, so a PR cannot add one in a
 *  location GitHub would start honouring, or retire the one it honours. */
export const ALWAYS_HUMAN_GLOBS = [".os-review.json", "**/CODEOWNERS"];

export const GATE_RISKS = ["low", "medium", "high"] as const;
export type GateRisk = (typeof GATE_RISKS)[number];

export interface ApprovalGateConfig {
  checkName: string;
  /** Highest merge risk the automatic path accepts. Absent = risk ignored. */
  maxRisk?: GateRisk;
  /** Lowest review quality the automatic path accepts. Absent = 5. */
  minQuality?: number;
  /** Count only human approvals of the current head. Default false. */
  requireApprovalOnHead?: boolean;
}

/** Parse the `approvalGate` key of `.os-review.json`. Null = gate off. */
export function normalizeApprovalGateConfig(
  raw: unknown,
): ApprovalGateConfig | null {
  if (raw === true) return { checkName: DEFAULT_GATE_CHECK_NAME };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.enabled === false) return null;
  const name =
    typeof o.checkName === "string" && o.checkName.trim()
      ? o.checkName.trim().slice(0, 100)
      : DEFAULT_GATE_CHECK_NAME;
  const maxRisk = GATE_RISKS.find((r) => r === o.maxRisk);
  const minQuality =
    typeof o.minQuality === "number" &&
    Number.isInteger(o.minQuality) &&
    o.minQuality >= 1 &&
    o.minQuality < 5
      ? o.minQuality
      : undefined;
  return {
    checkName: name,
    ...(maxRisk ? { maxRisk } : {}),
    ...(minQuality ? { minQuality } : {}),
    ...(o.requireApprovalOnHead === true
      ? { requireApprovalOnHead: true }
      : {}),
  };
}

// ── CODEOWNERS ───────────────────────────────────────────────────────────────

export interface CodeownersRule {
  pattern: string;
  /** Globs equivalent to the CODEOWNERS pattern. */
  globs: string[];
  /** Lowercased `@user`, `@org/team`, or email. Empty = explicitly unowned. */
  owners: string[];
}

/** Translate one CODEOWNERS (gitignore-style) pattern into globs. A pattern
 *  with a leading or inner slash is anchored to the root; otherwise it
 *  matches at any depth. A trailing slash means a directory. A name without
 *  wildcards in its last segment also matches everything below it. */
export function codeownersGlobs(pattern: string): string[] {
  let p = pattern.trim();
  if (!p) return [];
  if (p === "*" || p === "/*" || p === "**" || p === "/**") return ["**"];
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.replace(/\/+$/, "");
  const anchored = p.startsWith("/") || p.includes("/");
  p = p.replace(/^\/+/, "");
  if (!p) return ["**"];
  const base = anchored ? p : `**/${p}`;
  if (dirOnly) return [`${base}/**`];
  const last = p.split("/").pop() || "";
  return last.includes("*") ? [base] : [base, `${base}/**`];
}

export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...rest] = line.split(/\s+/);
    if (!pattern) continue;
    const owners: string[] = [];
    for (const token of rest) {
      if (token.startsWith("#")) break;
      if (token.includes("@")) owners.push(token.toLowerCase());
    }
    rules.push({ pattern, globs: codeownersGlobs(pattern), owners });
  }
  return rules;
}

/** The owners of one path: the LAST matching rule wins, as on GitHub. */
export function ownersFor(
  rules: CodeownersRule[],
  path: string,
  matchGlob: (glob: string, path: string) => boolean,
): string[] {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (rule.globs.some((g) => matchGlob(g, path))) return rule.owners;
  }
  return [];
}

// ── Reviews ──────────────────────────────────────────────────────────────────

/** One formal PR review, as GitHub lists them (chronological). */
export interface GateReview {
  login: string;
  /** "User" or "Bot". */
  userType: string;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING. */
  state: string;
  commitId: string;
}

/** The latest decisive review per login, as GitHub counts them: a comment
 *  does not replace an earlier approval or change request; a dismissal does. */
export function latestDecisiveReviews(
  reviews: GateReview[],
): Map<string, GateReview> {
  const latest = new Map<string, GateReview>();
  for (const r of reviews) {
    const key = r.login.toLowerCase();
    if (!key) continue;
    if (
      r.state === "APPROVED" ||
      r.state === "CHANGES_REQUESTED" ||
      r.state === "DISMISSED"
    )
      latest.set(key, r);
  }
  return latest;
}

export interface GateInput {
  headSha: string;
  author: string;
  /** The head lives in another repository: an outside contributor, whose PR
   *  the model alone never clears. */
  fromFork: boolean;
  /** Paths the PR changes (renames list both sides). */
  files: string[];
  /** False when GitHub truncated the file list: owners cannot be checked. */
  filesComplete: boolean;
  lastReview?: LastReviewState | null;
  reviews: GateReview[];
  /** Lowercased logins allowed to approve: write access, not a bot. */
  approvers: ReadonlySet<string>;
  /** Default-branch CODEOWNERS rules (empty when the repo has none). */
  codeowners: CodeownersRule[];
  /** Lowercased login → the lowercased owner tokens (`@login`, `@org/team`)
   *  that login satisfies. Only counted approvers need an entry. */
  ownerTokens: ReadonlyMap<string, ReadonlySet<string>>;
  /** Highest merge risk the automatic path accepts; absent = ignored. A
   *  review without a risk score never clears a cap. */
  maxRisk?: GateRisk;
  /** Lowest review quality the automatic path accepts; absent = 5. */
  minQuality?: number;
  /** Count only approvals of the current head (default: any commit). */
  requireApprovalOnHead?: boolean;
  /** Matches a path against one glob; injected so the policy stays pure. */
  matchGlob: (glob: string, path: string) => boolean;
}

export type GateResult =
  | { status: "in_progress"; title: string; summary: string }
  | {
      status: "completed";
      conclusion: "success" | "action_required";
      title: string;
      summary: string;
    };

/** Changed files that have code owners, with those owners, in file order. */
export function ownedFiles(
  input: Pick<GateInput, "files" | "codeowners" | "matchGlob">,
): Array<{ path: string; owners: string[] }> {
  return input.files
    .map((path) => ({
      path,
      owners: ownersFor(input.codeowners, path, input.matchGlob),
    }))
    .filter((f) => f.owners.length > 0);
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function list(items: string[], max = 5): string {
  const shown = items.slice(0, max).map((s) => `\`${s}\``);
  const more = items.length > max ? ` and ${items.length - max} more` : "";
  return shown.join(", ") + more;
}

function quality(min: number): string {
  return min === 5 ? "5/5" : `${min}/5 or higher`;
}

function reviewLabel(r: LastReviewState): string {
  const verdict = (r.verdict || "no verdict").replace(/_/g, " ");
  const quality =
    typeof r.confidence === "number" ? `${r.confidence}/5` : "no score";
  const risk = r.risk ? `risk ${r.risk}` : "no risk score";
  return `${verdict} · ${quality} · ${risk}`;
}

function how(onHead: boolean, minQuality: number): string {
  const approval = onHead ? "an approval of the current head" : "an approval";
  return `Passes when every changed file with a code owner has ${approval} from one of its owners and either the OS review of the current head clears the automatic path (approve and ${quality(minQuality)}, plus the repository's risk cap if it sets one), or someone with write access gives ${approval}. Files with code owners, the review policy, and PRs from forks always need a human.`;
}

export function evaluateApprovalGate(input: GateInput): GateResult {
  const head = input.headSha;
  const onHead = !!input.requireApprovalOnHead;
  const minQuality = input.minQuality ?? 5;
  const HOW = how(onHead, minQuality);
  const author = input.author.toLowerCase();
  const counted = [...latestDecisiveReviews(input.reviews).entries()].filter(
    ([login]) => login !== author && input.approvers.has(login),
  );

  const blockers = counted
    .filter(([, r]) => r.state === "CHANGES_REQUESTED")
    .map(([, r]) => `@${r.login}`);
  if (blockers.length) {
    return {
      status: "completed",
      conclusion: "action_required",
      title: `Changes requested by ${blockers.join(", ")}`,
      summary: `A human review requests changes. It stops blocking once that reviewer approves or the review is dismissed.\n\n${HOW}`,
    };
  }

  if (!input.filesComplete) {
    return {
      status: "completed",
      conclusion: "action_required",
      title: "Needs a human approval: too many files to check",
      summary: `GitHub listed only part of this PR's files, so code owners cannot be checked.\n\n${HOW}`,
    };
  }

  const approvedHead = counted
    .filter(
      ([, r]) => r.state === "APPROVED" && (!onHead || r.commitId === head),
    )
    .map(([login, r]) => ({ login, display: r.login }));
  const staleApproval =
    onHead &&
    counted.some(([, r]) => r.state === "APPROVED" && r.commitId !== head);
  const reapprove = staleApproval
    ? "\n\nAn earlier approval was for an older commit; approvals count only on the current head."
    : "";

  const owned = ownedFiles(input);
  const satisfies = (login: string, owners: string[]) => {
    const tokens = input.ownerTokens.get(login);
    return !!tokens && owners.some((o) => tokens.has(o));
  };
  const unapproved = owned.filter(
    (f) => !approvedHead.some((a) => satisfies(a.login, f.owners)),
  );

  if (approvedHead.length && !unapproved.length) {
    const owners = approvedHead.filter((a) =>
      owned.some((f) => satisfies(a.login, f.owners)),
    );
    const who = (owned.length ? owners : approvedHead)
      .map((a) => `@${a.display}`)
      .join(", ");
    return {
      status: "completed",
      conclusion: "success",
      title: owned.length
        ? `Approved by code owner ${who}`
        : `Approved by ${who}`,
      summary: `${owned.length ? "Code owners of every owned file" : "A human with write access"} approved ${onHead ? `\`${short(head)}\`` : "this PR"}.\n\n${HOW}`,
    };
  }

  if (unapproved.length) {
    const owners = [...new Set(unapproved.flatMap((f) => f.owners))];
    return {
      status: "completed",
      conclusion: "action_required",
      title: `Needs a code owner approval from ${owners.slice(0, 3).join(", ")}${owners.length > 3 ? ` and ${owners.length - 3} more` : ""}`,
      summary: `${list(unapproved.map((f) => f.path))} ${unapproved.length === 1 ? "has a code owner" : "have code owners"} in CODEOWNERS, so the OS review cannot clear this PR. An owner (${owners.join(", ")}) must approve${onHead ? " the current head" : ""}.${reapprove}\n\n${HOW}`,
    };
  }

  if (input.fromFork) {
    return {
      status: "completed",
      conclusion: "action_required",
      title: "Needs a human approval: opened from a fork",
      summary: `Pull requests from other repositories always need a human approval.${reapprove}\n\n${HOW}`,
    };
  }

  const policy = input.files.filter((f) =>
    ALWAYS_HUMAN_GLOBS.some((g) => input.matchGlob(g, f)),
  );
  if (policy.length) {
    return {
      status: "completed",
      conclusion: "action_required",
      title: "Needs a human approval: changes the review policy",
      summary: `${list(policy)} decide${policy.length === 1 ? "s" : ""} what the OS review and this gate accept, so a change to ${policy.length === 1 ? "it" : "them"} always needs a human approval.${reapprove}\n\n${HOW}`,
    };
  }

  const review = input.lastReview;
  if (!review || review.sha !== head) {
    return {
      status: "in_progress",
      title: `Waiting for the OS review of ${short(head)}`,
      summary: `${review ? `The last OS review was of \`${short(review.sha)}\`. ` : ""}This check updates when the review of \`${short(head)}\` finishes, or when someone approves.${reapprove}\n\n${HOW}`,
    };
  }

  const riskOk =
    !input.maxRisk ||
    (!!review.risk &&
      GATE_RISKS.indexOf(review.risk) <= GATE_RISKS.indexOf(input.maxRisk));
  const needs = `approve, ${quality(minQuality)}${input.maxRisk ? `, risk ${input.maxRisk}${input.maxRisk === "high" ? "" : " or lower"}` : ""} and no blocking findings`;
  const passes =
    review.verdict === "approve" &&
    typeof review.confidence === "number" &&
    review.confidence >= minQuality &&
    review.blocking === 0 &&
    riskOk;
  if (passes) {
    return {
      status: "completed",
      conclusion: "success",
      title: `OS review: ${reviewLabel(review)}`,
      summary: `The OS review of \`${short(head)}\` cleared the automatic path (${needs}), and the PR touches no file with a code owner.\n\n${HOW}`,
    };
  }
  return {
    status: "completed",
    conclusion: "action_required",
    title: `Needs a human approval: OS review ${reviewLabel(review)}`,
    summary: `The OS review of \`${short(head)}\` did not clear the automatic path (it needs ${needs}${review.blocking ? `; this review has ${review.blocking} blocking` : ""}).${reapprove}\n\n${HOW}`,
  };
}
