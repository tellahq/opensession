# Transcripts

How session transcripts are stored and served. Contributor doc. Nothing here
is operator configuration.

## The store

Open Session-owned transcripts are per-session, sequence-numbered event logs in
the same actor-owned SQLite file (WAL) as that session's kernel tables, under
`<sessions dir>/session-kernel-sessions/`. The central kernel database is only
the placement and wake catalog. `packages/core/opensession-server/src/server/transcript-store.ts`
owns the mature transcript schema inside each actor file. The retired shared
`<sessions dir>/transcripts.db` is left untouched after the offline authority
cutover as rollback evidence. External CLI/tmux and `plain-` sessions can remain
file-backed as described below.

- A row is one parsed `TranscriptEntry`: `(session_id, seq)` is the primary key,
  with dense 1-based `seq` values per session and unique `(session_id, uuid)`
  for deduplication. Re-appending an entry id updates the row in place while
  keeping its original `seq`. A separate monotonic `changeSeq` records every
  insert or rewrite, including rewrites of old sequence rows.
- Store keys are canonical Open Session ids (`os-…`, historical `bks-…`, and
  ingress session families), never engine session ids.
  `packages/core/opensession-server/src/server/transcript-persistence.ts` maps
  engine ids to canonical ids so engine-session rotation does not fragment a
  transcript. The map defaults to `<sessions dir>/engine-session-map.json` and
  can be redirected with `OPENSESSION_ENGINE_SESSION_MAP`.
- Serialized entries over 32 KiB keep the full JSON in `transcript_blobs` and a
  bounded form in `transcript_events`: content is clamped, tool input becomes a
  summary, and inline image data URLs become `os-blob:` markers. Full message
  and tool detail comes from `GET /api/sessions/:id/entry/:entryId`; image
  markers resolve through
  `GET /api/sessions/:id/transcript-image/:entryId/:index`.
- **Exactly one physical writer:** the independently supervised session actor
  worker owns every actor database. The gateway uses the bounded async
  transcript facade and only publishes post-commit bus wakes returned by the
  actor. Backfills and detached, sandbox, and remote run hosts relay bounded
  transcript batches through that facade; they never open actor databases.

The authority move is an offline, all-at-once operation. Stop the gateway,
executor, and session-kernel services, then run
`scripts/migrate-actor-transcripts.ts`. It fails closed unless all three units
report the explicit systemd state `inactive`. It enumerates the union of all
five source tables, every central durable session, and every shared-authority
placement, including sessions with no transcript rows, then migrates any legacy
central kernel state first. A transcript-only row with no kernel state receives
an offline-only isolated
placement whose authority remains `shared` until the final publication, so old
fixture/orphan evidence cannot be stranded behind the actor facade. The cutover
copies every transcript into its isolated kernel database in one transaction,
verifies global and per-table counts, bidirectional `EXCEPT`, sequence and
change-cursor invariants, reset/import high-waters, durable append receipts,
blob and outline coherence, and `integrity_check`, then atomically publishes
every central authority placement last. Rerunning adopts verified targets after
a crash before publication. A private read-only snapshot is attached for the
copy, so the shared source is never modified, removed, or chmodded and retains
its exact bytes and file mode even if migration is killed.

With all three services stopped, audit without creating placements or targets:

```sh
bun scripts/migrate-actor-transcripts.ts --audit
```

Perform the verified cutover:

```sh
bun scripts/migrate-actor-transcripts.ts
```

To deploy the old shared-store build again, first atomically roll every catalog
entry back to shared authority. Rollback verifies every actor transcript and
migration receipt against the frozen shared source before changing any catalog
entry. It fails closed if an actor-owned append, import, replacement, deletion,
or other divergence occurred after cutover; it cannot report success while the
shared source is stale:

```sh
bun scripts/migrate-actor-transcripts.ts --rollback
```

For future detached Agent Host recovery, the store also exposes a typed internal
`transcript_destination_append` API. This is deliberately separate from legacy
`transcript_append`, whose behavior and replay policy are unchanged. A request
carries an exact `{sessionId, runId, turnId, generation}` fence, a bounded
`appendId`, and bounded validated entries. `(sessionId, appendId)` is the
immutable destination identity. A domain-versioned SHA-256 digest binds the
canonical fence and exact entries payload.

