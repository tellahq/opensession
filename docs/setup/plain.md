# Plain (customer support)

The Plain integration (`packages/core/opensession-server/src/agents/plain/`)
adds the Plain TODO queue and thread controls to Open Session's Support UI and
handles Plain webhooks. Humans can reply, leave notes, and change thread state
from the UI. New inbound threads can also trigger a triage automation that
investigates the customer through MCP and leaves an **internal note** with its
findings and a suggested reply. The automation itself cannot reply to the
customer or change thread state.

## Env vars

| Var                           | Required for    | Notes                                                                                                                                                                               |
| ----------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLAIN_API_KEY`               | Plain API calls | required by the integration registry; used by the Support UI and agent's `PlainClient` (`packages/core/opensession-server/src/agents/plain/api.ts`) and by the archive safety sweep |
| `PLAIN_WEBHOOK_SECRET`        | webhook intake  | **fail-closed**: unset or empty means every Plain webhook returns 401                                                                                                               |
| `PLAIN_SPAM_CHECK_MODEL`      | optional        | tool-less pre-triage router model; default `claude-haiku-4-5`                                                                                                                       |
| `PLAIN_REFUND_INTENT_MODEL`   | optional        | tool-less classifier for the legacy mention flow's refund/cancellation approval; default `claude-haiku-4-5`                                                                         |
| `PLAIN_AGENT_API_KEY`         | optional        | key of a separate **Custom agent** machine user for Ask Sidekick (see [Internal agent](#internal-agent-ask-sidekick)); unset, the discussions use `PLAIN_API_KEY`                   |
| `PLAIN_AGENT_MACHINE_USER_ID` | optional        | pins the agent's `mu_…` id instead of resolving it with `myMachineUser` at first use                                                                                                |

Put server secrets and an optional enable flag in `~/.opensession.env`; the
service does not use a checkout `.env`:

```sh
PLAIN_API_KEY=plainApiKey_...
PLAIN_WEBHOOK_SECRET=...
ENABLE_PLAIN_AGENT=true
```

Only the literal value `true` enables an integration through an env flag. If
`ENABLE_PLAIN_AGENT` is unset, use `integrations.plain.enabled: true` in
`~/.opensession/config.json`. The env flag wins when present. See
[integrations-misc.md](integrations-misc.md#boot-guards).

Config keys under `integrations.plain` in `~/.opensession/config.json`:

| Key             | Notes                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`       | enables the agent when `ENABLE_PLAIN_AGENT` is unset; default `false`                                                                                  |
| `apiUrl`        | GraphQL endpoint used by the archive safety sweep; default `https://core-api.uk.plain.com/graphql/v1`                                                  |
| `workspaceId`   | Plain workspace id (`w_…`) for app.plain.com deep links; unset hides the UI's open-in-Plain affordances                                                |
| `mentionHandle` | handle in Plain notes that wakes the mention flow, with or without a leading `@`; default is `persona.name` lowercased with spaces replaced by hyphens |

When the legacy mention flow creates an issue (`GITHUB ISSUE:` in the model's
reply, or `start worktree`), it opens a GitHub issue in the default
repository's `ghRepo` with the GitHub App's repository-scoped credential
(`issues: write`), labels it `feature-request`, and links the thread to it
through Plain's GitHub Issues integration (a `github_issue` thread link with
source id `owner/name/number`). Plain's Top issues then ranks GitHub issues,
and closing an issue moves its linked threads to Close the loop, so never
close or reopen an issue while threads are still linked to it.

