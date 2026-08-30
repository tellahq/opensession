# Apple mobile

Open Session ships an opt-in Apple mobile MCP integration for SwiftPM and iOS projects. It has separate build and release servers so normal development never receives Apple credentials.

## Capabilities and limits

The build server can inspect a configured project, run `swift test`, create unsigned Xcode simulator builds, and create xtool development builds. xtool distribution is development-only. Do not treat an xtool IPA or development profile as ad-hoc, TestFlight, or App Store distribution.

Release planning and execution require Xcode on macOS. The integration can create ad-hoc exports and upload to TestFlight. It cannot submit an app for App Review or release an app publicly. It never revokes certificates.

xtool can download and use Apple SDK material on Linux. Apple licenses may restrict where and how that SDK may be used. Open Session does not bundle an Apple SDK or grant a license to one. Have your organization review Apple's terms before enabling xtool on Linux.

## Add the connections

In **Settings → Connections**, add two stdio MCP servers. `opensession` must be on the service user's `PATH`.

### Build tools

- Name: `apple-build`
- Command: `opensession`
- Arguments: `apple-mobile-mcp --mode build`
- Environment:

  ```text
  APPLE_MOBILE_ALLOWED_ROOTS=/Users/YOU/dev:/Users/YOU/.opensession/worktrees
  ```

This server is credential-free. It may be available to normal interactive coding sessions. Building a repository can execute repository-controlled SwiftPM plugins and build scripts, so keep the allowed roots narrow.

### Release tools

- Name: `apple-release`
- Command: `opensession`
- Arguments: `apple-mobile-mcp --mode release`
- Environment:

  ```text
  APPLE_MOBILE_ALLOWED_ROOTS=/Users/YOU/dev:/Users/YOU/.opensession/worktrees
  APPLE_ASC_KEY_ID=YOUR_KEY_ID
  APPLE_ASC_ISSUER_ID=YOUR_ISSUER_ID
  APPLE_ASC_PRIVATE_KEY_PATH=/protected/apple/AuthKey_YOUR_KEY_ID.p8
  APPLE_DEVELOPER_TEAM_ID=YOUR_TEAM_ID
  ```

Set **Allowed users** to the people permitted to release. Never leave `apple-release` unrestricted. Open Session's `allowedUsers` gate keeps the server out of other users' sessions and unattended automations. The package does not set or bypass that operator-owned gate.

Store the private key outside every allowed project root and worktree with mode `0600`. Put credentials in protected Open Session configuration, not a repository, project config, or chat.

## Configure an app

Commit `.opensession/apple-mobile.json` in the app repository. Paths are project-relative and symlinks may not escape the project.

### xtool development

The project also needs `Package.swift` and `xtool.yml`.

```json
{
  "version": 1,
  "backend": "xtool",
  "bundleId": "com.example.App",
  "xtool": { "configuration": "debug" },
  "release": { "requireClean": true, "allowedBranches": ["main"] }
}
```

### Xcode release

```json
{
  "version": 1,
  "backend": "xcode",
  "bundleId": "com.example.App",
  "teamId": "TEAMID",
  "xcode": {
    "container": "workspace",
    "path": "App.xcworkspace",
    "scheme": "App",
    "configuration": "Release"
  },
  "release": {
    "requireClean": true,
    "allowedBranches": ["main"],
    "artifactDirectory": ".build/apple-mobile"
  }
}
```

Add the artifact directory to `.gitignore`.

## Release approval

Release plans expire after one hour. A plan is authenticated and bound to the clean git commit, branch, project config, and, for an existing IPA upload, the artifact SHA-256. Execution requires the exact full commit SHA shown in the plan.

The shipped skill requires a separate user turn between planning and execution. Review the commit, version, build number, destination, and effects before approving. TestFlight upload only hands the build to Apple for processing. It does not submit for review or make the app public.

Existing IPA upload uses `xcrun altool` on macOS. Linux and Windows uploads are unsupported. Release execution always requires macOS and Xcode.
