# `opensession-runner` image

Prebaked container image for the **Docker sandbox provider** (operator guide:
`docs/self-hosting-sandboxes.md`). One container per session runs the
existing runner-host entry inside an isolated filesystem/env/network, with the
session's git worktree **bind-mounted at its identical host path**.

## What it contains

| Component                         | Purpose                                                                                                                                                                                        | Pin                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `bun`                             | runs the runner bundle + Bun `$` exec                                                                                                                                                          | `1.4.0` (host)                                    |
| Node.js LTS                       | native-dep builds, tooling                                                                                                                                                                     | `24.x`                                            |
| `git`, `gh`                       | clone / status / diff / push / PR                                                                                                                                                              | apt latest                                        |
| `ripgrep`                         | @-mention file search                                                                                                                                                                          | apt                                               |
| `python3`, `build-essential`      | worktree `bun install` native deps                                                                                                                                                             | apt                                               |
| `just`, `direnv`, `lsof`          | common repo dev-server bring-up chains (in-sandbox previews)                                                                                                                                   | apt / pinned release                              |
| Claude Code CLI                   | baked at the identical host CLI path for session-resume parity                                                                                                                                 | `2.1.218` (host); build FAILS on version mismatch |
| runner bundle                     | `/home/ubuntu/projects/opensession`: root manifests, lockfile, patches and `tsconfig.json`; copied protocol and server packages; `scripts/workload-identity-client.ts`; installed dependencies | from lockfile                                     |
| minimal `~/.claude/settings.json` | so `settingSources:["user"]` doesn't error                                                                                                                                                     | `{}`                                              |

Runs as uid **1000** user `ubuntu` (matches the host uid) so bind-mounted
worktrees keep sane ownership. Default `CMD` is `sleep infinity` — the provider
starts the container long-lived and `docker exec`s runs into it; there's no
baked ENTRYPOINT.

## Why path parity matters

The runner config points at host absolute paths: the claude CLI at
`/home/ubuntu/.local/bin/claude`, the runner bundle at
`/home/ubuntu/projects/opensession`, and the session worktree
bind-mounted at its **same** host path. The image reproduces every one of those
absolute paths exactly. If any drifts, the in-container runner can't find the
CLI, its dependencies, or the worktree. Do not "tidy" these paths — and if your
host's username/home/checkout path differs, edit them in the Dockerfile and
rebuild (see docs/self-hosting-sandboxes.md "Path parity is load-bearing").

## Build

```sh
deploy/sandbox/build.sh
```

Tags `opensession-runner:latest` and `opensession-runner:<git-sha>` from the repo
root context. Override the name with `IMAGE=... deploy/sandbox/build.sh`.

Version pins are Dockerfile `ARG`s: `BUN_VERSION`, `CLAUDE_VERSION`,
`NODE_MAJOR`, and `JUST_VERSION`. `build.sh` supports `IMAGE=...` but does not
forward command-line options. To override a pin, invoke `docker build` directly
with `--build-arg` or change the Dockerfile default.

## Runtime design (Phase 1 — DockerProvider)

`packages/core/opensession-server/src/server/sandbox/docker.ts` runs one container per session
(`bks-sbx-<sessionId>`, labels `opensession.sandbox=1` +
`opensession.session=<id>`, `--init`, `--restart no`, `--cpus`/`--memory` from
`~/.opensession/sandbox.json`, defaults 4 / 8g). A run is the same runner-host
entry the systemd path uses (`packages/core/opensession-server/src/runner-host/host.ts`), `docker exec -d`'d
into the container; its unix socket + spec/meta/journal/log live in a
bind-mounted per-session run dir (`~/.opensession/sessions/sandbox-runs/<id>`), so
the server drives it with the normal HostHandle machinery and can reattach
after a restart. Idle containers are `docker stop`ped after
`idleStopMinutes` (default 30) and restarted on the next turn.

These are the canonical paths for fresh installations. An existing legacy
top-level entry remains supported when it exists and its canonical
`~/.opensession/` replacement does not.

Mounts (rationale in the docker.ts header):

