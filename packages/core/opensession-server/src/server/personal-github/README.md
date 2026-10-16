# Personal GitHub connection broker

Issue #390 component: connection setup, coordinator-backed repository registration
and internal per-use credential resolution. Repository admission requires the
installed real catalog/runtime coordinator, never just disclosure consent.
See [implementation status](../../../../../../docs/personal-github-implementation.md).

## Trust, identity and disclosure

The accepted threat model trusts server operators, same-system-account agents
and root-capable agents. Filesystem modes are hygiene, not isolation. No runtime
attestation, sandbox flag or private-cookie claim enables personal sessions.
Ordinary application/API/MCP ownership must still be enforced separately.

`disclosure.ts` owns the exact versioned text. The browser must display it and
explicitly acknowledge it when connecting. An expiring receipt binds verified
numeric owner, hash of the authenticated browser credential, exact origin and
`create_personal_github_app`. The engine consumes the receipt before manifest
creation and validates its preserved acknowledgement before both conversion and
credential storage. Receipt/state replay, changed owner/session/origin, expired
or superseded version and a body flag pretending to acknowledge are denied.
Acknowledgement metadata is stored with the App; no raw browser bearer is stored.

Positive safe-integer GitHub ids are authority. Login/display name is metadata.
No existing organization App, shared grant, global App-selection code, config or
webhook is repurposed. No `gh`, SSH or ambient credential fallback exists.

## Public HTTP contract

The route resolves numeric owner and actual authenticated browser credential
from server auth context, never JSON. Mutations require matching `Origin`.
All responses are non-cacheable. The gateway delegates asynchronously to the worker and does not read credential
storage or perform GitHub conversions. Its internal runtime-only resolver carries
credential results; HTTP and coordinator callbacks never contain tokens.

Successful JSON carries `ok:true` and `ownerGithubAccountId`. Failures carry
`ok:false,code,error` (401 sign-in denial retains the existing `code,error`
shape). Status DTOs are explicit projections, never spread broker records.

