Default to Bun instead of Node.js.

Keep instance-private operator instructions in an untracked `AGENTS.local.md` or
`CLAUDE.local.md`, never in this file.

## Publishing to repositories

Repositories owned by your own organization are fair game, including public
ones: commit, push, and open issues, comments, and pull requests there as part
of normal work.

For any repository outside your organization, public or third-party, never
publish without explicit user confirmation in the current conversation. Local
investigation and commits are allowed; issues, comments, branches, forks,
pushes, and pull requests are not.

## Choose the client first

Open Session has five clients:

- Web UI: `packages/core/opensession-server/src/frontend/`
- Phone web/PWA: the same web bundle at phone width
- Electron shell: `packages/clients/mac/`
- Native Swift app: `packages/clients/ios/`
- Chrome extension: `packages/clients/chrome/`

Once a conversation names a client, keep working on that client unless the user
changes scope. Ask when the target is unclear. For web changes, build desktop
and phone together. For protocol, preference, or transcript changes, check the
native app and Chrome extension for matching wire models or behavior. Read the
nearest nested `AGENTS.md` before editing a client.

## Shared checkout and deployment workflow

Sessions edit the shared `main` checkout, but the live services run from an
immutable release worktree selected by `~/.opensession/deploy/current`. Other
sessions may edit and stage files in the shared checkout at the same time.
Uncommitted checkout edits never become live, including frontend edits.

- **Local `main` must always equal `origin/main`.** Start every task, and
  finish every push, with `bun scripts/shared-checkout-sync.ts`. It fetches,
  fast-forwards `main` in place, and carries every uncommitted edit, yours or
  another session's, onto the new base without stash or reset. It is the only
  sanctioned way to move `main`. If it reports a conflict in a file you own,
  reapply that edit onto the current content before staging it; if the file
  is not yours, continue, its owner is responsible for it. Never work around
  a stale checkout by rebasing only your own commit, by committing from a
  throwaway worktree, or by leaving `main` behind: each of those leaves the
  shared checkout stale for everyone.
- **Do not commit until `bun run check` passes in the checkout.** Run it after
  finishing the change and before the final fetch and commit. It checks
  formatting, type-checking, lint, isolated unit tests, and strict transcript
  snapshots. If it fails, do not commit. Platform installer jobs remain CI-only,
  so installer or service-definition changes also need their documented
  platform-specific verification.
- **Do not commit until your branch includes the latest `origin/main`.** After
  the checkout gate passes, immediately before every `git commit`, run the
  sync tool again, then `git merge-base --is-ancestor origin/main HEAD`. If it
  fails, do not commit: rebase the local commits onto `origin/main` and resolve
  every conflict first. Run the sync tool again immediately before pushing; if
  the remote moved after your commit, rebase that commit onto the new
  `origin/main` before pushing.
- Rebasing your own unpushed commits is the only manual sync left. Preserve
  every staged, unstaged, and untracked change while doing it. Never use
  `git stash`, autostash, `git pull --rebase --autostash`, reset, clean,
  force-push, or an ordinary pull that creates a merge commit in this checkout.
  After pushing, run the sync tool once more and verify
  `git rev-list --left-right --count HEAD...origin/main` reports `0 0` before
  continuing.
- Leave no residue. Once your change has landed, from here or from anywhere
  else, the files you edited must be clean in this checkout. An edit that
  landed elsewhere becomes clean the next time the sync tool runs; an
  abandoned half-edit does not, and it sits on every later sync report until
  its owner deals with it. Before a session ends, commit your work or restore
  only your own files with `git checkout origin/main -- <your files>`.
- Never reset, revert, switch branches, or discard unrelated work.
- Stage only your files. Use `git add -p` for shared high-traffic files.
- Inspect `git diff --cached --name-only` and `git diff --cached` before every
  commit. Commit with a pathspec when the index contains other work.
- Commit and push promptly. Never use `git add -A`.
- Do not use an ad-hoc `systemctl restart`. It only restarts the already pinned
  release and can violate the gateway/kernel rollout order.
- Commit and push before deploying. Deployment may be autonomous when the task
  calls for making the change live, but it is a shared operation, not a
  per-session completion ritual. Concurrent main-line requests queue and
  coalesce to the newest fast-forward commit; targets already covered become
  successful no-ops. Do not manually retry a queued request.
- Treat a successful deploy as fully settled. Success already means the target
  release is active and its required health checks passed; the rollback safety
  window is protection, not a cooldown. Continue immediately with the next
  promotion or verification. Do not wait for a shared deploy to "settle", add
  an arbitrary delay, or wait out the safety window. If a lifecycle operation
  still owns the deploy lock, submit the normal deploy request and let it queue
  and coalesce instead of polling or sleeping.