| Mount                                                                                                                              | Mode | Why                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| named vol → `~/.claude`, `~/.codex`                                                                                                | rw   | engine session state survives; NEVER a volume at `/home/ubuntu` (would shadow the baked CLI + bundle)                                    |
| session worktree at identical path                                                                                                 | rw   | diff/files/status/push/preview unchanged host-side                                                                                       |
| main checkout `.git` at identical path                                                                                             | rw   | worktrees aren't self-contained (`rev-parse --git-common-dir`); accepted Phase 1 tradeoff                                                |
| host `~/.claude/projects/<munged-cwd>`                                                                                             | rw   | engine transcripts stay host-visible (viewer tail, resume continuity)                                                                    |
| `~/.opensession/sessions/opensession-rpc.sock`                                                                                     | rw   | opensession-* stdio proxies (socket filename kept for protocol compat); goes stale across a server restart until the container restarts  |
| `~/.ssh`, `~/.gitconfig`, `~/.config/gh`                                                                                           | ro   | git push / PR parity — interactive-level ambient trust, same as host runs today; automations use the separate MicroVM-only trust profile |
| `mcp-config.json`, `~/.opensession/claude-accounts.json`                                                                           | ro   | external MCP servers + in-container account-pool selection                                                                               |
| `~/.opensession/codex-accounts.json`, each home account's `<CODEX_HOME>/auth.json`                                                 | ro   | seed access-token-only Pi/OpenAI authentication                                                                                          |
| `~/.opensession/model-providers.json` → `~/.opensession-model-providers.json`; `~/.opensession/pi.json` → `~/.opensession-pi.json` | ro   | model-provider and Pi configuration, readable in the sandbox                                                                             |
| `~/.opensession/audit`                                                                                                             | rw   | one audit jsonl stream for host + sandboxed runs                                                                                         |

Known Phase 1 caveats: external MCP servers spawn inside the container, so
host-only dependencies will not work. Full writable Codex account homes are not
mounted and native Codex remains host-only; sandbox code can read the mounted
registry and per-account authentication files used to seed access-token-only
Pi/OpenAI authentication. Sandboxes cannot reach IMDS directly. Runs use
workload identity. Preview lifecycle commands use workload identity when
allowed, but retain a migration fallback that can inject short-lived
instance-role credentials minted on the host and write a sandbox-local AWS
profile.

## Phase 2 — exec-routed surfaces, volume workspaces, preview ports

- **workspace-exec choke point** (`packages/core/opensession-server/src/server/sandbox/workspace-exec.ts`):
  @-mention file search, the Changes diff/discard, and git status/pull/push
  take an optional exec from `workspaceExecFor(session, dir)` — host Bun `$`
  unless the session's sandbox is ACTIVE (materialized + config docker +
  kill-switch absent + container **running**; a stopped container is never
  started for a read). With bind mounts this is redundant by design — it's
  the seam volume workspaces and Phase 3 remote providers run through.
- **Volume workspaces** (`~/.opensession/sandbox.json` → `"workspace":
"volume"`, default `"bind"`): new sandboxes whose canonical worktree path
  has no host dir get a per-session `<name>-ws` volume mounted at that path
  and cloned **inside** the container from the repo's origin (ro-mounted
  creds do the auth; a local-path origin is mounted ro — that's the verify
  suite's scratch case). No host worktree is created at all; the mode is
  sticky per sandbox (state file), and the session records
  `sandbox.workspace: "volume"`. **Contract: `destroy()` (session delete,
  archive sweep) deletes the workspace volume — un-pushed work is gone.
  Push your work.** While the container is idle-stopped, the read surfaces
  go quiet (empty diff/status) rather than waking it. Attached repos and
  sibling chats are rejected for volume-mode sessions.
- **Attached repos (bind mode)**: `attachedRepos[].dir` + each repo's common
  `.git` are now bind-mounted rw at identical paths; changing the attach set
  recreates the container on the next ensure (mounts are create-time).
- **Preview ports** (`"previewPorts": [3300, …]`, default `[3300, 3301,
3302]`): each container port in the set is published to a random
  **loopback** host port at container create; `sandbox.ports()` reads the
  live map and preview.ts routes the same Caddy tailnet-HTTPS front at the
  published port. Selecting a sandbox is the explicit opt-in for in-sandbox
  Preview. See "Previews in sandboxes" below for the full flow (port
  namespace, lifecycle scripts, `.tunnels.env`).

