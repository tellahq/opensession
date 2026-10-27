# Self-hosting sandboxes

How to run Open Session sessions inside their own machines. A **Sandbox** is a
Linux VM in your Daytona or Boat account, or a macOS VM on a Mac you pair as
a Runner, with the repository checked out, its `.agents/setup` already run,
and a durable disk. It sleeps between turns,
wakes when the next message arrives, and comes back with files, running
Portals, and the conversation intact. Companion to
[`deploy/sandbox/README.md`](../deploy/sandbox/README.md) (the base runtime) and
[repo-lifecycle.md](repo-lifecycle.md) (what a repository commits).

**Default = This machine.** The new-session menu's **Machine** row offers
This machine plus every Ready Sandbox provider by name (Boat, Daytona,
use.computer, Mac VM, Modal), each with a line saying whether it is Linux or a
Mac. Modal also appears as **Modal · T4 GPU** and **Modal · L4 GPU**.
The workspace or personal default is marked there and can make a Sandbox the
norm, and a project can be pinned under **Workspace → Sandboxes → Projects** so
every new session on it starts in a Sandbox whatever the workspace or person
chose; that is how a repository's app always runs in a Sandbox Portal rather
than on this server.
Precedence is project, then personal, then workspace; a per-session choice
always wins.

Every model works with a Sandbox: the agent loop runs on this server, and
only the workspace is in the Sandbox (see [Where the agent runs](#where-the-agent-runs)).

## Setup

1. **Public ingress.** Sandboxes reach this server over WebSocket. Configure
   the workspace's public callback origin once under **Settings → Domains and
   ingress → Public callbacks** (Cloudflare Tunnel or Direct HTTPS with Caddy),
   or run `opensession sandbox ingress install https://ingress.example.com`.
   The same fail-closed listener on `:3860` receives signed integration
   webhooks, Sandbox callbacks, and workload identity; the private app on
   `:3850` is never part of it.
2. **Connect a provider.** In **Workspace → Sandboxes**, connect Daytona,
   Boat, or **use.computer** (macOS on reserved Macs; see
   [use.computer](#usecomputer) below) with an API key, **Modal** (Linux
   with an optional GPU; see [Modal](#modal) below) with a token, or **Mac VM** with a
   paired macOS Runner (no credential; see
   [Mac VM](#mac-vm-tart-on-a-mac-runner) below). Credentials
   are written once to the server-side workspace secret store and never
   returned to the browser or placed in a Sandbox. Connecting runs a
   qualification: ingress is verified, a disposable sandbox is created, a
   snapshot restore is proven, and everything is cleaned up. Only a **Ready**
   connection is offered to sessions.
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
  provider's base image), installs the base runtime, and clones the
  repository inside it. The workspace lives in the Sandbox; after every clean
  turn its state is checkpointed to origin (see below), so a lost or replaced
  machine continues from the last checkpoint;
- runs the repository's `.agents/setup` once per disk, and `.agents/resume`
  on every wake;
- runs the agent loop on this server, like any other session, with the
  Sandbox as its workspace: every file read, edit, search and shell command
  the agent makes runs in the VM (see [Where the agent runs](#where-the-agent-runs));
- exposes services as **Portals**: authenticated HTTPS routes on this host
  that relay to the Sandbox. The browser never sees a provider URL;
- puts the Sandbox to sleep once it is idle (see [Sleep and wake](#sleep-and-wake)).
  Sleeping costs no compute. Sends while asleep persist in the durable queue;
  the first one wakes the Sandbox, `.agents/resume` runs (the wake waits for
  it up to 10 seconds), the Portals that were awake are restarted, and then
  the queue drains.

The session's **Sandbox** badge shows Preparing, Awake, Sleeping, Waking, or
Needs attention, with manual sleep, wake, checkpoint, and rebuild, plus the
`setup` and `resume` logs and the age of the last checkpoint.

## Where the agent runs

The agent loop, its model credentials, the conversation, MCP connections and
permission checks stay on this server. Each Sandbox turn runs in an ordinary
detached run host here, exactly like a session on this machine; only its
workspace tools are remote. `read`, `write`, `edit`, `ls`, `find`, `grep` and
`bash` each become one command in the Sandbox, sent over the server's run-rpc
socket (`/workspace/exec`) with the run's own token. The server resolves the
token to the session's recorded Sandbox, so a run can reach its own machine
and nothing else, and a session without a Sandbox is refused rather than run
here.

So a Sandbox needs only the base runtime: the workspace tools, the pinned
Node, just, gh and bun, and the `opensession` identity command. No model
credential, runner payload or conversation history is placed in it, and a
deploy of Open Session changes nothing inside it. A Sandbox that crashes or
fills its disk fails the tool call; the turn, its history and the session
survive, and the next turn continues on a rebuilt machine.

Shell commands run in their own process group with output going to a file,
so a Stop or a timeout reaches everything a command started, and a server it
left in the background does not hold the call open. The command receives the
run's GitHub and git identity; this server's paths and file-based
credentials (AWS, Claude or Codex CLI pools) are never passed. The skills
this server ships are read from here; the checkout's own AGENTS.md and
skills are read from the Sandbox at the start of each turn.

A tool call costs one provider round trip: about 25 to 110 ms on Boat over
its SSH lane and 120 to 300 ms on Daytona. `deploy/sandbox/verify-remote-workspace.ts`
measures it against a live provider. With the Sandbox agent connected (below)
it is one frame on a socket the Sandbox opened itself.

### The Sandbox agent

A Sandbox can run a small agent (`src/runner-host/sandbox-agent.ts`) that
dials out to this server's public ingress at `/sandbox-agent-ws`. While it is
connected, the Sandbox's commands, background processes and file writes
travel over that socket instead of the provider's command API or SSH. Nothing
has to reach into the machine, so the provider-specific part of an adapter
shrinks to creating, starting, stopping, snapshotting and deleting machines;
`withSandboxAgent` in `sandbox/agent-driver.ts` wraps any adapter's driver.

- The server copies the agent into the Sandbox and starts it with the base
  runtime's bun once the machine is up, and again whenever it is not
  connected when a command needs the machine. It runs as the Sandbox user.
- It authenticates with a token minted for that one Sandbox. The token
  reaches the machine in a file under `/tmp` that the agent reads once and
  deletes, so it is never on disk while the agent runs, never in a project
  snapshot, and never in the environment of a command the agent starts.
  The server keeps only its hash, in memory.
- A new token revokes the previous one and closes its socket, so a Sandbox
  restored from another's snapshot can never answer for it. Retiring a
  Sandbox revokes its token with its workload identity leases.
- After a server restart the old tokens are unknown: each agent's probe gets
  a 403 and the agent exits, instead of retrying against the public ingress.
  The next command that needs the Sandbox starts a fresh one.
- Each command runs in its own process group with a timeout that reaches
  every process it started. Background processes are detached and outlive
  the agent.
- The provider's own lane stays: it bootstraps the machine (the agent needs
  bun), starts the agent, and carries every command while the agent is not
  connected. A missing agent can make a Sandbox only as slow as it was
  before, never unusable.

Boat and use.computer Sandboxes run the agent by default. `agent.providers`
in `sandbox.json` lists the providers that do (`["box", "usecomputer"]` when
absent), and
`OPENSESSION_SANDBOX_AGENT=0` in the server's environment turns it off
everywhere. The Sandbox badge says whether commands go through the agent or
the provider's API, and the agent logs to `~/.opensession/agent/agent.log`
inside the Sandbox.

## Checkpoints

A Sandbox's disk is the only copy of the session's uncommitted work, and a
provider can lose or replace that disk. After every clean turn, and before a
manual sleep, rebuild, or move, Open Session pushes a **checkpoint** to
origin: one synthetic commit whose parent is the branch tip and whose tree is
the working tree, reachable from `refs/opensession/checkpoints/<session id>`.
The ref is hidden (GitHub shows it nowhere and `git fetch` never pulls it),
costs no host storage, and is removed when the session is deleted; an archived
session keeps it. Ignored files, the repository's private seed files, and
`.ports.conf` never enter a checkpoint. The push uses the workspace's GitHub
App credential in the command's environment only; the Sandbox's origin stays
credential-free. Repositories that are not on GitHub have no checkpoints.

A checkpoint is restored whenever a fresh workspace is materialized for a
session that has one: a **Rebuild sandbox** from the badge, a replacement
machine after the provider lost the old one, or a move. The branch lands on
the checkpoint's tip with the checkpointed changes uncommitted, exactly as the
agent left them. A restore that fails is loud (the badge shows Needs
attention with the reason) rather than silently starting from origin, and the
clone credential is scrubbed from the workspace's origin either way.
`POST /api/sessions/<id>/sandbox/checkpoint` takes one on demand.

Checkpoints, moves, rebuilds, and manual sleep all run on one per-session
lifecycle lane: one at a time, in order. A turn does not start while an
operation is in flight, and an operation refuses (409) while a turn is
admitted, so a capture never reads a tree the agent is editing, no turn
starts against a Sandbox that is about to be destroyed, and the recorded
commit is always the one the ref points at.

Deleting a session is a lifecycle operation too: it runs on the same lane,
removes the hidden ref while it holds the lane, and any checkpoint or move
still queued behind it finds no session and refuses (410) rather than acting
on the deleted record or pushing the ref back.

A checkpoint is labeled with the branch the checkout is actually on, read
inside the Sandbox by the checkpoint script itself. When the agent renamed
or switched branches during a turn, the session record follows the checkout
in the same write, so the checkpoint restores onto, and later publication
targets, the branch the work is really on; a detached HEAD takes no
checkpoint. A checkpoint is restored only onto the branch it was taken
from. The record carries that branch and every restore checks it before
touching anything; a
session that switched branches after its last checkpoint has, for the
purposes of a move or rebuild, no checkpoint (the refusal says so), and a
replacement Sandbox that would otherwise restore it is parked as Needs
attention rather than moving the new branch onto the old tip.

Nothing destroys a reachable Sandbox on the strength of an older checkpoint.
A rebuild or a move away from a Sandbox first takes a checkpoint now; when
that is impossible (no branch, default branch, no credential) the request is
refused with the reason, and only an explicit second answer (the badge's
rebuild asks again; a move to this machine asks to leave the files behind)
proceeds without the Sandbox's files. The recorded checkpoint is used only
when the Sandbox cannot be reached at all.

## Moving a session

A code session can move between this machine and any ready Sandbox provider,
in every direction, from its ⋯ menu (_Move to Sandbox_ on this machine,
_Move session_ in a Sandbox). The agent must be idle. From the next message
on its tools act on the destination. The agent loop and its conversation
stay on this server, so nothing about the conversation moves.

- **This machine → Sandbox** (`POST /api/sessions/<id>/sandbox/attach`): the
  worktree is checkpointed first, so uncommitted work travels along. Portals
  on this machine stop; the Sandbox is provisioned in the background and
  restores the checkpoint, and the badge turns Awake when it is up. The next
  message adopts it, waiting on the provider's per-session lock if it is still
  booting. When no checkpoint is possible (a shared checkout, a repository off
  GitHub, the default branch), the old rule applies: with unpublished work the
  move answers 428 and asks before moving anyway.
- **Sandbox → Sandbox** (same route with another provider): the current
  Sandbox is woken if needed and checkpointed, then released; the new one
  restores the checkpoint. Refused when the Sandbox cannot be reached and no
  checkpoint exists.
- **Sandbox → This machine** (`POST /api/sessions/<id>/sandbox/detach`): the
  Sandbox is checkpointed, the checkpoint is restored into a worktree on this
  server (the branch need not exist on origin), and the Sandbox is released.
  An unreachable Sandbox falls back to its last checkpoint; with none, the
  move answers 428 and continues from the branch as origin has it only after
  confirmation. The restore never lands in a checkout that may hold someone
  else's work: finding, creating, and rewriting the worktree is one step
  under the repository's git lock, and a branch already checked out on this
  machine refuses the move (409, naming the checkout), except the session's
  own former worktree when it is clean and the checkpoint extends its tip.
  The same rule protects a branch this machine still has without a worktree
  (left by an earlier cleanup, possibly with commits that were never
  pushed): it is restored onto only when the checkpoint extends its tip;
  only a branch created for the restore is reset outright. A restore that
  fails on a worktree the move just created removes that worktree again
  (and the branch, if it created that too) before the lock is released, so
  retrying the move finds the branch free rather than a half-restored
  checkout.

Whichever way a session leaves a Sandbox, the old machine is retired the
same way a deleted session's is: its workload-identity leases are revoked
first, then its Portal routes are dropped, then it is destroyed. A destroy
the provider refuses or swallows therefore cannot leave a running machine
that can still exchange for credentials.

A move that failed shows Needs attention and can be attempted again.

Terminal tabs land inside the Sandbox (Daytona's native PTY, Boat's SSH).

## The app in a Sandbox, the session on this machine

A project can keep its sessions on this machine and still run its dev
server remotely. Set the project's **app** to a provider under Settings →
Sandboxes → Projects (`perRepo.<repo>.portalSandbox` in the runtime config).
Nothing changes for the session itself: the worktree and the agent stay on
this machine, and the Sandbox badge stays off. The first time a Portal is
started, by the person from the Portals panel or by the agent through
`start_declared_portal` or `start_portal`, Open Session:

- checkpoints the worktree, so uncommitted work travels too. A worktree
  that cannot be checkpointed (a repository not on GitHub, the default
  branch, no credential) gets no Portal Sandbox: the start is refused with
  the reason, rather than bringing up a machine built from origin that
  shows older code;
- provisions a **Portal Sandbox** for the session (the provider names it
  `<session id>--portals`) and materializes the branch on that checkpoint,
  exactly as a rebuild would, then checkpoints and lands once more, so a
  turn that finished while the machine came up is on it too;
- starts the Portal there and relays it as usual. The Portals panel says so,
  with the machine's state while it prepares, sleeps, or needs attention.

A Portal Sandbox carries only the base runtime: the workspace tools, the
pinned Node, just, gh and bun, and the `opensession` identity command. The
agent runs on this machine, so none of the runner payload is installed there,
and deploying Open Session does not make the machine reinstall anything.

After every clean turn the worktree is checkpointed again and the Portal
Sandbox's checkout is landed on it (whatever branch it was on), so the app
shows what the agent just did at turn granularity; the dev server's own file
watcher does the rest. A sleeping Portal Sandbox catches up when a Portal
wakes it, and a start or restart lands the latest checkpoint first, before
the Portals the machine was running are relaunched; when that landing
fails, the start fails with it and says why, and nothing is relaunched,
rather than bringing the app up on the older tree the machine still holds.
A start or wake from the Portals panel while the agent is working is
refused ("Wait for the agent to finish"), since it would checkpoint a tree
mid-edit; the agent's own `start_declared_portal` call is not, its worktree
being at rest while the tool runs. A turn asked for while a Portal Sandbox
wakes starts once the wake is done. The
checkout there is nobody's work: nothing in it is ever pushed or restored
back, and its origin stays credential-free.

The Portal Sandbox is torn down with the session, and when the session moves
into a workspace Sandbox (whose Portals run there). A session that already
runs in a workspace Sandbox, or on a Runner, runs its Portals there and never
gets one. A Portal Sandbox the provider has lost is replaced on the next
start; a failed provisioning shows its reason in the Portals panel and is
retried by starting the Portal again.

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
window at 0x0. Boat has no control API, so Open Session drives the sandbox's
own X display (`:0`) with `xdotool` and ImageMagick over the command channel.
A call on a sleeping Sandbox wakes it first.

- **Boat** mints a 60fps stream page (`POST /sandboxes/{id}/desktop`).
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

A provider may restore only the home directory from a snapshot (Boat brings
back `/home/user` over a fresh base image), so the base runtime installed
outside it (Node, just, gh in `/usr/local`) is checked on every start and
reinstalled when missing. Before a snapshot is sealed, the Bun package cache
is checked for packages that lost their executables; a damaged cache is
cleared and setup runs again, so the damage never reaches the next image.

Typing a new-session prompt also starts a **prewarm**: Open Session begins
provisioning a Sandbox before Create is pressed and adopts it at create time.
Prewarms expire after ten minutes when unused; at most two are live at once.
This is automatic wherever a Ready provider exists; disable it with
`"prewarm": {"enabled": false}` in `~/.opensession/sandbox.json`.

**Keep one ready** on a project snapshot card holds a prepared Sandbox for
that project between sessions, whoever starts the next one and without
waiting for typing. It is refilled after each adoption, counts against the
live prewarm limit, and is stored as `prewarm.keepReady`. Nothing is kept
ready unless a project is switched on here.

Each project snapshot carries a **machine size** (Small, Medium, Large),
mapped to the provider's shapes. Daytona sizes require a base snapshot created
with those resources; Boat exposes three fixed machine types.

## Sleep and wake

A Sandbox sleeps once **both** are true:

- the agent has done no work in it for 5 minutes (`idle.agentMinutes`): no
  tool call and no turn running for the session;
- nobody has interacted with it for 20 minutes (`idle.humanMinutes`): a
  person's prompt, any request to one of its Portals (whoever makes it), a
  Terminal or Desktop opened on it, or a manual wake.

So a turn somebody sent keeps the machine around while they look at the
result, and a turn an automation started lets it sleep five minutes after the
work ends. Sleeping goes through the same path as the badge's Sleep action:
on the session's lifecycle lane, the workspace is checkpointed first, Portal
routes are suspended so opening one wakes the machine, and only then is the
provider stopped. A host session's Portal Sandbox sleeps the same way. While a
machine is in use the server keeps the provider's own idle timer (Boat's
countdown, `idleStopMinutes`) from firing, which stays as the backstop for a
machine nothing has touched since the server started.

Asleep, every provider keeps the disk but not memory: files, installed tools
and the checkout are there on wake; dev servers, Terminal shells and Desktop
apps start again. The Sandbox badge, the Portals panel and
Workspace → Sandboxes say so, and the badge counts down to the next sleep.

A start that finds the provider full (every Mac host at its VM budget)
waits for room instead of failing, for up to 15 minutes.

## Repo lifecycle hooks

Sandboxes honor the repository contract in [repo-lifecycle.md](repo-lifecycle.md):
`.agents/setup`, `.agents/resume`, and `.agents/portals.json`. A declared
Portal starts from the Portals panel or through `start_declared_portal`; the
agent can also expose any process with `start_portal`. Portal processes
receive `PORT` and `PORTAL_URL`. Logs live under
`~/.opensession/lifecycle/` inside the Sandbox.

Setup is capped at 20 minutes and every process it leaves running is stopped
before the disk can become a project snapshot. A wake waits at most 10
seconds for `.agents/resume`. Two scripts can live in Workspace → Sandboxes
instead of a repository: a project's **setup script**, run right before
`.agents/setup` and part of the snapshot's inputs, and the workspace
**resume script**, run before `.agents/resume` in every Linux Sandbox (for a
fix every machine needs and no repository can deliver).

## Workload identity

A Sandbox never receives long-lived cloud credentials. Lifecycle hooks and
Portals receive a short-lived workload identity lease that they exchange for
scoped cloud roles (`OPENSESSION_WORKLOAD_IDENTITY_*`); see
[repo-lifecycle.md](repo-lifecycle.md#workload-identity-from-a-sandbox).
Model credentials never enter a Sandbox: the agent loop runs on this server.

## Automations

Unattended runs (automations and public review) use disposable Daytona
sandboxes with a per-sandbox egress allowlist enforced by the provider. They
never adopt a prewarm or project snapshot. See
[security-model.md](security-model.md).

## Runtime config — `~/.opensession/sandbox.json`

Workspace → Sandboxes writes this file; hand-edit only for the operator
settings below. Read fresh per call, no restart needed except where noted.

| Key                                 | Meaning                                                                                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connections`                       | Provider connections and their qualification state. Managed by Workspace → Sandboxes.                                                                                   |
| `sessionDefault`                    | `"daytona"`, `"box"`, `"tart"`, or `"none"`: where new sessions run when nobody chose.                                                                                  |
| `provider`, `perRepo.<id>.provider` | Legacy default and per-repo override for API creates that pass `sandbox: true`.                                                                                         |
| `perRepo.<id>.sessionDefault`       | `"daytona"`, `"box"`, or `"none"`: where new sessions on that repo run, ahead of the workspace and personal defaults. Managed by Workspace → Sandboxes → Projects.      |
| `idleStopMinutes`                   | The provider's own idle backstop (default 30); the two timers below decide when a machine in use sleeps.                                                                |
| `idle.agentMinutes`                 | Sleep once the agent has done no work for this long (default 5)...                                                                                                      |
| `idle.humanMinutes`                 | ...and nobody has interacted for this long (default 20). See [Sleep and wake](#sleep-and-wake).                                                                         |
| `agent.providers`                   | Providers whose Sandboxes run the [Sandbox agent](#the-sandbox-agent) (default `["box", "usecomputer"]`; `[]` turns it off).                                            |
| `workspaceResumeScript`             | Runs before `.agents/resume` in every Linux Sandbox. Managed by Workspace → Sandboxes.                                                                                  |
| `perRepo.<id>.preSetupScript`       | Runs before `.agents/setup` for that project. Managed by Workspace → Sandboxes → Projects.                                                                              |
| `callbackBaseUrl`                   | Dial-back URL when the public ingress origin should not be used (tailnet setups).                                                                                       |
| `publicIngress`                     | Advanced bind override for the `:3860` listener. Needs a restart.                                                                                                       |
| `daytona.snapshot`                  | Org snapshot new Daytona sandboxes start from when no project snapshot exists (sizing lives in it).                                                                     |
| `cloneCredential`                   | `{type: "none"}` or `{type: "https-token", token}` for repository clones inside Sandboxes. The live GitHub App wins.                                                    |
| `prewarm`                           | `enabled`, `ttlMinutes`, `maxLive` for the warm-on-typing pool; `keepReady` lists `{provider, repoId}` targets kept prepared (Keep one ready in Workspace → Sandboxes). |
| `automation.egressAllowlist`        | Extra hosts unattended runs may reach.                                                                                                                                  |

Retired keys (`image`, `workspace`, `transport`, `previewPorts`, `snapshots`,
`e2b`, `modal`, `awsLambdaMicrovm`, and the runner payload's
`runnerBundleUrl`, `runnerRepoUrl`, `runnerSha`) are ignored. A turn that was
running on the retired in-Sandbox runner when this release was deployed ends
with a note to send the prompt again; the Sandbox and its files are kept. Sessions that recorded a
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

All providers passed the live conformance matrix (Daytona 2026-08-11, Boat
2026-08-13, then called Box; Mac VM 2026-09-20 on the office Mac mini;
use.computer 2026-09-21 on a reserved Mac; Modal 2026-10-26, qualification,
exec, GPUs, and sleep/wake only): workspace tool round trip, exec
semantics, in-sandbox workspace git, Portal relay, sleep/wake, snapshot
restore with credential scrub, and cleanup.
Re-run it with `bun run deploy/sandbox/conformance.ts [daytona] [box]`; it
uses scratch state and never touches live sessions. The certification dates in
`src/server/sandbox/config.ts` gate which providers can be selected.

## Provider notes

### Daytona

Sandboxes are labeled `opensession.session=<id>`. Daytona stops an idle
sandbox itself (`autoStopInterval`) and retains the disk; wake is `start`.
Project snapshots are Daytona snapshots. Without a snapshot or explicit size,
Open Session cold-creates from `daytonaio/sandbox:0.8.0` with 2 vCPU, 4 GiB
memory and 10 GiB disk. Daytona's implicit 1 GiB / 3 GiB snapshot OOM-kills
the runner compiler (exit 137) and cannot hold the completed runtime. The
4 GiB / 10 GiB cold bootstrap and compiled runner were live-verified; larger
repositories may need more headroom. Explicit sizes still win, and configured
snapshots keep their baked-in size, so replace an undersized snapshot rather
than expecting the cold fallback to resize it. Bootstrap errors include the
command exit code even when the provider returns no output.

A failed setup may have a provider machine before the session records its
Sandbox ID. Moves and deletion recover that machine from its durable provider
mapping and wait for in-flight provisioning before retirement. Refused Daytona
deletions retain the mapping for retry; a move does not forget its source when
retirement fails. Automations use Daytona's per-sandbox domain allowlist.
Self-hostable.

### Boat (boat.dev)

Boat is the provider formerly called Box at ascii.dev. Its id stays `box` in
configuration, session state, and the conformance runner, so existing
connections and repo templates carry over; the API base is
`https://boat.dev/api/v1`, and a stored legacy `https://ascii.dev/api/box/v1`
base is mapped to it automatically. Existing `box_…` keys keep authenticating
next to new `boat_…` keys.

Sandboxes are named after the session. Sleep is `stop` (archive, disk
retained); wake is `resume`, after which the workspace is re-hydrated in the
background. Project snapshots are named snapshots. Boat serializes command
admission per VM, so concurrent control-plane calls queue. Destroy archives
the sandbox; your dashboard retains it.

### Mac VM (Tart on a Mac Runner)

Provider id `tart`. Each session gets a macOS virtual machine on one of the
Macs you already paired as Runners (Apple silicon, macOS 13 or later, the
Runner's user logged in to a desktop session). A Mac mini in the office and
an EC2 Mac instance are the same thing to the connection: a paired macOS
Runner with a VM budget. On macOS 15 and later the Runner
process also needs the **Local Network** privacy permission so the Mac can
reach its guests: accept the "bun would like to find and connect to devices
on your local network" dialog, or turn `bun` (the Open Session Runner) on
under System Settings → Privacy & Security → Local Network, then restart
the Runner service so the running process picks the decision up. macOS
records the decision per binary path, so a Homebrew upgrade of `bun` asks
again. The qualification reads the recorded decision and says which of
these is missing. Guest VMs run as launchd jobs on the Mac, so a Runner
restart or upgrade does not stop them. Inside a guest the session's
workspace keeps its canonical path: base preparation switches off the
`/home` automounter and aliases `/home/ubuntu` to the `admin` home. Nothing dials into the Mac: Open
Session drives [Tart](https://tart.run) through the Runner's authenticated
command channel and reaches each guest over SSH from the Mac itself, so the
guests need no address of their own. The Runner stays a trusted machine; the
VMs are the isolation boundary.

**Connect** lists the **Mac hosts** (each a paired macOS Runner with its own
**Max VMs**, default 2; Apple allows two macOS guests per host, and the host
shares its memory with them), the image, and the VM shape (default 4 CPUs,
6 GB). The qualification proves every host in turn: it installs the pinned
Tart release under `~/.opensession-tart` on the Mac, generates a host-local
SSH key, pulls the image (the default
`ghcr.io/cirruslabs/macos-tahoe-xcode:26.5` is about 70 GB on disk; plan
100 GB free and an hour for the first pull), prepares `opensession-base` (key
installed, sleep disabled, `cliclick` for desktop control), and then proves
a disposable VM: exec semantics, file upload, stop/start persistence, and a
distinct clone. Later connects are seconds per host. A failure names the
Mac it happened on, and every listed Mac must pass.

A new VM goes to the host with the most free slots, preferring one that
already holds the repo's project snapshot; ties keep the configured order.
The VM's state file records which Runner holds it, so sleep, wake, the
Desktop tab, and Terminal tabs return to that Mac. Offline hosts are skipped
for new VMs; a VM whose Mac is offline waits for it rather than being
recreated elsewhere. When every host is full, the start waits for a free
slot (up to 15 minutes, checking every 15 to 60 seconds) and the Sandbox
badge says so; after that the error lists each Mac's running VMs. Project
snapshots (`tpl-<repo>-<hash>`) live on the Mac that
sealed them; a session placed on another Mac clones the base instead, and
the snapshot stays valid where it is.

Session VMs are APFS clone-on-write clones of the base (`sbx-<session>`), so
creating one costs no space up front and takes seconds; the base runtime
install on first use takes a few minutes, and project snapshots
(`tpl-<repo>-<hash>`, local clones) remove that. The
guest user is `admin` with home `/Users/admin`; the workspace lives under
`/Users/admin/worktrees`. Sleep is `tart stop` (disk kept, processes gone);
wake boots the VM again and runs `.agents/resume`. Idle VMs are stopped
after `idleStopMinutes` by the server, since Tart has no idle timer of its
own. Destroy deletes the VM.

The Desktop tab shows the guest's screen: Tart serves each running VM over
VNC on the Mac's own loopback, and the Runner relays that stream frame by
frame to the viewer in the browser, so the guest still needs no address of
its own. A Terminal tab is a shell inside the guest, opened by the Runner
over SSH with the same host-local key. Both are typed Runner operations that
name only the VM (the Runner resolves the port and the guest address itself)
and ride the `commands` permission the provider already needs; they require
the Runner to run this release or later. A full host does not start another
VM; the start waits for a slot as above and then says which sessions hold
them.

Portals ride the outbound relay like every remote provider. The agent's
`opensession-desktop` tools work (`screencapture` and `cliclick` inside the
guest). Automations never run here: the guest network is not
policy-enforced.

More capacity is more Macs: pair another Mac and add it under **Configure**
on the Mac VM card. [mac-vm-hosts.md](mac-vm-hosts.md) walks through
preparing a Mac mini or an EC2 Mac instance as a host, including the
`deploy/mac-host/prepare.sh` script that does the machine-side steps. For
Macs you do not want to own or run, see use.computer below.

### use.computer

Provider id `usecomputer`. Each session gets a macOS virtual machine (Apple
silicon, Xcode) on a Mac mini reserved in your [use.computer](https://use.computer)
account; the service places it, keeps a warm pool of booted VMs, and stores
snapshots. Reservations are the unit of capacity: a Mac reserved for 24
hours or more runs two VMs (5 CPU, 8 GB each), and sandboxes inside the
reservation are free to create and delete. **Connect** takes the account API
key (`uc_live_…`) from the service's Settings; add a reservation id under
**Provider settings** only when the account holds more than one active
reservation. That includes booking a replacement Mac before the current one
ends: while both are active the service refuses to pick one, and its API
cannot list them, so enter the new reservation's id before the next sandbox
starts. Update or clear it once that reservation ends. The qualification
checks the reservation and its free slots, creates a disposable sandbox,
proves exec semantics, file upload, and guest preparation, restores a snapshot of it into a second sandbox, and deletes
everything. It takes about six minutes; the snapshot dominates.

The guest user is `lume` with home `/Users/lume`; the workspace lives under
`/Users/lume/worktrees`, and guest preparation aliases `/home/ubuntu` to that
home so the session's canonical path resolves. The base runtime install on
first use takes a few minutes; project snapshots (service snapshots, restored
on any reserved Mac) remove that, and prewarms adopt as on
Daytona. Prewarms are never parked, since a stopped VM would still hold one of
the reservation's slots: they are adopted or destroyed.

Sleep is a snapshot followed by deleting the VM, which frees its slot
(measured: about four minutes to seal a fresh VM); wake restores the snapshot
into a fresh VM (about two minutes) and runs `.agents/resume`. Because the
service names VMs itself, the sandbox id a session records here is stable
(`uc-<session>`) and the state file maps it to the VM the service currently
holds. Idle sessions are put to sleep by the server after `idleStopMinutes`,
since the service's own idle timeout deletes the VM outright. Destroy deletes
the VM and its sleep snapshot. The reservation's end deletes every sandbox on
it: push your work, or extend the reservation, before then.

The Desktop tab relays the service's VNC stream on this origin, like the Mac
VM provider; the agent's `opensession-desktop` tools use the service's input
and screenshot API, with window titles from AppleScript inside the guest. A
Terminal tab is a local `ssh` whose transport is the service's SSH WebSocket
proxy (`scripts/ws-stdio-proxy.ts` as the ProxyCommand); the VM's login
password reaches `ssh` through `SSH_ASKPASS`, never argv. Portals ride the
outbound relay. Automations never run here: the guest network is not
policy-enforced.

### Modal

Provider id `modal`. Each session gets a Linux container in your
[Modal](https://modal.com) account, optionally with one NVIDIA GPU: **T4**
(16 GB) or **L4** (24 GB). Pick the GPU per session in the Machine menu, or
pass `sandboxGpu: "T4" | "L4"` with `sandbox: "modal"` to the
`create_session` and `spawn_task` tools. A GPU on any other provider fails the
create. The GPU is for work that needs one, such as GPU render tests; it is
billed per second while the container is awake.

**Connect** takes a token id (`ak-…`) and its secret (`as-…`) from Modal's
token settings, or both pasted into the secret field as `ak-…:as-…`.
Qualification builds the base image, starts a small container without a GPU,
proves exec and file upload, restores a filesystem snapshot into a second
container, and terminates both (about 40 seconds once the image is cached).

The base image is Ubuntu 24.04 with build tools, clang, CMake, Ninja, NASM,
the OpenSSL headers, the AWS CLI v2, Rust
(rustup under `/home/ubuntu`), and the Vulkan and GL loader libraries. Modal
injects the NVIDIA driver with every capability, so with those libraries
`vulkaninfo` lists the GPU as a discrete device instead of falling back to
llvmpipe, and CUDA works as well. Commands run as root with
`HOME=/home/ubuntu`.

Sizes: project snapshots use Small (2 CPU, 8 GB), Medium (4 CPU, 16 GB, the
default) or Large (8 CPU, 32 GB). A GPU session gets at least 8 CPU and 32 GB.
Prewarms never hold a GPU; a GPU session starts from the project snapshot.

Sleep takes a filesystem snapshot (kept 30 days) and terminates the container;
wake starts a new container from it, with the GPU the session asked for, and
deletes the old image only once the new container answers. Memory and running
processes do not survive. Modal caps a container at 24 hours, so an awake
container is replaced the same way after 22 hours, or when the session's GPU
changes. The Sandbox id a session records is stable (`md-<session>`); the
state file maps it to the current container. Project snapshots are kept 90
days, and a replaced one is deleted ten minutes later.

If a GPU container's start fails after it was created (the repository's setup
script, a dial-back), it sleeps at once so it stops holding the GPU. Any
Sandbox a failed start leaves behind, on any provider that reports it, is
recorded on the session: **Sleep** works on it, and the idle timers put it to
sleep like any other machine.

A new container counts as started once it runs a command; until then it may
be waiting for a GPU, and the start waits up to ten minutes for one. A
prewarm or project-snapshot container left behind by a server restart is found
by the prewarm orphan audit (every ten minutes) and terminated. Opening a
sleeping session's files or diff wakes its Sandbox like **Wake** does: the
session shows it awake, and the idle timers count it as an interaction.

A Terminal tab is a Modal exec with a PTY. There is no Desktop. Portals ride
the outbound relay. The Sandbox agent is not on by default here; add
`"modal"` to `agent.providers` to try it.

A session can get a GPU three ways:

- **Start on one:** pick **Modal · T4 GPU** or **Modal · L4 GPU** as the
  Machine. A project's default Machine (Workspace > Sandboxes > Projects)
  may be one of these too; an unchosen Machine then starts there.
- **Move onto one:** **Move to Sandbox** (or **Move session**) lists the same
  three Modal entries. Moving between them replaces the container with one
  carrying the new GPU; moving back to this machine drops it.
- **Run GPU jobs from anywhere:** a session on this machine or in a CPU
  Sandbox keeps running where it is and sends GPU work to a GPU machine of
  its own with `run_gpu_job` (`opensession-gpu`, interactive runs only). The
  job checkpoints the session's work, uncommitted changes included, lands it
  on the session's GPU machine (`md-<session>--gpu`, created on first use,
  woken after), and runs the command from the repository root with a
  read-only GitHub credential for the repository and its `readRepos`. The
  command runs detached inside the machine and writes its log and exit code
  there, so it survives a restart of this server; the registry
  (`gpu-jobs.json` in the state dir) is reattached at boot. When the job
  ends, its log is copied to the session's scratch folder and the session is
  woken once with the exit code and the end of the output. The machine keeps
  its build output between jobs (a landing never removes ignored files) and
  sleeps five minutes after its last job, whatever the session itself is
  doing; archiving the session puts it to sleep and deleting it destroys it.

A repository names its GPU jobs in `.agents/gpu-jobs.json`, and sessions on
this machine are told about them each turn, so asking for "the GPU tests"
needs no setup:

```json
{
  "jobs": {
    "gpu-tests": {
      "description": "Render tests on a real GPU",
      "command": "scripts/gpu-tests.sh",
      "gpu": "T4",
      "timeoutMinutes": 60
    }
  }
}
```

`gpu` is `T4` (default) or `L4`; `timeoutMinutes` defaults to 60 and is
capped at 360. The agent may pass its own `command` (one test) instead. The
command sees `OPENSESSION_GPU`, `OPENSESSION_GPU_JOB_ID`, `CI=1` and
`RUNNER_TEMP=/tmp`.

## Security posture

A Sandbox isolates the agent's filesystem, processes, and network from this
host and from other sessions. It is third-party compute: the repository clone
credential, the run's GitHub token inside each shell command's environment,
and short-lived workload identity leases enter it; model credentials, the
instance config, other users' credentials, and the session store do not. Portal routes forward-authenticate every request
against Open Session before proxying. Portals inherit the instance's team
boundary; there is no narrower per-session ACL yet.
