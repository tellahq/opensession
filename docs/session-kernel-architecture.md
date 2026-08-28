# Session kernel architecture

Open Session has one logical owner for every session. The owner is a
`SessionKernel` actor addressed by the canonical session id. Its writable store and autonomous reducers run in a separate Worker isolate;
the gateway reaches it through a versioned IPC client. HTTP routes, WebSocket handlers, MCP tools,
automations, timers, recovery, and executors are clients of that owner. They do not own session lifecycle state themselves.

## Invariant

For one session id, one kernel serializes commands and is the only module that
may commit session mutations. Read models can lag. They never decide whether a
prompt starts, whether a run is busy, whether recovery retries, or whether an
executor event belongs to the current run.

The implementation lives in
`packages/core/opensession-server/src/server/session-kernel/`.

## Service boundary

The writable actor runs in a separately supervised session-kernel service
process, not in the HTTP gateway. Systemd names that process
`opensession-session-kernel.service`. The service binds only `127.0.0.1:3849`,
bearer-authenticates every `/rpc` call, and negotiates a
transport version separately from the actor/schema version. System-scope
installs use the root-owned systemd `session-kernel-token` credential. User
systemd and launchd installs use a user-owned `0600` token file, while foreground
startup generates an inline token shared only with its child service. `/live`
reports process/actor liveness and `/ready` reports whether the actor handshake
completed. Neither endpoint exposes RPC data.

The network frontend and actors are separate isolates. The frontend bounds
requests at 16 MiB, responses at 128 MiB, and outstanding calls at 1024. A
catalog lane plus a configurable bounded pool of session Worker lanes host typed
messages. The service owns one serial promise mailbox per canonical session ID
and gives that actor stable lane affinity, so process-local reducer caches remain
coherent and two turns for one session cannot overlap. Many actors share each
lane, while the short isolated SQLite wait bound leaves unrelated lanes
available. A failed lane is restarted without stopping healthy lanes;
system-catalog ambiguity still fail-stops the service. After startup ownership
checks, actor turns perform bounded SQLite
reductions only. They do not bind sockets, perform filesystem or process work,
invoke models, or execute outbox effects. Physical filesystem, network,
process, and model work remains in gateway continuations, the executor service,
run hosts, sandboxes, or Runners. Active effect receipts do not hold the actor
mailbox, so Stop, steering, and fenced run events remain responsive.

The gateway retains a Worker bridge for typed reductions. Mutations and durable
reads perform authenticated bounded HTTP RPC and wake the gateway through its
existing `SharedArrayBuffer`. Reads also route through the actor host because a
central WAL mirror cannot authoritatively represent sessions placed in separate
databases. Hot run-state projections remain cached in the gateway and are
invalidated by committed actor replies. A missing credential,
actor/transport/incarnation mismatch, service failure, or invalid response
fail-stops the gateway. There is no in-process actor or direct writer fallback
in production.

Installer, deploy, and CLI restart flows stop the old gateway before restarting
the actor service, then start the new gateway. This sequencing prevents mixed
releases from opening two writable SQLite connections. The actor process does
not load the application environment file. It receives only its runtime path,
`HOME`, `NODE_ENV`, active state-directory overrides, and its credential. Source
installs use `packages/core/opensession-server/src/session-kernel-service.ts`;
compiled installs dispatch `opensession session-kernel-service` and ship both
actor and transport Worker sidecars. Built-in supervisors use port 3849. A
manual launcher may set `OPENSESSION_SESSION_KERNEL_PORT` on the service and a
matching `OPENSESSION_SESSION_KERNEL_URL` or
`OPENSESSION_SESSION_KERNEL_HOST`/`OPENSESSION_SESSION_KERNEL_PORT` pair on the
gateway. It must also give both processes the same
`OPENSESSION_SESSION_KERNEL_TOKEN` or
`OPENSESSION_SESSION_KERNEL_TOKEN_FILE`. Both sides still require plain HTTP on
`127.0.0.1`. Systemd user units, macOS launchd installs, and foreground startup
supervise the same separate actor process.

The target is an Erlang/Durable Objects style state machine: each typed message
is reduced and committed in one short actor turn, external work is emitted as a
durable effect, and results return as fenced messages. The actor never waits for
a model run or gateway callback before processing the next state fact.

