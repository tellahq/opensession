# Claude host

Pi runs `pi/anthropic/*` turns on Claude accounts through the Claude Agent
SDK, which starts one Claude Code process per conversation. By default that
process is a child of whatever drives the turn (a run host on this machine).
The Claude host is an optional separate service that runs those processes
instead, so the part of Open Session that drives a turn no longer needs to be
able to start a process, and the machine that does start them never holds an
account's token.

It is off by default. Nothing changes until `pi.json` selects it.

## What moves and what stays

```text
turn driver (run host)                       Claude host
  pi agent loop, tools, account pick  --ws-->  Claude Code processes
  token proxy  <----- model requests -------   SDK session files
       |
       v
  api.anthropic.com
```

Only the SDK call moves. The provider still picks the account, plans what to
resume, parses the stream, counts usage, rotates on a limit and writes the
audit log, exactly as it does in-process. The Claude host:

- starts one Claude Code process per query it is asked for, with the same
  options the in-process provider uses (no built-in tools, the client's tools
  as passthrough MCP tools, an empty working directory, one isolated config
  directory per account);
- relays that process's SDK messages and client tool calls to the client, and
  the client's input and tool results back;
- keeps the conversation's SDK session files, so a later query can resume;
- ends the process when the client closes the query or its socket drops. A
  query never outlives its client.

It decides nothing about a conversation and has no account pool.

## The token never reaches it

The client does not send the account's credential. For each conversation it
leases a random placeholder from a small proxy in its own process
(`server/claude-token-proxy.ts`) and sends the host that placeholder plus
`ANTHROPIC_BASE_URL` pointing at the proxy. Claude Code then sends its model
requests to the proxy with the placeholder as its credential. The proxy
swaps in the real one and forwards the request to `api.anthropic.com`
unchanged, streaming the answer back.

- The real credential is attached only to requests for that one origin, and a
  redirect is returned to Claude Code, never followed.
- A placeholder works only while its conversation's process is alive; the
  provider releases it when it retires the process.
- A request without a known placeholder gets `401` and reaches nothing.
- The host drops every variable in a query's environment that is not on a
  short allowlist (`CLAUDE_HOST_ENV_ALLOWLIST` in `claude-host/protocol.ts`),
  and sets the config directory itself.

Subscription tokens, federated tokens and API keys are all handled this way;
an API key is swapped in `x-api-key` instead of `Authorization`.

## Turn it on

1. Start the host, as the same user as the server:

   ```sh
   bun packages/core/opensession-server/src/claude-host/main.ts
   ```

   It listens on `127.0.0.1:3847` and writes a bearer token to
   `claude-host-token` in the instance's state directory on first start. It
   needs Claude Code installed (`paths.claudeBin` in the config, or `claude`
   on `PATH`) and no Claude login.

2. Select the transport in `pi.json`:

   ```json
   {
     "enabled": true,
     "anthropicTransport": "remote"
   }
   ```

   The file is read whenever a conversation's process is started, so the
   next turn uses the host. Remove the field, or set it to `"inprocess"`, to
   go back; a process that is already running stays where it started.

| Setting                               | Where            | Default                                    |
| ------------------------------------- | ---------------- | ------------------------------------------ |
| `claudeHostUrl`                       | `pi.json`        | `ws://127.0.0.1:3847`                      |
| `OPENSESSION_CLAUDE_HOST_PORT`        | host environment | `3847`                                     |
| `OPENSESSION_CLAUDE_HOST_BIND`        | host environment | `127.0.0.1`                                |
| `OPENSESSION_CLAUDE_HOST_MAX_QUERIES` | host environment | `48`                                       |
| `OPENSESSION_CLAUDE_HOST_TOKEN_FILE`  | both sides       | `claude-host-token` in the state directory |

`GET /live` on the host answers without a token and reports the protocol
version and the number of running queries.

## When it fails

There is no fallback to the in-process transport. If the host is not running,
rejects the token, is at its query limit, or drops the connection, the turn
fails with that reason, and the message for an unreachable host names the
setting to change. A dropped connection ends the process on the host; the
next model step replays the conversation the way a failed in-process step
does.

## Limits today

- The service has no installed supervisor unit yet. Run it under your own
  process manager before relying on it.
- A query lives only as long as its client's socket. A client that restarts
  cannot reattach to a running process.
- The token proxy listens on loopback in the client's process, so the host
  must run on the same machine as the turn driver. Running the host elsewhere
  needs the proxy on a route that machine can reach.
- One Claude Code process uses roughly 200 MB while it is alive.

## Code

| Path                                     | Role                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `src/server/claude-sdk-query.ts`         | One SDK query as plain data, and the local starter both transports share |
| `src/server/claude-passthrough-tools.ts` | How client tools are presented to the SDK                                |
| `src/server/claude-query-runtime.ts`     | Binary, directories and spawn wrapper on this machine                    |
| `src/claude-host/protocol.ts`            | Wire frames and the environment allowlist                                |
| `src/claude-host/host.ts`                | Transport-free core: frames in, queries out                              |
| `src/claude-host/server.ts`, `main.ts`   | Listener and entry point                                                 |
| `src/server/claude-host-client.ts`       | The client's remote query handle                                         |
| `src/server/claude-token-proxy.ts`       | Placeholder leases and the forwarding proxy                              |

`claude-host/host.test.ts`, `server/claude-token-proxy.test.ts` and
`server/pi-anthropic-remote.test.ts` cover the protocol, the proxy and a
provider tool turn over a real loopback socket with a scripted stand-in for
Claude Code.
