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

When a server is unreachable, **Switch server** opens a local dropdown of saved
organizations. **Add organization…** reveals a URL field and adds a separate
organization rather than replacing the current server. **Add anyway** saves an
unreachable address so its tailnet can be configured from the offline screen.
Selecting an existing organization also honors its local Tailscale profile.

`OS1_URL` overrides the stored answer for one run. Distributions set the address
the first-run screen offers with `opensession.defaultServer` in `package.json`
(or `OS1_CLOUD_URL`); a profile that already worked keeps using it and is never
asked.

## This Mac

A build that carries the compiled server can run it itself, so the app works
with no server set up anywhere. The first-run screen and **Add organization…**
then offer **Use this Mac**, which adds one organization named "This Mac" next
to any others. Its sessions, repositories and transcripts exist only on this
computer. Model requests still go to the model provider.

`src/local-server.js` owns the server. It runs while the app runs: started at
launch when the "This Mac" organization exists, restarted if a process dies
(three times in ten minutes, then reported), and stopped on quit. Nothing is
installed as a background service. It starts the release the way
`opensession start --foreground` does (session kernel, catalog seed, gateway)
with these differences, all so it can never collide with a server installed
from the command line on the same machine:

| What                   | Where                                                         |
| ---------------------- | ------------------------------------------------------------- |
| State, config and logs | `~/.opensession-app/` (`logs/` holds one file per process)    |
| Repositories           | `~/OpenSession/repos/` (`paths.reposDir`)                     |
| Session workspaces     | `~/OpenSession/workspaces/` (`paths.worktreesDir`)            |
| Ports                  | 47850 (app), 47849 (session kernel), 47860 (webhook listener) |
| Gateway ownership lock | `~/.opensession-app/deploy/`                                  |

The ports are chosen once and kept in `~/.opensession-app/app.json`, because
the web app stores preferences and drafts per origin. A port something else
holds is replaced by a free one, and the stored organization follows. The first
launch writes a config with the two folders, switches the engine on and creates
a `scratch` repository; later launches leave the config alone, so settings
changed in the app stay.

The server gets a minimal environment: the login shell's `PATH` (where `git`,
`gh` and `claude` are), `HOME`, and the SSH agent socket. Turns run inside the
server process (`OPENSESSION_EXECUTOR=0`, `OPENSESSION_PI_DETACH=0`), so
quitting the app ends them and nothing keeps running in the background. A turn
that was in flight is recorded as interrupted and can be continued. Processes
left by a crashed or force-quit app are ended at the next launch, matched by
executable path and never by pid alone.

Security: the server listens on loopback with no sign-in, like a default
command-line install, so any process running as the same macOS user can reach
it, and agents run commands as that user. It sets
`OPENSESSION_LOOPBACK_HOSTS_ONLY=1`, which refuses requests whose `Host` is not
a loopback name, so a web page cannot reach it by re-pointing a domain at
127.0.0.1. Only the shell's own pages can start, stop or inspect it; a server
the window loads cannot.

Not available on "This Mac": opening sessions from a phone or another computer,
inbound integrations that need a public address (Slack mentions, GitHub
webhooks), and teammates. Connect to a team server for those.

Packaging: `scripts/after-pack.js` copies the unpacked release folder named by
`OS1_LOCAL_SERVER_RELEASE` into `Contents/Resources/server` before signing, so
electron-builder signs its executables with the app. It is not an
`extraResources` entry because electron-builder leaves `node_modules` folders
out of those, and the release keeps its image library in one. Without that
variable nothing is packed and **Use this Mac** is never offered. The release
workflow builds and packs the server when run manually with **Pack the server
into the app**, or for every release once the `OS1_BUNDLE_LOCAL_SERVER`
repository variable is `1`; it then starts the signed server from inside the
packaged app before notarizing.

To try it from source, point the app at any unpacked release:

```sh
OS1_LOCAL_SERVER_DIR=/path/to/opensession-<version>-darwin-arm64 bun run start
bun test src/local-server.test.js
node scripts/smoke-local-server.js /path/to/opensession-<version>-darwin-arm64
```

The app updates through the server it is pointed at (see Auto-update), and the
server on this Mac has no release feed configured. An install that only uses
"This Mac" therefore does not update itself yet.

