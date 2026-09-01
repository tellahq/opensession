# Rust backend rewrite plan

## Summary

Rewrite the Open Session backend incrementally, preserving the web, native, and
Chrome client protocols while moving runtime ownership to Rust one service at a
time. Do not replace the backend in one cutover.

The main performance goal is not simply “use Rust.” It is to:

1. remove blocking filesystem, SQLite, parsing, and process work from the
   network runtime;
2. execute independent sessions on different cores;
3. retain strict serialization for mutations within one session;
4. bound every queue and expensive resource;
5. measure improvements against repeatable production-shaped workloads.

The current backend is already split into a gateway, a multi-lane SessionKernel
service, an executor, and detached run hosts. Those boundaries make a staged
rewrite possible. Rust should preserve them initially rather than combining all
work into a new monolith.

A rewrite will improve gateway responsiveness, concurrent session capacity,
memory use, startup time, transcript work, and CPU-bound control-plane tasks. It
will not materially reduce model-provider latency, GitHub latency, sandbox
startup, or the duration of agent tools. Those need separate product and
provider optimizations.

## Scope and completion definition

The tracked non-frontend TypeScript server and protocol tree currently contains
roughly 960 files and 279,000 lines including tests. Treat this as a multi-stage
migration, not a translation project.

Completion means the entire production backend is Rust. The public gateway,
authentication and policy enforcement, session authority, persistence,
WebSocket control plane, schedulers, effects, executor, run hosts, MCP runtime,
agent loop, model-provider clients, integrations, and backend CLI all run
without Bun, Node.js, `node_modules`, or JavaScript libraries. The
TypeScript/React frontend remains unchanged and is built ahead of deployment;
its build toolchain is not part of the production backend runtime.

The migration may temporarily run an old Bun role beside its Rust replacement
for isolated comparison or rollback. That is a migration mechanism, not an
acceptable end state. A JavaScript provider adapter, SDK sidecar, or hidden Bun
fallback does not satisfy completion.

## Non-goals

- Do not rewrite the frontend, native apps, or Chrome extension.
- Do not redesign the external client protocol during the language migration.
- Do not replace SQLite merely because the implementation language changes.
- Do not parallelize mutations within one session.
- Do not introduce a second live writer or dual-write session state.
- Do not use Rust FFI inside Bun or embed a JavaScript runtime in Rust. Temporary
  old/new comparisons use process boundaries and versioned protocols.
- Do not change security policy, tool availability, or credential scope as an
  incidental part of the rewrite.
- Do not claim success from microbenchmarks alone.

## Current boundaries to preserve

The migration must start from the architecture documented in
[Session kernel architecture](session-kernel-architecture.md),
[Executor architecture](executor-architecture.md), and
[Transcripts](transcripts.md).

The important invariants are:

- One `SessionKernel` actor is the logical and physical mutation owner for a
  canonical session ID.
- One session is serialized. Different sessions may run concurrently.
- Per-session SQLite databases are authoritative; the central database is a
  placement and wake catalog.
- The online service never scans or opens every actor database. Cross-session
  views use catalog-maintained projections and counters.
- External work is emitted as durable, fenced, retryable effects. Actor turns
  stay short and do not wait for models, Git, sandboxes, filesystems, or the
  network.
- The gateway, kernel, and executor fail closed when ownership, credentials, or
  protocol compatibility is ambiguous.
- Run hosts receive a minimal environment and explicit tool/MCP policy.
- Client command request IDs, run IDs, generations, effect IDs, transcript
  change cursors, and deletion tombstones retain their current semantics.
- Service startup, shutdown, deployment, and schema rollback checks remain
  ordered and health-gated.

A Rust implementation that violates one of these invariants is not a valid
migration even if its benchmark is faster.

## Target architecture