## Previews in sandboxes (Phase 4A)

The session Preview button works for sandboxed sessions: `startSandboxPreview`
(preview.ts) brings the dev server up INSIDE the container and fronts it with
the same Caddy tailnet-HTTPS origin as host previews.

**HTTPS-port namespace (the old collision TODO, fixed).** Host previews key
their Caddy route as `webappPort + 6000` (9100-9999) — safe on the host
because a host-side port allocator can enforce webapp-port uniqueness with
lsof, but blind to container netns: a sandbox and a host session (or two
sandboxes) can hold the same webapp port number. Sandbox routes therefore use
a dedicated allocated range **[20000, 28000)**, keyed by
`(sandboxId, containerPort)` and persisted in
`~/.opensession/sessions/sandbox-preview-ports.json`
(packages/core/opensession-server/src/server/sandbox/preview-ports.ts): host-vs-sandbox collisions are
impossible by range disjointness, sandbox-vs-sandbox by the allocator's
uniqueness probe. Allocations survive restarts/recreations (stable preview
URL) and are released by `destroy()`.

**Pre-published port range.** Docker port publishing is create-time-only, so
every sandbox container publishes the `previewPorts` set (default 3 ports,
3300-3302) at create. `startSandboxPreview` picks the worktree's existing
`.ports.conf` WEBAPP_PORT when it's one of them, else the first published
port nothing listens on, and seeds/rewrites `.ports.conf` so the dev flow
adopts it (a repo dev script that sources an existing `.ports.conf` and keeps
free ports will keep ours — inside the fresh netns they always are). **Range
exhaustion** (every published port busy) refuses to start. Widen
`previewPorts` in `~/.opensession/sandbox.json`, then use the Sandbox panel's
destructive Recreate action or otherwise destroy and re-ensure the sandbox. A
stop/start cycle preserves the old mappings. Changing the attachment set also
forces recreation.

**Bring-up resolution (repo-local lifecycle scripts, background-agents
convention).** ONE chain — `resolvePreviewBoot` in preview.ts — shared by
sandboxed AND host previews (the Preview button on a plain non-sandboxed
session resolves identically; only the existence checks and process plumbing
differ):

1. `<worktree>/.agents/start.sh` when present — a script committed IN
   the target repo (docs/repo-lifecycle.md; the `.agents/setup` sibling is
   taken from the same dir). Run detached with `WEBAPP_PORT` (the allocated port —
   pre-published container port in sandboxes, a free host port for host
   previews, seeded into `.ports.conf` either way), `PREVIEW_URL`, and
   `OPENSESSION_BOOT_MODE` (`fresh` | `snapshot-restore`; host previews always
   say `fresh`) in its env. It should bring the dev server up on
   `$WEBAPP_PORT` (exec your server so stop's process-group kill reaches it).
2. else the repo's configured `previewCommand` (an instance-config `repos`
   entry — e.g. a repo-specific ensure-up script kept outside the repo),
   invoked with the worktree path as `$1`. A configured absolute path that
   doesn't exist in the current environment (e.g. a host path the sandbox
   image doesn't carry) is skipped instead of failing.

No rung resolves → the status reports `bootable: false` and the UI renders a
disabled Start explaining what to add. A matching operator workload-identity
grant injects only an exchange lease into the lifecycle command. The repository
can mint an OIDC token with `opensession sandbox id-token` and let a standard
cloud SDK exchange it. If no grant matches, preview lifecycle commands retain a
migration fallback that injects short-lived host-minted instance-role
credentials and writes a profile under `/tmp/opensession-preview-aws/` in the
sandbox. The sandbox cannot reach IMDS directly.

`<worktree>/.agents/setup` behavior depends on the provider:

- Docker runs it with Bash once per workspace materialization, skips it on a
  snapshot restore, and settles it even after failure. Failures do not block the
  session. The log is
  `~/.opensession/sessions/sandbox-runs/<session>/workspace-setup.log`.
- Host previews run and settle it, success or failure, on the first repo-script
  preview start. The stamp is under `<sessions-dir>/preview-setup/`.
- Remote providers and MicroVMs require the hook to be executable. Failure
  blocks materialization and leaves it unstamped, so a later ensure retries it.
  Logs are under `/home/ubuntu/.opensession/lifecycle/` in the sandbox.