Schema 27 includes the production-unwired foundation for atomic signed Agent
Host supervision receipts. Authority construction, bounded synchronous signing,
receipt insertion, supersession and high-water updates share one immediate
transaction. Production has no signing credential and therefore fails signed
claim issuance closed. Legacy unsigned receipts remain explicitly
non-authorizing. The exact protocol-v3 Host attach path now verifies that foundation with only
a strict public keyring and fresh socket-bound challenges, but remains
production-unwired. A separate import-inert Linux Unix-socket gate can verify
`SO_PEERCRED` before reading protocol bytes, but is likewise not composed into
the Host or SessionKernel services. Socket path ownership and modes are defense
in depth; future activation requires an exact allowed numeric UID and must fail
closed rather than falling back to a token, loopback, or socket permissions.
Separate Host, SessionKernel, and gateway service identities, private/public key
provisioning, and detached Host deployment are still required before it can
authorize production work.

## Durable state

The storage router uses two durable locations within the active sessions
directory. A fresh default install uses `~/.opensession/sessions`; an existing
legacy `~/.opensession-sessions` directory remains active when the new directory
does not exist. `OPENSESSION_SESSIONS_DIR` overrides the sessions directory
directly. Without that override, `OPENSESSION_STATE_DIR` places it at
`<state-dir>/.opensession-sessions/`.

- `session-kernel.sqlite` is the placement/wake catalog and temporary source for
  not-yet-migrated legacy rows.
- `session-kernel-sessions/<prefix>/<sha256>.sqlite` is the authoritative
  database for each placed session.

Each authoritative session database contains:

- Durable commands, keyed by session id and client request id.
- Authoritative run state, run id, and generation.
- Durable delivery and blocking-ask aggregates with monotonic revisions.
- A monotonic session change stream.
- Durable timers.
- A retrying effect outbox.
- Durable per-session quarantine records for ambiguous settlements.

While a session exists, request ids have no age expiry because clients retain
unresolved intents without one. After execution admission, most payload bodies
are dropped while their SHA-256 fingerprints remain; bounded cancel and
WebSocket command payloads stay with their receipts for fenced replay. Large
semantic results remain fully replayable until the client durably records and
delivers `command_ack`; the client retries that acknowledgement until
`command_ack_result`. After 30 days, acknowledged results larger than 64 KiB
compact to a permanent digest marker. Terminal failures always retain their
bounded error. Replaying an unresolved id therefore returns the complete
committed result without retaining large request bodies forever. Reusing an id
with another payload is rejected. WebSocket receipt replay is capability-negotiated. Mutations wait
behind the hello handshake, then become durable commands on a capable server
or one-shot sends on an older server. A command whose physical execution was
interrupted becomes a retryable durable failure receipt only when its server
call site explicitly declares the operation replay-safe. Admission committed but
never marked as executing is also promoted to that safe retry receipt on actor
restart, because no physical callback could have begun. Replay policy is not part of client request identity,
and the first policy-aware migration preserves pre-existing interrupted receipts. The default is fail-closed: interrupted physical work
becomes `indeterminate` and cannot execute again without reconciliation. Web and native clients persist each admitted mutation until a terminal
`command_result`, then persist its acknowledgement until `command_ack_result`.
They do not evict by age or count; both cap pending mutation storage at 3 MiB and
reject a new durable admission when full instead of evicting unresolved work.
After reconnect or app restart they replay the same request id. Chrome keeps
unresolved create and follow-up intents by request identity instead of
overwriting one ambiguous request with the next. Completed retries return the
stored result; replay-safe interrupted retries re-enter the actor with the
original id.
Readiness ages only pending or processing commands. Indeterminate outcomes have
separate count and oldest-age metrics, so a retained forensic receipt cannot make
an unrelated active command report the whole actor service as stale.

Large attachments are not copied into the command journal. Their content hash
is part of the command identity. Create requests derive a stable session id
from the verified actor and request id. Every opening prompt enters a durable dispatch record before the session file is
announced. Create retries and boot recovery share one request-derived
prompt-entry id: whichever path runs first adopts that dispatch, so they cannot
launch two opening turns. Creation is owned by the deterministic target session,
not a person-wide mailbox. Command admission completes once the session and
opening dispatch are durable, while the opening run continues under generation
fencing. A retried create rebuilds
its full environment plan from the deterministic id and original request. The actor's write-once setup plan persists nondeterministic branch and workspace
choices before those resources are created, plus the serializable
`ResolvedCreate` decisions (model, sandbox, MCP scope and assembled opening
context) before the opening run. Attachments remain in their dedicated durable
store rather than being copied into the plan. Setup state is retired when the
opening launch commits; pre-schema-11 create-plan JSON is only a read-only
recovery fallback. REST and native callers reuse the original request id. MCP calls derive it from
the model's durable tool-use id, which the Pi bridge forwards in request
metadata rather than relying on a transport JSON-RPC id. Recovery therefore
resumes the same worktree, attachment, sandbox or runner preparation before
delivering the opening prompt.

