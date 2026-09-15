# Issues

Issues lists open GitHub issues from connected repositories. Users search or scope the list, preview an issue, open its existing session, or start a session for unclaimed work.

## Sub-features

- `issues-list` groups open issues by recent activity and shows labels, comments, and session state.
- `issues-search` filters by title, number, author, repository, or label.
- `issues-repository` narrows the list to one repository when several are connected.
- `issues-preview` opens the issue body and metadata without leaving the list.
- `issues-session` opens an existing issue session or starts one when execution is available.
- `issues-phone` keeps search, preview, and session actions reachable at phone width.

## How to get to it (user POV)

- Enable `Issues` under Preferences → Show in sidebar, then choose it in the sidebar.
- Open `/issues` directly.
- Choose an issue row to inspect it, then use its session action.

## Driving it with verify-opensession

Preconditions:

- Doctor passes for the isolated demo run.
- The demo issue cache contains four synthetic issues, including `Dark mode: due-date chips lose contrast`.

- **Open the list.** Run `verify-opensession browser "$RUN_ID" open --route /issues --width 1440 --height 900`, then wait for searchbox `Search issues`. Take a snapshot after the loading state clears. The page shows four issues grouped by update date.
- **Search.** Run `verify-opensession browser "$RUN_ID" fill --role searchbox --name "Search issues" --value "contrast"`. The list narrows to `Dark mode: due-date chips lose contrast`.
- **Preview an issue.** Clear the search, take a fresh snapshot, and choose one issue row using its full current accessible name. A responsive dialog shows the issue title, body, metadata, and either `Start session` or the existing session action.
- **Scope by repository.** When the seed or test state contains more than one repository, choose the repository menu and confirm only that repository's issues remain. With the default one-repository seed, record this control as unreachable because the UI intentionally omits it.
- **Check phone layout.** Reopen `/issues` at 390x844, search for `contrast`, and open the result. Search and dialog actions remain reachable without desktop hover.
- **Proof.** Capture the loaded list, filtered list, issue preview, and phone view. If starting a session is in scope, reopen it from the issue and confirm the new session through `/api/sessions`.

## Gotchas

- Issues come from the in-memory GitHub issue cache. The demo launcher seeds synthetic rows and does not call GitHub.
- Search is read-only and does not prove preview or session behavior.
- The repository menu appears only when the list contains more than one repository.
- Starting a session crosses into engine execution. The isolated demo disables execution, so do not claim a successful model turn.
- Issue-row accessible names include repository initials, title, number, state, comments, and age. Take a current snapshot instead of copying an old full name.
