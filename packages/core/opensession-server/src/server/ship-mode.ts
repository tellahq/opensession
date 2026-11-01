/**
 * Ship mode: how a workspace's change reaches the default branch, and every
 * git/publication instruction the agent is given about it.
 *
 * Two modes. `pull-request` pushes the workspace branch and opens (or
 * updates) one PR that a person merges. `direct` integrates the default branch
 * and fast-forward pushes to it, trunk-based. A repository picks its default
 * with `publicationMode` in config.json; a session or workspace may override
 * it at creation. Code Storage repos, automations and their descendants,
 * stacked branches, branches that already carry a PR, and pstack sessions
 * always stay on the change-request flow, whatever was asked for.
 *
 * Worktree isolation is a separate axis: a shared-checkout session already
 * works on the default branch, so it has no branch to publish and gets no note
 * here (its repository's AGENTS.md owns that flow).
 *
 * This module is pure: callers resolve the repository and session facts and
 * pass them in, so the instruction text can be tested without git or config.
 */

import type { Repo, RepoPublicationMode } from "./config";
import { shellQuoteWord } from "./sandbox/adapters/bootstrap";
import {
  MAX_SHIP_ACTIONS,
  parseShipActions,
  type ShipAction,
} from "./ship-actions";

export type ShipMode = RepoPublicationMode;

export const SHIP_MODES: readonly ShipMode[] = ["pull-request", "direct"];

export function parseShipMode(value: unknown): ShipMode | undefined {
  return value === "direct" || value === "pull-request" ? value : undefined;
}

type ShipRepo = Pick<Repo, "id" | "defaultBranch" | "host" | "publicationMode">;

/** Why the effective mode is what it is; the UI explains a forced PR flow. */
export type ShipModeReason =
  | "repository"
  | "override"
  | "code-storage"
  | "automation"
  | "open-pr"
  | "stacked"
  | "existing-branch"
  | "pstack";

export interface ShipModeInput {
  repo: ShipRepo;
  /** The session's or workspace's own choice; absent = the repository's. */
  override?: ShipMode;
  /** The workspace branch already has an open PR. */
  openPr?: boolean;
  stacked?: boolean;
  /** The worktree checked out an existing branch (a PR start). */
  existingBranch?: boolean;
  pstackMode?: boolean;
  /** An automation run or one of its descendants. */
  automation?: boolean;
}

export interface ResolvedShipMode {
  mode: ShipMode;
  /** What the repository or session asked for, before the guards. */
  requested: ShipMode;
  reason: ShipModeReason;
}

export function resolveShipMode(input: ShipModeInput): ResolvedShipMode {
  const requested =
    input.override ?? input.repo.publicationMode ?? "pull-request";
  const source: ShipModeReason = input.override ? "override" : "repository";
  if (requested !== "direct")
    return { mode: "pull-request", requested, reason: source };
  const forced: ShipModeReason | null =
    input.repo.host === "codestorage"
      ? "code-storage"
      : input.automation
        ? "automation"
        : input.openPr
          ? "open-pr"
          : input.stacked
            ? "stacked"
            : input.existingBranch
              ? "existing-branch"
              : input.pstackMode
                ? "pstack"
                : null;
  if (forced) return { mode: "pull-request", requested, reason: forced };
  return { mode: "direct", requested, reason: source };
}

/** Claim file, under the shared git dir, naming the session resolving an
 * upstream merge. Sibling sessions share one worktree, so git's own MERGE_HEAD
 * already serializes the merge; the claim adds WHO owns it, so a sibling can
 * tell a live merge from one abandoned by a session that stopped. */
export const MERGE_CLAIM_FILE = "opensession-merge-owner";

/**
 * Conflicts with the trunk are always this workspace's job, never something to
 * report and leave: an unresolved conflict blocks every sibling's next publish.
 * Exactly one session resolves at a time, coordinated through the claim file.
 */
