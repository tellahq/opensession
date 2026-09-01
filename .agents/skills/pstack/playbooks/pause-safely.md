# Pause safely

Leave a checkpoint another session can resume cold.

1. Stop at a coherent boundary. Finish or roll back only your own incomplete operation through the repository's allowed workflow. Never discard unrelated work.
2. Record the goal, exact current state, branch and worktree, owned changed files, commits and PRs, decisions, verification run, failures, pending external events, and next action.
3. Make partial work durable only when repository policy authorizes a commit or pushed branch. Otherwise leave the working tree intact and name every owned path.
4. Record child session ids, their explicit scopes, and whether they are running, waiting, done, or blocked. Do not cancel durable children merely to make the checkpoint tidy.
5. Do not edit Open Session session files, queues, journals, or transcript databases. Use the product's session and reporting tools.
6. Verify that the checkpoint's references resolve and that no process or temporary writer you started was accidentally left behind.

Report the checkpoint in the conversation. A future pickup uses `playbooks/session-pickup.md`.
