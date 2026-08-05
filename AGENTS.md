Default to using Bun instead of Node.js.

OpenSession was born as Tella's internal agent server, code-named "backstage" —
that history explains the `bks-`/`prj-` id prefixes, the internal `/backstage/*`
route literals, and other protocol-compat residue you'll see below.

Instance-private operator instructions (deployment hostnames, org access
grants, incident history) belong in an untracked `AGENTS.local.md` or
`CLAUDE.local.md` next to this file — the runner appends it to every engine
run (`readLocalInstructions` in src/server/opencode-runner.ts), and Claude
Code auto-loads `CLAUDE.local.md`. Keep anything you wouldn't publish there,
never here.

## Public repositories require confirmation

NEVER publish changes to an open-source or public repository without explicit
user confirmation in the current conversation. A request to investigate,
implement, or prepare a change is not permission to publish it. This covers
every kind of write — issues and comments included, not just forks/branches/PRs.
Local edits and commits are allowed, but before writing anything to a
public/open-source repository, stop and ask the user. This rule overrides
bias-to-action and generic commit/push/PR defaults; automatic PR creation
applies only to your registered first-party repositories.

Enforce this with credential scope, not just prompts: run the bot on a
fine-grained token whose resource owner is your org (no Administration/Secrets,
no gists, cannot fork or create repos outside the org), and give teammates
GitHub App user tokens limited to the app's installation on that org — then
any GitHub write outside the org, from ANY code path including raw API calls
and CLI/tmux sessions, fails at GitHub's side with 403 "Resource not
accessible". The same rule is injected into every engine run via
`buildOpencodeInstructions` (opencode-runner.ts).

## Data handling — never upload to public hosts

NEVER upload files or data to public file-sharing hosts or pastebins — no
exceptions, no matter how delivery of a file is failing. Anything uploaded
there is public and unrecoverable, and session files routinely contain
customer data. Deliver files only through channels you control: Slack file
upload, the session UI, email via your own tooling, or a commit/PR in a
private repo. If every controlled channel fails, stop and report the failure
instead of escalating to a third-party host. The same rule is injected into
every engine run via `buildOpencodeInstructions` (opencode-runner.ts).

## The five client apps — resolve which one BEFORE working

OS1 has five user-facing clients in this repo, and requests about "the app"
are ambiguous between them:

- **Web UI** — `src/frontend/` (React, served by the Bun server; also what the
  iOS PWA and the Electron shell display).
- **Electron desktop shell** — `os1-mac/` (bundle id `dev.tella.os1.shell`;
  wraps the web UI).
- **Native Swift app** — `os1-ios/` (one SwiftUI codebase, iOS + macOS targets,
  bundle id `dev.tella.os1`). Read `os1-ios/AGENTS.md` before touching it —
  build/verify workflow, release trigger, and performance invariants live there.
- **Chrome extension** — `os1-chrome/` (MV3 side panel; captures page context —
  screenshot, element pick with React fiber info — and starts sessions via the
  REST surface with Bearer auth; loaded unpacked, never the Web Store; see
  `os1-chrome/README.md`).
- **Terminal client** — `os1-tui/` (the `os` binary; herdr-style TUI on OpenTUI,
  tmux keys, tabs). Pure client: HTTP + one WebSocket per watched session, no
  server imports, so it compiles to a standalone binary. `opensession tui` is an
  alias. Read `os1-tui/AGENTS.md` before touching it.

Conversation scoping rule: once a conversation is about a specific app, every
following message is about THAT app unless the user says otherwise — don't
drift back to the web UI because it's the default surface (e.g. after an iOS
bug report, "also fix X" means fix X in the native app). If it's genuinely
unclear which app a request targets — the symptom could exist in several, or
the thread hasn't named one — ask first instead of guessing; a fix landed in
the wrong app wastes a round-trip and can mask the real bug.

## Server architecture map (post-refactor 2026-07-09)

