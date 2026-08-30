# Open Session Apple mobile

First-party MCP servers for SwiftPM/xtool development builds and commit-bound Xcode ad-hoc or TestFlight releases.

This package is private to the Open Session workspace. Run it through the stable `opensession apple-mobile-mcp` entry point rather than installing a scratch-local binary.

- `--mode build` exposes credential-free inspection, tests, unsigned builds, and IPA inspection.
- `--mode release` exposes release planning and execution. Configure this server with App Store Connect credentials and a non-empty Open Session `allowedUsers` list.

See [the setup guide](../../../docs/setup/apple-mobile.md) for connection configuration, project examples, security boundaries, and platform limitations.
