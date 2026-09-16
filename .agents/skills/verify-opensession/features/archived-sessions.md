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
- The demo seed contains cancelled session `bks-demo-cancelled`, titled `Refactor date helpers into shared/`, but starts with no archived work.
- Create the disposable prerequisite through the UI: open `/session/bks-demo-cancelled`, choose `More actions`, then choose `Archive workspace`. Do not use an API or internal state setter.

- **Open the index.** Run `verify-opensession browser "$RUN_ID" open --route /archived --width 1440 --height 900`. Wait for `searchbox` named `Search archived sessions`, open `Owner, My archived`, and choose `Everyone` because the seeded session belongs to Alex. Capture the unfiltered state.
- **Search.** Run `verify-opensession browser "$RUN_ID" fill --role searchbox --name "Search archived sessions" --value "Refactor"`. The visible results narrow to `Refactor date helpers into shared/`.
- **Clear and filter.** Refill the searchbox with an empty value. Owner and repository are separate buttons whose names include their current values, such as `Owner, Everyone`; a reason button appears only when auto-archived work exists. Select one available value and capture the narrowed list.
- **Open a result.** Choose the visible archived-session row using its exact accessible name from the current snapshot. Its transcript opens and keeps the archived state visible.
- **Restore.** From `/archived`, choose `Restore session` on the disposable result. Confirm it disappears from the matching archived results and reappears in its active workspace or `/api/sessions` response.
- **Check phone layout.** Repeat owner selection, search, and result opening at 390x844. Search and filters must remain reachable without desktop hover; the row's accessible name includes its relative age on phone.
- **Proof.** Capture unfiltered, filtered, and resulting states. For restore behavior, save a read-only session API response after the UI action.

## Gotchas

- Searching is read-only. It does not prove restore behavior.
- A session may be hidden by archive reason or the default `My archived` owner. Record the active owner, repository, and reason filters in proof.
- Filter controls include their current values in their accessible names. Take a fresh snapshot after each change.
- Restoring mutates disposable demo state. Run it last if later checks depend on the seeded archive list.
- Opening a direct session URL does not prove the archived index entry point.
