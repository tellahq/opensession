# Worktrees and disk

By default, a code workspace gets an isolated **git worktree**: a separate
working directory and index that shares the registered repository's object
database. Sessions in the same workspace can deliberately share its worktree;
a stacked session gets another branch and worktree. Unrelated branches do not
see each other's edits or contend over one index, and no second clone is needed.

This is also where much of the instance's disk usage goes.

## The shape

On a normal installation using the default worktree root:

```
~/projects/myapp                                  the repository you registered
~/.opensession/worktrees/myapp-fix-login          a code workspace on `fix-login`
~/.opensession/worktrees/myapp-add-metrics        another branch and worktree
~/.opensession/worktrees/myapp-ask-checkout       shared, read-only Ask checkout
```

`paths.worktreesDir` in `~/.opensession/config.json` decides where host
worktrees live. `OPENSESSION_WORKTREES_DIR` overrides it; the normal default is
`~/.opensession/worktrees`. An instance using `OPENSESSION_STATE_DIR` gets a
worktree root inside that state namespace unless either setting overrides it.
Directory names use the repository's configured `wtPrefix` and branch.

Fresh worktree setup is best-effort. Open Session first tries to seed a ready
warm template, then runs `.agents/setup` or the configured `worktreeSetup`
fallback. It next runs the configured `depsInstall`, or `bun install` when the
worktree root contains `package.json`. A failed setup skips the remaining steps
of that attempt but does not block the session. Interactive creation starts this
work in the background, so the first turn may begin before dependencies finish
installing.

Commit `.agents/setup` and `.agents/start.sh` to let each workspace provision
itself and boot its dev server on demand. This also lets an agent open its own
change in a browser. See [repo-lifecycle.md](repo-lifecycle.md).

## Modes

**`code` sessions** have write access. This is the default. A new code workspace
normally follows its repository setting, while each person can override each
repository under **Preferences** with **Local checkout** or **Separate worktree**.
Additional sessions in an existing workspace keep its worktree, and
a deliberately selected branch or pull request stays isolated. Worktree sessions
can commit and use the repository's configured pull-request flow.

**`ask` sessions** are read-only. For an isolated repository they share one
per-repo detached checkout (`<wtPrefix>-ask-checkout`) pinned to
`origin/<defaultBranch>`. Open Session refreshes an existing Ask checkout at
most every five minutes. A shared-checkout repository uses its main checkout
instead. Repo-less Ask sessions use a non-git scratch directory.

**Attached repos.** A code session can attach additional repositories. Each
gets an isolated worktree using the session's branch name, and may be reused by
another owner of that branch. Ask sessions and remote or volume-backed Sandbox
workspaces cannot attach repositories. A repository configured as a shared
checkout cannot itself be attached unless shared-checkout behavior has been
disabled.

Remote Sandbox providers, and Docker configured with a `volume` workspace, clone
inside provider-owned storage and create no host worktree. Docker `bind`
workspaces use the host worktree described here. The low-level schema defaults
to `bind`, but `opensession sandbox enable docker` currently configures
`volume`. Provider-owned cleanup is separate, and destroying a volume workspace
deletes any work not pushed elsewhere. See
[self-hosting-sandboxes.md](self-hosting-sandboxes.md).

## The shared-checkout exception

A repository can set `sharedCheckout: true`, making new interactive code
sessions work directly in its registered main checkout. The built-in Open
Session repository uses this mode by default. Note that the live services run
from an immutable release, so an edit in the shared checkout is not live until
it is committed, pushed, and deployed. Settings → Repositories exposes the choice as **Use
isolated worktrees**; changing it affects new sessions, while existing sessions
keep their recorded checkout. The top-level `selfDev: "worktree"` setting also
opts Open Session self-development into isolated worktrees. PR-branch sessions,
code automations, and other explicitly isolated runs still use worktrees.

This is a deliberate trade with sharp edges. In a shared checkout:

- **Only `add` → `commit` → `push`.** Never run `git reset --hard`,
  `git checkout .`, `git revert`, or switch branches. Those operations can
  replace files under the running server and every other session.
- **Stage specific files, never `git add -A`.** Other sessions may have changes
  in the same tree. Inspect the staged diff before committing.
- **Commit and push often.** Keep shared uncommitted work brief and coordinate
  changes to the same file.
- **Keep `main` at `origin/main` with `bun scripts/shared-checkout-sync.ts`.**
  A plain `git pull --ff-only` refuses the checkout as soon as one dirty file
  overlaps an upstream commit, and nobody may discard another session's edit,
  so without a tool the branch drifts behind for everyone. The sync tool
  fetches, follows upstream for clean paths, adopts local edits that already
  landed upstream, three-way merges genuine local edits onto the new base
  (index and worktree separately, with a copy of the pre-merge file under
  `.git/shared-checkout-sync/`), leaves conflicting edits untouched and lists
  them, then moves the branch with a compare-and-swap. Exit code 2 means the
  branch is current but listed edits still sit on the old base and must be
  reapplied by their owner before staging. It never touches untracked files or
  other branches, and it refuses to run when local commits are unpushed.

If sessions do not need to edit the running checkout, use isolated worktrees.

## What cleans up automatically

