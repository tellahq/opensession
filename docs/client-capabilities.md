# Client capability negotiation

Web, cached phone PWA bundles, Electron, native apps and the Chrome extension
upgrade independently. Do not infer server support from the client's version.

`GET /api/capabilities` returns the typed `ServerDescriptor` from
`packages/core/protocol/src/capabilities.ts`. UI WebSockets include the same
object in `hello.server`. The existing `hello.capabilities.commandResults`
field remains available to older clients. Runner and executor handshakes are
separate protocols and do not use this descriptor.

The descriptor has a diagnostic `serverVersion`, a `protocolVersion` (currently
1), and stable capability keys. Values are booleans or positive integer feature
versions. A missing descriptor, missing key, false, zero, invalid value or failed
bootstrap means unsupported. Ignore unknown keys. Use a specific capability,
not a comparison of package versions or an exact protocol-version check.

## Current capabilities

| Key                        | Contract                                                       |
| -------------------------- | -------------------------------------------------------------- |
| `commandResults`           | Durable WebSocket command results and acknowledgements         |
| `deskVoice`                | Desk voice secret, tool and transcript endpoints               |
| `sessionVoice`             | Session voice call endpoints                                   |
| `sessionListSlices`        | Archived/live session list query filters and slim archive rows |
| `sessionCreateIdempotency` | Session creation deduplicates an actor-scoped `requestId`      |

Flags describe implemented wire support, not authorization, credentials or
provider availability. For example, voice can be supported while the instance
has no configured voice provider. Normal endpoint errors still apply.

## Adding a feature

Add a key when a new client action would call an endpoint, send a command or
consume a response shape an older server does not implement. Add it to the
protocol registry, advertise it only once its contract works, update the key
lock test and this table, and gate the action in each client that offers it.
Test the missing endpoint, absent key, unknown fields and downgrade paths.
Do not silently remove or rename keys while old clients may exist. Prefer a new
key for an incompatible contract; keep accepting the old one. Increment a small
feature version only for additive revisions clients can explicitly require.

## Cache and reconnect behavior

The server serializes its immutable descriptor once, without filesystem,
provider or catalog probes. HTTP responses are `no-store`: capabilities must not
survive a server downgrade in a network cache. The web Effect runtime shares one
scoped bootstrap and focus subscription across consumers. Every hello replaces
rather than merges the current descriptor, and late HTTP replies cannot
supersede a newer hello. An absent descriptor disables optional actions.

The PWA service worker bypasses `/api/` requests. A stale bundle can still speak
an older contract after the server updates; preserve old endpoints and fields.
Advertising a new flag cannot repair an already-shipped bundle that never read
capabilities. Conversely, new bundles talking to older servers disable voice
calls instead of probing missing endpoints. Electron loads the web bundle and
uses its negotiation, not an independent shell version. Native Desk voice checks
the descriptor when opening the sheet and again before requesting a call secret.
Chrome refreshes on account bootstrap, uses server-side list slicing only when
advertised, and persists creation retry identities only when the server promises
deduplication; older servers still accept one-shot session creation.

Prior art: t3code's environment descriptor and pull request linking compatibility
rules use additive capabilities for independently upgraded clients.
