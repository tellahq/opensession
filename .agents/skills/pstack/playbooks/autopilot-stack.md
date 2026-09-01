# Autopilot stack

Build and verify an ordered PR stack, then stop at the operator's authorized landing boundary.

1. Confirm the repository's stacking workflow and commands from its instructions. If none exists, use ordinary dependent branches and GitHub base relationships rather than inventing Graphite support.
2. Define the ordered slices and one owner per slice. Parallelize only slices with separate writers and no unresolved parent dependency.
3. Give each writing child an isolated worktree, exclusive branch, `/pstack` brief, acceptance criteria, and exact verification.
4. Give stack topology to one coordinator. Workers never rebase, retarget, force-push, or mutate another slice unless repository policy explicitly assigns that role.
5. Run an independent ask-mode verifier on every exact head before delivery. Parent changes that rewrite a head invalidate its verdict until reverified.
6. Append only a contiguous verified run from the base. Stop at the first failed, blocked, or unverified slice.
7. Never merge or arm automatic landing unless the user and repository policy authorize it. The default deliverable is a reviewable ordered chain.
8. Do not poll waiting systems. Child reports and external events wake the session; otherwise end the turn after one status check.

Report the ordered chain, bases and head SHAs, verifier verdicts, the verified ceiling, and who owns landing.
