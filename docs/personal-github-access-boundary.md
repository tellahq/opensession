# Personal resource access boundary

Stages 2 and 3 of issue #390, following the verified-identity prerequisites. This is
still an incomplete application-privacy feature. Repository registration and
launch remain unavailable until the application guards are complete.

The human has explicitly accepted shared-host/operator access to private GitHub
credentials, code and transcripts, provided each connecting person acknowledges
a clear, versioned disclosure. This includes code running as the server's OS
account, not only root. Separate-host/privilege isolation is no longer a release
prerequisite. Consent to that hosting risk does not grant another authenticated
principal application/API/MCP access, and does not authorize private-to-shared
or other-owner context flow without an explicit export.

## Architecture

`shared/access-scope.ts` defines `AccessScope` as `{ kind: "shared" }` or
`{ kind: "personal", ownerGithubAccountId: number }`. The account id must be a
positive safe integer. An absent legacy field is shared; explicitly malformed,
null, unknown or ownerless personal scope is denied. An `AccessPrincipal` is
server-resolved `{ githubAccountId }`, never a body field, display name, admin
role or MCP capability. Omitted principals have shared authority only.

The existing worker-owned metadata catalog projects session scope from the
committed document. Exact-id, page and count predicates execute in SQLite
before results, pagination or aggregate counts leave the catalog. The internal
`catalog_read` result distinguishes found, missing and denied so an export/cache
fallback cannot turn a denial into a hit. Actor metadata reads and writes are
also scoped; mutation conflicts must not return another owner's document.
Ownership is immutable, including a lazy actor seed against an existing catalog
projection. Raw store access used by the catalog settler remains internal.

Schema 35 adds an authoritative central repository catalog with scoped
get/page/count and compare-and-set put operations. Personal writes require the
matching principal; conflicts and updates never expose another owner's record
or transfer ownership. This is a storage primitive, not an enabled import API.
The instance config registry refuses claimed nonshared/malformed repository
entries rather than stripping their scope and exposing them as shared. Shared
config repositories have not yet been migrated into the new repository catalog.

Schema 36 adds a durable central scope ledger and monotonic change clock.
Ledger claims and catalog writes settle in the same transaction. Ownership and
tombstones outlive metadata documents; seeds, reused ids and recovery cannot
resurrect a deleted id. Alias registration is transactional, rejects cross-owner
collisions/cycles, and flattens complete same-owner groups when canonical ids
merge. Deletion retains denial for every historical alias. Existing central
metadata and tombstones are migrated without opening other actor databases.

The list worker has an independent scope replica. Indexed deltas carry only
identity/owner/tombstone/version fields, not session documents. A page advances
coverage only to its last applied row, never to an unapplied advertised clock.
Replica reset creates a fresh nonce even when authority counters match. A new
authority incarnation invalidates old rows and coverage; backwards clocks fail
closed. Scope changes and all affected derived owner fields commit atomically
inside the list worker.

Counts, sidebar automation ranks, selected archived ids, workspace queries and
list predicates use an indexed scalar owner derived from this replica, never
from the caller's JSON scope. Stale, omitted or wrong-owner payload scopes are
overwritten from authority. Unknown claimed-private payloads stay hidden.
Private-owner collection queries fail unavailable if required private canonical
rows have not been materialized; a shared-only rebuild is not private coverage.

`withSessionScopeFence` brackets complete query/materialization/enrichment with
fresh authority checks. Cache snapshots carry authority incarnation, generation
and replica nonce. A concurrent change discards the result and permits one
bounded retry; failures never serve the old cache. Normal reads replay at most
eight indexed delta pages. Complete initial replay is an explicit boot job.
Requests do not run cold file scans: missing materialization starts one
coalesced recovery job and remains unavailable. Bootstrap filters source rows
against replicated authority before alias grouping or workspace/PR enrichment.
Catalog errors never permit a legacy export scan.