## Runtime ownership

The actor owns two durable aggregates that previously lived in unrelated global
maps and JSON files. Production delivery and ask access fails closed when the
actor is unavailable. The direct store adapter exists only for isolated tests.

- Delivery state: ordered prompt queue, one pre-journal dispatch and steer receipts.
- Blocking ask facts: question identity, content, escalation and recovery state.

Delivery mutation and dispatch claim, acknowledgement or failure are short typed
Worker reductions. Mutation replies contain only the operation result and new
revision. They invalidate the gateway projection instead of returning or eagerly
refetching the full attachment-bearing aggregate. Queue batching policy (solo
interrupts, auto-continue, review handoffs, delegated reports and worker holds)
now runs inside the same actor reduction as the claim. The gateway supplies
only live policy facts such as whether child workers remain. The actor prepares
a stable interrupt identity and fenced cancel outbox effect before physical
cancellation, then records the explicit `confirmed` or `not_aborted` result. An
`executing` receipt makes cancellation retryable against only the same run
generation and an immutable physical dispatch identity; ambiguous retry
conservatively confirms instead of crossing into a successor that reused the
same session or engine alias. Claiming waits for confirmation and atomically moves
the interrupt with its selected batch into dispatch ownership. A crash or
launch failure restores the exact batch and confirmed interrupt together, so
restart cannot lose the solo target or separate hold bypass from steer framing.
Failure atomically restores that exact batch
ahead of later work. Actor-owned boot recovery reconciles each dispatch and
steer with idempotent reducers and never clears durable slots for a projection
rebuild. Interrupt preparation may atomically move an accepted-but-unread steer
receipt into its anchored queue position; `not_aborted` restores its original
steered position. Steering first moves an item to a pending-steer checkpoint,
then reports runner acceptance or rejection as a second typed fact. Restart treats
an unresolved checkpoint as ambiguous acceptance and reconciles it through the
receipt and transcript path instead of delivering a duplicate turn. The old queue and ask JSON formats are imported once under
durable migration markers, then deleted. Default-path writers no-op after the
marker commits; only explicit test/migration fixture paths retain JSON output.
Explicit Stop is also actor-owned. Preparation atomically records the target run
and generation, moves only unconfirmed steer receipts back to the queue, parks
the run state, and emits a `turn_cancel` effect keyed to the immutable physical
dispatch. `prepared`, `executing`, and settled receipts survive gateway crashes;
settlement precedes outbox acknowledgement, retries cannot cancel a successor,
and the durable `stopped` state keeps the queue parked across restart until an
explicit prompt advances the reducer. Boot recovery preserves and attaches an
exact journal owner named by a cancel receipt instead of treating `stopped` as
proof of absence. The effect reissues cancellation when that control appears;
an executing retry with no positive reconciliation remains failed closed. Small
run-targeting command payloads remain with their permanent receipts so reconnect
replay reconstructs the original run id and generation even after actor state
moves on. Resolver closures and timeout handles
remain process-local executor state because they are not durable decisions.

## Creation ownership

The actor persists a fenced creation aggregate with `planned`, `preparing`,
`opening_dispatched`, `ready`, `failed`, and `cancelled` states. Typed creation events reject
identity crossover, invalid transitions, and stale physical-effect results while
other gateway work is active. Creation reductions can now atomically persist state and a stable typed effect.
The protocol names workspace, branch, sandbox, credential, attachment-reference,
and opening-turn effects, including adoption or reconciliation modes and durable
creation fences. Payload decoding strips unknown fields, so bearer credentials
and inline attachment bodies do not cross the durable executor boundary. The
creation aggregate durably retains bounded completed-effect receipts. An
executor result clears the current effect and records its stable ID in the same
state/change transaction. Actor-store restarts preserve those receipts, and a
completed effect cannot be emitted again after its outbox row is acknowledged.
The receipt set rejects new completions at a fixed capacity before acceptance.

