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
- Create one archived result through the UI because the demo seed starts with no archived sessions. Open `/session/bks-demo-live`, choose `More actions`, choose menu item `Archive session Ctrl+Shift+A`, then confirm with `Close anyway ⌘↵`. This cancels only the synthetic running state in the disposable demo.

- **Open the index.** Run `verify-opensession browser "$RUN_ID" open --route /archived --width 1440 --height 900`. Wait for `searchbox` named `Search archived sessions`. The page defaults to `My archived`, while the seeded session belongs to Alex, so open `Filters, 1 active` and choose `Everyone` before capturing the unfiltered result.
- **Search.** Run `verify-opensession browser "$RUN_ID" fill --role searchbox --name "Search archived sessions" --value "tracing"`. The visible results narrow to `Instrument request tracing in api-gateway`. Use an unmatched value to capture the explicit no-results state.
- **Clear and filter.** Refill the searchbox with an empty value, choose the `Filters` button using the exact accessible name from the current snapshot, and select one visible repository or person. Capture the filter state and narrowed result list.
- **Open a result.** Choose the button whose name starts with `Instrument request tracing in api-gateway`. Its transcript opens and keeps the archived state visible.
- **Restore.** From `/archived`, choose `Restore session` on desktop or `Restore` on phone. Confirm it disappears from `/api/sessions?archived=only&slim=1` and reappears in its active workspace.
- **Check phone layout.** Repeat search and result opening at 390x844. Select `Everyone` again because reopening the route resets the owner filter. Search and filters must remain reachable without desktop hover.
- **Proof.** Capture unfiltered, filtered, and resulting states. For restore behavior, save a read-only session API response after the UI action.

## Gotchas

- Searching is read-only. It does not prove restore behavior.
- A session may be hidden by archive reason or current-person defaults. Record active filters in proof.
- The filter button's accessible name includes the active-filter count. Take a fresh snapshot after each change.
- Archiving and restoring mutate disposable demo state. Restore the session last so the drive leaves no archived residue.
- Opening a direct session URL does not prove the archived index entry point.