## Single-item macOS Keychain access

Agents can request **one generic-password item for one HTTPS API call** through
`opensession-keychain.request_mac_keychain`. This uses Apple's Security framework
(`SecKeychainFindGenericPassword`), not 1Password, the `op` CLI, or a custom
credential-authorization dialog. It does not read 1Password vaults, Apple
Passwords/iCloud items, internet-password items, certificates, or SSH keys.

1. Sign in to Open Session in the Mac app. Verified web sign-in is required;
   name-picker identities and machine browsers cannot authorize requests.
2. Give the agent the exact **service** and **account** identifiers of an existing
   generic-password item in your macOS Keychain, never its value. A display label
   alone may not be the service identifier. No item enumeration is exposed.
3. View the requesting session and choose **OS → Keychain requests…**. The native
   menu shows the item identifiers, purpose and complete HTTP destination/body.
   Select **Use once…** only if you trust that destination with the credential.
4. macOS applies the item's existing access controls. If authorization is needed,
   its native Keychain prompt offers **Allow / Always Allow / Deny**. Choose
   **Allow** for this access only. Existing permissions, including an earlier
   **Always Allow**, may permit access without another prompt. The app never
   changes an item's ACL or silently unlocks a keychain.

There is no CLI installation or 1Password integration to configure. The packaged,
signed `OS Keychain` helper looks up one exact service/account pair, returns the
value through a private pipe to Electron's main process, and exits. The main
process injects it into the approved HTTPS request. The value is never returned
to a renderer, Open Session server, agent environment, or model. Nothing caches
or writes the value to disk. Only the numeric HTTP status returns; response bodies
and headers are discarded, even for redirects and errors. This version cannot
retrieve API response data for the agent.

Each request can execute once, expires after ten minutes or a server restart,
and is visible only to the teammate who prompted the agent. Claims are atomic
across Macs, and failure never retries automatically. Canceling the menu declines
without accessing Keychain. The requesting session and organization are checked
again before execution. Each use requires a new native menu action even if macOS
already trusts the helper. The Keychain helper has a two-minute deadline for the
native prompt; the API request has a thirty-second deadline.

Only public HTTPS destinations on port 443 are supported. Private, loopback and
tailnet DNS addresses, browser cookies and redirects are refused. Supported
headers are `Authorization: Bearer` and `x-api-key`; an optional JSON request body
is limited to 512 characters. Raw secret export and shell/environment injection
are not supported. Native iOS and Chrome clients do not expose this Mac-only flow.

Verification: `bun test ./packages/clients/mac/src/` plus the server
`mac-keychain-requests` and route tests. On macOS, the following compiles and tests
against a newly created disposable keychain, with interaction disabled and no
changes to the default search list:

```sh
xcrun swiftc -DKEYCHAIN_TESTING native/KeychainHelper.swift native/KeychainHelperTests.swift \
  -parse-as-library -framework Security -o /tmp/os-keychain-tests
/tmp/os-keychain-tests
```

The release workflow also runs these tests and checks the packaged helper's
signature. A live **Allow / Always Allow / Deny** prompt still needs verification
in a signed app on an interactive Mac, using a disposable item.

## Local folders

`src/local-folders.js` is the native side of local folders
([docs/local-folders.md](../../../docs/local-folders.md)). The web app calls
`window.os1.localFolders` to pick a folder (the native open panel), list and
update grants, and run one file operation at a time. Grants are stored in
`local-folders.json` in the profile, keyed by the server origin that created
them, so one organization never sees another's folders. Every path is
folder-relative and resolved with `realpath`, including the deepest existing
ancestor of a file that does not exist yet, so a symlink cannot lead outside
the folder. System roots and the home folder itself cannot be picked. Deleting
uses `shell.trashItem`. There is no command execution. Hidden per-organization
windows can answer too, so a folder stays reachable while another organization
is on screen.

```sh
bun test src/local-folders.test.js
```

## Realtime voice audio

Voice sessions benefit from separate microphone and output choices, echo
cancellation, and quieter music while someone talks. Chromium already offers
microphone selection and echo cancellation, but Electron does not expose
Apple's speech-aware other-audio ducking settings. The shell therefore exposes
`window.os1.voiceAudio` backed by a signed native helper,
`native/VoiceAudioHelper.swift`, packaged as `Contents/Resources/os1-voice-audio`.