The destination write and its immutable result receipt commit together in one
`BEGIN IMMEDIATE` transaction. Exact retries return the stored sequence and
change-sequence result without rewriting rows or notifying subscribers. The
first destination append for a never-imported store session marks it `live-only`
in that same transaction, as the existing first-live-append path does. An id
reused with another digest fails closed. Receipts survive import and
authoritative replacement, preventing an old append from being reapplied after
a reset, and are retained until atomic session deletion removes both transcript
rows and receipts. The destination-only method is internal and must be called
after short SessionKernel admission; it is not an HTTP route.

After each commit, the store publishes a wake-up on
`packages/core/opensession-server/src/server/transcript-bus.ts`. Seq-mode
watchers reconcile from SQLite by `changeSeq`; the in-process notification is
not itself the replay buffer. This avoids polling for server-owned sessions and
makes delayed or duplicate notifications harmless.

## Serving to clients

A client requests seq mode with `supportsSeq` on `watch`. The server uses it for
non-`plain-` sessions whose store is current and whose running process is owned
by Open Session:

- **Initial snapshot:** `transcript_init` has a floor of the latest 132 entries.
  It extends backward until it includes four user/assistant messages and, when
  tool work is present, at least one user boundary. Extension stops at 1,400
  rows or an estimated 850,000 wire bytes. Ordinary opening content is clamped
  to 8,192 characters; folded tool results and intermediate assistant notes
  get 512-character previews.
- **Index:** web clients advertising `supportsTranscriptIndex` receive a
  complete content-free `transcript_index` after the snapshot. It gives the
  virtualizer the full scroll range without downloading every message.
- **History:** indexed clients request visible sequence spans with
  `load_transcript_range`; each response is capped at 500 rows. Seq clients
  without the index page backward with `load_history {beforeSeq}` (40 rows by
  default, at most 500).
- **Live and resume:** `transcript_append` carries `seq`, `changeSeq`, and the
  latest durable change cursor. Clients that advertise `supportsChangeSeq`
  resume with `sinceChangeSeq`, so a rewrite of an old `seq` is not missed.
  Clients merge entries by id, not by assuming append sequence bounds always
  increase.
- **Collapsed detail:** snapshot, history, and range previews hydrate through
  `/api/sessions/:id/entry/:entryId` when web or native clients open them.
  Live appends retain the store's larger bounded form.

`transcript_outline` is a one-row-per-event structural projection maintained in
the same transaction as the canonical event. It contains ids, sequence and
change cursors, timestamps, display roles, content lengths, and review PR
numbers, but no message bodies. Existing sessions backfill this projection in
100-row yielding slices only when an indexed client opens them.

Externally owned running sessions (CLI/tmux), `plain-` sessions, clients without
`supportsSeq`, and watches whose import or freshness check cannot safely use
the store use the legacy file-watcher and byte-offset protocol. A legacy watch
polls the external transcript once per second and can feed parsed appends into
an already-imported store, but the running external session remains on the
legacy serving path. Watch-setup failures fall back to that path; the client
detects the active mode from the fields on `transcript_init`.

## Model-visible means logged

A turn's model input is more than the message a human typed: an engine handoff,
the per-turn repos and memory note, an attached session excerpt, ticket
context, and other injected blocks.
`packages/core/opensession-server/src/server/prompt-context.ts` fences prompt
payloads so the rendered conversation stays the human's own words.

`packages/core/opensession-server/src/server/context-log.ts` records those
payloads as ordinary `system` entries tagged `noticeKind:
"context-injection"`. Each carries the payload plus `contextInjection`
metadata (`source` and the `turnId` it rode with). Using the normal entry path
means oversized context gets the same blob split and no separate WebSocket
frame.

- **Choke point:** `runOnModel` in
  `packages/core/opensession-server/src/server/agent-runner.ts` logs every
  production Pi dispatch, every fallback hop, and the test fake. The Pi runner
  also logs a same-engine restart or resume-miss handoff that it adds below
  that point. Content-derived ids make overlapping records upsert one row.
