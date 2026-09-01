# Single-executable build (`bun build --compile`)

The default simple-mode artefact centres on an executable built with
[`bun build --compile`](https://bun.com/docs/bundler/executables). It dispatches
all seven process roles from one argv and embeds the prebuilt frontend. The
release adds Worker and native sidecars beside that executable. It boots and
serves the UI with no runtime interpreter on `PATH`; Anthropic turns still
require the `claude` CLI, and the ChatGPT path requires `codex`. The Pi engine
and its Anthropic bridge are compiled in and run in-process. The `--source` install (a
git checkout + `bun install`) stays as the self-development and contributor
path.

## Build

```bash
# Full release: target binary, sharp sidecar, four Worker sidecars, three
# service templates, deploy policy/helper files and release.json, tarred.
bun scripts/build-compile.ts --os linux --arch arm64 --out ~/.cache/opensession-release

# Local host build: binary plus all four Worker sidecars in dist/. Omits sharp,
# service templates, deploy files and release.json.
bun scripts/build-compile.ts --outfile dist/opensession
```

The script builds the production frontend into `.frontend-dist`, bakes its
assets into the binary, then compiles
`packages/core/opensession-server/src/main.ts` with `sharp`, `@img/*` and the
build-only React compiler marked external. It then restores
`packages/core/opensession-server/src/server/embedded-frontend.ts` to its stub.

The executable and sharp sidecar are target-specific, but the build can run on
another host. `--os` and `--arch` select `bun-<os>-<arch>` and fetch sharp's
optional packages for that target. The Worker sidecars are bundled JavaScript
and are platform-neutral.

## One binary, seven process roles

A compiled install has no `bun`/`.ts` tree to re-exec, so
`packages/core/opensession-server/src/main.ts` dispatches a leading subcommand
to these source entrypoints:

| Invocation                             | Runs                                  | Source entrypoint                                                         |
| -------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| `opensession server`                   | HTTP/WS gateway                       | `packages/core/opensession-server/opensession.ts`                         |
| `opensession runner-host <spec>`       | detached agent run                    | `packages/core/opensession-server/src/runner-host/host.ts`                |
| `opensession mcp-proxy`                | stdio↔RPC MCP proxy                   | `packages/core/opensession-server/src/runner-host/mcp-proxy.ts`           |
| `opensession executor`                 | supervised executor launcher          | `packages/core/opensession-server/src/executor/main.ts`                   |
| `opensession session-kernel-service`   | supervised session-kernel service     | `packages/core/opensession-server/src/session-kernel-service.ts`          |
| `opensession transcript-search-worker` | read-only transcript search worker    | `packages/core/opensession-server/src/server/transcript-search-worker.ts` |
| `opensession <anything else>`          | CLI (`onboard`, `start`, `doctor`, …) | `scripts/cli.ts`                                                          |

`packages/core/opensession-server/src/runner-host/exe.ts` supplies compiled and
source argv helpers. `isCompiledBinary()` (execPath basename ≠ `bun`) selects
the re-exec and Worker paths.

## Embedded vs external

**Embedded in the binary** (via `Bun.embeddedFiles` / `import … with { type:
"file" }`): an instance-neutral index shell, bundle metadata, hashed
JS/CSS/wasm, PNG app assets, sign-in WebP/MP4 media, splash images,
`mac-app-icon.png` and `sw.js`. In compiled mode `isPrebuiltFrontend()` is true:
the server serves these assets and skips the in-process frontend build and file
watcher.

At boot, `renderIndexHtml()` stitches the running install's product name, mark,
persona, public and webhook URLs, default repo and related instance settings
into the neutral shell. Identity and ingress changes made through the settings
routes re-stitch it immediately; out-of-band config edits take effect after a
server restart. Neither path requires rebuilding the binary.

**External — `sharp`** (dynamic social-card PNG rasterizer). Its platform
native (`@img/sharp-<platform>` + libvips) is resolved at runtime and cannot be
embedded. `src/server/session-social-card.ts` loads sharp lazily: without it the
server still boots and serves the UI, and the `/session-card/*.png` endpoint
returns `501` (the Open Graph meta tags still emit). To enable social cards,
place a minimal `node_modules` with `sharp` + the platform `@img/sharp-*`
beside the binary — e.g. copy `node_modules/sharp` and
`node_modules/@img/sharp-<platform>` (+ its `sharp-libvips-<platform>`).

**External: session-kernel service and sidecars.** The independently supervised
`opensession session-kernel-service` process loads `session-kernel-worker.js`.
That Worker owns the authoritative actor and writable SQLite store; its service
binds authenticated HTTP RPC to `127.0.0.1:3849` by default. The gateway loads
`session-kernel-transport-worker.js`, which forwards bounded RPC to the service
and wakes the synchronous facade through `SharedArrayBuffer`. Missing actor or
transport sidecars prevent the service or gateway from becoming ready.

**External: feature Worker sidecars.** `workflow-worker.js` and
`code-flow-worker.js` run workflow and code-flow analysis Workers. Like both
session-kernel Workers, they are bundled JavaScript files beside the executable
because `bun build --compile` does not embed Worker entrypoints.

**External: the `claude` CLI.** The Anthropic bridge is the Claude Agent SDK
running in-process (`src/server/anthropic-bridge.ts`), and the SDK shells out
to the installed `claude` binary (`OPENSESSION_CLAUDE_BIN`, default `claude` on
`PATH`) for every `pi/anthropic/*` turn. The binary is not embedded: the
installer puts it on the box (`--no-engine` skips it) and `doctor` reports it
when missing. The Pi engine and its provider adapters compile into the binary
and resolve from the embedded graph, so no plugins sidecar ships beside it.

Other native addons in the dependency tree (`@libsql/*`, `@cbor-extract/*`,
`@anthropic-ai/claude-agent-sdk` audio-capture, `@mariozechner/clipboard`,
`@earendil-works/pi-tui`) are not on the server boot/serve path, so the binary
boots and serves without them; features that reach one only need it when that
feature runs. The build-only natives (`@tailwindcss/oxide`, `lightningcss`,
`@parcel/watcher`) are never used in prebuilt-frontend mode.

## What doesn't work in this mode

Features absent or degraded in the compiled binary versus a source/tarball
install. Everything the shipped artefact covers (the sharp sidecar,
install/service/update, non-sandbox turns) works and is not listed here.

- **On-box self-development.** No source tree ships in the binary, so code
  sessions cannot run against the Open Session checkout itself (the
  `sharedCheckout` self-hosting path). Use the `--source` install (git checkout
  - bun) for self-development.
- **Bundled agent skills.** The release does not stage the repository's
  `.agents/skills` tree, so built-in skills are absent by default. Set
  `OPENSESSION_SKILLS_DIR` to an on-disk skills directory to load externally
  supplied skills in a compiled install.
- **Live frontend rebuild / CSS hot edits.** The in-process watcher and
  `scheduleFrontendRebuild` are off in prebuilt mode. Use `--source` for live
  edits.
- **Sandboxed agent runs launched from a compiled host** are untested: the
  sandbox re-exec sites run `bun run <host-entry>` inside a container that
  carries its own bun + checkout. Non-sandbox / local runs work (the dispatcher
  self-execs the binary for `runner-host` and `mcp-proxy`).
- **Stored transcript search.** The sessions route launches the TypeScript
  worker path directly instead of using the compiled
  `transcript-search-worker` subcommand, so compiled installs currently return
  no stored-transcript matches.
- **Features that spawn a `scripts/*.ts` helper by path.** A few paths resolve
  a helper script through `import.meta.dir` (which is `/$bunfs` in the binary),
  so the file is not on disk for the spawned process: PR-checks
  (`GH_CHECKS_CLI_PATH` → `scripts/gh-checks.ts`, `run-instructions.ts`) and the
  code-storage credential mint (`scripts/cs-credential.ts`,
  `codestorage/remote.ts`). The default self-repo / `mcp-config.json` path
  (`OPENSESSION_ROOT`, `config.ts`) also resolves under `/$bunfs`; simple mode
  uses the scratch repo and a written config, so it is unaffected, but a
  self-repo default would be wrong. These are separate from the turn path
  (Claude turns work) and would each need their own on-disk-sidecar treatment.

## State

Runtime state stays external and is unchanged: `OPENSESSION_CONFIG`
(`config.json`), `OPENSESSION_STATE_DIR`, the sessions dir, and
`mcp-config.json` are read by path as usual.
