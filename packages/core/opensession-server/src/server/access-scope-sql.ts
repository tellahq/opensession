import {
  assertAccessPrincipal,
  type AccessPrincipal,
} from "../shared/access-scope";

/** Mirrors parseAccessScope for worker-owned JSON projections. CASE guards
 * json_extract from damaged JSON. -1 is never visible; 0 is legacy/shared.
 * Column names are code-owned, not caller-supplied SQL. */
export function accessOwnerSql(column: "doc" | "payload" | "value"): string {
  return `(CASE
    WHEN NOT json_valid(${column}) THEN -1
    WHEN json_type(${column}) != 'object' THEN -1
    WHEN json_type(${column}, '$.accessScope') IS NULL THEN 0
    WHEN json_type(${column}, '$.accessScope') != 'object' THEN -1
    WHEN json_extract(${column}, '$.accessScope.kind') = 'shared'
      AND json_type(${column}, '$.accessScope.ownerGithubAccountId') IS NULL THEN 0
    WHEN json_extract(${column}, '$.accessScope.kind') = 'personal'
      AND json_type(${column}, '$.accessScope.ownerGithubAccountId') = 'integer'
      AND json_extract(${column}, '$.accessScope.ownerGithubAccountId') BETWEEN 1 AND 9007199254740991
      THEN json_extract(${column}, '$.accessScope.ownerGithubAccountId')
    ELSE -1 END)`;
}

/** Omitted callers (background tasks, old clients and unscoped MCP) see only
 * shared data. A principal is an internal capability, not an API body field. */
export function accessPredicateSql(
  column: "doc" | "payload" | "value",
  principal?: AccessPrincipal,
): string {
  assertAccessPrincipal(principal);
  const owner = accessOwnerSql(column);
  // Safe integer validation above makes this a SQL numeric literal, not input.
  return principal
    ? `${owner} IN (0, ${principal.githubAccountId})`
    : `${owner} = 0`;
}