The dictation microphone and conversation handset are split buttons: the main
button starts its action, and the attached chevron opens an audio menu without
starting capture. Both menus share microphone and ducking choices for the next
use; the conversation menu also selects the output. Choices stay on this device.
Dictation feeds the selected native microphone into its recorder and speech
recognizer, so its menu changes the actual capture source too. Older shells
without the helper keep the plain buttons and browser capture.

The helper owns the real microphone and speaker through `AVAudioEngine` with
voice processing enabled (Apple's echo cancellation and noise suppression).
The renderer never opens a microphone on this path: it receives processed
48 kHz mono Float32 PCM and sends the agent's 48 kHz mono PCM back, which the
helper plays through the same voice-processing engine to provide the playback
reference for echo cancellation and remote-speech detection. Input and output devices are chosen separately per session
(`ducking`, `inputDeviceId`, `outputDeviceId`), by persistent CoreAudio UID;
an empty id means the system default. Choosing the built-in microphone with
AirPods as output avoids opening the headset microphone, the usual trigger
for a lower-quality hands-free profile. Device
choice is applied to this engine only (`kAudioOutputUnitProperty_CurrentDevice`
on the voice-processing unit's output and input elements, verified by
read-back), never to the system defaults.

Ducking: on macOS 14 and later the helper sets
`voiceProcessingOtherAudioDuckingConfiguration` to advanced ducking at the
maximum level when `ducking` is true, so other apps' audio ducks while either
side speaks. With `ducking` false it sets advanced ducking off at the minimum
level. This configuration API exposes a minimum ducking level, not a zero
level, so the off setting minimizes ducking rather than promising to disable
it. `devices()` reports `advancedDucking` so the frontend disables the control
on macOS 13 and earlier, where the
engine runs with the system's default ducking.

The API on `window.os1.voiceAudio` (present only when the packaged helper
exists; a dev run without it keeps the browser path):

- `devices(): Promise<{ inputs, outputs, advancedDucking }>`
- `start(id, { inputDeviceId, outputDeviceId, ducking }): Promise<void>`,
  resolves once the engine runs; rejects when macOS denies the microphone, a
  chosen device is missing, or the request was cancelled meanwhile.
- `push(id, samples: Float32Array)`: agent audio, 48 kHz mono.
- `setPaused(id, paused)`: pause tears the engine down (microphone, speaker
  and ducking released) and discards queued playback; resume rebuilds it and
  re-resolves the devices, reporting a missing one through `onError`.
- `clearPlayback(id)`: discard queued agent audio on barge-in.
- `stop(id)`.
- `onAudio(cb)`, `onError(cb)`: microphone frames and terminal errors, each
  returning an unsubscribe.

Realtime bounds: the renderer's AudioWorklet delivers WebRTC playback in
20 ms chunks at the audio clock's pace, not as faster-than-realtime TTS bursts.
The helper keeps 250 ms of agent audio in a ring buffer and
drops the oldest when delivery runs ahead; it drops microphone frames when
250 ms already waits on the pipe. The preload acknowledges every delivered
microphone packet and the main process every push, and both sides drop
beyond eight outstanding microphone packets or sixteen pushes, so a stalled
renderer or main process never queues IPC without bound.

Ownership and teardown: one native voice session exists at a time, owned by
the main frame of a visible, focused app window. The owner is recorded
before the macOS microphone prompt, so a stop, main-frame navigation,
renderer crash, closed window or competing start during the prompt cancels
the request and no capture begins. The same events, and quitting the app,
stop a running session. The shell sends a stop frame, then SIGTERM, then
SIGKILL on a bounded schedule, and the helper stops its engine before it
tries to drain stdout, so the microphone and ducking are always released.
The helper does no file I/O and logs drop counts from its main thread only.

Verification: `bun test ./packages/clients/mac/src/` covers the protocol,
bounds and ownership rules with a fake helper. On macOS, the helper's pure
parts (framing, device JSON, resampling, the ring buffer) compile and run as:

```sh
xcrun swiftc -DVOICE_AUDIO_TESTING native/VoiceAudioHelper.swift native/VoiceAudioHelperTests.swift \
  -parse-as-library -framework AVFoundation -framework AudioToolbox -framework CoreAudio \
  -o /tmp/os1-voice-audio-tests
/tmp/os1-voice-audio-tests
```

The release workflow runs these and checks the packaged helper's signature
and audio-input entitlement. Echo cancellation quality, AirPods routing and
how far music actually ducks depend on the hardware and still need listening
tests on a real Mac; a compile cannot prove them.

## Local Tailscale profiles

**OS → Organizations → Tailscale profiles…** binds an organization to a saved
Tailscale profile on this Mac. **Save** configures it without changing networks.
To connect immediately, check **Connect now** and choose **Save and connect**.
The refresh icon reloads profiles; **Open Tailscale** opens the Tailscale app.
Close with **×**, **Escape**, or a click outside the card to discard unsaved
changes. The local overlay follows its parent window and works offline.
Profiles must already be signed in through Tailscale. **Don't change Tailscale**
is the default and removes an existing binding.

The top-left organization picker and the native organization menu switch to the
bound profile before opening the organization's saved page. This changes
networking for the **whole Mac**, including other apps, SSH connections, and
other Open Session windows. Enabling a binding requires a native confirmation.
Launch, window focus, notifications, deep links, and background windows never
switch networks automatically.

If a server is unreachable, **Choose tailnet…** on the offline screen opens the
same local settings, even without a server connection. The connection window
has **Retry**, **Switch back** (when a previous profile is known), **Choose another
profile**, and **Open Tailscale** recovery actions. Closing a failed attempt
keeps the current network and the previous organization. Switching back is
explicit and will not override a profile changed outside Open Session.

Only the profile ID is stored alongside the organization in the local
`server.json`; nothing is sent to the server and no Tailscale credentials are
stored. The shell uses the installed Tailscale app's CLI, or the Homebrew CLI
when the app binary is absent. Subprocesses set `TS_BE_CLI=1` and `TERM=dumb`:
the Mac app launcher needs `TERM` to enter CLI mode even when Open Session is
started from Finder or the Dock without a terminal. It uses
`tailscale switch --list --json` where
supported and falls back to the older `tailscale switch --list` format when the
CLI reports that `--json` is unsupported. CLI calls and server probes have
deadlines, never invoke a shell or
request sudo, and errors leave the local recovery UI available. Only the shell's
owned, packaged main-frame settings pages can enumerate profiles or change
bindings. Remote content can only request a switch to an already configured
organization from the focused organization picker.

Verification: `bun test ./packages/clients/mac/src/`. Unit tests use a fake CLI
and never change the host's network. Real profile switching still needs macOS
verification with two already signed-in Tailscale profiles.

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
  `dictation`, `voiceAudio` (when the packaged helper exists), and `server`. The main process refuses `server` calls from
  anything but a `file://` page, so the app a server serves cannot repoint the
  shell.
- Native dictation: Electron exposes Chromium's speech-recognition API without
  connecting it to a working service. The renderer therefore streams mono PCM
  through the preload bridge to `native/DictationHelper.swift`, a signed helper
  that uses Apple Speech and prefers its on-device recognizer. The browser's
  recorded clip stays available as the server fallback if native recognition
  is unavailable. `scripts/before-pack.js` compiles the helper before every
  local or release package.
- Native voice audio: `native/VoiceAudioHelper.swift`, the signed helper
  behind `window.os1.voiceAudio` (see "Realtime voice audio");
  `src/native-voice-audio.js` runs it and `src/voice-audio-bridge.js` decides
  which page may.
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

- `os://…` opens the app and maps to the focused window's server
  (e.g. `os://session/abc` → `/session/abc`, `os://plain-triage/<thread>` →
  `/plain-triage/<thread>`, which redirects to the triage session). Use it for
  "open in the app" buttons in other tools. `os1://…` is the older name and
  still works. Shared session, workspace and
  PR pages show a dismissible **View in the app** card with an **Open** button
  at the bottom of the sidebar in an eligible Mac browser. The click opens this
  protocol while leaving the web page in place when the app is not installed.
  That button still uses `os1://`, because copies of the app older than
  `os://` support only register `os1://`.
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
