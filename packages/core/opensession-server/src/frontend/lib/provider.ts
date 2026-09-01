/**
 * Provider-agnostic naming for the code-review UI. Open Session talks to GitHub
 * and code.storage today, but the UI copy shouldn't hardcode a vendor — it
 * derives the provider from a PR's URL host so the same components read
 * correctly wherever a repo lives, and so the generic surfaces (the sidebar
 * tab, the Reviews module) can just say "code review" / "pull request".
 */

import type { PrHostCapabilities } from "./types";

export interface Provider {
  /** Stable key: github | gitlab | bitbucket | codestorage | git (unknown host). */
  key: string;
  /** Display name for "Open on <name>": GitHub, GitLab, Bitbucket, Code Storage, or "the provider". */
  name: string;
  /** What this provider calls a change: "pull request" / "merge request". */
  changeNoun: string;
  /** Abbreviated change noun for chips: "PR" / "MR". */
  changeAbbr: string;
}

const GITHUB: Provider = {
  key: "github",
  name: "GitHub",
  changeNoun: "pull request",
  changeAbbr: "PR",
};
const GITLAB: Provider = {
  key: "gitlab",
  name: "GitLab",
  changeNoun: "merge request",
  changeAbbr: "MR",
};
const BITBUCKET: Provider = {
  key: "bitbucket",
  name: "Bitbucket",
  changeNoun: "pull request",
  changeAbbr: "PR",
};
// code.storage has no PR concept — a "change" is a branch reviewed against the
// default branch, so the noun stays generic rather than borrowing GitHub's.
const CODESTORAGE: Provider = {
  key: "codestorage",
  name: "Code Storage",
  changeNoun: "change",
  changeAbbr: "CR",
};
const GENERIC: Provider = {
  key: "git",
  name: "the provider",
  changeNoun: "pull request",
  changeAbbr: "PR",
};

/**
 * Infer the provider from a PR/MR URL. Defaults to GitHub — it's the main
 * backend wired up, so a missing/opaque URL should still read as GitHub rather
 * than the vague "the provider".
 */
export function providerFromUrl(url: string | null | undefined): Provider {
  if (!url) return GITHUB;
  let host = "";
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    host = url.toLowerCase();
  }
  // Org-scoped hosts: <org>.code.storage (and api.<org>.code.storage).
  if (host === "code.storage" || host.endsWith(".code.storage"))
    return CODESTORAGE;
  if (host.includes("gitlab")) return GITLAB;
  if (host.includes("bitbucket")) return BITBUCKET;
  if (host.includes("github")) return GITHUB;
  // Unknown self-hosted host: assume GitHub Enterprise (the supported backend)
  // rather than the anonymous fallback.
  return url ? GITHUB : GENERIC;
}

/** Avatar URL for a login on the given provider. GitHub serves `/<login>.png`;
 * code.storage has no user accounts, so there is nothing to point at. */
export function avatarUrl(
  login: string,
  provider: Provider,
  size = 40,
): string | null {
  if (!login) return null;
  if (provider.key === "github")
    return `https://github.com/${encodeURIComponent(login)}.png?size=${size}`;
  return null;
}

const ALL_CAPABILITIES: PrHostCapabilities = {
  checks: true,
  reviewers: true,
  viewedState: true,
  stacks: true,
  reviewComments: true,
  prCreate: true,
  images: true,
  // Off in the fallback: absent capabilities means GitHub, which has no
  // commit-notes concept — only a payload that explicitly says "yes"
  // (code.storage) turns the annotation block on.
  commitNotes: false,
};

/**
 * Effective host capabilities for a PR payload. Absent means GitHub or a cache
 * entry that predates the field — everything on, so the GitHub UI never
 * regresses; only payloads that explicitly say "no" hide a surface.
 */
export function prCapabilities(
  caps?: PrHostCapabilities | null,
): PrHostCapabilities {
  return caps ?? ALL_CAPABILITIES;
}