```text
Web/native/Chrome clients
            |
            v
  Rust gateway (Tokio + Axum)
    |       |        |
    |       |        +--> integrations and projections
    |       +-----------> Rust SessionKernel service
    +-------------------> Rust executor / run-host control
                                 |
                                 +--> Rust agent runtime
                                        |--> Rust MCP and local tools
                                        +--> Rust provider clients
```

Keep the existing process roles and the current three-service supervision
boundary for the first complete Rust release:

1. `opensession server`
2. `opensession session-kernel-service`
3. `opensession executor`
4. `opensession runner-host`
5. `opensession mcp-proxy`
6. `opensession transcript-search-worker`
7. CLI commands

They can ship as one Rust multi-call binary with subcommands, matching the
current compiled executable model. Separate processes retain failure isolation,
minimal environments, credentials, and independent capacity limits.

### Proposed Cargo workspace

| Crate                       | Responsibility                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `opensession-protocol`      | Versioned HTTP, WebSocket, executor, run-host, MCP, and record types using `serde`                   |
| `opensession-domain`        | IDs, fences, state machines, policy decisions, errors, and pure reducers                             |
| `opensession-storage`       | SQLite schemas, migrations, transactions, placement routing, actor connection LRU, and writer claims |
| `opensession-kernel`        | Per-session command mailboxes, timers, outbox, quarantine, and actor RPC                             |
| `opensession-gateway`       | Axum routes, WebSockets, auth, static frontend, limits, and request lifecycle                        |
| `opensession-coordinator`   | Schedulers, effect dispatch, recovery, projections, and shutdown fencing                             |
| `opensession-executor`      | Fixed-policy detached host launch, inspect, stop, and capacity admission                             |
| `opensession-run-host`      | Engine lifecycle, journaling, cancellation, transcript relay, and MCP proxying                       |
| `opensession-agent`         | Native agent loop, conversation state, steering, compaction, retries, presets, and tool scheduling   |
| `opensession-tools`         | Contained local tools, MCP client/runtime, JSON Schema validation, and tool-result rendering         |
| `opensession-providers`     | Native Anthropic, OpenAI, and OpenAI-compatible HTTP streaming clients plus account-pool policy      |
| `opensession-integrations`  | GitHub, Slack, storage, webhooks, and other HTTP integrations                                        |
| `opensession-observability` | `tracing`, metrics, health/readiness, audit fields, and redaction                                    |
| `opensession`               | Multi-call binary, config loading, service composition, and CLI                                      |

Keep dependency direction one way: transport and integrations may call domain
interfaces, but domain reducers must not import HTTP clients, process launchers,
or SDKs.

### Concurrency model

Use different pools for different work instead of putting everything on Tokio's
worker threads.

- **Network runtime:** a Tokio multi-thread runtime handles HTTP, WebSockets,
  timers-as-wakes, and nonblocking sockets.
- **Session actor lanes:** route canonical session IDs to a bounded set of OS
  threads or dedicated blocking lanes. Each session has a FIFO mailbox and
  stable lane affinity while active. Separate sessions can commit in parallel.
- **SQLite:** keep a connection per activated actor in a bounded LRU. Run
  transactions only on actor/storage lanes. Never call `rusqlite` from an async
  network task. Preserve the current short busy timeout and session quarantine
  behavior.
- **CPU pool:** use a bounded Rayon pool for parsing, indexing, hashing, diff
  preparation, compression, and other measured CPU-heavy pure work.
- **External work:** Git, process launch, provider HTTP streams, sandboxes,
  object storage, and MCP calls run in bounded task groups with per-kind
  semaphores and cancellation tokens.
- **Backpressure:** all channels are bounded. Overload returns an explicit
  retryable response or waits within a documented deadline. It must not create
  unbounded tasks or buffers.

Do not hold an actor mailbox across an `await`. An actor reduction validates and
commits a fact, emits a fenced effect, and releases the mailbox. Completion
returns as another typed fact.

During the kernel prototype, benchmark two storage-lane designs:

