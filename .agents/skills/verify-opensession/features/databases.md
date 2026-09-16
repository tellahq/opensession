# Databases

Databases are named SQLite stores that sessions and automations can keep outside a repository. Users create and manage a database, inspect its schema and rows, download data, and run read-only SQL.

## Sub-features

- `database-list` shows every database with its description, size, table count, and recent activity.
- `database-create` creates an empty named database that a session can later use.
- `database-detail` opens schema and table navigation, linked sessions, and database actions.
- `database-rows` pages and sorts one table's rows.
- `database-query` runs read-only SQL and renders the result grid.
- `database-manage` renames, downloads, or deletes a database.

## How to get to it (user POV)

- Choose `Databases` in the sidebar when that tool is enabled in Preferences.
- Open `/databases` directly.
- Open a shared `/databases/<databaseId>` or `/databases/<databaseId>/<table>` link.
- Open the command menu and choose `Databases`.
- Open a database linked from a session's database pane.

## Driving it with verify-opensession

Preconditions:

- Doctor passes for the isolated demo run.
- Set `DATABASE_NAME="Verification database $RUN_ID"` so the disposable mutation is unambiguous.

- **Open the list.** Run `verify-opensession browser "$RUN_ID" open --route /databases --width 1440 --height 900`. On a fresh run the page says `No databases yet` and offers `New database`.
- **Create one.** Choose `New database`, wait for `dialog` named `New database`, fill textboxes `Name` and `Description`, and choose `Create`. Capture the filled form and resulting detail.
- **Confirm persistence.** Run `verify-opensession api "$RUN_ID" /api/databases | jq --arg name "$DATABASE_NAME" '.databases[] | select(.name == $name)'`. Require one object with the saved description, then reopen its route from the list.
- **Inspect populated data when available.** Choose a table from the detail, change sorting or page through rows, then switch to the query view and run a read-only `SELECT`. Capture both the row grid and result grid. An empty database has no table or query result to prove; report that prerequisite rather than creating schema through an internal shortcut.
- **Check phone layout.** Open `/databases` at 390x844. The bare route stays on the list. Choose the created database, then use the visible back action to return from detail to the list.
- **Proof.** Save before, filled-form, created-detail, API, and phone snapshots and screenshots. For a query, include the SQL and rendered result without exposing sensitive data.

## Gotchas

- The API list response is an object with a `databases` array, not a top-level array.
- The demo starts with no databases. Creating one through the visible dialog is the expected disposable prerequisite.
- Creation proves persistence but not rows or SQL. Those require a database with at least one table, normally populated by a session or automation through its database tools.
- Query mode is read-only. Do not use it to manufacture verification state.
- Downloads are browser side effects; a click alone does not prove the file contents. Inspect the saved file only inside the isolated run when download behavior is in scope.
- Cleanup removes the disposable database with the state directory and keeps evidence.
