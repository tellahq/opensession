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
- The demo seed has no archived records. Open `/session/bks-demo-cancelled`, choose `More actions`, then choose menu item `Archive session Ctrl+Shift+A`. Require the action to finish before opening the archive. If it remains `Archiving… Ctrl+Shift+A`, run doctor, capture the stuck state, and report the archive feature as unreachable.

- **Open the index.** Run `verify-opensession browser "$RUN_ID" open --route /archived --width 1440 --height 900`. Wait for searchbox `Search archived sessions` and capture the unfiltered state.
- **Search.** Run `verify-opensession browser "$RUN_ID" fill --role searchbox --name "Search archived sessions" --value "date helpers"`. The visible results narrow to the session archived during setup.
- **Clear and filter.** Refill the searchbox with an empty value. The owner picker is named `Owner, My archived`. Repository and reason pickers appear only when the archived records contain more than one repository or an auto-archive reason. Use the exact names from a current snapshot and capture any applicable narrowed state.
- **Open a result.** Choose a visible archived session title. Its transcript opens and keeps the archived state visible.
- **Restore.** From `/archived`, choose `Restore session` on one disposable demo result. Confirm it disappears from the matching archived results and reappears in its active workspace or `/api/sessions` response.
- **Check phone layout.** Repeat search and result opening at 390x844. Search and filters must remain reachable without desktop hover.
- **Proof.** Capture unfiltered, filtered, and resulting states. For restore behavior, save a read-only session API response after the UI action.

## Gotchas

- Searching is read-only. It does not prove restore behavior.
- A session may be hidden by archive reason or current-person defaults. Record active filters in proof.
- Filter controls are separate pickers whose names include their current values. Take a fresh snapshot after each change.
- Restoring mutates disposable demo state. Run it last if later checks depend on the archived setup record.
- Opening a direct session URL does not prove the archived index entry point.
