# Self-hosting sandboxes

How to run Open Session sessions inside isolated sandboxes on your own
infrastructure. Companion to
[`deploy/sandbox/README.md`](../deploy/sandbox/README.md) (runner image and
provider internals). This page is the operator's view: what to install, the
provider guides, and the safety switches.

**Default = This machine.** The shipped web new-session flow explicitly chooses
the host unless the user selects a Ready Sandbox. Personal and workspace
defaults still apply to API and client creates that omit a sandbox choice. A
per-session explicit choice wins.

Claude and Pi-family models can run inside a Sandbox. Native Codex cannot: its
writable, rotating `CODEX_HOME` remains host-only. Choose a `pi/openai/*` model
for GPT in a Sandbox.

## Setup

Workspace administrators configure providers in **Workspace → Sandboxes**.
Daytona, Box and Modal accept workspace-owned provider credentials there; they
are submitted write-only to the server-side workspace secret store and are
never returned to the browser or placed in a Sandbox.

The local Docker provider uses this host command:

```sh
opensession sandbox enable docker
```

They check prerequisites, install and verify available release artifacts,
install a persistent metadata-service firewall, run a disposable
qualification, and record Ready in the shared connection store. They do not
install Docker, Firecracker, KVM, `cosign`, or passwordless `sudo` access.
Re-running them is safe. `opensession sandbox test <provider>` requalifies a
connection; for Daytona, Box and Modal the server must be running and the app
must have an existing local web session. The Workspace → Sandboxes Test action
uses the same server-side qualification. `opensession sandbox disable
<provider>` stops future use without deleting live Sandboxes.

Docker needs a working daemon, `cosign` for a published release image, and
non-interactive `sudo` for the firewall unit. On a source checkout, build the
runtime tag before enabling it:

```sh
deploy/sandbox/build.sh
opensession sandbox enable docker
```

This also ensures the image contains the current checkout. The enable command's
verified release pull keeps its GHCR tag, while Docker qualification and runs
currently look for `opensession-runner:latest` unless the root-level `image`
runtime setting says otherwise.

`opensession sandbox enable docker` currently requests volume workspaces, WS
transport, and Docker snapshots enabled. Ask sessions and sessions with an
existing host worktree still bind-mount that worktree. These choices differ
from the low-level schema defaults documented below.

Remote providers use the workspace's canonical Public ingress origin. Configure
it once under **Settings → Domains and ingress → Public callbacks** with
Cloudflare Tunnel or Direct HTTPS with Caddy. The same fail-closed listener receives
signed integration webhooks, Sandbox callbacks, and workload identity; the
private app is never part of that public listener.

This machine remains a first-class personal and per-session choice. If a
chosen provider later becomes unavailable, creation or the next turn fails
clearly; Open Session never changes the execution boundary to the host or
another provider.

### Building the image

`deploy/sandbox/build.sh` builds `deploy/sandbox/Dockerfile` from the repo
root and tags `opensession-runner:latest` plus the current short git SHA.
`IMAGE=name deploy/sandbox/build.sh` changes the image name. The script does not
forward command-line build arguments; to override a Dockerfile `ARG`, invoke
`docker build` directly:

```sh
docker build -f deploy/sandbox/Dockerfile \
  --build-arg BUN_VERSION=1.4.0 \
  --build-arg CLAUDE_VERSION=2.1.218 \
  --build-arg NODE_MAJOR=24 \
  -t opensession-runner:latest .
```

| ARG              | Default | Keep in lockstep with   |
| ---------------- | ------- | ----------------------- |
| `BUN_VERSION`    | 1.4.0   | host `bun --version`    |
| `CLAUDE_VERSION` | 2.1.218 | host `claude --version` |
| `NODE_MAJOR`     | 24      | host Node major         |

There is no `PI_VERSION` build argument; Pi is installed from `bun.lock`.
Rebuild after a tool pin or lockfile change and after any runtime source copied
by the Dockerfile changes, especially the protocol package, server runner code,
or `scripts/workload-identity-client.ts`. Sandboxed runs execute the image's
copy, not the checkout's copy.

### Path parity is load-bearing for Docker bind mode

The source runner passes its absolute `runner-host/host.ts` path into the
container. Docker bind mode also mounts the worktree and common Git directory
at their host paths, and uid 1000 keeps ownership aligned. The image must
therefore reproduce the host's runner checkout path; bind mode additionally
needs matching workspace paths and uid. This preserves host-side
diff/status/push/preview behavior and cwd-keyed engine resume.

