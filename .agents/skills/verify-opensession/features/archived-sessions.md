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
- The archived index contains at least one disposable row. Check with `verify-opensession api "$RUN_ID" '/api/sessions?archived=only&slim=1' | jq .`. If it is empty, report the archive list, filters, opening, and restore checks as unreachable because the isolated seed supplied no archived row. Do not create archive state through an internal endpoint.

- **Open the index.** Run `verify-opensession browser "$RUN_ID" open --route /archived --width 1440 --height 900`. Wait for `searchbox` named `Search archived sessions` and capture the unfiltered state.
- **Search.** Run `verify-opensession browser "$RUN_ID" fill --role searchbox --name "Search archived sessions" --value "retry"`. The visible results narrow to archived work matching `retry`, or an explicit no-results state appears if the seed's archive rules changed.
- **Clear and filter.** Refill the searchbox with an empty value. Use a current snapshot to choose the individual `Owner, …`, `Repository, …`, or `Reason, …` button, then select one visible option. There is no combined Filters button. Capture the selected control and narrowed list.
- **Open a result.** Choose a visible archived session title. Its transcript opens and keeps the archived state visible.
- **Restore.** From `/archived`, choose `Restore session` on one disposable demo result. Confirm it disappears from the matching archived results and reappears in its active workspace or `/api/sessions` response.
- **Check phone layout.** Repeat search and result opening at 390x844. Search and filters must remain reachable without desktop hover. Restore is a left-swipe row action on phone, not the desktop button.
- **Proof.** Capture unfiltered, filtered, and resulting states. For restore behavior, save a read-only session API response after the UI action.

## Gotchas

- Searching is read-only. It does not prove restore behavior.
- A session may be hidden by archive reason or current-person defaults. Record active filters in proof.
- Each filter button's accessible name includes its selected value. Take a fresh snapshot after each change.
- Restoring mutates disposable demo state. Run it last if later checks depend on the seeded archive list.
- Opening a direct session URL does not prove the archived index entry point.