1. N long-lived actor threads with lane-local SQLite connection caches;
2. async actor mailboxes dispatching transactions to an N-thread storage pool.

Choose based on p95 queue delay, fairness under one locked database, memory per
active actor, and crash behavior. The design must preserve per-session ordering
without a global lock.

## Performance contract

Phase 0 must record baselines on the same hardware, data fixture, release build,
and kernel settings. Ratify exact targets after collecting the baseline. The
initial program targets are:

| Area                        | Provisional target at final completion                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| Non-model HTTP throughput   | At least 2x at the same or lower p95 latency                                                  |
| Independent kernel commands | At least 70% parallel efficiency from 1 to 8 cores                                            |
| Kernel p95 latency          | No regression while handling 4x the baseline concurrent sessions                              |
| WebSocket fanout and resume | No messages lost; p95 processing latency at least 50% lower under the baseline stress fixture |
| Process RSS                 | At least 30% lower for the same idle and active-session fixture                               |
| Cold readiness              | At least 2x faster without skipping recovery or migration checks                              |
| Reliability                 | No increase in indeterminate commands, quarantines, dead letters, or recovery failures        |

Measure at least these workloads:

- health, session list, session detail, search, and transcript range requests;
- 1, 100, and 1,000 concurrent WebSocket clients with reconnect/resume;
- independent actor commands spread across sessions;
- a hot single session to prove serialization and Stop responsiveness;
- transcript append/read/search with small and oversized entries;
- scheduler and outbox bursts with slow and failing destinations;
- 100 or more detached runs streaming events concurrently;
- startup and recovery with realistic catalog, projection, and journal sizes.

Record throughput, p50/p95/p99, queue delay, CPU time, RSS, allocations where
available, SQLite busy time, open file descriptors, dropped connections, and
scheduler lag. Separate model/tool wall time from Open Session overhead.

## Migration strategy

### Phase 0: inventory, profiles, and acceptance fixtures

Deliverables:

- Add a repeatable backend benchmark harness and production-shaped synthetic
  state generator. Never copy production credentials or private transcripts
  into fixtures.
- Add request, actor-queue, SQLite, WebSocket, scheduler, outbox, and run-host
  spans with stable names shared by both implementations.
- Capture CPU and allocation profiles for idle, list/search, transcript append,
  WebSocket streaming, and concurrent actor workloads.
- Produce an endpoint and background-job inventory. For each item record its
  data owner, side effects, auth requirements, inputs, outputs, and tests.
- Classify current synchronous filesystem/process work on request and event-loop
  paths.
- Freeze a representative compatibility fixture set, including failure and
  recovery outcomes.

Exit gate: target metrics and fixtures are reviewed, reproducible in CI or a
controlled benchmark host, and identify where current time is actually spent.
Do not start bulk translation before this gate.

### Phase 1: schema-first protocols and Rust foundation

The current TypeScript types are the compatibility source. Introduce a
language-neutral schema representation for externally visible and service
protocols. JSON remains the first wire encoding.

Deliverables:

- Generate or validate TypeScript and Rust types from versioned JSON Schemas.
- Preserve unknown-field, optional-field, integer, timestamp, and error-shape
  behavior explicitly.
- Define canonical JSON or canonical field encoding anywhere a digest or
  request fingerprint depends on bytes.
- Add golden fixtures for HTTP, WebSocket, executor, run-host, SessionKernel,
  transcripts, and config records.
- Add a Rust workspace with formatting, Clippy, deny/audit policy, tests,
  reproducible release builds, and cross-platform artifact packaging.
- Implement shared config parsing, secret redaction, structured logging,
  shutdown, health, and readiness primitives.

Do not switch to Protobuf, CBOR, or another transport during this phase. A later
measured change can add an encoding behind protocol negotiation.

Exit gate: TypeScript and Rust decode and re-encode every golden fixture with
identical domain meaning, and both reject the same invalid security-sensitive
inputs.

### Phase 2: read-only worker, executor, and provider feasibility

