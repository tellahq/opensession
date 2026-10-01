/**
 * The fully qualified remote-tracking ref for `branch` on `origin`.
 *
 * Git resolves a bare `origin/<branch>` by trying `refs/<name>`,
 * `refs/tags/<name>`, `refs/heads/<name>` and only then
 * `refs/remotes/<name>`. One stray LOCAL branch literally named
 * `origin/main` (a `git fetch origin main:origin/main` typo creates it)
 * therefore makes `rev-parse origin/main` silently answer with the local
 * branch, and makes `git worktree add -b … origin/main` refuse outright with
 * "ambiguous object name". Every worktree of the shared checkout inherits the
 * same refs, so one typo took down every new session and automation on that
 * repository (2026-09-09). Naming the ref in full sidesteps the lookup order,
 * and Git still treats it as a remote-tracking branch for upstream setup.
 */
export function remoteRef(branch: string): string {
  return `refs/remotes/origin/${branch}`;
}
