# Autonomous run

Own one checkable exit condition and drive it without unnecessary human turns.

1. State the exit condition before work starts. Examples are a reproduced bug fixed, a measured target reached, or an explicitly authorized PR made merge-ready.
2. Break the run into verifiable units. Keep a decision trail with `show-me-your-work` when a reviewer will need it.
3. Use durable Open Session children for independent slices. Begin each brief with `/pstack`; use ask mode for reads and isolated code worktrees for writes.
4. Do not block on sleep or polling loops. A child completion reports back automatically. Check an external status once; if it is still pending, do other useful work or end the turn so the next event can wake the session.
5. After each unit, verify the real artifact, update the remaining predicate, and stop work that no longer helps it.
6. Follow active repository and user authorization for commits, publication, deployment, merges, and external actions. Autonomy never creates permission.
7. Finish only when the predicate is true or a concrete external prerequisite blocks it.

Report the predicate, completed units and evidence, remaining blocker if any, and produced links.
