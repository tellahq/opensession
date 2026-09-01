# Opening a PR

Prepare and publish a reviewable change only when the user and repository workflow authorize it.

1. Read the repository's branch, shared-checkout, commit, push, PR, attribution, reviewer, and deployment instructions.
2. Inspect current branch, divergence, staged files, unstaged files, and untracked files. Preserve unrelated work. Never reset, clean, switch, stash, or discard work unless the active repository instructions explicitly permit it.
3. Rebase or synchronize only through the documented shared-checkout workflow. Fetch immediately before committing and pushing when required.
4. Inspect the complete diff. Apply relevant cleanup, `unslop`, `no-comments`, tests, and real-surface verification.
5. Stage only owned paths or hunks. Inspect the index before committing. Use a path-limited commit when unrelated staged work exists.
6. Write the smallest useful commit and PR prose. Include required attribution and reviewers. Never add an assignee unless repository policy says to.
7. Push and open the PR only with authorized organization-scoped credentials. For repositories outside the authorized organization, obtain current-conversation confirmation first.
8. Verify the resulting PR URL, base, head, checks, requested reviewers, and body. Do not claim publication from a local commit.
9. Route ongoing review work to Babysit. Deployment remains a separate repository-controlled action.

Report the commit, PR link, reviewers, verification, and any remaining gate.