The workspace effect now has a production executor. It creates a fixed-ID,
dedupe-keyed workspace or adopts the exact existing destination, then returns a
fenced result through the creation reducer before the outbox item is
acknowledged. A crash after the atomic workspace write adopts on retry. A crash
after result acceptance replays as an audited stale no-op. Identity, project, or
branch ambiguity dead-letters immediately instead of overwriting the workspace.
The interactive MCP and WebSocket create paths now record the actor plan before
physical setup and emit `creation_workspace_prepare` instead of writing a new
workspace. Their gateway continuations wait for the completed actor receipt,
never workspace file presence. Existing-workspace joins remain reads, while the
actor setup plan carries the other recovery decisions.
The branch effect also has a production executor. It adopts only an exact
project, branch, and worktree-path match, or materializes the requested branch
with stable base and isolation options before returning its actor fence. Branch
or path crossover is immediately indeterminate. An unregistered destination
that already exists also fails indeterminate instead of being overwritten, while
a crash after Git registers the worktree adopts it on retry. Credential
preparation now has a production
executor and stable intent. It validates only a durable principal selector and
scope, records no token or Git environment, and returns an ordinary fenced
receipt. Branch effects can carry that selector and resolve its process-local Git
capability only when Git creation is necessary. Both fresh and restored MCP
creates emit the credential receipt before the credential-bound branch intent.
WebSocket creates and cold create-plan recovery use the same actor materializer,
including an explicit existing-branch flag for PR heads. No create entry point
calls Git worktree creation directly.
Sandbox preparation now has a production executor and stable receipt intent. Its
durable effect carries the complete non-secret provider/session specification;
the provider's idempotent `ensure` adopts resources by canonical session key.
Session-key or returned-provider crossover is indeterminate, and a crash after
provider acceptance re-enters the same ensure before returning the fenced actor
receipt. Create entry points emit this effect before opening a sandboxed run.

Opening turns also enter the durable outbox. Create intake first records the
stable prompt dispatch, then atomically moves the creation aggregate to
`opening_dispatched` with one `creation_opening_turn` effect and the bounded,
non-secret opening recovery input in the same actor transaction. The executor
uses the active create registration or reconstructs the specification from that
actor-owned input after restart. Schema 11 also keeps branch, workspace,
attachment, and resolved setup decisions as write-once actor state. Opening
launch atomically retires that setup state in favor of the exact opening input.
Pre-schema-11 create-plan files remain a read-only mixed-version import fallback;
production has no create-plan file writer. Terminal actor settlement clears the
large recovery input while retaining the permanent effect receipt. It settles
`ready` or `failed` through the effect fence before
acknowledging the prompt dispatch. Run-journal admission and cold
queue restoration preserve actor-owned create dispatches until that settlement.
Boot leaves local openings with the generic run adopter and settles the actor
from that adopter's fenced terminal callback; remote sandbox and Runner journals
are deferred to executors that can physically adopt them. Runner openings derive
one stable host identity from the opening run fence, persist the prompt and host
identities in the run journal, and advance a durable
`prepared → launching → started` launch phase in a session-keyed launch-state
file as well as the run journal. A prepared retry may launch; a definite server
preflight rejection records a permanent `rejected` fence, while ambiguous
launching/started failures are quarantined out of boot recovery. Ambiguous
adoption requires positive Runner liveness evidence and otherwise fails closed
instead of duplicating or later reviving a creation already reported failed. Long-running opening effects use a
separate bounded runtime pool so they cannot consume all general outbox capacity.
The terminal event consumer persists final session/outcome projections and settles
the actor before requesting another generator item, so local, sandbox, and Runner
generator `finally` blocks cannot retire the only physical-owner journal first.
If a backend naturally ends without a terminal event, its wrapper replaces the
live journal with a durable abnormal-completion receipt instead of clearing it;
boot recovery or the opening executor settles that receipt without relaunching.
A crash after actor settlement adopts the completed receipt without launching
another turn. Direct `opening_dispatched` transitions without a typed effect are rejected.
Schema 15 makes Stop terminal for that opening effect as well as its physical
turn. The creation actor records a `cancelled` receipt for the exact effect,
clears its recovery plan, and fences late success. Opening recovery checks the
durable stopped turn or its retained cancel receipt before launch and while
awaiting a detached local owner, so a restart cannot resurrect a cancelled
opening prompt. Runner, sandbox, and local openings use the same stable token
for actor admission and physical control, letting Stop reach the exact backend
without giving up restart adoption. Stop bookkeeping never depends on the
creation settlement succeeding: a concurrent opening result racing the cancel
read is logged and skipped, while the durable `prepare_cancel` commit, queue
persistence, and broadcast always run. Retained cancel receipts fence by exact
run id and generation, matching the opening they cancelled.
Non-image create attachments are durably spooled to bounded source references,
then copied or adopted at deterministic session-owned paths by
`creation_attachment_stage`; digest crossover fails closed and inline bodies
never enter actor payloads. Removing the remaining create-plan compatibility
authority is the next creation cutover; the presence or absence of a plan file
is not actor lifecycle evidence.