The shipped Dockerfile bakes `/home/ubuntu/projects/opensession`,
`/home/ubuntu/.local/bin/claude`, and user `ubuntu`. If the service checkout,
home, username, or uid differs, update every corresponding Dockerfile path and
user and rebuild `opensession-runner:latest`. Volume mode removes the host
worktree mount, but it does not remove the runner-entry path requirement.

## Images, warm pools and snapshots

Three separate mechanisms get confused with each other. They solve the same
problem — a cold sandbox is slow — at different layers.

### The runner image

The base image a sandbox starts from. `deploy/sandbox/build.sh` builds it and
tags `opensession-runner:latest` plus the git SHA (`IMAGE=` overrides the
name). It carries the toolchain a
session needs (bun, git, the engine) so no session pays to install them.

This is the piece you should rebuild deliberately: pinning
`"image": "opensession-runner:<sha>"` means a rebuild cannot change behaviour
underneath running sessions, and rolling back is retagging.

Path parity between the image and the host is load-bearing — see the section
above before "tidying" any of it.

### Warm pools (prewarm)

Remote providers can take minutes to prepare a large repository. The default
pool starts while you type and destroys an untouched sandbox after its TTL.
Workspace administrators can create a maintained per-project artifact under
Workspace → Sandboxes → Project snapshots. For a project that must also keep a
ready Sandbox outside active typing, use `keepReady`:

```json
"prewarm": {
  "enabled": true,
  "ttlMinutes": 10,
  "maxLive": 2,
  "keepReady": [
    { "provider": "box", "repoId": "tella-fusion" },
    { "provider": "daytona", "repoId": "tella-fusion" }
  ]
}
```

`maxLive` bounds preparing plus unparked Ready capacity. Set it at least as high
as the number of keep-ready targets; the parser does not enforce that
relationship, so excess targets remain at capacity. Open Session parks prepared
capacity when the provider retains its disk on stop, including Box and Daytona.
A claim resumes that disk, and its replacement prepares in the background
before parking again. Completed, signature-matching entries survive
coordinator restarts. Without `keepReady`, the pool remains demand-driven and
TTL-bound.

Prewarm defaults on when Daytona, Box or Modal is configured, unless
`prewarm.enabled` is false. E2B and Lambda MicroVM have no prewarm
adapter. Docker starts fast enough locally that it is not pooled.

### Snapshots

The `snapshots` runtime block is Docker-only. When enabled, Open Session commits
the container layer after a successful turn and, when `onIdle` is true, before
idle stop. A gone container can then be recreated from that image. Workspaces
and engine state remain on bind mounts or named volumes and are not copied into
the committed layer.

```json
"snapshots": { "enabled": true, "onIdle": true, "maxPerSession": 2 }
```

The schema default is off, although `opensession sandbox enable docker` writes
it on. `maxPerSession` bounds retained timestamped images per session.

Daytona has a separate base-snapshot setting. Its unsized default is 1 vCPU,
1 GB and 3 GiB, too small for a real repository. Configure a prepared project's
machine profile, connection CPU/memory, or a suitably sized base snapshot.
Custom resources cannot be combined with a base snapshot because sizing then
belongs to that snapshot.

### Current limits

Honest status, because these are the newest parts:

- **Snapshot restore is best-effort.** A restored workspace can hold stale git
  refs; the `quickSyncOnRestore` setting (a non-destructive `git fetch` +
  `git status` after a volume restore, default on) exists for exactly that. If
  a session starts confused about what branch it is on, suspect this first.
- **Prewarm restart recovery** restores completed, signature-matching entries.
  Interrupted bootstraps are destroyed because their completion promise cannot
  be resumed safely.
- **Docker, Daytona, Box and Modal** have live certifications.
  E2B and Lambda MicroVM are implemented but not certified. They are hidden
  from the workspace connection UI and rejected for new sessions until their
  live matrix passes and the code certification registry is updated.
- Clearly transient provider/network failures during idempotent sandbox
  creation are retried once. Agent launch is never retried because that could
  duplicate a turn.
- Daytona, Box and Modal prepared images remain safe because adoption fetches
  the requested branch; setup-input changes invalidate them separately.
  Explicitly prepared Daytona and Modal images refresh on a 30-minute cadence,
  while Box uses six hours to conserve its daily start quota.
- Prepared templates are keyed on the runner toolchain and the repo's
  committed setup inputs, not on the runner's commit pin: an ordinary deploy
  bumps the pin, and adoption reconciles it inside the restored filesystem
  (shallow fetch + detached checkout + incremental install), so templates
  survive deploys instead of rebuilding on every one. The default setup
  inputs are `.agents/setup`, `.agents/sandbox-environment.json` and
  `bun.lock`; a repo can declare extra committed files or directories in
  `.agents/sandbox-environment.json` under `preparationInputs` (for example
  `["patches", "Cargo.lock"]`) so its own invalidation surface travels with
  the repo.

