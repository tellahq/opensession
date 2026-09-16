# Personal repository runtime on the shared host

This implements application-level owner/credential selection, **not OS isolation**.
Other Open Session users can use agents on this shared server to read repository
files, GitHub credentials and session data, as can server operators and anyone
with administrator (root) access. The accepted disclosure states this explicitly. The retired private
control-plane prototype is not a prerequisite and is not restored here.

## Gateway integration contract

Use `personalRepoRuntime()` from
`server/personal-repo-runtime-default.ts` after installing the gateway's personal
repository coordinator into the App worker client. The factory performs no
import-time startup and never adds a personal record to global config.

- `resolve(ownerNumeric, registryId, expectedBinding?)` returns immutable
  `{repo: Readonly<Repo>, binding}`. It reads the owner-aware central catalog,
  rejects blocked/missing/foreign/stale identity, asks the broker for the exact
  personal App's repository-read credential, and resolves the real default
  branch. `Repo.ghRepo` uses the broker's current canonical `fullName`.
- `prepare(ownerNumeric, binding, {sessionId, mode, branch?})` returns
  `{repo, binding, cwd, branch, mode}`. Use this same entrypoint for creation,
  recovery and attached repositories. Persist its returned branch. Paths derive
  from numeric owner, a hash of registry id and a hash of the owning session id.
  Never pass a browser path or a `getRepo()` result. Attached repositories use
  the owning session id and their own distinct binding/registry id.
- `assertWorkspace(owner, binding, sessionId, cwd)` revalidates the catalog,
  exact derived path, real Git common directory/toplevel/HEAD and raw plus
  effective remote URLs using the broker's current read-credential locator.
  A persisted path is not authority.
- `projectWorkspaceCredential(owner, binding, kind, {sessionId, cwd})` is the
  detached launch/respawn admission operation. It compares the final credential's
  `fullName` with the resolved config, then validates the existing workspace
  against that final credential/locator before returning `{repo, binding, kind,
fullName, expiresAt, env}`. It neither fetches nor repairs the existing checkout
  during that final validation.
- `projectCredential(owner, binding, kind)` returns ephemeral
  `{binding, kind, fullName, expiresAt, env}`. It must never enter session metadata,
  transcripts, journals, a `RunHostSpec`, logs or an HTTP/MCP response. Only the
  fixed per-host credential file and runner environment consume it.

The binding is `{registryId, descriptor: PersonalRepositoryDescriptor}`. It
contains the immutable numeric owner/App/installation/repository tuple and
`accessRevision`, but no token, arbitrary config or path. Display-name changes
are not identity changes. A renamed existing clone whose recorded origin differs
from the fresh canonical URL currently fails closed; there is no automatic
origin rewrite/migration or org fallback. Final admission checks raw locators
(for gh) and effective fetch/push URLs (including includes, per-worktree config,
`pushurl`, URL rewrites and branch/default push selectors). Every configured
remote must still address the same canonical HTTPS repository; alternate
repository/transport destinations are rejected, not rewritten. Discovery runs
outside the gateway's ambient checkout, with Git discovery bounded to the
personal namespace.

Admission proves repository identity, not an originally prepared branch. Same
repository branch changes and detached HEAD remain valid for launch/respawn;
explicit preparation/publication-policy branch restrictions remain separate.
This is a pre-admission snapshot, not perpetual enforcement against subsequent
GitHub renames or local configuration changes during an already-running process.

`Repo.repo` is a seed checkout, **not** a model working directory. Always use
`prepare().cwd`; never fall back to that seed, the instance default, an ask
checkout or a global registry lookup. The adapter rejects symlinked paths and
wrong Git common-directory/origin/branch identity. Recovery restores an existing
branch into the same derived worktree, without resetting files. Per-repository
mutation lanes serialize preparation inside the gateway.

Git setup receives an explicit environment, no inherited SSH/Git/gh credentials,
noninteractive HTTPS helper projection, a per-repository owner home/gh directory,
and disabled system/global Git config, hooks, file and ext transports. Tokens
never appear in clone URLs, arguments or `.git/config`. Git errors are redacted.
The adapter executes no repository setup/dependency scripts on the gateway.

## Credential and run policy

Personal Pi runs take a mandatory branch **before** ordinary ask, connected-user,
organization App or launcher-token selection:

| Trusted existing run classification | Personal credential  |
| ----------------------------------- | -------------------- |
| Ask                                 | `installation-read`  |
| Human code turn                     | `installation-write` |
| Machine/unattended code turn        | `installation-write` |