The synchronous `getCachedSessions` entry point now throws. Its production
callers await fenced snapshots, including workspace resolution, Desk state,
child-run holds, context notes, live-activity selection, session-control
list/get and their immediate Slack/GitHub/workflow adapters. Pure note rendering
accepts an explicit snapshot. Cached identity hints are not authorization;
engine-store async readers authorize the resolved resource before content reads.
Live activities remain shared-only, even for a private owner's registration.
Loop ticks coalesce, select a bounded fair batch, reauthorize exact ids, await
the durable timestamp, and release their guard on every error.

No scope/catalog/list query enumerates actor databases. Delta and owner/activity
indexes keep coverage checks and result selection off payload-wide scans.
Pending exports still omit personal records. No owner-aware public HTTP/WS
read context or personal admission success path is enabled by this stage.

## Enforced HTTP inventory

The guard runs immediately after auth in the ordered route chain, before media,
static assets, feeds or session handlers. These existing endpoints deliberately
retain **shared authority only**, including for a signed-in personal owner:

- `/api/sessions/:id` and all descendants: detail/delete; transcript, entries,
  images and subagents; overview/context; assets and notes; diff/files/git and
  branch operations; review; preview; prompt; archive/title/status.
- Exact collection GET `/api/sessions/search` and POST
  `/api/sessions/archive-old` are not interpreted as ids. Their existing list
  paths use the shared list/catalog selectors where integrated.
- `/api/files`, `/api/skills`, `/api/mention-suggestions`: `session` query field.
- POST `/api/automations/retrigger`: `sessionId` body field, read from a clone so
  the downstream handler still owns its request body.

Denial/unavailable authority returns a non-cacheable 404 before the downstream
handler. `findSessionAsync` preserves terminal denial through native export,
Slack and cached-alias fallbacks. A cached alias is rechecked against its
canonical catalog id. Missing-only legacy native fallback uses async file I/O
and rejects any nonshared or malformed scope even for its claimed owner.

## Enforced WebSocket inventory

Before mailbox admission, queue/ask mutation or terminal creation, the shared
session gate covers `command_ack`, `watch`, `load_transcript_index`,
`load_transcript_range`, `load_history`, `prompt`, `interrupt_prompt`,
`delete_queued_prompt`, `take_queued_prompt`, `take_steered_prompt`,
`update_queued_prompt`, `steer_queued_prompt`, `interrupt_queued_prompt`,
`reorder_queued_prompt`, `cancel`, `answer_question` and `term_start`.
Only cancel may use the already-watched id when none is supplied. Queue, ask and
receipt ids alone are not capabilities and cannot establish a session owner.
Client-supplied principal/user/scope fields grant nothing.

Sidebar row publication checks the catalog before returning a row or emitting
an existing private removed-id event. Full live delivery is **not protected by
this stage**. Review found that asynchronously admitting only hub frames races
the transcript bus, and coalescing full-document reads still creates token-rate
RPCs and retained closures. Those hotpath changes have been removed, restoring
the existing synchronous hub/feed and presence-handshake behavior. There is no
new delivery queue or settled permission cache, and no feed/presence privacy
claim. Admission must remain disabled until all producers share one bounded,
ordered, lightweight authorization path.

Watch generations are captured on arrival before authorization can await;
unwatch/close supersede pending watches. Id-less cancel captures the viewed id
before awaiting, canonicalizes it in the authorization result, and carries that
explicit target through mailbox and recursive dispatch. Authorized native
records retain only merge-generated alias metadata from the warmed projection,
not its stale content, so shared historical asset lookup remains intact.

Raw JSON is normalized at seed, settle, put and schema-35 migration boundaries.
A parser-based duplicate-key check quarantines ambiguous top-level scope or
nested owner/kind fields as `accessScope: null`. Other JSON is canonicalized
with the same parser as application reads, including exponent/decimal integer
encodings. Migration processes central tables and the one already-open actor,
never enumerates actor databases. The derived list index has a one-time matching
normalization marker.

## Remaining acceptance gates

Do not mistake this inventory for complete authorization coverage:

- Private owner-aware HTTP/WS dispatch, sidebar subscriptions and initial
  snapshots are not wired. Existing clients still have shared authority only.
- Other route identifier forms (workspace/repo ids, generic asset/media URLs,
  report/database/library ids, additional body/query selectors, operational
  recovery endpoints) need an explicit inventory and authorization integration.
