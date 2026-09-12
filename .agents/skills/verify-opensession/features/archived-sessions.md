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
- Open a session's `More actions` menu and choose `Archive workspace` to put its disposable workspace in the archive.
- Choose an archived result to inspect it, or its restore action to return it.

## Driving it with verify-opensession

Preconditions:

- Doctor passes for the isolated demo run.
- The demo seed has finished and cancelled sessions that are safe to archive, but starts with no archived sessions.
- Before opening the index, open `/session/bks-demo-cancelled`, choose `More actions`, then choose `Archive workspace`.

- **Open the index.** Run `verify-opensession browser "$RUN_ID" open --route /archived --width 1440 --height 900`. Wait for `searchbox` named `Search archived sessions`. The default `My archived` owner filter may hide the seeded session because its synthetic owner is Alex. If so, open `Owner, My archived` and choose `Everyone`, then capture the unfiltered state.
- **Search.** Run `verify-opensession browser "$RUN_ID" fill --role searchbox --name "Search archived sessions" --value "date helpers"`. The visible results narrow to `Refactor date helpers into shared/`.
- **Clear and filter.** Refill the searchbox with an empty value. Use the current snapshot to choose a visible owner, repository, or archive-reason picker, then select one option. Capture the picker state and narrowed result list.
- **Open a result.** Choose the result button whose accessible name starts with `Refactor date helpers into shared/`. Its transcript opens with an `Unarchive` action on desktop and an `Archived` marker on phone.
- **Check phone layout.** Before restoring, repeat search and result opening at 390x844. Search and pickers must remain reachable without desktop hover. Phone result names include their source, owner, and relative time, so take a fresh snapshot instead of guessing the full name.
- **Restore.** From `/archived` at desktop width, choose `Restore session` on the disposable result. Confirm it disappears from the matching archived results and reappears in its active workspace or `/api/sessions` response.
- **Proof.** Capture unfiltered, filtered, and resulting states. For restore behavior, save a read-only session API response after the UI action.

## Gotchas

- Searching is read-only. It does not prove restore behavior.
- A session may be hidden by archive reason or current-person defaults. Record active filters in proof.
- Picker accessible names include their current values, such as `Owner, Everyone`. Take a fresh snapshot after each change.
- Archiving and restoring mutate disposable demo state. Run restore last because the seed does not start with an archived result.
- Opening a direct session URL does not prove the archived index entry point.