Start with roles that prove packaging and service operation without taking
session write authority. In parallel, retire the largest technical uncertainty:
replacing Pi and its JavaScript provider stack.

1. Rewrite `transcript-search-worker` in Rust. It is read-only and provides a
   real parsing, SQLite, and CPU performance comparison.
2. Rewrite the fixed-policy executor while preserving its Unix socket protocol,
   request idempotency, spec hash, host ID validation, systemd helper policy,
   capacity admission, and minimal environment.
3. Teach the multi-call artifact and installer to select the Rust role while
   retaining a release-level rollback switch.
4. Build small native provider probes for every required transport. At minimum,
   cover Anthropic streaming, OpenAI Responses streaming, OpenAI-compatible
   chat/completions, images, reasoning/thinking, tool calls, usage accounting,
   cancellation, rate limits, and account rotation.
5. Produce a signed-off provider support matrix. For each current model and
   account type, record its documented wire API, authentication method,
   streaming protocol, resumable state, tool semantics, and whether a direct
   Rust implementation can preserve it. Do not silently retain a JavaScript SDK
   or CLI bridge for a row that is difficult to port.

Subscription-backed Claude and ChatGPT accounts are an explicit feasibility
gate. If they depend on an undocumented or JavaScript-only interface, choose
openly between implementing a maintainable Rust transport with permission,
using a documented provider API with different credentials, or dropping that
account mode. A hidden `claude`, `codex`, or SDK subprocess is not a pure-Rust
backend fallback.

Exit gate: differential tests match current output, fault tests match current
failure behavior, artifact installation works on supported platforms, the
search benchmark demonstrates a meaningful measured win, and there is a credible
native path for every model/account mode retained in the product.

### Phase 3: SessionKernel service

This is the best high-value migration boundary because the gateway already uses
an authenticated, versioned service protocol. It is also the highest correctness
risk.

Deliverables:

- Port pure reducers and state machines before persistence code.
- Run existing transition fixtures against TypeScript and Rust.
- Implement the exact current schema and migration reader before proposing any
  Rust-only schema.
- Preserve writer claims, file mode, placement routing, per-session databases,
  catalog wake indexes, connection passivation, command idempotency, run
  generations, outbox/timer retries, quarantine, dead letters, and tombstones.
- Implement `/live`, `/ready`, authenticated `/rpc`, protocol negotiation,
  request/response limits, and incarnation fencing.
- Reproduce crash points around command admission, SQLite commit, effect
  dispatch, destination acceptance, actor settlement, and outbox
  acknowledgement.
- Keep the gateway's existing TypeScript actor client for the first production
  canary. The service boundary should make the implementation swap invisible.

Conformance must run on copied or generated state. Never open one live actor
database with both implementations, even read-only while a writer is active.
Shadow comparison replays recorded commands into isolated databases and
compares state, replies, changes, and effects.

Exit gate:

- all state-machine, schema, migration, crash, and ownership tests pass;
- a copied-state audit produces equivalent durable state;
- sustained multicore load meets the ratified kernel target;
- one session remains responsive to Stop while unrelated effects are slow;
- old and Rust services can each read the last mutually compatible schema;
- canary rollout and rollback are proven with the gateway stopped during the
  writer handoff.

### Phase 4: Rust gateway shell and read paths

Use a strangler gateway rather than replacing every route at once.

- Bind the Rust gateway to the public/private application listener.
- Serve the prebuilt frontend and static assets from Rust.
- Put the legacy Bun gateway on a private Unix socket or authenticated loopback
  address during migration. It must not be publicly reachable.
- Strip client-supplied internal identity headers. Authenticate and authorize in
  exactly one owner before proxying, and authenticate the private proxy hop.
- Port health, readiness, config reads, session list/detail, transcript ranges,
  search, media reads, and other side-effect-free routes first.
- Move read projections to Rust-owned bounded stores. Never replace projection
  reads with full-fleet actor database fanout.