- All search/history/MCP, transcript-store raw operations, analytics/counts,
  notifications, user stores, outbound integrations, goals and automations need
  authoritative predicates, not merely a filtered session-list input.
- App-wide messages with nested references or repository/workspace payloads and
  `broadcastToUser` are not a private delivery channel. They must not carry
  personal content. Private terminal revocation after start and runner/Portal
  transports remain unimplemented.
- Fork/attach/duplicate/child/workflow scope inheritance and all recovery/run
  admission paths remain incomplete. Persistent scope/tombstone/alias history now
  blocks reused-id and stale-export resurrection, but does not replace execution
  authorization or descendant scope validation.
- All live transcript/feed/presence delivery, including reconnect and stale
  watcher audiences, remains an admission gate. The restored synchronous hub
  has no private audience filtering. Do not publish personal frames there.
- Repository registration/discovery, catalog migration of shared config, App and
  grant storage/brokering, manifest ownership/replay checks, refresh/disconnect,
  credential fallback prevention, client cache isolation and UI remain pending.
- Shared-host risk now requires owner-bound, versioned connection disclosure,
  not separate-plane qualification. Repository/launch admission must still stay
  closed until ordinary application/API/MCP and data-flow guards are complete.
  This worker has not imported live personal data or changed registrations.

Tests use synthetic two-user rows in memory/temp state, including a real
isolated kernel service RPC. They cover scope validation, owner predicates,
counts/ranking, conflicts, stale exports/aliases, unavailable authority, HTTP
and WS denial before dispatch, deferred navigation/cancel races, historical
asset aliases, and restored stream/commit ordering. Existing
shared auth contracts remain additive-compatible with native/Chrome clients;
this stage does not require them to understand `accessScope`. There is no UI
change, Portal, external GitHub verification, commit, push or deployment in
this worker stage.

## Remaining work by implementation unit

1. **Owner read contexts and exact resource/mutation ACL:**
   `routes/session-access.ts`, `ws-session-access.ts`, `session-control-wiring.ts`,
   `session-create.ts`, `session-repos.ts`, `workflow-sessions.ts`, asset/media,
   workspace, PR and operational route families. Construct principals only from
   verified numeric sign-in or authenticated run authority; enforce descendants
   and attachments before work starts. Public legacy paths remain shared-only.
2. **Private content projection/recovery:** `session-cache.ts`,
   `session-list-store.ts`, `session-list-sqlite.ts` and catalog worker protocols.
   Populate private owner views through an explicitly authorized materializer.
   Missing private projection coverage currently refuses counts/lists rather
   than returning an apparently complete empty private view.
3. **Search/history and other catalogs:** `session-index.ts`,
   `session-search-store.ts`, history MCP, memories, raw transcript APIs, user
   stores, analytics and notification sources. History results are now checked
   against a fenced shared snapshot, but its legacy candidate query/ranking
   still needs worker-owned, pre-limit scoped search projections. This is not a
   private search release gate passed. Synchronous/raw content APIs need their
   own resource authorization; identity hints confer no access.
4. **Delivery:** `ws-hub.ts`, `transcript-bus.ts`, `transcript-watch.ts`,
   `session-feed.ts`, reconnect/presence and nested-reference broadcasts. Build
   one ordered, bounded, lightweight admission path for every producer before
   private audiences are permitted. The stage-2 partial async hotpath fix was
   deliberately removed and has not been reintroduced.
5. **Credentials, disclosure and revocation:** integrate the separately owned
   `personal-github/` broker/App/grant and durable shared-host disclosure modules.
   Preserve the org App. Bind imported repositories to immutable App record id,
   numeric installation/repository ids and access revision. Wire real catalog,
   session and run revocation acknowledgments before enabling consumers. Unknown
   consumers must fail, not receive a fake successful revocation. The retired
   separate-plane/private-runtime prototype is not a prerequisite or dependency.
6. **Clients and proof:** verified-principal cache keys, logout/account-switch
   clearing, supported-client capabilities, personal settings/picker UI, native
   and Chrome behavior, synthetic desktop/phone proof and external GitHub flow.
   No personal data may be admitted merely because the collection layer passes.
