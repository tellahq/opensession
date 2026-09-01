# Shipping

Land only work that is independently verified and explicitly authorized.

1. Confirm the requested terminal action and the repository's publication, merge, stack, and deployment workflow. This playbook grants no authority.
2. Verify every PR independently at its exact head SHA. Exercise the real changed surface. CI and author self-report are supporting evidence, not the verdict.
3. For a stack, walk from the lowest unmerged PR and stop at the first failed, blocked, or unverified head. Only the contiguous verified run is eligible.
4. Use the repository's configured stacking or merge tool. If no stack tool is documented, do not invent Graphite commands or retarget bases speculatively.
5. Recheck the live head immediately before the authorized mutation. A changed head voids the verdict unless an evidence-backed patch comparison proves the relevant diff unchanged.
6. Submit, merge, or deploy only through the documented path. Never replace a gated deploy with an ad hoc service restart or a missing publication tool with ambient credentials.
7. Once a queue is draining, stop changing its topology. Diagnose a stall before mutating anything.
8. Check status once. Do not hold the conversation in a sleep loop. A completed lifecycle event wakes the session; continue useful work or end the turn while pending.
9. Stop at the verified ceiling. Extending it requires another verification pass.

Report what was authorized, exact verified heads, what landed, the verified ceiling, and remaining risk or gates.