Keep lifecycle scripts convention-level: no framework and no arguments beyond
the environment.

**`.tunnels.env` contract** (adopted from background-agents): when a preview
starts, Open Session writes `<worktree>/.tunnels.env` — dotenv, consumable by
in-container dev processes:

```
PREVIEW_URL=https://<host>:<httpsPort>     # the primary (webapp) URL
PREVIEW_URL_<containerPort>=https://…      # one var per exposed port
```

Stale files are removed whenever ensure() (re)starts the container and on
preview stop; each start rewrites the file whole. It's kept out of session
diffs via the repo's `.git/info/exclude`.

**External `previewCommand` scripts in-container.** Docker sandboxes mount the
directory of a configured absolute preview command read-only at the identical
path (`externalPreviewCommandDirs` in preview.ts). Remote providers and
MicroVMs cannot mount host paths; use a repo-committed `.agents/start.sh` or
install the configured command inside that environment. The Docker image bakes
the common dev-chain deps such scripts tend to need —
bash/coreutils/curl/python3/git, plus `just`,
`direnv` (`direnv exec . just dev` chains) and `lsof` (port probes).
Deliberately NOT installed: the **aws CLI** and heavyweight backing services
(Postgres/Redis-class daemons are out of image scope — the dev server points
at whatever its bind-mounted env files point at, seeded host-side). A
repository needing cloud access should use its SDK's standard web-identity
provider, after an operator has granted the lifecycle a narrow audience. This
keeps provider tooling out of the image and keeps a snapshot credential-free.

**Post-prompt snapshots.** When `snapshots.enabled`, a successfully completed
sandboxed run schedules a `docker commit` snapshot (same helper as the
idle-stop path; deduped, delayed past the run-teardown busy window) — the
background-agents "snapshot after every turn" warm-restore behavior.

## Terminals in sandboxes (Shell tab)

The session viewer's **Shell tab** (xterm.js ↔ server-side PTY over the
tailnet-gated session WS — `packages/core/opensession-server/src/server/terminals.ts`) is sandbox-aware:
`startSessionTerminal` lands the PTY where the session's work actually
happens.

- **Docker**: `docker exec -it -w <workspace> <container> bash -il` under the
  host PTY. Works for bind AND volume workspaces (volume ones have no host
  copy at all). Opening a terminal is an interactive gesture, so unlike the
  read surfaces it **wakes a stopped container** (`docker start` first) and
  resets the idle-stop clock; an idle-stop while a shell is open simply ends
  it (`term_exit` in the tab) — reopen to wake again. Works on every existing
  container: no image change, no published port, no Caddy route.
- **Daytona**: the SDK's native PTY socket, with working prompt, echo and
  resize. It terminates at Open Session; no preview port or browser credential
  is created.
- **Box**: Box's authenticated API installs a dedicated Open Session public
  key on the selected Box, then the host opens a normal SSH PTY. The private
  key remains on the Open Session host. Opening the tab wakes an archived Box.
- **MicroVM**: a native PTY over the guest's private control lane. Opening it
  wakes the preserved guest when needed.
- **Unsupported providers / any failure**: a host login shell with a dim
  fallback notice. It starts in the host worktree when that directory exists,
  otherwise in the host home directory.

Deliberately NOT ttyd-in-the-sandbox: these providers already have an
interactive exec transport that plugs into the existing PTY plumbing, so the
browser only ever speaks the existing tailnet- + team-gated session WS — no
extra HTTPS listener, no basic-auth credential to store, no public-ish
preview-domain URL, no preview-port slot consumed, and no image rebuild /
container recreation to roll it out. The UI signals where a shell landed via
`term_ready` (dim `[shell inside docker sandbox — <cwd>]` banner).

Terminal code is reached through the server's WebSocket handlers
(`packages/core/opensession-server/src/server/ws-handlers.ts`), which do NOT hot-apply — a real restart is
needed after changing it.

## Phase 3 — WS transport + remote adapters