## Agent operation receipts (unwired foundation)

Schema 28 adds actor-owned Agent operation admission, transcript barriers, and
terminal receipts to the existing Agent operation v1 protocol and import-inert
gateway ledger. The internal facade is deliberately not composed at boot and
has no Host transport, provider/MCP adapter, credential resolution, live key,
or production operation route. It therefore performs no provider, MCP, socket,
executor, or transcript I/O and creates no executable production authority.

Each admit, settle, indeterminate, or exact query is one synchronous actor
reduction and one short SQLite transaction. Admission binds the exact turn
fence, operation identity and kind, descriptor and payload digests, adapter
identity, transcript input anchor, registered plan, and the current active
schema-27 signed supervision receipt. A caller-supplied authority hash is never
accepted independently of that stored signed row. Legacy unsigned receipts do
not authorize operations.

A turn has at most one admitted nonterminal operation. A model terminal declares
an ordered, bounded, unique set of pending tool-use entry IDs contained in its
terminal transcript receipts. MCP admission binds the exact next declared entry,
so distinct calls may proceed model, MCP, MCP. A successor anchor must
cumulatively cover every required transcript entry and change sequence, and the
next model is blocked until every declared MCP operation has settled. Physical
prepared and executing phases remain gateway-ledger state. Actor state
is only admitted, settled, or indeterminate. Indeterminate is visible terminal
state and blocks continuation until a future explicit actor-owned recovery
policy exists. Exact duplicate requests replay their original durable receipt;
identity or terminal crossover quarantines the session.

Terminal receipts and active operations are retained for at least seven days.
Expiry-aware pruning never removes an active operation or the latest dependency
for a turn. Per-turn and per-session receipt limits bound storage without a
fixed session or turn count, while a separate monotonic operation high-water
survives pruning and restart. Session deletion removes receipts and high-water
in the same tombstone transaction.

The shared gateway ledger requires an exact session/operation primary key plus
kind, full turn fence, plan and authority hashes, descriptor and physical
payload digests, and adapter ID/version. A mismatch is atomically quarantined
without replacing the original identity. Exact terminal replay returns the
canonical durable receipt. `prepared` means no physical invocation was allowed
to start and may be reauthorized after recovery. Once `executing` commits,
recovery requires explicit adapter proof; the default and initial adapter
contract is reconciliation unsupported and settles the row visibly as
`indeterminate`, never as a retry. The SessionKernel now admits and settles only these durable authority facts.
Gateway execution remains unwired. No actor mailbox is held across physical
provider, MCP, gateway-ledger, or transcript work.

## Detached Agent Host supervision

Schema 26 is an additive migration from live schemas 24 and 25 and raises the
normal `user_version` rollback floor, so an older actor refuses the migrated
store. Its receipt and plan backfill is transactional, crash-resumable, and
validates every canonical authority before raising that floor.
It adds a v2 Agent Host supervision authority consumed by the exact
production-unwired Agent Host wire protocol v3. Before any claim, a short typed SessionKernel
reduction registers the exact current run/generation, turn ID, and canonical
plan hash once. Exact registration replays and any mismatch fails closed. A
second short claim reduction must match that actor-owned plan, consumes a Host
challenge and nonce once, and monotonically advances a per-session supervisor
high-water mark. It binds the stable Host ID, Host generation and process
incarnation to the current kernel service epoch. Exact retries return the same
canonical immutable payload and bytes. A fresh challenge lets the same Host
generation recover after either its process incarnation or the kernel service
epoch changes; the higher supervisor epoch fences old control. Lower Host
generations and changed Host IDs remain stale.

