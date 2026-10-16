import type { Database } from "bun:sqlite";

/** Worker-only JSON boundary. SQLite preserves duplicate keys and chooses the
 * first, while JS chooses the last. Deny ambiguous ownership, then canonicalize
 * numeric encodings and all remaining keys with the application's JSON parser.
 * json_tree is a parser, not a regex over JSON strings or escaped keys. */
export function canonicalAccessDocument(db: Database, doc: string): string {
  let value: unknown;
  try {
    value = JSON.parse(doc);
  } catch {
    return doc;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const ambiguous = db
      .query(`SELECT 1 FROM json_tree(?)
      WHERE (path = '$' AND key = 'accessScope')
         OR (path = '$.accessScope' AND key IN ('kind', 'ownerGithubAccountId'))
      GROUP BY parent, key HAVING count(*) > 1 LIMIT 1`)
      .get(doc);
    if (ambiguous) (value as Record<string, unknown>).accessScope = null;
  }
  return JSON.stringify(value);
}

/** Only the currently opened worker database is migrated. This pages central
 * projections (or one already selected actor), never enumerates actor stores. */
export function canonicalizeAccessTable(
  db: Database,
  table:
    | "session_kernel_metadata"
    | "session_kernel_metadata_catalog"
    | "session_list",
  column: "doc" | "payload",
): void {
  let after: number | null = null;
  while (true) {
    const rows = db
      .query(`SELECT rowid AS id, ${column} AS doc FROM ${table}
      ${after === null ? "" : "WHERE rowid > ?"} ORDER BY rowid LIMIT 256`)
      .all(...(after === null ? [] : [after])) as Array<{
      id: number;
      doc: string;
    }>;
    if (!rows.length) return;
    for (const row of rows) {
      const canonical = canonicalAccessDocument(db, row.doc);
      if (canonical !== row.doc)
        db.run(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`, [
          canonical,
          row.id,
        ]);
      after = row.id;
    }
  }
}
