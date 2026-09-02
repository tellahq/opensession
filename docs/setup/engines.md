# Pi engine

Open Session sends every production model turn through the bundled Pi runtime;
there is no separate `pi` executable to install. Model ids use
`pi/<provider>/<model>`. Recognized bare ids such as `claude-fable-5-1` and
`gpt-5.6-sol`, and provider paths such as `openai/gpt-5.6-sol`, normalize to
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

## Configure model access

Enabling Pi only opens the engine gate. Add at least one usable account or API
key under **Settings → Providers**:

- `pi/anthropic/*` uses the Claude account pool. Add a setup token created with
  `claude setup-token`; a separate Claude sign-in can provide usage and reset
  data.
- `pi/openai/*` uses the OpenAI account pool, which accepts ChatGPT sign-ins or
  OpenAI API keys.
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
| `~/.opensession/claude-accounts.json` | Claude setup tokens and optional usage credentials                                  |
| `~/.opensession/codex-accounts.json`  | ChatGPT sign-ins and OpenAI API keys                                                |
| `~/.opensession/xai-accounts.json`    | SuperGrok / X Premium sign-ins (xAI OAuth tokens)                                   |
| `~/.opensession/model-providers.json` | Third-party provider keys, base URLs, picker models, and optional pool restrictions |

SuperGrok accounts sign in by device code from Settings → Providers. Their
models appear in the picker as `pi/xai-oauth/<model>` and every request goes
through xAI's `cli-chat-proxy.grok.com`, so it draws on the subscription's
quota rather than API credits. Pay-per-token xAI keys stay a separate `xai`
provider under Your own providers. `bridge.xaiAccounts` in
`model-providers.json` restricts which accounts serve Grok runs, like
`bridge.openaiAccounts` does for the ChatGPT pool.

Sandboxes never hold the xAI refresh grant. Docker mounts the store read-only
and remote sandboxes receive a scoped copy with fresh access tokens and no
refresh token, so a sandbox can neither rotate nor kill the host's sign-in;
the host keeps every stored token ahead of expiry on its own.

Legacy top-level counterparts such as `~/.opensession-claude-accounts.json`
remain supported when the grouped path is absent. Run `opensession doctor`
after setup to verify that the engine and the default model have usable
capacity.

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
is used, then `claude-fable-5-1`.

Interactive auto-fallback is on by default. Its preferred model comes from
`OPENSESSION_FALLBACK_MODEL`, defaulting to `claude-opus-5`; set the variable to
`none` to disable fallback. Environment changes require a service restart.
Haiku-backed runs and derived one-shots instead cross providers to
`gpt-5.6-luna` when the Claude pool is exhausted or unavailable. Override that
with `OPENSESSION_HAIKU_FALLBACK_MODEL`, or set it to `none` to disable the
Haiku-specific fallback.
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
