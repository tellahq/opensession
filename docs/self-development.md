# Self-development: working on Open Session with Open Session

Open Session can develop itself: open a session on the `opensession` repo, edit
the server, and press **Preview** to boot your edited code as an isolated dev
instance next to the one you are using. This doc explains the pieces and their
boundaries.

## The dev instance

A dev instance is `bun run packages/core/opensession-server/opensession.ts` with:

- `OPENSESSION_DEV=1` — historically this only swapped the frontend pipeline:
  serve the UI through Bun's HMR dev server instead of the prebuilt
  `.frontend-dist` bundle. It gated nothing on the backend. With the dev boot
  gate, `OPENSESSION_DEV=1` additionally skips every boot side effect that
  talks to the outside world or to shared state: integration agents
  (Slack/Linear/Plain/GitHub/Stripe/Grafana), public webhook intake, the cron
  automation scheduler and all background tickers/sweeps, the public-ingress
  listener, detached-engine-server adoption, run resume/redelivery, and the
  seed writes to automations. What remains is the web server, the
  session store, and the UI.
- `OPENSESSION_DEMO=1` — demo mode. On first boot it idempotently seeds
  generated sessions, transcripts, repository and PR state, automations, audit
  data, and a goal, then registers a demo ask card and starts the transcript
  replayer. It requires `OPENSESSION_STATE_DIR`.
- `OPENSESSION_STATE_DIR=<dir>` — root for all instance state. The session
  store, config, automations, sandbox config, run-rpc unix socket, and the other
  stores normally grouped under `~/.opensession/` resolve under this directory
  instead, so a dev instance never reads or writes the operator's live stores.

None of these flags change anything when unset: an unflagged boot is
byte-identical to today's behavior.

## Previewing your own change

The Preview button uses the repo's own lifecycle scripts, the same convention
every other repo uses ([repo-lifecycle.md](repo-lifecycle.md)):

- `.agents/setup` — one-shot per worktree: `bun install
--frozen-lockfile`. Safe to re-run.
- `.agents/start.sh` — boots the dev instance in the foreground on
  `$WEBAPP_PORT`, loopback only, with the three flags above and
  `OPENSESSION_STATE_DIR=$PWD/.dev-state`.

For a host preview when no warm-pool claim is available, pressing Preview
allocates a port (3100–3999), runs the `setup` hook once, and launches
`start.sh` detached with cwd = the session's checkout. Caddy fronts the port at
`https://<host>:<port+6000>` (the `PREVIEW_URL` in the button). Stop kills the
script's process group, which kills the instance because `start.sh` `exec`s it.

A warm-pool preview may adopt an already-running container instead. A sandbox
preview launches `start.sh` inside the sandbox on a pre-published container
port and uses a separately allocated HTTPS route in 20000–27999, so the
3100–3999 and port+6000 rules are host-specific.

`start.sh` is deliberately paranoid: the environment it inherits is the
calling server's production env (ports, agent toggles, secrets), so it
overrides or unsets every operationally significant variable rather than
inheriting anything — the production port is explicitly refused. Read the
comment block in the script for the variable-by-variable rationale.

