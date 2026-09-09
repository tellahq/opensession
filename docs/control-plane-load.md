# Control-plane load

How to measure what the gateway and session kernel do under a busy fleet
without spending model tokens or touching the live instance.

## Synthetic engine

`src/server/testing/synthetic-engine.ts` stands in for Pi. Every turn emits
`init`, a paced run of text chunks, a few tool call/result pairs and one
`done`, and persists the assistant lines through the same transcript path a
real adapter uses, so the store sees production write patterns. It is a dev
seam in `agent-runner` `runOnModel`, active only when both are set:

```
OPENSESSION_DEV=1 OPENSESSION_SYNTHETIC_ENGINE=1
```

Per-turn shape: `OPENSESSION_SYNTHETIC_CHUNKS` (40), `OPENSESSION_SYNTHETIC_TOOLS`
(4), `OPENSESSION_SYNTHETIC_CHUNK_MS` (25). Production never sets
`OPENSESSION_DEV`, so the branch is dead there; a dev instance also refuses to
boot without an isolated state dir.

## Harness

```
bun scripts/load-control-plane.ts [--sessions 200] [--clients 50] [--turns 2]
    [--rate 20] [--chunks 40] [--tools 4] [--chunk-ms 25] [--keep]
    [--url http://127.0.0.1:PORT]
```

Without `--url` the script boots its own isolated instance under
`/tmp/opensession-load-*`: a kernel service, then a gateway with
`OPENSESSION_DEV=1`, `OPENSESSION_TEST_IN_PROCESS_RUNS=1` (runs execute in
the gateway process, where the seam lives), `OPENSESSION_EXECUTOR=0`, no
agents, and the synthetic engine. It refuses a `--url` naming the live
instance or its ports.

It then opens `--clients` WebSockets that `sessions_subscribe` with a sidebar
query (and each `watch` one session), creates `--sessions` sessions at
`--rate` per second (each create runs its opening turn), and sends `--turns`
rounds of prompts to every session at the same rate, waiting for the fleet to
drain between rounds. Throughout it samples the sidebar list route, health
and the RSS of both processes once a second.

Report (JSON under `artifacts/load/`, summary on stdout):

- HTTP p50/p95/p99 for create, prompt, sidebar list, health
- WebSocket frames by type
- `sessions_invalidated`: whole-list refetch orders the fleet still emits.
  The target on the hot path is 0; every ordinary write publishes one row.
- `session_row` latency from the prompt that caused it (includes the 250 ms
  coalesce window)
- transcript frames watchers received
- peak RSS of gateway and kernel

## Reading the numbers

`sessions_invalidated` above zero during creates or turns means a code path
regressed to `invalidateSessionsCache()` for a change that names a session;
route it through `publishSessionChange` or `publishSessionRowsForBranch`
(`docs/session-kernel-architecture.md`, Read projections).

Create latency is the creation-effect pipeline: the durable workspace effect
and then the opening turn are executed by `drainSessionKernelRuntime`, which
runs on a 1 s tick and on wakes (an emitted effect, a freed slot; see
`docs/session-kernel-architecture.md`, Timers and effects), with
`OPENSESSION_KERNEL_CREATION_PREPARATION_OUTBOX_CONCURRENCY` (16) and
`OPENSESSION_KERNEL_OPENING_OUTBOX_CONCURRENCY` (100) slots, discovering at
most `OPENSESSION_KERNEL_RUNTIME_WAKE_CANDIDATES` (32) sessions' work per
pass. The waiter in
`requestCreationWorkspace` is woken by the effect's result and otherwise
polls with backoff, so pending creates cost the kernel lanes nothing while
they wait. Before the wakes and the wider batch, discovery admitted four sessions per
one-second tick, so a 12/s create stream backed up until every create hit
its 30 s deadline; a `create` p50 near 30 s with `http errors` counting
`creation effect ... remains durably pending` is that regression. Prompts to
an existing session do not pay any of this.

Measured on the live box (16 cores, isolated instance, synthetic engine):
300 sessions, 100 clients, 2 turns at 12/s went from create p50 30.6 s with
189 of 300 creates failing to create p50 277 ms, p99 661 ms, 0 http errors,
prompt p50 8 ms, list p50 10 ms, row latency p50 265 ms, gateway 665 MB and
kernel 1063 MB peak RSS. A 300-session burst at 30/s went from 228 failures
to all 300 created in 10.2 s, create p50 141 ms, max 292 ms, 0 http errors,
gateway 1455 MB peak RSS.

The synthetic engine does not cover one-shot helpers (generated titles), so a
load instance logs `[oneshot:generated-titles] failed` per create; that is
expected noise there.
