# Open Session native app (iOS + macOS, SwiftUI): agent guide

This directory is the NATIVE Swift client for Open Session: one SwiftUI
codebase, two targets, `OS1` (iOS 26+) and `OS1Mac` (macOS). The target,
scheme, bundle and directory names keep the older `OS1` spelling on purpose:
they are identifiers, and the app's own name lives in the Info.plist keys
below. It is not the web UI
(`packages/core/opensession-server/src/frontend/`) and not the Electron desktop shell (`packages/clients/mac/`); see the
"client apps" section of the root AGENTS.md for how to disambiguate requests.
`README.md` here is the human-facing overview (features, architecture map,
WS protocol notes) — keep it updated alongside changes.

## Project setup

- The Xcode project is GENERATED: `project.yml` (XcodeGen) is the source of
  truth — `OS1.xcodeproj` is not checked in and must never be hand-edited.
  New/removed Swift files under `OS1/` are picked up by `xcodegen generate`.
- Deployment targets live in `project.yml` (iOS 26.0; don't trust stale docs).
- The app has two names, and they are not interchangeable. Its **label** is
  **OS**: that is what the system shows, on the Home Screen, in the Dock and
  Finder, in Spotlight, Siri, Shortcuts, and on the Settings screens that list
  installed apps. Its **full name** is **Open Session**, which the App Store
  record keeps and which prose the app writes uses. Four places carry the label
  and have to move together: `CFBundleDisplayName` in the iOS target's `info`
  plus `INFOPLIST_KEY_CFBundleDisplayName` on the Mac target in `project.yml`,
  `PRODUCT_NAME` on the Mac target (the app menu
  is `CFBundleName`, and only `PRODUCT_NAME` can set it, so it also renames the
  `.app` and executable — keep `TEST_HOST` in step), `CFBundleDisplayName` in
  `OS1Widgets/Info.plist`, and `AppBrand.appName`. The full name lives once, in
  `AppBrand.productName`. Never hardcode either in a view. Which one a string
  takes: a sentence that sends a person somewhere outside the app ("turn it on
  for OS in Settings") takes the label, because that is what they will read
  when they get there; prose about the product takes the full name. Siri
  phrases interpolate `\(.applicationName)` and follow the display name for
  free. Renaming is free on this side — every byte the app stores is keyed on
  the bundle id, not the name. The Electron shell is the opposite (see
  `packages/clients/mac/src/main.js`). `AppBrand` is the product; `Brand` in
  `Views/BrandLogos.swift` is the third-party service marks on the Connections
  screen. They are not the same.
- Pure SwiftUI. SwiftStreamingMarkdown is the deliberate exception to the
  no-third-party-dependencies default; discuss any additional dependency first.
- Both targets share one bundle id (one App Store Connect record, universal
  purchase) — Tella ships `dev.tella.os1`, set in `project.yml`; forks rebrand
  to their own team id and bundle-id prefix. The Electron shell uses a
  distinct `.shell`-suffixed id (Tella: `dev.tella.os1.shell`); two Mac apps
  must never share a bundle id.

## Building and testing (from a non-Mac host)

A Linux host has no Xcode. Verify every change on a Mac build node over SSH —
the commands below show how Tella does it (`ssh tella-mac-node`, Xcode 26.6);
substitute your own Mac's hostname:

```sh
rsync -a --delete packages/clients/ios/ tella-mac-node:/tmp/os1-check/packages/clients/ios/
ssh tella-mac-node '
  cd /tmp/os1-check/os1-ios && xcodegen generate --quiet
  xcodebuild -quiet build -skipMacroValidation -project OS1.xcodeproj -scheme OS1 \
    -destination "generic/platform=iOS Simulator" -derivedDataPath /tmp/os1-check/dd
  xcodebuild -quiet build -skipMacroValidation -project OS1.xcodeproj -scheme OS1Mac \
    -destination "platform=macOS" -derivedDataPath /tmp/os1-check/dd CODE_SIGNING_ALLOWED=NO
  xcodebuild -quiet test -skipMacroValidation -project OS1.xcodeproj -scheme OS1Mac \
    -destination "platform=macOS" -derivedDataPath /tmp/os1-check/dd \
    CODE_SIGNING_ALLOWED=NO'
```

- Always build BOTH schemes: `#if os(macOS)` blocks only compile in `OS1Mac`.
- Keep `-skipMacroValidation` on noninteractive builds. SwiftStreamingMarkdown's
  exact pinned dependency graph includes the Equatable compiler macro.
- A Mac-target `errSecInternalComponent` CodeSign failure over SSH is the build
  box's locked keychain, not a code error — `CODE_SIGNING_ALLOWED=NO` avoids it
  for compile checks.
- The Linux host can't catch Swift compile errors; never declare a change done
  without a real xcodebuild run.

## Screenshots

`bun scripts/capture-ios.ts <out.png>` is the whole chain in one command: it
syncs this directory to the Mac node, regenerates the project, builds, boots a
simulator of its own, installs, launches against the live server, screenshots
at device resolution and copies the PNG back. Use it for the walkthrough every
user-visible change here is expected to publish — a native change is the one
that gets skipped because capturing it _looks_ expensive.

```sh
bun scripts/capture-ios.ts /tmp/after.png
bun scripts/capture-ios.ts /tmp/after.png --session os-… --theme dark
bun scripts/capture-ios.ts /tmp/before.png --source /tmp/wt-x/packages/clients/ios   # a detached worktree
```

- **`--platform mac` is a first-class surface, not a consolation prize.** It
  builds `OS1Mac` and captures the window — the same SwiftUI views with no
  simulator underneath, so it costs a fraction of the load and renders when
  the box is too busy for a device. For a transcript row, a chip, a colour or
  a layout fix it is the better picture. Reach for the simulator when the
  change is about a _phone_: safe areas, the keyboard, sheets, Dynamic Type.
- **The first build is 5-8 minutes; later ones are ~90 seconds.** The build
  tree is keyed on your session and reused, so take the second screenshot.
- **It talks to the server over the tailnet, never a reverse tunnel.** Tunnels
  are the historic source of silent failure here (colliding ports, stale
  listeners, and loopback rejecting human tokens while `/api/auth/status` still
  answers 200, so the app looks signed in while every poll 401s).
- **A Swift error in a file you did not touch is usually another session
  mid-edit** in this shared checkout, not your change — the failure says so and
  prints the errors. Capture from a detached worktree with `--source`
  meanwhile.
- **Raise `--wait` for a long transcript.** The default 45s catches the app
  signed in with its list rendered, but a big session can still be showing
  skeleton rows.

## Using the Mac node beyond builds

A build node with a logged-in GUI session is a full Mac — use it whenever
a task needs real Apple hardware, not just for compiles:

- **Run the actual app.** `ServerConfig` honors `OS1_SERVER` / `OS1_TOKEN`
  env overrides (nothing persisted), so a built Mac app launches
  pre-configured straight from SSH. If the server isn't reachable from the
  Mac (a private/VPN-only instance), reverse-tunnel it:
  `ssh -R 13850:127.0.0.1:3850 <mac-node> '…'` and launch with
  `OS1_SERVER=http://127.0.0.1:13850 OS1_TOKEN=<token>
"<build>/Open Session.app/Contents/MacOS/Open Session"` (quote it: the Mac
  target's `PRODUCT_NAME` is the product name, spaces and all; tokens:
  `~/.opensession/web-sessions.json` on the server host). On the iOS simulator the
  same overrides inject via `SIMCTL_CHILD_*`.
- **Profile it.** `sample <pid> 15 -file out.txt` gives per-thread call
  graphs — enough to see exactly what runs on the main thread; `xctrace
record --template "Time Profiler" --attach <pid>` when a full Instruments
  trace is needed.
- **Micro-benchmark suspect code.** The model files are plain Foundation:
  compile them against a `main.swift` harness (`swiftc -O main.swift
Session.swift`) and feed real payloads fetched from the live server.

This is how the 2026-07 sessions-poll hitch was found and verified: the old
formatter-per-parse comparator sort measured ~400ms per poll on the Mac (the
fixed decorated sort ~50ms), and a `sample` of the running app confirmed the
main thread idle afterwards. Prefer measuring there over reasoning from
source alone.

## Releasing

Pushing to `main` with changes under `packages/clients/ios/**` auto-triggers the
TestFlight workflows (`.github/workflows/os1-ios-testflight.yml` and
`os1-mac-testflight.yml`; markdown-only changes are excluded from the path
filter). There is no separate release step — treat every push as shipping to
TestFlight.

Every embedded target needs its own App Store provisioning profile, because
each is its own bundle id. The app's comes from a repository secret; the
widget extension's ("OS1 Widgets App Store", `dev.tella.os1.widgets`) is
fetched during the build with `ci/fetch-provisioning-profile.mjs`, using the
App Store Connect API key the upload job already holds — do the same for any
further extension rather than adding a secret. Profiles expire a year after
the signing certificate is issued; the fetch fails loudly with the expiry
date, and a replacement is one `POST /v1/profiles` away. Adding an extension
also means adding its bundle id to the `provisioningProfiles` map in the
workflow's ExportOptions.plist, or the export fails after a green archive —
verify both steps on a Mac node (`xcodebuild archive -configuration Release`
then `-exportArchive`) before pushing, since a push IS the release.

## Icons: SF Symbols

Icons in this app are SF Symbols. That is the platform's own set, it carries
weight, scale and Dynamic Type sizing for free, and it is what every other iOS
app draws, so a symbol reads as the system rather than as the web client
transplanted onto a phone. The web UI is the mirror image: it draws iconic-pro,
because that is ITS platform convention (see `packages/core/opensession-server/src/frontend/AGENTS.md`). Neither
set follows the other across. A glyph that exists in both clients is expected
to look different in each, and that is not a bug to file.

- **Never port a web glyph** to get visual parity with the browser. If SF
  Symbols has the metaphor, use it, even when the drawing differs from the
  web's.
- **`WebIcon.swift` is the one escape hatch**, for a metaphor the platform set
  does not carry. That is a higher bar than preferring the web's drawing, and
  it is met two ways: SF Symbols has no glyph at all (`robot` — the nearest is
  `robotic.vacuum`, a floor cleaner), or it has one that does not read as the
  thing (`pullRequest`, `gitMerge` — `arrow.trianglehead.pull` and `.merge` are
  generic arrows, while the branch-and-node graph is what GitHub and every
  other dev tool uses, so it is what people recognise a PR by). Its paths are
  stroked at 1.5 on a 24-point grid so they sit at a symbol's weight beside one.
- **Context decides which of the two a git mark takes.** The unlabelled STATE
  MARK on a session row carries the meaning alone, so it takes the graph. A
  menu row or a panel header sits in system chrome beside other symbols and has
  a text label doing the work, so it takes `arrow.trianglehead.pull`. Both are
  in the app on purpose; do not unify them.
- **Weight comes from the font, not from the box.** Size a symbol with
  `.font(.callout)` or `.font(.system(size:))` and give it a fixed `.frame`;
  never `.resizable()`, which scales the stroke with the box and leaves a large
  glyph heavier than its neighbours.
- **Default to monochrome rendering.** `.symbolRenderingMode(.hierarchical)`
  draws in two opacities and reads as a lighter weight than the rows around it.
  It is right for a large empty-state mark (`ListPlaceholder`), not for a row.
- **Icons that sit next to each other must be built the same way** — same font,
  same frame, same rendering mode. The Reports and Archived rows are the
  worked example.
- **Use current symbol names.** Many were renamed in SF Symbols 7 and the old
  names survive only as aliases: `doc.text` is now `text.document`,
  `arrow.triangle.pull` is `arrow.trianglehead.pull`, `doc.on.doc` is
  `document.on.document`, `clock.arrow.circlepath` is
  `clock.arrow.trianglehead.counterclockwise.rotate.90`. Parts of this app are
  still on the old names; they render, so it is not urgent, but do not add
  more. Check a name against the deployment target before using it — an
  unknown name is not a compile error, it renders blank.

## Performance invariants (learned the hard way — don't regress)

- **Observation granularity is per view `body`.** `SessionViewModel` is
  `@Observable`; any property read inside `SessionView.body` re-evaluates the
  whole body — transcript included. Per-keystroke state (`draft`, `canSend`,
  `attachedImages`) is read ONLY inside `SessionInputBar`; keep it that way,
  and give other hot state the same treatment (own view struct).
- **Streaming markdown uses one persistent source.** `StreamingMarkdownBody`
  feeds coalesced full-text snapshots through one `StreamedMarkdownView` and a
  newest-only `AsyncStream`; don't recreate the renderer per chunk or bypass
  the source. Durable rows use the library's async `MarkdownView`.
- **Stream text is coalesced.** `stream_text` chunks buffer in the view model
  and flush to `liveText` at ~8Hz; don't bind UI to per-chunk updates.
- **Scroll pinning is explicit.** `onScrollGeometryChange` tracks
  "near-bottom"; new output follows only while pinned, sends and pending
  questions always scroll. Don't rely on `defaultScrollAnchor(... .sizeChanges)`
  alone — keyboard insets and lazy row settling knock it loose.
- Decode server frames off the main thread (see `OS1Socket` / `ServerEvent`);
  the transcript can be large.
- **REST decoding and list preparation are off-main too.** `OS1API` is
  `@MainActor`, so its generic get/post decode via `decodeDetached` —
  `/api/sessions` is multi-megabyte (thousands of rows) and polls every 5s
  while a session is open, and inline decoding was a visible periodic hitch
  while typing. Keep new endpoints on that path, keep the sessions-list
  filter/sort in `SessionsListViewModel.prepared` (detached, decorated sort),
  and never allocate an `ISO8601DateFormatter` per call — `Session.parseISO`
  uses cached thread-safe formatters because it runs inside sort comparators.
- **The list arrives in two pieces.** The 5s poll asks for the live slice
  (`?archived=exclude`); archived sessions come from `?archived=only&slim=1`
  on a 30s clock, as SUMMARY rows marked `slim` — they were about half the
  payload and none of the first screen. A slim row is not a whole session:
  anything that opens one calls `SessionsListViewModel.hydrated` first
  (`GET /api/sessions/:id`), or the conversation comes up missing its PR,
  walkthrough and model. Both parameters are opt-in server-side, so a server
  that predates them answers with the whole list and `prepared` still splits
  it — don't "simplify" that fallback away.

## Server coupling

- REST + WS shapes live in `packages/core/opensession-server/src/server/` (routes, `ws-handlers.ts`,
  `pr-info.ts` for `PrDetails`). Models here decode a tolerant SUBSET —
  optionals everywhere, unknown fields ignored — so server additions never
  break older app builds. Keep new fields optional.
- The server answers a bare JSON `null` for "no PR" style routes — probe the
  raw body before decoding (see `OS1API.pr`).
- Cross-platform shims live in `PlatformCompat.swift`; add new
  iOS-only/Mac-only API bridging there rather than scattering `#if os(...)`.
