/**
 * Longest a single `git fetch` may run. Fetches run inside `withGitLock`, which
 * serializes every worktree operation on a repository, so one transfer that
 * never finishes (an SSH connection that stays open but sends nothing) would
 * otherwise queue every later worktree for that repository until session setup
 * times out.
 */
export const GIT_FETCH_TIMEOUT_SECONDS = 300;

/**
 * argv for `git -C <dir> fetch <args>` bounded by coreutils `timeout`, which
 * signals its whole process group, so the `ssh` transport exits too. A
 * timed-out fetch exits 124 and callers see an ordinary fetch failure.
 */
export function gitFetchArgv(dir: string, args: string[]): string[] {
  return [
    "timeout",
    "--kill-after=10",
    String(GIT_FETCH_TIMEOUT_SECONDS),
    "git",
    "-C",
    dir,
    "fetch",
    ...args,
  ];
}
