# Databases

Databases are named SQLite stores that sessions and automations keep for durable structured data. Users create and manage databases, browse tables and rows, run read-only SQL, and download data.

## Sub-features

- `database-list` shows each database, size, table count, update time, and related automation.
- `database-create` creates and persists an empty named database.
- `database-detail` shows metadata, schema, tables, and paged rows.
- `database-query` runs read-only SQL and renders tabular results.
- `database-manage` renames, downloads, or deletes a database and can open its last session.
- `database-phone` splits the list and selected database into phone-sized pages.

## How to get to it (user POV)

- Enable `Databases` under Preferences → Show in sidebar, then choose it in the sidebar.
- Open `/databases` directly.
- Open `/databases/<databaseId>` or `/databases/<databaseId>/<table>` from a shared link.
- Open a database named in a session's Databases panel.

## Driving it with verify-opensession

Preconditions:

- Doctor passes for the isolated demo run.
- Set `DATABASE_NAME="Verification database $RUN_ID"` so this run's mutation is unambiguous.

- **Open the list.** Run `verify-opensession browser "$RUN_ID" open --route /databases --width 1440 --height 900`. A fresh demo shows `No databases yet` and a `New database` button.
- **Create a database.** Choose `New database`, wait for dialog `New database`, fill textboxes `Name` and `Description`, and choose `Create`. The list and detail view show the new database.
- **Confirm persistence.** Run `verify-opensession api "$RUN_ID" /api/databases | jq --arg name "$DATABASE_NAME" '.databases[] | select(.name == $name)'`. Require one matching object, then reopen `/databases/<id>`.
- **Browse or query data.** When the selected database has a table, choose it in the table selector, inspect its row count and columns, then switch to `Query`, enter a read-only `SELECT`, and run it. An empty database intentionally has no table or query target; record that precondition rather than injecting rows outside the UI.
- **Check phone layout.** Open `/databases` at 390x844 and choose the created database using the full accessible row name from a current snapshot. The detail replaces the list and exposes a visible `Databases` back action.
- **Proof.** Capture the empty or initial list, filled create form, resulting detail, phone list and detail, and the matching `/api/databases` object.

## Gotchas

- `/api/databases` returns an object with a `databases` array, not a bare array.
- The desktop list automatically selects its first database. The phone's bare `/databases` route deliberately remains on the list.
- Database row accessible names include relative update time, table count, and size. Take a fresh snapshot before choosing one.
- Queries from the UI are read-only. Sessions populate databases through MCP tools, which this UI recipe does not prove.
- Downloads use browser attachment navigation. Confirm the named file only when download behavior is in scope; creating a database does not prove export.
- Cleanup removes the created database with the disposable state directory and leaves evidence intact.
