/** Shared identifiers for the github PR agent. */

import {
  configuredIntegration,
  configuredRepos,
  defaultRepo,
  type Repo,
} from "../../server/config";

/**
 * The configured repo a webhook's `repository.full_name` belongs to, or null.
 * Events for unconfigured repos are dropped — the GitHub-side webhook config
 * is the outer gate, this is the inner one. Multi-repo: any repo in the
 * config registry participates once its GitHub webhook points here.
 */
export function repoForFullName(
  fullName: string | null | undefined,
): Repo | null {
  const lower = (fullName || "").trim().toLowerCase();
  if (!lower) return null;
  return (
    Object.values(configuredRepos()).find(
      (r) => r.ghRepo && r.ghRepo.toLowerCase() === lower,
    ) || null
  );
}

/**
 * Repo-qualified key for per-PR state files, locks, session ids, and
 * workspace keys. The DEFAULT repo keeps the bare PR number — back-compat
 * with every existing state file, `bks-ghpr-N-*` session, and `ghpr-N`
 * workspace — while other repos prefix their registry id.
 */
export function prKey(prNumber: number, ghRepo?: string | null): string {
  if (!ghRepo || ghRepo.toLowerCase() === defaultRepo().ghRepo.toLowerCase()) {
    return String(prNumber);
  }
  const id =
    repoForFullName(ghRepo)?.id || ghRepo.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${id}-${prNumber}`;
}

/** Internal/automation event key — the seeded automation subscribes to this. */
export const PR_EVENT_KEY = "github:pull_request";
/** Name of the seeded (disabled-by-default) review automation. */
export const REVIEW_AUTOMATION_NAME = "github-pr-review";

/** Internal event key published when a PR is merged into a registered repo. */
export const PR_MERGED_EVENT_KEY = "github:pr_merged";
/** Name of the seeded docs-sync automation (fires on PR merge). */
export const DOCS_SYNC_AUTOMATION_NAME = "docs-sync";
/** Branch prefix for docs-sync's own PRs — skipped on merge so it can't loop. */
export const DOCS_SYNC_BRANCH_PREFIX = "auto-docs-sync-";
/**
 * Slack channel where docs-sync announces the PRs it opens
 * (`integrations.github.docsSyncChannel`). Undefined when unconfigured — the
 * announcement is an optional courtesy, so docs-sync still runs without it.
 */
export function docsSyncChannel(): string | undefined {
  const configured = configuredIntegration("github").docsSyncChannel;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : undefined;
}

/** Slack channel where merged visual changes are shared with their walkthrough screenshot. */
export function shippedChangesChannel(): string | undefined {
  const configured = configuredIntegration("github").shippedChangesChannel;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : undefined;
}

/** PR trigger labels. */
export const LABEL_REVIEW = "os-review";
export const LABEL_AUTOFIX = "os-auto-fix";
export const LABEL_SIMPLIFY = "os-simplify";
export const LABEL_ADVERSARIAL = "os-adversarial";

export function labelMatches(name: string, expected: string): boolean {
  return name === expected;
}

export function labelAliases(label: string): string[] {
  return [label];
}