`.dev-state/` (plus the preview flow's `.ports.conf` / `.ports/`) appears in
the checkout the preview ran from; it is disposable and must stay gitignored.

## What a dev instance does NOT cover

Live integrations are out of scope by design. A dev instance has no Slack,
Linear, Plain, Stripe, Grafana, or GitHub agents, receives no webhooks, and runs
no cron automations. It does not adopt or resume detached run hosts left by an
earlier process. The current `.agents/start.sh` disables the executor but does
not set `OPENSESSION_PI_DETACH=0`, so Pi turns may still attempt a transient
detached run host and fall back in-process if launch is unavailable.

You cannot use a dev instance to test "did my change fix the Slack agent"
end-to-end. Verify that class of change with tests plus a real deploy. Engine
runs depend on engine credentials and are best treated as untested from a
preview.

## Deploying a source change

A system-scope source installation bootstrapped by `deploy/deploy.sh`, including
Tella's live instance, has two immutable-release rollout commands, and the
standard command automatically selects a restart-free frontend promotion when
the complete diff is frontend-only. “Light” and “full” describe whether
root-owned installation artifacts are refreshed. A plain source service
installed directly from a checkout still follows
[the checkout watcher/restart behavior](setup/install.md#10-frontend-rebuilds-vs-restart)
until an operator deliberately adopts the immutable-release deploy path.

| Path             | Use it for                                                                                                                                                                                                                                | Entry point                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Standard (light) | Ordinary frontend, backend, protocol, and dependency changes that can reuse the installed units, credentials, and helper. Frontend-only targets are promoted without a restart; other targets restart and health-gate the three services. | interactive MCP `deploy_self({ sha, confirm: true })` |
| Full (root)      | Changes to the live deploy controllers, `opensession*.service`, credential installers, the fixed run-host helper/installer, or systemd artifacts managed by the root script                                                               | `sudo deploy/deploy.sh <sha>`                         |

A docs-only commit does not need a live rollout. A frontend-only commit does.
The production frontend watcher follows the pinned release worktree, not the
shared WIP checkout, so editing `src/frontend` in the shared checkout cannot
change the live bundle. `/api/rebuild-frontend` also rebuilds the already pinned
source; it cannot publish frontend source from the shared checkout.

`deploy_self` is that publication path. It compares the running backend commit
to the requested target. When every runtime file in the diff is under
`packages/core/opensession-server/src/frontend/` (documentation may ride with
it), it prepares the target release, bundles the SPA there, validates every
listed asset, atomically records `frontend-current.json`, swaps the in-memory
shell/asset root, and broadcasts `frontend_updated`. The gateway, session
kernel, and executor keep running. Old release asset roots remain readable for
long-open tabs that request a lazy chunk after promotion.

The frontend pointer records the exact backend commit it advances from. A later
standard/full deploy or rollback changes that backend base, so boot ignores the
old frontend pointer and serves the new backend release's own UI. This prevents
a newer UI from accidentally surviving across an incompatible backend move.

Deployment may be autonomous when the task calls for making a change live, but
it is shared across every coding session. Concurrent main-line requests wait on
one lifecycle lock, pause briefly for the commit burst, and select the newest
compatible target that was actually requested. Requests already covered by
that release exit successfully without another restart. A target that just
failed its health gate is not retried automatically. `deploy_status` remains
useful for observing the result, but callers no longer need to implement their
own wait/retry loop.
Exact-SHA deploy intent is preserved: unrelated commits are never absorbed just
because they appeared on `origin/main`.

Do not substitute `systemctl restart opensession`. That restarts the currently
pinned release, does not pick up the new commit, and bypasses the coordinated
executor/kernel/gateway rollout.

### Standard (light) deploy

The `opensession-self-deploy` in-process MCP server is available only to
interactive admin sessions, never automations or dev instances.
`deploy_self({ sha?, confirm: true })` first classifies the complete diff. The
`confirm` flag deliberately acknowledges a shared live rollout; it is not a
requirement for separate human approval. An agent may deploy autonomously,
subject to the coordination and batching rule above.

For a frontend-only target, the gateway performs the preparation, bundle,
validation, pointer swap, and client notification in process. `deploy_status`
shows both the backend pin and any active restart-free frontend pin.

For every other ordinary target, it launches the controller from the running
release as a transient system unit so the rollout survives the gateway restart.
That controller:

1. fetches `origin` and resolves the requested target (`origin/main` by
   default),
2. requires the currently pinned commit to be an ancestor of the target, so a
   stale or parallel release cannot silently replace it,
3. creates or reuses a detached worktree under the deploy state directory,
   runs `bun install --frozen-lockfile` there, and verifies tracked files stayed
   unchanged,
4. records the current release as last-known-good, stops the gateway, and
   atomically repoints `current` to the prepared release,
5. restarts and readiness-checks the installed executor, runs the offline
   session migration, restarts and checks the session kernel, then restarts the
   gateway, and
6. requires three consecutive health responses from the same `bootId`.

The shared checkout is only the Git object source. Its branch, index, staged
files, and unrelated dirty edits are not changed by deployment. Detached engine
turns survive in their transient run-host units and sessions reattach after the
UI blip.

This path deliberately does **not** copy root-owned units, credentials, helper
executables, sudo policy, or systemd drop-ins from a writable checkout. If the
target relies on a changed installed artifact, use the full deploy instead.

On readiness or health failure, the controller switches the `current` pointer
back to last-known-good and brings all three services back. Rollback is refused
when the old release cannot read the durable session-kernel schema floor.
`deploy_status({})` reports the pin, latest result, and deploy-marker age. The
optional watchdog can act once during the first 15 minutes after a deploy. This
window only bounds automatic rollback; it neither delays nor blocks a later
deploy, and status reports it closed once the 15 minutes expire.

### Full (root) deploy

`sudo deploy/deploy.sh <sha>` uses the same immutable release preparation and
pointer switch, then also installs or synchronizes the privileged credentials,
fixed run-host helper and sudo policy, three systemd units, gateway resource
drop-in, user slice, and Caddy boot drop-in. It relies on the gateway's bounded
graceful drain by default rather than adding a second pre-drain delay;
operators can opt into an extra wait with `MAX_DRAIN_WAIT`. It restarts and
health-checks the executor and kernel before the gateway, and switches back to
the previous release if the rollout fails. Overlapping full deploys wait on the
same lifecycle lock rather than failing immediately.

The root path also requires the current release to be an ancestor of the
target. `OPENSESSION_DEPLOY_ALLOW_DIVERGED=1` is an explicit operator override
for a deliberate history-line change, not a normal agent workflow. It manages
only the artifacts named in `deploy/deploy.sh`; watchdog units, sandbox images,
and other operator-managed assets keep their own rollout procedures.

### Prerequisites and updates

Use **your own remote first**. Self-sessions normally commit and push to
`origin`, and the default `deploy_self` target is `origin/main`. If the checkout
was cloned directly from an upstream repository you cannot write, clone your
fork instead (keep the original as `upstream`) and set the self repo's `ghRepo`
to the fork. Passing an exact pushed SHA avoids deploying an unintended newer
`origin/main`.

On Linux/systemd, run `opensession service install --system` once from the
service user account and allow its sudo prompts. The default command without
`--system` installs a rootless user service and does not install the fixed
run-host helper or self-deploy grants.

On macOS, run `opensession service install` without `sudo` or `--system`.
Standard self-deploys run as transient jobs in the current user's launchd
domain, prepare immutable releases, reload the gateway and SessionKernel
LaunchAgents, health-gate the result, and restore the prior compatible release
on failure. The first standard deploy bootstraps the immutable release pin; it
cannot roll back automatically until that first release is healthy.

Staying current is one command: **`opensession update`**. It refuses a dirty
checkout, detects fork topology (origin = your fork + an upstream remote),
fetches upstream, and either fast-forwards or creates an honest merge commit.
It never rebases, and conflicts abort cleanly back to your tree. For a fork it
attempts to push the result to `origin`; a push failure is only a warning.

For a source checkout, update uses the health-gated self-deploy script only
when a service is installed, the script exists, and `sudo -n true` succeeds.
In that path the pre-update commit is the rollback pin. Otherwise an installed
service receives a plain restart with no rollback pin or health gate.
`opensession update --check` previews what it would pull without applying it.

The optional watchdog,
`deploy/systemd/opensession-watchdog.{service,timer}`, probes health every 60s
but only acts inside a 15-minute window after a self-deploy restart, after 3
consecutive failures, and at most once per deploy. The checked-in units are
host-specific templates. Before copying them, replace `User=ubuntu`,
`OPENSESSION_DEPLOY_STATE`, `OPENSESSION_DEPLOY_CHECKOUT`, `PATH`, and
`ExecStart` with this installation's service user, state directory, checkout,
and Bun path.

Install the adjusted units with:

```bash
sudo cp deploy/systemd/opensession-watchdog.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now opensession-watchdog.timer
```
