# The clients

Open Session is one server with several front ends. Only the first is required;
everything else is optional.

| Client                         | Where                                            | Needs building?                   |
| ------------------------------ | ------------------------------------------------ | --------------------------------- |
| Web UI                         | `packages/core/opensession-server/src/frontend/` | no, the server serves it          |
| PWA                            | same web UI, installed to a home screen          | no                                |
| Electron desktop shell         | `packages/clients/mac/`                          | yes                               |
| Native Swift app (iOS + macOS) | `packages/clients/ios/`                          | yes, with Xcode                   |
| Chrome extension               | `packages/clients/chrome/`                       | no, load unpacked for development |

The Web UI and installed PWA use the server origin that serves them. Electron,
Swift, and Chrome default to `http://127.0.0.1:3850` and let you save and switch
between organization/server accounts at runtime. See
[docs/instance-configuration.md](docs/instance-configuration.md) for runtime and
packaging configuration.

## Web UI

The core client. Without `OPENSESSION_DEV=1`, a source checkout builds or reuses
the frontend at boot, then watches frontend files for in-process rebuilds. Open
tabs receive a refresh prompt. With `OPENSESSION_DEV=1`, Bun provides HMR.
Prebuilt releases serve their shipped or embedded bundle and do not watch source
files. There is no separate Vite server. Backend changes still need
`opensession restart`.

Served at the root of whatever address you bound to. If you use nothing else,
you are not missing core session functionality.

## PWA

The same web UI, installed to a phone home screen via the browser's "Add to Home
Screen". No build, no store, no separate codebase.

On iOS, web push requires both a secure origin, normally HTTPS, and installation
to the Home Screen; it does not work from an ordinary Safari tab. Enable
**Push to this device** in Notifications settings.

Keyboard handling and safe-area insets are handled for the installed case, which
is why it feels like an app rather than a website in a frame.

## Electron desktop shell

`packages/clients/mac/` is a macOS-targeted Electron window around the web UI.
It adds Dock and window integration, native materials and dictation, and deep
links using `os1://`.

It renders the server's frontend, so it does not lag behind the web UI. On first
launch it asks for the first organization and stores an account list in its
profile. Use **OS → Organizations → Edit current server…**, or **Change server**
on the offline status page, to reopen the prompt. `OS1_URL` overrides the active
server for one run.

```sh
cd packages/clients/mac && bun install && bun start
```

The shell runtime includes macOS window materials, Dock and activation behavior,
permissions, deep links, and an Apple Speech helper. Packaged builds target
macOS arm64 DMG and ZIP artifacts.

## Native Swift app (iOS and macOS)

`packages/clients/ios/` is one SwiftUI codebase with two targets. This is not a
web view: it is a native client against the REST and WebSocket surface, which is
why it feels different from the PWA and can provide native settings and
background behavior.

Manage saved servers under **Settings → Organizations** and edit the active
organization through **Settings → Server**. `OS1_SERVER` and `OS1_TOKEN`
environment overrides are available for simulator runs and are deliberately not
persisted.

Read `packages/clients/ios/AGENTS.md` before changing it. The build and
verification workflow, release trigger, and load-bearing performance invariants
live there rather than being obvious from the code.

Needs Xcode and an Apple developer account to run on a device. TestFlight builds
come from `.github/workflows/os1-ios-testflight.yml` for iOS and
`.github/workflows/os1-mac-testflight.yml` for macOS.

The committed iOS and macOS defaults are loopback. Distributors must set
`targets.OS1.info.properties.OS1DefaultServerURL` and
`targets.OS1Mac.settings.base.INFOPLIST_KEY_OS1DefaultServerURL` separately in
`packages/clients/ios/project.yml`. The current iOS TestFlight workflow stamps
only the macOS property, so it leaves the archived iOS app at loopback.

## Chrome extension

`packages/clients/chrome/` is an MV3 side panel. It captures context from the
current page: a screenshot, or a selected element with its DOM and React
context, then hands that context into a new session.

It also provides a compact recent-sessions list with live state, a transcript
tail, follow-up prompts with steer/queue semantics, and per-organization
server/token accounts. Blocking questions and complete transcript reading still
open in the Web UI.

For development, load it unpacked:

```
chrome://extensions → Developer mode → Load unpacked → packages/clients/chrome/
```

Managed deployments can force-install it from an Open Session update feed. It
is not distributed through the Chrome Web Store. Manage organizations and their
servers in the side panel's Settings view. Each account authenticates with its
own Bearer token against the REST surface.

## Which to use

Start with the Web UI. Add the PWA if you want notifications on your phone. The
Electron shell is a desktop option, the Swift app is the native phone and Mac
experience, and the Chrome extension is useful when debugging web front ends.

The Web UI contains the core session experience. Optional clients also add
platform-specific capabilities: page and React-context capture in Chrome,
native widgets, intents, and Live Activities on iOS, and desktop protocol,
window, and dictation integration in Electron.
