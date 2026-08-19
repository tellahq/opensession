# Simple mode: requirements

Status: draft. Requirements, not design. Written 2026-08-18.

## Problem

Open Session's install works, but it is an operator's install: a runtime, a
source clone, four chained `curl | bash` installers, a ten-question terminal
wizard, an out-of-band credential step, an opt-in service, and a public-URL
problem the docs hand to Caddy. Someone who wants to *try it* on a laptop or
a cheap Linux box has to make a dozen decisions they do not yet have the
context for, and then keep a server healthy they do not know how to operate.

The tools people compare us to (OpenClaw, Ollama, PocketBase, Temporal
`start-dev`, the *ARR apps) get from a one-liner to first value in two or
three minutes by locking every one of those decisions to a default and
moving the rest into the browser. We need that tier, **simple mode**,
without giving up the configurable install sophisticated teams run today.

## Two tiers, one codebase

| | Simple mode (this doc) | Full install (today's docs) |
|---|---|---|
| Who | one person, one box, trying it | a team operating it |
| Where | laptop, Mac mini, cheap VPS | EC2/VPS with a public hostname |
| Bind | `127.0.0.1:3850` | Tailscale IP / behind Caddy |
| Exposure | one outbound tunnel for webhooks | reverse proxy + DNS + TLS |
| Config | all defaults; browser first-run | wizard / `config.json` / env |
| Ops | self-maintaining, alarms only | operator + runbooks |

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
  a system service or Tailscale on Linux; both are offered *after* the first
  turn, not before.
- **R1.2** Trim the critical path. `opencode` and `claude` are needed for a
  turn; `codex` and Tailscale are not. Install them lazily: `codex` when the
  user picks the ChatGPT path on the first-run page, Tailscale when they ask
  to share or expose. (Same reasoning as the installer already applies to
  `--no-engine`; flip the default.)
- **R1.3** Prebuilt release artefact. Simple mode installs what a customer
  downloads, never a source clone plus `bun install`. This is a **ship
  requirement**, not a follow-on: the multi-gigabyte dependency tree is the
  single largest cost on the critical path and the main reason the install
  cannot hit the five-minute bar.
  - Artefact: a `bun build --compile` single executable, tarred as
    `opensession-<ver>-<os>-<arch>.tar.gz` beside a small `node_modules`
    sharp sidecar (its platform native cannot be embedded), the engine seed,
    and `release.json`. `src/main.ts` is the front controller (server / CLI /
    runner-host / mcp-proxy behind one argv), so the binary re-execs itself
    for its side entrypoints via `process.execPath`; the prebuilt frontend is
    baked in with `Bun.embeddedFiles`. `bun build --compile --target=bun-<os>-
    <arch>` cross-compiles every target from one runner. Unpacked to
    `~/.opensession/releases/<ver>/` with the `src` link; `opensession update`
    swaps it and keeps the previous release for rollback.
  - Consequences: no `bun` on the box, no `.git`, no full `node_modules`
    (only the sharp sidecar) under `~/.opensession`; client apps (Electron,
    Swift, Chrome, TUI) are outside the build graph; `doctor` reports Bun as
    embedded; the harness installs the artefact, not the source. The
    `--source` install (a git checkout + `bun install`) stays as the
    self-development and contributor path.
- **R1.4** Idempotent and pinnable: re-run to upgrade (true today when
  the checkout is clean and fast-forwardable), and `--channel` for a tag.
  Keep `--uninstall`. A release install upgrades by download-and-swap:
  `opensession update` fetches the latest artefact for the OS/arch, unpacks
  it beside the current release, swaps the `src` symlink atomically, and
  restarts, keeping the old release for rollback. `--uninstall` preserves any
  session worktree that holds uncommitted or unpushed work.
- **R1.5** Installer output is a checklist, not a log; the last line is the
  URL.

## R2. First run in the browser, not the terminal

- **R2.1** The installer writes `config.json` + `.env` with all defaults
  (product name, `127.0.0.1:3850`, webhook `3848`, worktrees dir, no
  integrations, no automations) and starts the server. `opensession onboard`
  becomes `--advanced` mode; the ten questions still exist there. The
  no-flag installer runs `onboard --defaults` (no questions, service
  installed, ends with the URL).
- **R2.2** `/setup` first-run page, served until complete:
  1. Display name.
  2. Model account: **Claude Max via `claude setup-token`**, and only
     that on the simple-mode path (decision, 2026-08-18). The page shows the
     exact command, one paste field, write-only after save. `setup-token`
     mints a standalone OAuth token that lasts about a year, the same flow
     tellahq/crucible relies on; the interactive keychain access token
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
- **R2.5** Unattended provisioning of the model account, in this order
  (mirrors crucible's seeding): `OPENSESSION_CLAUDE_TOKEN` in the
  environment at install or boot; else a one-line
  `~/.opensession-claude-token` file (0600); else the first-run page. A
  token from either source is written into
  `~/.opensession-claude-accounts.json` as the pool account and the file
  source is removed after import. This is what cloud-init, the VM harness
  and the "paste this into an agent" README path use, and it is how the
  harness runs a real turn (DoD 5).

## R3. Runs as a service from the start

- **R3.1** The installer installs and starts a **user-level** supervisor:
  LaunchAgent on macOS (exists, but opt-in from onboarding with default
  No), `systemd --user` unit on Linux (new: today only a `/etc/systemd`
  system unit installed via sudo) with `loginctl enable-linger` so it
  survives logout. Installed and started by the installer, not offered.
  No root, no unit files to write. `opensession service install` defaults to
  the user scope; `--system` is the root-unit operator path. `loginctl
  enable-linger` is root-free on Ubuntu 24.04 (polkit `set-self-linger` is
  allow-any); where an older policy wants an admin, the CLI falls back to a
  non-interactive `sudo` and otherwise prints the one command to run.
  `loginctl` calls are bounded, since a wedged logind hangs indefinitely.
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
land on the loopback webhook server on `:3848`) and a simple-mode box has no
public hostname. Prior art splits two ways; we need both.

- **R4.1 `opensession expose`**: one command that gives `:3848` a public
  HTTPS URL, stores it as the webhook base, and prints paste-ready URLs for
  every integration. Backends, in preference order:
  1. **Tailscale Funnel** (`tailscale funnel --bg 3848`): stable URL, real
     cert, survives reboots; needs a tailnet + the `funnel` ACL attribute,
     which the command links to.
  2. **Cloudflare quick tunnel** (`cloudflared tunnel --url`): no account,
     random hostname; good enough to try Slack for ten minutes. Named tunnel
     with a free account for stability.
  Only `:3848` is exposed. The UI on `:3850` never is: every exposed route
  is HMAC-verified and fail-closed, the UI has no auth. `doctor` reports the
  tunnel's state and whether the stored base URL still resolves to us.
- **R4.2 Integration setup screens show the URLs.** Enabling Slack/GitHub/
  Linear/Plain/Stripe in the UI shows *this install's* event URL(s) and the
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
- **R4.4** Precedence is explicit and visible: an integration is *configured*
  (creds present), *reachable* (tunnel or socket up), and *verified* (an
  event arrived). `doctor` and the UI show all three.

## R5. No maintenance toil

Simple-mode users will not read `journalctl`, will not notice a full disk
until sessions start failing, and will not know that a pinned CPU is a
runaway `cargo build` in a worktree. The system must stay healthy on its
own, and when it cannot, tell the user in the UI in words, with a button.

Parts of the chassis exist, none of it as a default: three hourly sweeps
(`disk-gc.ts` reclaims Rust `target/` under pressure; `worktree-reaper.ts`
parks clean idle checkouts; `sweepArchivedWorktrees` in `worktree.ts`), an
OpenCode DB compactor that is a standalone script for an external cron
(`scripts/opencode-db-gc.ts`, nothing installs it), Linux-only
`systemd-run --user` memory/task limits on detached engine and preview
scopes (CPU quota on previews only), the `instance-health` recipe
(`enabled: false`, Slack delivery), and a self-deploy watchdog that only
guards rollbacks and is never installed by the app. Simple mode turns
these on by default, adds the missing pieces, and surfaces them.

- **R5.1 Budgets, not limits.** Simple mode ships with a **disk budget**
  (default: whichever is smaller of 20 GB or 40 % of the free space at
  install) and enforces it in layers: worktree parking → archived-session
  sweep → engine DB compaction → build-output eviction (`target/`, `dist`,
  `.next`, `build`, `node_modules` in *parked* worktrees only) → refuse new
  sessions with a clear message when still over. Never touch dirty or
  unpushed work (existing rule). The UI shows the budget as a bar with
  "what is using it" and a "reclaim now" button.
- **R5.2 Runaway runs.** Per-run CPU/memory/time caps on by default on both
  platforms: transient systemd scopes on Linux (already exists for detached
  engines and previews; extend to every run), and an equivalent on macOS
  (process-group `ulimit`s + a wall-clock kill, since launchd has no
  cgroups). A run that hits a cap is *stopped, not killed silently*: the
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

The cloud metadata endpoint is a caveat worth stating, because installing a
service on a cloud box by default puts it in reach. The engine detaches each
session into its own `systemd --user` scope (so restarts do not kill
in-flight turns), which sits outside any unit's cgroup — so the metadata
block (`IPAddressDeny=`) does not reach the agent's children under the user
or the system unit, and a per-user manager cannot apply `IPAddressDeny=` at
all on stock Ubuntu (`PrivateUsers=` is denied to unprivileged users,
silently). So `service install` probes 169.254.169.254 and refuses when it
answers, naming the controls that do cover the engine's children: a host
firewall rule on the endpoint (`-m owner --uid-owner <uid>`),
`OPENSESSION_OC_DETACH=0` (keeps engines in the system unit's cgroup), or
`OPENSESSION_ALLOW_IMDS=1` on a box with no role. Full detail in
`docs/setup/integrations-misc.md`.

- Bind stays loopback; sharing with a teammate is a deliberate `opensession
  bind` / Tailscale step with the trust-model warning (exists).
- Only the webhook server is ever exposed, only via R4, only HMAC-verified
  routes. No route on the exposed port may serve UI or accept unsigned
  input.
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
  files, HTTP, commands, in YAML with a pass/fail table. Two files:
  `goss.yaml` is what must hold today (installer exit, `opensession` on
  PATH, health, loopback-only listeners, `doctor` clean but for accounts);
  `goss.dod.yaml` is the simple-mode bar (user service active, linger,
  survives reboot, uninstall leaves nothing) and is expected to fail until
  simple mode lands.
- **A `bun test` driver** orchestrates: build the release artefact for the
  VM's arch (R1.3), create the VM, run the installer against that artefact
  exactly as a customer would (no Bun, no git clone in the guest), run
  Goss, reboot, run Goss again, uninstall, run Goss, destroy. A
  `--source` variant of the same run covers the contributor path. TypeScript calling `limactl` and `goss`; no
  hand-written shell scripts. `SIMPLE_MODE_TARGET=host` runs the same steps
  on the current machine (a CI runner, or a throwaway box) without Lima.
- **The real turn** (DoD 5) runs only when `OPENSESSION_TEST_CLAUDE_TOKEN`
  is set; everything else runs without any secret.
- **Sudo is a test dimension.** The Lima user has passwordless sudo, which
  hides R1.1. The driver has a no-sudo mode that runs the installer as a
  second user without sudoers rights; that mode is the one that must pass
  for simple mode.
- CI (GitHub Actions `ubuntu-latest` as the fresh VM, `macos-latest` for
  the LaunchAgent path) reuses the driver with `SIMPLE_MODE_TARGET=host`.
  Later; local comes first.

Run: `bun test ./test/simple-mode/harness.test.ts` (not part of `bun test`'s default `src
scripts` set; it takes minutes and needs Lima).

## Non-goals

- Multi-user auth in simple mode. Sharing = Tailscale (full-install
  guidance).
- Docker as the primary distribution. Docker sandboxes stay optional; a
  compose file is a full-install artefact.
- Public exposure of the UI. Ever.

## Open questions

1. Prebuilt binary: single `bun build --compile` executable vs. tarball
   with pinned Bun; how the engine (`opencode`, `claude`) and frontend
   assets travel with it; how self-development installs (source) and
   simple-mode installs (artefact) share `opensession update`.
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
(install ≠ join; Funnel/Serve), Cloudflare quick tunnels, `gh webhook
forward`, `stripe listen`, Slack Socket Mode, Home Assistant / n8n tunnel
modes for webhooks.