If you are starting out, use Docker and leave prewarm alone. The enable command
turns Docker snapshots on; set `snapshots.enabled` to false if you prefer no
committed container images.

## Repo lifecycle hooks — `.agents/`

Sandboxes honor the repo-committed lifecycle contract
([docs/repo-lifecycle.md](repo-lifecycle.md)):

- `.agents/setup` — one-shot workspace preparation. Remote providers and Local
  MicroVM require it to be executable and fail preparation when it fails.
  Docker treats failure as settled and non-blocking. Reusable project images
  run it before sealing and skip it after restore.
- `.agents/resume` — executable, idempotent post-wake repair. It currently runs
  after an actual durable remote-provider wake; failure blocks the wake and
  is retained in the Sandbox panel.
- `.agents/start.sh` — foreground dev-server/legacy Preview entry honoring
  `WEBAPP_PORT`, `PREVIEW_URL` and `OPENSESSION_BOOT_MODE`.

For private remote workspaces, prefer workload identity and a repository-owned
secret source. `.agents/environment.json` is only a migration mechanism for
explicit, gitignored files from the registered checkout; its limits and
security checks are documented in the linked lifecycle page.

## Internal runtime config — `~/.opensession/sandbox.json`

Fresh installs use `~/.opensession/sandbox.json`. If only the legacy
`~/.opensession-sandbox.json` exists, Open Session continues using it until it
is migrated; it does not split the store.

Do not configure Docker, Daytona, Box or Modal connections by
editing this file. Normalized connections and opaque credential references are
server-owned. Raw Daytona/Modal credentials and their credential environment
variables are not supported by normal operation. E2B remains an experimental
exception. The schema below documents low-level runtime controls and
experimental conformance providers.

Values are read fresh per run. Missing or invalid JSON and unknown provider
values resolve to `provider: "local"`. `OPENSESSION_SANDBOX_CONFIG` overrides
the path for verification and tests. If this low-level file contains an E2B or
clone token, keep it mode `0600`.

