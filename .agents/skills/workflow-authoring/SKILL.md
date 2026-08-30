---
name: workflow-authoring
description: Author, revise, or debug Open Session dynamic workflow scripts. Use before writing a non-trivial run_workflow script, choosing agent versus MCP calls, using parallel or pipeline fan-out, spawning durable child sessions, or designing replay-safe workflow logic.
---

# Workflow authoring

Use this guide when a task benefits from deterministic fan-out across many focused agents, direct MCP data calls, or durable child sessions. Do not use a workflow for one small sequential task that the current session can do directly.

## Start with current capabilities

Call `mcp__opensession-workflows__workflow_capabilities` when model choice or run size matters. It returns the live model ids, default model, concurrency, lifetime, timeout, and child-session limits. Do not guess model ids or copy an old model list into a script.

## Script shape

Pass plain JavaScript, not TypeScript, to `run_workflow`. Do not use imports. Export `meta`, then write the async body with top-level `await` and `return`:

```javascript
export const meta = {
  name: "route-audit",
  description: "Audit routes for missing auth checks",
  phases: [{ title: "List" }, { title: "Audit" }, { title: "Rank" }],
};

phase("List");
const files = await agent("List the route files. Return only a JSON array.", {
  schema: { type: "array", items: { type: "string" } },
});
if (!files) return "Listing failed";

phase("Audit");
const findings = await parallel(
  files.map(
    (file) => () =>
      agent(`Read ${file} and report missing auth or validation checks.`, {
        label: file,
      }),
  ),
);

phase("Rank");
return findings.filter(Boolean);
```

`meta.name` is required and should be a short slug. `description` and `phases` are optional. Predeclared phases make progress understandable before work reaches them.

## Injected globals

### `agent(prompt, opts?)`

Run one focused model turn. Agents begin with no conversation context, so every prompt must include the paths, constraints, and output contract it needs.

Options:

```javascript
{
  label,   // short progress label
  phase,   // phase override for this call
  schema,  // JSON Schema; returns parsed validated data
  model,   // current model id from workflow_capabilities
  effort,  // low, medium, high, xhigh, or max when supported
  write,   // opt into a branch-producing write agent
}
```

A successful unstructured call resolves to final text. A schema call resolves to the parsed value. An errored call resolves to `null`, so filter nulls before synthesis. Unsupported effort levels are ignored rather than failing the call.

Agents are read-only by default. Use `write` only when a lightweight branch-producing agent is sufficient. A successful write call returns an object containing `text`, `structured`, `seq`, `branch`, `worktreeDir`, `changed`, `files`, `insertions`, and `deletions`. Use a durable child session when work needs an inspectable transcript, steering, a worktree, or a pull request.

### `merge(writeResults)`

Land selected write-agent branches back onto the session branch, sequentially. Pass one write result, an array of results, or bare `{ seq, branch }` items. Null, unchanged, and branchless values are ignored.

```javascript
const edits = await parallel(
  files.map(
    (file) => () =>
      agent(`Fix the issue in ${file} and commit the change.`, {
        label: file,
        write: true,
      }),
  ),
);
const merged = await merge(edits);
return merged;
```

The result is `{ merged, conflicts, skipped, error }`. A conflicted branch is reported instead of rejecting the whole batch, and the remaining branches continue. Inspect the result rather than assuming every write landed.

### `parallel([...thunks])`

Run zero-argument functions concurrently and wait for all results:

```javascript
const reports = await parallel(
  files.map(
    (file) => () => agent(`Audit ${file}`, { label: file, phase: "Audit" }),
  ),
);
```

Pass thunks, not already-started promises. A thrown thunk becomes `null` and does not reject the batch.

### `pipeline(items, ...stages)`

Run a per-item stage chain without a global barrier. Item B may start stage 2 while item A is still in stage 1. Each stage receives `(previousResult, originalItem, index)`. A throwing stage drops that item to `null` and skips its remaining stages.

```javascript
const findings = await pipeline(
  files,
  (file) => agent(`Inspect ${file}`, { label: file }),
  (report, file) => (report && report !== "none" ? `${file}: ${report}` : null),
);
```

Use `parallel` for one independent pass. Use `pipeline` when each item has a sequence of dependent transformations and early filtering should free capacity for other items.

### Direct MCP calls

Call tools from the script without spending a model turn:

```javascript
const alerts = await mcp.grafana.list_alert_groups({ state: "new" });
const issues = await mcp.linear.list_issues({ team: "ENG" });
```

Available forms:

- `mcp.<server>.<tool>(args)`
- `mcp.call(server, tool, args)` for dynamic names
- `mcp.servers()` to list the script's allowed servers
- `mcp.tools(server)` to return tool names, descriptions, and input schemas

