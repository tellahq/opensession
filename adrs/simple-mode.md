# Simple mode: requirements

Status: draft. Requirements, not design. Written 2026-08-18.

## Problem

Open Session's install works, but it is an operator's install: a runtime, a
source clone, four chained `curl | bash` installers, a ten-question terminal
wizard, an out-of-band credential step, an opt-in service, and a public-URL
problem the docs hand to Caddy. Someone who wants to _try it_ on a laptop or
a cheap Linux box has to make a dozen decisions they do not yet have the
context for, and then keep a server healthy they do not know how to operate.

The tools people compare us to (OpenClaw, Ollama, PocketBase, Temporal
`start-dev`, the *ARR apps) get from a one-liner to first value in two or
three minutes by locking every one of those decisions to a default and
moving the rest into the browser. We need that tier, **simple mode**,
without giving up the configurable install sophisticated teams run today.

## Two tiers, one codebase

|          | Simple mode (this doc)           | Full install (today's docs)    |
| -------- | -------------------------------- | ------------------------------ |
| Who      | one person, one box, trying it   | a team operating it            |
| Where    | laptop, Mac mini, cheap VPS      | EC2/VPS with a public hostname |
| Bind     | `127.0.0.1:3850`                 | Tailscale IP / behind Caddy    |
| Exposure | one outbound tunnel for webhooks | reverse proxy + DNS + TLS      |
| Config   | all defaults; browser first-run  | wizard / `config.json` / env   |
| Ops      | self-maintaining, alarms only    | operator + runbooks            |

Simple mode is the default outcome of `curl … | bash`. Everything today's
installer and wizard can do stays reachable (`--advanced`, `onboard --force`,
the docs), and a simple-mode install upgrades to a full one without
reinstalling: same files, same paths, more of them filled in.

## Definition of done (the "insanely simple" bar)

On a fresh macOS or Ubuntu box with only `curl` and `git`:

1. One command, no flags, no sudo prompt on the happy path.
2. Zero questions before the server is running.
3. It ends with a URL, and that URL opens a first-run page.
4. First-run page: pick a display name, sign in a model account, pick or
   create a repo. Three screens.
5. First agent turn completes inside **five minutes** wall clock on a decent
   connection, including downloads.
6. Close the laptop / reboot the box: it comes back on its own.
7. Walk away for a month: it is still healthy, or it told you why not.
8. `opensession uninstall` (or `curl … | bash -s -- --uninstall`) leaves
   nothing behind but your repos. Today's uninstall removes the shim and
   service only and deliberately keeps checkout, config, env, sessions,
   PATH lines and skill symlinks.

## R1. Install

- **R1.1** Rootless by default: everything under `~/.opensession` (Bun,
  source, deps, engine binaries, data). No `sudo` unless the user opts into
  a system service or Tailscale on Linux; both are offered _after_ the first
  turn, not before.
- **R1.2** Trim the critical path. The `claude` CLI is needed for an Anthropic
  turn (Pi is bundled into the binary); `codex` and Tailscale are not. Install
  them lazily: `codex` when the
  user picks the ChatGPT path on the first-run page, Tailscale when they ask
  to share or expose. (Same reasoning as the installer already applies to
  `--no-engine`; flip the default.)
- **R1.3** Prebuilt release artefact. Simple mode installs what a customer
  downloads, never a source clone plus `bun install`. This is a **ship
  requirement**, not a follow-on: the multi-gigabyte dependency tree is the
  single largest cost on the critical path and the main reason the install
  cannot hit the five-minute bar.
  - Artefact: a `bun build --compile` executable, tarred as
    `opensession-<ver>-<os>-<arch>.tar.gz` with the required session-kernel,
    transport, workflow, and code-flow worker `.js` sidecars; the minimal
    `node_modules` Sharp sidecar; gateway, executor, and session-kernel service
    templates; the fixed privileged-helper installation assets; and
    `release.json`. `src/main.ts` is the front controller for the server, CLI,
    runner host, MCP proxy, executor, session-kernel service, and
    transcript-search worker, so the binary re-execs itself for process side
    entrypoints via `process.execPath`; the prebuilt frontend is baked in with
    `Bun.embeddedFiles`. `bun build --compile --target=bun-<os>-<arch>`
    cross-compiles every target from one runner. Unpacked to
    `~/.opensession/releases/<ver>/` with the `src` link; `opensession update`
    swaps it and keeps the previous release for rollback.
  - Consequences: no `bun` on the box, no `.git`, no full `node_modules`
    (only the sharp sidecar) under `~/.opensession`; client apps (Electron,
    Swift, Chrome, TUI) are outside the build graph; `doctor` reports Bun as
    embedded; the harness installs the artefact, not the source. The
    `--source` install (a git checkout + `bun install`) stays as the
    self-development and contributor path.
- **R1.4** Idempotent and pinnable. Source installs can select a branch or tag
  with `install.sh --channel`, which implies the source path. Release installs
  currently use `--artifact` for an explicit tarball; release tag/channel
  selection is not implemented. On a release install, `opensession update
--channel` currently expects a complete artefact URL. With no channel it
  fetches the latest artefact for the OS/arch, unpacks it beside the current
  release, swaps the `src` symlink atomically, and restarts, keeping the old
  release for rollback. Keep `--uninstall`; it preserves any session worktree
  that holds uncommitted or unpushed work.
- **R1.5** Installer output is a checklist, not a log; the last line is the
  URL.

## R2. First run in the browser, not the terminal

- **R2.1** The installer writes `config.json` + `.env` with all defaults
  (product name, private app `127.0.0.1:3850`, ingress `3860`, worktrees dir, no
  integrations, no automations) and starts the server. `opensession onboard`
  becomes `--advanced` mode; the ten questions still exist there. The
  no-flag installer runs `onboard --defaults` (no questions, service
  installed, ends with the URL).
- **R2.2** `/setup` first-run page, served until complete:
  1. Display name.
  2. Model account: **Claude Max via `claude setup-token`**, and only
     that on the simple-mode path (decision, 2026-08-18). The page shows the
     exact command, one paste field, write-only after save. `setup-token`
     mints a standalone OAuth token that lasts about a year; the
     interactive keychain access token
     expires within hours and is never used. ChatGPT (device code) and
     API-key providers stay in Workspace → Models for anyone who wants
     them, but the first-run page does not offer a menu.
  3. Repo: pick a local path, clone by URL, or **"start with a scratch
     repo"**, a throwaway git repo the server creates so a turn can run
     before the user commits to pointing it at real code.
- **R2.3** The setup page ends by running a real turn ("say hello and list
  the files") and shows its output. A health check is not proof; a turn is.
  This is `doctor`'s "can run turns" check, made visible.
- **R2.4** Everything else (integrations, automations, sharing, service)
  is a "next steps" checklist inside the UI, each item one screen.
- **R2.5** Unattended model-account provisioning remains a requirement, not
  current behavior. The intended precedence is `OPENSESSION_CLAUDE_TOKEN` at
  install or boot, then a one-line `~/.opensession-claude-token` file (0600),
  then the first-run page; a token should enter the account pool and the staged
  file should be removed. Currently the installer writes its environment token
  to that file, but the server consumes neither source and does not remove the
  file. The harness's secret-backed real-turn path therefore cannot pass yet.

## R3. Runs as a service from the start

- **R3.1** The installer installs and starts a **user-level** supervisor:
  LaunchAgent on macOS and `systemd --user` on Linux, with
  `loginctl enable-linger` so it survives logout. No root or system unit is
  required. The rootless Linux unit deliberately runs agent turns inside the
  gateway process because it cannot read the root-owned executor credential.
  `opensession service install --system` is the hardened operator path: it
  installs the independent executor, fixed root helper, and detached run-host
  policy. `loginctl enable-linger` is root-free on Ubuntu 24.04; where policy
  wants an admin, the CLI prints the one command to run. Calls are bounded so
  a wedged logind cannot hang installation indefinitely.
- **R3.2** `Restart=always`, log to a rotated file under
  `~/.opensession/logs`, and `opensession logs`/`status` work against
  whichever supervisor is in use. Today launchd writes unrotated
  `server.log`/`server.err.log` there and systemd logs to the journal only;
  `logs`/`status` already handle both.
- **R3.3** Auto-update is **on** in simple mode: a daily `opensession
update` through the existing health-gated path, with the previous checkout
  kept for rollback. Off by default in full install (operators own their
  deploys). One toggle in Settings.

## R4. Webhooks without a public server

Inbound webhooks are fundamental (Slack, GitHub, Linear, Plain, Stripe all
land on the fail-closed loopback ingress gateway on `:3860`) and a simple-mode
box has no public hostname. The same gateway serves remote Sandbox callbacks
and workload identity.

- **R4.1 Settings → Public ingress**: choose an exposure method that gives
  `:3860` a public HTTPS URL and stores one canonical origin:
  1. **Cloudflare Tunnel**: a named tunnel with a CNAME to
     `<tunnel-id>.cfargotunnel.com`, without inbound ports.
  2. **Custom domain**: A/AAAA records plus a managed Caddy site.
     Only `:3860` is exposed. The private app on `:3850` never is: the gateway
     dispatches exact registered routes and returns 404 for everything else.
- **R4.2 Integration setup screens show the URLs.** Enabling Slack/GitHub/
  Linear/Plain/Stripe in the UI shows _this install's_ event URL(s) and the
  secret fields, and verifies the first inbound event, instead of linking to
  docs. Slack's URL verification requires the server to be up; the screen
  says so.
- **R4.3 Pull modes where the provider offers them**, so the two most
  common integrations need no exposure at all:
  - **Slack Socket Mode**: outbound WebSocket, app-level `xapp-` token, no
    signing secret, no URL. Not implemented today; the highest-value item on
    this list because it makes Slack + GitHub work with zero exposure.
  - **GitHub**: `gh webhook forward` (official extension) as a managed
    subprocess, or API polling of PR/issue comments; the existing
    `github-pr-review` recipe should work either way.
  - **Stripe**: `stripe listen --forward-to` for try-out.
    Linear and Plain are webhook-only and stay on R4.1.
- **R4.4** Precedence is explicit and visible: an integration is _configured_
  (creds present), _reachable_ (tunnel or socket up), and _verified_ (an
  event arrived). `doctor` and the UI show all three.

## R5. No maintenance toil

Simple-mode users will not read `journalctl`, will not notice a full disk
until sessions start failing, and will not know that a pinned CPU is a
runaway `cargo build` in a worktree. The system must stay healthy on its
own, and when it cannot, tell the user in the UI in words, with a button.

Disk GC and the worktree reaper are enabled by default and run hourly after
short initial delays; the archived-session worktree sweep runs every six hours.
The reaper may bank dirty or unpushed state in the parked-work store before
removing a worktree, and keeps the tree if banking fails. Other chassis parts
include Linux system-scope memory/task limits on detached engine and preview
scopes, rootless runs in the gateway process, and a self-deploy watchdog that
only guards rollbacks and is never installed by the app. The
`instance-health` recipe remains disabled by default. Simple mode adds the
missing pieces and surfaces them.

- **R5.1 Budgets, not limits.** Simple mode ships with a **disk budget**
  (default: whichever is smaller of 20 GB or 40 % of the free space at
  install) and enforces it in layers: worktree parking → archived-session
  sweep → engine DB compaction → build-output eviction (`target/`, `dist`,
  `.next`, `build`, `node_modules` in _parked_ worktrees only) → refuse new
  sessions with a clear message when still over. Never discard dirty or
  unpushed work. The UI shows the budget as a bar with
  "what is using it" and a "reclaim now" button.
- **R5.2 Runaway runs.** Per-run CPU/memory/time caps on by default on both
  platforms: transient systemd scopes on Linux (already exists for detached
  engines and previews; extend to every run), and an equivalent on macOS
  (process-group `ulimit`s + a wall-clock kill, since launchd has no
  cgroups). A run that hits a cap is _stopped, not killed silently_: the
  session shows why, and offers "retry with a higher limit".
- **R5.3 Zombie and leak hygiene.** Sweep orphaned engine processes,
  MCP proxies, preview servers, and tunnels whose session ended; sweep
  detached `git worktree` registrations; rotate and cap logs and the audit
  log; cap session-store growth by archiving cold transcripts. All on the
  existing hourly tick, all reported in `doctor`.
- **R5.4 Health in the UI, alarms only.** A status strip: disk (budget %),
  memory pressure, load, engine reachability, tunnel/webhook reachability,
  last successful turn, last successful update. Green is silent. Anything
  else is a banner in plain language ("Disk is 92 % full. 6 GB is parked
  worktrees you can remove") with the one action that fixes it. The
  `instance-health` automation is **enabled** in simple mode and delivers to
  wherever the user reads (the UI inbox; Slack once connected); it stays
  observe-and-notify.
- **R5.5 Self-heal what is safe, ask about the rest.** Auto: restart on
  crash, DB compaction, log rotation, parking, tunnel reconnect, resuming
  interrupted runs (exists). Ask: deleting anything with unpushed work,
  raising limits, upgrading across a breaking version.
- **R5.6 Sleep and reboot.** macOS laptops sleep; the server, the tunnel and
  the supervisor must resume cleanly, and a run interrupted by sleep is
  resumed or marked interrupted, never left spinning. `caffeinate` is not the
  answer; a clean interrupted-state is.
- **R5.7 One-screen "what happens on this box"** in the docs and Settings:
  what runs on a schedule, what it may delete, where the data lives, how to
  turn each off. Simple mode may not be a black box.

## R6. Security posture unchanged

The cloud metadata endpoint is a caveat worth stating. Rootless Linux mode
runs agent turns inside the user gateway, where a per-user manager cannot
apply `IPAddressDeny=` on stock Ubuntu. The hardened system scope launches
runs through the credentialed executor and fixed root helper. Before installing
a user-scope service, `service install` probes 169.254.169.254 and refuses when
it responds unless `OPENSESSION_ALLOW_IMDS=1` is explicitly set. The complete
host-level control is a firewall rule covering the service uid. The system
unit's `IPAddressDeny=` is defense in depth for its own cgroup and does not
cover detached user scopes. Full detail is in
[`docs/setup/integrations-misc.md`](../docs/setup/integrations-misc.md).

- Bind stays loopback; sharing with a teammate is a deliberate `opensession
bind` / Tailscale step with the trust-model warning (exists).
- Only the isolated public-ingress listener on `:3860` may be exposed. It
  serves an explicit allowlist of webhook and OAuth routes, authenticated
  sandbox and RPC WebSockets, workload identity, an unsigned health endpoint,
  and capability/signed public image and card routes. Each sensitive route
  applies its own signature, token, OAuth-state, or workload-identity check.
  Unknown methods and paths return 404, and the app UI is never served there.
- Auto-update pulls signed tags/`main` from the configured remote only;
  self-development installs (forks) keep the existing "your fork, your
  remote" rules.
- Runs keep the minimal-env, no-token-inheritance model regardless of tier.

## Test harness

The definition of done is only real if a machine checks it on a fresh box.
The harness lives in `test/simple-mode/` and runs locally first; CI is a
second consumer of the same files, not the primary one.

- **VM, not container.** Two requirements need a real machine: a user-level
  supervisor with linger (R3) and a reboot (DoD 6). Containers keep a fast
  smoke tier (install, `start --foreground`, health) but cannot carry the
  full bar.
- **Lima** for the VM (`test/simple-mode/lima.yaml`: Ubuntu 24.04, cloud
  images, virtiofs mounts, declarative, runs on Apple Silicon and Linux).
  Multipass is the fallback if Lima ever becomes a problem; Vagrant is out
  (no sane Apple Silicon provider).
- **Goss** for assertions (`test/simple-mode/goss.yaml`): ports, services,
  files, HTTP, and commands in YAML with a pass/fail table. `goss.yaml` is the
  current post-install bar (`opensession` on PATH, expected runtime files and
  model CLIs, `doctor` runs, loopback-only listeners, health, and embedded
  assets). `goss.dod.yaml` adds the user service, linger, stricter `doctor`, and
  no Tailscale or source checkout; `goss.uninstalled.yaml` checks the strict
  clean uninstall. Both strict files run only with
  `SIMPLE_MODE_STRICT=1`.
- **A `bun test` driver** builds the release artefact for the VM's arch,
  creates the VM, installs the artefact as a customer would (no Bun or clone in
  the guest), checks the service and current Goss bar, creates a session
  worktree, performs the basic uninstall, and destroys the VM. Strict mode adds
  the DoD Goss checks, Lima reboot, the saved-work uninstall guard, and strict
  uninstall assertions. `SIMPLE_MODE_SOURCE=1` covers the contributor path.
  The driver is TypeScript calling `limactl` and `goss`, with no hand-written
  shell scripts. `SIMPLE_MODE_TARGET=host` runs without Lima, but skips the
  reboot check.
- **The real turn** runs only when `OPENSESSION_TEST_CLAUDE_TOKEN` is set;
  everything else runs without a secret. Its timer starts after installation
  and permits eight minutes, so it does not yet enforce DoD 5's five-minute,
  download-inclusive limit.
- **Sudo is a test dimension.** The Lima user has passwordless sudo, which
  hides R1.1. `SIMPLE_MODE_NOSUDO=1` runs as a second user without sudoers
  rights. Lima currently pre-enables linger for that user during root
  provisioning, so this mode does not yet prove that the installer enabled it.
- CI (GitHub Actions `ubuntu-latest` as the fresh VM, `macos-latest` for
  the LaunchAgent path) reuses the driver with `SIMPLE_MODE_TARGET=host`.
  Later; local comes first.

Smoke/current bar:

```sh
bun test ./test/simple-mode/harness.test.ts
```

Current strict Linux no-sudo checks:

```sh
SIMPLE_MODE_STRICT=1 SIMPLE_MODE_NOSUDO=1 \
  bun test ./test/simple-mode/harness.test.ts
```

Add `OPENSESSION_TEST_CLAUDE_TOKEN` for the real-turn path. The harness does
not yet enforce the five-minute install-inclusive bar, verify removal of
separately installed tooling such as Claude or `gh`, or prove installer-driven
linger setup for the no-sudo user. It is not part of `bun test`'s default
`src scripts` set and needs Lima unless `SIMPLE_MODE_TARGET=host` is set.

## Non-goals

- Multi-user auth in simple mode. Sharing = Tailscale (full-install
  guidance).
- Docker as the primary distribution. Docker sandboxes stay optional; a
  compose file is a full-install artefact.
- Public exposure of the UI. Ever.

## Open questions and resolved history

1. **Resolved in the current implementation:** the prebuilt distribution is
   a compiled executable plus the required worker, Sharp, service, and policy
   sidecars. Pi and the frontend are embedded, Claude is installed separately,
   and source and artefact installs share `opensession update`.
2. Slack Socket Mode: coexistence with the HTTP path for full installs, and
   what breaks in the Slack agent's request-signature assumptions.
3. macOS run caps: is `ulimit` + a supervisor timer enough, or does simple
   mode on macOS lean on Docker sandboxes for isolation?
4. Disk budget defaults for a laptop vs. a 20 GB VPS.
5. Where the first-run page's "scratch repo" lives, and whether it is
   removed once a real repo is registered.

## Prior art consulted

OpenClaw (rootless install, QuickStart vs Manual wizard, user-level daemon,
no inbound), Temporal `server start-dev` (dev topology distinct from prod),
Sonarr/Radarr (single binary, embedded DB, first-run in browser), Grafana
(config file ↔ env mirror, `brew services`), Ollama (installer installs the
service, documented uninstall/pin), PocketBase/Gitea (one-shot setup URL),
Coolify (installer brings Docker; browser registers admin), Tailscale
(install ≠ join), Cloudflare quick tunnels, `gh webhook
forward`, `stripe listen`, Slack Socket Mode, Home Assistant / n8n tunnel
modes for webhooks.
