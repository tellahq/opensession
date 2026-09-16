# Personal GitHub implementation

Issue #390: **connection setup, coordinator-backed registration and per-use credential resolution implemented**. Repository/session admission requires the real catalog/runtime coordinator to be installed; disclosure acknowledgement alone never enables it. These are source-level implementation notes, not a statement that this work has been deployed or verified against live GitHub.

## Accepted shared-host trust model

The person connecting must explicitly acknowledge the versioned disclosure:

> Your connection is personal, but the server is shared. Other Open Session users can use agents on this server to read your repository files, GitHub credentials, and session data. Server operators and anyone with administrator (root) access can also read them. Only connect repositories you trust these people and this server with.

The acknowledgement is informed consent, not proof of isolation. Mode 0700 directories and 0600 credential files are baseline hygiene; they do not protect against same-account agents, administrators or root. Independent infrastructure is not required under this accepted trust model. Ordinary application/API/MCP access must still enforce numeric ownership; accepting host trust does not authorize another person's ordinary application access.

No broad API privacy guarantee is made here. Without the real catalog/runtime coordinator, repository registration and session launch remain denied. The parent owns full end-to-end access enforcement and reviewed rollout.

## Identity and separate connections

GitHub device-flow identification retains the positive safe-integer account id returned by `GET /user`. The server-owned web session retains it through cookie/native bearer persistence and roster-name refresh. A login or display name is informational, never ownership authority. Legacy cookies are not upgraded by guessing an id; personal APIs require verified sign-in again. Automation/simple-mode attribution cannot establish a personal principal.

Personal App setup uses `/api/personal/github`, separate from administrator-owned organization App setup. The existing shared App, key, grants, sign-in configuration and webhook path are unchanged. Personal setup creates a private `public:false` User-owned App, with no webhook events or organization Members permission.

## Implemented connection path

1. `GET /api/personal/github/status` returns the verified owner id, current disclosure, secret-free App/installation/grant metadata and whether the real repository coordinator is installed (`repositoryAdmission`).
2. `POST /disclosure` requires the exact current version and `accepted:true`. Its expiring, single-use receipt binds the verified numeric owner, actual authenticated browser credential hash, origin and manifest operation.
3. `POST /manifest` consumes that receipt before generating GitHub's manifest form. Its state preserves the acknowledgement and the same bindings. A naked request flag or body-claimed identity cannot substitute for a receipt.
4. The callback consumes manifest state atomically before exchanging the code. It checks expiry/operation/origin/browser/owner and acknowledgement again before conversion and credential storage. Converted numeric owner must match and be a personal User, not an organization. Replay, concurrent replacement, account mismatch, nonempty webhook events and explicitly public responses fail closed.
5. Device-flow grants are verified with `/user`, persisted only for the issuing App and numeric owner, and refreshed under App-plus-owner locks. Temporary discovery tokens are revoked after use. No shared App, other owner's grant, ambient `gh`, SSH or personal-token fallback exists.
6. Refresh verifies the selected-access installation and returns a complete bounded owner-matching repository discovery list. This list is not registration or launch authority. With the real coordinator, `POST /api/personal/repos` revalidates the selection and commits the canonical descriptor to the central catalog under the broker's owner lane. It returns an opaque `registryId` for existing session-create; registered repositories are listed through owner-filtered `/api/repos`.
7. The internal runtime credential resolver revalidates the exact App/owner/repo/installation/revision and catalog binding on every use, returns a fresh canonical repository name, and delivers only a numeric repository-narrowed installation token: read for ask, write for all code turns. The App-wide user grant remains broker-internal for identity/discovery; legacy runtime `user` requests are rejected. Projected installation tokens are durably tracked and revoked before disconnect completes. There is no HTTP/MCP token endpoint.
8. Disconnect first records a deny barrier, invalidates pending receipts/flows, revokes GitHub grants and cleanup obligations, then deletes local App/grant credentials. Failure remains retryable and denied.

The callback returns minimal secret-free HTML linking to `/settings/myAccounts`. UI state must refetch the authenticated owner/status rather than trusting callback query fields.

## Worker-owned persistence and gateway boundary

`server/personal-github/connection-worker.ts` owns the connection engine, credential store and GitHub operations. The gateway sends bounded asynchronous RPC and receives explicit DTOs; it never reads credential files or executes conversion. There is no in-process fallback if the worker fails.

