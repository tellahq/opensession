# Databases

Databases are named SQLite stores that sessions and automations can keep outside a repository. Users create and inspect databases, browse tables and rows, run read-only queries, download data, rename a database, or delete it.

## Sub-features

- `database-list` shows each database with its description, table count, and size.
- `database-detail` opens metadata, tables, rows, and the query view.
- `database-create` persists an empty named database for later session use.
- `database-query` runs read-only SQL and displays columns and rows.
- `database-export` downloads a table as CSV or the complete SQLite file.
- `database-manage` renames or deletes a database.
- `database-phone` separates the list and detail into navigable phone pages.

## How to get to it (user POV)

- Choose `Databases` in the sidebar when that preference is enabled.
- Open `/databases` or a shared `/databases/<id>` link.
- Open a database linked from a session's Databases panel.
- Choose `New database` from the database list.

## Driving it with verify-opensession

Preconditions:

- Doctor passes for the isolated demo run.
- Set `DATABASE_NAME="Verification database $RUN_ID"` so this run's mutation is unambiguous.

- **Open the list.** Run `verify-opensession browser "$RUN_ID" open --route /databases --width 1440 --height 900`, take a snapshot, and require `Databases` or the `No databases yet` empty state.
- **Create a database.** Choose `New database` and wait for `dialog` named `New database`. Fill textbox `Name` with `$DATABASE_NAME` and textbox `Description` with `Created by the isolated verification pass.`. Capture the filled form, then choose `Create`.
- **Confirm stored state.** Run `verify-opensession api "$RUN_ID" /api/databases | jq --arg name "$DATABASE_NAME" '.databases[] | select(.name == $name)'`. Require one object with the entered description. Set `DATABASE_ID` from that object's `id`, then open `/databases/$DATABASE_ID`. The detail view names the saved database and shows `No tables yet`.
- **Browse or query populated data.** When a database has tables, choose one from `Table`, inspect its row count and columns, then choose `Query`. Enter a read-only `SELECT` in textbox `SQL query`, run it, and capture the result. Do not use browser evaluation or a write query to manufacture proof.
- **Check phone navigation.** Open `/databases/$DATABASE_ID` at 390x844. The detail view has a visible `Databases` back button. Use it to return to the list and reopen the saved row.
- **Proof.** Save list, filled-form, detail, and phone snapshots and screenshots. Save the matching `/api/databases` object as `databases-api.json`.

## Gotchas

- A newly created database has no tables. Creation proves metadata persistence, not row browsing or queries.
- The UI query runner accepts read-only SQL only. Sessions and automations use their MCP tools to create tables or write rows.
- Downloading proves the browser action, not the contents of a database. Pair exports with the visible schema or API metadata.
- Delete is permanent within the disposable run. Perform it last if it is in scope.
- On phone, bare `/databases` is the list and `/databases/<id>` is the detail page.
