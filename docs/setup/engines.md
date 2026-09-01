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
| `~/.opensession/model-providers.json` | Third-party provider keys, base URLs, picker models, and optional pool restrictions |

Legacy top-level counterparts such as `~/.opensession-claude-accounts.json`
remain supported when the grouped path is absent. Run `opensession doctor`
after setup to verify that the engine and the default model have usable
capacity.

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
