# Repo lifecycle scripts: `.agents/`

Commit a `.agents/` directory to a repository and every agent host that
follows this convention — Open Session, and anything else that adopts it —
knows how to provision a workspace for that repo and boot its dev server.
Six files, each optional:

| File               | When it runs                                                           | Job                                       |
| ------------------ | ---------------------------------------------------------------------- | ----------------------------------------- |
| `setup`            | once per workspace preparation, and as a first-host-preview safety net | install deps, fetch prebuilt assets       |
| `resume`           | reserved for providers that implement durable wake                     | idempotent post-wake repair               |
| `start.sh`         | when a preview starts                                                  | bring the dev server up in the foreground |
| `preview.json`     | warm preview-pool preparation                                          | declare which routes to pre-compile       |
| `portals.json`     | session Portals panel                                                  | declare supervised service starters       |
| `environment.json` | when a private remote workspace is adopted                             | legacy migration path for local env files |

Why commit them rather than configure the host: the boot recipe travels with
the code. Each session workspace can provision itself, and the Preview button
uses the same repo script on the host, in Sandboxes, and from the warm pool.
The real payoff is that an agent can bring your app up **headlessly** in its
own worktree and verify its changes in a real browser (screenshots, DOM
checks, CDP) without a human bootstrapping anything. See
[Letting the agent test the app itself](#letting-the-agent-test-the-app-itself).

For repo-script previews, `setup` is taken from the same directory as the
resolved `start.sh`; the pair ships together.

## setup — one-shot provisioning

Runs during workspace preparation and as a first-host-preview safety net,
`cwd` = repo root, no arguments. Everything arrives by environment:

- **Host worktree creation.** Every new session worktree runs the repo's
  `setup` hook when present; it replaces the instance-level `worktreeSetup`
  command. If setup succeeds, the same invocation then runs the configured
  `depsInstall`, or plain `bun install` when the repo has a root
  `package.json`. These steps share one best-effort operation: a failed setup
  does not block the session, but it skips that invocation's later dependency
  install. See [worktrees.md](worktrees.md).
- **Docker Sandbox workspace setup.** Runs once per workspace and is skipped
  after a post-setup snapshot restore. Failure is logged, treated as settled,
  and does not block the session. The retained log is available in the
  sandbox panel. See
  [deploy/sandbox/README.md](../deploy/sandbox/README.md).
- **Remote-clone Sandbox workspace setup.** A present
  hook must be executable. Failure blocks workspace preparation and leaves no
  success stamp, so a later preparation attempt can retry it. During remote
  setup, a PATH shim makes `bun install` use `--frozen-lockfile`; commit
  lockfile changes before preparing the workspace.
- **First host preview start**, as a safety net. It runs during the first
  repo-script preview boot and is stamped per worktree whether it succeeds or
  fails. Failure does not block the preview.

Because it can fire from more than one path, it must be **idempotent** and
cheap when there is nothing to do. Print a loud, actionable error before
exiting non-zero. For portability, commit both `setup` and `resume` with their
executable bits set.

Keep it scoped to what the dev server needs: dependency install, prebuilt
artifact fetch, codegen. Slow extras belong behind an existence check.

## resume — idempotent post-wake repair

Currently `.agents/resume` is reserved but not invoked by the selectable
Sandbox providers or host worktrees. When a provider adopts it, use it to
repair wall-clock- or environment-sensitive state such as stale pid files,
expired cached tokens, and clock-skewed build caches.

The hook runs with `cwd` = repo root, no arguments, and
`OPENSESSION_BOOT_MODE=resume`. It must be idempotent because it can run many
times over a workspace's life. Failure blocks the wake rather than continuing
with a half-repaired workspace.

## start.sh — boot the dev server

Runs when someone — or the agent itself — starts a preview: detached, `cwd` =
repo root, no arguments. Two rules make it work:

1. **Foreground.** `exec` the final dev process. Stop kills the script's
   process group; if you background the server, stopping the preview orphans
   it.
2. **Honor the environment contract:**

   | Variable                | Meaning                                                                                                                                                                                            |
   | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `WEBAPP_PORT`           | The port the app must listen on. For `.agents/start.sh`, the host allocates and seeds it into `.ports.conf`; in a Sandbox it is a published container port.                                        |
   | `PREVIEW_URL`           | When supplied, the public HTTPS origin fronting that port (e.g. `https://host.ts.net:9301`). Add its hostname to your framework's allowed dev origins so pages served through it actually hydrate. |
   | `OPENSESSION_BOOT_MODE` | `fresh` or `snapshot-restore`, informational. Host previews use `fresh`; restored Docker and preview-pool images can use `snapshot-restore`. The separate `resume` hook receives `resume`.         |

Beyond that it should be just a script: a developer with a normal setup can
run `./.agents/start.sh` by hand and get the usual dev server with sane
defaults. Assume no TTY and no human — never prompt. When a one-time human
step is missing (a gitignored `.env` that needs an interactive login to pull,
say), exit non-zero with the exact commands to run; that error message is
what both the session UI and the agent will act on.

**Resolution chain.** `.agents/start.sh` → the
instance-config `previewCommand` (invoked with the worktree path as `$1` —
for repos you can't commit to). One chain, shared by host and sandbox
previews (`resolvePreviewBoot` in packages/core/opensession-server/src/server/preview.ts); no rung resolves →
the Preview button is disabled with a hint about what to add.

**`.ports.conf`.** For `.agents/start.sh`, the host allocates and seeds
`WEBAPP_PORT` in `<worktree>/.ports.conf` and exports `WEBAPP_PORT` and
`PREVIEW_URL`. A configured `previewCommand` receives the worktree path and
must create or maintain its own `.ports.conf`. Extra `*_PORT` keys show up as
additional services on the session's preview card. Once services are
reachable, both host and Sandbox previews write `<worktree>/.tunnels.env`
with their authenticated URLs (see
[deploy/sandbox/README.md](../deploy/sandbox/README.md)).

For cloud access, a Sandbox preview with a matching
`OPENSESSION_WORKLOAD_IDENTITY_GRANTS` entry receives an exchange lease rather
than injected AWS credentials. Without a matching grant, the compatibility
path injects the configured short-lived AWS credentials. Host previews receive
the configured agent AWS environment when it is enabled. Migrate repositories
to workload identity before relying on the no-cloud-credentials property. The
lease is not persisted in the workspace or a reusable snapshot.

## Workload identity from a sandbox

Open Session sandboxes can mint a short-lived OpenID Connect ID token for a
service that trusts this instance. This is the portable alternative to putting
cloud credentials, CLI profiles, or provider-specific secrets in a sandbox:

```sh
opensession sandbox id-token --audience https://artifacts.example.com
```

The command is available only when the operator has granted that lifecycle an
audience. It prints only the JWT, so use command substitution or a credential
helper. `--ttl-seconds` defaults to 600 and accepts 60 through 3600. It does
not work in an ordinary host shell, and it never prompts.

For a long-running process, pass `--refresh-file /path/to/token`. The command
atomically replaces that mode-0600 file before its token expires, so a standard
web-identity SDK can read a fresh token when it refreshes its own credentials.
Run the refresher in the preview process group. It stops with the preview and
the exchange lease still expires when the sandbox does.

The token is signed by this instance and has standard `iss`, `aud`, `sub`,
`iat`, `exp`, and `jti` claims. Open Session additionally supplies opaque
`sandbox_id`, `sandbox_provider`, `lifecycle`, and, when available,
`session_id`, `repo_id`, `user_id`, and `trust_profile` claims. `token_use` is
always `exchanged`. The issuer discovery document is
`<callback-origin>/workload-identity/.well-known/openid-configuration`.

The audience names a verifier. It is not permission by itself: a relying
service must verify the signature, issuer, audience, and expiry, then restrict
the immutable identity claims it trusts. Use a distinct URL or URN audience for
each relying service. Open Session issues the identity only. AWS, GCP, Vault,
and internal services exchange or authorize it themselves.

Set `OPENSESSION_WORKLOAD_IDENTITY_GRANTS` to a JSON array to grant audiences
by repository, lifecycle, and optionally trust profile. A grant matches only
the fields it declares:

```json
[
  {
    "repoId": "example",
    "lifecycle": "setup",
    "audiences": ["urn:example:artifacts"]
  },
  {
    "repoId": "example",
    "lifecycle": "preview",
    "trustProfile": "interactive",
    "audiences": ["urn:example:preview-read"]
  }
]
```

Use separate audiences for setup artifacts, read-only previews, and any
write-capable workflow. Do not grant the `run` lifecycle a cloud audience
unless agent code genuinely needs it. The exchange lease is passed only to the
sandbox process for that lifecycle, is not written to the workspace, and is
absent from reusable prewarm snapshots. A session restored from a snapshot
receives a fresh lease. Do not enable shell tracing around the command or save
a token in the repository.

## preview.json — warm routes

Frameworks with on-demand compilers (Next dev, Vite with heavy transforms)
serve a route slowly the first time it is requested. Warm preview-pool
preparation can request a small set of routes after boot:

```json
{
  "warmRoutes": ["/", "/dashboard", "/api/session"]
}
```

Keep it to the handful of routes people open first. Preview-pool preparation
reads `.agents/preview.json` directly and uses its non-empty `warmRoutes`
array. If the file cannot be parsed or `warmRoutes` is not a non-empty array,
it requests `/`.

Host warm-template refresh does not boot a dev server or warm routes. Its
legacy Settings `warmRoutes` value remains in the API for compatibility but
currently has no effect.

## Portals and `portals.json`

Use session Assets for a static artifact, diagram, report, or standalone HTML
file that does not need a running process. Use a Portal for an interactive app,
web server, API-backed UI, multiple routes, authentication, or anything someone
should open and test live.

Open Session owns `.ports.conf` for the session. It records generated service
metadata and stable `*_PORT` entries. Agents may inspect it, but start, stop,
restart, and default paths go through `opensession-portals`. A Portal process is
session-scoped, receives `PORT` and `PORTAL_URL`, and is exposed only through
the authenticated Open Session URL. A stopped or sleeping Sandbox never turns
into a host Portal by fallback.

Repositories can declare reusable recipes in `.agents/portals.json`:

```json
{
  "portals": [
    {
      "id": "local-webapp",
      "name": "Local webapp",
      "description": "Authenticated app and local dependencies",
      "command": "./.agents/start.sh",
      "serviceKey": "WEBAPP_PORT",
      "readyTimeoutSeconds": 180
    }
  ]
}
```

For a command recipe, the UI asks the server to reread the recipe from the
session workspace and run its declared command under the Portal supervisor;
browser input cannot replace the command. `serviceKey` connects the recipe to
its generated `*_PORT` entry. New recipes should use `command`. Legacy recipes
containing only `skill` send a fixed prompt naming the validated skill instead.
Agents can also create an ad-hoc Portal without changing repository
configuration: create the service,
call `start_portal`, verify it with `list_portals`, then tell the user which
Portal is ready.

## Environment sources for sandboxes

Do not make the Open Session host the source of a repository's secrets.
The portable pattern is:

1. Keep `.agents/setup` deterministic and safe to reuse in a prewarm.
2. Give a sandbox a short-lived OIDC identity for an audience the operator
   approved.
3. In `.agents/start.sh`, after the session workspace is adopted, fetch or
   decrypt the environment from the repository's own secret source and write
   the local file mode `0600`.

The source is repository-owned, not Open Session-owned. It can be an internal
secret service, Vault, a cloud secret manager, SOPS plus a KMS, or any service
that trusts the Open Session identity. The host never needs the secret values,
and no provider-specific CLI needs to be baked into a sandbox image.

Keep this work out of `.agents/setup`: remote prewarms may run setup before a
shared template is published. A secret belongs only in the adopted session
workspace, immediately before a preview starts.

## environment.json — legacy local-file migration

Remote providers clone the repository and therefore cannot see gitignored
environment files from the registered local checkout. `environment.json` can
copy explicitly declared files during a transition away from host-managed
configuration:

```json
{
  "seedFiles": ["packages/web/.env.local", ".envrc"]
}
```

Open Session copies each file from the same relative path in the registered
checkout into the session-owned sandbox after a template is restored and
before the session setup hook runs. The files are never included in a shared
prewarm or provider snapshot. New repositories should use an external
environment source instead.

Every declared source is required, must be a regular gitignored text file
inside the registered checkout, and is written mode `0600`. Each seed file is
capped at 1 MiB, and the aggregate contents of all declared seed files are
capped at 4 MiB. The manifest itself is read from the operator-controlled
checkout, not from an agent branch, so a PR cannot ask Open Session to upload
a different host file.

## A minimal pair

```bash
#!/usr/bin/env bash
# .agents/setup — one-shot per workspace. Idempotent.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
bun install
```

```bash
#!/usr/bin/env bash
# .agents/start.sh — boot the dev server in the foreground.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -f .env.local ]; then
  echo "ERROR: .env.local missing. Run once: <your env-pull command>" >&2
  exit 2
fi

# Trust the preview origin so the framework hydrates behind it.
if [ -n "${PREVIEW_URL:-}" ]; then
  host="${PREVIEW_URL#*://}"; host="${host%%[:/]*}"
  export ALLOWED_DEV_ORIGINS="$host"   # whatever your framework expects
fi

exec bun run dev --port "${WEBAPP_PORT:-3000}"
```

Real scripts grow from here — a prebuilt-WASM fetch instead of a local
toolchain build, a credentials shim, a write-access preflight — but the shape
stays: idempotent setup, foreground start, contract honored, loud actionable
failures.

## Letting the agent test the app itself

The scripts have a second consumer besides the Preview button: the agent.
With the pair committed, any session worktree is bootable headlessly, which
closes the loop _change → boot → screenshot → iterate_ entirely inside a
session — the agent verifies its own UI work in a real browser instead of
declaring victory from a successful compile. Running this daily on our own
repos, these are the patterns that make it work:

- **A dev auth bypass.** The single biggest unlock. An env-gated auto-login
  (dev-only, secrets gitignored) means every headless request is
  authenticated — no interactive OAuth dance a bot can't perform. Gate it
  hard: dev environment only, never in committed config.
- **An idempotent ensure-up.** The agent shouldn't reason about whether the
  server is running — give it one command that is instant when it already is
  and boots when it isn't, and make the port discoverable (`.ports.conf`, or
  a well-known file) so follow-up tooling finds the server without guessing.
- **Committed driving instructions.** Pair the scripts with a repo skill or
  an agent-instructions section that says: run this to bring the app up, then
  use these one-liners to screenshot / record / evaluate JS over CDP
  (puppeteer or `chrome --remote-debugging-port`). The lifecycle scripts make
  the app _reachable_; the instructions make it _drivable_.
- **Human-once bootstrap, machine-many reuse.** Secrets that genuinely need
  an interactive login get pulled once into the main checkout by a human;
  `setup` (or the skill) seeds them from there into each worktree. Scripts
  fail with the copy-pasteable bootstrap commands when the seed is missing.

## Pointers

- [worktrees.md](worktrees.md) — worktree creation and where the `setup` hook
  fits in the dependency-install chain
- [deploy/sandbox/README.md](../deploy/sandbox/README.md) — the same
  convention inside sandboxes: port publishing, `.tunnels.env`, setup logs
- [self-development.md](self-development.md) — Open Session's own
  `.agents/` scripts, a real in-tree example
