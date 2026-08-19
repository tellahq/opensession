# Misc integrations: Stripe, WorkOS, observability, push, voice

## Boot guards

Every integration is declared in the registry
(`src/server/integrations/registry.ts`); `loadAgents()` in `opensession.ts`
is a loop over it (`loadIntegrations`, `src/server/integrations/load.ts`).
Enable resolution per integration:

- Every agent is **OFF by default**. An integration loads only when you enable
  it, so a fresh install runs nothing you did not ask for.
- Flags: `ENABLE_SLACK_AGENT`, `ENABLE_LINEAR_AGENT`, `ENABLE_PLAIN_AGENT`,
  `ENABLE_GITHUB_AGENT`, `ENABLE_GRAFANA_POLLER`, `ENABLE_STRIPE_AGENT`.
- **Only the literal string `true` enables via env.** `ENABLE_SLACK_AGENT=1`
  does *not* turn Slack on — any other value disables. The asymmetry is
  deliberate: anything unrecognised means off.
- The env flag wins when set; otherwise `integrations.<id>.enabled` in
  `config.json` decides. Onboarding writes explicit values rather than relying
  on either default.

Enabling an integration without its credentials is the one state to avoid: it
loads and degrades with warnings (Slack calls fail, webhook verification
rejects everything, the Grafana poller no-ops) rather than refusing. That costs
log noise and health warnings, not crashes. Missing webhook secrets are
fail-closed (401), so nothing untrusted gets in. The exception is Stripe: its
registry entry carries a `requires` gate, so without `STRIPE_WEBHOOK_SECRET`
the agent is skipped entirely (no route worth exposing).

## Stripe

Two separate pieces:

1. **Dispute webhook agent** (`src/agents/stripe/`): route `POST
   /stripe/webhook` on the [webhook server](install.md#webhook-server),
   verified with `STRIPE_WEBHOOK_SECRET`. It only acts on
   `charge.dispute.created`, firing the `stripe:charge.dispute.created`
   automation event with a minimal payload (the automation re-fetches details
   via MCP). Everything else is acked and ignored.
2. **Stripe MCP server** (`mcp-config.json`): an HTTP server pointing at
   `https://mcp.stripe.com` with a **restricted key** (`rk_live_…`) in the
   config file, not env. Use a restricted key with write on Refunds +
   Subscriptions (+ Invoices if you want invoice voiding) only and read on
   core billing resources — Stripe enforces that ceiling server-side no
   matter what the agent asks for.

On top of the key ceiling, the money-moving tools are **confirm-listed**
(`STRIPE_CONFIRM_TOOLS`, `src/server/runner-shared.ts`; override with
`policy.stripeConfirmTools` in config): `mcp__stripe__create_refund`,
`mcp__stripe__cancel_subscription`, `mcp__stripe__update_subscription`, and
the raw-API mutators `mcp__stripe__stripe_api_execute` /
`mcp__stripe__stripe_api_write` (they can hit any endpoint the key permits).
The opencode engine has no per-call approval card, so these tools are
STRIPPED from the model's tool list on every run — the server stays mounted
and Stripe reads keep working. The instructions tell the agent to propose
the action instead: unattended runs post it in their internal note for a
human to approve by opening the session; interactive runs ask the human in
the session.

## WorkOS

No server code — it's a stdio MCP server in `mcp-config.json` (a wrapper
script that loads its own credentials; the repo doesn't contain one, so
bring your own WorkOS MCP). Automation runs
hard-deny its entire write/impersonation surface
(`AUTOMATION_DENIED_TOOLS` in `src/server/automations.ts` — see
[plain.md](plain.md#the-triage-automation-least-privilege-model) for the
exact list); reads (`get_*`, `list_*`) stay allowed.

## Grafana poller

`src/agents/grafana-poller/` polls Loki for failure signatures and spins up
investigation automations with a Slack control card per fresh failure.

| Var | Default | Notes |
| --- | --- | --- |
| `GRAFANA_URL` | — | required; without it (or the token) startup logs "poller disabled" and the agent is a complete no-op |
| `GRAFANA_SERVICE_ACCOUNT_TOKEN` | — | bearer token for the datasource proxy |
| `LOKI_DATASOURCE_UID` | `loki` | queried via `/api/datasources/proxy/uid/<uid>/loki/api/v1/query` |

Each poll is configuration on an automation (`grafanaPoll` in
`src/server/automations.ts`): the LogQL to run (`lokiQuery`, with `$LOOKBACK`
substituted with the poll window), the dedup label, and the Slack channel the
control card posts to (`slackChannel`) — so pointing the poller at your own
failure signatures is configuration, not a code edit. Dedup state lives in
`~/.opensession-grafana-poll/<automationId>/` (default window 7 days).

## Sentry and Tinybird

MCP-only — no server code, no env vars. Configure them as HTTP MCP servers
in `mcp-config.json` (`https://mcp.sentry.dev/mcp`;
`https://mcp.tinybird.co?token=<token>` with the token in the URL). Omit
them and nothing breaks; runs just don't get those tools.

## Web push

`src/server/push.ts`. Zero configuration: VAPID keys are generated on first
use and stored in `~/.opensession-push/vapid.json`; per-user subscriptions in
`~/.opensession-push/subscriptions.json` (dead ones pruned on send). The VAPID
contact comes from `integrations.push.vapidSubject` and defaults to
`mailto:admin@example.com` — push works regardless, but set it to a real
address so a push service can reach you about your own subscriptions. Push
requires the UI to be served over HTTPS (e.g. Tailscale
`ts.net` certs); on iOS it needs the PWA installed.

## Voice / transcription

`src/server/transcribe.ts` tries providers in order, falling through on
failure:

1. OpenAI (`OPENAI_API_KEY`; `gpt-4o-mini-transcribe`)
2. Groq (`GROQ_API_KEY`; `whisper-large-v3-turbo`)
3. Local whisper.cpp — `WHISPER_CLI` (default
   `~/tools/whisper.cpp/build/bin/whisper-cli`) + `WHISPER_MODEL` (default
   `~/tools/whisper.cpp/models/ggml-small-q5_1.bin`), with `ffmpeg` for
   audio conversion. Build whisper.cpp yourself; it's outside the repo.

All optional — with no provider configured, dictation throws and the rest of
the app is unaffected.

## AWS creds for runs (`AGENT_AWS_REGION`)

`src/server/aws-creds.ts` mints short-lived instance-role credentials for
agent runs that opt into AWS (`aws: true`), injecting `AWS_REGION` /
`AWS_DEFAULT_REGION` (resolved `AGENT_AWS_REGION` → `AWS_REGION` →
`integrations.aws.region` in config → default `us-east-1`) plus
temporary keys into the child env. It exists because the service cgroup
blocks the EC2 metadata endpoint (`IPAddressDeny=169.254.169.254/32` in
`opensession.service`) so untrusted agent code can't mint the role itself; the
main process escapes via a transient systemd unit (`sudo -n systemd-run`) to
fetch read-only creds.

Two limits of that block, worth knowing on a cloud box:

- The `IPAddressDeny=` directive covers only processes inside the unit's own
  cgroup, and the engine deliberately detaches each session into its own
  `systemd --user` scope outside it (`opencode-detach.ts`, so a restart does
  not kill in-flight turns). So the agent's shell tools run in the engine
  scope, which the unit's filter never reaches — under the **user** unit and
  the **system** unit alike. The unit directive is defense-in-depth for the
  non-detached path, not the boundary.
- The boundary on a cloud box is a **host firewall rule**, which applies to
  every process a uid runs regardless of cgroup:
  `sudo iptables -I OUTPUT -d 169.254.169.254 -m owner --uid-owner <uid> -j REJECT`
  (drop `--uid-owner` to block the whole host). `OPENSESSION_OC_DETACH=0`
  keeps engines inside the system unit's cgroup instead, trading detached-run
  survival across restarts for the unit filter covering them.
- Because of this, `opensession service install` (user scope, the default)
  probes 169.254.169.254 and refuses when anything answers, printing the host
  rule, the detach kill switch, and `OPENSESSION_ALLOW_IMDS=1` for a box with
  no role to protect. A per-user manager additionally cannot apply
  `IPAddressDeny=` at all on stock Ubuntu (it needs `PrivateUsers=`, which the
  apparmor unprivileged-userns restriction denies, silently), so the user
  unit could not carry even the defense-in-depth copy.

**Off by default.** The mint is EC2-specific and needs passwordless sudo, so it
only runs when you turn it on:

| Setting | Meaning |
| --- | --- |
| `AGENT_AWS_CREDS` | Only the literal `true` enables, any other value disables. Checked first, so it is also the off switch on a host that pins a region. |
| `integrations.aws.enabled` | Used when `AGENT_AWS_CREDS` is unset. |
| `AGENT_AWS_REGION` / `integrations.aws.region` | With neither of the above set, pinning a region for agent runs enables the mint. |
| `AGENT_AWS_MINT_USER` / `integrations.aws.mintUser` | The unprivileged account the transient unit runs as. Defaults to the account the server runs as, which is what a sudoers rule is written for. The separate uid is what keeps the mint out of root, so keep it unprivileged. |

A bare `AWS_REGION` does not enable anything: it names the region for a run
that already has credentials, and it is set on plenty of machines with no
instance role to mint.

With the mint off, `getAgentAwsEnv` / `ensureAgentAwsCredsFile` return `{}`
without spawning anything, and runs proceed without AWS. That is the state a
laptop or a plain VPS wants, including every simple-mode install: the enabled
path would otherwise cost a sudo attempt and up to three 3-second IMDS curl
timeouts on every session start. With the mint on but failing (no instance
role, no sudo rule, or inside a docker sandbox where IMDS is blocked for the
helper too) the result is the same `{}`, logged so the misconfiguration is
visible.

## Account health (`integrations.accountHealth`)

Hourly credential-health sweep over both model-account pools, DMing whoever
can fix a rotting credential before a run dies on it. Needs the Slack
integration. Documented with the pools it watches —
[engines.md](engines.md#usage-visibility--account-health).