```jsonc
{
  // Provider used by legacy/internal `sandbox: true` callers. Explicit
  // provider choices are recorded on each session.
  // "local" | "docker" | "daytona" | "e2b" | "box" | "modal" |
  // "lambda-microvm"
  "provider": "docker",

  // Shared default when a client omits its new-session sandbox choice.
  // "none" is the schema default. The shipped web UI explicitly sends its
  // current choice, initially This machine.
  "sessionDefault": "none",

  // ── Docker provider ────────────────────────────────────────────────
  // Container image (default "opensession-runner:latest").
  "image": "opensession-runner:latest",
  // Shared idle timeout/countdown. Docker, Daytona, E2B, Box and Modal default
  // to 30 minutes. Provider semantics differ:
  // stop, archive, expiry, termination or pause as documented in each guide.
  "idleStopMinutes": 30,
  // Docker per-container resource limits (docker --cpus / --memory).
  // Defaults: 4 cpus, "8g".
  "cpus": 4,
  "memory": "8g",

  // Workspace mode for NEW docker sandboxes (existing sandboxes keep the
  // mode they were created with — it's sticky in their state file). The
  // schema default is bind; `opensession sandbox enable docker` writes volume:
  //  "bind": the host worktree is bind-mounted at its identical
  //           path. Host-side diff/status/push/preview work unchanged.
  //  "volume": for code/scratch sessions with no existing host worktree, the
  //           repo is cloned into a per-session volume inside the container.
  //           Ask sessions and existing host worktrees still use bind mode.
  //           destroy() (session delete or the six-hourly sweep of archived
  //           sessions last active over 14 days ago) DELETES the volume — un-pushed work
  //           is gone. Push your work. Attached repos + sibling sessions are
  //           not supported in volume mode.
  "workspace": "bind",

  // Container ports published for previews (docker -p 127.0.0.1::<port> at
  // container create → random loopback host port; preview.ts routes the
  // same Caddy tailnet-HTTPS front at the published port).
  // Default [3300, 3301, 3302].
  "previewPorts": [3300],

  // Snapshot-based warm restores (Docker only; see docker.ts "Snapshots").
  // On idle-stop the container is `docker commit`ed; a later ensure() for a
  // GONE container starts from that snapshot — preserving container-layer
  // state (apt/global caches), NOT workspace or engine state (those live on
  // volumes/bind mounts). Absent block = disabled.
  "snapshots": {
    "enabled": false, // master switch (default false)
    "onIdle": true, // snapshot right before the idle-stop
    "maxPerSession": 2, // keep at most N snapshot images per session
    "quickSyncOnRestore": true, // git fetch + status after a volume restore
  },

  // Per-repo provider overrides for legacy/internal default resolution.
  // Image selection is currently global, not per-repo.
  "perRepo": {
    "my-app": { "provider": "docker" },
  },

  // ── Transport (how the in-sandbox run host talks to opensession) ─────
  //  "socket" (default): unix socket in a bind-mounted run dir. Docker only.
  //  "ws": the sandbox DIALS OUT to opensession's /run-ws +
  //        /rpc-ws routes (token-authed, seq/ack replay on
  //        reconnect). Required for remote providers (they force it
  //        regardless of this value); docker can dogfood it.
  "transport": "socket",
  // Base URL sandboxes dial back to for the ws transport. MUST be reachable
  // FROM the sandbox: your Tailscale ts.net URL or a tunnel for remote
  // providers; 127.0.0.1 never works. http(s):// is normalized to ws(s)://.
  // Default derives from the server's HOST:PORT bind.
  "callbackBaseUrl": "ws://<your-tailnet-ip>:3850",

  // ── Experimental conformance providers ─────────────────────────────
  "e2b": {
    "apiKey": "e2b_…", // falls back to E2B_API_KEY
    "template": "base", // sandbox template id (default "base")
  },
  "awsLambdaMicrovm": {
    "imageIdentifier": "arn:aws:lambda:us-east-1:123456789012:microvm-image:opensession",
    "imageVersion": "1", // optional; latest active version by default
    "executionRoleArn": "arn:aws:iam::123456789012:role/OpenSessionMicrovm",
    "region": "us-east-1", // falls back to AGENT_AWS_REGION/AWS_REGION
    "controlPort": 8080, // must match the image daemon
    "maximumDurationSeconds": 28800, // AWS hard max: eight hours
    // Optional: endpoint-idle suspension. Omit for long-running agents: their
    // outbound WebSocket does not count as endpoint activity.
    "idleSuspendSeconds": 3600,
    "suspendedDurationSeconds": 3600, // only used with idleSuspendSeconds
    "logGroup": "/aws/lambda/microvms/opensession",
    "ingressConnectorArn": "…", // optional VPC connectors
    "egressConnectorArn": "…",
  },
  // How remote sandboxes authenticate `git clone` (they can't mount host
  // creds). "none" = public clone; "https-token" injects the token into the
  // https URL (GitHub App token / x-access-token).
  "cloneCredential": { "type": "https-token", "token": "ghp_…" },

  // Demand-driven by default. Add explicit keepReady targets when a project
  // must open in seconds. maxLive includes both preparing and ready entries.
  "prewarm": {
    "enabled": true,
    "ttlMinutes": 10,
    "maxLive": 2,
    "keepReady": [
      { "provider": "box", "repoId": "tella-fusion" },
      { "provider": "daytona", "repoId": "tella-fusion" },
    ],
  },

  // Remote runner bootstrap. All sandboxable model families run the full
  // runner inside the Sandbox; native Codex is rejected before creation:
  "runnerBundleUrl": null, // tarball of the runner bundle (preferred)
  "runnerRepoUrl": null, // git URL fallback (default: this checkout's origin, or
  // https://github.com/tellahq/opensession.git for a release install)
  "runnerSha": null, // pinned ref (default: origin default branch, or the
  // installed release's tag for a release install)
}
```

### Real-work scorecard

`GET /api/sandbox/scorecard?days=30` reports turn/preview/wake/restart evidence
from the structured audit log. The automatic gate requires 20 turns per
environment, five distinct sandbox-use days, five preview starts per
environment, five wake samples, three perfect restart-survival samples, median
first-token time no slower than worktrees, and no turn-failure regression over
two percentage points. It never changes configuration: a human still approves
any future default flip.

## Public ingress (remote providers)

Remote sandboxes must dial back from the public internet. They use the same
canonical public origin as signed integration webhooks and workload identity.
`packages/core/opensession-server/src/server/public-ingress.ts` binds the one
fail-closed gateway on `127.0.0.1:3860`.

| Path                           | What                                    |
| ------------------------------ | --------------------------------------- |
| registered webhook/OAuth paths | signature-checked integration intake    |
| `/run-ws/<hostId>`             | authenticated run-host event stream     |
| `/rpc-ws?host=…`               | authenticated MCP proxy channel         |
| `/sandbox-portal-ws`           | authenticated remote Portal relay       |
| `/ingress-health`              | bare `200 ok`                           |
| `/workload-identity/*`         | OIDC discovery, JWKS and token exchange |