export function buildConflictNote(defaultBranch: string): string {
  return [
    "## Merge conflicts after the default branch moves",
    `When \`origin/${defaultBranch}\` has moved and conflicts with this branch (a merge stops on conflicts, a push is rejected and integrating conflicts, or you are told this branch's PR now has merge conflicts), resolving them is part of your task. Do not stop at reporting them, and do not leave them for the user. Merge \`origin/${defaultBranch}\` into this branch (no rebase, no force-push), keep the intent of both sides, rerun the required checks, commit, and push. Ask the user only when the two sides make incompatible product decisions.`,
    `Sibling sessions share this worktree, so exactly one session resolves at a time. Coordinate through \`$(git rev-parse --git-dir)/${MERGE_CLAIM_FILE}\`:`,
    `- Before merging, read that file and check for \`MERGE_HEAD\`. If neither exists, write your Open Session id to the file and start the merge. You own it until the merge commit is pushed; then delete the file.`,
    "- If the file names another session, check it with `get_session`. While it is running, queued, or waiting on a question, it owns the conflict: do not start a second merge or edit conflicted files. Keep working on unrelated files and check again before you publish. If it is idle, archived, or unknown, or `MERGE_HEAD` exists with no claim, take over: write your id to the file and finish the merge in progress.",
    "- If git refuses the merge because a sibling's uncommitted edits would be overwritten, ask the sessions working on those files with `send_to_session` to commit them, wait for their reply, then merge. Tell the user which files block the merge only when no session owns them.",
  ].join("\n");
}

/**
 * Branch discipline for an interactive session in an isolated worktree, in the
 * session's effective ship mode. Sessions in one workspace share a single
 * worktree + branch, so each agent must treat that branch as THE branch,
 * sibling commits included. Rewriting the branch as a whole (rebasing it onto
 * the trunk when the user asks) is fine as long as every sibling commit rides
 * along; what the note forbids is dropping or routing around them.
 */
export function buildWorktreePublicationNote(input: {
  repo: ShipRepo;
  mode: ShipMode;
  worktreeDir: string;
  branch: string;
  stacked?: boolean;
}): string {
  const { repo, worktreeDir, branch } = input;
  if (input.mode === "direct") {
    return [
      "## Branch discipline (direct publication)",
      `You are working in \`${worktreeDir}\` on branch \`${branch}\`. Sibling sessions share this worktree and branch; preserve all their commits and uncommitted work. Stay on this branch, never switch or create branches, reset, stash, or cherry-pick around sibling commits.`,
      `Repository \`${repo.id}\` defaults to publishing directly to \`${repo.defaultBranch}\` without a pull request. This publication preference is independent of checkout isolation. If the user explicitly requests a PR, or this branch already has an open PR, use the PR workflow instead; never merge that PR without explicit user approval for that specific PR.`,
      `Before publishing, inspect the complete diff against \`origin/${repo.defaultBranch}\`, including sibling commits. Stop if unfinished or unrelated work would land. Stage only your own changes, inspect the staged diff, and run the repository's required checks before committing.`,
      `Fetch with \`git fetch origin\`. Before integrating upstream, check for rebase-merge, rebase-apply, or MERGE_HEAD under \`git rev-parse --git-dir\` and coordinate with sibling sessions. If \`git merge-base --is-ancestor origin/${repo.defaultBranch} HEAD\` fails, merge \`origin/${repo.defaultBranch}\` into this branch without rewriting its history, only with a clean index. Never stash or discard another session's uncommitted work. Resolve conflicts and rerun all required checks on the final candidate.`,
      `Publish the checked commit with a normal fast-forward push: \`git push origin HEAD:refs/heads/${repo.defaultBranch}\`. Never force-push or delete the default branch. If the push is rejected because the remote advanced, fetch, integrate, review, and check again; do not blindly retry. Keep this worktree's upstream on its own branch, not the default branch.`,
      "This preference grants no additional credentials or permissions. If server policy or branch protection refuses direct publication, report the blocker; never bypass it. Automations and their descendants keep their existing publication restrictions.",
      "",
      buildConflictNote(repo.defaultBranch),
    ].join("\n");
  }
  const cs = repo.host === "codestorage";
  return [
    "## Branch discipline (shared worktree)",
    `You are working in \`${worktreeDir}\` on branch \`${branch}\`. Other sessions in this workspace share this exact worktree and branch — commits you don't recognize are their work, not noise.`,
    `Stay on \`${branch}\`: never create or switch branches, and never drop, reset away, or cherry-pick around sibling commits. Commit your changes on this branch and push with \`git push -u origin ${branch}\`.`,
    `When the user asks to rebase onto the trunk, do it: \`git rebase origin/<default branch>\` keeps every sibling commit, so it is allowed. First make sure no other session has a rebase or merge in progress (no \`rebase-merge\`, \`rebase-apply\`, or \`MERGE_HEAD\` under \`git rev-parse --git-dir\`) and commit or leave untouched any uncommitted work, then push the rewritten branch with \`git push --force-with-lease origin ${branch}\`. Do not rebase, force-push, or otherwise rewrite the branch unless the user asked for it in the current conversation.`,
    cs
      ? `Commit and push your branch with \`git push -u origin ${branch}\` — this repo is hosted on Code Storage; there is no gh CLI and no pull requests; a pushed branch IS the change request. Never merge it into the default branch yourself.`
      : `This workspace keeps ONE pull request: if an open PR for \`${branch}\` already exists, pushing updates it — do not open another. Only run \`gh pr create\` when the branch has no open PR. Never merge a pull request unless the user explicitly asks in the current conversation to merge that specific pull request. A positive review (including 5/5, no blocking findings, or “safe to merge”), passing checks, pull request ownership, or a request to create, update, review, or babysit a pull request does not authorize merging it.`,
    cs
      ? "Only deviate from this (a separate branch) when the user explicitly asks for it."
      : "Only deviate from this (separate branch or separate PR) when the user explicitly asks for it.",
    // A stacked branch follows its base branch, not the trunk (buildStackNote).
    ...(input.stacked ? [] : ["", buildConflictNote(repo.defaultBranch)]),
  ].join("\n");
}

