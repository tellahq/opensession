# Linear

The Linear agent (`packages/core/opensession-server/src/agents/linear/`) turns
Linear agent-session assignments into Open Session coding sessions. It prepares
the instance's default repository, offers plan/implement/free-form paths, runs
the work, and uses `gh pr create` after implementation completes.

All Linear assignments target `defaultRepo()`. There is no per-issue repository
routing.

## Prerequisites

- Configure an HTTPS [public ingress](install.md#public-ingress). The OAuth state
  cookie is `Secure`, and the webhook and OAuth routes exist only on this
  gateway, normally port 3860 behind a TLS proxy.
- Configure the intended GitHub repository as the instance's default repo. For
  the branch-and-PR workflow, it must not use the live `sharedCheckout` path
  (unless instance `selfDev` is `"worktree"`). The Linear agent does not request
  an isolated checkout explicitly, so a shared-checkout default repo is edited
  in place and has no dedicated branch for the automatic PR.
- Give the Open Session service user working Git push credentials and ambient
  `gh` authentication for that repository. The final PR helper invokes
  `gh pr create` with the service process's environment and `HOME`.
- The issue's Linear team should have workflow statuses named **Ready** and
  **In Progress**. Planning moves the issue to `Ready`; implementation moves it
  to and auto-starts from `In Progress`. Status matching is case-insensitive,
  but the names are otherwise exact.

## Configuration

Set secrets in **Settings → Integrations → Linear** or in
`~/.opensession.env`. Settings writes the same env file and requires a restart
to load the agent.

| Var                        | Required for                                          | Notes                                                                                                                                |
| -------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `LINEAR_CLIENT_ID`         | OAuth                                                 | Linear OAuth app client ID                                                                                                           |
| `LINEAR_CLIENT_SECRET`     | OAuth                                                 | authorization-code exchange and token refresh                                                                                        |
| `LINEAR_WEBHOOK_SECRET`    | webhooks                                              | HMAC secret; unset or empty rejects every webhook with 401                                                                           |
| `ENABLE_LINEAR_AGENT`      | loading the agent                                     | optional env override; only the literal `true` enables, and any other set value disables                                             |
| `LINEAR_API_KEY`           | current Settings enable gate; optional Plain fallback | the Linear session agent does not read it; the Plain agent uses it only to create Linear issues when no stored OAuth token is usable |
| `OPENSESSION_INGRESS_BASE` | optional global override                              | public origin used by the default OAuth callback URL                                                                                 |
| `OPENSESSION_UI_BASE`      | optional global override                              | private app origin used for links added to Linear sessions                                                                           |

The agent is off by default. If `ENABLE_LINEAR_AGENT` is unset, enable it with
`integrations.linear.enabled: true` in `~/.opensession/config.json`; the env flag
wins when present. See [boot guards](integrations-misc.md#boot-guards).
Restart Open Session after changing the flag or credentials.

The current Settings form marks `LINEAR_API_KEY` as required before its switch
can be enabled, even though the Linear agent runtime does not use that key. If
you do not use Plain's issue-creation fallback, enable Linear directly through
`ENABLE_LINEAR_AGENT=true` or `integrations.linear.enabled` instead of adding an
unneeded personal API key.

## OAuth app setup

1. Create a Linear OAuth application and enable its app/agent actor capability.
2. Register the exact callback described below. Open Session requests scopes
   `app:assignable read write` with `actor: "app"`.
3. Set the client ID, client secret, and webhook secret; enable the integration;
   then restart Open Session. The routes are not registered while the agent is
   disabled.
4. Visit `<public-ingress-origin>/oauth/authorize` in a browser and approve the
   app in the Linear workspace. The callback stores the grant.
5. Configure Linear to send agent-session and issue events to
   `<public-ingress-origin>/webhook`.

OAuth routes:

- `GET /oauth/authorize` redirects to Linear's consent page.
- `GET /oauth/callback` exchanges the code. Grants are stored by organization
  in `~/.linear-agent-tokens.json`, written atomically and refreshed when an
  agent API call finds a token within five minutes of expiry.

The OAuth `redirect_uri` is `integrations.linear.oauthRedirectUrl` when that
value is non-empty. Otherwise it is
`<configuredServer().webhookBaseUrl>/oauth/callback`; that base resolves from
`OPENSESSION_INGRESS_BASE`, then `ingress.publicBaseUrl`, then the private app
origin. Register the resulting HTTPS URL exactly, including its scheme and
path.

The token file can contain multiple organization keys, and webhook handling
selects a token by `organizationId`. Startup session restoration and the Linear
MCP overlay use the first stored organization, however, so operate this as a
single-workspace integration.

### Linear MCP

The agent-session flow does not require an MCP server. If `mcp-config.json` has
an HTTP server named `linear` whose URL contains `mcp.linear.app`,
`withDynamicCredentials()` overlays a stored, currently usable app access token
for each run. A separately stored personal/shared MCP OAuth grant can supersede
that overlay; when no app token is usable, any static MCP header remains
unchanged.

## Webhook intake and lifecycle

Linear signs the raw request body in the `linear-signature` header with
HMAC-SHA256. Open Session verifies it with `LINEAR_WEBHOOK_SECRET` using a
timing-safe comparison. Bodies over 1 MiB receive 413.

Consumed events (`packages/core/opensession-server/src/agents/linear/index.ts`
and `handlers.ts`):

- `AgentSessionEvent` / `AgentSession`:
  - `created` prepares the default repo, persists the session, links its Open
    Session viewer, and asks for plan, implement, or another instruction.
  - `prompted` runs planning, implementation, or a free-form coding turn.
    `signal: "stop"` cancels the current engine run.
  - Planning completion posts a `# Implementation Plan` issue comment, moves
    the issue to `Ready`, and waits. The next reply starts implementation, as
    does a later move to `In Progress`.
  - `dismissed` / `ended` removes the managed worktree, when one exists, and
    the session file.
- `Issue` action `update`: a state change to `In Progress` auto-starts only for
  an existing Linear session with an engine session and an issue comment whose
  body contains `# Implementation Plan` or `## Implementation Plan`.
- When a run returns `IMPLEMENTATION_COMPLETE`, Open Session runs `gh pr create`
  and posts the resulting PR URL to the Linear agent session. A failed PR
  command is reported in Linear but is not retried automatically.

Other event types and actions are acknowledged and ignored. Team IDs are
fetched from each issue; only the workflow status names above are fixed.

## Repository and persistence behavior

For a non-shared default repo, worktrees live at
`<paths.worktreesDir>/<wtPrefix>-<branch>`. `paths.worktreesDir` defaults to
`~/.opensession/worktrees` and can be overridden by
`OPENSESSION_WORKTREES_DIR`. The branch is based on the first two words of the
issue title plus its issue identifier.

Session metadata is stored under `~/.linear-sessions/`. On startup, Open Session
restores files updated within the last seven days when they have a Linear
session ID and either an engine session ID or the `awaiting_direction` phase.
Older files remain on disk but are not restored. An interrupted background turn
is not restarted automatically; a later prompt can continue the restored
session.
