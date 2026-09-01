import { realpathSync } from "fs";
import { basename, isAbsolute, resolve } from "path";
import { fileURLToPath } from "url";
import { parseCsRemote } from "../codestorage/remote";

async function git(
  args: string[],
  cwd?: string,
): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(["git", ...args], {
    ...(cwd ? { cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(9), 30_000);
  const [exitCode, stdout] = await Promise.all([
    proc.exited.finally(() => clearTimeout(timeout)),
    new Response(proc.stdout).text(),
  ]);
  return { exitCode, stdout: stdout.trim() };
}

export function repoIdFromName(input: string): string {
  const name = basename(
    input
      .replace(/[\\/]+$/, "")
      .replace(/\.git$/i, "")
      .replace(/^.*:/, ""),
  );
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return id || "repo";
}

function remotePathIdentity(path: string): string {
  return path
    .replace(/^\/+/, "")
    .replace(/[\\/]+$/, "")
    .replace(/\.git$/i, "");
}

function localOriginIdentity(path: string, cwd?: string): string {
  const resolved = isAbsolute(path)
    ? path
    : resolve(cwd || process.cwd(), path);
  let canonical = resolved;
  try {
    canonical = realpathSync(resolved);
  } catch {
    // Missing remotes still get a stable absolute identity.
  }
  return `file:${canonical.replace(/[\\/]+$/, "").replace(/\.git$/i, "")}`;
}

/** Protocol- and credential-free origin identity used only for duplicate checks. */
export function normalizeRepoOrigin(remote: string, cwd?: string): string {
  const value = remote.trim();
  if (!value) return "";

  if (value.includes("://")) {
    try {
      const url = new URL(value);
      if (url.protocol === "file:") {
        return localOriginIdentity(fileURLToPath(url), cwd);
      }
      if (url.hostname) {
        const host = `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}`;
        return `${host}/${remotePathIdentity(url.pathname)}`;
      }
    } catch {
      // Fall through to Git's scp-like and local-path forms.
    }
  }

  const scp = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scp) return `${scp[1].toLowerCase()}/${remotePathIdentity(scp[2])}`;
  return localOriginIdentity(value, cwd);
}

function githubRepoFromRemote(remote: string): string | undefined {
  const normalized = remote.trim().replace(/\.git$/i, "");
  const match = normalized.match(
    /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+)$/i,
  );
  return match?.[1];
}

function defaultBranchFromLsRemote(output: string): string | undefined {
  return output.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/m)?.[1];
}

async function hasCommit(path: string, ref: string): Promise<boolean> {
  return (
    (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], path))
      .exitCode === 0
  );
}

export async function repoOriginIdentity(
  repoPath: string,
): Promise<string | null> {
  try {
    const origin = await git(["remote", "get-url", "origin"], repoPath);
    if (origin.exitCode !== 0 || !origin.stdout) return null;
    return normalizeRepoOrigin(origin.stdout, repoPath) || null;
  } catch {
    return null;
  }
}

export async function inspectRepo(repoPath: string): Promise<{
  path: string;
  defaultBranch: string;
  originIdentity: string;
  ghRepo?: string;
  cs?: { org: string; repoId: string };
}> {
  const root = await git(["rev-parse", "--show-toplevel"], repoPath);
  if (root.exitCode !== 0 || !root.stdout)
    throw new Error("Path is not a Git repository");
  const path = realpathSync(root.stdout);
  const [origin, remoteSymref, remoteHead, localHead] = await Promise.all([
    git(["remote", "get-url", "origin"], path),
    git(["ls-remote", "--symref", "origin", "HEAD"], path),
    git(
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      path,
    ),
    git(["symbolic-ref", "--quiet", "--short", "HEAD"], path),
  ]);
  if (origin.exitCode !== 0 || !origin.stdout) {
    throw new Error("Repository must have an origin remote");
  }

  const defaultBranch =
    defaultBranchFromLsRemote(remoteSymref.stdout) ||
    remoteHead.stdout.replace(/^origin\//, "") ||
    localHead.stdout;
  if (!defaultBranch) {
    throw new Error(
      "Could not determine origin's default branch. Fetch the repository and set origin/HEAD, then try again",
    );
  }

  const remoteRef = `refs/remotes/origin/${defaultBranch}`;
  if (!(await hasCommit(path, remoteRef))) {
    await git(
      [
        "fetch",
        "--quiet",
        "origin",
        `+refs/heads/${defaultBranch}:${remoteRef}`,
      ],
      path,
    );
  }
  if (!(await hasCommit(path, remoteRef))) {
    const [remoteBranches, localCommit] = await Promise.all([
      git(["ls-remote", "--heads", "origin"], path),
      git(["rev-list", "--all", "--max-count=1"], path),
    ]);
    const emptyRepository =
      remoteBranches.exitCode === 0 &&
      !remoteBranches.stdout &&
      localCommit.exitCode === 0 &&
      !localCommit.stdout;
    if (!emptyRepository)
      throw new Error(
        `Repository must have a commit on origin/${defaultBranch}`,
      );
  }

  const cs = parseCsRemote(origin.stdout);
  return {
    path,
    defaultBranch,
    originIdentity: normalizeRepoOrigin(origin.stdout, path),
    ghRepo: githubRepoFromRemote(origin.stdout),
    ...(cs ? { cs } : {}),
  };
}

/** Whether a candidate default branch currently exists on origin. */
export async function repoHasBranch(
  repoPath: string,
  branch: string,
): Promise<boolean> {
  return (
    (
      await git(
        [
          "ls-remote",
          "--exit-code",
          "--heads",
          "origin",
          `refs/heads/${branch}`,
        ],
        repoPath,
      )
    ).exitCode === 0
  );
}

export async function repoCurrentBranch(
  repoPath: string,
): Promise<string | null> {
  const current = await git(["branch", "--show-current"], repoPath);
  return current.exitCode === 0 && current.stdout ? current.stdout : null;
}