/**
 * System-prompt note for a session whose worktree was branched off ANOTHER
 * session's branch rather than the trunk. Its diff is only reviewable against
 * that branch, so its PR must target it, and GitHub's stacked PRs then give the
 * pair a real stack. Code Storage has no PRs and no stacks: the relationship is
 * a branch cut from another branch, so the note reduces to push discipline.
 */
export function buildStackPublicationNote(input: {
  base: string;
  branch: string;
  codeStorage: boolean;
}): string {
  const { base, branch } = input;
  if (input.codeStorage) {
    return [
      "## Stacked branch",
      `This branch was cut from \`${base}\` (another session's branch), not from the trunk — its commits sit ON TOP of that work, and a diff against the trunk would show both.`,
      `Commit and push your branch with \`git push -u origin ${branch}\` — this repo is hosted on Code Storage; there is no gh CLI and no pull requests; a pushed branch IS the change request. When reviewing the diff, compare against \`${base}\`, not the default branch.`,
      `Never merge \`${base}\` into this branch to "catch up" — it moves under you as its own review updates — and never merge either branch yourself; the human merges.`,
    ].join("\n");
  }
  return [
    "## Stacked branch",
    `This branch was cut from \`${base}\` (another session's branch), not from the trunk — its commits sit ON TOP of that work, and a diff against the trunk would show both.`,
    `Open your PR against that branch: \`gh pr create --base ${base}\`. Never retarget it at the default branch, and never merge \`${base}\` into this branch to "catch up" — it moves under you as its own PR updates.`,
    `Once both PRs exist, register them as a GitHub stack so each is reviewed on its own diff and the bases rebase themselves as layers merge: \`gh stack link <base-PR-url> <your-PR-url>\` (bottom first, run from this worktree). If that reports \`unknown command "stack"\`, don't retry or try to install it — just say so; the PR's base is what matters, and the Stack card in the PR tab links it in one click.`,
    "Never merge either PR — the human merges the stack.",
  ].join("\n");
}

/**
 * The run-level publication section of the system prompt. Code Storage swaps
 * the PR flow for push-the-branch; everything else names the attribution
 * rules and defers branching to the per-session note above.
 */
export function buildRunPublicationSection(input: {
  repoHost?: "github" | "codestorage";
  prReviewer?: string;
}): string[] {
  if (input.repoHost === "codestorage")
    return [
      "## Code Storage\nCommit and push the branch; a pushed branch is the change request. " +
        "Do not merge it or use `gh pr create`.",
    ];
  return [
    "## Pull requests\nEnd each PR body with the attribution footer from the session " +
      "context and follow its assignee rule. Add the commit trailers from the session " +
      "context to every commit, each on its own line at the end of the message. Follow repository branching and publication rules.",
    ...(input.prReviewer
      ? [
          `For a PR this unattended automation creates, request \`${input.prReviewer}\` as reviewer. Never add this automatic reviewer to an existing PR or a human-steered PR. If the request fails, mention it in the final response.`,
        ]
      : []),
  ];
}