Every other method/path is a bodyless 404. The listener never exposes app
routes, the general API, or the frontend. Sandbox upgrades use per-launch
tokens and internet-facing upgrade/token attempts are rate-limited per client
IP.

**Settings → Domains and ingress → Public callbacks** offers two exposure
methods:

1. **Cloudflare Tunnel** stores a named tunnel's connector token write-only,
   runs `cloudflared`, and uses a CNAME to `<tunnel-id>.cfargotunnel.com`;
   its only service must be `http://127.0.0.1:3860`.
2. **Direct HTTPS with Caddy** points A/AAAA records at the host and lets Open
   Session manage a Caddy site that reverse-proxies the whole origin to 3860. The
   application, not Caddy, remains the exact route allowlist.

The workload-identity issuer is the canonical public origin plus
`/workload-identity`. An external relying party must be able to fetch discovery
and JWKS from that exact issuer. Changing the origin therefore also requires
updating external trust policies.

Hosted-Daytona reminder: the sandbox side needs Tier 3 / self-hosted egress;
lower tiers block outbound traffic, so no ingress URL is reachable from inside.

## Known gaps (remote providers)

- **Audit trail**: in-sandbox runs write turn-level audit lines to their own
  `~/.opensession/audit`. Docker bind-mounts that directory into the host audit
  stream. Daytona, E2B, Box, Modal and Lambda MicroVM do not
  mirror it to the host, so inspect the Sandbox while it exists if those lines
  are required. Provider lifecycle, journal and run-ws events still originate
  on the host. Pi transcripts are mirrored host-side from the dial-back stream.

## Kill switch

```sh
touch ~/.opensession/sessions/disable-sandboxes
```

Checked per run with no restart. While the file exists, creation cannot select
a Sandbox and every existing sandboxed session refuses its next turn with an
operator kill-switch error. Nothing falls back to the host, including bind-mode
Docker. Remove the file to re-enable. On an installation that still uses the
legacy sessions store, place the file in that active store instead; the path
resolver deliberately does not split old and new stores.

## What needs a restart

The config file's _values_ are read fresh per run. Code changes to the sandbox
path are **runner internals** and need a service restart:

- Connection enable/disable/test and runtime config values need no restart.
  Provider/transport code changes, runner-host changes, run-ws/rpc-ws changes,
  and server boot wiring need a real `systemctl restart opensession`.
- The public ingress gateway starts once at boot on loopback port 3860 even
  before a public origin is configured.
  Changing code or its internal bind requires a restart; changing the canonical
  public URL applies to new remote launches immediately.
- A transport flip applies on the next ensure and recreates an existing Docker
  container whose recorded transport differs. The transport code itself must
  already be live; restart after changing that code, not after changing the
  value.
- Docker runtime changes need an image rebuild as well as any server restart.
  Existing containers keep their image until the container is gone and
  re-ensured.
- Config value changes need no restart. Docker idle sweeps
  read `idleStopMinutes` fresh; provider-native idle policies update on their
  own create/touch paths. Docker mounts, preview ports, CPU and memory are
  create-time settings, so an existing container keeps them until recreated.

## Provider guides

### Docker (certified)

Covered above. Per-session container, engine state (`~/.claude`, `~/.codex`)
on named volumes so session resume survives stop/start/restart; runs are
`docker exec`s of the same runner-host entry the systemd path uses, so
steer/cancel/reattach-after-restart all work. Verify end-to-end with
`bun run deploy/sandbox/verify.ts` (safe next to a live server — everything
is `sbxtest-*` scratch), and keep the conformance matrix green:

```sh
bun run deploy/sandbox/conformance.ts docker-socket docker-ws
```

`conformance.ts` is a developer certification harness, not the connection
qualification path. Its Docker entries use scratch state and are current. Its
remote credential loader still reads legacy top-level sandbox and secret files,
so on a fresh `~/.opensession/` installation a remote entry may skip despite a
Ready workspace connection. Use `opensession sandbox test <provider>` or the
Workspace → Sandboxes Test action for operator qualification; do not interpret
a skipped conformance entry as a pass.

### Daytona (implemented, live-certified 2026-08-11)

