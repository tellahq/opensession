# Open Session for Mac

A thin Electron shell around a configured Open Session server. The app owns
the window, navigation policy, notifications, dock badge and deep links.

The shell lives in `packages/clients/mac/` inside the Open Session repository so native
window changes and their frontend counterparts can ship together.

## Its name, and what a rename costs

The app's label is **OS** (`productName`), the full product name is **Open
Session**. On macOS that label is one knob for four things, and they cannot be
separated:

| Follows `productName`           | Why it matters                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `OS.app` and its executable     | what Finder and the Dock show                                                                          |
| `CFBundleName`                  | the menu-bar title                                                                                     |
| `OS Helper.app` (and friends)   | Electron looks child processes up by `CFBundleName`; a mismatch is a fatal "Unable to find helper app" |
| Keychain item `OS Safe Storage` | the key Chromium encrypts the cookie jar with                                                          |

So each rename costs one sign-in: Electron resolves the Keychain name from the
bundle before `src/main.js` is loaded, and the new key cannot read what the old
one wrote. Nothing else has to move, because the profile folder no longer
follows the label — `src/main.js` pins `userData` (and `sessionData`) to a
fixed name, so window bounds, zoom, notification grant, preferences and drafts
stay put. The release artifacts keep the full name (`OpenSession-<version>-arm64.zip`)
because the update feed matches on it.

Fresh installs from the DMG land as `OS.app`; copies that auto-update keep
whatever filename they already had, because Squirrel replaces the bundle in
place. Both are the same app.

## Development

```sh
cd packages/clients/mac
bun install
bun start
```

Requires network access to the configured server; otherwise you get the
built-in retry screen.

### Iterating on the frontend before it ships

The shell renders whatever the server serves. To test unmerged Open Session
frontend changes, run this from the repository root:

```sh
bun app:dev
```

This starts the local SPA on `:3851`, waits for it to become ready, prepares a
lightweight unsigned development `.app`, launches it with the proper Open
Session Dock name/icon, and stops both processes together on `Ctrl+C`. Fully
quit an already-running Open Session first (`⌘Q`); closing its window only
hides it and the single-instance lock would otherwise reuse that older process.

`bun app:dev` defaults to the backend at `http://127.0.0.1:3850`. To use a
remote production backend, set `OS1_UPSTREAM` and either `OS1_TOKEN` or
`OS1_SSH_HOST`. Writes go to whichever upstream you configure.

Edits are rebuilt by the local proxy. JavaScript entry-bundle changes trigger
a full page reload; it does not provide React Fast Refresh or CSS hot-swap.
Refresh manually after stylesheet-only edits. For an empty, isolated server
state instead, run:

```sh
OPENSESSION_DEV=1 OPENSESSION_STATE_DIR="$(mktemp -d)" bun run dev
```

This starts the server on port 3850 by default without using normal Open
Session state.

## Which server

The app asks the first time it opens and keeps an account list plus its active
organization in `server.json`, so a build is not tied to one address. A bare
host is tried over HTTPS first, except localhost and loopback addresses use
HTTP. If HTTPS does not answer, the shell retries a bare host over HTTP. Both
setup flows probe `/api/health` by default but allow the normalized address to
be saved with **Use anyway** or **Add anyway**. The organization row above Feed
and **OS → Organizations** both switch the focused window; ⌘⇧1…9 remains
available from the keyboard. Other visible windows keep their own organizations
and routes. Organizations without a visible window stay loaded in hidden
sandboxed windows so WebSockets and notifications remain live.

`OS1_URL` overrides the stored answer for one run. Distributions set the address
the first-run screen offers with `opensession.defaultServer` in `package.json`
(or `OS1_CLOUD_URL`); a profile that already worked keeps using it and is never
asked.

## Architecture

- `src/main.js` — sandboxed `BrowserWindow`s that each own an organization and
  route, plus hidden sandboxed windows for organizations not already visible
  (`contextIsolation`, no Node in the renderer). Use **File → New Window** or
  ⌘N to keep different organizations or workspaces open side by side. Switching
  organizations changes only the focused window. In-window navigation is
  limited to app pages for that window's organization; everything else opens
  in the default browser. Additional windows close
  normally; closing the last one hides it to the Dock so its route and drafts
  stay intact. Same-origin documents that are not app pages, including raw
  reports, assets and downloads, open in the default browser. Window state
  persists across launches.