The broker validates current App state, numeric repository ownership,
installation and revision, performs current GitHub discovery and catalog
callbacks, and narrows installation tokens to the numeric repository id.
Denied/unavailable resolution is terminal. There is no shared-person, shared-App,
ambient credential or other-owner/App fallback. MCP allowlists, unattended tool
policy and publication guards are not enlarged by a personal binding.

Gateway classification runs in a bounded, lazy policy worker because existing
roster/persona helpers read configuration synchronously. The host uses the same
classifier locally. Missing journal kind normalizes to `prompt`, matching the
host entrypoint. Existing roster tables are a boot snapshot; mismatched policy
at admission fails closed rather than changing credential kind.

Shared GitHub selection remains unchanged. The ordinary runner's shared Git
identity/attribution setup is also unchanged; the new personal branch selects
repository credentials, not a new commit-attribution policy.

## Compatible detached launch, before execution

Personal model execution does not move into the gateway. Unsupported detached
hosts fail closed, including the ordinary non-systemd/in-process fallback.
Gateway preparation can clone and resolve metadata, but model config/credential
consumption requires the dedicated host preflight.

1. `HostedRunOpts.personalRepo` and internal `RunHostSpec.personalRepo` carry only
   the nonsecret binding. The hosted journal retains it; respawn copies it to a
   fresh host id. The owning session/recovery caller must preserve it and must
   not adopt/steer an older host without the same personal identity.
2. The gateway invokes `verifyPersonalRunHostHelper()` from
   `executor/host-unit.ts`, a fixed `sudo -n opensession-run-host check-personal`.
   This is a real runtime compatibility check, not a configured ready flag.
3. Every launch/respawn revalidates the catalog, workspace and broker and writes
   `personal-github-auth.json` in that exact host directory. The private-mode
   file is atomically published without replacement. It binds owner, complete
   tuple/revision, host id, session id, exact spec hash, cwd and credential kind.
   The bearer never enters the spec, argv or normal journal.
4. The executor selects fixed `launch-personal` from the persisted spec. The
   installed helper's ordinary `launch` rejects any spec containing a personal
   field. Consequently an old executor cannot silently choose the shared path.
5. The helper checks the source `runner-host/personal-host.ts` entrypoint, or
   runs the compiled executable's fixed `personal-runner-capability` query as
   the service uid with minimal environment, ten-second timeout, pipefail and
   bounded output. Exact response: `personal-runner-host-v2`. Old helpers,
   or unsupported compiled binaries are rejected. Source-mode entrypoint existence
   is not proof of its validator version; use an immutable current release and
   fresh hosts for the installation-only policy.
6. The dedicated entrypoint validates exact spec bytes/hash and the mode-0600,
   non-symlink, same-service-uid projection before importing the host/engine.
   It consumes/unlinks the file and retains the credential only in that one
   host's memory. The ordinary host also refuses personal work without adoption.
   Pi reads this adopted projection, never starts a second broker/catalog in
   the detached host and never consults shared credential selectors.

`admitUntil` is a one-use startup deadline of at most five minutes. It is separate
from `expiresAt`, the finite installation-token expiry. Null, nonfinite, expired
and legacy `user` projections fail closed at writing, adoption and later access.
Once admitted, later provider retries/config lookups are not cut off by the
startup deadline. They reject at actual token expiry. This is **not** a per-tool
expiry interceptor: an already-built child environment retains its token;
GitHub enforces token expiry/revocation, while catalog/runtime revocation must
cancel affected active work. A new host/recovery always obtains a fresh token.

Known executor/direct launch failure first proves the exact host absent, then
removes only its matching projection. Missing means preflight already consumed
it. Unknown absence, ambiguous launch, mismatched or pre-existing projection
remain denied/uncertain; neither this cleanup nor outer recursive spawn cleanup
may erase a possibly live launch's credential. This allows safe fresh retries
without retaining a rejected launch's bearer.

## Deployment and remaining integration

The root helper remains version 2 for ordinary shared compatibility. Personal
support is negotiated separately. The updated installer requires system Python
3 for root-side data-only JSON parsing, Bash, `timeout` and `runuser`; it does
not execute service-owned JS as root. It creates no users, changes no workload
privilege policy and adds no new sudo grant.

After parent review, passing repository checks and publication, this change
requires the documented **full root deploy**, not just service restart or ordinary
frontend/self-deploy. That installs the new helper and pins the complete source
or compiled release before restarting the normal executor/kernel/gateway stack.
Only the parent performs that operation. The helper's existing service uid,
environment and systemd resource/capacity policy remain unchanged.

