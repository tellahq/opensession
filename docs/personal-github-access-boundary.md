# Personal resource access boundary

Stage 2 of issue #390, following the verified-identity prerequisites. This is
still an incomplete feature. Personal provisioning remains unavailable and no
personal data should be imported on current deployments.

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

The list-index worker uses a shared-only SQL relation for its legacy selectors.
An owner/activity expression index keeps scoped counts and activity reads from
parsing every stored payload; query-plan tests verify indexed lookups for shared
and principal-scoped requests. Filtering happens before sidebar automation
ranking/counting and workspace selection, not in the browser. Explicit principal-aware get/count/list methods
exist at the store layer. Native session projections retain access scope, and
legacy cold-list assembly excludes nonshared inputs before alias merging.
Pending exports omit personal records: this stage must not repair their files
onto the shared host.

No catalog/list query enumerates or opens session actor databases. Repository operations and
session catalog reads route to the central catalog lane; schema migration adds
catalog indexes without actor enumeration.

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
- Collection responses still need authoritative scope-version/coverage fencing
  for preexisting warmed projections that incorrectly omit a private scope.
  Exact-id and alias reads recheck the central catalog; the separate list index
  filters its own payload, not a cross-database authoritative join. Do not use
  these projection-only predicates as the final private-list admission proof.
- All search/history/MCP, transcript-store raw operations, analytics/counts,
  notifications, user stores, outbound integrations, goals and automations need
  authoritative predicates, not merely a filtered session-list input.
- App-wide messages with nested references or repository/workspace payloads and
  `broadcastToUser` are not a private delivery channel. They must not carry
  personal content. Private terminal revocation after start and runner/Portal
  transports remain unimplemented.
- Fork/attach/duplicate/child/workflow scope inheritance and all recovery/run
  admission paths remain incomplete. Metadata ownership checks do not replace
  execution authorization. Deletion/revocation must retain enough scope history
  to prevent resurrecting private ids from stale shared exports.
- All live transcript/feed/presence delivery, including reconnect and stale
  watcher audiences, remains an admission gate. The restored synchronous hub
  has no private audience filtering. Do not publish personal frames there.
- Repository registration/discovery, catalog migration of shared config, App and
  grant storage/brokering, manifest ownership/replay checks, refresh/disconnect,
  credential fallback prevention, client cache isolation and UI remain pending.
- Shared-uid execution and storage isolation remain blockers. No admission flag
  or success path was added. No live data or registrations were imported.

Tests use synthetic two-user rows in memory/temp state, including a real
isolated kernel service RPC. They cover scope validation, owner predicates,
counts/ranking, conflicts, stale exports/aliases, unavailable authority, HTTP
and WS denial before dispatch, deferred navigation/cancel races, historical
asset aliases, and restored stream/commit ordering. Existing
shared auth contracts remain additive-compatible with native/Chrome clients;
this stage does not require them to understand `accessScope`. There is no UI
change, Portal, external GitHub verification, commit, push or deployment in
this worker stage.
