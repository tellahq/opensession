# Open Session for Chrome (os1-chrome)

Chrome extension (MV3) — a side panel that captures context from the
page you're looking at and kicks
off Open Session agent sessions with it. In the spirit of Claude for Chrome and
Ramp's Inspect extension, but deliberately small: it's a **capture + dispatch**
surface, not a full Open Session client. Never distributed via the Web Store.

## What it does

- **Composer** (default view): write a prompt, attach context, start a session.
  - **Page chip** — active tab URL + title, auto-attached.
  - **Screenshot** — visible-tab PNG, sent as a real image attachment.
  - **Pick element** — click any element on the page: captures its DOM path,
    text, aria/testid, a cropped screenshot of it, and — via a MAIN-world React
    fiber walk — the React component stack (with `file:line` sources on dev
    builds that carry `_debugSource`) plus the nearest component's props.
  - Organization picker with independent server/token accounts. On GitHub PR
    pages, the repository owner selects the matching account and repository.
  - Repository (loaded from the active server), ask/code mode, model picker.
- **Sessions**: recent sessions with live state (running / needs input /
  queued), click through to a transcript view.
- **Session detail**: transcript tail (polled), follow-up prompts (steer/queue
  semantics, same as the web UI), link out to the full web UI.
- **Right-click → "Send to Open Session"**: seeds the composer with the page +
  selection.

## Install

The extension requires per-user GitHub sign-in and has no unauthenticated mode.
Before using it, enable `integrations.github.userPrAuth` on the server and add
each user's GitHub login to `identity.team`. Authentication is off by default.
See [Per-user GitHub auth](../../../docs/setup/github.md#per-user-github-auth-prs-as-the-session-owner).

**Managed.** A deployment may force-install the extension through Chrome policy
and point it at its own Open Session update feed
(`https://<your-server>/api/packages/clients/chrome/updates.xml`). `deployment.json` supplies
the default server; `manifest.json` deliberately contains no
organization-specific update URL.

- Extension ID: `paoolggkbjkobjblpjgncolaaikcmboe` (derived from the signing
  key; also pinned as `key` in manifest.json so unpacked loads share it)
- Google Workspace (whole team): Admin console → Devices → Chrome →
  Apps & extensions → Users & browsers → pick the org unit → **+** →
  "Add Chrome app or extension by ID" → switch to **From a custom URL** →
  paste the ID and update URL → set to **Force install**. Applies to Chrome
  profiles signed in with a Google account in that org.
- Single Mac (no Workspace policy needed — Tella's feed URL shown as the
  example):

  ```sh
  defaults write com.google.Chrome ExtensionInstallForcelist -array-add \
    "paoolggkbjkobjblpjgncolaaikcmboe;https://os.tella.dev/api/packages/clients/chrome/updates.xml"
  ```

  then fully restart Chrome (it will show "Managed by your organization").

If the update feed is private (Tella's is tailnet-only, like the rest of its
instance), machines must be on that network. Off-network, installs/updates
just retry later; the installed extension keeps working (it can't reach the
server anyway).

**Unpacked (development).** `chrome://extensions` → Developer mode → "Load
unpacked" → this `packages/clients/chrome/` directory. No build step; edit and hit reload.

Either way, open the toolbar icon → side panel → Settings. For a non-loopback
server, add or remove a trailing slash in the **Server** field, leave the field,
and accept Chrome's host-access request; a packaged default does not request
access by itself. Then click **Sign in with GitHub**.

## Releases (CI)

`.github/workflows/os1-chrome-release.yml` runs on every push to `main`
touching `packages/clients/chrome/`: it stamps the version (`<major.minor from
manifest>.<commit count on packages/clients/chrome/>` — merging IS the deploy, no manual
bumps), packs a signed .crx with the `OS1_CHROME_CRX_KEY` repo secret (base64
of the RSA pem; keep a backup of the pem outside CI — the key determines the
extension ID, lose it and every install orphans), and publishes it as a GitHub
**prerelease** tagged `os1-chrome-v<version>` (prerelease so the os1-mac
Squirrel feed's `releases/latest` never sees it). Before packing, CI rewrites
`deployment.json` from the `OS1_SERVER_URL` repository variable, falling back
to `https://os.tella.dev`; the committed file remains the portable loopback
default.

The server generates the Omaha feed and proxies the selected `.crx` artifact
from GitHub in
`packages/core/opensession-server/src/server/routes/os1-update.ts`. Configure
`integrations.updates.releaseRepo` and
`integrations.updates.chromeExtensionId` to match the release repository and
signing-key-derived extension ID. Also set the public base URL through
`server.publicBaseUrl` or `OPENSESSION_UI_BASE`, and ensure the server's `gh`
CLI can read that repository's releases and assets.

## How it talks to the server

Per-organization bearer tokens (from the device flow's `native: true` poll,
same as os1-ios) against the REST surface. Existing single-server `cfg` storage
migrates into the account list on first load:

- `POST /api/sessions` — create with
  `{ prompt, repo?, mode, model?, images?, requestId }`; `requestId` is stored
  locally and reused as the durable retry key until acknowledgment.
- `POST /api/sessions/:id/prompt` — follow up with `{ content, clientId }`;
  `clientId` is the durable delivery key, and the response reports `started`,
  `steered`, `queued`, or `handled`.
- `GET /api/sessions`, `GET /api/sessions/:id/transcript`
- `GET /api/repos`, `GET /api/models`
- `POST /api/auth/device` + `/auth/device/poll` — sign-in

Chrome extensions with host permissions bypass CORS, so the server needs no
CORS headers. Mutations pass the server's cross-site check because requests
with an explicit `Authorization: Bearer` header are exempt (and the pre-token
device-flow POSTs are covered by a `chrome-extension://` origin carve-out) —
see `crossSiteViolation` in `packages/core/opensession-server/src/server/web-auth.ts`.

## Files

- `manifest.json` — MV3; loopback host access is built in, and the extension
  requests access to the team server selected in Settings. `activeTab` covers
  page capture when invoked from the toolbar.
- `deployment.json` — distribution-owned default Open Session server.
- `background.js` — tiny service worker: opens the panel on icon click, owns
  the context-menu entry.
- `sidepanel.html/css/js` — the whole client. No frameworks.
- `picker.js` — injected on demand (isolated world): hover-highlight element
  picker; tags the chosen node with `data-os1-picked` so the follow-up
  MAIN-world script (`readPickedReactInfo` in sidepanel.js) can walk its React
  fiber — isolated worlds can't see page-JS expandos.

## Server capabilities

The panel refreshes `GET /api/capabilities` on account bootstrap. Missing flags
disable optional list slicing and persistent session-creation retry identities.
Older servers still support one-shot session creation and full-list reads. See
[client capability negotiation](../../../docs/client-capabilities.md).
