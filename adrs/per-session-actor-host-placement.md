# Per-session actor host placement

Status: Accepted for incremental implementation

## Context

Schema 21 made `SessionKernel` the single logical owner of lifecycle state but hosted every session in one Worker and one SQLite database. Schema 22 introduced a durable placement catalog and routes a newly mutated session with no legacy rows to its own database. Schema 23 adds bounded, verified cutover of legacy rows. This ADR defines the final placement model and the crash-safe path from that bridge.

The non-negotiable boundary is one logical actor, serial mailbox, and authoritative SQLite database per session. Logical actors are not operating-system processes. A separately supervised actor-host service runs a bounded pool of Worker isolates, activates actors lazily, and passivates idle actors. Network, model, sandbox, filesystem, and process work stays in gateway/executor processes and returns only fenced receipts.

## Existing durable surface

Schema 22 creates these tables in every `SessionKernelStore` because the same store implementation serves legacy and isolated databases:

| Table                             | Ownership after placement                                   | Purpose                                                                                                                                                            |
| --------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session_kernel_owner`            | system and session DB                                       | Single-writer process/incarnation claim.                                                                                                                           |
| `session_kernel_migrations`       | temporary compatibility in both                             | One-time schema/import markers. Session copies must not use this as routing authority.                                                                             |
| `session_kernel_tombstones`       | session DB                                                  | Permanent deletion fence. Legacy copies remain evidence until cleanup.                                                                                             |
| `session_kernel_quarantine`       | session DB; system DB only for storage/migration quarantine | Fail-closed ambiguous settlement and infrastructure quarantine.                                                                                                    |
| `session_kernel_placements`       | system DB only                                              | Durable route, conservative dirty wake bit, and derived next timer/outbox wake.                                                                                    |
| `session_kernel_outbox_routes`    | system DB only, temporary                                   | Globally unique numeric outbox ID to session route while numeric IDs remain in the wire protocol. Remove after effect receipts use session-scoped/string identity. |
| `session_kernel_state`            | session DB                                                  | Run state, run ID, generation, and change sequence.                                                                                                                |
| `session_kernel_creation`         | session DB                                                  | Creation state machine, setup/opening plan, and bounded effect receipts.                                                                                           |
| `session_kernel_asks`             | session DB                                                  | Blocking ask aggregate and revision.                                                                                                                               |
| `session_kernel_delivery`         | session DB                                                  | Prompt queue, dispatch, interrupt, steer receipts, and revision.                                                                                                   |
| `session_kernel_turn`             | session DB                                                  | Cancel aggregate.                                                                                                                                                  |
| `session_kernel_turn_projections` | session DB                                                  | Generation-fenced outcome projections.                                                                                                                             |
| `session_kernel_commands`         | session DB                                                  | Durable request journal, payload fingerprint, result, acknowledgement, and retry/indeterminate state.                                                              |
| `session_kernel_changes`          | session DB                                                  | Monotonic actor change stream.                                                                                                                                     |
| `session_kernel_timers`           | session DB                                                  | Durable timer authority, attempts, execution token, and dead-letter state.                                                                                         |
| `session_kernel_outbox`           | session DB                                                  | Durable external effects, stable effect identity, attempts, execution token, and dead-letter state.                                                                |

The final system database contains only process ownership, placements, storage quarantine, the repairable wake index, and the temporary numeric outbox route allocator. Schema 23 removes a session's central rows in the same transaction that publishes its placement and outbox routes, so retained central evidence can never be mistaken for a second authority.

## Existing command and effect surface

`SessionActorReducerCommand` is the authoritative reducer union. Its families are:

- `creation_event` and `run_event` state-machine decisions.
- `delivery`: snapshot/entries, durable submit request/complete/fail, queue slot set/delete/clear, steer prepare/accept/reject/requeue/recovery, interrupt prepare/begin/settle, and dispatch claim/ack/fail.
- `ask`: snapshot/entries/set/answer/delete/clear.
- `turn`: snapshot, cancel request/complete/fail, physical cancel prepare/begin/settle, and outcome projection prepare/begin/settle.
- `timer`: schedule/cancel/begin/complete/fail/runtime-failure.
- `gateway`: durable physical command request/complete/fail.
- `core`: enqueue/ack/defer/fail outbox, clear, and tombstone.

The compatibility `SessionKernelStoreApi` delegates older call sites into the same reducers/store. Routing metadata for that surface must be declared once and consumed by both the service router and worker dispatch. Adding another hand-maintained dispatch switch or method list is forbidden.

The typed effect union is session-owned: `human_ask_deliver`, `delivery_interrupt_cancel`, `turn_cancel`, `turn_outcome_project`, `creation_workspace_prepare`, `creation_branch_prepare`, `creation_sandbox_prepare`, `creation_credential_resolve`, `creation_attachment_stage`, and `creation_opening_turn`. Executors run outside actors. Results carry stable effect, run, generation, creation, and/or dispatch identities as applicable.

## Decision

### Actor host and bounded pool

The independently supervised actor-host service owns a bounded set of Worker isolates. The service router owns a mailbox per canonical session ID. It never dispatches two turns for one session concurrently. Each logical actor has stable affinity to one Worker lane while many actors share every lane; the database connection itself activates lazily and passivates under an LRU bound. Stable affinity keeps process-local reducer caches coherent without creating a Worker or process per session. A short isolated SQLite busy bound prevents one wait from indefinitely occupying its lane, while unrelated lanes continue.

Activation opens only the routed session database and validates its writer/route epoch. Passivation closes the connection after an idle deadline or under an LRU bound. A Worker crash rejects only its current turn as retryable/ambiguous according to the durable request journal, replaces that Worker, and leaves the actor-host service and other mailboxes alive. A critical settlement whose commit cannot be proven quarantines that session. A system-catalog ambiguity fail-stops the service.

During the compatibility stage, legacy sessions and global compatibility scans use a dedicated legacy/catalog lane. Isolated session turns use the bounded session lanes. Global maintenance is a barrier and must be decomposed into routed session work before central session tables can be removed.

### Routing and admission

A route lookup has three durable states:

1. No route and no legacy rows: in one system-DB transaction insert an `isolated` placement with a fresh route epoch and `needs_scan = 1`. Only after that commit may the first session DB mutation run.
2. No route and legacy rows: use the legacy mailbox/database until lazy migration acquires that session's admission fence.
3. An `isolated` route: dispatch only to the named session DB and route epoch. There is no writer fallback and no dual write.

The service uses typed, exhaustive routing metadata to derive the session ID before dispatch. Outbox-ID-only settlements resolve through the temporary system outbox route. Missing, conflicting, or ambiguous routing fails closed.

Before an isolated mutation the router commits `needs_scan = 1`. The actor then commits the session transaction. Repair may conservatively rescan extra work after a crash. It must never omit accepted timer/outbox work. After a scan, the router writes derived `next_timer_at` and `next_outbox_at`. The index is rebuilt by enumerating placements and querying each session DB.

### Offline legacy migration

The schema-23 deploy stops the gateway and actor service, then runs the resumable placement migrator as the only writer. Migration never occupies an actor turn or blocks Stop/steer behind filesystem work:

1. **Fence:** stop gateway admission and the actor service. The migration process claims the same durable single-writer lease before touching either authority.
2. **Snapshot:** copy every row for one session-owned table into a new unpublished database. Preserve numeric outbox IDs, command receipts, generations, tombstones, timers, attempts, execution tokens, quarantine, and change sequences.
3. **Verify:** compare counts and both-direction `EXCEPT` row sets for every table, then require `PRAGMA integrity_check = ok`. A mismatch leaves the central route authoritative and removes the unpublished target.
4. **Publish target:** checkpoint, fsync, and atomically rename the verified database to its content-addressed session path.
5. **Cut over:** in one immediate central transaction insert all temporary outbox routes and the isolated placement, then remove that session's central rows. This transaction is the linearization point. A crash before it leaves central state authoritative; after it only the complete target is authoritative.
6. **Activate:** after all remaining legacy rows are cut over, start the actor service and gateway. Normal routed turns lazily open targets and apply ordinary command-journal recovery. Durable dirty wake bits force timer/outbox rescan.

Each cutover is independently crash-safe. Rerunning the offline command resumes from central rows that still lack placements. No migration writes both authorities. Copying writes an unpublished target while central state remains authoritative. The cutover transaction removes central session rows as it publishes the route.

### Crash points and recovery

| Crash point                                   | Recovery                                                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Before route claim commit                     | No route exists; retry claim. No session mutation occurred.                                                                                   |
| After route claim, before first session write | Route exists with dirty wake; lazy activation opens an empty DB and retries the same durable request ID.                                      |
| During isolated transaction                   | SQLite rollback plus request journal semantics decide retry. Critical commit ambiguity quarantines only that session.                         |
| After isolated commit, before reply           | Replay returns the durable command/effect/timer receipt.                                                                                      |
| After isolated commit, before wake repair     | Dirty placement forces a rescan.                                                                                                              |
| Worker crash or timeout                       | Supervisor removes the Worker, preserves mailbox ordering, starts a replacement, and re-enters only replay-safe work. Other lanes continue.   |
| During migration snapshot or verification     | Delete/rebuild only the unpublished temporary target. Central rows remain authoritative.                                                      |
| After target rename, before route cutover     | No placement exists, so recovery may remove and rebuild the unpublished target from central rows.                                             |
| During cutover                                | Placement, outbox routes, and central-row removal commit or roll back together.                                                               |
| After cutover with unreadable target          | Quarantine that session. Do not silently recreate or fall back to central writes.                                                             |
| During deletion                               | Tombstone and ownership fences remain in the session authority. Route/evidence removal occurs only after physical ownership is proven absent. |
| System DB commit ambiguity                    | Fail-stop the actor host because route authority is unknown.                                                                                  |

## Compatibility and removal gates

- Central session tables remain structurally for mixed-version compatibility, but bounded maintenance drives their session row count to zero.
- `session_kernel_outbox_routes` remains until all consumers settle effects by `(session_id, effect_id)` rather than a global integer.
- Global ask/delivery import markers remain until legacy JSON import support is removed.
- The central WAL read mirror remains valid only for legacy compatibility reads. Routed reads for isolated sessions always enter the actor host.
- Global fan-out methods (`stats`, dead letters, migration imports, maintenance, wake work) must become catalog enumeration plus per-session mailbox requests before central session tables are dropped.
- Cleanup requires zero legacy routes, zero non-verified migrations, successful wake-index rebuild, verified backups, and a release gate that no older actor/schema can start.

## Consequences

This design bounds process count while preserving a distinct failure, backup, migration, quarantine, restart, and deletion radius per session. It introduces a small routing authority and requires explicit mailbox/barrier handling for compatibility-wide operations. Numeric outbox IDs and central legacy tables are acknowledged temporary costs with concrete removal gates, not permanent session authority.
