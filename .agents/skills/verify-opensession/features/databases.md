# Databases

Databases are named SQLite stores that sessions and automations can keep outside a repository. Users create and inspect them, browse tables, run read-only queries, rename or download them, and delete them.

## Sub-features

- `database-list` shows each database, its size and table count, and recent activity.
- `database-create` creates an empty named database with an optional description.
- `database-detail` opens metadata and available tables.
- `database-rows` browses, sorts, pages, and downloads table rows.
- `database-query` runs a read-only SQL query and renders its rows.
- `database-manage` renames, downloads, or deletes a database.
- `database-phone` splits the list and detail into separate phone pages.

## How to get to it (user POV)

- Choose `Databases` in the sidebar tools.
- Open `/databases` or a shared `/databases/<databaseId>` link.
- Open a session's Databases workspace panel to see databases last changed by that session.
- Choose a database row to inspect its tables, rows, and query view.

## Driving it with verify-opensession

Preconditions:

- Doctor passes for the isolated demo run.
- The demo starts without a database. Set `DATABASE_NAME="Verification database $RUN_ID"` for the disposable mutation.

- **Create a database.** Open `/databases` at 1440x900, wait for `New database`, and choose it. In dialog `New database`, fill `Name` with `$DATABASE_NAME` and `Description` with `Created by the isolated verification pass.`, then choose `Create`.
- **Confirm persistence.** Run `verify-opensession api "$RUN_ID" /api/databases | jq --arg name "$DATABASE_NAME" '.databases[] | select(.name == $name)'`. Require one result with the entered description, save its ID, and reopen `/databases/<databaseId>`.
- **Inspect empty rows.** The detail shows `No tables yet`, because the web form creates an empty database. Table creation and writes belong to session and automation tools rather than this form.
- **Run a read-only query.** Choose `Query`, fill textbox `SQL query` with `SELECT 1 AS verified`, and choose `Run`. The grid shows one row whose `verified` value is `1`.
- **Check phone navigation.** Open `/databases` at 390x844 and choose the saved database row. Its detail has a visible `Databases` back action. Use it to return to the list.
- **Proof.** Capture the empty list, filled create form, saved detail, query result, phone list, and phone detail. Save the matching `/api/databases` object.

## Gotchas

- The create form makes an empty database. Do not expect a table until a session or automation creates one through the database tools.
- The query editor rejects writes, attached databases, and unsafe SQLite operations. Use it only for read-only proof.
- Downloads are browser actions. A click does not prove the downloaded file contents unless the file is inspected separately.
- A database can belong to an automation, and its latest writer can link to a session. The empty verification database has neither relationship.
- Cleanup removes the database with the disposable state directory but leaves evidence.