### Rust build-cache GC

`packages/core/opensession-server/src/server/disk-gc.ts` starts five minutes
after the server and runs hourly by default. It only finds Cargo `target/`
directories marked by `CACHEDIR.TAG`, under host worktrees:

- Caches with no recent entry for more than 7 days are reclaimed unless an
  active build process is using their worktree.
- At 80% usage on the root filesystem, remaining caches are reclaimed oldest
  first until usage falls below 70%. The normal pressure pass protects caches touched in
  the last 24 hours; if usage remains at least 80%, a final pass can reclaim
  caches idle for more than 2 hours.

The sweep reads `/proc` on Linux and uses `ps` plus `lsof` on macOS. It skips
everything if it cannot determine which worktrees contain live build
processes. It protects Ask checkouts and warm infrastructure. It does not
remove worktrees, branches, commits, `node_modules`, or non-Rust build output.

Disable it with `OPENSESSION_DISK_GC=0`. The thresholds and cadence can be
overridden at startup with `OPENSESSION_DISK_GC_COLD_DAYS`,
`OPENSESSION_DISK_GC_HOT_HOURS`, `OPENSESSION_DISK_GC_URGENT_HOT_HOURS`,
`OPENSESSION_DISK_GC_PRESSURE_PCT`, `OPENSESSION_DISK_GC_RELIEF_PCT`, and
`OPENSESSION_DISK_GC_INTERVAL_MS`.

### Worktree reaping and parking

`packages/core/opensession-server/src/server/worktree-reaper.ts` starts after
ten minutes and runs hourly. It removes a checkout when its branch tip is in
the remote default branch or its pull request is merged or closed, but protects
worktrees used by a live process and sessions active within the last 6 hours.
It also parks session-owned checkouts after 7 days without session activity,
or after 24 hours when every owner is an automation. Branch and session records
remain. A later prompt recreates a missing primary worktree; a parked attached
repository may need to be attached again.

Dirty files and local-only commits do not necessarily keep a reaped or parked
checkout on disk. Before removal, the reaper banks tracked changes, non-ignored
untracked files, and unpushed commits under the Open Session `parked-work` state directory.
If banking fails, or the untracked payload exceeds 1 GiB by default, it keeps
the worktree. Banked state is retained for 90 days by default and is not
reapplied automatically; its `metadata.json`, patch, tarball, and git bundle
are the recovery material.

The reaper skips the entire pass when `/proc` is unavailable. Disable it with
`OPENSESSION_WORKTREE_REAPER=0`. Tune it with
`OPENSESSION_WORKTREE_IDLE_DAYS`, `OPENSESSION_WORKTREE_ACTIVE_HOURS`,
`OPENSESSION_WORKTREE_AUTOMATION_IDLE_HOURS`,
`OPENSESSION_WORKTREE_BANK_MAX_MB`, and
`OPENSESSION_PARKED_WORK_RETENTION_DAYS`.

A separate six-hour sweep removes eligible clean primary worktrees in the
default repository for non-running sessions archived and inactive for more than
14 days. It refuses worktrees with uncommitted files or commits absent from
every remote. Ask checkouts, warm
infrastructure, independent clones, detached worktrees, and unregistered healthy
worktrees are protected from the hourly reaper.

## What still uses disk

The repository's object database and history are shared by all its worktrees.
Most generated files are not shared. In retained worktrees, the common large
entries are:

1. **Rust `target/` directories.** These can reach tens or hundreds of
   gigabytes. A shared `sccache` or deliberate `CARGO_TARGET_DIR` strategy can
   reduce duplication, while the automatic GC handles stale Cargo caches.
2. **Other build output**, such as `dist`, `.next`, and `build`. Open Session
   removes these only when it removes the whole worktree.
3. **`node_modules`.** The GC deliberately leaves it alone. With Bun's default
   install, package files are hardlinked into a shared store, so summing
   per-worktree `du` results double-counts shared inodes and can greatly
   overstate the space that deletion would free.

## Cleaning up by hand

The examples below use the normal default root. Replace `WT_ROOT` if
`paths.worktreesDir`, `OPENSESSION_WORKTREES_DIR`, or
`OPENSESSION_STATE_DIR` changes it.

```sh
WT_ROOT=~/.opensession/worktrees

# what exists, and apparent size per entry
# (the sum can overcount hardlinked package files)
du -sh "$WT_ROOT"/* | sort -h | tail -20

# inspect a candidate for uncommitted and local-only work
WT="$WT_ROOT/myapp-old-branch"
git -C "$WT" status --short
git -C "$WT" log --oneline HEAD --not --remotes

# remove it through its registered repository so Git's registry stays correct
git -C ~/projects/myapp worktree remove "$WT"

# forget registrations whose directories are already gone
git -C ~/projects/myapp worktree prune
```

Deleting a worktree directory with `rm -rf` leaves Git believing it still
exists. `git worktree prune` repairs that registry, but `git worktree remove`
avoids the problem.

Before removal, confirm in Open Session that no session using the workspace is
running, stop its previews and Portals, and check for live processes with
`lsof +D "$WT"`. `opensession status` reports only the service manager's state;
it does not report running sessions or worktree use.
