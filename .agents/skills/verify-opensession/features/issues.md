# Issues

Issues is the cross-repository list of open GitHub issues. Users search or filter it, inspect an issue without leaving Open Session, see whether work already has a session, and start a session for unclaimed work.

## Sub-features

- `issue-list` groups open issues by recent activity and shows repository, number, labels, comments, and session state.
- `issue-search` filters by title, number, author, repository, or label.
- `issue-repository` narrows the list when more than one repository has issues.
- `issue-preview` opens the issue body and metadata in a responsive preview.
- `issue-session` opens existing work or asks Open Session to start work on an unclaimed issue.

## How to get to it (user POV)

- Choose `Issues` in the sidebar when that tool is enabled in Preferences.
- Open `/issues` directly.
- Open the command menu and choose `Issues`.
- Choose an issue row to inspect it, then open or start its session from the preview.

## Driving it with verify-opensession

Preconditions:

- Doctor passes for the isolated demo run.
- The demo seed contains issue #131, issue #129, issue #124, and issue #118. Issue #131 is linked to the running demo session.

- **Open the list.** Run `verify-opensession browser "$RUN_ID" open --route /issues --width 1440 --height 900`. Wait for the button named `A Upload retries stall after the third attempt #131 Running 1h`, then capture the list. The trailing relative age changes as the run gets older, so take a snapshot before reusing this selector in a long run.
- **Search.** Choose the `Search issues` button, then fill the `searchbox` also named `Search issues` with `contrast`. Require the list to retain `Dark mode: due-date chips lose contrast` and hide non-matches.
- **Preview.** Clear the search, take a fresh snapshot, and choose one issue row by its exact accessible name. The responsive preview shows its title, body, labels, repository, author, and either an existing-session action or `Start session`.
- **Check linked work.** Issue #131 shows `Running` on desktop and opens its existing session rather than creating another one. Do not start an unclaimed issue merely to prove an engine turn; execution is disabled in the demo.
- **Check phone layout.** Open `/issues` at 390x844. Wait for the issue #131 row using its current accessible name from the snapshot, then capture the list and one preview. Search and preview dismissal must remain reachable without hover.
- **Proof.** Save desktop list, filtered list, preview, and phone snapshots and screenshots. Use `verify-opensession api "$RUN_ID" /api/issues | jq .` as a read-only second view when issue metadata matters.

## Gotchas

- Issue data comes from the configured GitHub cache in normal use. The demo uses synthetic cache rows and proves no live GitHub connection.
- The row name includes repository initials, issue number, state, comments, and a relative age; desktop and phone omit different secondary fields. Snapshot before clicking instead of guessing.
- The search trigger and expanded search field share the name `Search issues` but have different roles (`button` and `searchbox`).
- Starting an issue session is a real mutation. In the demo it can prove session creation, not a successful model turn or GitHub label update.
- With only one seeded repository, the repository picker is intentionally absent.
