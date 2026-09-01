# Worktree cleanup

Audit worktrees and reclaim space without risking another session's work.

1. Read the repository and operator instructions. Shared live checkouts, active session worktrees, staged changes, untracked files, and branches owned by other sessions are protected.
2. Stay read-only for the first pass. Record disk usage and list worktrees through `git worktree list --porcelain`. For each, record branch, head, dirty state, untracked files, age, upstream state, and known PR.
3. Use policy-gated Open Session session tools to identify active ownership by exact session id and explicit creator. Never infer ownership from a title or scan transcripts, databases, or session files.
4. Classify candidates as active, dirty, unmerged, merged-clean, abandoned-clean, or unknown. Unknown is not safe.
5. Present every destructive candidate and its evidence. Obtain explicit confirmation when removal could lose data or when repository policy requires it. A generic autonomy request does not authorize deletion.
6. Remove only confirmed, inactive, clean worktrees through the repository's documented cleanup path. Never reset, clean, switch, or delete a shared live checkout. Never use hand-typed broad `rm -rf` as a substitute for worktree ownership checks.
7. Re-list worktrees and disk usage. Confirm protected work remains.

Report before and after usage, removed paths with reasons, and every held path with its owner or uncertainty.