/**
 * Shipping rules for a code goal's wake prompt. A goal runs unattended across
 * wakes, so it keeps the change-request flow even on a direct repository: only
 * a shared-checkout repository, which already lives on the default branch,
 * pushes there.
 */
export function buildGoalShippingInstructions(input: {
  repo: Pick<Repo, "defaultBranch" | "host" | "sharedCheckout">;
  cwd: string;
}): string {
  const { repo, cwd } = input;
  const branchLabel = JSON.stringify(repo.defaultBranch);
  const branchArg = shellQuoteWord(repo.defaultBranch);
  const remoteRefArg = shellQuoteWord(`origin/${repo.defaultBranch}`);
  if (repo.sharedCheckout) {
    // Shared-checkout repos (opensession) have NO isolated worktree — `cwd` is
    // the live main checkout the running server and every other session share.
    // A `git checkout -B`/`reset`/`pull` here yanks the working tree out from
    // under everyone and orphans their un-pushed commits, so forbid it.
    return `Shipping code: you are in the SHARED, live main checkout at ${cwd} on branch ${branchLabel}. The running server and other sessions use this exact working tree at the same time. NEVER create or switch branches, \`reset\`, \`pull\`, \`stash\`, or \`checkout\` (that rips the tree out from under everyone and orphans their commits). Just edit files, then \`git add <your specific files>\` → \`git commit\` → \`git push origin ${branchArg}\`. Commit + push frequently. No feature branch and no PR. This repo ships directly from branch ${branchLabel}.`;
  }
  if (repo.host === "codestorage")
    return `Shipping code: you are in a persistent worktree at ${cwd} (kept stable across wakes so your session resumes cleanly). For each change, start clean from the default branch (\`git fetch origin ${branchArg} && git checkout -B <feature-branch> ${remoteRefArg}\`), make edits, follow the repo's AGENTS.md and run its checks/format, then commit and push your branch with \`git push -u origin <feature-branch>\`. This repo is hosted on Code Storage; there is no gh CLI and no pull requests; a pushed branch IS the change request. NEVER merge into branch ${branchLabel}. The merge is the human gate.`;
  return `Shipping code: you are in a persistent worktree at ${cwd} (kept stable across wakes so your session resumes cleanly). For each change, start clean from the default branch (\`git fetch origin ${branchArg} && git checkout -B <feature-branch> ${remoteRefArg}\`), make edits, follow the repo's AGENTS.md and run its checks/format, then open a PR with \`gh pr create --base ${branchArg}\`. NEVER merge. A PR is the human gate.`;
}

/**
 * The publication pieces of a security scan prompt. A scan is unattended: one
 * change request per finding, never a push to the default branch, whatever the
 * repository's ship mode.
 */
export interface ScanPublication {
  codeStorage: boolean;
  /** "push one fix branch" / "open one PR". */
  openOne: string;
  /** "branches" / "PRs". */
  plural: string;
  /** "fix branch" / "PR". */
  singular: string;
  /** What to do when no safe fix is known. */
  noFixStep: string;
  /** The commit/push/open step for a fix. */
  publishStep: string;
  /** "pushed branch names" / "PR links". */
  summaryLinks: string;
}

export function scanPublication(
  repo: Pick<Repo, "host" | "ghRepo" | "defaultBranch">,
  productName: string,
): ScanPublication {
  const cs = repo.host === "codestorage";
  const branchArg = shellQuoteWord(repo.defaultBranch);
  return {
    codeStorage: cs,
    openOne: cs ? "push one fix branch" : "open one PR",
    plural: cs ? "branches" : "PRs",
    singular: cs ? "fix branch" : "PR",
    noFixStep: cs
      ? 'push the branch with the finding writeup + recommended fix in the commit message and NO code change, and add "[needs-human-fix]" to the commit title'
      : 'open the PR with the finding writeup + recommended fix and NO code change, and add "[needs-human-fix]" to the title',
    publishStep: cs
      ? `Commit with message "[deepsec][scan] <concise title>" plus a body covering finding, impact, fix, severity (note: generated by an on-demand ${productName} security scan via vercel-labs/deepsec), then push the branch with \`git push -u origin deepsec-scan-<short-slug>\`. This repo is hosted on Code Storage; there is no gh CLI and no pull requests; a pushed branch IS the change request. One branch per finding. NEVER merge.`
      : `Commit, push, then \`gh pr create --repo ${repo.ghRepo} --base ${branchArg} --title "[deepsec][scan] <concise title>" --body "<finding, impact, fix, severity; note: generated by an on-demand ${productName} security scan via vercel-labs/deepsec>"\`. One PR per finding. NEVER run \`gh pr merge\`.`,
    summaryLinks: cs ? "pushed branch names" : "PR links",
  };
}