`opensession.ts` is a thin entry (~900 lines): env, `hotServe` (reuse the live
server across hot reloads), the `Bun.serve` composition (SPA routes map + fetch
preamble → route dispatch → WS-upgrade/SPA-fallback/404 tail), `loadAgents`,
the `__backstageBooted` boot block, and graceful shutdown. Everything else
lives in focused modules — work in the module that owns your feature, not the
entry file (that's what keeps parallel sessions from colliding):

- `src/server/routes/` — every HTTP route, one file per domain (sessions, pr,
  plain, workspace, models, …). Handlers get a `RouteContext` and return a
  `Response` or `undefined` to fall through; `routes/index.ts` is the ordered
  chain. Order only matters *within* a path family — keep a family (e.g.
  `/notes/search` before `/notes/:id`) in one module. New endpoint → add it to
  the matching domain file (or a new file + one line in index.ts).
- `src/server/ws-handlers.ts` — the UI WebSocket (watch/prompt/queue control/
  answers/terminals/notes/chat + create_session).
- `src/server/run-session.ts` — driving a session turn: runSessionPrompt(Inner),
  queue delivery (enqueue/steer/interrupt/drain), sandbox launch, restart
  resume, /loop ticker. This is runner-adjacent: changes need a real restart.
- State modules (all park live state on `globalThis` under the same keys so
  hot reloads keep it): `ws-hub.ts` (clients/presence/broadcasts),
  `queue-state.ts` (prompt queues + steer receipts), `asks.ts` (pending
  AskUserQuestion + Slack escalation), `session-cache.ts` (2s session cache —
  call `invalidateSessionsCache()`, never poke the cache), `agents-registry.ts`.
- `session-repos.ts` (repo notes/attach/switch), `interactive-mcp.ts`
  (interactive opensession-* MCP builders; side-effect registers the run-rpc
  builder), `session-control-wiring.ts` (opensession-sessions MCP surface),
  `slash-commands.ts`, `goal-runner.ts` (goal wakes + ticker),
  `frontend-build.ts` (in-process SPA rebuild), `uploads.ts`,
  `session-sandbox.ts`.

Modules with module-scope side effects (listener/ticker registration guarded
by `__backstageBooted`) are explicitly side-effect-imported at the top of
opensession.ts — if you add such a module, add it to that import list.

## OpenSession dev workflow (self-hosting — read this first)

Naming: OPENSESSION_* env vars, `~/.opensession-*` state. URLs are prefix-less
since 2026-07-10: the app serves at the bare domain root (your instance URL),
old `/opensession` + `/backstage` page URLs 301 there, and prefixed non-page
traffic (WS upgrades incl. sandbox dial-back run-ws/rpc-ws, API calls) still
normalizes silently onto the internal `/backstage/*` route literals — keep that
normalization; running sandboxes have the old literals baked in.
`src/server/rename-compat.ts` keeps legacy aliases for env/state working — never
remove it, and never rename protocol ids (`bks-`/`prj-` prefixes,
`===MICHAEL-SUMMARY===`/`BACKSTAGE_VIDEO:` markers, repo ids). The in-process
MCP servers are named `opensession-*` (renamed from `michael-*` 2026-07-09;
`canonicalMcpServerId` in rename-compat normalizes legacy ids from persisted
runs — keep using the new names at definition sites).

OpenSession runs itself from its main checkout. OpenSession code sessions do
**not** get their own worktree
(`sharedCheckout` in `src/server/worktree.ts`); they all work in this one shared
checkout on the default branch. That's intentional wild-west iteration. The rules that keep
it from descending into chaos:

- **Only `add` → `commit` → `push`. Never `git reset --hard`, `git checkout .`,
  `git revert`, or `git checkout <other-branch>` in the shared checkout.** A reset
  or branch-switch yanks the working tree out from under the live server *and*
  every other session — that's the "sessions undoing each other's work" trap. If
  something looks wrong, inspect and fix forward; don't roll back the shared tree.
- **`git add <specific files>`, not `git add -A`** — multiple sessions may have
  uncommitted edits in this tree; only commit your own. High-traffic files
  (`foundation-adapters.css`, `opensession.ts`, `App.tsx`) are sweep magnets: even a specific
  `git add` on one of them can pick up another session's uncommitted hunks
  (it has happened repeatedly). For
  those files use `git add -p` to stage only your hunks, and check
  `git diff --cached` before committing.
- **Scope the *commit*, not just the `add`.** The index is shared too: another
  session's `git add` may already be staged before you touch anything, so a
  careful `git add <your files>` followed by a bare `git commit` still ships
  their work under your message. Always check `git diff --cached --name-only`
  first — if it lists anything that isn't yours, commit with a pathspec
  (`git commit -- <your files>`, which commits those paths' worktree content
  and ignores the rest of the index). Never `git reset`/`git restore --staged`
  to "clean up" first — that silently unstages what another session staged
  deliberately. When a file has both problems at once (foreign entries in the
  index *and* foreign uncommitted edits inside your own files), build the
  commit through a private index instead: `GIT_INDEX_FILE=/tmp/my.index
  git read-tree HEAD` → `git apply --cached your.patch` → `git write-tree` →
  `git commit-tree` → `git update-ref refs/heads/main <new> <old>` (the
  three-argument form is a compare-and-swap that fails instead of clobbering).
- **Commit + push frequently.** Un-pushed work is the only thing a sync can't
  protect (the deploy is now `merge --ff-only`, never `reset --hard`, so it aborts
  loudly instead of wiping — but push anyway).
- **Backend edits need a deliberate `systemctl restart opensession`.** Commit
  and push first, then restart and verify health. Restarts are graceful and
  detached engine turns reattach, but they still churn active sessions, so do
  this once after the backend change rather than after every save. Frontend
  changes never need it: the in-process watcher rebuilds the bundle live.
- Want isolation for a risky/breaking change? Boot a real dev instance:
  `OPENSESSION_DEV=1` now gates the FULL dev mode — no agent loops, webhook
  server, schedulers, automation seeding, detached-server adoption, or prewarm
  — and it refuses to boot without `OPENSESSION_STATE_DIR` (or a chats-dir
  override), so it can never touch live state or steal the run-rpc socket. Add
  `OPENSESSION_DEMO=1` for synthetic demo data. The repo's `.opensession/start.sh`
  wires all of this for the session Preview button; see
  docs/self-development.md.

## Frontend UI system (Base UI + Tailwind + Motion)

New UI goes through this stack; component presentation belongs in Tailwind
utilities, while residual cross-tree contracts stay in the foundation adapter:

- **Tokens**: `src/frontend/styles/tailwind.css` maps the foundation
  variables (`--bg`, `--text-dim`, …) into Tailwind's namespace via
  `@theme inline` — use `bg-panel text-dim border-line text-fg bg-surface` etc.,
  never raw hex or stock Tailwind grays. Dark/light theming comes for free
  because the vars re-resolve under `html[data-theme]`. The spacing/radius/text
  scales are px-anchored there (the foundation sets `html { font-size: 14px }`,
  which would otherwise shrink every rem-based utility to 87.5%) — so `p-3` is
  a true 12px and `text-xs` a true 12px. Bare `rounded` bypasses the radius
  scale; use `rounded-sm/md/lg` (4/6/8px).
- **Compile**: Tailwind is compiled by an `@tailwindcss/cli` subprocess inside
  `buildFrontend()` (src/server/frontend-build.ts). `tailwind.css` imports
  `foundation-adapters.css` before unlayered utilities, so utilities win
  source-order ties. Preflight is intentionally NOT imported; the foundation
  owns the small reset the app needs. Don't import tailwind.css from App.tsx —
  Bun can't compile it.
- **Primitives**: wrap Base UI (`@base-ui/react`) per component in
  `src/frontend/ui/` (see `ui/tooltip.tsx` for the pattern). Rules: always
  pass `className` through `cn()` (ui/cn.ts); keep Base UI's composable parts
  shape rather than mega prop APIs; style open/close state via Base UI data
  attributes; few variants (`variant`/`size`), no boolean prop explosions.
- **Motion**: use `motion.*` directly with shared presets from `ui/motion.ts` —
  don't build wrapper components around Motion. Caveat for Base UI popups:
  `render={<motion.div/>}` drops Base UI's injected attributes (role, data-*),
  so it's only safe on non-focus popups like the tooltip (enter-only; restore
  `role` by hand — see ui/tooltip.tsx). Focus-managed popups (menus, dialogs)
  animate with CSS transitions on Base UI's `[data-starting-style]` /
  `[data-ending-style]` lifecycle attributes instead (see ui/menu.tsx) — that
  keeps keyboard nav + a11y intact and gets exit animations for free.
  AnimatePresence can't track exits through Base UI portals; don't use it there.