The actor stores only bounded supervision metadata. It does not store prompts,
transcripts, provider/model configuration, MCP payloads, or credentials, and it
performs no provider, executor, model, socket, or signing work. Superseded and settled receipts remain replayable through their lease and clock
skew. The actor prunes only expired non-active receipts before enforcing its
fixed capacity; active and unexpired receipts are never pruned, and the separate
supervisor and Host-generation high-water marks survive terminal runs, pruning,
and restart. Legacy migrated payloads remain deliberately unsigned and provide no Host
authentication. New schema-27 receipts are signed atomically. The import-inert
wire-v3 Host consumes a fresh one-use challenge and strict V2 public keyring,
then verifies the signed envelope against the exact actor-issued attachment
descriptor before admitting one fenced turn. It is not referenced by boot or
existing Pi routing. Separate Host and gateway service identities, peer
credentials, keyring provisioning, and detached service deployment must land
before production wiring. The current shared Ubuntu identity is not a security
boundary.

The hardened detached-host target keeps provider and MCP access gateway-proxied;
ambiguous proxy outcomes are visible `indeterminate` failures rather than
silent retries. Host workers use blue/green replacement with a 24-hour maximum
worker lifetime. Kernel and Host services run as separate service users. Host
ledger admission has no fixed concurrent-turn count. A turn may accumulate at
most 32 MiB of actual worst-case physical charge. Ordinary growth stops at
448 MiB and a protected 64 MiB remains inside, not beyond, the same 512 MiB
physical ceiling for emergency-class transitions. The import-inert encrypted
ledger v1 and conservative page/WAL accounting prototype are present but remain
production-unwired. Bun SQLite cannot expose exact dirty-page/checkpoint-peak
attribution, so production composition remains blocked on calibration and
ENOSPC/checkpoint proof. Signed challenge leases are required before use, and
same-UID processes are explicitly not treated as a security boundary.

## Run ownership

Run state is durable and explicit. Run events are typed actor messages. The
Worker validates the transition, current run id and generation, then commits the
new state and change event in one SQLite transaction. This reducer remains
responsive even while a gateway command is waiting on external work.

Registering a new run id increments the session generation. Registering the
same logical run again, such as a detached host reconnect, keeps its generation.
Prompt preparation also takes the actor decision before installing any gateway
reservation. A rejected candidate remains a cancelled local token and cannot
replace or launch ahead of the actor's current run, even when the gateway lost
its in-memory projection of that owner.

Schema 14 moves normal and opening-turn terminal outcome persistence behind the
typed `turn_outcome_project` effect. The actor validates the immutable run id and
generation, durably stores one receipt per generation, and commits the outbox row
in the same transaction. Stable projection ids and timestamps make transcript
notices and session-file patches destination-idempotent. Multiple completed turns
may await projection without overwriting accepted work; execution defers later
generations behind an earlier live projection without consuming dead-letter
attempts. The executor commits the transcript, `lastRunError`, and worker-failure
notification before settling the exact actor receipt and acknowledging the
outbox. Replays of completed, stale, cancelled, replaced, or tombstoned owners do
not project onto a successor. Compatibility-only callers without a physical run
fence still use the old facade while their launch paths migrate.

Detached host events and direct side-effect frames (transcript, asks and failed
steers) are accepted only while their stable logical run id is current. An
input from an older physical host is audited, ignored, and that host is asked
to stop. A missing executor is not proof that a run is dead. Restart recovery retains
uncertain journals, refuses to replay persisted `starting` launches with
execution evidence, and settles durable kernel state only when no recoverable
journal owner exists. Stop retains that journal until the host reports terminal
or its launcher proves absence. Cancel and interrupt receipts bind to the run
generation and immutable dispatch identity present at admission, so replay
cannot affect a successor that reused its session or engine aliases.

## Mutation boundaries

The following public compatibility modules delegate writes to SessionKernel:

- `run-state.ts`
- `queue-state.ts`
- `asks.ts`
- `session-cache.ts`
- `transcript-store.ts`
- `session-control-wiring.ts`
- `ws-handlers.ts`

`updateSessionFile` remains the session JSON compatibility facade, but its
per-session serialization belongs to the kernel. Direct session JSON writes
outside that facade are rejected by a structural test.

The transcript database keeps its own `changeSeq`, which is the client replay
cursor. SessionKernel also records lifecycle and metadata changes in its own
change stream. Token deltas remain ephemeral.

## Timers and effects

A process timer is only a wake-up. The durable timer row is the authority. Timer
firing enters the same command mailbox with a deterministic request id. A
restart or duplicate wake therefore runs the decision once.