A direct call returns the structured result, or parses text as JSON when possible. It rejects on failure. Catch failures explicitly or run calls inside `parallel`, where a throw degrades to `null`.

The script receives the current run's policy-scoped MCP surface. Per-user restrictions still apply, and confirmation-gated tools are unavailable.

### Progress and inputs

- `phase(title)` sets the progress group for subsequent calls.
- `log(message)` appends a short narrator line to the live progress feed.
- `args` is the parsed `args_json` value passed to `run_workflow`.
- `budget` exposes `{ total, spent(), remaining() }` for the optional advisory output-token budget.

Pass timestamps, seeds, file lists, and other varying inputs through `args` so a resumed run receives the same values.

## Agent or tool?

Use direct `mcp.*` for retrieval and mutation that a connected tool already performs. Use `agent()` only when the step needs judgement, such as reading code, reconciling evidence, classifying, ranking, or synthesizing.

Filter and join data in JavaScript before sending it to agents. Every row removed in the script is context and model work not spent.

```javascript
export const meta = { name: "alert-triage" };

const alerts = await mcp.grafana.list_alert_groups({ state: "new" });
const issues = await mcp.linear.list_issues({ team: "ENG", state: "started" });
const unclaimed = alerts.filter(
  (alert) => !issues.some((issue) => issue.title.includes(alert.title)),
);

log(`${unclaimed.length} unclaimed of ${alerts.length}`);
return await parallel(
  unclaimed.map(
    (alert) => () =>
      agent(
        `Assess this alert and suggest an owner: ${JSON.stringify(alert)}`,
        {
          label: alert.id,
        },
      ),
  ),
);
```

## Durable child sessions

Use `spawnSession()` for code work that needs a visible, durable Open Session with its own transcript, branch, worktree, steering, and PR lifecycle.

```javascript
const child = await spawnSession({
  prompt: "Implement the auth fix and open a PR. Do not merge it.",
  repo: "tellahq/example",
  mode: "code",
  workspace: { type: "isolated-worktree", baseRef: "main" },
});

const pushed = await waitSession(child.id, {
  until: "branch_pushed",
  timeout: 30 * 60_000,
});
return pushed;
```

Session API:

- `spawnSession({ prompt, repo, mode?, workspace?, branch? })` returns `{ id, url, repo, branch, parentSessionId }` once the visible session exists.
- `sessionStatus(id)` returns current status, branch/worktree, and PR data.
- `waitSession(id, { until, timeout? })` waits for `running`, `waiting`, `branch_pushed`, `pr_opened`, `done`, `error`, or `cancelled`.
- `sendToSession(id, message)` steers a child spawned by this workflow.
- `cancelSession(id)` cancels a child spawned by this workflow.

For dependent branches, wait for the base child to push, then create an isolated worktree with `baseSessionId` instead of `baseRef`.

Nested sessions inherit the parent session's user, repositories, model/account, and MCP scope. They cannot merge. A human owns every merge decision.

## Replay and determinism

Completed `agent()`, `mcp.*`, and session API calls are journaled. Resume and restart recovery replay matching completed calls instead of firing them again. `spawnSession()` also uses a stable durable creation identity, so a crash between child creation and journaling does not duplicate the session, branch, or worktree.

Keep scripts deterministic:

- `Date.now()`, argumentless `new Date()`, and `Math.random()` throw. Pass timestamps and seeds through `args`.
- Keep call order and prompts stable when you want completed work to replay.
- Do not embed transient discovery in a prompt when it can be supplied through `args` or a journaled MCP call.
- Catch expected tool failures and return explicit fallbacks.
- Make labels and phases stable so recovery and telemetry remain understandable.

A paused workflow stops active agents cleanly and preserves the journal. Resume continues it in place. Recovery after a process restart creates a new lineage run that replays completed journal entries and re-adopts durable child sessions.

## Model and effort selection

Call `workflow_capabilities` immediately before choosing a non-default model. Prefer the default unless a phase has a clear reason to differ.

Use stronger reasoning for verification, ranking, architecture, and synthesis. Use lower effort for mechanical extraction or classification. Avoid spreading the strongest model and highest effort across every fan-out item when one final verifier can evaluate cheaper parallel results.

## Authoring checklist

Before calling `run_workflow`:

1. Confirm fan-out provides real value over doing the task directly.
2. Call `workflow_capabilities` if model choice or run size matters.
3. Give every agent a self-contained prompt and a short stable label.
4. Use direct MCP calls for data and agents for judgement.
5. Filter inputs in JavaScript before model calls.
6. Add schemas where downstream code requires structured values.
7. Put independent work in `parallel`; use `pipeline` for dependent per-item stages.
8. Use durable sessions only when visibility, steering, worktrees, or PRs matter.
9. Pass nondeterministic values in `args`.
10. Return a compact useful result and poll `workflow_status` after launch.