### UI Design & Motion Skills

Design/motion skills can be installed instance-locally under `.agents/skills/`
(gitignored — see docs/extending.md for the skill format). If your instance
has them, read the smallest relevant set before frontend design or motion
work.

- Use `bun run opensession.ts` to start the server
- Server binds 127.0.0.1:3850 — not publicly accessible
- Access at your instance URL — however you front 127.0.0.1:3850 (reverse
  proxy, VPN/tailnet, SSH tunnel). Old `/opensession` + `/backstage` page URLs
  301 to the prefix-less form on the same host.
- Bun automatically loads .env, so don't use dotenv
- HTML imports for frontend bundling (no Vite)
- All session file access is read-only (never modify ~/.slack-sessions/ or ~/.linear-sessions/) — sole exception: `src/server/agent-session-sync.ts`, the surgical engine-id/model sync interactive runs use when a fallback/rotation mints a new engine session for a slack/linear-source session (see that module's doc before widening it)
- Own session store at ~/.opensession-chats/
- Audit log: every agent run emits structured JSON events (incident-agent style) to ~/.opensession-audit/audit-YYYY-MM-DD.jsonl via src/server/audit.ts — see deploy/README-audit.md for the event catalog and CloudWatch shipping
- Internal notes and draft replies (Plain, Linear) are always written in English, regardless of the customer's language — note the customer's language so the team can translate before sending. This applies to agent prompts here (src/agents/plain/prompts.ts) and to automation prompts stored in ~/.opensession-automations/.

## Frontend rebuilds & restarts

The systemd service runs `bun run opensession.ts`, intentionally without
`--hot`. On Bun 1.3.14, an ordinary backend hot reload can permanently kill all
timers while HTTP keeps serving, leaving sessions stuck until a restart. The
in-process frontend watcher still rebuilds and broadcasts frontend changes.
Every backend change, including routes, WebSocket handlers, agent loops, and
runner internals, needs one deliberate `systemctl restart opensession` after
the change is committed and pushed.

Restarts are graceful — and since 2026-07-11 they no longer kill in-flight engine turns. `opencode serve` processes spawn via `systemd-run --user --scope` into transient user scopes OUTSIDE the unit's cgroup (`src/server/opencode-detach.ts`; registry at `~/.opensession-opencode-servers.json`), so a restart leaves them — and every turn they're executing — running. SIGTERM stops new intake, drains only the runs a restart would actually kill (bounded by `SHUTDOWN_DRAIN_MS`, default 60s; unit `TimeoutStopSec=80` must stay above it), and exits; with all runs on detached servers the restart is near-instant. On boot, surviving servers are adopted back into the pool (health-checked; stale ones pruned) and journaled runs REATTACH to their live turns (`tryReattachOpencodeRun` — SSE re-pump + transcript gap backfill from opencode's SQLite) instead of being re-prompted; the continuation re-prompt remains the fallback for dead servers. Kill switch: `OPENSESSION_OC_DETACH=0` reverts to direct-child spawns. `KillMode=mixed` stays required (SIGTERM only the bun parent so the drain/journal run). The deployed `/etc/systemd/system/opensession.service` is a **copy** of the repo `opensession.service`, not a symlink — sync with `sudo cp` + `systemctl daemon-reload`.

## Automation least-privilege

Automation runs (especially event-triggered ones like Plain ticket triage) process untrusted text — customer ticket content is data the agent reads, never configuration for the run. Constraints are enforced at the tool/env layer, not just in prompts:

- Agent subprocesses get a minimal env (PATH, HOME, LANG, OPENSESSION_MODEL) — no tokens from ~/.opensession.env. MCP servers receive their own credentials via mcp-config.json per-server `env` or load it themselves (workos-mcp wrapper).
- Each automation has an optional `mcpServers` allowlist (per-automation field, settable via the API); runs only see those servers. Triage uses six (`plain`, `workos`, `tinybird`, `linear`, `sentry`, `stripe`) so it can look up the customer, analytics, billing, related issues and errors while investigating.
- Stripe is money-moving, so it gets a third enforcement tier beyond allow/deny: the tools in `STRIPE_CONFIRM_TOOLS` (runner-shared.ts: create_refund, cancel/update_subscription, and the raw-API mutators stripe_api_execute + stripe_api_write since they can hit any permitted endpoint — keep this list in sync with mcp.stripe.com's live catalog). The MCP uses a restricted key (write on Refunds + Subscriptions + Invoices only — invoice voiding included; read on core billing resources, nothing else — Stripe enforces this ceiling server-side). On the opencode engine there is no per-call approval card, so the confirm tools are STRIPPED from the model's tool list on every run — the server stays mounted and Stripe reads keep working. Guidance differs by run type: unattended runs get post-the-proposal-in-your-note wording, interactive runs get ask-the-human-in-this-session wording (dropping the whole server from interactive runs was tried and reverted: it blanked Stripe reads in dispute-investigation replays for no security gain — money-movers were never reachable either way, and the restricted key's write ceiling is enforced by Stripe server-side).
- Automation runs hard-deny *customer-facing and identity-mutating* tools (enforced for direct runs and interactive resumes of automation sessions): Plain thread writes (reply_to_thread, mark_thread_done/todo, snooze_thread) and the WorkOS write/destructive subset (create/delete/update user+org, revoke, invitations, password/verification emails, impersonation URLs). Reads stay allowed; suggested customer replies go in an internal Plain note. Linear (incl. issue creation) and Sentry are internal, so their writes are allowed — that's the "spin off work" affordance.
- Everything runs on the **opencode engine** (single engine since 2026-07-09; the legacy Claude/Codex SDK runners are deleted). runAutomation maps the automation's model tier onto opencode at dispatch (`opencodeAutomationModel` — claude-X → opencode/anthropic/claude-X, unset → `DEFAULT_OPENCODE_AUTOMATION_MODEL` in automations.ts). Deny-sets are enforced by STRIPPING the tools from the model's tool list via OpenCode's `tools` config (`opencodeRunPolicy` in opencode-runner.ts, `<server>_<tool>` ids verified live), and the Stripe confirm tools fold into that deny-set with the post-in-note message — automations get Stripe reads, never the money-movers. opensession-admin/opensession-sessions and per-user (`allowedUsers`) servers stay out of automation runs. The run gate (`opencodeGateReason`) is deny-by-default on journal kind: interactive kinds (prompt/goal/create/linear/slack), unattended kinds (automation/plain/action/security-scan/github-*), everything else refused.
- `mode` is per-automation: "ask" runs read-only on the main checkout (no worktree, no Write/Edit); "code" gets an isolated worktree with Write/Edit and can open PRs (never merge — PRs are the human gate). Triage runs in code mode: it can implement a fix in its worktree and open a PR for review, or recommend the fix in the note. Code mode still carries every other scoping (MCP allowlist, denied customer/identity writes, IMDS blocked, minimal env) — only the worktree + write tools differ from ask.
- When adding an automation, scope it: pick ask mode unless it must write, and name only the MCP servers it uses.

## Per-user MCP servers (`allowedUsers`)

An MCP server in `mcp-config.json` can carry an optional `allowedUsers: string[]`. When set (non-empty), only runs whose **user** resolves to one of those people get that server's tools; everyone else's sessions never see it. Omitted/empty = available to everyone (the default, unchanged behavior). Entries are matched by `userMatchesAny` (src/server/shared/user-mappings.ts) through the same identity table as commit attribution, so a teammate's name matches a run user given as their short name, a nickname, their email, or their Slack id. Example use: scope a finance/expenses MCP server to the one or two people who should see it.

- Enforcement is at the runner layer, not the prompt: `filterMcpServers(allowlist, user)` (runner-shared.ts, consumed by `buildOpencodeMcpConfig` in opencode-runner.ts) drops a restricted server the run's user isn't cleared for, and strips the `allowedUsers` field before the config reaches the engine. Both allowlist (per-automation least-privilege) and the per-user gate apply.
- The `user` is threaded from the run paths (`runSessionPrompt`, both `create_session` paths, goal wakes, the Slack/Linear loops) through `runAgent` → `runOpencode`, and is journaled on the `ActiveRunRecord` so a resume after a restart keeps the same visibility. **Automation runs pass no user**, so a `allowedUsers`-restricted server is invisible to them — untrusted ticket text can never reach a restricted server, even if the automation's own `mcpServers` allowlist names it (fail-closed).
- Manage it from the Connections UI (the Add-MCP form has an "Allowed users" field; each server card has a Restrict/Edit-access button → `PUT /api/connections/mcp/:name` with `{allowedUsers}`), or via opensession-admin (`add_mcp_server`'s `allowedUsers`, and `set_mcp_allowed_users` to change it on an existing server). Backing helpers: `addMcpServer` / `setMcpAllowedUsers` in src/server/connections.ts.
- **A change to the runner-layer filtering needs a real `systemctl restart`**
  (see "Frontend rebuilds & restarts"). Adding/removing/re-scoping a server in
  `mcp-config.json` itself is read fresh per run, but until the process runs the
  new `filterMcpServers`, `allowedUsers` is neither enforced nor stripped — so
  restart after wiring a restricted server.

## Per-user GitHub auth + web sign-in (opt-in, config `integrations.github`)

Off by default — with no config the bot-PR + localStorage-name-picker behavior
is byte-identical. Opting in (`integrations.github: { userPrAuth: true,
oauthClientId: "<GitHub App client id>" }`; env OPENSESSION_GITHUB_CLIENT_ID
wins over the config id) activates BOTH halves at once:

- **PRs as the session owner** (src/server/github-auth.ts): teammates connect
  their GitHub account via the OAuth *device flow* (Connections UI card, or
  implicitly by signing in). Tokens live per-login in
  `~/.opensession-github-auth.json` (0600, never returned by any API). The
  runner injects them as GH_TOKEN/GITHUB_TOKEN into the engine-server env —
  interactive kinds only and never a least-privilege run (`policy.unattended`:
  automations, deniedTools carriers incl. the Slack/Linear loops keep the bot
  credential, fail-closed). The run user resolves to a login through the SAME
  identity table as commit attribution, so the mapping is config
  (identity.team[].github), not code. The PR-attribution instructions swap
  the `--assignee` bot wording for "authored by them" when the token rides.
  Injection lives in opencode-runner.ts ⇒ **needs a real restart**.
- **GitHub web sign-in** (src/server/web-auth.ts + routes/auth.ts): when
  active, the UI's name picker is replaced by a real sign-in (UserGate →
  device flow → HttpOnly `opensession_auth` cookie; sessions in
  `~/.opensession-web-sessions.json`, sliding 90d). Every `/backstage/api/*`
  request and the UI WebSocket 401 without it (gate in opensession.ts's fetch
  preamble; exempt: `/api/auth/*`, run-ws/rpc-ws dial-backs, page/asset
  loads). Only logins on identity.team may sign in. The verified identity
  OVERRIDES client-claimed `user` on every WS message and stamps
  `createdByLogin` on new sessions; a one-time boot migration backfills
  `createdByLogin` onto existing sessions from `createdBy` (marker:
  `~/.opensession-chats/.github-user-migration.json`). Non-browser callers
  (curl/CDP recipes) authenticate with `Authorization: Bearer <token>` using a
  token from the web-sessions file.

Two sign-in flows, both backed by the same token store: the **redirect
(authorization-code) flow** is primary when `oauthClientSecret` is configured
(`/api/auth/login` → GitHub authorize → `/api/auth/callback`, CSRF state
cookie; the app's registered callback URL must literally be
`<publicBaseUrl>/api/auth/callback`), and the **device flow** stays as the
fallback (the "use a device code" link — needed on the iOS PWA, where a
redirect can return into Safari instead of the PWA, and works without the
secret). GitHub side: one org-owned **GitHub App** with "Enable Device Flow"
checked, the callback URL set, and installed on your org → All repositories,
installable only on that account. GitHub App user tokens are what scopes
teammates' tokens to your org (see the public-repos section): they can't
reach public/third-party repos, they expire ~8h, and github-auth.ts refreshes
them via a rotating refresh token (20-min ticker parked on globalThis +
refresh-on-boot; getters never hand out an expired token — runs fall back to
the bot credential, web mutations 403 to "connect your account"). A refresh
rotates the token string, which changes the shared-server config hash →
drain-respawn at next run start, by design.

## Self-management tools (Slack + interactive OpenSession sessions)

The `opensession-admin` in-process MCP server (src/agents/slack/admin-tools.ts) lets the agent manage its own setup from Slack: channel memory (remember/list_memory/forget) and — gated to the trusted user (`isAdmin` = no `ALLOWED_SLACK_USER_ID` set, or sender matches it) — automations (list/create/update/delete/run) and MCP connections (list/add/remove). It is wired ONLY into interactive Slack runs (handlers.ts `processMessage`); automation runs never go through there, so they never receive these tools. Do not add `opensession-admin` to automation/`runAgent` paths — that would let untrusted ticket text reconfigure the agent. Channel memory is scoped in src/agents/slack/memory.ts (public channel → shared `workspace` store; private channel/DM → isolated, with read-only workspace view) and auto-injected into the system prompt each run.

Both `opensession-admin` and `opensession-sessions` are ALSO available inside **interactive OpenSession sessions** (web UI + loops), not just Slack: `interactiveMcpServers(user, sessionId)` (src/server/interactive-mcp.ts) builds them and they are passed as `inProcessMcp` from the interactive run paths (`runSessionPrompt`, both `create_session` paths). They're withheld from automation runs **and** from interactive resumes of automation-owned sessions (gated on `!isAutomationSession`, the same gate as `deniedTools`) — untrusted ticket text must never reach these tools. OpenSession is network- and team-gated and already exposes all of this through its UI, so interactive users are treated as `isAdmin: true` there. The in-process servers are built with our own `src/server/inprocess-mcp.ts` (a thin @modelcontextprotocol/sdk wrapper) and reach opencode runs as stdio MCP proxies that forward to the in-process tools through OpenSession's run-RPC socket; the Slack loop registers its own slack-context server set per run via `registerSessionMcpServers` (run-rpc.ts) so those proxies execute the right context. The runner adds a short "Managing <persona.name>" context block when these tools are present so the session knows they exist.

The `opensession-sessions` in-process MCP (src/agents/slack/sessions-tools.ts) is a sibling, wired the same way (interactive runs only — Slack and OpenSession sessions per above — never automations). It lets the agent see and steer every *other* OpenSession session: read tools `list_sessions` (with a `waiting` filter for sessions blocked on an AskUserQuestion) and `get_session` (state + pending question + transcript tail) are open to any whitelisted user; the control tools — `answer_session_question` (resolves a paused question), `send_to_session` (steer/queue/start a turn), `cancel_session`, `create_session` — are gated to the trusted user via `isAdmin`. The tools don't touch in-process state directly; they go through the `SessionControl` registry (src/server/session-control.ts) that src/server/session-control-wiring.ts populates at boot with the same helpers (`runSessionPromptAndDrain`, `steerAgentRun`, `makeAskHandler`, the `pendingAsks`/`promptQueues` maps) the WebSocket handlers use — so steering from here behaves exactly like a human in the web UI, and an autonomous monitor can call the same registry directly without the MCP. Sessions whose runs aren't owned by this process (CLI/tmux) are surfaced as `observe-only` and can't be steered/cancelled. Do NOT wire `opensession-sessions` into automation/`runAgent` paths — cross-session control from untrusted ticket text would be a privilege-escalation path. (Sole carve-out: `automation.selfImprove` below, which grants the spawn_task suite only — never answer/send/cancel/create.)

**Papercuts is the one deliberate exception** to "no in-process servers for automations": `opensession-papercuts` (src/agents/slack/papercuts-tools.ts, store in src/server/papercuts.ts → ~/.opensession-papercuts) is an append-only friction log with no reads of anything sensitive and no control surface, so automation runs DO carry it (automations.ts registers the instances per run). Two invariants keep that safe: the run-rpc interactive builder (interactive-mcp.ts) fails closed for automation-owned sessions — a registered automation run token can never resolve the admin/sessions siblings through the socket — and the "Managing <persona.name>" instructions block is gated on `opensession-sessions` presence, not on any in-process server. Per-repo toggle (default on) in Settings → Papercuts; entries mirror into the audit log so the digest/Dreaming sees them. Keep new additions to automation runs held to the same bar: append-only, nothing sensitive readable, no control surface — anything more stays interactive-only.

**Self-improving automations (`automation.selfImprove`) are the second, human-set exception** (human-authorized per instance; first user: the nightly Dreaming reflection). A flagged automation's runs — and thread-reply resumes of its sessions (run-session.ts + the run-rpc fallback builder both honor the flag) — additionally carry two scoped servers: `opensession-sessions` in `automationSelf` shape (sessions-tools.ts — list/get reads plus the `spawn_task`/`task_status`/`cancel_task` suite ONLY; the answer/send/cancel/create controls on other sessions stay isAdmin-gated and are never included) and `opensession-self` (src/agents/slack/self-improve-tools.ts — read own record + `update_own_prompt`, own automation only, timestamped backup + `automation_self_update` audit event, length floor against degenerate rewrites; schedule/model/mode/repo stay human-only via `updateAutomationPromptSelf` in automations.ts). Containment: spawned children go through the same createSession path (PR-gated, spawn-depth ≤ 2), and the flag is settable only by humans (API/UI) — never grant it to automations triggered by untrusted event/ticket text (Plain triage, channel watches); it's meant for introspective/scheduled ones whose input is our own telemetry.

## Model routing and delegation

Interactive sessions should act as orchestrators, not as the only worker. Use
the OpenSession `opensession-sessions` MCP tools to spin up focused worker
sessions when that reduces context noise or parallelizes work.

Pick the model that fits each task — intelligence and taste come first, cost
isn't a reason to downgrade. All models run on the opencode engine (ids are
`opencode/<provider>/<model>`; bare native ids map onto that form at dispatch).

How to delegate from an OpenSession session:
- Use `opensession-sessions.create_session`, setting `model` to whatever fits
  the worker's task.
- For workers that only need filesystem/code access, pass `mcpServers: []` so
  unrelated external MCP startup does not slow or block them.
- Set `repo` to the registered repo id the worker should inspect or edit
  (one of the repos registered in your config — see "Multi-repo sessions").
- Use `mode: "ask"` for read-only investigation on the main checkout.
- Use `mode: "code"` plus a branch name for implementation work that can edit
  files or open a PR.
- Give worker sessions self-contained prompts: scope, repo/worktree path,
  relevant files, constraints, acceptance criteria, and exactly what to report
  back. Ask for summarized findings and file references, not raw dumps.
- Keep the final call in the orchestrator session. Inspect the worker's
  summary, diff, tests, and assumptions; rerun, steer, or escalate to a smarter
  model if the result misses the bar.

Engine notes: the opencode engine has no mid-turn steer — a busy send queues
and delivers as the next turn. Anthropic models run through the bundled
Meridian bridge on your configured Anthropic account pool; OpenAI models run
on your configured OpenAI (ChatGPT-OAuth) account pool. One-shot utility calls
(titles, branch names, intent classifiers) go through `opencodeOneShot`
(src/server/opencode-oneshot.ts) on a shared tool-less server. Runner code is
runner internals — changes need a real restart.

OpenCode server pools (since 2026-07-09): eligible interactive runs (kinds
prompt/goal/create/linear/slack, no MCP allowlist, no prebuilt proxies, no
opensession-goal-self) multiplex onto ONE shared always-warm `opencode serve` per
(bridge account × user), using per-session `?directory=` instances and
per-prompt model/system/agent/tools; opensession-* calls route per session via
src/server/opencode-plugin-session-tag.js + run-rpc's ocSession registry. Automations and
other unattended kinds keep per-session servers so their least-privilege MCP
allowlist stays config-level. Full contract in opencode-runner.ts's module doc
("Server lifecycle"); adding a new in-process opensession-* server requires adding
it to SHARED_INPROCESS_SERVERS or its sessions silently fall back to
per-session servers.

Priority rule for shipped work: intelligence > taste > cost. Cost is only a
tie-breaker. Do not ship mediocre output just because it was cheaper to produce.

## Multi-repo sessions

A session is no longer single-repo. Beyond its primary `project`/`worktreeDir`/`branch`, it can **attach** secondary repos (`attachedRepos: {project,branch,dir}[]` on the session file + `UnifiedSession`). The registered repos live in `REPOS` (`src/server/worktree.ts`) — the repos registered in your config, each with a `defaultBranch` and `ghRepo` (`owner/name` for the gh CLI). All but the self-hosted OpenSession repo (`sharedCheckout`) use the normal worktree+PR flow.

- **Attaching** creates (or reuses) an *isolated* worktree via `prepareAttachedWorktree` (never another repo's shared main checkout — that's the "parked on a random branch / collisions" trap). Default branch = the session's primary branch, so cross-repo PRs line up. Two entry points, both hitting `POST /api/sessions/:id/attach-repo` → `attachRepo()` in src/server/session-repos.ts: the `opensession-repos` in-process MCP server (`attach_repo`/`list_repos`, src/agents/slack/repos-tools.ts — wired in `interactiveMcpServers` exactly like the other sibling servers, interactive runs only, never automations) and the `RepoBar` UI in the session viewer. Detach via `POST /api/sessions/:id/detach-repo` (POST, not DELETE — a DELETE on `/sessions/:id/...` is swallowed by the generic session-delete route).
- **Agent awareness**: `runSessionPrompt` passes `reposNote` (built by `buildReposNote`) through `runAgent`; the opencode runner injects it via the per-session instructions file (OpenCode's system-append channel — see buildOpencodeInstructions). It lists primary + attached repos with their worktree paths so the agent cd's into the right isolated checkout. Only present when the session has attached repos.
- **@-mentions** (`GET /api/files`) search the primary worktree + every attached repo; cross-repo hits insert as `@<project>:path` (primary stays a bare path) and carry a repo label.
- **Diff** (`GET /api/sessions/:id/diff`) returns `{ repos: [{project,dir,primary,diff}] }` — one `getSessionDiff(dir, project.defaultBranch)` per repo. `DiffPanel` shows a repo switcher when >1 repo changed.
- **PR** routes accept `?repo=<project>`; `resolvePrTarget` maps it to the right `ghRepo`+branch (primary branch, or an attached repo's branch). `pr-info.ts` functions take a `repo` arg (caches keyed by repo+branch). `PrPanel` shows a repo switcher when a session spans repos. The Reviews list table still only surfaces the *primary* repo's PR columns — attached-repo PRs live inside the session's PR tab.