- Compare responses from isolated fixtures and optionally shadow only
  side-effect-free requests.

Assign each route to exactly one implementation. Do not let a route perform
half of a mutation in Rust and half in Bun.

Exit gate: Rust owns the listener and all selected reads, protocol responses are
compatible with every shipped client, and proxy removal for migrated routes is
observable and reversible at the release level.

### Phase 5: WebSocket and session command plane

Port one complete WebSocket connection mode at a time. Do not split one stream
between runtimes.

Deliverables:

- handshake and capability negotiation;
- authentication and connection ownership;
- transcript init/index/range/live/resume;
- durable mutation request IDs, replay, command acknowledgement, and storage
  caps;
- queueing, steering, Stop, asks, session create, and deletion;
- bounded per-connection outbound buffers, slow-consumer policy, heartbeat, and
  reconnect behavior;
- post-commit publication from SessionKernel replies.

Use deterministic network tests that inject duplication, reordering,
disconnection, slow consumers, gateway restart, and kernel restart.

Exit gate: web, phone, iOS, and Chrome protocol suites pass against Rust; soak
runs show no missed or duplicate durable commands; and a release flag can move
the whole WebSocket endpoint back to the legacy gateway.

### Phase 6: schedulers, effects, recovery, and control-plane routes

Port authoritative coordination in vertical slices:

1. durable timers and scheduled prompts;
2. generic and opening-turn outbox executors;
3. transcript and session projections;
4. automation intake and recovery;
5. GitHub workflows and review coordination;
6. portals, sandboxes, Runners, and workload identity;
7. configuration mutations, setup, account, and admin routes;
8. Slack and other agent integrations.

Each slice must include intake, policy, persistence, effect execution, recovery,
shutdown fencing, observability, and operator repair paths. Merely porting the
happy-path route is incomplete.

Exit gate: Bun no longer owns a public route, durable scheduler, recovery loop,
or privileged control-plane decision.

### Phase 7: native Rust agent runtime and providers

Replace Pi rather than wrapping it. This phase moves both lifecycle authority
and the complete coding-agent loop into Rust.

#### 7.1 Freeze the behavior that Pi currently supplies

Build fixtures from the current production path for:

- system prompt, context-file, skill, and per-turn context assembly;
- conversation records, images, thinking, text, tool calls, tool results, usage,
  stop reasons, and transcript projection;
- `read`, `grep`, `find`, `ls`, `edit`, `write`, and `bash` schemas, containment,
  truncation, updates, audit, cancellation, and minimal environments;
- MCP discovery, search, invocation, OAuth/headers, allowlists, denied tools,
  per-user gates, timeout, reconnect, and result normalization;
- sequential tool-batch execution, steering at step boundaries, exact steer
  identity/retraction, and skipped stale calls;
- retry/backoff, empty completions, usage-limit classification, account
  rotation, model fallback, cancellation, and restart;
- compaction, branch summaries, session resume, engine handoff, presets, Dial
  oracles, orchestrator workers, and one-shot runs;
- Anthropic's current durable passthrough/checkpoint behavior, including tool
  batch settlement and suppression of hidden provider-only digest output.

These fixtures define Open Session behavior. Pi's internal JSONL layout and
class structure do not.

#### 7.2 Implement the agent state machine

Create a Rust `AgentRuntime` whose core is a deterministic state machine:

```text
prepare context -> request model -> stream blocks -> execute tool batch
       ^                                      |             |
       |                                      v             v
       +-- compact/retry/steer/follow-up <- settle step <- results
```

The runtime owns conversation state, request construction, tool scheduling,
stream normalization, usage, retry policy, compaction, steering, and terminal
settlement. Provider and tool work returns typed events to the state machine.
No provider client may mutate transcripts, journals, or SessionKernel directly.

Define a Rust `Provider` trait with a cancellable stream of normalized events:
start, text/thinking deltas, tool-call fragments, completed tool calls, usage,
finish reason, retry metadata, and typed failure. Preserve provider-native opaque
continuation data where required, but keep it out of user-visible transcripts.

