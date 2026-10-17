---
name: apple-mobile
description: Create SwiftUI iOS apps, build them, and ship them through TestFlight and the App Store with the apple-build and apple-release MCP servers. Every release step is a commit-bound plan a person approves.
---

# Apple mobile workflow

Use `apple_mobile_doctor` and `apple_mobile_inspect_project` before any build.
Only iOS apps can be released today. macOS apps can be created and built, and
release tools refuse them with a clear error.

## Safety rules

- Never paste or print an App Store Connect private key, Apple password, certificate private key, or provisioning secret.
- Treat xtool as a development-build backend only. Do not claim its current development profiles are ad-hoc or App Store profiles.
- Never release from a dirty worktree or an unapproved branch.
- Never call `apple_release_execute` in the same response that creates a plan. Show the plan ID, commit, version/build, and its `effects`, then stop. A signed-in allowed person approves it with the card under the planning call in the session, or in Settings → Integrations → Apple mobile.
- The execute confirmation must be the full commit SHA from the reviewed plan.
- A TestFlight upload is not App Review. Submitting for review and releasing on the App Store are separate plans, each approved on its own.
- Do not revoke certificates.

## New app

1. `apple_mobile_create_app` with an absolute, empty `projectDir`, a display `name`, a reverse-DNS `bundleId`, and the `teamId` if known. It writes an XcodeGen `project.yml`, SwiftUI sources, tests, an asset catalog, and `.opensession/apple-mobile.json`. The Xcode project is generated, never committed.
2. `git init -b main`, commit, and push wherever the person wants the repo.
3. Build with `apple_mobile_build_unsigned`; it runs XcodeGen and returns the simulator `.app` path. Preview with `start_simulator_portal`.
4. With the release server: `apple_release_register_bundle_id`, then `apple_release_app_status`. Apple's API cannot create the App Store Connect app record, so status prints the exact values for the person to enter once at App Store Connect → Apps → New App. Do not try to automate that step with an Apple ID login.
5. Remind the person to add a 1024×1024 app icon before the first App Store submission.

## Development

1. Run `apple_mobile_doctor` and `apple_mobile_inspect_project`.
2. Run `apple_mobile_test` where the package has host-portable tests.
3. Use `apple_mobile_build_unsigned` for a non-signing build. For an Xcode project it returns the built `.app` relative to the project.
4. Inspect generated IPAs with `apple_mobile_inspect_ipa`.
5. To show an app from a local Mac workspace, pass the simulator `.app` (workspace-relative) to `opensession-portals` `start_simulator_portal`. This needs full Xcode and idb. Open the returned Portal at `/`, exercise the app, and report the URL. A listening viewer may still be booting its simulator; verify the screen before claiming the app works. Use `restart_portal` after rebuilding or `stop_portal` to release it. See `docs/simulator-portals.md` in the Open Session repository.

## TestFlight

1. `apple_release_doctor`, then `apple_release_app_status` to see the app record, recent builds, and next steps.
2. `apple_release_plan_testflight`. Omit `buildNumber`: the plan uses one above the highest build in App Store Connect. Pass `marketingVersion` only when the version changes.
3. Present the plan ID, commit, version, build, and `effects`, then stop.
4. After approval, in a later turn, `apple_release_execute` with the plan ID and full commit SHA.
5. Apple then processes the build, usually for several minutes. Check `apple_release_app_status` until the build is `VALID`. Do not sleep in a loop; schedule a check-back.
6. `apple_release_testflight_distribute` with the build number, optional `whatToTest`, and internal `groups`. External groups need Beta App Review in App Store Connect and are refused.

## App Store

Store metadata, screenshots, privacy answers, and age rating must already be complete in App Store Connect; these tools do not edit them.

1. `apple_release_plan_submit` with `marketingVersion`, the processed `buildNumber`, optional `whatsNew`, and `releaseType`: `manual` (default) keeps the approved version waiting for a release plan, `after_approval` goes live as soon as Apple approves it. Say which one you chose.
2. Present the plan and stop. After approval, `apple_release_execute` in a later turn. It creates or updates the App Store version, attaches the build, and submits for review.
3. Apple's review takes hours to days. Check with `apple_release_app_status`.
4. For a manual release, once the version is `PENDING_DEVELOPER_RELEASE`, `apple_release_plan_store_release`, present it, stop, and execute after approval.

## Ad-hoc

`apple_release_plan_adhoc` exports a build signed for registered devices. Same plan, approve, execute flow.

## Repository contract

Each app commits `.opensession/apple-mobile.json`. Configured paths are relative to the project and cannot escape it. `platform` is `ios` (default) or `macos`. Set `xcode.generator` to `xcodegen` to generate the Xcode project from `project.yml` at build time. Distribution requires the `xcode` backend; xtool is intentionally rejected for distribution.
