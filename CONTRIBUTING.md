# Contributing

Thanks for looking. Open Session is a self-hosted agent-infrastructure system.
A Bun gateway serves the web UI and integrations, while an independently
supervised session-kernel service owns session state. System-scope Linux installs
also use a separate executor service. Agent turns run in detached hosts against
worktrees or sandboxes.

## How contributions work

We take contributions as **human-written text, not code**. Describe the change
you'd like — a bug, a missing feature, a design objection — informally in a
[GitHub issue](https://github.com/tellahq/opensession/issues). Prompts and
suggestions are exactly the right shape: say what you'd want, the way you'd
tell an agent. If we're aligned, we handle the implementation (this is an
agent-infrastructure project; implementation is what the infrastructure is
for). Your name stays on the issue.

Plain language beats a spec. Say what's wrong or missing, what you'd expect to
happen instead, and why it matters to you. A paragraph is enough. For bug
reports, include what you ran, what happened, and `opensession doctor` output;
if it is an install problem, the full installer output — it prints every step
it took.

One thing that should _not_ go through the issue tracker:

- **Vulnerabilities** — report privately, see [SECURITY.md](SECURITY.md).
  Never a public issue.

Code pull requests aren't the path for outside contributions — forking is.
The project is MIT-licensed and built to be made your own: instance config
covers branding, persona, repos and integrations without touching source
(see [Make it your own](README.md#make-it-your-own)), and a fork covers
everything else. The rest of this document is for people doing exactly that.

## Getting set up

```sh
git clone https://github.com/tellahq/opensession.git
cd opensession
bun install
bun run setup          # writes ~/.opensession/config.json and ~/.opensession.env
```

`bun run setup` offers to install and start the service. If you accept, open the
URL it prints. If you decline, run `bun run opensession start --foreground`.
Do not invoke `opensession.ts` directly unless you separately start and configure
the session-kernel service.

You need [Bun](https://bun.sh) and `git`. Everything else is optional until you
touch the feature that needs it — `gh` for pull-request work, the bundled Pi runtime for agent turns, and Docker
only if you are working on sandboxes.

The UI comes up at `http://127.0.0.1:3850`. There is no login by default; see
[the trust model](docs/setup/README.md#trust-model-read-this) before binding it
anywhere but loopback.

## Verifying your changes

```sh
bun run typecheck
bun run lint
scripts/test-unit-isolated.sh # the broad opensession-server/src and scripts sweep
bun run test:snapshots       # the run-pipeline fixtures
```

The broad unit suite runs each test file in its own process, four at a time, so
fixtures that replace environment variables, globals, or module-level stores do
not leak into later files. Run focused tests for the area changed as well.
Deployment tests live under `deploy/`, and shared protocol tests under
`packages/core/protocol/src/`.

The snapshot suite keeps its own command because it exercises the run-pipeline
fixtures as end-to-end transcript scenarios with a dedicated harness. See
[transcript snapshots](docs/transcript-snapshots.md).

CI gates type-checking, lint, the broad unit suite, the focused session-ownership
and executor suite in [`.github/workflows/ci.yml`](.github/workflows/ci.yml), transcript snapshots,
Linux and macOS installer jobs, and Windows runner checks. If you touched
`install.sh`, the CLI or the service definitions, the installer jobs matter:
they catch things unit tests cannot, like a `PATH` that works interactively and
not from a script.

## Things that will surprise you

**Backend changes need a real restart.** The in-process watcher rebuilds the
frontend live, but nothing reloads the server. Gateway or session-kernel changes
need `opensession restart`; a bare `systemctl restart opensession` does not
restart the kernel. Executor changes on a system-scope Linux install need
`sudo systemctl restart opensession-executor`. If running in the foreground,
stop and relaunch `bun run opensession start --foreground`.

**`bun --hot` is deliberately not used in production.** On Bun 1.3.14 a failed
reload can permanently stop timer delivery while HTTP keeps serving, which
looks like "sessions are running but never progress".

**Integrations are declared, not hand-wired.** Adding one means appending an
entry to `packages/core/opensession-server/src/server/integrations/registry.ts` — config key, env flag,
credentials, constructor. `loadIntegrations()` loops over that array; you should
not need to touch `opensession.ts`. The array order is boot order, because
agents register webhook routes in sequence.

**Automations are per-instance data, not source.** Anything specific to one
company's product, customers or people belongs in that instance's config. The
repository ships only generic recipes — see
[recipes/README.md](recipes/README.md) for where the line is.

## Code style

Match the file you are editing. The codebase is fairly consistent about this,
and consistency beats any individual preference.

Comments should explain _why_, particularly when the code looks odd. A lot of
the stranger-looking decisions here encode a specific incident — `KillMode=mixed`
in the systemd unit, the `IPAddressDeny` line, the deny-before-allow ordering in
permission maps. If you find one of those and it has no comment, adding the
explanation is a genuinely useful contribution (as an issue, per above).

Prefer deleting to adding. If a change makes something simpler, say so; that is
not a small thing.

## Security

Agent runs process untrusted text — customer tickets, pull-request diffs, issue
bodies. The rule is that constraints are enforced at the tool and environment
layer, never in a prompt:

- automation local tools receive a minimal, explicitly constructed environment;
  they do not inherit the full server environment or `~/.opensession.env`.
  Eligible runs may receive repository-scoped GitHub credentials for trusted
  GitHub code workflows, short-lived AWS credentials for host automations, or
  operator-enabled Claude or Codex CLI credentials
- automations may define an `mcpServers` allowlist. Sandbox automations require
  an explicit list, including `[]` for none. An omitted list on a host
  automation exposes all configured MCP servers, so set it for least privilege
- customer-facing and identity-mutating tools are hard-denied for unattended runs
- money-moving tools are stripped from the model's tool list entirely

If a suggestion touches any of that, call it out explicitly. If you find a way
around it, report it privately — see [SECURITY.md](SECURITY.md), which also
sets out what counts as a vulnerability here and what is working as designed.

## License

By contributing — issues and suggestions included — you agree that your
contributions are licensed under the [MIT License](LICENSE), the same license
as the project.
