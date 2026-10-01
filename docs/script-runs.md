# Script runs

A script run is a long shell command, such as a migration, a backfill, a data
fix or a sync, that Open Session supervises for a session. Agents start one
with `start_script` (`opensession-scripts`) instead of a background shell job,
which would die with the turn, the run host, or a server restart.

```text
start_script ──> script-runs.ts ──systemd-run --user --scope──> script host ──> bash -c <command>
                      │  registry.json                               │  log, exit.json
                      └─────────── reattach on boot ─────────────────┘
```

## What a run gets

- **It survives restarts.** The command is owned by a script host
  (`src/script-host/main.ts`) launched in its own transient user scope under
  `opensession-agents.slice`, outside the server's cgroup. Stopping, crashing
  or redeploying the server leaves it running. Without a systemd user manager
  (macOS, development) the host starts in its own session instead.
- **It is visible.** The session shows a card per run: its state, how long it
  has been going, credential call counts, the end of its output, and a Stop
  button. Viewers get `script_runs` frames when a run starts, ends or its
  counts move, and fetch output from `/api/scripts/:id`.
- **It reports back.** When a run ends, its session is woken once with how it
  ended and the end of its output, so the agent can start a run and end its
  turn instead of polling or scheduling a check-back. `notify: false` turns
  that off.
- **It has limits.** A deadline (default 60 minutes, at most 24 hours) that the
  host enforces even while the server is down, a minimal environment, and the
  workload slice's memory and task caps.

## Restarts

The server keeps one registry file, `script-runs/registry.json` in the state
dir, and a directory per run holding its `spec.json`, `host.json` and, once it
ended, `exit.json`. On boot `startScriptRuns()` loads the registry once and,
for each run recorded as running:

1. if `exit.json` exists, the run ended while the server was down: it is
   settled now and its session woken;
2. otherwise it is watched again, by polling for `exit.json` and checking the
   host's scope every 30 seconds;
3. a host that is gone without an `exit.json` marks the run `lost`.

The wake-up is delivered with a fixed delivery id and recorded in the
registry, so it happens exactly once, also across restarts.

Nothing here scans session files or actor databases. The registry holds only
script runs, is read once at boot, and is written asynchronously.

## Credential relays

A run that borrows a teammate's credential carries one relay per credential.
The host listens on a loopback port per relay and gives the script that URL.
Each request is forwarded over the run's unix socket to the server, which
checks the URL's secret against the SHA-256 it persisted and hands the request
to the registered relay handler, which injects the credential. The host never
holds a credential, and the secret itself is never written to disk.

While the server restarts, the socket is gone. The host holds each request and
retries until the server is back, for up to ten minutes. A request cut off
mid-flight is retried only when it is a GET or HEAD; anything else gets a 502,
because it may already have reached the API.

## States

| State       | Meaning                                                     |
| ----------- | ----------------------------------------------------------- |
| `running`   | The host is running the command.                            |
| `exited`    | The command ended on its own; see the exit code.            |
| `failed`    | The command could not be started.                           |
| `timed_out` | The deadline passed and the host stopped it.                |
| `stopped`   | Someone stopped it (`stop_script` or the card).             |
| `revoked`   | Its credential grant was revoked, which stopped it.         |
| `lost`      | The host went away without recording how the command ended. |
