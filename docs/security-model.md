# Security model

Open Session runs agents against untrusted input: customer tickets, channel
events, webhook payloads, and the open internet. The stance throughout is
**enforce at the tool/env/credential layer, never just in prompts** — a prompt
rule is guidance, a stripped tool or scoped token is a guarantee. This
document is the full reference behind the invariant summary in
[AGENTS.md](../AGENTS.md).

## Automation least-privilege

Automation runs (especially event-triggered ones like support-ticket triage)
process untrusted text — ticket content is data the agent reads, never
configuration for the run.

- Runner local tools receive an explicit, non-inherited environment. The base
  includes PATH/HOME/LANG, scoped session scratch variables when available,
  and Git identity. Eligible runs may additionally receive projected GitHub
  authority, short-lived AWS credentials through a fixed credentials-file
  pointer, or human-enabled Claude/Codex pool credentials. `OPENSESSION_MODEL`
  is not added to Pi's local-tool environment. MCP subprocesses use safe SDK
  defaults plus their configured headers/env or OAuth projection. Neither path
  inherits the server's full environment or `~/.opensession.env`.
- Each automation has an optional `mcpServers` allowlist (per-automation
  field, settable via the API); runs only see those servers. Example: a
  support-triage automation might name only its support-inbox, identity,
  analytics, issue-tracker, error-tracker, and billing servers so it can look
  up the customer, related issues, and errors while investigating.
- Scheduled automation `inputs` are a separate read path from the primary
  run's MCP allowlist. Built-in input providers fetch a bounded time window,
  pass it through a tool-less one-shot reducer as explicitly untrusted data,
  and persist only a cursor after the primary run succeeds. Raw Slack text and
  reductions are not stored in the checkpoint. A Slack input never grants the
  primary model Slack tools; optional Slack output is likewise server-side,
  disabled independently, and derived from the final structured report.
- Automation runs hard-deny _customer-facing, identity-mutating, and incident.io
  mutation_ tools (enforced for direct runs and interactive resumes of
  automation sessions):
  Plain thread writes (reply_to_thread, mark_thread_done/todo, snooze_thread)
  and the WorkOS write/destructive subset (create/delete/update user+org,
  revoke, invitations, password/verification emails, impersonation URLs).
  incident.io is declare-and-read only: `incident_create` may create a triage
  incident, while incident updates, follow-up writes, escalation responses,
  alert attachment changes, investigation controls, extension writes, and
  skill-feedback writes are stripped. Reads stay allowed; suggested customer
  replies go in an internal Plain note. Linear (including issue creation) and
  Sentry are internal, so their writes are allowed. That is the "spin off
  work" affordance.
- Automations run on Pi in detached run hosts. `runAutomation` maps every
  native or legacy Pi model id onto Pi at dispatch (`automationModel`;
  unset uses `DEFAULT_PI_AUTOMATION_MODEL` in automations.ts). Deny-sets are
  enforced before Pi registers MCP tools, and its guarded local tools keep
  filesystem and environment access contained. `opensession-admin`, the
  unrestricted `opensession-sessions`, and per-user (`allowedUsers`) servers
  stay out of automation runs. The scoped automation-safe set is documented
  below. Both engine run gates are
  deny-by-default on journal kind: interactive kinds
  (prompt/goal/create/linear/slack), unattended kinds
  (automation/plain/action/security-scan/github-*), everything else refused.
- `mode` is per automation. Ask has guarded read/find/grep/ls/bash tools but
  no Write/Edit. For an unsandboxed ordinary repository it uses a stable,
  shared detached worktree pinned to `origin/<defaultBranch>`; only a
  repository configured as a shared self-development checkout uses its live
  checkout. Sandboxed ask runs use the sandbox workspace. Code gets an
  isolated writable workspace/worktree and can edit and commit. Ordinary
  automations currently receive no GitHub credential, so they cannot push or
  open a GitHub PR; trusted `github-*` code workflows have a separate,
  repository-scoped credential path. Every other scope still applies: MCP
  allowlist, denied writes, IMDS blocking, and the explicit environment.
- A sandboxed automation runs in a fresh disposable Daytona Executor. Open
  Session admits it only after Daytona has passed qualification, including a
  live domain-allowlist check. The provider applies that allowlist before
  runner bootstrap, repository setup hooks, private workspace seeds, or model
  credentials enter the guest. Each run requires one hard-pinned Anthropic or
  OpenAI subscription account, no fallback model, no nested CLI credentials,
  and an explicit MCP allowlist. The launcher adds only the callback, clone,
  runner bootstrap, model API, configured MCP, and operator-approved domains.
  It probes one allowed and one blocked destination before continuing, and
  strictly deletes the Executor after the run. There is no host fallback.