Self-hostable sandbox platform (Helm/K8s) with a hosted cloud. The adapter
(`packages/core/opensession-server/src/server/sandbox/adapters/daytona.ts`) creates sandboxes over the
Daytona API/SDK: volume-style workspace cloned in-sandbox over https
(`cloneCredential`), ws transport always, runner bootstrapped on first
ensure. A prewarm clones the repo, runs `.agents/setup`, scrubs clone and
model authority, and can publish a Daytona snapshot. Explicitly prepared
project records refresh every 30 minutes without discarding the old mapping
until the replacement is ready. Later sessions restore that artifact, fetch
the requested branch delta, and skip setup. Preparation inputs such as
`bun.lock` and `.agents/setup` invalidate the image separately. Idle-stop is
native (`autoStopInterval`).

- Connect in Workspace → Sandboxes with a Daytona API key and a Ready Public
  ingress origin. Settings owns region/resource/base-snapshot overrides;
  private-repo clone authority remains a separately scoped runtime concern.
  Without a sized project profile, connection CPU/memory, or base snapshot,
  Daytona's 1 vCPU / 1 GB / 3 GiB default is generally too small.
- **Org-tier egress caveat (hosted Daytona):** Tier 1/2 orgs restrict
  sandbox egress, which blocks the WS dial-back entirely — `launchRun`
  needs a **Tier 3 org or self-hosted Daytona**. Workspace clone/exec work
  on lower tiers; runs don't.
- Requalify your connection with `opensession sandbox test daytona`. The
  developer conformance harness caveat above applies to
  `bun run deploy/sandbox/conformance.ts daytona`. The historical full matrix,
  including
  the launchRun round-trip + steer/cancel + mid-run WS drop/redial — went
  41/41 green 2026-08-11 against hosted Daytona (Tier 3), including an exact
  sealed-filesystem restore into a second sandbox, setup non-reexecution,
  real agent execution, and WS reconnect/steer/cancel, dialing back over
  the public ingress (`SBX_CONF_LISTEN_PORT=3860
SBX_CONF_PUBLIC_BASE=wss://your.domain`).

### E2B (implemented, NOT yet certified)

Firecracker microVM sandboxes; hosted cloud plus an OSS self-host stack
(Terraform/Nomad, GCP full / AWS beta — heavyweight; we document it, we
don't operate it). The adapter (`packages/core/opensession-server/src/server/sandbox/adapters/e2b.ts`) is
written to the same contract as Daytona (volume-style workspace, ws
transport, bootstrap on first ensure) but has **not been run against a live
E2B account** — treat it as untested until the conformance suite passes.

- Config: `provider: "e2b"` + the `e2b` block (or `E2B_API_KEY`).
- Lifetime model differs: an E2B sandbox lives on a countdown that activity
  extends — **expiry KILLS the sandbox and its workspace** (vs. Daytona's
  stop/start). Push early.
- To certify, run `E2B_API_KEY=… bun run deploy/sandbox/conformance.ts e2b`,
  fix what fails, and update the code certification registry. Until then, the
  adapter is available only to the conformance harness; it is hidden from the
  picker and rejected by session creation and prewarm.

### Box / ascii.dev (live-certified 2026-08-13)

Persistent Ubuntu VMs from box.ascii.dev, integrated through its public HTTP
API without an SDK dependency. Connect an API key in **Workspace →
Sandboxes**. It is stored as an opaque workspace secret; new Boxes use
`noEnv: true`, so account-level Box/Git/agent credentials are never inherited.

- Projects opt in independently. Preparation runs the repository setup inside
  a Box, scrubs launch credentials, and publishes a named snapshot. Subsequent
  prewarms and sessions restore that exact prepared filesystem and are sized
  with Box's fixed **Small** (2 vCPU / 4 GB / at least 40 GB), **Default** (4 /
  8 GB / at least 80 GB), or **Large** (8 / 16 GB / at least 100 GB) profile.
- Warm-on-typing creates a Box while the user composes and the new session
  adopts it. Cold creation falls back cleanly when a named snapshot has gone
  stale. Explicitly prepared project images refresh every six hours to conserve
  Box's daily start quota. A session fetches only its requested branch and
  resets the lazy checkout to that small delta, rather than fetching every ref
  and hydrating the full filesystem. Feature-branch sessions therefore never
  begin on snapshot main.
- The command API's synchronous limit is 600 seconds. Longer work and
  background commands use Box's native detached-process endpoint and poll its
  separate stdout/stderr and exit status.
- A TTL archives idle Boxes. Archive releases compute, resume preserves the
  workspace, and opening a Shell tab wakes the Box. The Shell uses Box's
  authenticated SSH-key endpoint and a dedicated host-only Open Session key.
