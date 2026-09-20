# Session maintenance without source-directory scans

Live session-list and maintenance reads use complete central catalog projections.
Missing coverage or an unreadable projection is unavailable, not an empty store
and not permission to scan files. Seed a legacy installation with
`bun scripts/seed-session-metadata-catalog.ts` before starting it. This explicit
operator process may read source files; the gateway cannot. `opensession
service install` (what `install.sh` runs) and a foreground `opensession start`
run that seed themselves, after the kernel is up and before the gateway starts,
so a fresh install boots without a manual step; a compiled binary carries it as
`opensession seed-session-catalogs`. Once the metadata catalog and both agent
imports are marked complete the seed exits after checking those markers over
RPC and reads no source file, so an already-migrated instance pays nothing per
session; `--rescan` walks the files anyway.

## Live readers

- Slack and Linear startup restore from their imported catalog namespaces,
  including legacy timestamps and phase conversion. Targeted writes and deletes
  publish updated source projections.
- Analytics attributes sessions and Slack owners from catalogs. Concurrent cold
  requests share a refresh; failures never install an empty success cache.
- Title retries select at most ten eligible catalog rows. Plain cleanup rotates
  over at most forty active catalog candidates per sweep, without overlapping
  sweeps. A thread webhook also has a forty-session write bound; remaining
  candidates stay eligible for the next sweep.
- Identity backfill and orphan-transcript discovery are not boot operations.
  No maintenance path enumerates actor placements and opens every actor database.

The session-directory guard has no maintenance exceptions. Legacy _engine_
transcript discovery during a detail lookup remains separate: it can warm the
Claude transcript-path index asynchronously. These changes do not remove history
imports or claim that all filesystem I/O in the gateway has been eliminated.

## Configuration snapshots

`getConfig()` reads an asynchronously initialized snapshot, not a synchronous
file stat on each getter call. Active background readers initiate at most one
coalesced asynchronous refresh per second. Missing and invalid files retain the
existing portable-default behavior without repeated synchronous probes.

HTTP and UI WebSocket admission await `getConfigAsync()` before checking
identity/policy. Liveness endpoints do not wait for configuration storage.
Successful in-process settings writes publish immediately and fence older
in-flight reads. External atomic replacements are detected using inode, ctime,
mtime and size, including replacements preserving mtime and size.

Code that changes the configuration namespace (`OPENSESSION_CONFIG`, or its
HOME/state-root fallback) must await `getConfigAsync()` before calling typed
getters. An unloaded namespace throws rather than borrowing another root's
identity. Tests that directly rewrite a config file must also await that refresh;
production settings writers publish through `persistRawConfig`.

This removes the per-call config-file storm; it is not a claim that all remaining
gateway I/O or the exact callback behind the minute-long incident is resolved.

## Historical GitHub attribution

With GitHub sign-in enabled, preview the missing historical creator links:

```sh
bun scripts/migrate-session-github-users.ts --limit 50
```

The script uses the kernel RPC URL and credential-file configuration. It is
read-only unless `--apply` is supplied. Review the proposed mappings before
applying. Resume with `--after <returned cursor>` until `complete` is true.
Each invocation can write at most 100 actors (50 by default). Existing logins,
automation sessions and unknown creators are untouched. Each write re-evaluates
the current document rather than stamping a stale preview. No marker file or
startup directory scan controls completeness.

## Test isolation

`bun run check` launches each unit file with its own disposable HOME, config and
temporary directory, a minimal environment, and Bun's `--no-orphans` cleanup.
Snapshot tests use the same runner with their explicit runtime switches. The
`bunfig.toml` preload also isolates direct `bun test` invocations before any app
module loads. Intentional fixture overrides remain supported.

Operator config, state paths, service credentials and runtime bypasses are not
inherited. Moving a fixture's session-file root cannot leave its index in the
operator's HOME. Delayed publications finish inside the private test home before
it is removed.

## Reviewing old fixture residue

Do not delete sessions because their identifiers look unusual or their list rows
lack metadata. The list index is derived; transcripts, metadata, aliases and
references may still represent real work.

1. Keep a read-only inventory of suspect **central index** rows, metadata
   coverage and exact fixture provenance in the repository. Do not enumerate or
   open actor databases to build the inventory.
2. Run the source-catalog seed script with `--dry-run` in its separate operator
   process. Require zero uncovered sources, including agent namespaces and
   sidecars. Preserve aliases and archived records.
3. For any proposed derived-index repair, review the exact candidate IDs and
   confirm absence from complete authoritative sources, not merely one stale
   snapshot. Repairing a derived index is not authorization to delete actor data.
4. Transcript diagnosis is separately bounded and read-only:
   `bun scripts/diagnose-orphan-transcripts.ts <id> [<id> ...]` accepts 1..100
   explicit IDs, never a placement cursor. Missing coverage or actor authority
   refuses diagnosis; there is no fallback that opens the shared legacy database.
   known sessions, conversation records, recent records and large histories are
   kept. A proposed context-only orphan is still only a candidate.
5. Any actual transcript deletion needs a separately reviewed offline repair
   with a backup and an atomic revision/content fence. There is deliberately no
   live `--apply` path: a conversation appended after a dry run must not be lost.

These tools do not perform historical cleanup automatically.
