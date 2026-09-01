# Instance configuration

Open Session application code has portable defaults. Team-specific repositories,
identity, domains, policy, integrations, and routines belong in
`~/.opensession/config.json`. Use
[`config.example.json`](../config.example.json) as a starting point, not an
exhaustive schema: the current loader ignores its `cloud` block and accepts
sections the example omits, including `storage` and `organization`.

## Portability boundaries

- `repos` is authoritative when present. Repository behavior such as dependency
  installation, preview startup, warm-cache markers, AWS profile names,
  deployment tracking, and security-scan guidance lives on each repo entry.
  A repo entry can also carry an `icon`, a PNG served as the repo's tile icon
  (absolute path, or relative to the checkout). When it is unset or missing,
  the UI renders the repo's assigned-color letter tile.
- `identity.team` owns commit attribution, GitHub/Slack/Linear mappings,
  per-user connector access, and the team web-sign-in allowlist. There is no
  built-in company roster. `identity.defaultTimezone` controls the fallback
  used for team-local scheduling and defaults to `UTC`.
- `identity.reviewTeams` adds named GitHub teams to the reviewer picker. Each
  entry has a display `name`, an `org/team` GitHub reviewer spec, and `members`
  matching names or aliases from `identity.team`; an explicit group request is
  added to every listed member's Open Session review sidebar.
- `branding` and `persona` are injected into the frontend and prompt builders.
  The frontend bootstrap also receives the public base URL, default repo id,
  configured GitHub bot logins, and the Plain workspace id.
- Optional agent modules load only when `integrations.<name>.enabled` is true,
  unless their enable environment variable overrides it. Other config-backed
  capabilities use separate gates: Plain deep links use
  `integrations.plain.workspaceId` whenever it is set, and code.storage
  support activates when `org` and `privateKeyPath` are configured.
  Integration-specific values such as OAuth callbacks, GitHub/Plain mention
  handles, Slack workspace metadata, and Linear team keys live in the same
  section. Plain also takes `integrations.plain.apiUrl`, the GraphQL endpoint
  for direct API calls, which defaults to
  `https://core-api.uk.plain.com/graphql/v1`.
- Company routines are data. `integrations.seeds.automations` creates records
  only when `integrations.seeds.enabled` is true. Existing persisted records are never
  deleted when seeds are disabled.

Client distributions have their own packaging configuration. Their committed
server default is deliberately portable: `http://127.0.0.1:3850`, so a fresh
clone points at your own machine rather than somebody else's server. The Chrome,
Electron, and native macOS distribution workflows stamp the deployment address
from the `OS1_SERVER_URL` repository variable, falling back to
`https://os.tella.dev`. The current iOS TestFlight workflow edits only the native
macOS setting and leaves the iOS default at localhost.

Every client also lets the user change the server at runtime, so a wrong default
is an inconvenience rather than a dead end:

| Client                | Where the user changes it                                                   | Build-time default                                                |
| --------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Chrome extension      | the Server field in the side panel                                          | `packages/clients/chrome/deployment.json`                         |
| Electron shell        | asked on first launch, then app menu → Organizations → Edit current server… | `packages/clients/mac/package.json` → `opensession.defaultServer` |
| Swift app (iOS/macOS) | Settings → Server                                                           | `OS1DefaultServerURL` in `packages/clients/ios/project.yml`       |
| Web UI / PWA          | n/a — served by the server itself                                           | n/a                                                               |

Packaging configuration:

- Chrome: `packages/clients/chrome/deployment.json`
- Electron: `packages/clients/mac/package.json` → `opensession.defaultServer`
- Swift: `OS1DefaultServerURL` in `packages/clients/ios/project.yml`

Bundle identifiers, signing teams, provisioning profiles, update feeds,
deployment destinations, and infrastructure log destinations are
distributor-specific values. Change those values in the existing packaging
files rather than replacing the files wholesale. Preserve entry points, targets,
sources, dependencies, required entitlements, permissions, and usage
descriptions.

### iOS Live Activities

The native app can show the signed-in person's running and unread sessions as
one optional Live Activity. Foreground ActivityKit updates need no APNs signing
credentials, but the app still needs a configured Open Session account.
Background updates require `OPENSESSION_APNS_KEY_ID`,
`OPENSESSION_APNS_TEAM_ID`, and `OPENSESSION_APNS_PRIVATE_KEY_PATH` pointing to
an existing Apple `.p8` ES256 key. `OPENSESSION_APNS_BUNDLE_ID` is optional and
defaults to `dev.tella.os1`; set `OPENSESSION_APNS_ENV=sandbox` for development,
otherwise production is used.

The iOS App ID and provisioning profile must include Push Notifications. The
widget extension needs no APNs credential: it renders ActivityKit state supplied
by the host app and APNs.

## Compatibility literals

Several old names are protocol or persisted-data compatibility, not instance
branding. Do not rename the `bks-` session-id prefix or `OPENSESSION_VIDEO:` —
running and historical sessions depend on them.
