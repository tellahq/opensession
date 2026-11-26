# Pi engine

Open Session sends every production model turn through the bundled Pi runtime;
there is no separate `pi` executable to install. Model ids use
`pi/<provider>/<model>`. Recognized bare ids such as `claude-fable-5-2` and
`gpt-6.2-sol`, and provider paths such as `openai/gpt-6.2-sol`, normalize to
that form at dispatch. See the [generated engine catalog](../generated/engines.md)
for the current routing table.

## Enable Pi

`opensession onboard` creates the Pi config with `{"enabled": true}` when it is
absent. A missing or malformed config, or `"enabled": false`, prevents every
model turn from starting.

A fresh installation stores the config at `~/.opensession/pi.json`. To create
it by hand:

```sh
mkdir -p ~/.opensession
cat > ~/.opensession/pi.json <<'JSON'
{
  "enabled": true
}
JSON
chmod 600 ~/.opensession/pi.json
```

An existing legacy `~/.opensession-pi.json` remains in use while the grouped
path does not exist. You can also enable a disabled engine from **Settings →
Setup**. The gate and transport settings are read for each turn, so these edits
do not require a restart.

The legacy `pickerModels` field is not required for the built-in subscription
catalog. It is still parsed, and valid entries can add picker rows when the
matching provider credentials exist. New provider model lists are stored in
`model-providers.json` instead.

Anthropic turns use the native in-process provider by default. Setting
`"anthropicTransport": "bridge"` selects the loopback bridge as a rollback;
absent and unrecognized values use the in-process provider.
`"anthropicTransport": "remote"` keeps the same provider but runs its Claude
Code processes in a separate Claude host service that never receives an
account's token; see [claude-host.md](../claude-host.md).

Each turn of a session runs in its own process, and the Claude Agent SDK keeps
a conversation in its own session files. So that a later turn continues the
same SDK session, and reads the provider's prompt cache instead of writing the
whole conversation again, the provider records which SDK session holds the
conversation in `claude-sdk-sessions.json` beside Pi's session file. The next
turn resumes it when Pi's history still starts with the messages that session
has seen and the same account can serve; otherwise, or when the resume fails,
it replays the conversation into a new SDK session. The file can be deleted at
any time.

A conversation keeps the system prompt it started with. Pi records a later
change to its prompt (the run instructions, `AGENTS.md`, the skills list) as a
new system message in the transcript, and sending the changed prompt would
make the provider write the whole conversation to its cache again. The
provider sends the original prompt on every request and delivers each change
as a short note at its place in the conversation: the lines added to and
dropped from a section, or the whole section when most of it is new. A
compaction starts over with the then-current prompt. Tool declarations are
always the current set, so text that differs between turns or between people
does not belong in a tool's description or schema.

## Configure model access

Enabling Pi only opens the engine gate. Add at least one usable account or API
key under **Settings → Providers**:

- `pi/anthropic/*` uses the Claude account pool. Add a setup token created with
  `claude setup-token`; a separate Claude sign-in can provide usage and reset
  data.
