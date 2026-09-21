# Databases

Databases are named SQLite stores that sessions and automations can keep and query. Users create and manage databases, inspect schemas and rows, run read-only queries, and download data.

## Sub-features

- `database-list` shows each database with its update time, table count, and size.
- `database-create` creates an empty named database with an optional description.
- `database-detail` shows metadata, schema, tables, and rows.
- `database-query` runs read-only SQL and displays the result.
- `database-manage` renames, downloads, or deletes a database.
- `database-phone` uses separate list and detail pages at phone width.

## How to get to it (user POV)

- Choose `Databases` in the sidebar when the tool is enabled.
- Open `/databases` or a shared `/databases/<id>/<table>` link.
- Use the command menu and choose `Databases`.
- Open a session's Databases panel to follow a database used by that session.

## Driving it with verify-opensession

Preconditions:

- Doctor passes for the isolated demo run.
- Set `DATABASE_NAME="Verification data $RUN_ID"` so the mutation is unambiguous.

- **Open the list.** Run `verify-opensession browser "$RUN_ID" open --route /databases --width 1440 --height 900`. An empty run shows `No databases yet` and `New database`.
- **Create a database.** Choose `New database`, fill textbox `Name` with `$DATABASE_NAME`, fill `Description` with a synthetic description, and choose `Create`.
- **Confirm persistence.** Run `verify-opensession api "$RUN_ID" /api/databases | jq --arg name "$DATABASE_NAME" '.databases[] | select(.name == $name)'`. Require one matching object, then open `/databases/<id>`. The detail view shows the saved name and description plus `Rename`, `Download`, and `Delete`.
- **Inspect data.** `Rows` shows tables and paginated rows. `Query` accepts read-only SQL. An empty database explicitly shows `No tables yet`; do not invent rows through browser evaluation.
- **Check phone layout.** Open `/databases` at 390x844 and choose the created database row. The bare route remains the list; the selected route opens detail with a visible back action.
- **Proof.** Save the empty or initial list, filled create dialog, matching API object, desktop detail, and phone list/detail.

## Gotchas

- The demo seed may contain no database. Creating one through the UI is the expected disposable setup.
- Creating an empty database proves creation and detail rendering, not row browsing or SQL results. Exercise those only when a table already exists through a real session or automation path.
- Query mode is read-only. Data writes belong to the databases tool used by sessions and automations, not browser-side state setters.
- Download actions create browser files. Record the UI action only when download verification is in scope, and remove disposable downloads after the check.
- Cleanup removes the created database with the disposable state directory. It must not remove evidence.