// ── Ship actions (the Changes tab's buttons) ─────────────────────────────

export { MAX_SHIP_ACTIONS, parseShipActions, type ShipAction };

/** Where the session's checkout sits relative to the default branch. */
export type ShipCheckout = "worktree" | "shared";

export interface ShipPromptInput {
  repo: Pick<Repo, "id" | "defaultBranch" | "host">;
  mode: ShipMode;
  checkout: ShipCheckout;
  /** The workspace branch's open PR, when it has one. */
  openPr?: { number: number };
}

/**
 * The message the Ship button sends to the session's agent. Direct: check,
 * integrate the default branch, fast-forward push to it, then watch the
 * rollout. PR: open the workspace's one PR, or push to update it.
 */
export function buildShipPrompt(input: ShipPromptInput): string {
  const trunk = input.repo.defaultBranch;
  if (input.checkout === "shared")
    return [
      `Ship this session's changes to \`${trunk}\` from the shared checkout, following the repository's shared-checkout publication rules:`,
      "1. Review your own changes and stop to ask me if anything unfinished or unrelated would land.",
      "2. Run the repository's required checks and fix any failure.",
      `3. Sync with \`origin/${trunk}\` the way the repository's instructions require, stage only your own files, inspect the staged diff, and commit.`,
      `4. Push to \`${trunk}\` with a normal fast-forward push. If it is rejected because the remote moved, sync, check, and try again; never force-push.`,
      "5. If the repository deploys from the default branch, watch the rollout and its health checks and report the result.",
      "Report the pushed commit(s) when you are done.",
    ].join("\n");
  if (input.mode === "direct")
    return [
      `Ship this workspace's changes directly to \`${trunk}\`:`,
      `1. Review the complete diff against \`origin/${trunk}\`, including sibling commits and uncommitted work. Stop and ask me if anything unfinished or unrelated would land.`,
      "2. Commit any remaining work, staging only this workspace's changes.",
      "3. Run the repository's required checks and fix any failure.",
      `4. \`git fetch origin\` and integrate \`origin/${trunk}\` following your branch discipline (merge, never rewrite history). Rerun the checks if anything changed.`,
      `5. Publish with a normal fast-forward \`git push origin HEAD:refs/heads/${trunk}\`. If it is rejected because the remote moved, fetch, integrate, check, and try again; never force-push.`,
      `6. If the repository deploys from \`${trunk}\`, watch the rollout and its health checks and report the result.`,
      "Report the pushed commit(s) when you are done.",
    ].join("\n");
  if (input.repo.host === "codestorage")
    return "Commit any remaining work, run the relevant checks, and push the branch. A pushed branch is the change request here, so don't merge it.";
  if (input.openPr)
    return `Commit any remaining work, run the relevant checks, and push the branch to update PR #${input.openPr.number}. Then summarize what changed in this update. Don't merge it.`;
  return "Commit any remaining work, push the branch, and open a PR for it.";
}

export interface ShipActionsInput extends ShipPromptInput {
  custom?: readonly ShipAction[];
}

export interface ShipButton {
  id: string;
  label: string;
  prompt: string;
  primary?: boolean;
}

/** Ship first, then the repository's own buttons. */
export function buildShipButtons(input: ShipActionsInput): ShipButton[] {
  const prFlow = input.mode === "pull-request" && input.checkout !== "shared";
  const ship: ShipButton = {
    id: "ship",
    label: prFlow
      ? input.repo.host === "codestorage"
        ? "Push branch"
        : input.openPr
          ? "Update PR"
          : "Create PR"
      : "Ship",
    prompt: buildShipPrompt(input),
    primary: true,
  };
  return [
    ship,
    ...(input.custom || []).map((action, index) => ({
      id: `custom-${index}`,
      label: action.label,
      prompt: action.prompt,
    })),
  ];
}
