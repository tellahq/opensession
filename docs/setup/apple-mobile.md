# Apple mobile

Open Session ships an opt-in Apple mobile MCP integration for SwiftPM and iOS projects. It has separate build and release servers so normal development never receives Apple credentials.

## Capabilities and limits

The build server can create a new SwiftUI app, inspect a configured project, run `swift test`, create unsigned Xcode simulator builds, and create xtool development builds. xtool distribution is development-only. Do not treat an xtool IPA or development profile as ad-hoc, TestFlight, or App Store distribution.

The release server covers the rest of an app's life through the App Store Connect API:

| Step                                                                     | Tool                                                    | Needs approval |
| ------------------------------------------------------------------------ | ------------------------------------------------------- | -------------- |
| Register the bundle ID                                                   | `apple_release_register_bundle_id`                      | No             |
| See app, builds, versions, groups, next steps                            | `apple_release_app_status`                              | No (read-only) |
| Archive and upload to TestFlight, next build number picked automatically | `apple_release_plan_testflight`                         | Yes            |
| Ad-hoc export, or upload an existing IPA                                 | `apple_release_plan_adhoc`, `apple_release_plan_upload` | Yes            |
| Set What to Test and add a build to internal TestFlight groups           | `apple_release_testflight_distribute`                   | No             |
| Submit a processed build for App Review                                  | `apple_release_plan_submit`                             | Yes            |
| Release an approved version on the App Store                             | `apple_release_plan_store_release`                      | Yes            |

Apple's API cannot create the App Store Connect app record. Create it once at App Store Connect → Apps → New App; `apple_release_app_status` prints the values to enter. The tools also do not edit store metadata, screenshots, privacy answers, or external TestFlight groups.

Building and uploading require Xcode on macOS. Submitting and releasing only call the App Store Connect API. The integration never revokes certificates.

Only iOS apps can be released today. A project may declare `"platform": "macos"` and build with the build server; release tools refuse it until macOS distribution is added.

xtool can download and use Apple SDK material on Linux. Apple licenses may restrict where and how that SDK may be used. Open Session does not bundle an Apple SDK or grant a license to one. Have your organization review Apple's terms before enabling xtool on Linux.

## Set up the connections

Open **Settings → Integrations → Apple mobile**. The setup flow manages two local MCP connections without a restart:

1. Enable **Development builds**. This creates the credential-free `apple-build` connection for projects you open in Open Session.
2. On a Mac with Xcode, enable **Ad-hoc, TestFlight, and App Store releases**.
3. Enter the Apple Developer Team ID, App Store Connect key ID and issuer ID, and the path to its `.p8` private key.
4. Choose the configured Open Session people allowed to release. This creates `apple-release` with a mandatory `allowedUsers` gate.

Store the private key outside the app project with mode `0600`. Put credentials in the setup flow or protected instance configuration, not a repository, project config, or chat.

Before an ad-hoc build, the operator must also arrange an Apple Distribution certificate and private key in the Mac's Keychain, register each target device UDID in the Apple Developer portal, and grant the App Store Connect API key access to certificates, identifiers, and profiles. The agent cannot enroll in Apple's program, accept agreements, obtain device UDIDs, or create private credentials for the operator.

Open Session checks `apple-release` against the current prompter only. An allowed session creator does not grant release access to someone else steering that shared session. The setup route refuses to create or unrestrict the connection without at least one allowed person, and execution still needs the separate authenticated approval grant.

## Create an app

`apple_mobile_create_app` writes a SwiftUI app into an empty directory: an XcodeGen `project.yml`, sources, tests, an asset catalog, `.gitignore`, and `.opensession/apple-mobile.json`. The Xcode project is generated from `project.yml` at build time and is not committed. Install XcodeGen (`brew install xcodegen`) on the Mac that builds.

The generated `Info.plist` declares `ITSAppUsesNonExemptEncryption: false`, which answers TestFlight's export compliance question. Change it if the app uses non-exempt encryption. Add a 1024×1024 app icon before the first App Store submission.

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

`platform` defaults to `ios`. With `"generator": "xcodegen"`, `xcode.path` names the project XcodeGen will write and `container` must be `project`:

```json
{
  "version": 1,
  "backend": "xcode",
  "bundleId": "com.example.App",
  "platform": "ios",
  "teamId": "TEAMID",
  "xcode": {
    "container": "project",
    "path": "App.xcodeproj",
    "scheme": "App",
    "configuration": "Release",
    "generator": "xcodegen"
  },
  "release": { "requireClean": true, "allowedBranches": ["main"] }
}
```

A committed workspace works too:

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

Planning creates a pending request but never authorizes execution. Each plan lists its effects, for example "Upload com.example.App to App Store Connect for TestFlight processing" or "Release to the public automatically as soon as Apple approves it". In a later step, a signed-in person on the release allowlist reviews the effects, project path, plan ID, commit, and any IPA filename and SHA-256, then clicks **Approve**. The approval card appears under the planning call in the session; **Settings → Integrations → Apple mobile → Release approvals** lists the same requests. Both read the server's signed request, not the agent's output.

Submit and release plans are bound to a clean commit on an allowed branch like build plans, so the same branch policy governs who can ship. Planning a submission checks that the build is processed and the version can still be submitted. Planning a release checks that the version is waiting for developer release. Execution requires the same full commit SHA and atomically consumes that one-time approval grant. Echoing the plan ID or commit from the planning response is not approval.

The shipped skill requires a separate user turn between planning and execution. Review the commit, version, build number, destination, and effects before approving. A TestFlight upload only hands the build to Apple for processing. App Review submission and public release are separate plans.

Existing IPA upload uses `xcrun altool` on macOS. Linux and Windows uploads are unsupported. Release execution always requires macOS and Xcode.
