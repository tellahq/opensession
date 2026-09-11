/**
 * The SQL an agent may run against an Open Session database.
 *
 * bun:sqlite has no authorizer hook, so the statements are screened here
 * before they reach a connection. The screen is a small tokenizer, not a
 * parser: it walks the text skipping string literals, quoted identifiers and
 * comments, and looks at the bare words that remain. That is enough to refuse
 * the few statements that reach outside the database file:
 *
 * - ATTACH / DETACH name another file on disk.
 * - VACUUM INTO writes a copy to a path of the caller's choosing.
 * - PRAGMA can change how the file is handled (journal, page count, the
 *   size cap this store sets). A short allowlist of read-only schema
 *   pragmas stays open, plus `foreign_keys`, which is per connection and
 *   harmless.
 *
 * Reads run on a read-only connection, so a write hidden in a `query` call
 * fails in SQLite itself; the screen additionally refuses a read that holds
 * more than one statement, because bun:sqlite compiles only the first and
 * silently drops the rest, which would make `SELECT 1; DROP TABLE t` look
 * like a harmless SELECT.
 */

export class DatabaseSqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseSqlError";
  }
}

/** Pragmas that only read schema or set a per-connection flag. */
const ALLOWED_PRAGMAS = new Set([
  "table_info",
  "table_xinfo",
  "table_list",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
  "foreign_keys",
  "foreign_key_check",
  "integrity_check",
  "quick_check",
  "user_version",
  "schema_version",
  "page_size",
  "page_count",
  "freelist_count",
  "database_list",
  "collation_list",
  "function_list",
  "compile_options",
]);

const FORBIDDEN_WORDS = new Set(["attach", "detach", "load_extension"]);

/** The maximum text one statement or script may carry. */
export const MAX_SQL_BYTES = 256 * 1024;

interface Token {
  word: string;
  /** True for a bare word (keyword or identifier); false for punctuation. */
  bare: boolean;
}

/**
 * Bare words and statement-level punctuation, with literals, quoted
 * identifiers and comments removed. Words are lower-cased; quoted identifiers
 * become an empty placeholder so `"attach"` as a column name is not a word.
 */
export function tokenizeSql(sql: string): Token[] {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    // Line comment.
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    // Block comment. An unterminated one swallows the rest, as SQLite does.
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // String literal; a doubled quote is an escaped quote.
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      tokens.push({ word: "", bare: false });
      continue;
    }
    // Quoted identifiers: "..." (doubled quote escapes), `...`, [...]
    if (c === '"' || c === "`") {
      i++;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      tokens.push({ word: "", bare: false });
      continue;
    }
    if (c === "[") {
      const end = sql.indexOf("]", i + 1);
      i = end === -1 ? n : end + 1;
      tokens.push({ word: "", bare: false });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      tokens.push({ word: sql.slice(i, j).toLowerCase(), bare: true });
      i = j;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // Any other single character (;, (, ), =, digits, parameters...).
    tokens.push({ word: c, bare: false });
    i++;
  }
  return tokens;
}

/** Count statements: top-level semicolons, ignoring a trailing one. */
function statementCount(tokens: Token[]): number {
  // Triggers hold semicolons inside BEGIN ... END; count those as one
  // statement by tracking trigger bodies.
  let count = 0;
  let sawContent = false;
  let inTriggerBody = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.bare && token.word === "trigger") {
      // The body starts at the next BEGIN.
      inTriggerBody = true;
    }
    if (inTriggerBody && token.bare && token.word === "end") {
      inTriggerBody = false;
      sawContent = true;
      continue;
    }
    if (token.word === ";" && !inTriggerBody) {
      if (sawContent) count++;
      sawContent = false;
      continue;
    }
    sawContent = true;
  }
  if (sawContent) count++;
  return count;
}

/**
 * Refuse SQL that reaches outside the file. Throws DatabaseSqlError with a
 * message the agent can act on; returns the trimmed SQL otherwise.
 */
export function guardSql(
  sql: string,
  options: { readOnly?: boolean } = {},
): string {
  const text = (sql ?? "").trim();
  if (!text) throw new DatabaseSqlError("SQL is empty");
  if (Buffer.byteLength(text, "utf8") > MAX_SQL_BYTES)
    throw new DatabaseSqlError(
      `SQL is too long (more than ${MAX_SQL_BYTES} bytes); split it into smaller calls`,
    );
  const tokens = tokenizeSql(text);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.bare) continue;
    if (FORBIDDEN_WORDS.has(token.word))
      throw new DatabaseSqlError(
        `${token.word.toUpperCase()} is not allowed: a database is one file and cannot reach others`,
      );
    if (token.word === "vacuum") {
      const next = tokens[index + 1];
      if (next?.bare && next.word === "into")
        throw new DatabaseSqlError(
          "VACUUM INTO is not allowed: use the export action to copy a database",
        );
    }
    if (token.word === "pragma") {
      const next = tokens[index + 1];
      const name = next?.bare ? next.word : "";
      if (!ALLOWED_PRAGMAS.has(name))
        throw new DatabaseSqlError(
          name
            ? `PRAGMA ${name} is not allowed here; describe_database reports the schema`
            : "PRAGMA needs a name",
        );
    }
  }
  if (options.readOnly && statementCount(tokens) > 1)
    throw new DatabaseSqlError(
      "A query runs one statement; use execute for a script",
    );
  return text;
}

/** SQLite identifier quoting for table and column names built server-side. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
