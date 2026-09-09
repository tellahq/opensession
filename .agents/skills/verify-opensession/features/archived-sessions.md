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
- Archive one disposable demo workspace first. Open `/session/bks-demo-failed`, choose `More actions`, then choose the `Archive workspace` menu item. The seed itself has no archived rows.

- **Open the index.** Run `verify-opensession browser "$RUN_ID" open --route /archived --width 1440 --height 900`. Wait for `searchbox` named `Search archived sessions`. The page defaults to `My archived`, while seeded work belongs to a synthetic person. Open `Owner, My archived` and choose `Everyone` before capturing the row.
- **Search.** Run `verify-opensession browser "$RUN_ID" fill --role searchbox --name "Search archived sessions" --value "memory"`. The visible results narrow to `Investigate memory spike in export worker`.
- **Clear and filter.** Refill the searchbox with an empty value. Owner, repository, and reason are separate buttons whose accessible names include their current values, such as `Owner, Everyone`. Select one visible value and capture the narrowed result list.
- **Open a result.** Choose a visible archived session title. Its transcript opens and keeps the archived state visible.
- **Restore.** From `/archived`, choose `Restore session` on one disposable demo result. Confirm it disappears from the matching archived results and reappears in its active workspace or `/api/sessions` response.
- **Check phone layout.** Repeat search and result opening at 390x844. Search and filters must remain reachable without desktop hover. A result button's accessible name also includes its person and relative time, so take a current snapshot before clicking it.
- **Proof.** Capture unfiltered, filtered, and resulting states. For restore behavior, save a read-only session API response after the UI action.

## Gotchas

- Searching is read-only. It does not prove restore behavior.
- A session may be hidden by archive reason or current-person defaults. Record active filters in proof.
- The filter button's accessible name includes the active-filter count. Take a fresh snapshot after each change.
- Restoring mutates disposable demo state. Run it last if later checks depend on the seeded archive list.
- Opening a direct session URL does not prove the archived index entry point.
