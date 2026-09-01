# Slack

The Slack agent lives in
`packages/core/opensession-server/src/agents/slack/`. It turns DMs and
@-mentions into agent runs, keeps worktree-channel sessions, handles Block Kit
actions and link unfurls, and supplies watched-channel events to automations.

## Current transport support

The running server currently supports **HTTP Events API intake only**.
`SlackAgent.getRoutes()` always registers `/slack/events` and `/slack/actions`,
and its health response always reports `transport: "http"`. There is no Socket
Mode client in the server.

The setup UI and manifest generator currently expose a Socket Mode choice and
accept `SLACK_APP_TOKEN`, but the runtime never reads that token. Do not select
Socket Mode or rely on an `xapp-…` token. Configure public ingress, select
**HTTP**, and set `SLACK_SIGNING_SECRET`. An app token does not make the signing
secret optional and does not remove the HTTP routes.

## Set up the app

1. Configure an HTTPS origin under **Settings → Domains and ingress → Public callbacks**. It must route
   to the fail-closed gateway on `127.0.0.1:3860`; see
   [Public ingress](install.md#public-ingress).
2. Open **Settings → Integrations → Slack → Set up**, select **HTTP**, and click
   **Create Slack app**. The generated manifest comes from
   `src/frontend/lib/slack-manifest.ts` and includes the bot scopes, bot event
   subscriptions, interactivity, the two request URLs, the assistant surface,
   and the public UI hostname used for session-link unfurls. The JSON is also
   copyable for Slack's **App Manifest** page.
3. Create the app from that manifest and install it to the workspace.
4. Copy the `xoxb-…` bot token from **OAuth & Permissions** and the signing
   secret from **Basic Information** into the Open Session dialog. Set
   `ALLOWED_SLACK_USER_ID` to the trusted operator's Slack member ID.
5. Enable Slack, save, and restart Open Session. Saving writes credentials and
   the explicit enable flag to `~/.opensession.env`; the loaded module and its
   process-level credentials change only after restart.
6. Invite the bot to every existing channel whose history it should read. Then
   test a DM, an @-mention, and a Block Kit action.

A manifest cannot contain credentials. For a manually managed installation,
put the same values in `~/.opensession.env`, set
`ENABLE_SLACK_AGENT=true`, and run `opensession restart`. Alternatively,
`integrations.slack.enabled: true` in `~/.opensession/config.json` enables the
agent only when `ENABLE_SLACK_AGENT` is absent. If the env flag exists, only the
literal value `true` enables it; see
[integration boot guards](integrations-misc.md#boot-guards).

## Environment variables

| Variable                     | Required                 | Purpose                                                                                                                                                                    |
| ---------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENABLE_SLACK_AGENT`         | to enable by environment | Only the literal `true` enables Slack. When absent, `integrations.slack.enabled` decides                                                                                   |
| `SLACK_BOT_TOKEN`            | yes                      | Bot user token (`xoxb-…`) for the agent's Slack Web API calls. Missing or invalid credentials produce warnings and failed Slack operations rather than stopping the server |
| `SLACK_SIGNING_SECRET`       | yes                      | Verifies both HTTP endpoints. Missing or invalid signatures fail closed with 401; request timestamps must be within five minutes                                           |
| `ALLOWED_SLACK_USER_ID`      | strongly recommended     | Restricts ordinary DMs and mentions and sets the `isAdmin` gate for admin, session-control and human-ask tools. Unset means every sender admitted by routing is an admin   |
| `WORKTREE_HOOK_SECRET`       | only for worktree hooks  | Value callers send as `x-worktree-secret` to the two `/worktree/*` routes. Missing means every hook request is rejected with 403                                           |
| `SLACK_MENTION_INTENT_MODEL` | no                       | Mention intent classifier; default `claude-haiku-4-5`                                                                                                                      |
| `SCHEDULE_WHEN_MODEL`        | no                       | Natural-language parser used by one-off scheduling tools; default `claude-haiku-4-5`                                                                                       |
| `SLACK_APP_TOKEN`            | do not use               | Declared by the setup registry but not consumed by the runtime; it does not enable Socket Mode                                                                             |

The setup dialog manages the bot token, signing secret, allowed user and
worktree-hook secret. It does not expose the two model overrides. Set those
directly in `~/.opensession.env` and restart.

## HTTP intake and routes

With the Slack integration enabled, its exact routes are registered on public
ingress:

- `POST /slack/events`: Events API callbacks and Slack's `url_verification`
  challenge.
- `POST /slack/actions`: Block Kit actions and modal submissions.
- `POST /worktree/create-channel` and `POST /worktree/archive-channel`: shared-
  secret worktree-channel hooks.
- `POST /github/webhook`: a compatibility fallback only when the separate
  GitHub integration is disabled. When GitHub is enabled it owns this route;
  see [GitHub](github.md).

`/slack/events` and `/slack/actions` verify Slack's v0 HMAC over the exact body.
Slack request bodies are capped at 1 MiB; worktree-hook bodies at 64 KiB.
DM, mention, watched-channel and unfurl event IDs are persisted for a
five-minute deduplication window. DM and mention handlers enqueue work
asynchronously after dispatch; interactive actions are dispatched before their
200 response.

The generated manifest subscribes to:

- `app_mention`
- `assistant_thread_started`
- `link_shared`
- `message.channels`, `message.groups`, `message.im`, and `message.mpim`

Plain channel messages are used for watched-channel automations. They do not
mirror every message from a channel into an Open Session session.

## Bot scopes

The generated manifest currently grants these bot scopes:

- Writing: `chat:write`, `chat:write.customize`, `files:write`,
  `reactions:write`, `assistant:write`
- History: `channels:history`, `groups:history`, `im:history`, `mpim:history`
- Events, links, and emoji: `app_mentions:read`, `links:read`, `links:write`,
  `emoji:read`
- Channels and people: `channels:read`, `groups:read`, `im:read`,
  `channels:manage`, `groups:write`, `channels:join`, `im:write`, `users:read`

These cover posting and updating messages, assistant streaming and status,
reactions, session-link unfurls, response-media uploads, channel management,
history and user lookup. The bot must be a channel member to read that
channel's history. Open Session joins channels it creates or manages; invite it
to pre-existing channels yourself.

Slack responses can upload at most 10 files, each no larger than 20 MiB.
Inbound prompt image handling inlines at most six images and skips an image
over 4 MiB; non-image attachments are listed to the agent but not inlined.

## Who can drive it

`ALLOWED_SLACK_USER_ID` is checked in
`packages/core/opensession-server/src/agents/slack/handlers.ts`:

- Ordinary DMs and ordinary channel mentions are ignored when the sender does
  not match the configured ID.
- A mention in a managed worktree channel may come from any channel member.
- A mention, or a DM reply, in a thread already linked to an Open Session
  session steers that session. An exact teammate reply to a pending human ask
  is also accepted. These narrow reply paths run before the ordinary allowlist.
- `isAdmin = !ALLOWED_SLACK_USER_ID || sender === ALLOWED_SLACK_USER_ID`.
  Admin access unlocks automation and MCP-connection changes, session-control
  mutations, and creating or cancelling teammate asks. A non-admin whose
  message reached a bypass path keeps memory, read-only session and human-ask
  subsets, the current-user question handler, and the Slack-loop GitHub PR
  action tools.

External MCP servers still apply their own `allowedUsers` gate at the runner
layer. Configure `identity.team` with each member's `slackId` so Slack senders
resolve to the same people used for commit attribution and connector access.

## What triggers what

- A new top-level **DM** starts a code-mode Slack session using the default
  repository's configured checkout policy; replies in that DM thread continue
  it.
- A regular-channel **@-mention** is classified as a dedicated PR action, an
  ask in the selected repository without a new worktree, or a code task using
  that repository's configured checkout policy.
- A **worktree-channel @-mention** drives the one session associated with that
  channel, across its Slack threads.
- A mention or DM reply in a **session-linked Slack thread** is queued into the
  linked Open Session session and replies back into that thread. A reply
  beginning with `retrigger` reruns the linked automation when applicable.
- A **top-level message in a watched channel** fires matching channel-watch
  automations. Thread replies, bot messages, and messages that mention the bot
  do not fire that watch path.
- A **shared Open Session link** for the configured UI hostname is unfurled with
  in-process session data.
- `assistant_thread_started` sets the suggested prompts for Slack's assistant
  surface.

## Channel memory

Slack-loop memory is scoped like Slack visibility and injected into each run:

- public channel: shared `workspace` scope
- private channel: writable `channel-<id>` scope plus read-only workspace scope
- DM: writable `user-<id>` scope plus read-only workspace scope

The `remember`, `list_memory`, and `forget` tools manage those scopes. Memory
v2 is the default and stores records in
`~/.opensession/memory/memory-v2.sqlite` (or `OPENSESSION_MEMORY_DB`). Legacy
and shadow modes, selected with `OPENSESSION_MEMORY_MODE=legacy|shadow`, use
one JSON file per scope in `~/.opensession/memory/`. Existing
`~/.opensession-memory/` state remains the fallback when the grouped directory
does not exist.

## Channel and identity configuration

No destination channel or user is compiled into the agent. Optional destinations
and display metadata live in `~/.opensession/config.json`:

| Setting                                     | Used for                                                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `integrations.slack.workspaceId`            | Building `app.slack.com` deep links when Slack channel references are rendered in transcripts                                                                            |
| `integrations.slack.channelNames`           | Mapping `C…` channel IDs to names in transcripts and providing the configured Slack-channel list for feed and composer UI                                                |
| `integrations.github.docsSyncChannel`       | Channel scanned after a docs-sync PR merges so Open Session can find its existing bot announcement and add a check reaction; this setting does not post the announcement |
| `integrations.github.shippedChangesChannel` | Default channel for sharing merged visual changes; it must also appear in `integrations.slack.channelNames`                                                              |
| `grafanaPoll.slackChannel`                  | Destination on each Grafana-poll automation; see [Grafana poller](integrations-misc.md#grafana-poller)                                                                   |

Slack IDs map to people through `identity.team[].slackId`; extra display-only
mappings can go in `identity.slackNames`. Without a roster, only exact raw-ID
fallbacks work; names, aliases, cross-provider identities, commit attribution
and teammate resolution cannot identify Slack senders.

## Separate Slack connections

Two optional facilities are separate from inbound Slack-agent setup:

- The repository's `scripts/mcp-slack.ts` is a direct Slack MCP server. When
  you add it to `mcp-config.json`, its per-server environment requires
  `SLACK_BOT_TOKEN` and `SLACK_TEAM_ID`; `SLACK_CHANNEL_IDS` optionally limits
  channel listing to a comma-separated set. Apply normal MCP `allowedUsers`
  gating.
- Personal Slack grants let signed-in people read or post as themselves. Set
  `SLACK_OAUTH_CLIENT_ID` and `SLACK_OAUTH_CLIENT_SECRET`, register
  `<OPENSESSION_UI_BASE>/api/connections/mcp-oauth/callback` as the Slack OAuth
  redirect, then connect under **Settings → Account** (personal) or
  **Settings → Connections** (workspace grant). These variables are not needed
  for the inbound bot agent.
