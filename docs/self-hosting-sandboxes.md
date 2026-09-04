# Self-hosting sandboxes

How to run Open Session sessions inside their own machines. A **Sandbox** is a
Linux VM in your Daytona or Box account with the repository checked out, its
`.agents/setup` already run, and a durable disk. It sleeps between turns,
wakes when the next message arrives, and comes back with files, running
Portals, and the conversation intact. Companion to
[`deploy/sandbox/README.md`](../deploy/sandbox/README.md) (runner payload) and
[repo-lifecycle.md](repo-lifecycle.md) (what a repository commits).

**Default = This machine.** The new-session menu offers one choice, **Run in:
This machine or Sandbox**. Which provider backs "Sandbox" is the workspace's
decision (Workspace → Sandboxes), never the person creating the session. A
workspace or personal default can make Sandbox the norm; a per-session choice
always wins.

Claude and Pi-family models run in a Sandbox. Native Codex cannot: its
writable, rotating `CODEX_HOME` stays host-only. Choose a `pi/openai/*` model
for GPT in a Sandbox.

## Setup

1. **Public ingress.** Sandboxes reach this server over WebSocket. Configure
   the workspace's public callback origin once under **Settings → Domains and
   ingress → Public callbacks** (Cloudflare Tunnel or Direct HTTPS with Caddy),
   or run `opensession sandbox ingress install https://ingress.example.com`.
   The same fail-closed listener on `:3860` receives signed integration
   webhooks, Sandbox callbacks, and workload identity; the private app on
   `:3850` is never part of it.
2. **Connect a provider.** In **Workspace → Sandboxes**, connect Daytona or
   Box with an API key. Credentials are written once to the server-side
   workspace secret store and never returned to the browser or placed in a
   Sandbox. Connecting runs a qualification: ingress is verified, a disposable
   sandbox is created, a snapshot restore is proven, and everything is cleaned
   up. Only a **Ready** connection is offered to sessions.
3. **Pick the default.** Still in Workspace → Sandboxes, set **New sessions
   run in** to the provider you connected. With one Ready connection this is
   also what an explicit per-session "Sandbox" choice resolves to.

`opensession sandbox test <provider>` requalifies a connection from the shell
(the server must be running and the app must have a local web session).
`opensession sandbox disable <provider>` stops future use without deleting
live Sandboxes.

If a chosen provider later becomes unavailable, creation or the next turn
fails clearly; Open Session never changes the execution boundary to the host
or another provider.

## What a Sandbox is

Every Sandbox session gets its own machine. Open Session:

- creates the VM (from the project's snapshot when one exists, else from the
  provider's base image), installs the runner payload, and clones the
  repository inside it. Workspaces exist only in the Sandbox: push your work;
- runs the repository's `.agents/setup` once per disk, and `.agents/resume`
  on every wake;
- runs the agent inside the VM. The engine dials back to this server over the
  public ingress for run streaming and MCP;
- exposes services as **Portals**: authenticated HTTPS routes on this host
  that relay to the Sandbox. The browser never sees a provider URL;
- lets the Sandbox sleep after the provider's idle interval (30 minutes by
  default). Sleeping costs no compute. Sends while asleep persist in the
  durable queue; the first one wakes the Sandbox, `.agents/resume` runs, the
  Portals that were awake are restarted, and only then does the queue drain.

The session's **Sandbox** badge shows Preparing, Awake, Sleeping, Waking, or
Needs attention, with manual sleep, wake, and recreate, plus the `setup` and
`resume` logs.

Terminal tabs land inside the Sandbox (Daytona's native PTY, Box's SSH).

## Desktop

