# Archived sessions

Archived sessions are removed from active workspace lanes but remain searchable, restorable conversations. Users can search, filter by repository or person, inspect a result, and restore it.

## Sub-features

- `archive-list` groups archived sessions by time and workspace context.
- `archive-search` filters titles, repository, branch, and the person who started the session.
- `archive-filters` narrows results by owner, repository, and archive reason.
- `archive-open` opens a matching archived session without restoring it.
- `archive-restore` returns a session to its active workspace.

## How to get to it (user POV)

- Choose `Archived` in the sidebar.
- Open `/archived` directly.
- Choose `More actions` on an open session and archive it from there, then read it back in the archived index.
- Choose an archived result to inspect it, or its restore action to return it.

## Driving it with verify-opensession

Preconditions:

- Doctor passes for the isolated demo run.
- The demo seed archives nothing: `/archived` opens on `Nothing archived matches.` and `verify-opensession api "$RUN_ID" /api/sessions | jq '[.[] | select(.archived == true)] | length'` reports `0`. Archive one disposable demo session through the UI first.

- **Archive one session.** Open `/session/bks-demo-cancelled`, choose `More actions`, then the menuitem `Archive workspace`. The app returns to the sidebar and `/api/sessions` reports that session with `archived: true`.
- **Open the index.** Run `verify-opensession browser "$RUN_ID" open --route /archived --width 1440 --height 900`. Wait for searchbox `Search archived sessions` (searchbox, not textbox) and capture the unfiltered state.
- **Widen the owner filter.** The index defaults to `Owner, My archived`, and every demo session belongs to `Alex`, so results stay empty for the local viewer. Choose the button `Owner, My archived`, then the menuitemradio `Everyone`. The archived session appears under its time group with a `Restore session` action.
- **Search.** Run `verify-opensession browser "$RUN_ID" fill --role searchbox --name "Search archived sessions" --value "date helpers"`. The result stays visible. Refill with a term that matches nothing to capture the explicit empty state.
- **Open a result.** Choose the result button, named `<title> <owner>`. The session opens on its workspace route, still marked `Archived`, and offers `Unarchive` instead of restoring silently.
- **Restore.** From `/archived`, choose `Restore session` on one disposable demo result. Confirm it disappears from the matching archived results and that `/api/sessions` no longer reports it as archived.
- **Check phone layout.** Repeat search and result opening at 390x844. Search and filters must remain reachable without desktop hover.
- **Proof.** Capture unfiltered, filtered, and resulting states. For restore behavior, save a read-only session API response after the UI action.

## Gotchas

- Searching is read-only. It does not prove restore behavior.
- `My archived` filters by who owns the session, not by who archived it. Record active filters in proof.
- The owner, repository, and reason pickers are separate controls whose accessible names carry the current value (`Owner, Everyone`). The repository picker appears only with more than one archived repository, and the reason picker only once something was auto-archived. Take a fresh snapshot after each change.
- Restoring mutates disposable demo state. Run it last, because it empties the index this run archived into.
- Opening a direct session URL does not prove the archived index entry point.
