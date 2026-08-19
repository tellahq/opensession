# Engines: Pi and OpenCode

New interactive sessions, automations, and one-shot utility calls default to
Pi. Pi runs through detached run hosts driven by `src/server/pi-runner.ts`, so
turns survive server restarts. OpenCode remains available as an explicit engine
and as a migration fallback through `src/server/opencode-runner.ts`. Model ids
name their engine as `pi/<provider>/<model>` or
`opencode/<provider>/<model>`; bare native ids (`claude-sonnet-5`,
`gpt-5.6-sol`) are routed at dispatch. One-shots use the tool-less
`oneShot` helper in `src/server/one-shot.ts`.
After changing engine/runner code, restart with `systemctl restart opensession`
([install.md](install.md#10-frontend-rebuilds-vs-restart)).

Binary resolution: `OPENSESSION_OPENCODE_BIN` → `Bun.which("opencode")` → an
nvm fallback path.

## Engine config

`~/.opensession-opencode.json` (override with `OPENSESSION_OPENCODE_CONFIG`),
schema from `src/server/opencode-config.ts`:

```json
{
  "enabled": true,
  "bridge": { "mode": "meridian", "accounts": ["acc-id-1"] },
  "port": 3456,
  "pickerModels": ["opencode/anthropic/claude-sonnet-5"],
  "turnTimeoutMinutes": 60,
  "bridgeMaxRequestsPerHour": 300
}
```

- `enabled` gates the whole `opencode/` model surface: the Anthropic bridge,
  and whether third-party provider models reach the UI picker at all.
  `opensession onboard` creates the file as `{"enabled": true}` when it does
  not exist, so a fresh install has the bridge on; Settings → Setup has an
  Engine row in the Getting-started checklist that reports the OpenCode binary,
  the bridge state and the Claude/Codex account counts, with a button to turn
  the bridge on (`GET`/`PUT /api/settings/opencode-engine`, body
  `{"enabled": boolean}`).
- The two failure shapes when it is off (missing file, or `"enabled": false`;
  `bridge.mode: "off"` produces the first one on its own):
  `opencode/anthropic/*` turns fail with a config error naming
  `~/.opensession-opencode.json` — there is no fallback engine — and
  **third-party picker models silently disappear** from the model picker
  instead of erroring. If a model you configured is simply not in the list,
  check this flag first.
- `pickerModels` adds opencode model ids to the UI model picker (folded into
  the registry at load).
- Providers beyond the two subscription bridges run on an API key — see
  [Third-party providers](#third-party-providers-api-keys).

## Account pools — the mental model

Open Session runs a whole team on **subscription capacity, not API keys**. For
each provider you enroll one or more accounts — Claude Max subscriptions,
ChatGPT-plan logins — into a pool, and every agent turn checks one out:

- **Personal first, shared second.** A Claude account with an `owner` is
  preferred for that teammate's own runs; automations and everyone else draw
  from the owner-less shared accounts. Adding capacity means adding another
  account to the pool.
- **Limits rotate, exhaustion falls back.** An account that hits its usage
  window is sidelined and the run rotates to the next account in the same
  pool. Only when the *whole pool* is exhausted does the model-fallback
  chain fire (see [Model routing](#model-routing)) — and a fallback taken for
  transient reasons drives only that turn; the session remembers the model
  you picked and returns to it once its pool recovers.
- **Cross-provider fallback is a handoff, not a resume.** An engine session's
  internal history can't move between providers, so falling back from a
  Claude model to an OpenAI one (or vice versa) starts a fresh engine session
  seeded with a transcript handoff note; the worktree and UI transcript carry
  over, and the switch is visible in the chat.
- **Paid credits are opt-in.** Runs never intentionally spend extra-usage
  credits past a subscription's included quota unless explicitly allowed.

The two pools differ in mechanics — Claude picks least-utilized with a
97%-of-window sideline, Codex picks least-recently-used with a rate-limit
cool-off — details in their sections below, and
[usage visibility](#usage-visibility--account-health) covers how you see any
of this happening.

## Anthropic models (the Claude bridge)

`opencode/anthropic/*` models get Claude subscription capacity through
**Meridian** — the bundled opencode-with-claude / `@rynfar/meridian` stack
(pinned in package.json), injected as an OpenCode plugin. This is the default
mode when the bridge is enabled: flat Max-subscription quota. `accounts`
optionally restricts which Claude accounts serve it. Per-account
`CLAUDE_CONFIG_DIR` isolation pins the selected account.

Other `bridge.mode` values exist as non-default escape hatches: `"native"`
(the in-repo `src/server/anthropic-bridge.ts`, a loopback-only
Anthropic-Messages endpoint on the official Claude Agent SDK — designated
accounts only, bills to extra-usage credits; alongside the flag-gated
experimental claude-direct engine adapter it is the last consumer of
`@anthropic-ai/claude-agent-sdk`) and `"off"`.

### Claude accounts

`~/.opensession-claude-accounts.json` (override with
`OPENSESSION_CLAUDE_ACCOUNTS_PATH`; written mode 0600). Shape
(`src/server/claude-accounts.ts`):

```json
{
  "accounts": [
    {
      "id": "acc-…",
      "name": "alice-max",
      "token": "sk-ant-…",
      "email": "optional",
      "plan": "optional",
      "createdAt": "ISO date",
      "owner": "Alice",
      "credentialsPath": "/home/user/.claude/accounts/alice/credentials.json"
    }
  ]
}
```

- **Minting a token**: run `claude setup-token` on a Max-subscription login;
  paste the `sk-ant-…` value (whitespace from terminal wrapping is stripped).
  Setup-tokens lack the `user:profile` scope, so usage polling 403s and the
  account is marked `usageScope: "missing"`; point `credentialsPath` at a
  full login-scoped credentials file to restore usage visibility (it's used
  only for polling — runs still use `token`).
- **Picking**: personal accounts (`owner` matched through the identity
  table) are preferred for that user's runs; automations and everyone else
  draw from owner-less pool accounts, least-utilized first. Accounts at ≥97%
  of the 5-hour window are sidelined until reset. Sessions can pin an
  `accountId`; automations can hard-pin (`accountStrict`) as a cost cap.
  Each account gets an isolated `CLAUDE_CONFIG_DIR` for Meridian's SDK
  subprocesses, so the selected account is the only reachable credential.
- Fallback env vars: `OPENSESSION_FALLBACK_MODEL` (global fallback model when
  a pool is exhausted; `none` disables), `OPENSESSION_FORCE_LIMIT=1`
  (dev-only: fake a usage limit to exercise the fallback chain).

## OpenAI models (ChatGPT OAuth)

`opencode/openai/*` models run on OpenCode's native ChatGPT OAuth using the
codex-accounts pool — `~/.opensession-codex-accounts.json` (no env override;
0600), managed by `src/server/codex-accounts.ts` and seeded into opencode by
`src/server/opencode-openai-auth.ts` (access-token-only + poisoned refresh so
the host `codex login` can never be invalidated):

```json
{
  "accounts": [
    { "id": "…", "name": "key-1", "kind": "api_key", "value": "sk-…", "createdAt": "…" },
    { "id": "…", "name": "plan-1", "kind": "home", "value": "/home/user/.codex-homes/plan-1", "createdAt": "…" }
  ]
}
```

`kind: "api_key"` injects an OpenAI key; `kind: "home"` points at a
`CODEX_HOME` directory containing `auth.json` from `CODEX_HOME=<dir> codex
login` on a ChatGPT plan. Rotation is least-recently-picked with a cool-off
on rate limits.

## Third-party providers (API keys)

Everything the OpenCode engine supports beyond the two subscription bridges —
xAI, OpenRouter, Groq, Mistral, DeepSeek, Google, Cerebras, … — runs on a plain
API key. There is no pool and no rotation: one key per provider.

Configure them from **Workspace → Models** in the UI. Add the provider
by its OpenCode slug (`xai`, `openrouter`, …), paste the key, optionally set a
`baseURL`, and list the model ids you want in the picker. Keys are stored
server-side in `~/.opensession-opencode.json` (0600), returned only masked, and
injected into the engine's config as `provider.<id>.options`. The file shape is
the same if you would rather write it by hand:

```json
{
  "enabled": true,
  "providers": { "xai": { "apiKey": "xai-…" } },
  "pickerModels": ["opencode/xai/grok-4"]
}
```

`anthropic` and `openai` are rejected here — they run on the subscription
bridges above, which always override this map.

**The `enabled` flag applies even when you never touch Anthropic.** It gates
`pickerModels`, so with the bridge config disabled a perfectly good xAI key
gives you models that never appear in the picker — no error, just an empty
list. Keep `"enabled": true` whatever provider you run on. (Onboarding writes
it that way; older installs and hand-edited files are where this bites.)

Providers you would rather not put in Open Session's config can instead use
OpenCode's own auth — `opencode auth login`, stored in
`~/.local/share/opencode/auth.json`; HOME is passed through to the engine, so
the engine picks those credentials up directly. Nothing in the UI manages them,
and their models still need a `pickerModels` entry to be offered (any opencode
model id remains routable by typing it in).

## Usage visibility & account health

Pools only work if you can see them. Two mechanisms:

**Workspace → Usage** shows every account in both pools
with its live usage: the 5-hour and 7-day windows, plan, and extra-usage
credit spend where enabled. For Claude accounts this polling needs a full
login-scoped credential — a bare `claude setup-token` lacks the
`user:profile` scope, so the account works for runs but shows "no usage
scope" until you point its `credentialsPath` at a real login's
credentials file (used for polling only, never for runs).

**The account-health monitor** (config `integrations.accountHealth:
{ notifyUser, slackChannel }`, needs the Slack integration) sweeps both
pools hourly and DMs whoever can fix a problem — the `owner` of a personal
Claude account, `notifyUser` for shared and Codex accounts. It catches the
failure mode where credentials rot silently on the shelf: unreadable or
expired Claude credential files, revoked setup-tokens, refresh tokens
within a week of expiry, and Codex ChatGPT tokens expired or about to be
(they only refresh when a turn actually runs, so an idle account decays).
A standing issue re-alerts daily and clears silently once fixed; transient
poller noise is never alerted.

## Model routing

`src/server/models.ts`:

- **Default model**: UI override file `~/.opensession-default-model.json`
  (`{ "model": "<id>" | null }`) → `OPENSESSION_MODEL` env → `claude-fable-5`.
- **Fallback auto-switch**: `~/.opensession-model-fallback.json`
  (`{ "auto": boolean }`, default true) — whether interactive sessions
  auto-fall-back when their model's pool is exhausted. The built-in fallback
  order: gpt-5.6-sol → gpt-5.6-terra → gpt-5.6-luna → claude-opus-5 →
  claude-sonnet-5 → claude-sonnet-4-6 → claude-haiku-4-5 (a session's
  configured `preferredFallbackModel` is tried first). Every fallback is
  mapped onto opencode too.
- **Cheap-task models**: several features run small classifier prompts on
  Pi Haiku by default via `oneShot`, each overridable by env where it's
  read: `SUGGEST_BRANCH_MODEL`, `NOTE_EDIT_MODEL`, `SCHEDULE_WHEN_MODEL`,
  `DRAFT_AUTOMATION_MODEL`, `SLACK_MENTION_INTENT_MODEL`,
  `PLAIN_SPAM_CHECK_MODEL`, `PLAIN_REFUND_INTENT_MODEL` (all default
  `claude-haiku-4-5`; native and legacy OpenCode ids map onto Pi at dispatch), plus
  `OPENSESSION_ONESHOT_MODEL` as the one-shot default.

## Run gate + least privilege

The engine is deny-by-default on run kind (`opencodeGateReason`):
interactive kinds (`prompt`, `goal`, `create`, `linear`, `slack`,
`workflow`) and unattended kinds (`automation`, `plain`, `action`,
`security-scan`, `github-*`) are allowed; anything else — including runs
with no journal kind — is refused. Denied and confirm-listed tools are
STRIPPED from the model's tool list via OpenCode's `tools` config
(`opencodeRunPolicy`) — there is no per-call approval card on this engine,
so a confirm tool is never callable; the run's guidance differs by type
(unattended runs are told to post the proposed action in their internal
note, interactive runs to ask the human in the session). The rest of the
MCP server stays mounted, so reads keep working.
