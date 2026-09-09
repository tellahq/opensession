# Gateway catalog ownership

The gateway must not perform synchronous filesystem, database, or subprocess
I/O. Background callbacks share its event loop with transcript watches and
HTTP requests, so moving a blocking read into a timer does not isolate it.

## Application documents

Workspace definitions, automation definitions, pins, lanes, snoozes, hides,
legacy settlements, and mentions live in the session kernel's **central**
catalog. They are not session actor records. `catalog-documents.ts` exposes
async reads and compare-and-set mutations through `sessionCatalogDocument`.
Neither a read nor a failed RPC falls back to a JSON file.

The kernel assigns document revisions. Mutators reapply on a conflict, so a
concurrent mention or preference delta cannot overwrite another update. A
delete keeps a tombstone and revision; a historical import cannot resurrect
it. A request-id replay is recognized while its committed revision is current.
Mutators must be pure because a conflict can invoke them again.

At boot, after the kernel connects and before list priming or request serving,
`importApplicationCatalog()` imports each legacy namespace once. It reads
only these application directories, never session actor databases. Seeds
insert only absent keys, then the catalog records the namespace's import
completion. An interrupted import can resume without overwriting newer state.
Missing directories are empty. Invalid JSON or a document larger than the
kernel's document bound fails boot instead of marking incomplete data imported.

Legacy files remain best-effort derived exports for operator tools. Writes
await the catalog commit and attempt an asynchronous export. An export failure
is logged without failing the committed mutation or suppressing its client
notification. The next write to that document retries the export in the same
process. These files are not an authoritative backup or a read-after-write API.
Fixing an export failure must not involve reading the old file back over the
committed document. Edits made directly to
an exported file after cutover are not imported by a later restart. Operators
must use the owning API. A rollback to a file-writing release needs an explicit
state reconciliation before returning to a catalog-owning release.

Per-user keys preserve canonical-name precedence and legacy spelling lookups
inside the database. These are indexed catalog keys, not filesystem probes.
Renaming a user copies state without overwriting an existing destination.

## Session list index

The materialized session list remains a derived index of actor-owned session
metadata and application overlays. Its SQLite handle lives in a dedicated
worker. The gateway sends async commands and waits for their replies. A slow
SQLite operation or busy timeout therefore does not stop the gateway heartbeat.
Queries after an acknowledged write observe that write; worker failure must
reject pending work rather than silently switching to synchronous SQLite.

The sidebar scope loader reads catalog documents, including automation
ownership and per-user overlays. It does not run automation scheduling logic
or scan definition files just to decide which rows a person can see.

## Remaining migration work

This establishes catalog ownership for the stores above and moves list-index
SQLite off the gateway. It does not certify the entire legacy gateway as free
of synchronous I/O. Existing session enrichment registries, legacy session
assembly, run-host bookkeeping, and other file-backed stores must be audited
and migrated separately. Do not use their existence as a precedent for adding
new blocking I/O or a synchronous fallback.

Tests cover import idempotency, catalog reads after legacy exports are removed
or corrupted, tombstones, concurrent mutations, durable reopen, worker
ordering, and worker failure. Runtime verification must also measure gateway
health during sidebar reads and writes; passing storage tests alone does not
prove the reported transcript stall has been eliminated.
