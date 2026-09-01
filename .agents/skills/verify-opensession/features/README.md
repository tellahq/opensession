# Open Session verification map

This directory is the maintained source for verifying Open Session's user-facing web behavior. Read this index before driving the app, then use the matching feature file.

## Baseline preconditions

- Launch an isolated demo instance with `verify-opensession launch "$RUN_ID"`.
- Run `verify-opensession doctor "$RUN_ID"` and require every check to pass.
- Start browser recipes from their named route at either 1440x900 or 390x844.
- Use only the run's generated `APP_URL`, disposable state directory, and private browser.
- Never drive the production instance, the frontend production proxy, or another run's port.
- Keep proof in `artifacts/verification/opensession/$RUN_ID/`.

## Driving conventions

- Commands below abbreviate the executable as `verify-opensession`. From the repository root, its full path is `./.agents/skills/verify-opensession/bin/verify-opensession`.
- Every browser command takes `"$RUN_ID"` before its subcommand.
- Prefer accessibility roles and exact accessible names. Take a current `snapshot` when a lookup fails.
- Desktop and phone are one web bundle. Check both widths for visible changes.
- The demo seed is synthetic. Its stable sessions include `bks-demo-pr`, `bks-demo-failed`, and `bks-demo-automation-run`.
- External integrations, schedulers, and engine execution are disabled. Report those paths as unproved rather than steering production.

## Proof and skip reporting

- Capture the user action and the resulting state.
- UI proof includes an accessibility snapshot and screenshot with Open Session identity visible.
- Mutation proof includes a second read of the stored value through another UI route or read-only API.
- Record the feature ID, entry point, viewport, and run ID with each artifact.
- Report an unreachable entry point with the attempted command and unmet precondition.
- A different entry point does not prove a skipped one.
- Cleanup removes scratch state but leaves evidence in place.

## Feature entry contract

Each feature file uses the same four H2 sections. `Sub-features` names the behaviors. `How to get to it (user POV)` lists user entry points. `Driving it with verify-opensession` gives literal commands and observable results. `Gotchas` records limits that can invalidate a run.

## Features

- [Sessions and transcripts](./sessions-and-transcripts.md) covers opening seeded work, reading a transcript, changing panes, and entering the new-session flow.
- [Automations](./automations.md) covers the automation list, detail view, enabled state, authoring, and saved configuration.
- [Goals](./goals.md) covers list and detail views, creating a goal, and confirming persistence.
- [Archived sessions](./archived-sessions.md) covers the archived index, search, filters, restoration, and empty results.
- [Settings](./settings.md) covers direct section routes, settings navigation, search, and persisted preferences or instance configuration.