The Plain MCP server used by agent runs is separate from the server-side Plain
SDK. Open Session does not bundle a Plain MCP server. Add your compatible
server as `plain` in `mcp-config.json` (or the file selected by
`OPENSESSION_MCP_CONFIG`) and put its credentials, normally another
`PLAIN_API_KEY`, in that server entry's `env` block. See
[install.md](install.md#7-mcp-configjson). Editing MCP configuration is picked
up on the next run.

## Setup checklist

1. Create a Plain machine-user API key and a webhook endpoint signing secret,
   then add them to `~/.opensession.env` as shown above.
2. Set `persona.name`, `persona.company`, and `persona.product`, then configure
   `integrations.plain` in `~/.opensession/config.json`.
3. Configure the `plain` MCP server and any other MCP servers the triage
   automation will use.
4. Create and enable the "Support ticket triage" template in Automations. A
   fresh install does not create it automatically.
5. Expose Public ingress, create a Plain webhook for `POST /plain/webhook`, and
   subscribe it to the three events listed below.
6. Run `opensession restart` because integration loading, env vars, and the
   mention handle are boot-time state. Then run `opensession doctor` and use
   `opensession logs -f` while sending a test ticket.

## Webhook intake

Point the Plain webhook at `POST /plain/webhook` on
[Public ingress](install.md#public-ingress). Send Plain's
`plain-request-signature` header, which Open Session verifies as the lowercase
hex HMAC-SHA256 of the exact request body. Bodies over 1 MiB return 413.

Subscribe the endpoint to these events
(`packages/core/opensession-server/src/agents/plain/handlers.ts`):

- `thread.thread_created`: when an enabled `plain:thread_created` automation
  subscriber exists, filter and route the ticket, then fire every enabled
  subscriber asynchronously.
- `thread.thread_status_transitioned`: when the new status is `DONE`, archive
  every non-archived Open Session session linked to that thread.
- `thread.note_created`: when a note contains the configured mention and its
  author has `actorType === "user"`, deliver it to the newest live linked
  session. If no linked session can accept it, run the legacy mention flow.
  Customer, machine-user, and system notes are ignored.
- `discussion.message_created`, `discussion.turn_stop_requested`,
  `discussion.tool_call_approval_resolved`: the internal agent, below. Pin the
  webhook target to version `2026-09-14` or later; the turn-stop event does
  not exist on earlier versions.

A separate archive safety sweep starts even when the Plain agent is disabled.
With `PLAIN_API_KEY` set, it first runs 60 seconds after boot and then every 15
minutes, checking up to 40 distinct threads with active linked sessions per
pass. The webhook gives immediate archival; the sweep covers missed status
events.

### New-ticket filtering and routing

The gate fetches the thread up to eight times: once immediately, then after up
to seven 15-second waits. It skips the thread when its earliest email/chat was
sent by a Plain user or machine user. If no email/chat appears but other
timeline activity exists after 30 seconds, it treats the thread as an outbound
follow-up or issue-tracker close-the-loop thread and skips it. A still-empty thread
after all attempts fails open and is triaged.

The tool-less router then returns one of three routes:

- `spam`: leave an internal skip note and do not start an automation run.
- `basic`: run the automation with the configured basic-ticket model, default
  `claude-opus-5`.
- `full`: use the automation's own model.

Router errors or unparseable output fail open to `full`. Edit the router prompt
and basic-ticket model in the Plain integration dialog. Fresh installs store
them in `~/.opensession/plain-router.json`; an existing legacy
`~/.opensession-plain-router.json` remains active when the grouped path does
not exist. An empty prompt restores the built-in prompt.
`PLAIN_SPAM_CHECK_MODEL` selects the model that performs this routing, not the
model used by the resulting triage run.

## The triage automation (least-privilege model)

Fresh installs store automation records in
`~/.opensession/automations/<id>.json`
(`packages/core/opensession-server/src/server/automations.ts`). An existing
legacy `~/.opensession-automations/` store remains active when the grouped
store does not exist. Triage fires for every enabled automation whose
`eventKey` is `plain:thread_created`.
Create one from the "Support ticket triage" template in the Automations UI, or
seed one through `integrations.seeds.automations`. Config seeds run only when
`integrations.seeds.enabled` is `true`; they are create-if-absent at boot and
do not overwrite an existing automation.

Scope the automation deliberately:

- **`mode: "code"`** gives each run an isolated writable worktree so it can
  implement and commit a fix. Use `mode: "ask"` for read-only investigation.
  Ordinary automations currently receive no GitHub credential, so this Plain
  triage path cannot push or open a GitHub PR. `prReviewer` adds an instruction
  but does not grant authority; see
  [github.md](github.md#automation-pr-credentials-and-review-requests).
- **`mcpServers`** is the run's allowlist. The template suggests `plain`,
  `workos`, `tinybird`, `sentry`, and `stripe`; remove servers you do not use. `[]` means no external MCP servers. For an ordinary unsandboxed
  automation, omitting the field preserves the legacy behavior of exposing all
  configured servers. Sandbox automations run in fresh disposable Daytona
  Executors and require a qualified provider, a pinned subscription account,
  and an explicit allowlist.
- **Denied writes** are stripped before the model sees its tools. The policy in
  `packages/core/opensession-server/src/server/automation-denied-tools.ts`
  blocks Plain customer replies and thread-state changes, plus WorkOS identity
  mutation, destructive, email, and impersonation tools. Plain reads and
  internal notes remain available.
- **Stripe mutators** in `STRIPE_CONFIRM_TOOLS` are also stripped from normal
  automation runs, while Stripe reads remain available. The run must propose a
  refund or cancellation in its note. The only Plain-specific execution path
  is the separately gated legacy mention approval described below.
- Automation dispatch supplies no user identity, so an MCP server restricted
  with `allowedUsers` is invisible even when named in `mcpServers`. Local tools
  get a minimal explicit environment rather than inheriting
  `~/.opensession.env`; MCP credentials must live in their own server config.

## Mention flow and approvals

A teammate mention on a thread with a live linked session is delivered as that
session's next prompt, with the mention removed. Automation-owned sessions keep
the automation deny policy when resumed.

Without a linked session, the legacy flow in `handlers.ts` runs a code-mode
agent against the default repository checkout with all otherwise eligible MCP
servers. It can draft a customer reply, but posts the draft as an internal note
first. A second verified teammate note such as `@<handle> yes` while the
roughly 30-minute pending confirmation remains active sends the reply as the
Plain machine user and snoozes the thread as waiting for the customer. A
five-minute cleanup timer removes confirmations older than 30 minutes.

The same legacy flow contains the only exception for Stripe money-moving tools.
A tool-less, fail-closed classifier must find both a specific prior
"Proposed refund/cancellation (needs approval)" block and an unambiguous
teammate approval. Only then does a dedicated execution turn expose the Stripe
mutators, and any customer reply it drafts still requires the separate reply
confirmation above. See
[security-model.md](../security-model.md#stripe-a-third-enforcement-tier).

## Internal agent (Ask Sidekick)

Open Session can also be the agent a teammate picks in Plain's **Ask
Sidekick** — from Home or from a thread. Plain calls this a
[custom internal agent](https://www.plain.com/docs/agents/internal-agent):
each Sidekick conversation is a _discussion_, and the agent answers it over
webhooks and the discussion mutations
(`packages/core/opensession-server/src/agents/plain/discussions.ts`,
`discussion-api.ts`, `discussion-mirror.ts`, `discussion-tools.ts`).

One discussion is one Open Session session. The first message creates an
ask-mode session with `plainDiscussionId` set — inside the ticket's workspace
when the discussion was opened on a thread, so it gets the same ticket context
as a triage session — and every later message is delivered into that session.
Every finished turn is posted back to the discussion as Markdown and the agent
is reported idle, whoever started the turn: a teammate steering the same
session in the Open Session UI answers in Plain too. Each tool call is reported
on the discussion timeline. **Stop** in Plain cancels the session's run.

A discussion session reads untrusted ticket text, so its turns run under the
triage automation's policy rather than an interactive session's: the
automation deny-set plus the Plain customer-facing writes and the Stripe money
movers are denied, no user is passed (an `allowedUsers` server stays
invisible), no AWS credentials are provisioned, and the only in-process
`opensession-*` server it carries is `opensession-plain-discussion`; the
interactive admin, sessions, workflows, publish, keychain and self-deploy tools
are never mounted. This holds on the opening turn, on every later message and
on a turn a person sends from the Open Session UI.

Nothing posted in a discussion reaches the customer. Instead of the Plain MCP
writes the session carries the `opensession-plain-discussion` tools:

- `reply_to_customer`: shows the exact reply on an **Approve / Deny** card in
  the discussion and waits for the decision. Approved: the reply is sent as the
  triage machine user and the thread is snoozed as waiting for the customer.
  Denied: nothing is sent and the reviewer note goes back to the model.
- `execute_stripe_action`: the same card for a specific refund or
  cancellation. Approved: the money-tools execution turn the
  `@<handle> go ahead` note flow uses runs with a discussion prompt that
  treats the approved proposal as the action, re-verifies its identifiers and
  amount in Stripe, and aborts on any ambiguity (a discussion opened from
  Home has no thread note to fall back on).

A decision that arrives after a restart finds no waiting tool; the card stays
answered in Plain and the model is told nothing ran. Waiting tools give up
after 30 minutes.

### Setup

1. **Settings → Machine users & API keys**: open the machine user whose key
   is `PLAIN_API_KEY` and set **Type** to **Custom agent** (that is what
   lists it in Ask Sidekick; the picker shows the machine user's name, so
   name it `Open Session`). Its key must carry `threadDiscussion:read`,
   `threadDiscussion:edit`, `threadDiscussionMessage:create`,
   `threadDiscussionMessage:edit`, `thread:read`, `customer:read`.
2. To keep the agent identity separate from the triage machine user instead,
   add a second machine user with the same type and permissions and store its
   key as `PLAIN_AGENT_API_KEY`; the triage code keeps using `PLAIN_API_KEY`.
3. **Settings → Webhooks → Add webhook target** for `POST /plain/webhook`
   (or edit the existing one), version `2026-09-14`, subscribed to
   `discussion.message_created`, `discussion.turn_stop_requested` and
   `discussion.tool_call_approval_resolved`. The signing secret is the
   workspace's, so `PLAIN_WEBHOOK_SECRET` stays as it is.
4. `opensession restart`, then open Ask Sidekick, pick **Open Session** and
   send a prompt.

`discussion.message_created` fires for every discussion in the workspace,
including Sidekick's own and the agent's own replies (a person's turn is
`OUTBOUND`, the agent's replies come back as `INBOUND`). The handler answers
only `AGENT_SESSION` discussions whose agent is this machine user, for
`OUTBOUND` messages, while the discussion is not `RESOLVED`; everything else
is dropped silently.

## Internal notes in English

The legacy prompts and the "Support ticket triage" template require internal
notes and draft replies in English regardless of the customer's language, and
ask the run to note the customer's language for translation. Preserve this
rule in custom automation prompts.

Plain limits each internal note body to 10,000 characters. Server-side note
writes through `postNote` split longer text into numbered notes, but an
external Plain MCP tool may not. Keep automation notes under the limit and link
to a PR, issue, or session instead of pasting long logs.

The router's built-in product description uses `persona.company` and
`persona.product`. The default mention and legacy mention prompts also use
`persona.name`; set all three in `~/.opensession/config.json`.