#### 7.3 Implement local tools and MCP natively

- Implement contained filesystem tools in Rust with canonical-path and symlink
  checks at operation time, not only before dispatch.
- Execute shell commands with an explicit minimal environment, process-group
  cancellation, bounded output, timeouts, and the existing audit contract.
- Implement MCP JSON-RPC transports, lifecycle, capability negotiation, tool
  schema validation, discovery/search, calls, cancellation, OAuth projection,
  and reconnect in Rust. Do not shell out to a JavaScript MCP SDK.
- Preserve ask/code tool differences and all unattended-run deny rules before a
  tool is advertised to the model.

#### 7.4 Implement provider protocols directly in Rust

Use direct HTTP/SSE/WebSocket implementations and provider-owned documented
wire protocols. Do not load vendor JavaScript SDKs.

- **Anthropic:** Messages streaming, images, thinking/signatures where exposed,
  tool use/results, prompt caching, usage, errors, cancellation, and supported
  account authentication.
- **OpenAI:** Responses streaming, reasoning items, function calls/results,
  images, usage, service tier, errors, cancellation, and supported API-key or
  account authentication.
- **OpenAI-compatible providers:** configurable base URL and key, chat or
  responses dialect selected explicitly, reasoning-effort mappings, model
  metadata, and provider-specific error normalization. Cover retained Wafer,
  Cerebras, OpenRouter, xAI, Moonshot, and other configured catalog entries
  through declared capabilities rather than protocol guessing.

Implement account selection, affinity, strict pins, exhaustion sidelining, and
pre-output rotation above the transport so every provider follows one audited
policy. Never replay a request on another account after replay-unsafe output has
escaped.

The direct provider protocol may make a Pi/Claude-SDK workaround unnecessary.
For example, an ordinary Anthropic `tool_use` stop followed by `tool_result`
does not need a hidden passthrough digest. Preserve the external behavior and
durable recovery guarantee, not an obsolete implementation trick. Where a
provider requires opaque continuation state, store and fence it explicitly.

#### 7.5 Integrate with Rust run hosts

Rust owns:

- journal admission and recovery;
- run ID and generation fencing;
- host launch, adoption, liveness, and cancellation;
- environment construction and credential projection;
- context logging and transcript destination writes;
- fallback policy and terminal outcome projection.

Run old Pi and the Rust agent only against isolated fixture state during
comparison. Cut over one provider/account mode at a time at the release level,
with no per-turn fallback from Rust into Pi. Delete each JavaScript provider
path once its compatibility and live smoke gates pass.

Exit gate:

- every retained model, preset, account mode, local tool, and MCP transport runs
  through Rust;
- Rust can restart, adopt, steer, stop, and settle local, sandbox, and Runner
  executions without losing or duplicating an authoritative turn;
- differential, transcript snapshot, provider conformance, security, and fault
  suites pass;
- the run host starts with no Bun/Node executable or `node_modules` available;
- Pi, Meridian, the Anthropic JavaScript SDK, and all other backend JavaScript
  SDK dependencies are absent from the runtime artifact.

### Phase 8: remove the legacy backend and simplify

- Remove the Bun gateway proxy, TypeScript backend entrypoints, Pi runner,
  JavaScript SDK bridges, Worker sidecars, and backend JavaScript dependencies
  after at least one full compatibility window.
- Port remaining backend CLI commands to the Rust multi-call binary.
- Keep explicit migration readers until rollback policy permits removal.
- Consolidate service templates and release packaging around the Rust binary.
- Make release verification fail if the production artifact contains a Bun or
  Node runtime, backend `.js` files, `node_modules`, or an executable fallback
  to a JavaScript engine/provider path.
- Re-run profiles and remove compatibility serialization or copies only when
  benchmarks justify it.
