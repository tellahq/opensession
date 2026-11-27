import type { SandboxStatusInfo } from "./api";
import type { RepoInfo } from "./api/repos";

export interface ProjectSandboxOverride {
  repoId: string;
  label: string;
  provider: string;
}

/**
 * Projects whose Sandbox environment explicitly overrides the workspace
 * default (`value !== "workspace"`), sorted by display label.
 */
export function projectSandboxOverrides(
  defaults: SandboxStatusInfo["defaults"] | undefined,
  repos: readonly Pick<RepoInfo, "id" | "label">[],
): ProjectSandboxOverride[] {
  const byRepo = defaults?.repos;
  if (!byRepo) return [];
  const labelById = new Map<string, string>();
  for (const repo of repos) labelById.set(repo.id, repo.label || repo.id);
  const overrides: ProjectSandboxOverride[] = [];
  for (const [repoId, provider] of Object.entries(byRepo)) {
    if (!provider || provider === "workspace") continue;
    overrides.push({
      repoId,
      label: labelById.get(repoId) ?? repoId,
      provider,
    });
  }
  overrides.sort((a, b) => a.label.localeCompare(b.label));
  return overrides;
}

/**
 * Builds the prompt for the 1-click "Configure with agent" button in
 * Settings → Sandboxes so new Sandboxes boot with pre-cached dependencies.
 */
export function buildSandboxCachingPrompt(repoLabel: string): string {
  return [
    `Configure fast, cached Sandbox startup for ${repoLabel}.`,
    "",
    "1. Inspect the repository's package managers, lockfiles, build toolchains, and any existing `.agents/setup`, `.agents/resume`, or `.agents/portals.json`.",
    "2. Create or update `.agents/setup` (executable `#!/usr/bin/env bash` with `set -euo pipefail`) so it installs dependencies and warms build caches idempotently for prewarmed Sandbox snapshots.",
    "3. Only add `.agents/resume` if background services or runtime state must restart after a Sandbox wakes from sleep, and only add or update `.agents/portals.json` if the repository runs a dev server.",
    "4. Verify `.agents/setup` passes shell syntax checks (`bash -n`) and dry-runs cleanly, then summarize what it caches.",
  ].join("\n");
}
