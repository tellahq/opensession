# Misc integrations: Stripe, WorkOS, observability, push, voice

## Boot guards

Optional boot-loaded integrations are declared in
`packages/core/opensession-server/src/server/integrations/registry.ts` and
loaded by `loadIntegrations()` from `opensession.ts`. MCP-only integrations,
push, transcription, AWS credentials, and account health do not use this
registry.

- Every registry integration is **off by default**.
- Flags: `ENABLE_PLAIN_AGENT`, `ENABLE_LINEAR_AGENT`, `ENABLE_SLACK_AGENT`,
  `ENABLE_STRIPE_AGENT`, `ENABLE_GRAFANA_POLLER`, `ENABLE_GITHUB_AGENT`, and
  `ENABLE_CODESTORAGE`.
- **Only the literal string `true` enables via env.** For example,
  `ENABLE_SLACK_AGENT=1` does not enable Slack; any set value other than
  `true` disables it.
- The env flag wins when set. Otherwise `integrations.<id>.enabled` in
  `config.json` decides. Onboarding writes both settings explicitly.

Most enabled integrations still load when required credentials are missing:
outbound calls fail, and webhook handlers with no signing secret reject input.
The setup UI and `opensession doctor` report registry credentials marked as
required. Grafana instead starts as a no-op without its URL or token. Stripe is
skipped entirely without `STRIPE_WEBHOOK_SECRET`; code.storage is skipped
without its required config. Change boot flags or boot-loaded credentials, then
restart Open Session.

## Stripe

Two separate pieces:

1. **Dispute webhook agent** (`packages/core/opensession-server/src/agents/stripe/`): route `POST
/stripe/webhook` on [Public ingress](install.md#public-ingress),
   verified with `STRIPE_WEBHOOK_SECRET`. It only acts on
   `charge.dispute.created`, firing the `stripe:charge.dispute.created`
   automation event with a minimal payload (the automation re-fetches details
   via MCP). Everything else is acked and ignored.
2. **Stripe MCP server** (the effective `mcp-config.json`): add an HTTP
   server with a **restricted key** (`rk_live_…`) in its authorization header:

   ```json
   {
     "mcpServers": {
       "stripe": {
         "type": "http",
         "url": "https://mcp.stripe.com",
         "headers": { "Authorization": "Bearer rk_live_…" }
       }
     }
   }
   ```

   Use a restricted key with write on Refunds + Subscriptions (+ Invoices if
   you want invoice voiding) only and read on core billing resources. Stripe
   enforces that ceiling server-side. The MCP config path resolves from
   `OPENSESSION_MCP_CONFIG`, then `paths.mcpConfig`, then
   `<checkout>/mcp-config.json`.

On top of the key ceiling, the money-moving tools are **confirm-listed** in
`STRIPE_CONFIRM_TOOLS`
(`packages/core/opensession-server/src/server/runner-shared.ts`):
`mcp__stripe__create_refund`, the retained cancel/update subscription names,
and the raw-API mutators `mcp__stripe__stripe_api_execute` and
`mcp__stripe__stripe_api_write`. The current Stripe MCP exposes
`stripe_api_write`; the older names remain blocked in case a server still
exposes them.

Pi has no per-call approval card, so standard interactive and unattended paths
strip these tools from the model's tool list while leaving Stripe reads
available. Unattended runs propose the exact action in their internal note;
interactive runs ask the human to carry it out separately. The one execution
exception is Plain's fail-closed approval flow: a verified teammate explicitly
approves a previously proposed refund or cancellation in the same Plain thread,
and a dedicated run receives the mutators for that action.

## WorkOS

No WorkOS server ships in this repo. Add your own stdio or HTTP WorkOS MCP to
the effective `mcp-config.json`; this instance's stdio wrapper is
operator-provided and loads its own credentials. Automation runs and
interactive resumes of automation-owned sessions strip the explicit
write/destructive and impersonation tools listed in
`packages/core/opensession-server/src/server/automation-denied-tools.ts`.
WorkOS lookup tools remain available when the automation's MCP allowlist names
the server. Review that deny list when the WorkOS MCP adds mutators; matching is
by explicit tool name, not by a wildcard.

## Grafana poller

`packages/core/opensession-server/src/agents/grafana-poller/` polls Loki for failure signatures and spins up
investigation automations with a Slack control card per fresh failure.

| Var                             | Default | Notes                                                                                                |
| ------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `GRAFANA_URL`                   | —       | required; without it (or the token) startup logs "poller disabled" and the agent is a complete no-op |
| `GRAFANA_SERVICE_ACCOUNT_TOKEN` | —       | bearer token for the datasource proxy                                                                |
| `LOKI_DATASOURCE_UID`           | `loki`  | queried via `/api/datasources/proxy/uid/<uid>/loki/api/v1/query`                                     |

The Slack integration and bot token must also work because each investigation
uses a Slack control card. Configure each enabled automation with a
`grafanaPoll` object. Required fields are `lokiQuery` (an instant LogQL query;
`$LOOKBACK` is replaced), `dedupLabel`, `slackChannel` (a channel ID), and
`cardTitle`. Optional defaults are `lookback: "20m"`, `pollMinutes: 15`,
`dedupDays: 7`, and `namespace: "prod"`; set `namespace: ""` to accept every
namespace. The engine wakes every minute and polls each automation when due.
Adding or changing a poll is configuration, not a code edit or restart.

Fresh installs keep dedup state in
`~/.opensession/grafana-poll/<automationId>/`. If the legacy
`~/.opensession-grafana-poll` exists and the new path does not, Open Session
continues using the legacy path.

## Sentry and Tinybird

MCP-only, with no integration agent or dedicated server env vars. Configure
them as HTTP MCP servers in the effective `mcp-config.json`:
`https://mcp.sentry.dev/mcp` and
`https://mcp.tinybird.co?token=<token>`. These entries are shown in
`mcp-config.example.json`. Omit them and runs simply do not receive those
tools.

## Web push

`packages/core/opensession-server/src/server/push.ts`. No key provisioning is
required: VAPID keys are generated when push is first used. On a fresh install,
keys live in `~/.opensession/push/vapid.json` and per-user subscriptions in
`~/.opensession/push/subscriptions.json`; an existing legacy
`~/.opensession-push` remains in use when the new directory is absent. Dead
subscriptions are pruned after a 404/410 response.

Each user must opt in per device under **Settings → Notifications** and grant
browser notification permission. Push requires a secure HTTPS origin; on iOS,
the PWA must be installed. The VAPID contact is
`integrations.push.vapidSubject`, defaulting to
`mailto:admin@example.com`. Set a real `mailto:` or HTTPS subject so push
services can contact the operator; restart Open Session if you change it after
push was first used in the current process.

## Voice / transcription

`packages/core/opensession-server/src/server/transcribe.ts` tries providers in order, falling through on
failure:

1. OpenAI (`OPENAI_API_KEY`; `gpt-4o-mini-transcribe`)
2. Groq (`GROQ_API_KEY`; `whisper-large-v3-turbo`)
3. Local whisper.cpp — `WHISPER_CLI` (default
   `~/tools/whisper.cpp/build/bin/whisper-cli`) + `WHISPER_MODEL` (default
   `~/tools/whisper.cpp/models/ggml-small-q5_1.bin`), with `ffmpeg` for
   audio conversion. Build whisper.cpp yourself; it's outside the repo.

The endpoint accepts at most 25 MiB per clip. Providers are optional: if no
hosted key works and the local binary or model is unavailable, dictation
returns an error and the rest of the app is unaffected.

## AWS creds for runs (`AGENT_AWS_REGION`)

`packages/core/opensession-server/src/server/aws-creds.ts` mints short-lived
EC2 instance-role credentials for eligible host runs and previews. Pi receives
a rotating shared-credentials-file pointer; other callers receive temporary
keys. Both receive `AWS_REGION` / `AWS_DEFAULT_REGION`, resolved as
`AGENT_AWS_REGION` → `AWS_REGION` → `integrations.aws.region` →
`us-east-1`.

The credentials have the permissions of the attached instance role; Open
Session does not make a broad role read-only. Attach a read-only or otherwise
least-privileged role. The mint uses `sudo -n systemd-run` to run the IMDSv2
request outside the blocked agent cgroups as an unprivileged user.

On Linux system-scope installs, `opensession.service` and every detached
run-host system unit deny `169.254.169.254`; the executor denies all network.
`OPENSESSION_PI_DETACH=0` is the rollback switch that keeps Pi turns in the
gateway service cgroup, where the gateway's deny still applies. User-scope
installs disable detached run hosts and cannot reliably apply
`IPAddressDeny=`. Therefore `opensession service install` probes the metadata
endpoint before installing user scope and refuses if it responds. Apply the
printed uid-scoped firewall rule and rerun. Only on a host with no cloud role
to protect, set `OPENSESSION_ALLOW_IMDS=1` to skip that installer check.

**Off by default.** The mint is EC2-specific and needs passwordless sudo, so it
only runs when you turn it on:

| Setting                                             | Meaning                                                                                                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_AWS_CREDS`                                   | Only the literal `true` enables, any other value disables. Checked first, so it is also the off switch on a host that pins a region.                      |
| `integrations.aws.enabled`                          | Used when `AGENT_AWS_CREDS` is unset.                                                                                                                     |
| `AGENT_AWS_REGION` / `integrations.aws.region`      | With neither of the above set, pinning a region for agent runs enables the mint.                                                                          |
| `AGENT_AWS_MINT_USER` / `integrations.aws.mintUser` | The unprivileged account the transient unit runs as. Defaults to the account the server runs as. This selects the unit's UID/GID; it does not grant sudo. |

The service installer's fixed run-host helper permission does not grant the
separate `sudo -n systemd-run` access this mint needs. Provision a narrowly
scoped passwordless sudo policy for the exact `mintCommand()` in
`aws-creds.ts`. If a user-scope install uses the printed owner-based firewall
rule, that rule also blocks a mint running as the service user; use system scope
or a separate unprivileged mint user that is not covered by the rule.

A bare `AWS_REGION` does not enable anything: it names the region for a run
that already has credentials, and it is set on plenty of machines with no
instance role to mint.

With the mint off, `getAgentAwsEnv` / `ensureAgentAwsCredsFile` return `{}`
without spawning anything, and runs proceed without AWS. That is the expected
state on a laptop or plain VPS. When enabled, credentials are cached until five
minutes before expiry; the first mint or a refresh may make a sudo attempt and
up to three 3-second IMDS requests. If minting fails because there is no role,
no sudo rule, or a sandbox blocks IMDS, the run receives no AWS credentials and
the failure is logged.

## Account health (`integrations.accountHealth`)

This monitor starts on every non-development boot, runs first after 10 minutes,
then hourly. It checks both model-account pools and the configured GitHub App
credential, and attempts to refresh idle Codex tokens before alerting. Standing
issues re-alert daily; state is stored in
`~/.opensession/account-health.json` on fresh installs.

Delivery requires a working `SLACK_BOT_TOKEN` and resolvable teammates in the
identity configuration. Personal Claude-account alerts go to that account's
`owner`. Pool-wide, Codex, and GitHub App alerts go to
`integrations.accountHealth.notifyUser`, falling back to the first configured
team member. Restart after changing that setting. The model-account pools are
documented in [engines.md](engines.md#configure-model-access).
