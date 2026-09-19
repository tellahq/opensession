# Databases

Databases are named SQLite files that sessions and automations keep outside a repository. Users create, rename, query, download, and delete them, inspect tables and rows, and return to the session that last wrote one.

## Sub-features

- `database-list` shows each database with its table count, size, and last update.
- `database-create` saves a name and optional description.
- `database-detail` opens a shared `/databases/<id>` route and exposes metadata and file actions.
- `database-rows` selects a table, sorts and pages rows, and downloads CSV.
- `database-query` runs read-only SQL and renders rows or an error.
- `database-phone` separates the list and detail into pages with a visible back action.

## How to get to it (user POV)

- Enable `Show Databases in sidebar` under Preferences, then choose `Databases` in the sidebar.
- Open `/databases` or a shared `/databases/<id>` link.
- Open a database named by a session from that session's Databases panel.
- Use the command menu and choose `Databases`.

## Driving it with verify-opensession

Preconditions:

- Doctor passes for the isolated demo run.
- Set `DATABASE_NAME="Verification database $RUN_ID"` so this run's mutation is unambiguous.

- **Open the list.** Run `verify-opensession browser "$RUN_ID" open --route /databases --width 1440 --height 900`. An empty run shows `No databases yet` and `New database`; a populated run shows the `Databases` heading and rows.
- **Create a database.** Choose `New database`, wait for `dialog` named `New database`, fill textboxes `Name` and `Description`, and choose `Create`. The detail view opens and the list contains the saved name.
- **Confirm persistence.** Run `verify-opensession api "$RUN_ID" /api/databases | jq --arg name "$DATABASE_NAME" '.databases[] | select(.name == $name)'`. Require one matching object, then reopen `/databases/<id>`.
- **Inspect data.** A database with tables opens in `Rows`. Choose a table and capture its grid. Choose `Query`, fill textbox `SQL query` with a read-only statement, choose `Run`, and capture the result. For a newly created empty database, capture the explicit `No tables yet` state instead.
- **Check phone layout.** Open `/databases/<id>` at 390x844. The saved detail appears with a `Databases` back button. Use it to return to the list when list navigation is in scope.
- **Proof.** Save the empty or populated list, filled create form, saved detail, matching API object, and phone detail as snapshots and screenshots.

## Gotchas

- `/api/databases` returns an object with a `databases` array, not a bare array.
- Queries are read-only. Use sessions or database tools to change tables and rows; do not treat a rejected write statement as a broken query view.
- A new empty database proves creation and detail persistence, not row browsing, sorting, paging, CSV, or query results.
- Downloads require a filesystem check in addition to a click if they are in scope.
- Delete only a database created in the disposable run. Cleanup removes its state but leaves evidence.
