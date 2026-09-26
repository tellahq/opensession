# iOS simulator Portals

An interactive agent can start an iOS Simulator viewer with
`opensession-portals.start_simulator_portal`. The app runs on the Open Session
Mac, not in the browser. The Portal carries JPEG screen frames and input over
an authenticated WebSocket. On desktop, simulator Portals open beside the
conversation by default. Expand opens the full-width view; closing or expanding
does not immediately pin it again. Phones use the full-width Portal view.

## Host requirements

This first version supports local macOS workspaces. Both install modes work:
the compiled release binary and a source installation. Sandboxes and remote
Runners are not supported. It needs:

- Full Xcode selected with `xcode-select`, with an installed iOS Simulator runtime.
- `idb` and `idb_companion` on the service's PATH. See
  [idb installation](https://github.com/facebook/idb#quick-start).
- Working authenticated [Portal routing](portals-and-agent-communication.md),
  including the instance's Caddy HTTPS configuration. A listening local port
  without that route is not a shareable viewer.
- In a source installation, the checkout's Bun dependencies, including the
  Tailwind compiler. The viewer is bundled when the Portal starts, and the
  Tailwind CLI runs under Bun, so `node` is not required on PATH.

A compiled release binary carries the prebuilt viewer inside the executable
(`scripts/build-compile.ts` embeds it next to the SPA) and starts the viewer
process as `opensession simulator-portal`. Nothing is built at Portal start. A
binary compiled without the embedded viewer reports that gap when the Portal is
requested instead of failing inside the viewer process.

The implementation uses `describe --json` for logical screen dimensions, then
one persistent HTTP/2 gRPC connection to the private companion for input and
capture. The HID and screenshot messages follow the idb 1.5.9 protocol. The
companion must support JPEG screenshot options. Pin a tested idb version to your
Xcode/runtime combination: idb uses private Apple frameworks. Do not assume that
every upstream release is interchangeable.

Capture targets 30 fps at half native resolution and JPEG quality 0.5. It uses
software screenshot capture rather than idb's hardware-only MJPEG video encoder,
so host-specific video CLI wrappers cannot silently cap the frame rate. Captures
are serial and deadline-paced; a slow capture never creates a backlog. Pointer
down, move and up stream immediately rather than replaying a swipe on release.
No input launches a fresh Python CLI process.

Neither Xcode nor idb is installed automatically. Verify operation after a Mac
reboot and without a monitor before relying on unattended use. This integration
reads the simulator framebuffer through idb, not the Mac desktop via
ScreenCaptureKit. It does not request Screen Recording or Accessibility access.

## Agent workflow

1. Build an unsigned **iphonesimulator** `.app` inside the session workspace.
   A device `.app` or `.ipa` cannot be used. For an Xcode project, a typical
   command is:

   ```sh
   xcodebuild -project MyApp.xcodeproj -scheme MyApp \
     -configuration Debug -sdk iphonesimulator \
     -destination 'generic/platform=iOS Simulator' \
     -derivedDataPath .build/simulator CODE_SIGNING_ALLOWED=NO build
   ```

2. Call `start_simulator_portal`:

   ```json
   {
     "appPath": ".build/simulator/Build/Products/Debug-iphonesimulator/MyApp.app"
   }
   ```

   Optional `deviceType` and `runtime` select installed CoreSimulator identifiers.
   Omit them to choose an iPhone and an available iOS runtime. `appPath` is
   workspace-relative; paths and symlinks escaping that workspace are rejected.

3. Open the returned Portal. Its default route is `/`. The viewer shows startup
   and dependency errors, not a fake screen. A listening Portal means the viewer
   is ready; booting the simulator can take longer.
4. Click or drag on the screen. Focus it to send keyboard input, or use the text
   field and **Send**, which also works on phones. **Home** presses the simulated
   Home button. Tab retains normal browser focus navigation.
5. After rebuilding the app, use `restart_portal` with the returned name to
   install the updated bundle. Use `stop_portal` to release the simulator.

Repeated identical starts reuse the same Portal. Its name includes a session
hash so sessions sharing a checkout do not select the same viewer. Changing
start arguments requires stopping it and starting it with the new arguments.

## Ownership and limits

- Each viewer process creates its own CoreSimulator device set and device. No
  command accepts an existing device UDID, including the global `booted` target.
- An owned idb companion listens on a private Unix socket, never a public gRPC
  port. Every input command addresses that companion explicitly.
- At most two simulator leases run on a Mac. Durable capacity records permit
  bounded recovery of a dead owner's private device on the next start. Recovery
  never enumerates another session's devices or databases. Invalid metadata or
  an interrupted recovery lock fails closed and needs operator inspection under
  `/tmp/opensession-idb-simulator-capacity`; never delete a slot until its owned
  device set is stopped and removed.
- Capture runs only while viewers are connected. The helper exits and deletes
  its device after ten minutes without a viewer. Stop/restart and normal Portal
  cleanup also release the device. Restart creates a fresh simulator and loses
  installed app data. Forced termination can defer cleanup until the next start.
- Up to four viewers share one screen stream and a bounded input queue. New
  viewers acknowledge decoded frames, allowing at most one frame in flight per
  viewer; the next delivery uses the newest capture, not queued old frames.
- One viewer owns a touch gesture at a time. Pending moves coalesce to the newest
  position. Release is preserved under queue pressure; disconnect, cancellation
  and a five-second idle deadline release the touch. Other viewers cannot
  interrupt a held gesture.
- Portals retain the instance's authenticated team boundary. This is not a new
  per-person permission boundary. The helper additionally checks the WebSocket
  origin and a same-origin token; it binds only to loopback.
- Basic taps, swipes, text, common keyboard keys and Home are supported. This is
  not full multi-touch, audio, clipboard sync or a screen-reader representation
  of the app. Text support follows idb's keyboard mapping.
- Hot reload is not enabled by this tool. Swift injection or a framework's own
  reload server can be added to the app separately. The viewer is independent
  of how code reaches the running app.

## Verification

Unit tests replace the executable boundary to test device isolation, cleanup,
capacity, paths and setup CLI arguments. Unix-socket HTTP/2 tests exercise the
persistent input and capture RPCs. Real HTTP/WebSocket tests exercise the viewer
transport, origin/token checks, input ownership, movement coalescing, disconnect
release and frame acknowledgements.

For browser verification without Xcode, start a Portal with the command
`bun scripts/verify-simulator-portal.ts`. It serves the production viewer against
an explicitly labelled test fixture, records input at `/test-inputs.json`, and
starts **no simulator**. Append `--failure` to exercise the setup-error view.
These tests do not qualify a real idb/Xcode combination. Before rollout, start a
real app on the intended Mac and verify tap, drag, typing, Home, stream reconnect,
stop, restart, two simultaneous sessions and capacity rejection of a third.
