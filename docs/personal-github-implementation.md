# Personal GitHub implementation prerequisites

Implementation status for issue #390: **not usable and not complete**.

## Implemented boundary

GitHub device-flow identification now retains the positive safe-integer account
id returned by `GET /user`. Both direct and server-watched sign-in carry that id
into the server-owned web session. Bootstrap sign-in carries it too. Cookie and
native bearer resolution retain it across persistence and roster-name refresh.
The personal principal is `github:<account id>`, never a login or display name.
No existing cookie is upgraded by guessing its account id. Legacy cookies still
work for shared access; personal APIs require a new verified sign-in. Automation
identities and simple-mode attribution cannot establish a personal principal.

The reserved `/api/personal/github` and `/api/personal/repos` route families are
separate from administrator-owned instance App setup. They never read a claimed
identity from the body. Verified callers can read `/api/personal/github/status`,
which reports unavailable. All personal mutations return 503 before reading
request content, contacting GitHub, or writing credentials or repository state.
Exact-id reads and manifest callbacks return 404, including replayed callbacks.
Responses are non-cacheable. Missing stable sign-in returns 401.

There is deliberately **no admission-success path**. No environment flag,
sandbox flag, operator boolean, or existing per-run sandbox qualification can
enable provisioning. The current shared service uid does not isolate personal
credentials or stored content from other host runs. This denial must not be
replaced with a configuration toggle.

The existing instance App, including an instance App registered under a human
account, remains shared. Its setup, key, grants, and sign-in behavior are not
repurposed. Existing shared repository APIs remain shared: importing a repository
there does not make it owner-only, irrespective of GitHub visibility.

## Remaining release gates

These prerequisites introduce no personal App/grant store, private repository,
or private session. Before enabling admission, implement and verify:

1. Worker-owned authoritative catalog scope for repositories and sessions, with
   missing personal ownership denied and legacy records explicitly shared.
2. Owner-only enforcement across HTTP, WebSocket delivery, search/history/MCP,
   counts, assets, files, PRs, previews, terminals, workflows, fork/attach, and
   recovery. No online actor-database fanout or unscoped fallback.
3. Isolated private storage and a credential broker inaccessible to **all**
   shared and other-owner host runs, plus enforceable runtime qualification of
   identity, mounts, network/control authority, and fail-closed provisioning.
4. Separate per-owner App credentials and per-App/principal grants, refresh
   locks and caches; disconnect invalidation and running-work revocation.
5. Actual `public:false` personal manifest flow with owner-bound single-use
   state, origin/expiry/operation checks, converted numeric owner verification,
   mutation-lock uniqueness checks, and disabled personal webhooks.
6. App-scoped repository discovery and immutable personal registration;
   credential selection that never falls back to shared App, ambient `gh`, SSH,
   another person, or another App.
7. Principal-scoped client caches and settings/repository-picker UI, with
   desktop/phone synthetic demo proof. No UI has been enabled in this phase.
8. Full A/B adversarial matrix for admitted personal data, refresh/disconnect,
   stale caches, descendants/recovery, old clients, exact ids, and unavailable
   services. Denial tests here are not substitutes for that matrix.

## Verification scope

Synthetic API-seam tests cover GitHub-id sign-in through native bearer and
persisted cookie resolution, spoofed identity fields, legacy cookies,
automation exclusion, and unavailable personal routes for two distinct users.
The callback tests establish that conversion cannot run while unavailable;
they do not test a future manifest state machine. Existing shared GitHub auth
and setup regression tests pass. TypeScript typechecking passes.

Native `GitHubAuth.PollResponse` uses additive-compatible `Decodable`, and the
Chrome device-flow consumer selects existing response fields. Their bearer
contract is unchanged; account ids remain server-owned. No Swift or Chrome
changes are required for these prerequisites.

No live personal data, credentials, registrations, databases, deployment, or
GitHub publication were changed. External GitHub flow remains untested. No
Portal or visual demo was started because there is no frontend change.