- **Attribution rides the fence:** `wrapContext(body, source)` writes
  `<opensession:context source="…">`, and untagged blocks are logged as
  `unknown`. The system-channel repos note is logged explicitly because it
  does not ride in the prompt body.
- **Not conversation:** ordinary client transcript projections, handoff
  builders, and transcript excerpts exclude these records so they cannot be
  shown as authored messages or injected again. The dedicated session-context
  view described below intentionally exposes only the initial standing
  context.

### Standing context

Tool scope and standing instructions do not normally change every turn.
`logStandingContext` writes each source once per content hash and writes a new
version only when the content changes. These are ordinary `system` entries
with `noticeKind: "standing-context"` and `contextInjection` metadata
(`source`, `turnId`, `hash`, and UTF-8 `bytes`). The entry id is content
addressed, so reasserting the same version after a server restart upserts its
existing row instead of duplicating it.

Four sources are currently written:

| source          | written at                                      | content                                                                                                                              |
| --------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `tools`         | `runOnModel`                                    | Engine-neutral run scope: MCP allowlist, in-process servers, denied and confirmed tools, mode, and local-workspace-tool status       |
| `mcp-servers`   | Pi runner after tool policy                     | The effective MCP/discovery and local tool names, scope, strips, and optional oracle tool                                            |
| `instructions`  | Pi runner after `buildRunInstructions`          | Open Session's finalized instruction append, including the repos/memory note and local `AGENTS.local.md` / `CLAUDE.local.md` content |
| `session-start` | Pi runner after creating a fresh engine session | The final effective Pi system prompt, after AGENTS files, skills, and tool guidance, plus the active tool descriptions and schemas   |

The `session-start` source makes the initial provider system-and-tool context
exact for current Pi sessions, including tool schemas. The web viewer exposes
it as a collapsed, lazy-loaded **Session context** row through
`GET /api/sessions/:id/session-context`. Older sessions without that source get
a clearly marked partial reconstruction from `instructions`, `mcp-servers`,
and `tools`, with `repos-note` as a compatibility fallback when no
`instructions` record exists.

All standing records use the same `isContextInjection` predicate as per-turn
records, so ordinary transcript projections exclude both kinds. One known
ordering tradeoff remains: if a source changes A → B → A, the return to A
updates A's original row rather than appending a later copy.

## Imports and drift

Legacy transcript migration and maintenance preserve the single-writer rule:

- Production boot starts the one-time full backfill after 15 seconds. It is
  guarded by `<sessions dir>/.transcript-v2-backfill-done.json`; imports commit
  in chunks of at most 500 entries.
- On a seq watch, a never-imported legacy transcript of at most 2 MiB imports
  synchronously. Larger files queue a background import and that watch uses
  the legacy path; a later watch can upgrade to seq mode.
- A new store-only session is marked `live-only` on its first append. For
  legacy sessions, importing before live appends preserves history-first
  sequence order. Re-imports are idempotent by entry id and keep existing
  sequence numbers.
- Growth of an external transcript beyond its import watermark, or a recorded
  store-append failure, makes the store stale. The current watch uses the
  legacy path while an idempotent background re-import refreshes it.

The legacy parsers therefore remain for migration, external-session serving,
and freshness recovery, not as a second store for Open Session-owned runs.

## Adjacent pieces

- **Session metadata:** session JSON files are written through
  `updateSessionFile(sessionId, mutator)` in
  `packages/core/opensession-server/src/server/session-cache.ts`. A per-session
  mutex and session-owner admission serialize fresh-read, field-scoped,
  atomic writes; each write also increments the file's `rev`.
- **Engine boundary:** `EngineRunner` in
  `packages/core/opensession-server/src/server/agent-runner.ts` is the streamed
  engine contract used by the fallback walk and deterministic test fake. All
  production dispatch currently routes through
  `packages/core/opensession-server/src/server/pi-runner.ts`.
- **Snapshot fixtures:** scripted sessions run through the real pipeline with a
  fake engine, freezing both the stored entries and the prompt/config the
  engine received. See [transcript-snapshots.md](transcript-snapshots.md). A
  change to context fencing, tool scoping, or handoff notes appears as a
  fixture diff.
- **Deletion:** deleting a session purges its event, outline, blob, and
  transcript-session rows.
