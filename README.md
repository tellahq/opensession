# Open Session

Self-hosted agent-infrastructure server: a web UI plus Slack, Linear, Plain,
and GitHub agents, driving coding sessions through the Pi engine in git worktrees on your own box, or in isolated
sandboxes.
Supports multiple Codex and Claude subscriptions and model APIs.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/readme-hero-roomy-dark.webp">
  <img alt="Open Session on desktop and phone: a session that added multiplayer workspace presence and opened a pull request" src="docs/readme-hero-roomy-light.webp">
</picture>

<br>

_More: [pull-request review, diffs, automations, mobile →](docs/screenshots.md)_

## Quickstart

Run this on Linux, macOS, or inside WSL2 on Windows. The server does not run
directly from PowerShell; follow the
[Windows WSL2 setup](docs/setup/install.md#windows-run-the-server-in-wsl2)
first.

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash
```

The recommended install also adds Tailscale, Caddy and
the lego certificate helper so the private app can use HTTPS or a friendly
custom domain.

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --tailscale --caddy
```

For public ingress through Cloudflare Tunnel instead of Tailscale, `--cloudflare` installs
`cloudflared`. Finish configuring either option under Settings → Domains and
ingress.

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --cloudflare
```

Already installed Open Session? You do not need to reinstall it. Follow [Add
Tailscale after a normal
install](docs/setup/install.md#add-tailscale-after-a-normal-install).

On a fresh box this downloads the compiled release for your OS and
architecture, unpacks it under `~/.opensession`, installs the `claude` CLI,
puts an `opensession` command on your `PATH`, writes a default configuration,
and installs and starts a per-user service (a LaunchAgent on macOS, a `systemd
--user` unit on Linux). No questions. The last line it prints is a local URL,
by default <http://127.0.0.1:3850>. Budget 5 to 15 minutes, mostly unattended
download.

Open the URL, add a model account in Workspace → Providers, pick a repo, write
a prompt, and create the session. A turn that actually runs is the proof the
install works, not a health check. Connect your GitHub account later from
Settings → Connections. Configure Slack, Linear, Plain, GitHub agent intake,
and other integrations under Settings → Integrations; see
[docs/setup/github.md](docs/setup/github.md).

Check on it any time:

```sh
opensession doctor     # verify the install and report engine readiness
opensession status     # is the service up?
opensession update     # upgrade in place, health-gated
opensession --help     # everything else
```

The installer and updater verify each Open Session release archive against its
published SHA-256 sidecar before extracting it. GitHub also signs keyless build
provenance for every release archive, DMG, and ZIP. To verify a manually
downloaded artifact:

```sh
gh attestation verify ./opensession-linux-x64.tar.gz --repo tellahq/opensession
sha256sum --check ./opensession-linux-x64.tar.gz.sha256
```

Use `shasum -a 256 -c` instead of `sha256sum --check` on macOS.

Or install from a source checkout instead. This is the path for
self-development (sessions that modify Open Session itself) and for
contributing:

```sh
git clone https://github.com/tellahq/opensession.git
cd opensession && bun install
bun run setup                             # interactive onboarding
```

`bun run setup` runs the interactive onboarding wizard, writes the
configuration, and offers to install and start a user service. For unattended
defaults, run `bun scripts/cli.ts onboard --defaults`. Run
`bun scripts/cli.ts --help` for CLI commands. Options such as `--source`,
`--dir`, `--channel`, `--tailscale`, and `--no-engine` belong to `install.sh`;
run `bash install.sh --help` for the complete installer list. A source checkout
requires Bun and git.

> Letting the agent improve Open Session itself? Clone your fork, not this
> repo. Self-sessions commit and push to `origin`, and `deploy_self` advances
> the pinned runtime to a descendant commit from it. Pointed at
> `tellahq/opensession`, every push is rejected. Fork, clone the fork, and keep
> us as an `upstream` remote. Config-only use (your repos, your integrations)
> needs no fork.

> Authentication is available, and it is opt-in. By default, Open Session
> trusts everyone who can reach the address it binds to. GitHub sign-in can
> restrict access to configured team members. Keep the server on Tailscale, a
> private network, or behind an SSH tunnel even when sign-in is enabled. See
> the [trust model](docs/setup/README.md#trust-model-read-this) and
> [networking.md](docs/setup/networking.md).

## Docs

- [CONCEPTS.md](CONCEPTS.md) — projects, workspaces, chats, automations, goals
- [docs/setup/](docs/setup/README.md) — overview, requirements, trust model
- [docs/setup/install.md](docs/setup/install.md) — bare box → running service
- [docs/setup/ec2.md](docs/setup/ec2.md) — provisioning a clean EC2 box
- [docs/setup/networking.md](docs/setup/networking.md) — private team access,
  public callbacks, domains, and TLS
- [CLIENTS.md](CLIENTS.md) — web UI, PWA, desktop shell, native app, extension
- [docs/worktrees.md](docs/worktrees.md) — how sessions map to git worktrees,
  and where the disk goes
- [docs/repo-lifecycle.md](docs/repo-lifecycle.md) — the `.agents/` lifecycle
  scripts a repo commits so sessions provision and boot it themselves
- [docs/extending.md](docs/extending.md) — adding tools, recipes, integrations
  and providers
- [docs/security-model.md](docs/security-model.md) — least-privilege
  automations, per-user MCP/GitHub scoping, self-management boundaries
- [docs/self-hosting-sandboxes.md](docs/self-hosting-sandboxes.md) — certified
  Docker, Daytona, Box, Modal, and local Firecracker MicroVM sandboxes;
  implemented E2B and AWS Lambda MicroVM adapters remain unavailable until
  live-certified
- [docs/instance-configuration.md](docs/instance-configuration.md) — repos,
  identity, branding, integrations, deployment policy

## Clients

One server, five front ends — only the web UI is required, and everything else
talks to the same instance. [CLIENTS.md](CLIENTS.md) has the full tour.

| Client                                    | Where                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Web UI                                    | served by the server itself — start here                                                                      |
| PWA                                       | the web UI on your phone's home screen (iOS push notifications require the installed PWA and an HTTPS origin) |
| macOS desktop shell (Electron)            | [`packages/clients/mac/`](packages/clients/mac/)                                                              |
| Native Swift app (iOS + macOS)            | [`packages/clients/ios/`](packages/clients/ios/)                                                              |
| Chrome extension (page context → session) | [`packages/clients/chrome/`](packages/clients/chrome/)                                                        |

## Make it your own

Everything company-specific is instance configuration, not source — branding,
the agent's name and persona, your repositories, integrations, automations
([docs/instance-configuration.md](docs/instance-configuration.md)). Point a
stock install at your config and it becomes your company's agent server. No
fork needed for that.

Forking is welcome — recommended, even — when you want to change what it _is_,
not just whose it is: strip the integrations you'll never use, rebrand the
client apps to your own bundle ids, hard-code opinions we left configurable.
It's MIT, so you owe nothing but the license notice.

## Repository layout

Product code lives under `packages/`:

- `packages/core/opensession-server/` — Bun server, web client, runner host
- `packages/core/protocol/` — shared wire and record contracts
- `packages/clients/` — Chrome, native Swift, Electron, and website clients

Repository-level scripts, deployment files, documentation, the workspace
manifest, and the lockfile stay at the root.

## Contributing

We take contributions as human-written text, not code — see
[CONTRIBUTING.md](CONTRIBUTING.md). Open a
[GitHub issue](https://github.com/tellahq/opensession/issues) describing the
change you'd like — a prompt or suggestion in plain language is exactly the
right shape — and if we're aligned we'll handle the implementation. Report
vulnerabilities privately — see [SECURITY.md](SECURITY.md), not a public
issue.

## License

[MIT License](LICENSE). Use it, fork it, run it commercially, build on
it — the only obligation is keeping the copyright and permission notice.
Contributions are accepted under the same license.