- Private previews use `host <port> --private`. Their `_token` remains only in
  the provider URL stored server-side; Open Session's Caddy Portal authenticates
  the user and appends that token while proxying, so browsers receive only the
  normal session Portal URL.
- Box's current public API intentionally offers archive rather than hard
  deletion. Removing a session archives its Box and forgets the Open Session
  association; the no-compute archived entry remains visible in the user's Box
  account. Prepared named snapshots can be deleted and rebuilt normally.
- Workspace qualification checks credentials and quota, outbound dial-back,
  command semantics, `/home/ubuntu` file writes, private previews,
  archive/resume persistence, and a distinct named-snapshot restore. Run it
  again with `opensession sandbox test box`. The developer conformance harness
  caveat above applies to its `box` entry. The historical live matrix
  passed on 2026-08-13, including a real agent run, reconnect, steer/cancel,
  archive/resume, and an independent named-snapshot restore. Box serializes
  concurrent command admission per VM, so a launch behind a long command is
  bounded at 45 seconds rather than the 10-second parallel-lane target used by
  Daytona and Modal.

### Modal (implemented, live-certified 2026-08-11)

Modal sandboxes are ephemeral containers created through the official
Apache-2.0 TypeScript SDK. The adapter (`packages/core/opensession-server/src/server/sandbox/adapters/modal.ts`)
uses the same volume-style workspace, remote bootstrap, and WebSocket dial-back
contract as the other remote providers.

- Connect in Workspace → Sandboxes with a Modal token ID and secret. The
  connection owns app/environment, registry image, region, cloud, CPU and
  memory settings; CPU and memory are hard limits as well as reservations.
- Modal encrypted tunnel URLs are public Internet endpoints. Legacy Preview
  tunnels stay disabled unless the normalized connection's `publicPreviews`
  setting is true; the current Settings form does not expose that switch, and a
  raw `modal.publicPreviews` block is ignored. Supervised Portals use the
  outbound relay instead.
- Modal caps a sandbox's lifetime at 24 hours and deletes a terminated
  container's filesystem. After each clean turn Open Session therefore writes
  one session-private filesystem Image. A gone or near-lifetime follow-up
  restores that exact workspace, including uncommitted work, before syncing
  credentials and starting the runner. Rotation begins one hour before the hard
  lifetime. Each successful checkpoint replaces the previous one; session
  deletion removes it.
- The prewarm adapter publishes credential-free Modal filesystem Images after
  `.agents/setup` and credential scrubbing. Explicitly prepared project records
  refresh every 30 minutes, while input signatures rebuild immediately when
  setup or lockfiles change.
  A restored prewarm preserves the exact seal and setup output, then is adopted
  by the session. Shell-tab remote PTY remains provider-dependent work.
- The 41/41 live conformance pass covered provisioning, bootstrap, git/exec,
  idempotent reuse, encrypted preview tunnels, a distinct filesystem-image
  restore, real agent execution, WS reconnect/steer/cancel, and cleanup.
  Modal's SDK file-upload helper uses
  `ReadableStream.from`, which Bun lacks; the adapter's streamed-stdin fallback
  was separately verified against a disposable live sandbox with read-back.
- Requalify with `opensession sandbox test modal`. The developer conformance
  harness caveat above applies to its `modal` entry; remote dial-back requires
  a public ingress whose token registry belongs to that test process.

### AWS Lambda MicroVMs (experimental, NOT yet certified)

AWS Lambda MicroVMs are Firecracker VMs purpose-built for agent sandboxes. The
adapter (`packages/core/opensession-server/src/server/sandbox/adapters/lambda-microvm.ts`) uses the AWS SDK
control plane and authenticated HTTP requests to the structured command daemon
in `deploy/sandbox/lambda-microvm/`.

- Build the ARM64 image first using
  `deploy/sandbox/lambda-microvm/README.md`, then set
  `awsLambdaMicrovm.imageIdentifier`. Ambient AWS credentials must allow the
  MicroVM lifecycle/token APIs and `iam:PassRole` when an execution role is set.
- Runtime disk and background processes survive AWS suspend/resume, and the
  adapter wakes a suspended VM before command/restart recovery. Automatic idle
  suspension is disabled by default because an active run's outbound dial-back
  traffic does not count as endpoint activity to AWS; opt in with
  `idleSuspendSeconds` only when that tradeoff is acceptable.
- Every VM has a maximum eight-hour lifetime including suspended time; the
  configured duration can be shorter. The adapter rotates within the smaller
  of 30 minutes or 10% of that lifetime,
  only after proving the repo has an upstream, is clean, and has no commits
  ahead of it. Runtime disk and engine state are not durable
  across that rotation, so the next turn starts a fresh engine. EFS-backed
  rollover remains a follow-up for truly persistent sessions.