| Endpoint                                                | Input                     | Success                                                                                                                                                             |
| ------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/personal/github/status`                       | Verified sign-in          | `{ok,ownerGithubAccountId,disclosure:{version,text},repositoryAdmission:boolean,status:{runtime:"shared_trusted_host",needsDisconnect,app,installation,userGrant}}` |
| `POST /api/personal/github/disclosure`                  | `{version,accepted:true}` | `{ok,ownerGithubAccountId,disclosureReceipt,expiresAt}`                                                                                                             |
| `POST /api/personal/github/manifest`                    | `{disclosureReceipt}`     | `{ok,ownerGithubAccountId,action,manifest,state,expiresAt}`                                                                                                         |
| `GET /api/personal/github/manifest/callback?state&code` | Same owner/browser/origin | Minimal HTML with link to `/settings/myAccounts`; no upstream code/state/credentials rendered                                                                       |
| `POST /api/personal/github/grant`                       | Same verified owner       | `{ok,ownerGithubAccountId,flowId,userCode,verificationUri,interval,expiresIn}`                                                                                      |
| `POST /api/personal/github/grant/poll`                  | `{flowId}`                | `{ok,ownerGithubAccountId,status:"pending"                                                                                                                          | "connected"}` |
| `POST /api/personal/github/refresh`                     | Same verified owner       | `{ok,ownerGithubAccountId,repositories,installationId,accessRevision}`                                                                                              |
| `DELETE /api/personal/github/connection`                | Same verified owner       | `{ok,ownerGithubAccountId}`                                                                                                                                         |

`manifest` is already a JSON string for the form's hidden `manifest` field;
`action` already contains state. `verificationUri` is fixed to GitHub device
verification, not trusted from upstream. Device code/access/refresh tokens never
reach the browser. `slow_down` remains `pending` with server-side pacing.

`status.needsDisconnect` is true while a failed/revoking connection needs
cleanup; its App metadata remains visible so the owner can disconnect. A newly
created App with no installation yet can be installed and checked again.

Status fields (`null` until present):

- `app`: `recordId,githubAppId,slug,clientId,ownerLoginAtCreation,createdAt,installUrl,public:false,webhooks:"disabled"`.
- `installation`: `installationId,accountLogin,repositorySelection,suspended`.
- `userGrant`: `grantedLogin,connectedAt,expiresAt,needsReconnect`.

Repository discovery rows contain only
`repositoryId,name,fullName,ownerGithubAccountId,private,defaultBranch`.
`status.installation` is last verified metadata, not fresh authorization.

Error statuses: 401 verified sign-in missing; 403 wrong mutation origin;
400 malformed body/current disclosure missing; 404 missing/replayed/binding
mismatch; 409 App/grant already exists; 429 pending limit; 503 worker/GitHub/
storage/credential unavailable. Unknown paths are 404. `/api/personal/repos` registration is 503 without the
installed coordinator; discovery does not register anything. Use returned
`registryId` with existing session-create and list registered resources through
the owner-filtered `/api/repos`. Browser descriptors never authorize launch. The frontend must clear state on
authenticated numeric-owner change and discard stale other-owner responses.

## Production composition and durability

`service.ts:openTrustedHostConnections({directory,transport,now?})` constructs
`broker-core.ts` plus `engine.ts` over `trusted-host-store.ts`, returning `{connections,repositories,close}`. `repositories` is null unless a real
coordinator is supplied. It exposes `register` and `resolveCredential` only to
trusted server consumers. The HTTP handler exposes registration but no token
method. The worker allowlist cannot dispatch arbitrary broker methods.

`personalConnectionClient()` lazily starts `connection-worker.ts`. There is no
in-process fallback. The gateway owns only bounded RPC promises; the worker owns
secret-bearing state, GitHub transport, locks and asynchronous filesystem I/O.
Imports start no listener, timer, subprocess or filesystem operation.

Storage is `stateDir("personal-github")/connections.json`: at most 500 owners,
16 MiB, mode 0600 under a mode 0700 directory. An exclusive Linux `flock` held by
a fixed minimal-environment helper prevents concurrent writer snapshots; no
stale-PID unlink heuristic. File and directory fsync plus atomic rename provide
durable whole-snapshot CAS. Failure before promotion removes temporary output;
ambiguous filesystem failure after rename is an operational failure, not a
claim that GitHub/App cleanup completed. Unsupported OS locking fails closed.
No production credentials are used in tests.

Connection-only schema is `version:1,admission:"connections_only",bindings:[]`.
Before the FIRST registration callback, the worker durably migrates to
`version:2,admission:"catalog_bound",records:[...]`. A lost callback, late catalog
commit or ambiguous failure never downgrades it. Version 2 cannot reopen without
a coordinator; zero-consumer acknowledgement always throws for it. Unknown
schema and extra envelope/record fields remain denied. The worker rechecks that durable provenance. It never
accepts a caller/config declaration of no consumers. This is a zero-consumer
acknowledgement for a facade that cannot issue runtime bindings, **not** a
successful no-op sink for admitted repositories. Normal disconnect still
revokes the issuing App's GitHub user grant and pending token obligations.

`PersonalBrokerStore` requires detached reads and atomic CAS. Owner/app ids and
opaque record ids cannot change under updates. Owner uniqueness and GitHub
App-id uniqueness are checked in the serialized writer. Mutation lanes are
shared across requests: `owner:<id>` followed by `grant:<id>:<recordId>`; never
acquire them in reverse. Queues are bounded, idle lock entries removed.

There are no App-JWT or installation-token caches. Refresh rereads the exact
App+owner grant under its lock, caches only after CAS and verifies refreshed
numeric identity through `/user`. Initial grants cannot silently replace an
existing grant; refresh rotates, disconnect/new setup replaces. No credential
fallback is possible on a missing/suspended/revoking App.

Pending disclosure/manifest/device transactions are memory-only and invalidated
by restart. Stored App/grants/deny barriers survive. Disconnect cancels owner
receipts/flows even when no App exists. Retried disconnect continues the durable
deny barrier rather than restoring stale access.

## Catalog/runtime integration

Gateway boot installs `installPersonalRepositoryCoordinator(coordinator)` before
first `personalConnectionClient()` use. Idempotent hot-reload reinstall updates
callback functions in stateContext-keyed global state without replacing the
catalog-bound worker or its pending operations; dispatch uses the latest
coordinator. An already-started connection-only worker requires a gateway restart
to upgrade, never a silent in-place provenance change. Stage3's real adapter executes catalog
RPC and runtime cancellation on the gateway, never inside the credential worker.
Its callbacks `register(descriptor)`, `assertCurrent(owner,descriptor)`,
`revoke(ref)` and `reconcile(ref,installationId,ids,revision)` travel over bounded
reverse RPC with no secrets. Unknown methods, queue overflow and timeout deny.
Callbacks MUST NOT re-enter the broker. The gateway coordinator serializes per
owner even after worker timeout, so late register commit cannot outrun revoke.

Registration runs discovery and the catalog callback within the broker owner
mutation lane. Its descriptor's numeric/opaque tuple is immutable; fullName is
informational. The catalog returns a canonical opaque registry id. Neither
freezing the descriptor nor echoing it from a browser is authorization.

`personalConnectionClient().resolveCredential(owner,descriptor,kind)` is INTERNAL
runtime API; kinds are `installation-read` and `installation-write`, selected
only by existing trusted run policy. It verifies exact App/owner/repo/install and
access revision, calls catalog assertCurrent before/after, fresh-discovers GitHub
access and returns a fresh canonical fullName (never stale name authority).
Human and machine code both mint write tokens; ask mints read tokens. Runtime
minting always supplies exactly `[repositoryId]` and narrowed permissions.
Legacy `user` requests fail closed. User grants stay broker-internal for
identity/discovery, never runtime delivery. Metadata-only discovery minting is a
separate broker operation: it can omit repository ids and revokes in finally.
No shared/ambient fallback or HTTP/MCP token endpoint exists.

New policy cannot narrow old user tokens: if an older private build was used,
retire its hosts and revoke/reconnect prior grants before claiming cutover.
Use an immutable current release and fresh hosts; this source change performs
no rollout or existing-token revocation.

Every projected installation token is durably tracked BEFORE returning it. App
revocation first persists denial and awaits catalog/runtime consumers, then
revokes every unexpired projected token at GitHub; failure retains denied state
and cleanup obligations. Do not rely on the token's one-hour lifetime. Failed
uncommitted token cleanup is retained as denied/retryable state where storage is
available. If both storage and GitHub are unavailable, no credential is returned
and cleanup cannot be claimed. User grant revocation separately invalidates its
App-scoped user tokens. Status remains secret-free throughout.

The real sink must block catalog bindings, select affected sessions/runs from
central projections, cancel/revoke and await required acknowledgements. Unknown
consumers throw. No actor database fanout or zero-consumer fallback after v2.
Runtime consumers, session creation/recovery and broad application ACLs are owned
by the coordinator/runtime integration; broker tests alone do not prove them.

## GitHub protocol and bounds

Manifest requests `public:false`, personal User ownership, repository permissions
only, no Members permission, disabled hook and no events. Conversion checks
expected generated App name, numeric User owner, valid RSA key and empty events;
explicitly public responses are rejected. GitHub does not reliably return a
visibility field in conversion: submitted private intent is not independent
live installability proof. Verify the round-trip with a disposable App under
explicit human approval before claiming live GitHub verification. Confirmation
screen name edits are conservatively rejected.

Installations must all name the same numeric owner; exactly one selected-access,
unsuspended User installation is accepted. Repository ownership, safe path
components, full-name consistency, duplicates and complete discovery are checked.
Temporary metadata-only discovery tokens are revoked in `finally`; incomplete
verification/revocation blocks access rather than caching a partial success.

Bounds: 256-bit manifest/receipt state; 15-minute expiry; 64 pending globally,
3 receipts/manifests per owner; 64 devices globally, one per owner; 5–60 second
server-side device pacing; 8 KiB HTTP bodies; 64 gateway/worker pending calls;
16 per-owner lane waiters; 16 KiB GitHub bodies, 8 KiB header values; fixed API/
OAuth hosts and redirect rejection; 15-second transport/body deadlines (30-second
maximum configurable); 256 KiB ordinary/1 MiB list responses; 3 installation
pages or 5 repo pages of 100, with actual returned page size checked.

GitHub has no REST App-registration deletion endpoint. Rejected/storage-failed
conversion drops secrets and requires manual orphan App removal. Disconnect
revokes grants/local authority, not the remote App registration. Uncommitted
wrong-owner or storage-failed user tokens are revoked through the issuing App;
transient cleanup failure creates a bounded private retry obligation and denies
access. If GitHub cleanup and local storage both fail, cleanup is not guaranteed.
JS strings are not reliably zeroizable; operator trust includes memory/log/dump
administration, not just filesystem permissions.

## Tests

Run the folder suite plus `server/routes/personal-github.test.ts` and
`server/personal-access.test.ts`. Fake GitHub responses/generated synthetic RSA
keys/temp storage cover disclosure, identity, replay/races, refresh/disconnect,
CAS/restart, injected future bindings, DTO/HTTP boundaries and limits. The real
worker RPC smoke test never invokes GitHub. Tests prove neither live GitHub
behavior nor full application ACL coverage. No staging/publication/deployment is
performed by this worker component.