Compiled releases must include `personal-repo-runtime-policy-worker.js` and
`personal-github-connection-worker.js` beside the executable. Both are in the
existing `WORKER_SIDECARS` build/staging list and selected through `workerEntry`.
A raw source Worker URL is not sufficient in a compiled Bun executable: an
actual compiled smoke test exposed that failure before the sidecars were wired.
The compiled policy and connection workers were then exercised successfully
with synthetic configuration/store state and no GitHub requests.

The internal runner protocol field is additive; native/Chrome browser wire
models do not change. Personal remote/sandbox providers must stay rejected until
they implement equivalent verified preflight/projection and revocation. No host
or provider fallback may turn a failed personal request into shared execution.

Stage 3 owns create/run/attach/recovery callers, central owner catalog and ledger,
private session persistence, and active-run revocation. It must preserve bindings
through descendants and attached-repository operations, deny old-host mismatch,
and use this interface rather than global worktree/config helpers. The App worker
owns credential issuance/revocation and coordinator callbacks. A coordinator
callback must never re-enter the broker's owner lock.

## Durable logical and physical retirement

Personal specs require a nonsecret `logicalRunId` matching the original journal
`runKey`. It survives physical host replacement and is covered by the spec
hash. Missing, malformed or mismatched personal lineage is rejected; shared
legacy specs remain compatible.

`stopPersonalHostAndConfirm(consumer)` accepts the original
`{runKey, hostId, sessionId, binding}` and returns only
`{state: "absent", consumer}`. It checks exact enrollment and persisted spec,
commits logical stop intent, and serializes short physical transitions by both
logical lineage and host. Credential/workspace preparation is outside these
locks; final dispatch rechecks intent after preparation. A never-dispatched
fact is minted only by exclusive spec creation, never by caller metadata.
Transition entries and lock tails survive module refresh in a shared registry
keyed by StateContext and exact host directory. Mixed/repointed pinned paths
reject until runtime reinitialization instead of reading another state directory.
Opaque lifetime and publication-access associations also survive compatible
module refresh.

Executor dispatches (including unknown ones after restart) require a validated
`stop_host` receipt before actual unit/cgroup/process absence checks. An empty
busy cache, cancellation latch, missing socket or currently inactive unit alone
is not confirmation. Unknown/unavailable executor state stays indexed and fails
closed, including a cold restart that lost evidence of a never-dispatched or
direct launch. All new stop probes and credential reads are asynchronous and do
not re-enter the personal broker. The executor tolerates an already-collected
unit's failed stop only after the exact in-flight launch has drained and both
unit/readiness probes explicitly return false. This records a dispatch barrier,
not a substitute for the gateway's separate cgroup/process absence proof.

Respawn exports and enrolls the successor and awaits its journal callback before
confirming/removing the old physical consumer. Physical-only confirmation leaves
the logical lineage open; logical retirement fences every later physical host.
A crash between predecessor confirmation and successor launch therefore leaves
the successor spec and journal recoverable. Host journal clears use awaited
`journalClearIfLineageAsync` with the original record, not a current alias.
Host-change journal writes pass the exact predecessor as `replaces`; ordinary
per-event journal updates cannot roll a successor back to an old physical host.

Private consumer completion is explicit. `runAgentHosted` and the auxiliary
variant return an async generator with an opaque lifetime attached at creation.
`resumeLocalHostRun` attaches the same lifetime to its returned Promise and, if
present, its eventual generator. Capture that original object and call
`await finalizeHostedRun(source)` in the consumer's `finally`, **after** all
model-derived completion writes. Do this even for zero events, first-next
failure, early break or throwing postprocessing, and for every separate attempt.

The lifetime tracks validated same-logical-run physical consumers independently
of the last event. Finalization is idempotent, closes further dispatch, positively
stops/proves each outstanding host and commits retirement; uncertainty retains
retryable obligations. Normal `HostHandle.finish` preserves the last producer's
context/enrollment/spec for post-loop writes. Revocation can stop and confirm
immediately without waiting on those writes or a broker-dependent consumer.

## Initial private MCP surface

Private runs require explicit `mcpServers: []`, `proxyMcpServers: []`, no RPC
grant, and no in-process MCP configs. Opening, detached preflight, each model
fallback hop and Pi retry enforce this. Pi never invokes the shared MCP loader
for a private run, even for configuration discovery. Its MCP catalog and
discovery tools are empty; existing SDK extension auto-loading is disabled.
Built-in local tools and the projected personal Git/GH environment remain.

Non-delegating Pi provider models are supported. Dial/orchestrator paths and
synthetic/private out-of-workspace paths are rejected rather than inheriting
shared controls. No claim is made that broad interactive MCP sinks are scoped
for private data. Shared runs retain their existing MCP behavior.

