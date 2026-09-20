# Self-hosting sandboxes

How to run Open Session sessions inside their own machines. A **Sandbox** is a
Linux VM in your Daytona or Boat account, or a macOS VM on a Mac you pair as
a Runner, with the repository checked out, its `.agents/setup` already run,
and a durable disk. It sleeps between turns,
wakes when the next message arrives, and comes back with files, running
Portals, and the conversation intact. Companion to
[`deploy/sandbox/README.md`](../deploy/sandbox/README.md) (runner payload) and
[repo-lifecycle.md](repo-lifecycle.md) (what a repository commits).

**Default = This machine.** The new-session menu offers one choice, **Run in:
This machine or Sandbox**. Which provider backs "Sandbox" is the workspace's
decision (Workspace → Sandboxes), never the person creating the session. A
workspace or personal default can make Sandbox the norm, and a project can be
pinned under **Workspace → Sandboxes → Projects** so every new session on it
starts in a Sandbox whatever the workspace or person chose; that is how a
repository's app always runs in a Sandbox Portal rather than on this server.
Precedence is project, then personal, then workspace; a per-session choice
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
   Boat with an API key, or **Mac VM** with a paired macOS Runner (no
   credential; see [Mac VM](#mac-vm-tart-on-a-mac-runner) below). Credentials
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
  provider's base image), installs the runner payload, and clones the
  repository inside it. The workspace lives in the Sandbox; after every clean
  turn its state is checkpointed to origin (see below), so a lost or replaced
  machine continues from the last checkpoint;
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
Needs attention, with manual sleep, wake, checkpoint, and rebuild, plus the
`setup` and `resume` logs and the age of the last checkpoint.

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
on it runs on the destination; a fresh engine is seeded from the stored
transcript, so the conversation carries over.

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
| `sessionDefault`                                | `"daytona"`, `"box"`, `"tart"`, or `"none"`: where new sessions run when nobody chose.                                                                                                                                          |
| `provider`, `perRepo.<id>.provider`             | Legacy default and per-repo override for API creates that pass `sandbox: true`.                                                                                                                                                 |
| `perRepo.<id>.sessionDefault`                   | `"daytona"`, `"box"`, or `"none"`: where new sessions on that repo run, ahead of the workspace and personal defaults. Managed by Workspace → Sandboxes → Projects.                                                              |
| `idleStopMinutes`                               | Sleep after this much idle time (default 30).                                                                                                                                                                                   |
| `callbackBaseUrl`                               | Dial-back URL when the public ingress origin should not be used (tailnet setups).                                                                                                                                               |
| `publicIngress`                                 | Advanced bind override for the `:3860` listener. Needs a restart.                                                                                                                                                               |
| `daytona.snapshot`                              | Org snapshot new Daytona sandboxes start from when no project snapshot exists (sizing lives in it).                                                                                                                             |
| `cloneCredential`                               | `{type: "none"}` or `{type: "https-token", token}` for repository clones inside Sandboxes. The live GitHub App wins.                                                                                                            |
| `prewarm`                                       | `enabled`, `ttlMinutes`, `maxLive` for the warm-on-typing pool; `keepReady` lists `{provider, repoId}` targets kept prepared (Keep one ready in Workspace → Sandboxes).                                                         |
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

All providers passed the live conformance matrix (Daytona 2026-08-11, Boat
2026-08-13, then called Box; Mac VM 2026-09-20 on the office Mac mini): engine
round trip, exec semantics, in-sandbox workspace git, Portal relay,
sleep/wake, snapshot restore with credential scrub, and cleanup.
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

Provider id `tart`. Each session gets a macOS virtual machine on a Mac you
already paired as a Runner (Apple silicon, macOS 13 or later, the Runner's
user logged in to a desktop session). On macOS 15 and later the Runner
process also needs the **Local Network** privacy permission so the Mac can
reach its guests: accept the "bun would like to find and connect to devices
on your local network" dialog, or turn `bun` (the Open Session Runner) on
under System Settings → Privacy & Security → Local Network, then restart
the Runner service so the running process picks the decision up. macOS
records the decision per binary path, so a Homebrew upgrade of `bun` asks
again. The qualification reads the recorded decision and says which of
these is missing. Guest VMs run as launchd jobs on the Mac, so a Runner
restart or upgrade does not stop them. Nothing dials into the Mac: Open
Session drives [Tart](https://tart.run) through the Runner's authenticated
command channel and reaches each guest over SSH from the Mac itself, so the
guests need no address of their own. The Runner stays a trusted machine; the
VMs are the isolation boundary.

**Connect** picks the Runner, the image, the VM shape (default 4 CPUs, 6 GB),
and **Max VMs** (default 2; Apple allows two macOS guests per host, and the
host shares its memory with them). The qualification installs the pinned
Tart release under `~/.opensession-tart` on the Mac, generates a host-local
SSH key, pulls the image (the default
`ghcr.io/cirruslabs/macos-tahoe-xcode:26.5` is about 70 GB on disk; plan
100 GB free and an hour for the first pull), prepares `opensession-base` (key
installed, sleep disabled, `cliclick` for desktop control), and then proves
a disposable VM: exec semantics, file upload, stop/start persistence, and a
distinct clone. Later connects are seconds.

Session VMs are APFS clone-on-write clones of the base (`sbx-<session>`), so
creating one costs no space up front and takes seconds; the runner payload
bootstrap on first use takes a few minutes as on other providers, and
project snapshots (`tpl-<repo>-<hash>`, local clones) remove that. The
guest user is `admin` with home `/Users/admin`; the workspace lives under
`/Users/admin/worktrees`. Sleep is `tart stop` (disk kept, processes gone);
wake boots the VM again and runs `.agents/resume`. Idle VMs are stopped
after `idleStopMinutes` by the server, since Tart has no idle timer of its
own. Destroy deletes the VM. A full host refuses to start another VM and
says which sessions hold the slots.

Portals ride the outbound relay like every remote provider. The agent's
`opensession-desktop` tools work (`screencapture` and `cliclick` inside the
guest); a person-facing desktop view and Terminal tabs are not available
yet. Automations never run here: the guest network is not policy-enforced.

More capacity is more Macs: pair another Mac (a Mac mini, or an EC2 Mac
instance running the Runner client) and point the connection at it. One
host per connection today.

## Security posture

A Sandbox isolates the agent's filesystem, processes, and network from this
host and from other sessions. It is third-party compute: the repository clone
credential, a scoped model credential, and short-lived workload identity
leases enter it; the instance config, other users' credentials, and the
session store do not. Portal routes forward-authenticate every request
against Open Session before proxying. Portals inherit the instance's team
boundary; there is no narrower per-session ACL yet.