External effects can be added to the kernel outbox in the same transaction
that completes a command. Effect payloads and fenced results are discriminated
unions in `lifecycle-protocol.ts`. Executors register once by typed effect kind,
validate a persisted payload before physical work, and cannot replace another
executor for the same kind. Delivery is destination-idempotent at-least-once: a
crash after a destination accepts an effect but before acknowledgement retries
the stable effect id. It is exact-once only where the destination honors that
id. Each effect has a stable destination id and unique command-local key. Registered executors retry with exponential backoff; poison
effects dead-letter after a bounded attempt count. Unknown kinds remain queued but
are excluded from registered-kind work batches, so version skew cannot make them head-of-line block compatible work. Timers and
outbox effects both dead-letter after bounded attempts. Workspace admins can
inspect and paginate dead letters and quarantines, retry or discard dead timers
and outbox effects, and release a reconciled session quarantine through
`/api/system/session-kernel/dead-letters`.
Slack human-ask delivery was the first production handler and uses the ask id as
Slack `client_msg_id`. Durable timers use the same bounded backoff discipline.

The runtime starts only after run-host recovery and queue restoration establish
ownership. Any recovery-gate error fail-stops the gateway before timers or
outbox effects can run. Shutdown stops the runtime before draining the server.

Background intake observes the same process-wide shutdown fence. New cron,
automation webhook, GitHub review and queued boot-recovery work cannot start
after the fence. Automation triggers accepted before the fence write a bounded
pre-launch intent with a stable session id and acceptance time before setup.
The intent remains through physical execution: boot defers to an existing run
journal, while completed projection effects record a terminal receipt that boot can
settle without model replay. Ledger settlement precedes intent retirement.
Accepted setup remains part of bounded drain accounting until physical handoff. Review shutdown preserves its active-run/result marker
rather than treating restart as user cancellation.

## Read projections

The existing session-list cache, list snapshots, search index, and workspace
summaries are read projections. They may be rebuilt or served stale while a
refresh runs. Admission and recovery consult SessionKernel and the engine
control plane, never those projections.

Transcript clients already reconnect by durable `changeSeq`. This keeps a
future gateway process split mechanical: the gateway can translate commands
and replay committed changes without becoming another session owner.

## Process boundary

The writable stores and autonomous session coordinators run in the bounded
actor-host Worker pool behind `SessionKernelStoreHost`. The service mailbox is
the logical actor: it is created on first routing, serializes one session's
turns, and disappears when its queue drains. At activation, two rendezvous
candidates are compared by live lane load; the chosen lane remains pinned until
the mailbox drains. Worker-local kernel and transcript SQLite connections
activate lazily and are passivated by separate bounded LRUs. The pool scales to
available CPUs (16 session lanes on the production host), keeps a separate
compatibility catalog lane, and is bounded to 32 session lanes. `/ready` reports
per-lane queue occupancy, wait and processing time, restarts/timeouts, separate
kernel/transcript cache misses and evictions, and SQLite-busy events.
A session with no legacy durable rows is claimed in the placement catalog before
its first mutation, then writes only its own SQLite database. The schema-23
offline deploy migrator runs after gateway and actor shutdown, verifies each
unpublished target, and atomically switches placement while removing central
rows. The router never dual-writes authoritative state. Isolated outbox
rows use a globally reserved numeric identity allocated by the catalog so
existing settlement protocols remain additive and mixed-version safe.

Before every isolated mutation, the host durably marks that session's catalog
wake record dirty. A crash can therefore leave an extra scan but cannot hide a
committed timer or outbox item. Runtime reconciliation reads the authoritative
session database, dispatches due work, and repairs its next-wake projection.

The gateway starts and handshakes the actor host before hydrating projections. A
failed session-scoped critical settlement durably quarantines only that session,
suppresses its timer and outbox dispatch, and leaves reads and unrelated
sessions available. An isolated database infrastructure failure is recorded as
a catalog quarantine for that session. Catalog or legacy-store infrastructure
ambiguity still fail-stops the whole actor.

Sessions therefore converge on distinct physical databases and logical
mailboxes inside a bounded, independently supervised pool. A locked isolated
database has a 250 ms SQLite busy bound, after which that session is quarantined;
the compatibility gateway's synchronous bridge cannot inherit the central
store's five-second wait. Catalog-wide compatibility scans use read-only transient connections and paged
maintenance; their final decomposition is cleanup rather than an authority
change.