- Archive the final protocol fixtures and migration audit procedure.

Exit gate: no production request, durable decision, recovery path, model turn,
tool call, integration, or CLI command depends on Bun, Node.js, or a JavaScript
library. The only TypeScript/JavaScript artifact is the prebuilt browser bundle
served as static content.

## Verification strategy

### Differential testing

Build one harness that can execute the same operation against the TypeScript and
Rust implementations with isolated state directories. Normalize only declared
nondeterminism such as timestamps, random IDs, and ordering that the protocol
already defines as unordered. Compare:

- status, headers, and JSON body;
- WebSocket frames and resume cursors;
- actor reply and emitted effects;
- durable rows and schema versions;
- audit events and redaction;
- restart and recovery results.

A difference needs an explicit compatibility decision, not a growing ignore
list.

### State-machine and property testing

Use table fixtures plus property tests for commands, queueing, steering, Stop,
creation, run generations, timers, effects, deletion, and transcript receipts.
Generate duplicate, stale, conflicting, and reordered events. Assert that:

- one session has one mutation order;
- stale generations cannot affect successors;
- exact request replay is idempotent;
- conflicting request reuse fails closed;
- no accepted durable intent disappears;
- deletion cannot be undone by a late event.

Use model checking or a concurrency test tool for the small primitives that
coordinate mailbox shutdown, actor passivation, and cancellation.

### Crash and fault testing

Automate process termination and injected failures before and after every
important durable boundary. Cover full disks, permission failures, SQLite busy
and corruption responses, truncated frames, service version mismatch, slow
consumers, DNS/network timeout, destination ambiguity, and process restart.

### Client compatibility

Run contract suites for the web/phone bundle, iOS, and Chrome extension against
both backends throughout phases 3 to 7. Keep at least one mixed-version test for
every supported rolling or rollback combination.

### Provider and agent conformance

Capture provider streams as secret-free fixtures and replay fragmented SSE or
WebSocket frames through both implementations. Cover text, thinking, multiple
and partial tool calls, images, cache/usage fields, malformed events, rate
limits, transport interruption, cancellation, and opaque continuation state.
Run live smoke tests for every retained provider/account mode before cutover.

Drive the Rust agent with a deterministic fake provider and fake tools to pin
step ordering, steering boundaries, retries, compaction, fallback, transcript
entries, and terminal settlement. The provider test suite and agent-loop test
suite must remain separate so a provider quirk cannot conceal a state-machine
bug.

### Security verification

Port security rules before their routes and keep tests at the enforcement layer:

- minimal subprocess environments;
- MCP allowlists and per-user gates;
- unattended-run denied tools;
- GitHub actor and repository credential scope;
- customer, identity, incident, and money-moving mutation restrictions;
- private service authentication and protocol fencing;
- path traversal, symlink, request-size, decompression, and SSRF defenses;
- audit logging without secrets.

Run dependency audit, license policy, fuzzing on public parsers, and secret
scanning on release artifacts.

## Deployment and rollback

Migrate by service role and immutable release, not by random per-request
experiments.

1. Build TypeScript and Rust implementations from the same commit.
2. Keep existing wire versions until both ends support a negotiated successor.
3. For read-only roles, canary on isolated traffic and compare outputs.
4. For a writable role, stop its clients, verify the old writer is inactive,
   start exactly one new writer, run readiness and ownership checks, then start
   clients.
5. Record the highest schema opened by a release and reject an unsafe rollback.
6. Use offline copied-state audits for migrations. Never dual-write and never
   shadow a live actor database with another implementation.
7. Roll back the entire role, not individual requests, if ownership or durable
   semantics are uncertain.
8. Keep operator repair, dead-letter, quarantine, and migration audit commands
   available before the canary.

A release is healthy only after recovery gates complete. A fast listener that
has not reconciled journals, actor ownership, or durable effects is not ready.

## Main risks and mitigations