- `pi/anthropic/claude-mythos-*` needs a Claude API account: Anthropic offers
  Mythos to verified API organizations, not to Claude subscriptions. See
  [Claude API accounts](#claude-api-accounts).
- `pi/openai/*` uses the OpenAI account pool, which accepts ChatGPT sign-ins or
  OpenAI API keys.
- `pi/google/*` uses a Gemini API key from Google AI Studio, added under
  **Gemini**. See [Gemini and Google AI plans](#gemini-and-google-ai-plans).
- Other providers use one API key, an optional base URL, and the provider's
  model ids under **Your own providers**. `anthropic` and `openai` cannot be
  configured there because they use the account pools.

Accounts assigned to a person are available only to that person's runs and are
preferred over the shared pool. Ownerless accounts serve shared and unattended
runs. When an account reaches a provider limit, Open Session sidelines it and
tries another eligible account before considering a model fallback.

The UI writes these files with mode `0600`:

| File                                  | Contents                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `~/.opensession/claude-accounts.json` | Claude setup tokens, usage credentials, API keys, and federation IDs                |
| `~/.opensession/codex-accounts.json`  | ChatGPT sign-ins and OpenAI API keys                                                |
| `~/.opensession/xai-accounts.json`    | SuperGrok / X Premium sign-ins (xAI OAuth tokens)                                   |
| `~/.opensession/model-providers.json` | Third-party provider keys, base URLs, picker models, and optional pool restrictions |

SuperGrok accounts sign in by device code from Settings → Providers. Their
models appear in the picker as `pi/xai-oauth/<model>` and every request goes
through xAI's `cli-chat-proxy.grok.com`, so it draws on the subscription's
quota rather than API credits. The proxy rejects Grok CLI versions below its
current minimum with HTTP 426; set `OPENSESSION_XAI_CLIENT_VERSION` to the
current stable Grok CLI version (https://x.ai/cli/stable) to recover before a
release bumps the built-in default. Pay-per-token xAI keys stay a separate `xai`
provider under Your own providers. `bridge.xaiAccounts` in
`model-providers.json` restricts which accounts serve Grok runs, like
`bridge.openaiAccounts` does for the ChatGPT pool.

Sandboxes never hold the xAI refresh grant. They receive a scoped copy with
fresh access tokens and no refresh token, so a sandbox can neither rotate nor
kill the host's sign-in;
the host keeps every stored token ahead of expiry on its own.

### Gemini and Google AI plans

Gemini runs on a Gemini API key. Create one at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey) and paste it
under **Settings → Providers → Gemini**. Saving reads the key's model list from
the Gemini API (`GET /v1beta/models`), adds the newest chat models to the
picker as `pi/google/<model>`, and records Google's context and output limits
for models newer than Pi's bundled catalog. **Discover models** in the row's
menu reads the list again. The key is stored as the `google` provider in
`model-providers.json`.

There is no Google AI Pro or Ultra subscription sign-in. Google's terms do not
allow third-party agents to use the Gemini CLI or Antigravity sign-in, and
accounts that do can be suspended. Google AI Pro and Ultra plans instead come
with monthly Google Cloud developer credits that pay for Gemini API usage:

1. Subscribe to the plan as the primary member. Family members cannot use the
   credits.
2. In [AI Studio billing](https://aistudio.google.com/billing), create your
   Google Developer Program profile, claim the credits, and link a Cloud
   billing account. Credits are issued monthly from the date you first claim
   them and stay valid for 12 months.
3. Keep the prepayment balance Google requires for credits to draw down.
4. Create the API key in that billing project and add it under **Gemini**.

When the credits run out, usage is billed to the linked billing account.
Set a budget on it if that should not happen.

Legacy top-level counterparts such as `~/.opensession-claude-accounts.json`
remain supported when the grouped path is absent. Run `opensession doctor`
after setup to verify that the engine and the default model have usable
capacity.

### Claude API accounts

A Claude API account bills an Anthropic API organization instead of a Claude
subscription. It serves only Mythos runs, so metered API spend never stands in
for subscription capacity. Once one exists, Mythos runs use API accounts only.
An API account has no usage meters; a rate limit sidelines it for a minute, or
until the reset the error states. When `bridge.accounts` in `model-providers.json`
limits Claude runs to listed accounts, add each new API account's id there;
until then it serves nothing and the picker does not offer Mythos.

Add one under **Settings → Providers → Add account → Claude account**, with
one of two kinds:

- **Workload identity** (recommended; no stored secret). Open Session signs a
  short-lived ID token with its workload identity issuer and exchanges it for
  a short-lived Claude API access token, which it refreshes before expiry. In
  the Claude Console, register this server's issuer (the dialog shows the
  issuer URL, or an inline JWKS when Anthropic cannot reach the server), then
  create a service account and a federation rule that matches the dialog's
  subject and audience. Enter the organization, federation rule, and service
  account IDs, plus a workspace ID when the rule covers several workspaces.
  Open Session tests the exchange before saving. A token lifetime of one hour
  keeps exchanges infrequent. With web sign-in on, only the host operator can
  add a workload identity account, because it spends whatever organization
  trusts this server's issuer.
- **API key**: a static `sk-ant-api…` key. Prefer workload identity where a
  program limits long-lived keys.

With web sign-in on, only an API account's owner or the host operator can
rename, reassign, return, or remove it.

### Custom OpenAI-compatible providers

A provider id Pi does not know runs when its entry in
`~/.opensession/model-providers.json` declares the protocol. Only
`openai-completions` is accepted, and it needs a base URL. Each provider under
`providers.<id>` takes:

| Field            | Meaning                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `apiKey`         | Bearer key sent to the provider                                                                         |
| `baseURL`        | OpenAI-compatible base URL, for example `https://gateway.example/v1`                                    |
| `api`            | `openai-completions`; lets an id unknown to Pi and Open Session run                                     |
| `name`           | Display name in Settings                                                                                |
| `catalog`        | Per-model metadata keyed by model id (see below)                                                        |
| `catalogFile`    | JSON file with more catalog rows; relative paths resolve next to `model-providers.json`                 |
| `discoverModels` | `true` to read `GET {baseURL}/models` on save and from **Discover models** in Settings; picker ids only |
| `discovered`     | Written by discovery: the last listed ids and any extended fields the gateway sent                      |

A catalog row fills the fields a model unknown to every catalog would otherwise
get from the conservative stub (131072 context, 32768 output tokens, text
only, zero cost). Rows accept our camelCase names or the snake_case fields
gateway model objects tend to carry: `name` or `display_name`, `contextWindow`
or `context_length`, `maxTokens` or `max_output_tokens`, `input` or
`input_modalities` (`["text", "image"]`), `reasoning`, `efforts` (the
reasoning levels the gateway accepts, from `none`, `low`, `medium`, `high`,
`xhigh`, `max`), and `cost` with `input`, `output`, `cacheRead` and
`cacheWrite` in USD per million tokens. Layers apply weakest first: discovered
fields, then `catalogFile`, then inline `catalog`. A row for a model id Pi or
Open Session already knows overrides that entry.

```json
{
  "providers": {
    "my-gateway": {
      "apiKey": "…",
      "baseURL": "https://gateway.example/v1",
      "api": "openai-completions",
      "name": "My gateway",
      "catalogFile": "my-gateway-catalog.json",
      "catalog": {
        "big-model": {
          "name": "Big Model",
          "contextWindow": 1000000,
          "maxTokens": 131072,
          "input": ["text", "image"],
          "efforts": ["low", "high"],
          "cost": { "input": 1, "output": 4, "cacheRead": 0.1, "cacheWrite": 0 }
        }
      },
      "discoverModels": true
    }
  },
  "pickerModels": ["pi/my-gateway/big-model"]
}
```

The catalog file holds the same rows, either as a map keyed by model id or as
a list of objects with `id`. Discovery only adds ids to `pickerModels`; it
never removes hand-written ones, and a failed poll leaves the file untouched.
The stock OpenAI models object carries no limits or pricing, so keep those in
the catalog. Settings writes preserve every field the form does not edit.

## Defaults and fallbacks

**Settings → Providers** controls the default model and whether interactive
runs switch models automatically. The selected default is stored in
`~/.opensession/default-model.json`; without an override, `OPENSESSION_MODEL`
is used, then `claude-fable-5-2`.

Interactive auto-fallback is on by default. Its preferred model comes from
`OPENSESSION_FALLBACK_MODEL`, defaulting to `claude-opus-5`; set the variable to
`none` to disable fallback. Environment changes require a service restart.
Haiku-backed runs and derived one-shots instead cross providers to
`gpt-5.6-luna` when the Claude pool is exhausted or unavailable. Override that
with `OPENSESSION_HAIKU_FALLBACK_MODEL`, or set it to `none` to disable the
Haiku-specific fallback. Other one-shots fall over only when their caller
names a cross-provider chain: the PR merge-risk scorer tries `gpt-6.2-astra`,
then `gpt-6.2-sol`, when the review model's pool is dry.
When the current model's whole account pool is unavailable, the runner tries
configured fallback providers. Equal or stronger hops proceed automatically;
an interactive downgrade asks first. A cross-provider hop starts a fresh Pi
session seeded with a transcript handoff, while the worktree and UI transcript
stay in place. Fallbacks caused by transient infrastructure errors apply only
to that turn.

## Isolation and restarts

On a Linux system-scope installation, eligible local turns normally run in
transient run-host units launched by the independent executor. Those hosts
receive a minimal environment, guarded filesystem access, and only the MCP
servers allowed for the run. They survive a gateway service restart and are
reattached when the service starts again. Sessions assigned to a Runner or
sandbox use that environment's lifecycle instead.

The default rootless user service sets `OPENSESSION_PI_DETACH=0` and runs local
turns inside the gateway process; macOS does the same. Those turns do not
survive a service restart. A system-scope operator can also set
`OPENSESSION_PI_DETACH=0` as a rollback for new local turns.

After changing service environment or gateway/runner code, use
`opensession restart`, which selects the installed service scope. See
[service setup](install.md#9-running-it-as-a-service), the
[restart guidance](install.md#10-frontend-rebuilds-vs-restart), and the
[executor architecture](../executor-architecture.md).
