# Repo lifecycle scripts: `.agents/`

Commit a `.agents/` directory to a repository and every agent host that
follows this convention — Open Session, and anything else that adopts it —
knows how to prepare a workspace for that repo and expose its app. Four
files, each optional:

| File                       | When it runs                                       | Job                                          |
| -------------------------- | -------------------------------------------------- | -------------------------------------------- |
| `setup`                    | once per workspace (and once per project snapshot) | install deps, fetch prebuilt assets          |
| `resume`                   | every time a sleeping Sandbox wakes                | idempotent post-wake repair                  |
| `portals.json`             | Portals panel, `start_declared_portal`             | declare the services Open Session supervises |
| `sandbox-environment.json` | project snapshot preparation                       | environment source and extra snapshot inputs |

Why commit them rather than configure the host: the recipe travels with the
code. Each session workspace prepares itself, on this machine or in a Sandbox,
and an agent can bring your app up **headlessly** in its own workspace and
verify its changes in a real browser without a human bootstrapping anything.
See [Letting the agent test the app itself](#letting-the-agent-test-the-app-itself).

## setup — one-shot provisioning

Runs once per workspace: on the host after a worktree is created, in a
Sandbox after the clone, and once when a project snapshot is prepared (a
Sandbox restored from that snapshot skips it). `cwd` = repo root, no
arguments, `OPENSESSION_BOOT_MODE=fresh`. Must be idempotent and must not
prompt: assume no TTY and no human.

Do the minimum a dev server needs: dependency install, a prebuilt artifact
fetch, codegen. Slow extras belong behind an existence check. During snapshot
preparation `bun install` runs with `--frozen-lockfile` so a shared image
never rewrites `bun.lock`.

## resume — idempotent post-wake repair

Runs inside a Sandbox after every real wake, before Portals are restored and
before the queued turn runs. `cwd` = repo root, no arguments,
`OPENSESSION_BOOT_MODE=resume`. Use it for wall-clock- or environment-
sensitive state: stale pid and lock files, expired cached tokens, clock-skewed
build caches, a daemon that must be running. It must be idempotent because it
runs many times over a Sandbox's life. A failure is logged and shown in the
Sandbox badge; it does not block the wake.

## portals.json — the services Open Session supervises

A Portal is a session-scoped process exposed only through an authenticated
Open Session URL. Declare the ones your repository knows how to run:

```json
{
  "portals": [
    {
      "id": "web",
      "name": "Web app",
      "description": "Authenticated app and local dependencies",
      "command": "bun run dev --port \"$PORT\"",
      "serviceKey": "WEBAPP_PORT",
      "readyTimeoutSeconds": 180
    }
  ]
}
```

Open Session allocates a port, runs `command` under its supervisor with `PORT`
and `PORTAL_URL` in the environment, waits for the port to listen, and hands
back the URL. The Portals panel lists every declared Portal with a Start
button; the agent starts one with `start_declared_portal` and any other
process with `start_portal`. The recipe is always re-read from the workspace,
so browser input never replaces the command.

Two rules make a Portal command work:

1. **Foreground.** `exec` the final process. Stop signals the process group;
   a backgrounded server would be orphaned.
2. **Honor `PORT` and `PORTAL_URL`.** Listen on `PORT`. Add `PORTAL_URL`'s
   hostname to your framework's allowed dev origins so pages served through it
   hydrate. A recipe whose `serviceKey` is `WEBAPP_PORT` additionally receives
   `WEBAPP_PORT` and `PREVIEW_URL` for scripts written against the earlier
   contract.

The Portal keyed `WEBAPP_PORT` (else the first one) is the repository's main
app. `id` is the name the agent uses; keep it short and lowercase.

Open Session owns `.ports.conf` in the workspace. It records generated Portal
metadata and stable `*_PORT` entries so repository tooling can find its ports.
Agents may read it, but start, stop, restart, and default routes go through
`opensession-portals`. A stopped or sleeping Sandbox never turns into a host
Portal by fallback; when the Sandbox wakes, the Portals that were awake are
restarted with the same command and port.

Use session Assets for a static artifact, diagram, report, or standalone HTML
file that does not need a running process. Use a Portal for an interactive
app, web server, API-backed UI, or anything someone should open and test live.

## Workload identity from a sandbox

Lifecycle hooks and Portals inside a Sandbox never receive long-lived cloud
credentials. When a repository has a matching `OPENSESSION_WORKLOAD_IDENTITY_GRANTS`
entry, the process receives `OPENSESSION_WORKLOAD_IDENTITY_TOKEN_URL`,
`OPENSESSION_WORKLOAD_IDENTITY_LEASE`, and `OPENSESSION_WORKLOAD_IDENTITY_AUDIENCE`
and exchanges them for a short-lived identity token
(`opensession sandbox id-token`) that a cloud role trusts. The lease is not
persisted in the workspace or in a project snapshot. Host workspaces receive
the configured agent AWS environment when it is enabled.

## sandbox-environment.json — environment source and snapshot inputs

```json
{
  "dev": {
    "type": "aws-secrets-manager",
    "region": "us-east-2",
    "secretId": "dev/opensession/tella-fusion-webapp-env"
  },
  "preparationInputs": [".agents", "patches"]
}
```

`dev` names where a Sandbox fetches the repository's private environment
files after a workspace is materialized (they never land in a shared
snapshot). `preparationInputs` lists extra committed files or directories
whose change should refresh the project snapshot, on top of the defaults
(`.agents/setup`, this file, and `bun.lock`).

`environment.json` is the legacy local-file migration path; prefer the
secrets-manager source above.

## A minimal pair

```bash
#!/usr/bin/env bash
# .agents/setup — one-shot per workspace. Idempotent.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
bun install
```

```json
{
  "portals": [
    {
      "id": "web",
      "name": "Web app",
      "command": "exec bun run dev --port \"$PORT\"",
      "serviceKey": "WEBAPP_PORT"
    }
  ]
}
```

Real repositories grow from here — a prebuilt-WASM fetch instead of a local
toolchain build, a credentials shim, a write-access preflight, a `resume` that
restarts a database — but the shape stays: idempotent setup, foreground
Portal command, contract honored, loud actionable failures.

## Letting the agent test the app itself

With the pair committed, any session workspace is bootable headlessly, which
closes the loop _change → boot → screenshot → iterate_ entirely inside a
session — the agent verifies its own UI work in a real browser instead of
declaring victory from a successful compile. Running this daily on our own
repos, these are the patterns that make it work:

- **A dev auth bypass.** The single biggest unlock. An env-gated auto-login
  (dev-only, secrets gitignored) means every headless request is
  authenticated — no interactive OAuth dance a bot can't perform. Gate it
  hard: dev environment only, never in committed config.
- **A declared Portal.** The agent shouldn't reason about whether the server
  is running — `start_declared_portal` is instant when it already is and
  boots it when it isn't, and `list_portals` reports the URL.
- **Committed driving instructions.** Pair the scripts with a repo skill or
  an agent-instructions section that says: open the Portal, then use these
  one-liners to screenshot / record / evaluate JS over CDP. The lifecycle
  scripts make the app _reachable_; the instructions make it _drivable_.
- **Human-once bootstrap, machine-many reuse.** Secrets that genuinely need
  an interactive login get pulled once by a human into the secrets source;
  `setup` seeds them into each workspace. Scripts fail with the copy-pasteable
  bootstrap commands when the seed is missing.

## Pointers

- [worktrees.md](worktrees.md) — worktree creation and where the `setup` hook
  fits in the dependency-install chain
- [self-hosting-sandboxes.md](self-hosting-sandboxes.md) — the same
  convention inside Sandboxes: snapshots, sleep/wake, Portal relay
- [portals-and-agent-communication.md](portals-and-agent-communication.md) —
  Portal routing and the `opensession-portals` tools
- [self-development.md](self-development.md) — Open Session's own
  `.agents/` scripts, a real in-tree example