- **WS transport** (`~/.opensession/sandbox.json` → `"transport": "ws"` +
  `"callbackBaseUrl": "ws://<reachable-host>:3850"`): the in-sandbox run host
  DIALS OUT to the server's `/run-ws/<hostId>` route (token-authed,
  same NDJSON protocol, one JSON message per WS text frame) instead of
  serving a unix socket, and the opensession-* MCP proxies dial
  `/rpc-ws`. Docker containers created in ws mode don't mount the
  rpc socket. `callbackBaseUrl` must be reachable FROM the sandbox (Tailscale
  URL for self-hosters; 127.0.0.1 never works). The isolated public listener
  starts at boot on `127.0.0.1:3860`. Configure its public origin in Settings →
  Public ingress (`ingress.publicBaseUrl`); the legacy sandbox `publicIngress`
  block only overrides the internal bind. The listener exposes registered
  webhook/OAuth routes, `/run-ws/*`, `/rpc-ws`, `/sandbox-portal-ws`,
  `/ingress-health`, and `/workload-identity/*` without exposing the main app.
  Transport code is runner internals, so restart and rebuild the image after
  changing it.
- **Remote adapters** (`provider: "daytona"` / `"e2b"` / `"box"` / `"modal"` /
  `"lambda-microvm"`, packages/core/opensession-server/src/server/sandbox/adapters/):
  always use volume-style workspaces cloned
  in-sandbox over https (`cloneCredential`) and always use WS transport. Every
  adapter installs the full runner payload with `bootstrapRemoteSandbox`. The
  selected Claude or Pi engine runs inside the sandbox with narrowly projected
  per-launch credentials. Native Codex remains host-only because its writable,
  rotating `CODEX_HOME` is not projected. Daytona idle-stops natively
  (`autoStopInterval`); E2B lives on a countdown that
  activity extends — expiry KILLS the sandbox and its workspace. NOTE:
  Daytona Tier 1/2 orgs restrict sandbox egress, which blocks the WS
  dial-back entirely — launchRun there needs a Tier 3 org or self-hosted
  Daytona.
- `deploy/sandbox/conformance.ts` — the provider conformance matrix
  (`bun run deploy/sandbox/conformance.ts [docker-socket|docker-ws|daytona|e2b|box|modal|lambda-microvm]`):
  verify.ts's checks parameterized over providers. Docker entries always run
  and must stay green; configured providers otherwise skip when their required
  credentials are not discovered. The harness currently reads live sandbox
  configuration and workspace secrets only from the legacy top-level
  `~/.opensession-sandbox.json` and `~/.opensession-workspace-secrets.json`,
  plus its environment/profile fallbacks. Fresh consolidated-state connections
  under `~/.opensession/` can therefore be reported as skipped. Providers with
  hard deletion leave zero sandboxes behind; Box leaves only archived,
  non-billing conformance entries because its public API exposes archive rather
  than hard deletion.

## Host setup + verification

- `deploy/sandbox/setup-host.sh` — idempotently installs the DOCKER-USER
  iptables rule dropping container traffic to 169.254.169.254 (IMDS), the
  container mirror of the systemd `IPAddressDeny`. Not persisted across host
  reboots — re-run it after one.
- `deploy/sandbox/verify.ts` — manual end-to-end suite
  (`bun run deploy/sandbox/verify.ts`): ensure/reuse, in-container git
  commit through the mounts, claude CLI, RPC socket, IMDS block, a minimal
  real agent run via launchRun, stop/start/get/destroy, volume workspaces,
  WS transport, snapshots, and the sandboxed preview/lifecycle flow. Uses
  only `sbxtest-*` scratch resources and a redirected run journal; safe next
  to the live server.

## When to rebuild

- **Claude CLI bump** on the host (`claude --version` changes) → bump
  `CLAUDE_VERSION`. The in-container CLI must match host session-resume behavior
  (the build asserts the installed version and fails on drift).
- **Dependency input changes** (`package.json`, package manifests, `bun.lock`,
  or `patches/`) → rebuild so the dependency layer is current.
- **Bun bump** on the host → bump `BUN_VERSION` to keep parity.
- **Runner-runtime source changes** under `packages/core/opensession-server` or
  `packages/core/protocol`, especially
  `packages/core/opensession-server/src/runner-host/` → rebuild before the
  next sandboxed run. Rebuild after changes to the copied
  `scripts/workload-identity-client.ts` too. The container executes the image's
  copy, not the host checkout.

Keep the image's pins in lockstep with the host; parity is the whole point.