- `src/preload.js`: exposes `window.os1` with `desktop`, `materialBackdrop`,
  `setBadge`, `clearBadge`, `focusWindow`, `organizations`, `updates`,
  `dictation`, and `server`. The main process refuses `server` calls from
  anything but a `file://` page, so the app a server serves cannot repoint the
  shell.
- Native dictation: Electron exposes Chromium's speech-recognition API without
  connecting it to a working service. The renderer therefore streams mono PCM
  through the preload bridge to `native/DictationHelper.swift`, a signed helper
  that uses Apple Speech and prefers its on-device recognizer. The browser's
  recorded clip stays available as the server fallback if native recognition
  is unavailable. `scripts/before-pack.js` compiles the helper before every
  local or release package.
- `src/setup.html`: the server prompt, shown when nothing is stored yet and
  when adding from the native app menu or editing an organization. The in-app
  organization menu uses its own modal instead. Both probe the address by
  default and offer to save its normalized form when it is unreachable.
- `src/offline.html` — retry screen for when the configured server is
  unreachable, with a way back to that prompt, since a stored address that is
  wrong looks exactly like a server that is down.
- `src/shell.css`: the tokens and splash those two pages share. They load from
  `file://` with the server possibly gone, so they can fetch nothing from it;
  `src/mark.png` is that splash's mark.
- **The web app's service worker is deliberately blocked** (request to `sw.js`
  cancelled + registrations cleared at boot). Its jobs — Web Push, app-shell
  cache, PWA badge — don't function in Electron anyway, and its Cache Storage
  writes crash Electron 43's renderer with a bad `CacheStorageCache` Mojo
  message (reproducible on every launch; likely an Electron/Chromium bug —
  re-test when bumping Electron majors).
- Window chrome: the frontend already supports Window Controls Overlay (its PWA
  manifest), which Electron activates via `titleBarStyle: hidden` +
  `titleBarOverlay`. The window uses macOS's native `sidebar` vibrancy material;
  the frontend keeps the detail pane opaque and exposes that material only
  beneath its translucent sidebar.

## Auth

GitHub web sign-in is the device flow: the sign-in screen shows a code, "Open
GitHub" hands github.com to the default browser, and this window stays on the
waiting screen until the poll comes back. The `opensession_auth` cookie
persists in Electron's default session.

## Deep links

- `os1://…` opens the app and maps to the focused window's server
  (e.g. `os1://session/abc` → `/session/abc`). Shared session, workspace and
  PR pages show a dismissible **View in the app** card with an **Open** button
  at the bottom of the sidebar in an eligible Mac browser. The click opens this
  protocol while leaving the web page in place when the app is not installed.
