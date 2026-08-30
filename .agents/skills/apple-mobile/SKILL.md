---
name: apple-mobile
description: Build SwiftPM/xtool iOS apps and prepare explicitly approved ad-hoc or TestFlight releases through the apple-build and apple-release MCP servers.
---

# Apple mobile workflow

Use `apple_mobile_doctor` and `apple_mobile_inspect_project` before any build.

## Safety rules

- Never paste or print an App Store Connect private key, Apple password, certificate private key, or provisioning secret.
- Treat xtool as a development-build backend only. Do not claim its current development profiles are ad-hoc or App Store profiles.
- Never release from a dirty worktree or an unapproved branch.
- Never call `apple_release_execute` in the same response that creates a plan. Show the full project path, plan ID, commit, version/build, destination, effects, and any IPA filename and SHA-256. A signed-in allowed person must approve that exact pending plan later in Settings → Integrations → Apple mobile.
- The execute confirmation must be the full commit SHA from the reviewed plan.
- TestFlight upload is not App Review submission or public release. This integration deliberately exposes neither action.
- Do not revoke certificates.

## Development

1. Run `apple_mobile_doctor`.
2. Run `apple_mobile_inspect_project`.
3. Run `apple_mobile_test` where the package has host-portable tests.
4. Use `apple_mobile_build_unsigned` for a non-signing build.
5. Inspect generated IPAs with `apple_mobile_inspect_ipa`.

## Ad-hoc or TestFlight

1. Run `apple_release_doctor` and inspect the project.
2. Create a plan using `apple_release_plan_adhoc`, `apple_release_plan_testflight`, or `apple_release_plan_upload`.
3. Present the full project path, plan ID, commit, effects, and any IPA filename and SHA-256, then stop. The planning response cannot authorize execution.
4. Ask a signed-in allowed person to approve the exact pending plan in Settings → Integrations → Apple mobile.
5. In a later turn, call `apple_release_execute` with the plan ID and full planned commit SHA. The server consumes the one-time approval grant.
6. Report the output artifact SHA-256 or upload result. Do not imply Apple processing has completed unless separately verified.

## Repository contract

Each app must commit `.opensession/apple-mobile.json`. Configured paths are relative to the project and cannot escape it. Distribution operations require the `xcode` backend; xtool is intentionally rejected for distribution.
