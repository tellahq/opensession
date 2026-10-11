# Open Session Apple mobile

First-party MCP servers for creating SwiftUI apps, SwiftPM/xtool and Xcode development builds, and commit-bound ad-hoc, TestFlight, App Review, and App Store releases.

This package is private to the Open Session workspace. Run it through the stable `opensession apple-mobile-mcp` entry point rather than installing a scratch-local binary.

- `--mode build` exposes credential-free app creation, inspection, tests, unsigned builds, and IPA inspection.
- `--mode release` exposes App Store Connect status, bundle ID registration, TestFlight distribution, and release planning and execution. Configure this server with App Store Connect credentials and a non-empty Open Session `allowedUsers` list.

See [the setup guide](../../../docs/setup/apple-mobile.md) for connection configuration, project examples, security boundaries, and platform limitations.