- **Universal links** (plain `https://os.tella.dev/…` links opening the app,
  e.g. from Slack — Tella's host; see the rebrand note under Signing & release):
  Open Session exposes `/.well-known/apple-app-site-association` from the
  server's `integrations.clients.appleAppIds` setting. Tella uses
  `["6GUXT43C8B.dev.tella.os1", "6GUXT43C8B.dev.tella.os1.shell"]` for the iOS
  and Mac App Store pair plus this shell. Without that setting, the route
  returns an empty app-ID list. Signed CI builds install the
  Developer ID profile from the `OS1_PROVISIONING_PROFILE_BASE64` repository
  secret and sign the top-level app with `build/entitlements.mac.applinks.plist`;
  the release fails if either the signed entitlement or embedded profile is
  missing. The Electron helpers keep inheriting `build/entitlements.mac.plist`
  (no associated-domains): they carry no provisioning profile, and macOS
  SIGKILLs any helper that claims a restricted entitlement it can't back with
  one — which surfaces as `GPU process isn't usable. Goodbye.` at launch. Local
  unsigned builds use `build/entitlements.mac.plist` for both and need no
  profile.
  Caveat: os.tella.dev resolves to a tailnet IP, so Apple's AASA CDN cannot
  fetch the association file. The entitlement therefore also lists the
  `?mode=developer` alternate, which fetches directly — each team device must
  enable Associated Domains development mode for native Universal Links. The
  **Open** action above is the fallback on Macs without that setting.

## Signing & release

This section (and the universal-links app IDs above) documents **Tella's own
release setup** — Apple team `6GUXT43C8B` and the `dev.tella.os1.*` bundle ids.
Forks must rebrand the package metadata, entitlements, workflow checks, server
URL and `integrations.clients.appleAppIds`, then supply their own signing
secrets.

CI (`../../../.github/workflows/os1-mac-release.yml`) builds, signs, notarizes and
publishes a GitHub Release for matching version tags. Manual "Run workflow" does a dry
run with artifacts attached to the run. Repository secrets (the values below
are Tella's — supply your own):

| Secret                            | Value                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `APPLE_CERTIFICATES_P12`          | "Developer ID Application: Tella HQ Inc. (6GUXT43C8B)" as base64 .p12                                        |
| `APPLE_CERTIFICATES_PASSWORD`     | password of that .p12 export                                                                                 |
| `OS1_PROVISIONING_PROFILE_BASE64` | Developer ID provisioning profile for `dev.tella.os1.shell`, including Associated Domains, encoded as base64 |
| `APPLE_ID`                        | Apple ID with app access                                                                                     |
| `APPLE_APP_PASSWORD`              | app-specific password for that Apple ID                                                                      |

Set `version` in `packages/clients/mac/package.json` to the intended `X.Y.Z`
and commit it, then run `git tag vX.Y.Z && git push origin vX.Y.Z`. The package
version and tag must match.

Local `bun run dist` produces an unsigned build when signing credentials are
absent. Release builds package the Electron shell and its icon resources. The
pipeline embeds the Developer ID provisioning profile and signs only the outer
app with the associated-domains entitlement, so Universal Links work without
Electron helpers claiming an entitlement they cannot support. The package keeps
only Electron's English locale resources because Open Session is currently English-only;
Chromium's unused locale set otherwise adds roughly 49 MB to the installed app.

The shell has no production dependencies, and `package.json` declares an empty
`workspaces` list to say so structurally. Without it, electron-builder finds no
node modules here, walks up to the repository's own workspace root and tries to
resolve _that_ package's production dependencies, which the release runner never
installs: the build then fails with "Production dependency ... not found for
package opensession". The empty list stops the search at this directory.

## Auto-update

The packaged app keeps itself current via Electron's built-in Squirrel.Mac
updater. It points to
`/api/packages/clients/mac/update?version=<installed>` on the server selected
when the updater initializes, then checks after 15 seconds and every 4 hours.
The route lives in
`packages/core/opensession-server/src/server/routes/os1-update.ts` and returns a
Squirrel static JSON feed, proxying its signed arm64 ZIP because Squirrel cannot
read a private GitHub repository itself. The server must set
`integrations.updates.releaseRepo` to the GitHub `owner/repo` containing the Mac
releases, and its `gh` CLI credentials must be able to read the release and its
assets. Without that configuration the feed contains no updates.

The frontend stays quiet while Squirrel downloads. Once the update is staged,
`UpdatePill`, driven by `window.os1.updates`, shows a persistent bottom-left
**Update ready** card with a **Restart** action. Restarting installs and
relaunches the app.

Shipping an update is unchanged: bump `version` in `package.json`, tag, push
the tag. Installed apps (≥ 0.2.0) pick it up on their next check. Dev runs
(`electron .`, unsigned) skip the updater entirely.

## Follow-ups tracked

- **Dock badge**: the web app sets its badge via `navigator.setAppBadge` in the
  service worker, which doesn't reach Electron's Dock. The shell can aggregate
  per-organization counts, but the frontend does not yet call the bridge. When
  `window.os1` exists, it must also call `window.os1.setBadge(n)`.
- **Universal links**: see above.
- **Web Push**: push events don't arrive in Electron (no FCM); notifications
  while the app is running come through the page's WebSocket + Notification
  API, which works. Clicking one raises the window through
  `window.os1.focusWindow()`, since a renderer-side `window.focus()` does not
  bring a BrowserWindow forward on macOS. Closed-app push would need a native
  APNs story — not planned.