- When adding an automation, scope it: pick ask mode unless it must write, and
  name only the MCP servers it uses.
- A code automation's `prReviewer` is preserved and added to its instructions,
  but it grants no GitHub authority. It matters only when the run already has
  an authorized publication path. See
  [Automation PR credentials and review requests](setup/github.md#automation-pr-credentials-and-review-requests).

## Stripe: a third enforcement tier

Stripe is money-moving, so it gets a tier beyond allow/deny: the tools in
`STRIPE_CONFIRM_TOOLS` (runner-shared.ts: create_refund,
cancel/update_subscription, and the raw-API mutators stripe_api_execute +
stripe_api_write since they can hit any permitted endpoint — keep this list in
sync with mcp.stripe.com's live catalog). Run the MCP on a restricted key
(write on Refunds + Subscriptions + Invoices only — invoice voiding included;
read on core billing resources, nothing else — Stripe enforces this ceiling
server-side). On Pi there is no per-call approval card, so ordinary
interactive and unattended runs strip the confirm tools from the model's tool
list. The server stays mounted and Stripe reads keep working. Guidance differs
by run type:
unattended runs put the proposal in their internal note; interactive runs ask
the human in the session. The explicit exception is Plain's refund/cancellation
approval path: after a teammate's go-ahead is classified against an existing
proposal, a dedicated execution run omits both the deny and confirm sets and
therefore exposes the Stripe mutators. Its execution prompt directs the model
to perform the approved action. (Dropping the whole server from interactive
runs was tried and reverted: it blanked Stripe reads for no security gain. The
money movers were unreachable either way, and Stripe enforces the restricted
key's write ceiling.)

## Per-user MCP servers (`allowedUsers`)

An MCP server in `mcp-config.json` can carry an optional
`allowedUsers: string[]`. When non-empty, the gate checks both the current
prompter and, for an ordinary session, its creator. A match by either identity
exposes the server in that session, so a teammate steering a session created by
an allowed person can use it. Omitted/empty means available to everyone, the
default. Entries are matched by `userMatchesAny`
(packages/core/opensession-server/src/server/shared/user-mappings.ts) through
the same identity table as commit attribution, so names, nicknames, email
addresses, GitHub logins, and Slack ids resolve to the configured person.

- Enforcement is at the runner layer, not the prompt:
  `filterMcpServers(scope, user, grantUsers)` (runner-shared.ts, consumed by
  pi-mcp-bridge.ts) drops a restricted server unless one of the gate identities
  is cleared, then strips `allowedUsers` before the config reaches the engine.
  Both the automation allowlist and this gate apply.
- Ordinary session runs supply the current prompter and, where applicable, the
  session creator as a grant identity. Automation dispatch and automation-owned
  resumes explicitly drop both identities, so an `allowedUsers`-restricted
  server remains invisible even if the automation's `mcpServers` allowlist
  names it.
- Manage it from the Connections UI (the Add-MCP form has an "Allowed users"
  field; each server card has a Restrict/Edit-access button →
  `PUT /api/connections/mcp/:name` with `{allowedUsers}`), or via
  opensession-admin (`add_mcp_server`'s `allowedUsers`, and
  `set_mcp_allowed_users`). Backing helpers: `addMcpServer` /
  `setMcpAllowedUsers` in packages/core/opensession-server/src/server/connections.ts.
- Deploying runner-layer filtering code requires a real `systemctl restart`.
  Adding, removing, or re-scoping a server in `mcp-config.json` is picked up on
  the next run/message and does not require a restart.

## GitHub webhook actor trust (public repositories)

A valid webhook signature proves that GitHub sent an event. It does **not**
prove that the GitHub user who caused it is trusted. This distinction is
critical for public repositories, where anyone can open or update a PR, write a
PR comment, or submit a review.

The GitHub agent therefore treats `identity.team[].github` as its human trust
roster and `policy.githubBotLogins` as its machine trust roster. Actor-driven
entry points fail closed before starting an agent run or steering a session:

- PR and inline-review `@mention` commands require the comment author's exact
  GitHub login on the team roster. `author_association` is never accepted as a
  substitute.
- label-triggered review, auto-fix, simplify, and adversarial runs require the
  label actor on the roster.
- automatic review on open/reopen/push/ready events requires a rostered sender
  or configured bot for same-repository PRs. An external fork is the only
  exception: it may start the isolated public-review path described below.
- merge automations and deploy-workflow session notifications require a
  rostered actor or configured bot.
- startup recovery revalidates persisted requesters, so a previously accepted
  public event cannot bypass the boundary after a restart.

Keep every trusted GitHub login in the identity roster. An empty roster disables
human GitHub commands rather than making the integration public.

### Isolated public PR reviews

External fork PRs can receive an automatic semantic review without running
GitHub Actions or placing contributor code in a host worktree:

1. GitHub REST supplies the PR identity and a size-bounded patch, pinned by base
   repository, PR number, base SHA, head repository and head SHA.
2. A fresh disposable Daytona Executor anonymously fetches
   `refs/pull/<number>/head` plus the immutable base SHA, verifies both commits
   and checks out the head with Git hooks disabled. The source-verification
   profile refuses prewarmed and project-template resources and skips runner
   bootstrap, dial-back, private workspace seed files, and repository
   setup/resume hooks. Any mismatch fails closed. Provider deletion must be
   confirmed before model inference.
3. A tool-less one-shot model receives only the bounded immutable patch. Model
   and GitHub credentials never enter the guest, and untrusted repository text
   never reaches a host-side shell, filesystem tool or MCP server.
4. The control plane rechecks the live head SHA before posting bounded summary
   and inline comments through the GitHub App. Public comments contain no
   private session link and advertise no write-capable actions.

Public reviews never run repository setup from the fork, tests, autofix,
simplify, adversarial review, conversational commands, pushes or handoffs.
Review policy comes from the registered base checkout. The path is limited by
file count, changed lines, patch bytes, attempts per SHA, reviews per author and
a repository-wide daily budget. The `OPENSESSION_PUBLIC_REVIEW_*` environment
settings can lower or raise those bounded defaults. If Executor provisioning,
immutable ref verification, strict disposal, or the model call fails, there is no host-agent
fallback.

Public intake is an operator-controlled launch, not an App permission. Before a
human repository administrator changes GitHub's PR creation policy to allow all
users, operators must qualify the Daytona provider, enable the review
automation, and keep fork-origin GitHub Actions disabled or approval-gated. The
shipped PR workflows additionally skip every job whose head repository differs
from the base repository. The GitHub App intentionally has no repository
Administration permission; changing
and auditing those GitHub settings is a one-time human-admin task, not runtime
authority.

## GitHub credential scoping (out-of-org writes fail server-side)

The "repositories outside your org require confirmation" rule in AGENTS.md is
enforced with credential scope, not just prompts. One GitHub App may have
installations on several accounts. Server reads and writes resolve the
installation from the repository owner and use a short-lived token for that
installation. Trusted repository code runs receive a token narrowed further to
the owner-verified `owner/repo`. `integrations.github.installationOwner` is only
the default for calls that do not name a repository. Teammate device-flow
tokens are limited by both the App's installations and the person's own GitHub
access. Out-of-installation writes therefore fail at GitHub's side.

The App is a fail-closed boundary: token-mint failure never consults ambient
`gh` hosts.yml accounts, SSH credentials, or a connected human. Process-local
Git config rewrites GitHub SSH remotes to HTTPS so the projected App or user
credential is the only authority a run can use.

## Per-user GitHub auth + web sign-in (opt-in, config `integrations.github`)

Off by default. Opting in uses the same App identity as bot traffic:
`integrations.github` carries `userPrAuth`, `oauthClientId`,
`oauthClientSecret`, `appSlug`, and `installationOwner`; the private key lives
at `~/.opensession/github-app.pem` (or the path in
`OPENSESSION_GITHUB_APP_KEY`). Environment App identity values win over config.
Enabling `userPrAuth` activates both halves below:

- **PRs as the session owner** (packages/core/opensession-server/src/server/github-auth.ts): teammates connect
  their GitHub account via the OAuth _device flow_ (Connections UI card, or
  implicitly by signing in). Tokens live per-login in
  `~/.opensession/github-auth.json` (0600, never returned by any API). The
  runner injects them as GH_TOKEN/GITHUB_TOKEN into the engine-server env —
  interactive kinds only and never a least-privilege run
  (`policy.unattended`: automations and deniedTools carriers including the
  Slack/Linear loops stay credential-free; trusted GitHub code workflows alone
  receive a repository-scoped App token). The run user
  resolves to a login through the SAME identity table as commit attribution,
  so the mapping is config (identity.team[].github), not code. The
  PR-attribution instructions swap the `--assignee` bot wording for "authored
  by them" when the token rides. Injection lives in pi-runner.ts ⇒
  needs a real restart.
- **GitHub web sign-in** (packages/core/opensession-server/src/server/web-auth.ts + routes/auth.ts): when
  active, the UI's name picker is replaced by a real sign-in (UserGate →
  device flow → HttpOnly `opensession_auth` cookie; sessions in
  `~/.opensession/web-sessions.json`, sliding 90d). Ordinary `/api/*` requests
  and the UI `/ws` require that web session. Exceptions are `/api/auth/*`;
  health/readiness endpoints; client update feeds and artifacts; runner
  registration/heartbeat; the scoped keychain broker; the separately
  bearer-gated keypad route; workload-identity discovery, JWKS, and
  lease-gated token endpoints; and machine WebSocket transports authenticated
  by their own transport credentials. Page and static-asset loads remain open
  so sign-in can render, while published `/d` applications are authenticated.
  Only logins on identity.team may sign in. The verified identity OVERRIDES
  client-claimed `user` on every WS message and stamps `createdByLogin` on
  new sessions; a one-time boot migration backfills `createdByLogin` onto
  existing sessions from `createdBy` (marker:
  `~/.opensession/sessions/.github-user-migration.json`). Non-browser callers
  (curl/CDP recipes) authenticate with `Authorization: Bearer <token>` using a
  token from the web-sessions file.

One sign-in flow, for every client: the **device flow** (`POST
/api/auth/device` → the person enters the code on github.com →
`/api/auth/device/poll`, which the server also polls to completion itself so a
suspended phone doesn't lose the outcome). There is deliberately no
authorization-code redirect. A redirect has to return to the exact origin it
left, and on the iOS PWA it comes back in Safari rather than the installed
app; native apps can't take one at all. GitHub side: one
org-owned **GitHub App** with "Enable Device Flow" checked, installed only on
the repositories Open Session should reach. GitHub App user
tokens are what scopes teammates' tokens to your org (see the previous
section): they can't reach public/third-party repos, they expire ~8h, and
github-auth.ts refreshes them via a rotating refresh token (20-min ticker
parked on globalThis + refresh-on-boot; getters never hand out an expired
token: interactive runs receive no GitHub credential and web mutations return
403 to "connect your account"). A refresh rotates the token string, which changes the
shared-server config hash → drain-respawn at next run start, by design.
`oauthClientSecret` is what that refresh grant needs. Signing in never uses
it, so an instance without one signs people in and then drops them at the
first expiry.

"Enable Device Flow" is not optional on the GitHub side. It is the only
sign-in there is, so an app without it refuses every attempt with
`device_flow_disabled`, and nobody can get in. `startGithubDeviceFlow` maps
that one code to a sentence naming the switch, since it is the failure that
locks out a whole instance at once.

## Self-management tools (Slack + interactive Open Session sessions)

The `opensession-admin` in-process MCP server
(packages/core/opensession-server/src/agents/slack/admin-tools.ts) lets the agent manage its own setup from
Slack: channel memory (remember/list_memory/forget) and — gated to the trusted
user (`isAdmin` = no `ALLOWED_SLACK_USER_ID` set, or sender matches it) —
automations (list/create/update/delete/run) and MCP connections
(list/add/remove). It is wired ONLY into interactive Slack runs (handlers.ts
`processMessage`); automation runs never go through there, so they never
receive these tools. Do not add `opensession-admin` to automation/`runAgent`
paths — that would let untrusted ticket text reconfigure the agent. Channel
memory is scoped in packages/core/opensession-server/src/agents/slack/memory.ts (public channel → shared
`workspace` store; private channel/DM → isolated, with read-only workspace
view) and auto-injected into the system prompt each run.

Both `opensession-admin` and `opensession-sessions` are ALSO available inside
**interactive Open Session sessions** (web UI + loops), not just Slack:
`interactiveMcpServers(user, sessionId)` (packages/core/opensession-server/src/server/interactive-mcp.ts)
builds them and they are passed as `inProcessMcp` from the interactive run
paths (`runSessionPrompt`, both `create_session` paths). This unrestricted
interactive set is withheld from automation runs **and** from interactive
resumes of automation-owned sessions (gated on `!isAutomationSession`, the same
gate as `deniedTools`). Automation-owned runs instead receive only the explicit
set documented below. Untrusted ticket text must never reach the interactive
set. Open Session is network- and team-gated and already exposes all of this
through its UI, so interactive
users are treated as `isAdmin: true` there. The in-process servers are built
with `packages/core/opensession-server/src/server/inprocess-mcp.ts` (a thin @modelcontextprotocol/sdk wrapper)
and reach pi runs as stdio MCP proxies that forward to the in-process
tools through the run-RPC socket; the Slack loop registers its own
slack-context server set per run via `registerSessionMcpServers` (run-rpc.ts)
so those proxies execute the right context. The runner adds a short "Managing
<persona.name>" context block when these tools are present so the session
knows they exist.

The `opensession-sessions` in-process MCP (packages/core/opensession-server/src/agents/slack/sessions-tools.ts)
is a sibling, wired in its unrestricted shape only to interactive runs. The
scoped `automationSelf` shape is described below. It lets the agent see and
steer every _other_ Open Session session: read tools
`list_sessions` (with a `waiting` state filter and an exact `createdBy`
identity filter) and `get_session` (explicit creator/creation timestamp, state,
pending question, and transcript tail) are open to any whitelisted user; the control tools —
`answer_session_question`, `send_to_session`, `cancel_session`,
`create_session` — are gated to the trusted user via `isAdmin`. The tools
don't touch in-process state directly; they go through the `SessionControl`
registry (packages/core/opensession-server/src/server/session-control.ts) that
packages/core/opensession-server/src/server/session-control-wiring.ts populates at boot with the same helpers
the WebSocket handlers use — so steering from here behaves exactly like a
human in the web UI, and an autonomous monitor can call the same registry
directly without the MCP. Sessions whose runs aren't owned by this process
(CLI/tmux) are surfaced as `observe-only` and can't be steered/cancelled. Do
not wire the unrestricted `opensession-sessions` server into automation paths.
Cross-session control from untrusted ticket text is a privilege-escalation path.

### Automation-safe in-process servers

Automations never receive `opensession-admin` or the unrestricted interactive
`opensession-sessions` server. `automationRunInProcessMcp` mounts this explicit
set:

- Every automation receives `opensession-report`, `opensession-turn`,
  `opensession-health`, and `opensession-audit`. The latter two expose aggregate
  host metrics and a bounded daily audit digest, not arbitrary filesystem or
  command access.
- `opensession-papercuts` is mounted when the repository toggle is enabled
  (default on; Settings → Papercuts). It can append a papercut and list at most
  50 recent entries, using 14 days by default and at most 120 days. Reads include
  stored text, the `by` label, repository, and timestamp.
  The store is `~/.opensession/papercuts`, and entries also mirror to the audit
  log. It has no session-control or configuration-mutation tools.
- `opensession-workflows` is mounted only when a human enables the automation's
  `workflows` flag. Workflow MCP calls retain that automation's MCP allowlist
  and `AUTOMATION_DENIED_TOOLS` policy.
- The scoped `opensession-sessions`/`opensession-self` pair is mounted only when
  a human enables `automation.selfImprove`.

A self-improving automation's runs and thread-reply resumes receive session
list/get reads plus `spawn_task`, `task_status`, and `cancel_task`; the direct
`answer_session_question`, `send_to_session`, `cancel_session`, and
`create_session` controls are omitted. This is not child-only containment:
`task_status` accepts any session id, and `cancel_task` currently passes any
process-owned session id to `SessionControl.cancelSession` without proving the
target is a child. Treat `selfImprove` as carrying cross-session read and
cancellation capability until those tools are narrowed.

`opensession-self`
(packages/core/opensession-server/src/agents/slack/self-improve-tools.ts) can
read the automation's own record and run `update_own_prompt` for that automation
only, with a timestamped backup, `automation_self_update` audit event, and a
length floor against degenerate rewrites. Schedule, model, mode, and repository
remain human-only. Spawned children use the normal session-creation path, are
PR-gated, and have spawn depth limited to 2. Never enable `selfImprove` for an
automation triggered by untrusted event or ticket text; it is intended for
introspective scheduled runs over trusted telemetry.
