/**
 * Longest a single `git fetch` may run. Fetches run inside `withGitLock`, which
 * serializes every worktree operation on a repository, so one transfer that
 * never finishes (an SSH connection that stays open but sends nothing) would
 * otherwise queue every later worktree for that repository until session setup
 * times out. Incremental fetches take seconds; this leaves room for several
 * failed ones inside the 10-minute session setup budget.
 */
export const GIT_FETCH_TIMEOUT_SECONDS = 120;

/** Exit code of a fetch that `timeout` stopped. */
export const GIT_FETCH_TIMED_OUT_EXIT_CODE = 124;

/**
 * argv for `git -C <dir> fetch <args>` bounded by coreutils `timeout`, which
 * signals its whole process group, so the `ssh` transport exits too. A
 * timed-out fetch exits 124 and callers see an ordinary fetch failure.
 */
export function gitFetchArgv(
  dir: string,
  args: string[],
  timeoutSeconds = GIT_FETCH_TIMEOUT_SECONDS,
): string[] {
  return [
    "timeout",
    "--kill-after=10",
    String(timeoutSeconds),
    "git",
    "-C",
    dir,
    "fetch",
    ...args,
  ];
}