## Gateway publication provenance

`bindHostPublication` validates the original personal descriptor and exact
workspace, requires ready audience authority, and captures immutable publication
and execution-access contexts. It snapshots only session/cwd/binding plus
logical and physical ids, not prompt or image payloads. Reconnect retains its
physical context. An authorized respawn receives a **new** physical context via
`bindSessionPublicationSuccessor`, preserving the original audience owner,
incarnation, resource generation, binding and logical id. It never looks up a
new owner from a late callback's session alias.

Each socket callback, queued projection, ask continuation, journal task and event
captures its own physical context at acceptance. Queued A work keeps A when B
starts; its irreversible abort signal cannot be renewed into B. Queued
projections drain before retiring A where possible. Frames, asks and terminal
receipts check that captured context, including after journal awaits. No token-rate authority RPC or additional
payload queue is introduced. Recovery also requires the saved spec and original
journal binding to agree, including before offline terminal delivery. Private
terminal metadata must also identify the exact host and session. The host path
explicitly enrolls initial and successor consumers separately from journal
persistence. Enrollment stores the authenticated admission's original authority
incarnation/resource generation. Host and recovery capture validate those
persisted stamps; current catalog state can invalidate, never replace them.

Private boot recovery binds pre-event reattach transitions, events and terminal
work to original journal/enrollment authority. Unknown, unstamped or retired
sources preserve evidence rather than invoking unqualified failure callbacks.
Recovery bookkeeping revalidates after awaited reattach control operations,
so revocation cannot reset attempt counters or erase retained evidence.

Revocation suppresses data, not physical cleanup. An explicit end, an ended
hello followed by catch-up, or an identified absent host's terminal receipt
still retires that exact host control without delivering its payload. A live
host's catch-up marker alone never proves completion. Successor controls are
not unregistered. Revocation coordination still owns durable confirmation/enrollment retirement
when the event consumer has already stopped; the stop export provides the exact
physical absence receipt and retires only the matching in-memory control.

Private stream events carry an internal symbol tag, preserved by object spread
and omitted by JSON. Consumers explicitly use
`withHostedEventPublication(event, work, true)`; missing tags deny and stale tags
skip work instead of inheriting a fixed-A or current-alias scope. The tagged
context carries original binding, exact consumer and execution access into the
actor client's commit fence. The actor-side ownership/retirement check through
commit remains necessary for writes already dispatched before revocation;
hot-path checks alone are not an atomic database fence.

## Verification

Focused tests cover immutable resolution without global registration, wrong
owner/blocked/stale/changed App rejection before Git, exact credential provenance,
recovery and attachments, revocation during preparation, real temporary Git
clone/worktree/revival with a synthetic-only local transport, symlink rejection,
Pi selection and unchanged shared credential behavior, no in-process fallback,
private-mode one-use projection, old-host preflight refusal, post-five-minute
credential lifetime, and executor/direct-failure cleanup with ambiguity retention.
Publication tests cover owner changes, same-owner authority replacement,
same-incarnation resource rehoming, ordinary same-owner metadata updates,
revocation during queued persistence/asks, unchanged shared delivery, and no
per-token catalog calls.

The actual helper shell is exercised as an unprivileged synthetic fixture. Only
root/config/account bootstrap is substituted; JSON policy and launch argv run
against a recording systemd stub. This does not claim a live root installation
or real service launch. Shell syntax checks pass. The full compiled main builds
and its capability command was executed with an empty synthetic HOME/state,
returning the expected marker. The import-side-effect checker passes.

No live GitHub requests, repository clones, credentials, accounts, services,
root policy or deployment were used by this worker. Git commits in tests are
only temporary synthetic fixture commits, not changes to this repository's
index/history. Work remains unstaged for the parent to integrate and review.

## Installation-only cutover caveat

New policy cannot narrow previously issued user tokens or update already-running
hosts. If an older private build was used, retire its hosts and revoke/reconnect
its prior user grants before claiming cutover. Use an immutable current release
and fresh hosts. This source change performs no migration, helper installation,
rollout or existing-token revocation.

Human and machine private code runs use repository-scoped App write credentials;
ask uses repository-scoped read credentials. The user grant stays broker-internal
for identity/discovery and never enters a runner. GitHub API actions use the App,
not human OAuth authority or its merge-guard bypass. Existing Git attribution is
unchanged: the configured App bot is author/committer, with the human recorded in
`Co-authored-by` (without a configured App identity, Git configuration applies).
