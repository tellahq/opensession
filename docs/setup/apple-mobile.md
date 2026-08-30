# Apple mobile

Open Session ships an opt-in Apple mobile MCP integration for SwiftPM and iOS projects. It has separate build and release servers so normal development never receives Apple credentials.

## Capabilities and limits

The build server can inspect a configured project, run `swift test`, create unsigned Xcode simulator builds, and create xtool development builds. xtool distribution is development-only. Do not treat an xtool IPA or development profile as ad-hoc, TestFlight, or App Store distribution.

Release planning and execution require Xcode on macOS. The integration can create ad-hoc exports and upload to TestFlight. It cannot submit an app for App Review or release an app publicly. It never revokes certificates.

xtool can download and use Apple SDK material on Linux. Apple licenses may restrict where and how that SDK may be used. Open Session does not bundle an Apple SDK or grant a license to one. Have your organization review Apple's terms before enabling xtool on Linux.

## Set up the connections

Open **Settings → Integrations → Apple mobile**. The setup flow manages two local MCP connections without a restart:

1. Enable **Development builds**. This creates the credential-free `apple-build` connection for projects you open in Open Session.
2. On a Mac with Xcode, enable **Ad-hoc and TestFlight releases**.
3. Enter the Apple Developer Team ID, App Store Connect key ID and issuer ID, and the path to its `.p8` private key.
4. Choose the configured Open Session people allowed to release. This creates `apple-release` with a mandatory `allowedUsers` gate.

Store the private key outside the app project with mode `0600`. Put credentials in the setup flow or protected instance configuration, not a repository, project config, or chat.

Before an ad-hoc build, the operator must also arrange an Apple Distribution certificate and private key in the Mac's Keychain, register each target device UDID in the Apple Developer portal, and grant the App Store Connect API key access to certificates, identifiers, and profiles. The agent cannot enroll in Apple's program, accept agreements, obtain device UDIDs, or create private credentials for the operator.

Open Session checks `apple-release` against the current prompter only. An allowed session creator does not grant release access to someone else steering that shared session. The setup route refuses to create or unrestrict the connection without at least one allowed person, and execution still needs the separate authenticated approval grant.

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

Release plans expire after one hour. A plan is authenticated and bound to the clean git commit, branch, project config, and, for an existing IPA upload, the artifact filename and SHA-256. Repository config cannot disable the clean-worktree check. Planning copies an existing IPA into private controlled storage, and execution uploads that exact approved copy. Build releases execute from a fresh detached checkout at the planned commit, not from the selected worktree.

Planning creates a pending request but never authorizes execution. In a later step, a signed-in person on the release allowlist reviews the full project path, plan ID, commit, and any IPA filename and SHA-256 under **Settings → Integrations → Apple mobile → Release approvals**, then clicks **Approve**. Execution requires the same full commit SHA and atomically consumes that one-time approval grant. Echoing the plan ID or commit from the planning response is not approval.

The shipped skill requires a separate user turn between planning and execution. Review the commit, version, build number, destination, and effects before approving. TestFlight upload only hands the build to Apple for processing. It does not submit for review or make the app public.

Existing IPA upload uses `xcrun altool` on macOS. Linux and Windows uploads are unsupported. Release execution always requires macOS and Xcode.
