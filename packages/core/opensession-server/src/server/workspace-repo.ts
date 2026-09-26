import { realpath } from "fs/promises";
import { canonicalRepoId, configuredRepos } from "./config";

/** Git's common directory identifies a checkout without trusting its name or remote URL. */
async function gitCommonDir(dir: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(
      [
        "git",
        "-C",
        dir,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      { stdout: "pipe", stderr: "ignore", timeout: 5_000 },
    );
    const output = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0 || !output.trim()) return undefined;
    return await realpath(output.trim());
  } catch {
    return undefined;
  }
}

/** Targeted, fail-closed evidence for repairing one materialized workspace.
 * No path-prefix inference, actor scans, or fallback to the instance default.
 * A missing/reaped or remote-only checkout cannot authorize a repair here.
 */
export async function workspaceCheckoutProvesRepo(
  worktreeDir: string,
  currentRepo: string | undefined,
  requestedRepo: string,
): Promise<boolean> {
  const repos = configuredRepos();
  const target = repos[canonicalRepoId(requestedRepo)];
  if (!target) return false;
  const current = currentRepo ? repos[canonicalRepoId(currentRepo)] : undefined;
  const [checkout, targetGit, currentGit] = await Promise.all([
    gitCommonDir(worktreeDir),
    gitCommonDir(target.repo),
    current ? gitCommonDir(current.repo) : undefined,
  ]);
  // Even duplicate registrations must not displace a real current owner.
  return !!checkout && checkout === targetGit && checkout !== currentGit;
}