A command admission is a short bounded reduction: the actor fingerprints and
persists the intent, then immediately returns `execute`, `in_progress`, or the
committed result. It never awaits filesystem, network, process, sandbox, Runner,
or model work. Different command intents are interleaved as short serialized
reductions, and Stop or steering remains responsive while physical continuations
are queued or running. A restart re-admits replay-safe intent and marks ambiguous
non-replay-safe execution indeterminate.

Physical continuations run in the gateway process or executor processes outside
the actor. Their per-session mutex can queue physical work, but it does not hold
the actor mailbox. An exact retry of executing work receives `in_progress` immediately
rather than attaching an actor-held waiter. Typed completion and failure
reductions settle immutable receipts. A session-scoped settlement ambiguity
quarantines that session rather than committing over a successor or killing
unrelated sessions. Infrastructure ambiguity still fail-stops the actor client.

Transcript and session-file projections use typed admission and settlement
receipts, then mutate their specialized destination stores on the gateway thread.
The narrowly scoped `transcript_destination_append` command is replay-safe
because `transcripts.db` consumes the same stable append identity and stores an
immutable transactional result receipt. Legacy `transcript_append` remains
non-replay-safe. A crash after the transcript commit but before actor completion
therefore re-admits only the new command and reconciles from the destination
receipt. Admission and settlement are separate short actor reductions; SQLite,
bus publication, and append hooks never run while a session mailbox lease is
held.
The actor returns from admission before that destination work begins and retains
no execution waiter or callback. Extracting the Worker into the independently supervised local service was
therefore a transport and failure-isolation change, not an ownership migration;
no fallback writer is permitted.

## Tests

`session-kernel/kernel.test.ts` covers serialization, interrupted-command
re-admission, restart-persistent idempotency, generations, transactional
effects, timer/outbox backoff, dead-lettering, and passivation.

`session-kernel/actor-client.test.ts` exercises the Worker IPC boundary,
including cross-isolate serialization, duplicate-result replay, asynchronous
acknowledgement, quarantine, and response-buffer resizing.
`session-kernel/actor-service.test.ts` exercises authenticated HTTP transport,
version and incarnation fencing, readiness, the response bound, and actor
responsiveness. Web and native outbox tests pin request-id retention through
receipts.

`session-kernel/ownership.test.ts` pins the architectural boundary and rejects
new direct session-file writers. Existing queue, ask, journal, transcript,
host-client, and recovery suites exercise their compatibility facades through
the kernel.

## Writer claim and deletion fencing

The SQLite store carries a singleton writer claim with the process id and an
unpredictable owner token. Startup acquires that claim before checking or
migrating any other schema, so a losing process cannot modify a live actor's DB. A second live process cannot reset or process the
first process's commands. The database file is forced to mode `0600`.

Deleting a session first cancels its active engine or detached host and waits
for ownership to be released. If absence cannot be proven, deletion returns a
conflict and keeps the session. A successful serialized deletion removes its
session file and kernel runtime slots and leaves a permanent tombstone.
Transcript, search, sandbox, and Runner cleanup is best-effort. Workspace
metadata and optional worktree cleanup run after the tombstone; a failure can
leave retained resources even though late writes remain fenced. Recreating intentionally deleted work requires a
new request identity and therefore a new deterministic session id. Late executor
frames, run outcomes and queued commands cannot recreate the deleted session.

## Scheduled prompts

Scheduled prompt definitions remain in the JSON UI listing, while the kernel
timer is delivery authority. Boot rehydrates timers from that listing. Their
schedule id is also the prompt delivery id. A crash after queueing but before timer acknowledgement
adopts the existing queue or command receipt on retry. The former destructive
30-second polling loop is no longer part of delivery.

Slack ask escalation uses a stable human-ask id and Slack `client_msg_id`, so a
retry after an ambiguous network response asks the same external question
instead of posting a second one. GitHub conflict transitions likewise persist
their delivery intent until SessionControl durably admits it. Restored ask
answers keep their durable card until the stable continuation delivery is
admitted, so a restart cannot lose the answer between retirement and queueing.
Explicit Stop requests likewise enter through a typed turn command plan: the
actor permanently selects the original run id and generation before gateway
bookkeeping or physical cancellation, and an exact retry cannot target a
successor. Durable timer tokens also key typed actor begin/complete/fail
receipts. Once actor completion commits, recovery retires only that timer
generation without executing its handler again; a crash before that commit
remains destination-idempotent at-least-once delivery. SessionControl prompt
delivery uses the same pattern: the actor fingerprints the full immutable
delivery identity before slash handling, queueing or steering, then stores the
returned delivery result for exact caller replay.