- Use `deploy_self` for ordinary frontend, backend, protocol, and dependency
  changes. It classifies the complete diff from the running backend pin. A
  strictly frontend-only diff is built in its immutable target release and
  promoted without restarting any service; everything else uses the standard
  health-gated executor, session-kernel, and gateway restart. The deploy
  controller collapses overlapping main-line requests instead of producing a
  restart train.
- Use the full root deploy, `sudo deploy/deploy.sh <sha>`, instead when a change
  affects live deployment machinery or an artifact that script installs:
  `deploy/{deploy,self-deploy,release-checkout}.sh`, the four
  `opensession*.service` templates, credential installers, the fixed run-host
  helper/installer, or root-deploy-managed systemd units and drop-ins. The full
  deploy refreshes those privileged artifacts before switching the same
  immutable release. Other operator-managed artifacts, such as watchdog units
  and sandbox images, follow their own documented rollout. When unsure, inspect
  `deploy/deploy.sh` rather than assuming a restart applies the change.
- A docs-only change needs no live deploy. A frontend-only change still needs
  `deploy_self`: the production watcher and `/api/rebuild-frontend` use the
  active immutable release, not the shared WIP checkout. `deploy_self`
  automatically takes the restart-free frontend promotion path when the whole
  diff is safe; do not claim a shared-checkout edit is live before that succeeds.

For risky isolated work, use `OPENSESSION_DEV=1` with a dedicated
`OPENSESSION_STATE_DIR`. See `docs/self-development.md` for the deployment
sequence and rollback behavior.

## Server invariants

`packages/core/opensession-server/opensession.ts` is composition and boot code.
Put HTTP handlers in `src/server/routes/`, WebSocket handling in
`src/server/ws-handlers.ts`, and run orchestration in `src/server/run-session.ts`.

Never scan or open every per-session actor SQLite database from the running
service. This includes request handlers, health/readiness, boot recovery,
admin/reliability views, aggregate stats, and periodic maintenance. Cross-session
reads must come from catalog-maintained projections or counters. Work on one
known session may open that session's actor database. Online background work may
open only a hard-bounded set of actors selected by a catalog work index (for
example, actors with due timers); it must never walk the placement catalog,
even in cursored batches. A one-off migration that truly must visit every actor
is an offline operator job, never boot or live maintenance. Never add a
placement-enumeration API to the online store host or a helper that maps an
operation over every placement. The ownership architecture tests enforce this
invariant. Full-fleet SQLite fanout is prohibited because its cumulative open
and query work monopolizes actor lanes and turns live health/session requests
into timeouts.

Server modules must not bind sockets, start timers, or spawn processes at import
time. Put live effects behind idempotent `start*` or `ensure*` functions called
from boot. Run `bun scripts/check-module-side-effects.ts` when changing server
initialization.

## Frontend

Follow `packages/core/opensession-server/src/frontend/AGENTS.md`.

Use Base UI primitives from `frontend/ui/`, Tailwind utilities, and existing
semantic color tokens. Keep `styles/legacy.css` empty. Do not introduce raw
colors or one-off primitives. Check desktop and phone at shipped pixel density.
Use Motion presets from `ui/motion.ts`, preserve reduced-motion behavior, and
publish visual proof for user-visible changes.

Keep UI copy short, direct, sentence case, and consistent with `CONCEPTS.md`.
Do not use em dashes.

## Security

Treat automation inputs as untrusted data. Preserve these boundaries:

- Automation subprocesses receive a minimal environment and an explicit MCP
  allowlist.
- Customer-facing, identity-mutating, and money-moving tools stay unavailable
  where runner policy strips them.
- `opensession-admin`, `opensession-sessions`, and `opensession-repos` remain
  interactive-only unless a narrowly scoped exception is documented and
  enforced server-side.
- Run kinds and user-gated MCP access fail closed.

See `docs/security-model.md` before changing runner policy, credentials,
automations, or interactive MCP wiring.

## Waiting on background work

Do not block the conversation with `sleep` loops while waiting for reviews,
CI, builds, or worker sessions. Check the status once; if it is still pending,
do other useful work or end your reply. Worker reports and completed tasks wake
the session on their own.

## Multi-repo sessions

Attached repositories use isolated worktrees. Never attach another repository's
shared main checkout. Preserve repo-qualified file mentions, per-repo diffs, and
per-repo PR targeting when changing session repository behavior.