- The image runs on ARM64 and needs enough baseline memory/disk for the runner
  and target repo. The AWS image configuration, not this per-run adapter,
  controls those resources.
- `executionRoleArn` is optional. If used, it must be a dedicated least-
  privilege role: agent code has root-equivalent control inside the VM and can
  use every permission granted to that role.
- The legacy provider `ports()` surface intentionally returns no direct URL
  because AWS endpoints require expiring auth headers. Supervised Portals use
  Open Session's authenticated outbound Portal relay instead of exposing that
  endpoint to the browser.
- No prewarm adapter or Shell-tab integration yet.
- Certification still requires the live `lambda-microvm` conformance entry
  after the image and IAM resources exist. Its current credential loader has
  the legacy-path limitation noted above.
  Until then, the adapter is available only to the conformance harness; it is
  hidden from the picker and rejected by session creation.

## Licensing notes

- **Daytona** is AGPL-3.0. Open Session consumes it **over its API** (via the
  Apache-2.0 `@daytonaio/sdk`) and vendors none of its code, so AGPL
  obligations sit with whoever _operates_ the Daytona deployment, not with
  Open Session's codebase. Self-hosters running Daytona themselves take on
  AGPL's network-service obligations for their Daytona instance.
- **E2B**: the JS SDK is MIT; the self-host infra repo is Apache-2.0.
- **Modal**: the official `modal` TypeScript SDK is Apache-2.0.
- **AWS Lambda MicroVMs**: the AWS SDK client is Apache-2.0.
- **Docker provider**: plain `docker` CLI against your own daemon; nothing
  vendored.
- Core imports adapter SDKs only inside `packages/core/opensession-server/src/server/sandbox/adapters/` —
  a build without those files carries no third-party sandbox code.

## Security posture (what a sandbox does and doesn't isolate)

- Process/env/resource isolation per session; minimal env (no
  `~/.opensession.env` tokens); IMDS blocked (setup-host.sh / the systemd
  `IPAddressDeny` mirror).
- Docker interactive mounts carry **interactive-level ambient trust**: `~/.ssh`,
  `~/.gitconfig`, `~/.config/gh` are mounted read-only for push/PR parity.
  That's the same trust host runs have today. Automations never use this path;
  they require the credential-minimal MicroVM profile described above.
- Volume mode removes the host-worktree mount entirely (per-session disk,
  instant cleanup) at the cost of the destroy-deletes-work contract.

## MicroVM preview backend (Firecracker snapshots)

The separate preview pool can use `backend: "microvm"` to restore Firecracker
clones from a golden **memory snapshot**; claims serve in about 2–5 seconds
with no warm VM. Set the backend explicitly: an enabled repo record with no
`backend` currently resolves to Docker. MicroVM requires KVM (`/dev/kvm`): on
AWS that means a bare-metal instance or a supported nested-virtualization
family such as C8i/M8i/R8i. Assets live in `deploy/sandbox/microvm/`:

- `refresh-golden.sh` — docker-golden → `docker export` → ext4 rootfs
  (`build-rootfs.sh` injects `bks-init` as PID 1 plus the control.py agents)
  → boot under Firecracker → warm routes → pause → Full snapshot → kill.
  The canonical store paths and the tap name/guest IP are **load-bearing**:
  the vmstate embeds them. The base disk is frozen at pause time — never
  boot it read-write again.
- `clone.sh create|destroy <idx> [store-dir]` — per-claim: reflink COW disk
  when the store supports it, with sparse-copy fallback; a private netns
  recreating exactly `bkstap0`/172.16.100.2; snapshot load
  (~18ms), guest clock resync via the root agent (SigV4 tolerates <5min
  skew). VMs run in transient scopes (`os-fc-clone<idx>`) so they survive
  opensession restarts.
- `bks-host-setup.service` — boot oneshot re-arming the docker/guest IMDS
  drop rules. Enable it; nothing else needs manual re-arming after reboot.

Host prerequisites are `/opt/firecracker/firecracker`,
`/opt/firecracker/vmlinux`, `/dev/kvm`, non-interactive `sudo`, and a mounted
store, preferably on a reflink-capable filesystem. Firecracker runs
unprivileged in a per-clone chroot with the same capability/device/seccomp
hardening as session MicroVMs. The standard golden has 12 GiB of memory and is
pre-faulted, so allow roughly that much page cache for comfortable restores.
Unpushed branches ship to clones through the agent `/files` channel with a
30 MiB bundle cap.
