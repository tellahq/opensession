# Archived sessions

Archived sessions are removed from active workspace lanes but remain searchable, restorable conversations. Users can search, filter by repository or person, inspect a result, and restore it.

## Sub-features

- `archive-list` groups archived sessions by time and workspace context.
- `archive-search` filters titles and transcript metadata.
- `archive-filters` narrows results by repository, person, and archive reason.
- `archive-open` opens a matching archived session without restoring it.
- `archive-restore` returns a session to its active workspace.

## How to get to it (user POV)

- Choose `Archived` at the bottom of the sidebar.
- Open `/archived` directly.
- Open a workspace or session menu and choose its archived-sessions action.
- Choose an archived result to inspect it, or its restore action to return it.

## Driving it with verify-opensession

Preconditions:

- Doctor passes for the isolated demo run.
- The demo seed has active finished and cancelled sessions but no archived rows. Archive disposable session `bks-demo-cancelled` through its `More actions` menu and `Archive workspace` before opening the index.

- **Create a disposable archived row.** Open `/session/bks-demo-cancelled`, choose `More actions`, then choose `Archive workspace`. This archives only that session's disposable workspace and returns to the app.
- **Open the index.** Run `verify-opensession browser "$RUN_ID" open --route /archived --width 1440 --height 900`. Wait for searchbox `Search archived sessions`. The page defaults to `Owner, My archived`, which is empty for the demo's `Local User`. Open that picker and choose `Everyone` before capturing the archived row.
- **Search.** Run `verify-opensession browser "$RUN_ID" fill --role searchbox --name "Search archived sessions" --value "date"`. The visible results narrow to `Refactor date helpers into shared/`.
- **Clear and filter.** Refill the searchbox with an empty value, then take a fresh snapshot. Choose a picker by its current accessible name, such as `Owner, Everyone`, `Repository, All repos`, or `Reason, All`, and select one visible option. Some pickers appear only when the archived data has more than one value. Capture the picker state and narrowed result list.
- **Open a result.** Choose a visible archived session title. Its transcript opens and keeps the archived state visible.
- **Restore.** From `/archived`, choose `Restore session` on one disposable demo result. Confirm it disappears from the matching archived results and reappears in its active workspace or `/api/sessions` response.
- **Check phone layout.** Repeat search and result opening at 390x844. Search and filters must remain reachable without desktop hover.
- **Proof.** Capture unfiltered, filtered, and resulting states. For restore behavior, save a read-only session API response after the UI action.

## Gotchas

- Searching is read-only. It does not prove restore behavior.
- The demo archives belong to seeded teammates, not `Local User`, so the default `My archived` filter is empty. Choose `Everyone` to reach them and record active filters in proof.
- Owner, repository, and reason are separate pickers. Their accessible names include the current value and change after each selection, so a fresh snapshot before the next action.
- Restoring mutates disposable demo state. Run it last if later checks depend on the seeded archive list.
- Opening a direct session URL does not prove the archived index entry point.
