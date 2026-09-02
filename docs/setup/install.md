# Install: bare box to running service

## Fastest path: nothing to a first session

One prerequisite the installer cannot give you: **model capacity**. The
fastest paths are a Claude Max subscription for Anthropic or a ChatGPT plan
for OpenAI. You can instead configure a supported provider API key under
Workspace → Providers. Open Session does not bundle a model credential.

The installer adds the `claude` CLI, which mints and uses a Claude subscription
token, and the `codex` CLI, which backs the in-app ChatGPT sign-in (the Pi
engine itself is bundled in the binary). It skips existing CLIs. `--no-engine`
skips both installs, while `--no-codex` skips only Codex.

Then, end to end:

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash
# installs the compiled release, onboards with defaults, starts the service,
# and prints your local URL plus any shell-profile command you need to run
# Open a new shell, or run that printed `source …` command, before continuing.
claude setup-token     # on your Max login; copy the sk-ant-… it prints
```

Need access from other devices? The recommended remote-access install adds
Tailscale plus Caddy and the lego certificate helper, which prepare the box for
private HTTPS and friendly custom domains:

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --tailscale --caddy
```

The `bash -s --` separator is required: it tells Bash to read the script from
standard input and pass everything after `--` to that script. See [Install
with Tailscale](#install-with-tailscale) for the remaining setup and for adding
Tailscale after a normal install.

Now **open the URL the installer prints** (`http://127.0.0.1:3850` by default).
Add model capacity under Workspace → Providers: paste the `sk-ant-…`, use the
ChatGPT device-code sign-in, or add a provider API key and choose one of its
models. Then pick your repo on the home screen, write a prompt, and create the
session. A turn that actually runs is the only proof the install works, not a
health check.

Budget a few minutes on a fresh box, most of it unattended: the installer
downloads the compiled release binary and the requested model CLIs (the Pi
engine is bundled in the binary).

Sections 3-5 and 7 below — automations, environment variables, `config.json`,
and MCP — are reference material you can skip on a first install. Networking,
TLS, GitHub, and systemd details are also optional for session #1. Come back to
them when the first session has run.

Prerequisites: Linux, macOS, or Windows 10/11 with WSL2, plus `git` and
`curl`. The default release install needs nothing else on the box: the
compiled binary embeds the Bun runtime and the Pi engine. A source install
uses [Bun](https://bun.sh), which the installer adds when it is missing. `gh`
(authenticated) is needed for pull-request operations. See
[README.md](README.md#minimum-requirements) for the optional extras.

Provisioning a fresh cloud box first? [ec2.md](ec2.md). There is one
cloud-init trap worth knowing about.

### Windows: run the server in WSL2

Open Session supports a Windows host through WSL2. The server and agent engines
run in the Linux environment. Native Windows is supported separately as a
[Runner](../runners.md#windows-runners) for PowerShell and Windows toolchains;
running the server directly from PowerShell is not supported.

First install Ubuntu from an Administrator PowerShell window:

```powershell
wsl --install -d Ubuntu
```

Restart Windows if prompted, open Ubuntu, and finish creating its Linux user.
Open Session uses systemd to supervise its gateway and session-kernel services
inside WSL. Check what PID 1 is inside Ubuntu:

```sh
ps -p 1 -o comm=
```

If that does not print `systemd`, enable it inside Ubuntu:

```sh
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Then apply the change from PowerShell and reopen Ubuntu:

```powershell
wsl --shutdown
```

Run the standard installer inside Ubuntu:

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash
```

The default `http://127.0.0.1:3850` address is reachable from Windows through
WSL's localhost forwarding. For access from other machines, install and join
Tailscale inside WSL, then use `opensession bind` to bind Open Session to that
tailnet address. Do not expose it with `HOST=0.0.0.0`.

WSL distributions do not start at Windows boot on their own. After a Windows
restart, opening Ubuntu once starts systemd and the enabled Open Session
service. For an unattended desktop, create a Windows logon task after the
service is installed:

```powershell
schtasks /Create /TN OpenSessionWSL /SC ONLOGON /TR "wsl.exe -d Ubuntu --exec /bin/true" /F
```

If your distribution has a different name, use the value from `wsl -l -q` in
place of `Ubuntu`.

## 1. Install

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash
```

This downloads the compiled release for your OS and architecture and unpacks
it under `~/.opensession/releases` (with `src` linked at it), installs the
`claude` and `codex` CLIs, puts an `opensession` command on your `PATH`, writes
a default configuration (127.0.0.1:3850, a scratch repo, no integrations),
installs and starts the service, and ends with the URL. No questions. If no release is
published for your platform yet it falls back to a source clone; `--source`
forces the git checkout, and `--artifact <path|url>` installs a specific
release tarball. `--advanced` runs the full onboarding wizard instead; replace
an existing configuration later with `opensession onboard --force`. It is safe
to re-run: a release install swaps to the downloaded release, a clean source
checkout fast-forwards, and existing configuration is left untouched unless
you explicitly replace it (with a backup). A fresh install cannot change its
parent shell's `PATH`, so run the profile command it prints or open a new shell
before invoking `opensession` or a newly installed model CLI.

Because this command pipes the installer into Bash, put installer flags after
`bash -s --`:

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --tailscale --caddy
# Multiple flags work too:
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --tailscale --caddy --advanced
```

Useful flags: `--dir <path>` to install elsewhere, `--channel <ref>` to track
a branch or tag, `--advanced` for the wizard, `--org <name>` to set up an org
install, `--tailscale` to install Tailscale, `--cloudflare` to install
`cloudflared`, `--caddy` to install Caddy and the lego certificate helper,
`--no-codex` to skip the ChatGPT sign-in CLI, `--no-engine` to skip both model
CLIs, `--yes` to never prompt, and `--uninstall`
to remove it. `--help` lists them all.

The Pi engine is compiled into the release binary and runs in-process, so
there is no separate engine to seed or version. A release tarball carries the
`opensession` executable, the embedded frontend, `sharp` and Worker sidecars,
three systemd service templates, fixed-policy deploy helpers, and
`release.json`. The subscription paths also need the external `claude` and
`codex` CLIs, which the installer adds by default.

### Install with Tailscale

Authentication is opt-in (see the [trust
model](README.md#trust-model-read-this)). A default install trusts everyone who
can reach it, so the bind address is the access control. It binds `127.0.0.1`
and needs no network software. For remote access, have the Open Session
installer add the Tailscale client plus Caddy and lego for private HTTPS and
friendly custom domains:

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --tailscale --caddy
```

The installer uses Tailscale's Linux installer when passwordless `sudo` is
available. If it reports that `sudo` is needed, run the manual install command
it prints so your terminal can ask for your password. On macOS, install the
client from the [Tailscale download page](https://tailscale.com/download/mac)
instead.

**Installing the client does not join a tailnet.** Without an auth key, finish
setup after the installer returns:

```sh
sudo tailscale up
opensession bind
```

The first command prints a URL where you sign in to Tailscale. The second binds
Open Session to its new tailnet address and restarts the service. Then open
`http://<tailnet-ip>:3850` from another device on the same tailnet.

To join automatically during a fresh Linux install, create a Tailscale [auth
key](https://tailscale.com/kb/1085/auth-keys) and pass it to **Bash**, not to
the `curl` process on the other side of the pipe:

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | TS_AUTHKEY=tskey-auth-... bash -s -- --tailscale --caddy
```

#### Add Tailscale after a normal install

You do not need to reinstall Open Session. On Linux, run:

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
opensession bind
```

On macOS, install and connect the Tailscale app, then run `opensession bind`.
Full walkthrough: [networking.md](networking.md).

### Doing it by hand

This path assumes `bun` is already on `PATH`; install it from
[Bun](https://bun.sh) first if needed.

```sh
git clone https://github.com/tellahq/opensession.git
cd opensession && bun install
bun run setup
```

This manual path does not install model CLIs. Install Claude Code with
`curl -fsSL https://claude.ai/install.sh | bash`; add Codex with
`curl -fsSL https://chatgpt.com/codex/install.sh | sh` if you will use the
ChatGPT sign-in path.

If you plan to use self-development (sessions that modify Open Session itself —
see [../self-development.md](../self-development.md)), clone **your own fork**
instead and add this repo as `upstream`: self-sessions push to `origin`, which
must be a remote you can write to.

```sh
git clone https://github.com/<you>/opensession.git
cd opensession
git remote add upstream https://github.com/tellahq/opensession.git
bun install && bun run setup
```

With that in place, `opensession update` pulls upstream changes into your fork
(merging over your own commits when needed), reinstalls dependencies, and
restarts. It uses the health-gated deploy path when a service is installed and
passwordless `sudo` is available; otherwise it performs a plain service
restart.

A default (release) install updates differently: `opensession update`
downloads the latest published artefact for this OS/arch, unpacks it beside
the current one under `~/.opensession/releases/`, and swaps the `src` symlink
atomically. With a service installed it performs a health-gated restart; if the
new release does not become healthy, it repoints `src` to the previous release
and restarts it. Without a service, restart the foreground server yourself.
The previous release stays on disk. `OPENSESSION_RELEASE_BASE` overrides the
release base URL; `--channel <url>` points at a specific tarball.

A source checkout can live anywhere: the CLI derives its root from the code it
is running, and onboarding writes instance paths into
`~/.opensession/config.json`. If a source install skips onboarding, the default
MCP config is `<checkout>/mcp-config.json`
(`packages/core/opensession-server/src/server/config.ts`) and the checkout
registers itself as a repo.

## 2. Onboarding

`opensession onboard` asks for the bind address and port, your public base
URL, your first repository, and which integrations to turn on. It writes:

| File                         | What                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `~/.opensession/config.json` | instance config, mode `0600`                                                                 |
| `~/.opensession.env`         | secrets and feature flags, mode `0600`                                                       |
| `~/.opensession/pi.json`     | Pi engine config, created as `{"enabled": true}` only when absent ([engines.md](engines.md)) |

If you accept service installation, Linux also gets the user units
`~/.config/systemd/user/opensession.service` and
`opensession-session-kernel.service`, plus
`~/.opensession/session-kernel-token`. macOS gets two LaunchAgents under
`~/Library/LaunchAgents/`, for the gateway and session kernel.

Re-run onboarding with `opensession onboard --force`; existing config and env
files are backed up to `.bak-<n>` before replacement. The Pi setting is
preserved when it already exists.

State created by a fresh installation is grouped under `~/.opensession/`, for
example `sessions/`, `audit/`, `automations/`, and `pi.json`.
Existing top-level paths such as `~/.opensession-sessions` remain supported:
Open Session uses a legacy entry when it exists and the corresponding grouped
path does not. If both exist, the grouped path wins.

Then check the result:

```sh
opensession doctor
```

It reports missing tooling or model capacity, unparseable config, an
integration that is enabled but missing a required credential, a service that
is installed but dead, and whether anything is actually listening. Sections
below are the reference for what it is checking.

## 3. Automations (optional)

A fresh install runs nothing on its own. The repository ships a few generic
starting points:

```sh
opensession automations              # what is available
opensession automations add github-pr-review
opensession restart                  # created on the next boot, disabled
```

`github-pr-review` is the highest-leverage one — a lot of other workflow hangs
off having every PR reviewed automatically. `instance-health` watches this
install's own disk, memory and liveness. Both are offered during onboarding.

Recipes arrive **disabled**: read the prompt, adjust it for your codebase, then
enable it in the UI. Adding one appends to `integrations.seeds.automations` in
your config, and seeding is create-if-absent, so your edits are never
overwritten by a later restart.

Anything specific to your company — your product, customers, people, playbooks
— belongs in that config section rather than in the repository. See
[recipes/README.md](../../recipes/README.md) for the line and for how to write
your own.

## 4. Secrets: `~/.opensession.env`

Use `~/.opensession.env` as the service's secrets file. The rendered systemd
gateway unit loads it with `EnvironmentFile=`; the macOS gateway LaunchAgent
sources it through its launcher. A foreground run does not load this
nonstandard filename automatically, so export it first:

```sh
set -a
. ~/.opensession.env
set +a
opensession start --foreground
```

The server settings are optional, but an enabled integration needs the
credentials its setup page marks as required. Common operator-facing variables:

**Core server**

| Var                         | Default                      | Purpose                                                                                                                                                                                                                         |
| --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`                      | `127.0.0.1`                  | bind address for the main server. Keep loopback behind an identity-gated private tunnel, or bind to a Tailscale IP; never use a public wildcard without authentication (see the [trust model](README.md#trust-model-read-this)) |
| `PORT`                      | `3850`                       | private app server (UI + API at the server root)                                                                                                                                                                                |
| `OPENSESSION_UI_BASE`       | `http://127.0.0.1:<port>`    | private app base used in session links                                                                                                                                                                                          |
| `OPENSESSION_INGRESS_BASE`  | unset                        | public origin for webhooks, remote Sandbox callbacks and workload identity                                                                                                                                                      |
| `OPENSESSION_CONFIG`        | `~/.opensession/config.json` | config-file path override                                                                                                                                                                                                       |
| `SHUTDOWN_DRAIN_MS`         | `10000`                      | graceful-shutdown drain window for in-flight runs; unfinished work resumes from the journal                                                                                                                                     |
| `OPENSESSION_STATE_DIR`     | unset                        | isolated root for instance state; required with `OPENSESSION_DEV=1` unless `OPENSESSION_SESSIONS_DIR` is set                                                                                                                    |
| `OPENSESSION_SESSIONS_DIR`  | `~/.opensession/sessions`    | session store override                                                                                                                                                                                                          |
| `OPENSESSION_WORKTREES_DIR` | `~/.opensession/worktrees`   | where session worktrees are created                                                                                                                                                                                             |
| `OPENSESSION_DEV`           | unset                        | `1` = HMR frontend plus a safe dev boot that skips integrations, public ingress, schedulers, resume, and other live side effects; refuses live state without an isolation override                                              |
| `OPENSESSION_AGENTATION`    | unset                        | `1` = enable the Agentation visual feedback overlay on desktop, non-touch clients                                                                                                                                               |

**Engines and models** (details: [engines.md](engines.md))

| Var                                              | Default                               | Purpose                                                                         |
| ------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------- |
| `OPENSESSION_CLAUDE_BIN`                         | `claude` found on `PATH`              | Claude Code CLI the Anthropic bridge spawns                                     |
| `OPENSESSION_CLAUDE_ACCOUNTS_PATH`               | `~/.opensession/claude-accounts.json` | Claude account store override                                                   |
| `OPENSESSION_PI_CONFIG`                          | `~/.opensession/pi.json`              | Pi engine config path override (primarily a test/verification seam)             |
| `OPENSESSION_MODEL_PROVIDERS_CONFIG`             | `~/.opensession/model-providers.json` | provider API-key config path override (primarily a test/verification seam)      |
| `OPENSESSION_MODEL`                              | `claude-fable-5-1`                    | default model, below the persisted UI override                                  |
| `OPENSESSION_FALLBACK_MODEL`                     | `claude-opus-5`                       | global fallback model; `none` disables                                          |
| `OPENSESSION_HAIKU_FALLBACK_MODEL`               | `gpt-5.6-luna`                        | OpenAI fallback for exhausted Haiku runs and derived one-shots; `none` disables |
| `OPENSESSION_MCP_CONFIG`                         | `<checkout>/mcp-config.json`          | MCP config path override                                                        |
| `SUGGEST_BRANCH_MODEL`, `DRAFT_AUTOMATION_MODEL` | `claude-haiku-4-5`                    | per-feature cheap-task models                                                   |

**Integrations** — each has its own page with the full list:

| Feature                   | Vars                                                                                                                                                                   | Page                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Slack                     | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `ALLOWED_SLACK_USER_ID`, `WORKTREE_HOOK_SECRET`, `SLACK_MENTION_INTENT_MODEL`, `SCHEDULE_WHEN_MODEL`                        | [slack.md](slack.md)                                                                   |
| GitHub                    | App: `OPENSESSION_GITHUB_CLIENT_ID`, `OPENSESSION_GITHUB_CLIENT_SECRET`, `OPENSESSION_GITHUB_APP_SLUG`, `OPENSESSION_GITHUB_APP_KEY`; webhook: `GITHUB_WEBHOOK_SECRET` | [github.md](github.md)                                                                 |
| Linear                    | `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, `LINEAR_API_KEY`                                                                                  | [linear.md](linear.md)                                                                 |
| Plain                     | `PLAIN_API_KEY`, `PLAIN_WEBHOOK_SECRET`, `PLAIN_*_MODEL` ×2                                                                                                            | [plain.md](plain.md)                                                                   |
| Stripe                    | `STRIPE_WEBHOOK_SECRET`                                                                                                                                                | [integrations-misc.md](integrations-misc.md#stripe)                                    |
| Grafana                   | `GRAFANA_URL`, `GRAFANA_SERVICE_ACCOUNT_TOKEN`, `LOKI_DATASOURCE_UID`                                                                                                  | [integrations-misc.md](integrations-misc.md#grafana-poller)                            |
| Voice                     | `OPENAI_API_KEY`, `GROQ_API_KEY`, `WHISPER_CLI`, `WHISPER_MODEL`                                                                                                       | [integrations-misc.md](integrations-misc.md#voice--transcription)                      |
| Sandboxes                 | `E2B_API_KEY`, `OPENSESSION_SANDBOX_CONFIG` (experimental conformance only; supported workspace connections use Settings)                                              | [self-hosting-sandboxes](../self-hosting-sandboxes.md)                                 |
| AWS runs (off by default) | `AGENT_AWS_CREDS`, `AGENT_AWS_REGION`, `AGENT_AWS_MINT_USER`                                                                                                           | [integrations-misc.md](integrations-misc.md#aws-creds-for-runs-agent_aws_region)       |
| Previews                  | `PREVIEW_HOST`                                                                                                                                                         | Caddy-fronted live previews (`packages/core/opensession-server/src/server/preview.ts`) |

**Feature flags** — `ENABLE_SLACK_AGENT`, `ENABLE_LINEAR_AGENT`,
`ENABLE_PLAIN_AGENT`, `ENABLE_GITHUB_AGENT`, `ENABLE_STRIPE_AGENT`,
`ENABLE_GRAFANA_POLLER`, and `ENABLE_CODESTORAGE`. All **default OFF**; only
the literal string `true` enables (not `1`). The env flag wins when set,
otherwise `integrations.<id>.enabled` decides. Changes require a restart. See
[integrations-misc.md](integrations-misc.md#boot-guards).

Not for operators: `OPENSESSION_RPC_*`, `OPENSESSION_RUN_WS_*`,
`OPENSESSION_MCP_SERVER`, and `OPENSESSION_RUN_JOURNAL` are set by Open Session
for runner-host and MCP-proxy subprocesses.

Agent subprocesses do **not** inherit this env file. Runs receive a minimal,
explicit environment; only the run-scoped git identity and credentials that
policy allows are added. MCP servers carry their own credentials
(`packages/core/opensession-server/src/server/pi-runner.ts`).

## 5. `~/.opensession/config.json`

Instance config for structured settings: server addresses, tool paths, the
**repo registry**, the **team identity table**, persona, branding, and
integration-specific options. Some UI-managed integration and storage settings
also place secrets here, so keep the file mode `0600` and never commit it. Copy
[`config.example.json`](../../config.example.json) to
`~/.opensession/config.json` and edit. Every field is optional; where an env
override exists, precedence is env var → config.json → built-in default
(`packages/core/opensession-server/src/server/config.ts`). Most readers pick up
changes without a restart. Restart after changing the listening host or port,
boot-loaded integrations, or paths captured at startup. Settings routes refresh
the frontend bootstrap when needed; equivalent out-of-band edits that affect
bootstrap values also require a restart. See [instance
configuration](../instance-configuration.md) for portability boundaries and
client-distribution settings.

The two sections a team install normally sets:

- `repos` — your git repos (checkout path, `defaultBranch`, `ghRepo`
  owner/name for the `gh` CLI, `default: true` on the main one, optional
  `depsInstall`/`previewCommand`, preview cache markers, deployment tracking,
  and security-scan guidance). When `repos` is present it is authoritative.
  With no config, a source checkout registers itself as the shared
  `opensession` repo.
- `identity.team` — your people (name, email, aliases, `slackId`, `github`,
  `linearEmails`). Drives commit attribution, per-user MCP `allowedUsers`
  gating, and human-ask routing. Omitting it leaves the roster empty and makes
  identity-dependent features no-op.

Integrations are opt-in with `integrations.<name>.enabled` and require a
restart when their boot state changes. The optional `integrations.seeds`
section can create deployment-owned automations without putting company
playbooks in application source. `policy`, `persona`, and `branding` are
runtime configuration; frontend branding, the default repo id, public URL, and
GitHub bot identities are also injected into the SPA bootstrap.

## 6. Model capacity

The default `claude-fable-5-1` model needs a Claude subscription account. Mint a
token on a Claude Max login:

```sh
claude setup-token   # prints sk-ant-…
```

With the server running, open **Workspace → Providers** and paste the token.
The same page can sign in a ChatGPT-plan or SuperGrok account by device code,
or add a third-party provider API key and select one of its models.
Subscription account stores live at `~/.opensession/claude-accounts.json`,
`~/.opensession/codex-accounts.json` and `~/.opensession/xai-accounts.json`;
provider keys live at
`~/.opensession/model-providers.json`. All are server-managed mode-`0600`
files, so use the UI rather than hand-editing them. The exception is a custom
OpenAI-compatible gateway's per-model catalog, which is hand-written and
preserved across Settings writes. Pi configuration, including custom providers
and catalogs, is covered in [engines.md](engines.md).

## 7. `mcp-config.json`

MCP servers give runs their external tools. Copy
[`mcp-config.example.json`](../../mcp-config.example.json) to
`mcp-config.json` in the repo root (or point `OPENSESSION_MCP_CONFIG`
elsewhere). Per server: `{ "type": "http", "url": … }` or
`{ "command": …, "args": [], "env": {} }`. Credentials belong to that
server's `env`, headers, URL, or managed OAuth grant, never the Open Session
process environment. `mcp-config.json` is gitignored; if it contains inline
credentials, keep it mode `0600`. Two Open Session-specific fields:

- `allowedUsers: ["Alice", "alice@example.com"]` — optional per-user gate;
  only runs whose prompter or interactive-session creator matches through the
  identity table see the server. Automation runs carry neither gate identity,
  so restricted servers are invisible to them (fail-closed). The field is
  stripped before the config reaches the engine.
- The `linear` server gets the Linear agent's OAuth token overlaid at run
  time ([linear.md](linear.md)).

Manage servers later from the Connections UI. **Changing the runner-layer
filtering code requires a restart; editing mcp-config.json itself is read
fresh per run.**

## 8. First run

The default installer has already started the service:

```sh
opensession status
curl -fsS http://127.0.0.1:3850/api/health
```

If you declined service installation or have no supported supervisor, source
`~/.opensession.env` as shown in [section 4](#4-secrets-opensessionenv), then
run `opensession start --foreground`. Do not start a second foreground server
on the same port as the installed service.

Health returns `ok`, `bootId`, `frontendVersion`, `uptime`, `activeRuns`,
`executor`, `sessionKernel`, `agents`, and `system`. Agent entries include
per-agent status and missing credentials. The drain-aware deploy uses
`activeRuns` to avoid restarting the gateway mid-run where possible.

## 9. Running it as a service

Onboarding installs and starts the service by default; these are for a box
where you said no, or to move between scopes.

```sh
opensession service install            # user-scope unit / LaunchAgent, no root
opensession service install --system   # /etc/systemd/system unit (sudo)
opensession service uninstall
opensession status
opensession logs -f
```

On Linux the default is a pair of **user** units under
`~/.config/systemd/user`: the gateway and the independently supervised session
kernel. `loginctl enable-linger` keeps the user manager and services alive
after logout and across reboot. It needs no root on distributions that allow
`set-self-linger`; where policy requires an administrator, the command prints
the one-time `sudo loginctl enable-linger <user>` step. `status`, `stop`,
`restart`, and `logs` use the installed scope automatically. Rootless mode
disables the executor and detached turns, so model turns run inside the gateway
process.

`--system` is the hardened operator path. It installs three system units:
`opensession.service` for the HTTP/WebSocket gateway,
`opensession-session-kernel.service` for authoritative durable session
decisions, and `opensession-executor.service` for fixed-policy detached
run-host launch. It also installs credentials and the root-owned run-host
helper. The gateway requires the kernel and only wants the executor. Restarting
the executor alone does not drop browser sockets, session state, or active run
hosts. See [executor architecture](../executor-architecture.md).

On macOS two per-user **LaunchAgents** supervise the gateway and session kernel.
The Linux executor and systemd run-host helper do not apply there.

On EC2 and other cloud instances, the installer refuses to install or start
the user service while 169.254.169.254 is reachable. Rootless agents could use
that metadata endpoint to obtain the instance's role credentials. The failure
prints the exact uid-scoped `iptables` rule. Apply that host firewall rule and
rerun the same installation command. Only on an instance with no cloud role
credentials to protect, rerun with `OPENSESSION_ALLOW_IMDS=1` to explicitly
skip the check. The installer exits nonzero at this point instead of presenting
the configured but stopped server as a partly successful installation. See
[integrations-misc.md](integrations-misc.md#aws-creds-for-runs-agent_aws_region).

The repo's `opensession.service`, `opensession-session-kernel.service`, and
`opensession-executor.service` are templates, not files to copy verbatim.
`opensession service install` rewrites the selected scope for this box. User
rendering drops `User=`, makes the gateway env file optional, targets
`default.target`, removes the system-only executor dependency and credential,
and disables detached execution. System rendering verifies the username,
stamps all three units, and installs the credentials and helper.
`os.userInfo()` can return the literal string `"unknown"` under a non-login
shell, so installing an unchecked username would fail later with
`status=217/USER`.

On Tella's own deployment the units are copies, not symlinks. The deployment
script syncs changed templates and reloads systemd automatically
([`deploy/deploy.sh`](../../deploy/deploy.sh)).

Unit choices worth knowing (comments in the file itself):

- `ExecStart` uses the stable installed shim for compiled releases and Bun for
  source installs.
- The gateway's `EnvironmentFile=<your home>/.opensession.env` loads your
  secrets. It is optional in user scope and required in system scope.
- System scope loads separate executor and session-kernel credentials. User
  scope keeps its session-kernel token under `~/.opensession/` and disables the
  executor and detached runs.
- `TimeoutStopSec=80` covers the 10-second run drain plus bounded agent shutdown
  hooks; reducing it to the drain value can make systemd SIGKILL mid-shutdown.
- `KillMode=mixed`: SIGTERM hits only the gateway process so it can drain
  in-flight runs; the default control-group mode would kill model children
  instantly and defeat the run journal.
- `IPAddressDeny=169.254.169.254/32` (system scope) blocks the EC2 metadata
  endpoint for the whole service cgroup (untrusted agent text must not mint
  cloud credentials). Harmless off-cloud.
- `User`, `WorkingDirectory`, `EnvironmentFile`, `ExecStart` and `PATH=` are
  rewritten per box by `opensession service install`; the values checked into
  the repo are Tella's.

## 10. Frontend rebuilds vs restart

The production unit intentionally does not use `bun --hot`: failed backend
reloads on Bun 1.3.14 can permanently stop timer delivery while HTTP remains
healthy. On a **source install**, the in-process frontend watcher still rebuilds
frontend edits live; backend changes need `opensession restart` after commit
and push. A **compiled release** serves an embedded prebuilt frontend and has no
source watcher, so update to a newly built release instead of editing it in
place.

On Linux system scope, detached run hosts survive a gateway restart and the run
journal reattaches them. User-scope Linux and macOS turns run in the gateway;
they get the graceful drain window but are not detached across a restart.
An executor-only operational restart does not drop browser sockets, session
state, or active hosts, but the immutable source-release deploy paths roll out
the executor, kernel, and gateway as one version. On a direct-checkout source
install, restart once after a backend change rather than after every save.

## 11. Next

- Wire up integrations: [slack.md](slack.md), [github.md](github.md),
  [linear.md](linear.md), [plain.md](plain.md),
  [integrations-misc.md](integrations-misc.md). Inbound webhooks all land on
  Public ingress — see below.
- Sandboxed execution: [../self-hosting-sandboxes.md](../self-hosting-sandboxes.md).

## Public ingress

`packages/core/opensession-server/src/server/public-ingress.ts` binds the one
fail-closed public gateway on `127.0.0.1:3860`. Integrations register exact
webhook and OAuth methods and paths into it; the same listener owns remote
Sandbox WebSockets and workload identity. Everything else returns 404,
including all private app/API routes.

Choose Cloudflare Tunnel or Direct HTTPS with Caddy in **Settings → Domains and
ingress → Public callbacks**. These are alternatives for the same restricted
endpoint. All provider signature checks
remain fail-closed: a missing secret rejects the webhook rather than allowing
unsigned intake.