| Risk                                                                           | Mitigation                                                                                                                                                 |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Semantic drift across a large rewrite                                          | Schema-first contracts, golden fixtures, differential tests, and vertical slices                                                                           |
| Rust is faster in microbenchmarks but not in real turns                        | Phase 0 profiles, production-shaped load, and separate Open Session overhead from provider time                                                            |
| New concurrency creates races                                                  | Preserve per-session actors, use bounded message passing, avoid shared mutable maps, and property/fault test                                               |
| SQLite blocks async workers                                                    | Dedicated storage lanes, short busy bounds, per-session quarantine, and no SQLite on network tasks                                                         |
| Two writers corrupt authority                                                  | Role-level cutovers with clients stopped, writer claims, and no dual-write mode                                                                            |
| A subscription account depends on an undocumented or JavaScript-only transport | Resolve in phase 2: implement a permitted native protocol, move that mode to documented API credentials, or remove it; never hide a JavaScript fallback    |
| Provider protocols drift faster than the Rust clients                          | Capability tables, captured wire fixtures, strict decoding at security boundaries, tolerant decoding of additive events, and per-provider live smoke tests |
| Gateway proxy weakens authentication                                           | Private authenticated hop, strip synthetic headers, one auth owner per route, remove proxy incrementally                                                   |
| Rust build increases platform/release complexity                               | Prove packaging with read-only and executor roles before kernel or gateway cutover                                                                         |
| Rewrite stalls while TypeScript keeps changing                                 | Protocol ownership, domain freeze windows per slice, small mergeable phases, and delete migrated code promptly                                             |
| Team lacks Rust operating experience                                           | Establish coding, review, profiling, unsafe-code, dependency, and incident practices in phase 1                                                            |

## Recommended first implementation sequence

The first mergeable changes should be:

1. benchmark and fixture harness with current TypeScript baselines;
2. endpoint/background-job and Pi-behavior ownership inventories;
3. Cargo workspace, release build, logging, config, health, and CI foundation;
4. protocol schema and cross-language golden tests;
5. native Anthropic, OpenAI, and OpenAI-compatible streaming probes plus the
   provider/account support matrix;
6. deterministic Rust agent state-machine skeleton against a fake provider and
   fake tools;
7. Rust transcript search worker with differential benchmark;
8. Rust executor with fault and packaging tests;
9. pure SessionKernel reducer port and property tests;
10. Rust SessionKernel storage against generated/copied fixtures;
11. authenticated kernel service canary behind the existing gateway;
12. Rust gateway shell and read-route migration.

Do not begin by translating `opensession.ts` route by route. That would preserve
its current coupling in another language and postpone the actor, protocol,
backpressure, and ownership decisions that make multithreading safe.

## Program-level definition of done

Completion requires all of the following:

- Ratified throughput, latency, scaling, memory, and startup targets are met on
  the same hardware and fixtures used for the baseline.
- Rust owns all public listeners, auth/policy decisions, durable state,
  orchestration, recovery, privileged process control, agent turns, tools, MCP,
  and model-provider communication.
- Per-session serialization, cross-session parallelism, bounded queues, and
  backpressure are demonstrated under load.
- Every shipped client passes compatibility tests.
- Every retained model, preset, provider, and account mode passes agent and
  provider conformance plus live smoke tests.
- Crash tests prove no accepted intent is silently lost or executed twice where
  the destination contract promises idempotency.
- Security enforcement and credential isolation are equivalent or stronger.
- Deployment, schema compatibility, canary, and rollback procedures are tested
  and documented.
- The production backend artifact and service definitions contain no Bun,
  Node.js, `node_modules`, backend JavaScript, Pi, Meridian, JavaScript SDK, or
  executable JavaScript fallback. CI enforces this inventory.
- The prebuilt browser bundle is the only shipped JavaScript and is never
  executed by the backend.
- Production observability can attribute latency and saturation to network,
  actor queue, SQLite, CPU pool, external effect, provider, tool, and client
  fanout.