Both providers can show a person the Sandbox's screen. The Sandbox popover in a
session offers **Open desktop** while the Sandbox is awake; it opens a
**Desktop** tab next to Review and Terminal with the live, controllable
desktop embedded (the tab's header can also pop it into a browser window). The
agent keeps working underneath it, so this is the way to watch a browser test,
log into something the agent cannot, or take over for a moment.

The agent gets the same screen through the `opensession-desktop` MCP, wired
only into sandboxed sessions: `screenshot`, `click`, `move`, `drag`, `scroll`,
`type`, `key` and `windows`, all in desktop pixels. Daytona serves it from its
computer-use API, except `windows`, which reads real geometry from the X
server with `xprop` and `xwininfo` because Daytona's own list puts every
window at 0x0. Box has no control API, so Open Session drives the box's own X
display (`:0`) with `xdotool` and ImageMagick over the command channel. A call
on a sleeping Sandbox wakes it first.

- **Box** mints a 60fps stream page (`POST /boxes/{id}/desktop`).
- **Daytona** starts its computer-use stack (Xvfb, xfce4, x11vnc, noVNC) on
  first use and hands out a signed preview URL for noVNC; it stops working
  after an hour, so click again for a fresh one.

The URL is a bearer secret minted for one viewer: the API returns it once and
the audit log records the request, not the URL. Asleep Sandboxes answer
"Wake the sandbox first".

## Project snapshots

The slow part of a fresh Sandbox is `.agents/setup`. Opt a project into
**Project snapshots** in Workspace → Sandboxes and Open Session prepares a
credential-free image once (clone, setup, dependency install) and starts every
new Sandbox for that project from it. Snapshots refresh when the inputs that
affect setup change; a repository can declare extra inputs in
`.agents/sandbox-environment.json` under `preparationInputs`. Private files
and session credentials are injected only after a restore, never into the
shared image.

Typing a new-session prompt also starts a **prewarm**: Open Session begins
provisioning a Sandbox before Create is pressed and adopts it at create time.
Prewarms expire after ten minutes when unused; at most two are live at once.
This is automatic wherever a Ready provider exists; disable it with
`"prewarm": {"enabled": false}` in `~/.opensession/sandbox.json`.

Each project snapshot carries a **machine size** (Small, Medium, Large),
mapped to the provider's shapes. Daytona sizes require a base snapshot created
with those resources; Box exposes three fixed machine types.

## Repo lifecycle hooks

Sandboxes honor the repository contract in [repo-lifecycle.md](repo-lifecycle.md):
`.agents/setup`, `.agents/resume`, and `.agents/portals.json`. A declared
Portal starts from the Portals panel or through `start_declared_portal`; the
agent can also expose any process with `start_portal`. Portal processes
receive `PORT` and `PORTAL_URL`. Logs live under
`~/.opensession/lifecycle/` inside the Sandbox.

## Workload identity

A Sandbox never receives long-lived cloud credentials. Lifecycle hooks and
Portals receive a short-lived workload identity lease that they exchange for
scoped cloud roles (`OPENSESSION_WORKLOAD_IDENTITY_*`); see
[repo-lifecycle.md](repo-lifecycle.md#workload-identity-from-a-sandbox).
Model credentials are uploaded per launch, scoped to the run's account, and
never land in a snapshot.

## Automations

Unattended runs (automations and public review) use disposable Daytona
sandboxes with a per-sandbox egress allowlist enforced by the provider. They
never adopt a prewarm or project snapshot. See
[security-model.md](security-model.md).

## Runtime config — `~/.opensession/sandbox.json`

Workspace → Sandboxes writes this file; hand-edit only for the operator
settings below. Read fresh per call, no restart needed except where noted.

| Key                                             | Meaning                                                                                                                                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connections`                                   | Provider connections and their qualification state. Managed by Workspace → Sandboxes.                                                                                                                                           |
| `sessionDefault`                                | `"daytona"`, `"box"`, or `"none"`: where new sessions run when nobody chose.                                                                                                                                                    |
| `provider`, `perRepo.<id>.provider`             | Legacy default and per-repo override for API creates that pass `sandbox: true`.                                                                                                                                                 |
| `idleStopMinutes`                               | Sleep after this much idle time (default 30).                                                                                                                                                                                   |
| `callbackBaseUrl`                               | Dial-back URL when the public ingress origin should not be used (tailnet setups).                                                                                                                                               |
| `publicIngress`                                 | Advanced bind override for the `:3860` listener. Needs a restart.                                                                                                                                                               |
| `daytona.snapshot`                              | Org snapshot new Daytona sandboxes start from when no project snapshot exists (sizing lives in it).                                                                                                                             |
| `cloneCredential`                               | `{type: "none"}` or `{type: "https-token", token}` for repository clones inside Sandboxes. The live GitHub App wins.                                                                                                            |
| `prewarm`                                       | `enabled`, `ttlMinutes`, `maxLive`, `keepReady` for the warm-on-typing pool.                                                                                                                                                    |
| `runnerBundleUrl`, `runnerRepoUrl`, `runnerSha` | Where Sandboxes fetch the Open Session runner payload. Unset, a source install runs the runner at its own deployed commit, so every deploy carries it along; set `runnerSha` only to hold or roll back the runner deliberately. |
| `automation.egressAllowlist`                    | Extra hosts unattended runs may reach.                                                                                                                                                                                          |

Retired keys (`image`, `workspace`, `transport`, `previewPorts`, `snapshots`,
`e2b`, `modal`, `awsLambdaMicrovm`) are ignored. Sessions that recorded a
retired provider (`docker`, `modal`, `e2b`, `lambda-microvm`) keep their
transcript but their Sandbox can no longer be woken; start a new session.

## Kill switch

```sh
touch ~/.opensession-sessions/disable-sandboxes
```

forces every new run onto the host regardless of config. Remove the file to
re-enable. Existing sessions keep their recorded provider; their next turn
fails clearly rather than silently running on the host.

## Certification

Both providers passed the live conformance matrix (Daytona 2026-08-11, Box
2026-08-13): engine round trip, exec semantics, in-sandbox workspace git,
Portal relay, sleep/wake, snapshot restore with credential scrub, and cleanup.
Re-run it with `bun run deploy/sandbox/conformance.ts [daytona] [box]`; it
uses scratch state and never touches live sessions. The certification dates in
`src/server/sandbox/config.ts` gate which providers can be selected.

## Provider notes

### Daytona

Sandboxes are labeled `opensession.session=<id>`. Daytona stops an idle
sandbox itself (`autoStopInterval`) and retains the disk; wake is `start`.
Project snapshots are Daytona snapshots. Daytona's default image (1 vCPU / 1
GB / 3 GiB) is too small for real repositories: set a sized org snapshot
under the connection's settings. Automations use Daytona's per-sandbox domain
allowlist. Self-hostable.

### Box (ascii.dev)

Boxes are named after the session. Sleep is `stop` (archive, disk retained);
wake is `resume`, after which the workspace is re-hydrated in the background.
Project snapshots are named snapshots. Box serializes command admission per
VM, so concurrent control-plane calls queue. Destroy archives the Box; your
dashboard retains it.

## Security posture

A Sandbox isolates the agent's filesystem, processes, and network from this
host and from other sessions. It is third-party compute: the repository clone
credential, a scoped model credential, and short-lived workload identity
leases enter it; the instance config, other users' credentials, and the
session store do not. Portal routes forward-authenticate every request
against Open Session before proxying. Portals inherit the instance's team
boundary; there is no narrower per-session ACL yet.
