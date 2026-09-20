/** Refresh ownership for ONE session at its turn boundary. Cross-session
 * consumers query the maintained catalog, never probe checkouts themselves. */
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { configuredRepos, getConfigAsync, type Repo } from "./config";
import { statePath } from "./paths";

/** Classify catalog-recorded paths without probing a fleet of checkouts.
 * Only registered isolated-worktree locations establish ownership. Unknown
 * paths (including remote Runner paths and legacy aliases) fail closed: they
 * may get independent workspaces, never be grouped by a guessed shared HEAD. */
export function catalogWorktreeOwnership(
  repos: Record<string, Repo>,
  worktreesDir: string,
): (dir: string | null | undefined) => string | null {
  const root = resolve(worktreesDir);
  const shared = new Set<string>();
  const prefixes: string[] = [];
  for (const repo of Object.values(repos)) {
    shared.add(resolve(repo.repo));
    shared.add(resolve(root, `${repo.wtPrefix}-ask-checkout`));
    prefixes.push(`${repo.wtPrefix}-`);
  }
  return (dir) => {
    if (!dir) return null;
    const path = resolve(dir);
    if (shared.has(path) || dirname(path) !== root) return null;
    return prefixes.some((prefix) => basename(path).startsWith(prefix))
      ? dir
      : null;
  };
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

export async function ownedWorktreeHeadBranch(
  dir: string | null | undefined,
): Promise<string | null> {
  if (!dir) return null;
  const config = await getConfigAsync();
  const repos = configuredRepos(config);
  const worktreesDir =
    process.env.OPENSESSION_WORKTREES_DIR ||
    config.paths?.worktreesDir ||
    statePath(".opensession/worktrees");
  const current = await canonical(dir);
  for (const repo of Object.values(repos)) {
    if (
      current === (await canonical(repo.repo)) ||
      current ===
        (await canonical(`${worktreesDir}/${repo.wtPrefix}-ask-checkout`))
    )
      return null; // shared HEAD is not any one session's ownership
  }
  try {
    let gitDir = `${dir}/.git`;
    if ((await stat(gitDir)).isFile()) {
      const pointer = (await readFile(gitDir, "utf-8")).match(
        /^gitdir: (.+)$/m,
      );
      if (!pointer) return null;
      gitDir = resolve(dir, pointer[1].trim());
    }
    return (
      (await readFile(`${gitDir}/HEAD`, "utf-8"))
        .match(/^ref: refs\/heads\/(.+)$/m)?.[1]
        .trim() || null
    );
  } catch {
    return null;
  }
}
