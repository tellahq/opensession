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
- The demo starts with no archived sessions. First open `/session/bks-demo-cancelled` at desktop width, choose `More actions`, then choose menu item `Archive session Ctrl+Shift+A`. Open `/archived`, choose `Owner, My archived`, and select `Everyone` so the session created by Alex is visible. If it is still absent, record the archive mutation as a product gap and mark result opening and restoration unreachable.

- **Open the index.** Run `verify-opensession browser "$RUN_ID" open --route /archived --width 1440 --height 900`. Wait for searchbox `Search archived sessions` and capture the unfiltered state.
- **Search.** Run `verify-opensession browser "$RUN_ID" fill --role searchbox --name "Search archived sessions" --value "date"`. The visible results narrow to `Refactor date helpers into shared/`.
- **Clear and filter.** Refill the searchbox with an empty value. Use the separate owner, repository, or reason picker that is visible in the current snapshot, then capture the picker state and narrowed result list. Owner is always available.
- **Open a result.** Choose `Refactor date helpers into shared/`. Its transcript opens and keeps the archived state visible.
- **Restore.** From `/archived`, choose button `Restore session` on the disposable demo result. Confirm it disappears from the matching archived results and reappears in its active workspace or `/api/sessions` response.
- **Check phone layout.** Repeat search and result opening at 390x844. Search and filters must remain reachable without desktop hover.
- **Proof.** Capture unfiltered, filtered, and resulting states. For restore behavior, save a read-only session API response after the UI action.

## Gotchas

- Searching is read-only. It does not prove restore behavior.
- A session may be hidden by archive reason or current-person defaults. Record active filters in proof.
- There is no combined Filters button. Repository appears only when archived results span more than one repository, and reason appears only when an auto-archived result exists. Take a fresh snapshot before choosing a picker.
- Restoring mutates disposable demo state. Run it last if later checks depend on the seeded archive list.
- Opening a direct session URL does not prove the archived index entry point.
