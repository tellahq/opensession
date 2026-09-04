# `opensession-runner` image

The reference runner environment: the tool versions and absolute paths every
Sandbox reproduces. Sandboxes (Daytona, Box; operator guide:
`docs/self-hosting-sandboxes.md`) do not run this image directly. Their
bootstrap (`src/server/sandbox/adapters/bootstrap.ts`) installs the same
payload into the provider's base VM and keeps its pins aligned with the
Dockerfile, so a run behaves identically on the host, in the published image,
and inside a Sandbox.

## What it contains

| Component                         | Purpose                                                                                                                                                                                        | Pin                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `bun`                             | runs the runner bundle + Bun `$` exec                                                                                                                                                          | `1.4.0` (host)                                    |
| Node.js LTS                       | native-dep builds, tooling                                                                                                                                                                     | `24.x`                                            |
| `git`, `gh`                       | clone / status / diff / push / PR                                                                                                                                                              | apt latest                                        |
| `ripgrep`                         | @-mention file search                                                                                                                                                                          | apt                                               |
| `python3`, `build-essential`      | workspace `bun install` native deps                                                                                                                                                            | apt                                               |
| `just`, `direnv`, `lsof`          | common repo dev-server bring-up chains (Portals)                                                                                                                                               | apt / pinned release                              |
| Claude Code CLI                   | baked at the identical host CLI path for session-resume parity                                                                                                                                 | `2.1.218` (host); build FAILS on version mismatch |
| runner bundle                     | `/home/ubuntu/projects/opensession`: root manifests, lockfile, patches and `tsconfig.json`; copied protocol and server packages; `scripts/workload-identity-client.ts`; installed dependencies | from lockfile                                     |
| minimal `~/.claude/settings.json` | so `settingSources:["user"]` doesn't error                                                                                                                                                     | `{}`                                              |

Runs as uid **1000** user `ubuntu` (matches the host uid). Default `CMD` is
`sleep infinity`; there is no baked ENTRYPOINT.

## Why path parity matters

The runner config points at host absolute paths: the claude CLI at
`/home/ubuntu/.local/bin/claude` and the runner bundle at
`/home/ubuntu/projects/opensession`. The image and the Sandbox bootstrap
reproduce every one of those absolute paths exactly. If any drifts, the
in-sandbox runner can't find the CLI or its dependencies. Do not "tidy" these
paths.

## Build

```sh
deploy/sandbox/build.sh
```

Tags `opensession-runner:latest` and `opensession-runner:<git-sha>` from the
repo root context. Override the name with `IMAGE=... deploy/sandbox/build.sh`.
`.github/workflows/sandbox-release.yml` publishes and signs the release image.

Version pins are Dockerfile `ARG`s: `BUN_VERSION`, `CLAUDE_VERSION`,
`NODE_MAJOR`, and `JUST_VERSION`. Keep them aligned with
`bootstrap.ts`'s pins; the remote bootstrap treats a pin change as a reason to
re-bootstrap every Sandbox.

## Verification

`deploy/sandbox/conformance.ts` is the live provider certification matrix:

```sh
bun run deploy/sandbox/conformance.ts [daytona] [box]
```

It redirects every store to a scratch directory before importing server code,
creates sbxtest-labeled sandboxes, proves ensure/reuse, exec semantics,
in-sandbox workspace git, Portal exposure, a real engine round trip, snapshot
publication and adoption, sleep/wake, and destroy, then audits the provider
account for leftovers. Credentials are read from the live connection store
and only ever written to the scratch config.

`deploy/sandbox/opensession` is the in-sandbox CLI shim installed at
`~/.local/bin/opensession`; today it exposes `sandbox id-token` for workload
identity exchange.
