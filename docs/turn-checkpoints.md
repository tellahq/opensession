# Turn checkpoints

In a local code worktree, the web transcript's answer footer has **Changes in
this turn** and **Revert…** actions. Changes shows the exact Git snapshot diff,
including tracked and non-ignored untracked files, rather than estimating changes
from tool calls.

**Revert to before this turn** previews every file that would change. Confirming
restores the working files and branches the Pi conversation to its pre-turn
position. The original conversation and transcript rows are retained for audit;
reverted transcript entries are dimmed and a visible notice marks the operation.
Later turns are reverted too. This is not a Git reset: the branch, HEAD, commits,
and staging index stay unchanged. Ignored files are neither captured nor removed.

**Undo revert…** previews and restores the pre-revert files and conversation.
Undo is available only before new transcript activity and while its checkpoint
is retained. Both revert and undo refuse active runs, queued work, changed commits
or staged contents, and stale confirmation previews.

Checkpoints are local hidden Git refs, not pushed to a remote. Up to 50 recent
turn snapshots are retained per session; deletion of a session or managed
worktree cleans up its refs.
They are not backups. Do not publish these refs with a mirror push.

## Limitations

- Shared checkouts are skipped: their files belong to multiple sessions, not
  one turn. Another active or queued session in an isolated worktree also blocks
  restore. Unknown sibling activity fails closed.
- Remote runners, sandboxes, multi-repository restores, detached conversations,
  unborn repositories, submodules, and nested repositories are not supported.
- If the native Pi file or pre-turn entry is missing, restore is refused before
  any workspace files change. Changing engines can also make restore unavailable.
- Changing HEAD or staged contents requires resolving the work normally, not
  bypassing the guard. There is no "restore files only" override.
- Do not edit, commit, switch branches, or run other Git commands concurrently
  with restore. Sibling activity checks are advisory, not a repository-wide
  distributed lock. The per-session exclusion is durable.
- Older clients still show the ordinary system notice. The web client supports
  the new per-turn controls and dimmed history; native and extension controls are
  not added by this change.

## Interrupted restore

Opening the checkpoint dialog or next admitting work for that specific session
checks for an interrupted revert. Recovery restores the pre-revert snapshot and
leaves the original conversation selected. It never scans the actor fleet.

If commits, staged contents, or workspace files changed, recovery leaves the intent in place and
reports **Revert interrupted, needs attention**. New runs remain blocked. Resolve
the Git state and refresh the preview, or explicitly choose **Discard interrupted
revert…**. Discard keeps the current files and current conversation and unblocks
admission; inspect the workspace before continuing.

## Contributor invariants

`turn-workspace-checkpoint.ts` uses async subprocesses and temporary
`GIT_INDEX_FILE`s. It reuses index stat data when safe, includes non-ignored
untracked files, and refuses sparse/assume-unchanged blind spots, ignored-file
collisions, and nested repository snapshots. Capture errors are logged and never
fail a turn. Diffs are bounded to 4 MiB and Git subprocesses to 30 seconds.

The `revert` reducer owns the intent in actor metadata. Ordinary metadata writes
cannot create, clear, or alter a pending intent or switch its engine pointer.
Run-state transitions and queue dispatch refuse/hold while an intent exists;
new queue items remain durable. A central indexed worktree-activity projection
supports the best-effort sibling check without listing sessions or opening their
actor databases.

Completing a revert switches the Pi engine pointer, appends the audit marker,
updates active reverted ranges, and clears the intent in one transaction on the
same actor database connection. The derived session-file export is repaired
before run admission so legacy synchronous projections cannot resume the old
engine. Marker wakes remain actor-owned and replayable.

A new Pi JSONL file contains the exact native prefix through the captured leaf,
with a new engine id. The old file is never rewritten. Schema version 3 and the
leaf identity are checked before branching. Unlike an in-memory `branch()` call,
the new file survives reopening. No abandoned-path summary is injected into
model context. Engine handoffs and resume-miss bridges omit reverted rows.

The recovery phase named `files_restored` is written **before** restoring files.
It means files may have changed, not that restoration completed. This closes the
crash window between filesystem changes and recording their phase: recovery
restores the pre-revert ref for this phase when the tree is either the
original snapshot or the completed restore target. An unexpected/partial tree
fails closed rather than overwriting subsequent manual edits. `begun` means files have not
yet been touched. HEAD/index guards remain mandatory in recovery and undo.

Frontend requests, cancellation, typed errors, and payload decoding live in the
Effect v4 `turn-checkpoint-runtime.ts`. React owns only disclosure and rendering.
Destructive requests are never automatically retried after transport failure.

Prior art: the MIT-licensed [t3code checkpointing architecture](https://github.com/pingdotgg/t3code),
adapted to Open Session's actor ownership and local worktree invariants.
