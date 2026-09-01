# Durable sessions in dynamic workflows

Use `spawnSession()` when a workflow step needs a real code session with its own transcript, branch, worktree, PR, and Review UI. Existing `agent()` calls remain lightweight workflow workers.

```js
export const meta = {
  name: "stacked-layout",
  description: "Build a foundation and a dependent implementation",
};

const foundation = await spawnSession({
  prompt: "Implement the new layout protocol. Commit, push, and open a PR.",
  repo: "renderer",
  mode: "code",
  workspace: {
    type: "isolated-worktree",
    baseRef: "main",
  },
  branch: "compat/layout-protocol",
});

await waitSession(foundation.id, {
  until: "branch_pushed",
  timeout: 30 * 60_000,
});

const text = await spawnSession({
  prompt:
    "Implement Text using the new layout protocol. Commit, push, and open a PR against the foundation branch.",
  repo: "renderer",
  mode: "code",
  workspace: {
    type: "isolated-worktree",
    baseSessionId: foundation.id,
  },
  branch: "compat/text-layout",
});

const [foundationPr, textPr] = await Promise.all([
  waitSession(foundation.id, { until: "pr_opened", timeout: 45 * 60_000 }),
  waitSession(text.id, { until: "pr_opened", timeout: 45 * 60_000 }),
]);

return { foundationPr, textPr };
```

Both sessions appear beneath the workflow's parent session and in its Agents panel. The dependent session persists the existing `stackedOn` relationship, opens its PR against `compat/layout-protocol`, and uses the existing Review and GitHub stack UI. The workflow does not merge either PR.

## Session API

- `spawnSession(options)` returns `{ id, url, repo, branch, parentSessionId }` as soon as the visible child exists.
- `sessionStatus(id)` returns the child's current status, worktree, pushed-branch state, and PR.
- `waitSession(id, { until, timeout })` waits for lifecycle and PR events: `running`, `waiting`, `branch_pushed`, `pr_opened`, `pr_checks_passed`, `pr_checks_failed`, `pr_changes_requested`, `pr_approved`, `pr_merged`, `done`, `error`, or `cancelled`. Wait intent is persisted, wakes on session state changes, and is re-adopted by automatic restart recovery. `timeout` is milliseconds.
- `sendToSession(id, message)` messages or steers a child created by this workflow.
- `autofixSession(id, reason?)` queues the standard review-and-CI autofix handoff. It requires a child-owned PR and never grants merge permission.
- `cancelSession(id)` cancels a child created by this workflow.
- `reconcileSessions(desired, { concurrency, until, timeout, retry })` runs a refillable pool. Completed children free a slot for the next desired child; optional retries message the same durable child, so replay does not duplicate work.
- `workflowState.get(key)` and `workflowState.compareAndSet(key, version, value)` provide JSON CAS state scoped to the workflow's replay lineage.

`spawnSession()` also accepts:

- `runner`: an online, policy-authorized persistent Runner id. Runner, repository, user, and new-code-workspace capability checks still run in the normal create path. Runner children currently start from the repository default branch; dependent stacked children remain host-worktree sessions.
- `admission: { tokens, costUsd? }`: an up-front aggregate budget reservation. A child is rejected before creation when the reservation cannot fit; actual usage replaces the reservation as it arrives.

Completed calls are journaled. Resuming a workflow replays them, while a stable create identity also covers a crash after session creation but before the journal append. Child sessions are normal durable Open Session sessions and outlive the workflow worker or gateway process that launched them.

Nested sessions inherit the parent's identity, registered repository scope, model, provider-account pin, and credential policy. Automations remain blocked unless their human-owned definition sets `workflows: true`, `workflowSessions: true`, and a non-empty `workflowSessionRepos` allowlist. `workflowSessionRunners` separately allows specific persistent Runners and defaults to none. This authority is persisted with the workflow and revalidated against current automation configuration during recovery.

Automation descendants persist immutable automation trust provenance. Their opening and resumed turns use exact empty MCP scope, automation tool denials, no user GitHub or AWS credentials, and automation trust profile. A server-side publication policy allows pushing only the owned feature branch and updating its PR; it denies base-branch pushes, merges, external repository writes, and unscoped Runner use. Prompt text is not the enforcement boundary.

The defaults can be tightened per instance with `OPENSESSION_WORKFLOW_MAX_SESSION_DEPTH`, `OPENSESSION_WORKFLOW_MAX_ACTIVE_SESSIONS`, `OPENSESSION_WORKFLOW_MAX_SESSIONS`, `OPENSESSION_WORKFLOW_MAX_SESSION_TOKENS`, and `OPENSESSION_WORKFLOW_MAX_SESSION_COST_USD`.
