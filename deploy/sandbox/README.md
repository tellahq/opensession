# Sandbox runtime and live checks

A Sandbox is a workspace, not a place where Open Session runs. The agent loop,
model credentials, conversation history and MCP connections stay on the
server; the agent's file and shell tools reach the Sandbox as commands
(`packages/core/opensession-server/src/server/remote-workspace.ts`, served by
`src/server/sandbox/workspace-rpc.ts`). Operator guide:
[`docs/self-hosting-sandboxes.md`](../../docs/self-hosting-sandboxes.md).

## The base runtime

`src/server/sandbox/adapters/bootstrap.ts` installs the same small runtime on
every provider's base machine, pinned and checksum-verified where the upstream
publishes checksums:

| Component                                                                | Purpose                                                    |
| ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `git`, `curl`, `ripgrep`, `python3`, a C/C++ toolchain, `direnv`, `lsof` | clone, search, native dependency builds, lifecycle scripts |
| Node.js                                                                  | repository tooling                                         |
| `just`, `gh`                                                             | common dev-server chains and GitHub work in shell commands |
| `bun`                                                                    | lifecycle hooks, the Portal relay, repository tooling      |
| `~/.local/bin/opensession`                                               | workload identity minting (`opensession sandbox id-token`) |

It names no Open Session commit, so deploying Open Session never makes a
Sandbox reinstall anything. A marker file records the runtime signature;
changing a pin or `BASE_RUNTIME_REVISION` re-bootstraps prewarms and project
snapshots instead of calling them Ready.

## Live checks

`deploy/sandbox/verify-remote-workspace.ts` prepares one Sandbox on a live
provider, drives every tool operation through the server handler a run uses,
prints each round trip, and destroys the machine:

```sh
bun run deploy/sandbox/verify-remote-workspace.ts box
```

`deploy/sandbox/conformance.ts` is the provider certification matrix:

```sh
bun run deploy/sandbox/conformance.ts [daytona] [box]
```

Both redirect every store to a scratch directory before importing server
code and read credentials from the live connection store without logging
them.
