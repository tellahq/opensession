# Open Session

Self-hosted agent-infrastructure server: a web UI plus Slack, Linear, Plain,
and GitHub agents, driving coding sessions through the OpenCode engine
(any model provider) in git worktrees on your own box, or in isolated
sandboxes — Docker locally, with pluggable adapters for other providers.

![The Open Session session view: a running agent turn with its tool calls, next to the workspace sidebar](docs/screenshot.png)

*More: [pull-request review, diffs, automations, mobile →](docs/screenshots.md)*

## Quickstart

Run this on Linux, macOS, or inside WSL2 on Windows. The server does not run
directly from PowerShell; follow the
[Windows WSL2 setup](docs/setup/install.md#windows-run-the-server-in-wsl2)
first.

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash
```

Installs Bun, the OpenCode engine, the `claude` and `codex` CLIs, and the
Tailscale client if you do not have them, clones the source to
`~/.opensession/src`, puts an `opensession` command on your `PATH`, and walks
you through configuration. Budget 5-15 minutes on a fresh box — mostly
unattended download and dependency install.

```sh
opensession start      # run it
opensession doctor     # check the install
opensession update     # pull, reinstall, restart
opensession --help     # everything else
```

Or run it straight from a checkout:

```sh
git clone https://github.com/tellahq/opensession.git
cd opensession && bun install
bun run setup                             # same wizard, without the installer
```

> **Letting the agent improve Open Session itself?** Clone your **fork**, not
> this repo. Self-sessions commit and push to `origin` (and `deploy_self`
> fast-forwards from it) — pointed at `tellahq/opensession` every push is
> rejected and, once you've self-modified, updates from us stop fast-forwarding.
> Fork, clone the fork, and keep us as an `upstream` remote for pulling
> updates. Config-only use (your repos, your integrations) needs no fork.

With no flags it writes a default configuration, installs and starts the
service, and ends with the URL; `--advanced` runs the full onboarding wizard.
It also accepts `--dir`, `--channel <ref>`, `--tailscale`, `--codex`,
`--no-engine`, `--no-modify-path`, `--yes` and `--uninstall`; `--help` lists
them all.

### Or paste this into an agent

You're installing agent infrastructure — let an agent install it. Paste this
into Claude Code (or any coding agent) running on the box you want it on:

```text
Set up Open Session (https://github.com/tellahq/opensession) on this machine
for me. Go step by step and ask me one question at a time before acting.

1. Check the basics: OS, git, whether ~/.opensession already exists.
2. Install:
   curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --advanced
   Ask first whether I want Tailscale (--tailscale to add it).
3. Walk me through the onboarding wizard it starts: a product name, the bind
   address and port, which git repo I want agent sessions on, and which
   integrations to enable (Slack, GitHub, Linear, Plain, Stripe — all
   optional, all can wait).
4. Model accounts: help me add a Claude subscription token (`claude
   setup-token` on a Max login) and/or a ChatGPT-plan Codex login. The
   installer put both CLIs on this box already.
5. Networking: keep it on 127.0.0.1 unless I pick Tailscale or an SSH
   tunnel. Never expose it publicly — there is no built-in auth.
6. Finish: `opensession start`, then `opensession doctor` until clean, and
   give me the URL to open.
7. Verify it really works: open the UI, create a session on my repo with a
   real prompt, and confirm the agent completes a turn. If the turn errors,
   fix that before telling me you are done — that is where installs fail.

Details are in docs/setup/ in the repo — read them when unsure.
```

Then read the real setup guide — secrets, accounts, integrations, systemd:

- **[CONCEPTS.md](CONCEPTS.md)** — the core model: projects, workspaces, chats,
  automations, goals and how they fit together
- **[docs/setup/](docs/setup/README.md)** — overview, requirements, trust model
- [docs/setup/install.md](docs/setup/install.md) — bare box → running service
- [docs/setup/ec2.md](docs/setup/ec2.md) — provisioning a clean EC2 box
- [docs/local-profile.md](docs/local-profile.md) — single-user macOS companion
  to a hosted instance (it signs in against one, so it is not a first install)
- [docs/setup/networking.md](docs/setup/networking.md) — Tailscale, a custom
  domain, and verifying you are not public
- [CLIENTS.md](CLIENTS.md) — web UI, PWA, desktop shell, native app,
  Chrome extension
- [docs/nodes.md](docs/nodes.md) — attaching another machine as an
  execution node (`opensession connect`)
- [docs/worktrees.md](docs/worktrees.md) — how sessions map to git worktrees,
  and where the disk goes
- [docs/repo-lifecycle.md](docs/repo-lifecycle.md) — the `.opensession/`
  scripts a repo commits so sessions provision and boot it themselves (and
  agents can test their changes in a real browser)
- [docs/extending.md](docs/extending.md) — adding tools, recipes, integrations
  and providers
- [docs/security-model.md](docs/security-model.md) — least-privilege
  automations, per-user MCP/GitHub scoping, and the self-management tool
  boundaries
- [docs/self-hosting-sandboxes.md](docs/self-hosting-sandboxes.md) — isolated
  Docker/Daytona/E2B/Box/Modal/AWS Lambda MicroVM execution for sessions

> **No built-in authentication.** Open Session trusts everyone who can reach the
> address it binds to. Keep it on Tailscale, a private network, or behind an SSH
> tunnel — never expose it publicly. See the
> [trust model](docs/setup/README.md#trust-model-read-this), and
> [networking.md](docs/setup/networking.md) for how to set that up.

Repositories, identity, branding, public URLs, integration enablement,
deployment policy, client endpoints, and automation seeds are
instance configuration
([docs/instance-configuration.md](docs/instance-configuration.md)). The source
defaults to a local, single-repository Open Session install.

## Clients

One server, five front ends — only the web UI is required, and everything else
talks to the same instance. See **[CLIENTS.md](CLIENTS.md)** for the full
tour and which to pick.

| Client | Where |
| --- | --- |
| Web UI | served by the server itself — start here |
| PWA | the web UI on your phone's home screen (iOS push notifications) |
| macOS desktop shell (Electron) | [`os1-mac/`](os1-mac/) |
| Native Swift app (iOS + macOS) | [`os1-ios/`](os1-ios/) |
| Chrome extension (page context → session) | [`os1-chrome/`](os1-chrome/) |

## Make it your own

Everything company-specific is instance configuration, not source — branding,
the agent's name and persona, your repositories, integrations, automations
([docs/instance-configuration.md](docs/instance-configuration.md)). Point a
stock install at your config and it becomes your company's agent server: your
repos, your Slack, your name on the agent. No fork needed for that.

Forking is welcome — recommended, even — when you want to change what it *is*,
not just whose it is: strip the integrations you'll never use, rebrand the
client apps to your own bundle ids, hard-code opinions we left configurable.
It's MIT, so you owe nothing but the license notice. And if your change
would help everyone, propose it upstream — see below.

## Contributing

We take contributions as human-written text, not code — see
[CONTRIBUTING.md](CONTRIBUTING.md). Describe the change you'd like informally
in a `.txt` or `.md` file in [`adrs/`](adrs/), and if we're aligned we'll
handle the implementation. Report vulnerabilities privately — see
[SECURITY.md](SECURITY.md), not a public issue.

## License

[MIT License](LICENSE). Use it, fork it, run it commercially, build on
it — the only obligation is keeping the copyright and permission notice.
Contributions are accepted under the same license.