The connection store is under `stateDir("personal-github")`. It uses asynchronous filesystem operations, an exclusive OS `flock` writer, bounded owner lanes and CAS, detached reads, private-mode temporary writes, file fsync, atomic rename and directory fsync. The Linux lock helper has a fixed command and minimal environment; it receives no GitHub credentials. Unsupported/unavailable locking fails closed.

The initial schema explicitly permits **connections only** and requires an empty binding ledger. Before first catalog registration callback, storage durably switches to `catalog_bound` version 2. Lost callback acknowledgements or catalog commit ambiguity never restore version 1. Version 2 cannot reopen without the coordinator and cannot use a zero-consumer acknowledgement. Unknown/future schema, unknown fields or injected admitted bindings fail closed before disconnect acknowledgement. Without a coordinator the facade still exposes neither registration nor credential projection. The integrated facade has registration and an internal runtime-only resolver; only registration has an HTTP route. Zero-runtime-consumer acknowledgement applies solely to verified version-1 provenance, never version 2 or unknown consumers.

Admitted mode wires `PersonalRevocationSink.revoke(ref)` and `reconcile(ref, installationId, repositoryIds, accessRevision)` to authoritative catalog bindings, durable denial, central affected-session/run projections and cancellation acknowledgements. Callbacks use bounded worker-to-gateway RPC; they cannot re-enter the broker owner lane. The gateway coordinator serializes late callbacks with revocation. No actor-database fanout or blanket successful no-op is acceptable for admitted consumers.

## Remaining release gates

- Complete authoritative ownership and enforcement across HTTP, WebSocket delivery, search/history/MCP, counts, assets/files, previews/terminals, descendants, recovery and clients. Shared stays shared; missing personal ownership fails closed.
- Persist immutable numeric/opaque App-installation-repository bindings in the catalog and revalidate current access revisions at registration/use. A discovery DTO or browser-echoed descriptor is not a capability.
- Integrate revocation with actual running consumers before enabling registration, credential projection or session launch.
- Verify the manifest/device/install/refresh/revoke round-trip with an explicitly approved disposable live GitHub App. Synthetic tests do not prove live GitHub behavior.
- Complete reviewed desktop/phone UI and adversarial A/B access tests. Disclosure must appear when connecting and must not promise unfinished API privacy.

GitHub's conversion response does not reliably expose App visibility. The submitted manifest enforces `public:false`, explicit contrary responses are denied, and actual private installability remains a live verification gate. GitHub also provides no REST deletion endpoint for App registrations: rejected/storage-failed conversions require manual orphan App removal in GitHub settings. Disconnect revokes grants/local authority, not remote App registration. If both GitHub cleanup and local storage fail, cleanup cannot be promised; restore storage and revoke the grant/App before readmission.

## Verification scope

Tests use fake GitHub responses, generated synthetic keys and temporary local stores. They cover numeric identity, disclosure bindings/version/expiry, replay/concurrency, owner mismatches and renames, grant refresh/disconnect, immutable App/repo scoping, unknown durable bindings, bounded I/O, worker RPC allowlists and secret-free route responses. Real worker tests exercise status/disclosure/manifest generation and reverse-RPC revocation of synthetic records with no user/projected tokens, never a live GitHub call. Integrated tests also use the real central catalog with synthetic runtime acknowledgements and fake GitHub responses.

Existing sign-in native/Chrome wire consumers remain additive-compatible. No real GitHub credentials, repositories or API mutations were used in development. This component does not stage, commit, publish or deploy itself.

## Initial private-create scope

Private creation requires a compatible verified numeric principal and an atomic central owner/intent reservation before actor effects. Its isolated checkout is prepared for the actual canonical session id. Shared workspaces, forks, file and image attachments, account overrides, remote runtimes and nonempty MCP overrides are rejected rather than inherited. Pasted text remains supported. Private image ingress rejects staged paths, inline data and malformed payloads before readiness or reservation; shared upload storage and media serving do not supply a private owner-bound persistence contract.

Initial personal runs have an explicit empty MCP scope: no shared/default MCP grants or default AWS projection. Built-in local tools and explicitly projected personal Git/GH credentials remain available. Host, follow-up, fallback and recovery enforcement of that policy is a release gate; an unsupported execution path must deny, never downgrade to shared or in-process execution. Model selection/fallback alone does not relax the personal binding or host preflight.
