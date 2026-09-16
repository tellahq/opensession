/**
 * Materialized SQLite index for session lists: the pure store.
 *
 * Session detail remains authoritative in the owning session file. List
 * requests should never rediscover every session by parsing thousands of JSON
 * files, so this store keeps the already-assembled row plus the columns used
 * to select the small set a client can render.
 *
 * Every method here is synchronous SQLite I/O. The gateway never calls it
 * directly: session-list-worker.ts owns the database on a dedicated Bun
 * Worker thread and session-list-store.ts exposes the same operations as
 * promises. Tests may drive this class in-process. Keep this module free of
 * gateway imports so the worker's import graph stays small.
 */

import { Database } from "bun:sqlite";
import type {
  ScopeFence,
  ScopeDelta,
  ScopeLedgerRow,
} from "./session-kernel/access-ledger";
import { assertAccessPrincipal } from "../shared/access-scope";
import { canonicalizeAccessTable } from "./canonical-access-document";
import { canAccessScope, type AccessPrincipal } from "../shared/access-scope";
import { accessOwnerSql, accessPredicateSql } from "./access-scope-sql";
import { chmodSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { UnifiedSession } from "./types";

export type ScopeReplicaState = ScopeFence & { replica: string };

export type SessionListSlice = "include" | "exclude" | "only";

type StoredRow = {
  payload: string;
  automation_run_count?: number | null;
};

function activityMs(session: UnifiedSession): number {
  const value = Date.parse(session.lastActivity || session.createdAt || "");
  return Number.isFinite(value) ? value : 0;
}

function decodeRows(rows: StoredRow[]): UnifiedSession[] {
  const sessions: UnifiedSession[] = [];
  for (const row of rows) {
    try {
      const session = JSON.parse(row.payload) as UnifiedSession & {
        automationRunCount?: number;
      };
      if (row.automation_run_count != null)
        session.automationRunCount = Number(row.automation_run_count);
      sessions.push(session);
    } catch {
      // A single damaged materialized row must not take down the list. The
      // next targeted write or full rebuild replaces it.
    }
  }
  return sessions;
}

function scopeOwnerPredicate(principal?: AccessPrincipal): string {
  assertAccessPrincipal(principal);
  return principal
    ? `access_owner IN (0, ${principal.githubAccountId})`
    : "access_owner=0";
}

export class SessionListStore {
  private readonly db: Database;
  private readonly upsertStatement;

  constructor(path: string) {
    if (path !== ":memory:") {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(path);
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    // Deploy overlap and maintenance readers can briefly own the WAL writer.
    // Wait for that bounded handoff instead of dropping the targeted session
    // update and leaving its sidebar row stale until a full index rebuild.
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
    this.db.exec(`
			CREATE TABLE IF NOT EXISTS session_list_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS session_list (
				id TEXT PRIMARY KEY,
				source TEXT NOT NULL,
				archived INTEGER NOT NULL,
				last_activity_ms INTEGER NOT NULL,
				workspace_id TEXT,
				worktree_dir TEXT,
				automation TEXT,
				repo TEXT,
				started_by TEXT,
				created_by TEXT,
				desk INTEGER NOT NULL DEFAULT 0,
				is_running INTEGER NOT NULL DEFAULT 0,
				waiting_for_input INTEGER NOT NULL DEFAULT 0,
				manual_status TEXT,
				branch TEXT,
				payload TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_session_list_archive_activity
				ON session_list(archived, last_activity_ms DESC);
			CREATE INDEX IF NOT EXISTS idx_session_list_live_automation_activity
				ON session_list(archived, automation, last_activity_ms DESC)
				WHERE archived = 0;
			CREATE INDEX IF NOT EXISTS idx_session_list_workspace_activity
				ON session_list(workspace_id, archived, last_activity_ms DESC);
			CREATE INDEX IF NOT EXISTS idx_session_list_archive_workspace
				ON session_list(archived, workspace_id)
				WHERE workspace_id IS NOT NULL;
			CREATE INDEX IF NOT EXISTS idx_session_list_worktree_activity
				ON session_list(worktree_dir, archived, last_activity_ms DESC);
			CREATE INDEX IF NOT EXISTS idx_session_list_repo_activity
				ON session_list(repo, archived, last_activity_ms DESC);
			CREATE INDEX IF NOT EXISTS idx_session_list_started_by_activity
				ON session_list(started_by, archived, last_activity_ms DESC);
			CREATE INDEX IF NOT EXISTS idx_session_list_created_by_activity
				ON session_list(created_by, archived, last_activity_ms DESC);
		`);
    if (
      !this.db
        .query("SELECT 1 FROM session_list_meta WHERE key = 'access_json_v1'")
        .get()
    ) {
      this.db
        .transaction(() => {
          canonicalizeAccessTable(this.db, "session_list", "payload");
          this.db.run(
            "INSERT INTO session_list_meta(key, value) VALUES ('access_json_v1', '1')",
          );
        })
        .immediate();
    }
    const scopeColumns = this.db
      .query("PRAGMA table_info(session_list)")
      .all() as Array<{ name: string }>;
    if (!scopeColumns.some((column) => column.name === "access_owner")) {
      this.db
        .exec(`ALTER TABLE session_list ADD COLUMN access_owner INTEGER NOT NULL DEFAULT -1;
        UPDATE session_list SET access_owner = CASE WHEN ${accessPredicateSql("payload")} THEN 0 ELSE -1 END;
        DROP INDEX IF EXISTS idx_session_list_access_owner_activity;`);
    }
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS session_list_scope (id TEXT PRIMARY KEY, canonical_id TEXT NOT NULL, owner INTEGER NOT NULL, deleted INTEGER NOT NULL, generation INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_list_scope_owner ON session_list_scope(owner, deleted, canonical_id, id);
      CREATE TABLE IF NOT EXISTS session_list_alias_claims (row_id TEXT NOT NULL, alias_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(row_id, alias_id));
      CREATE INDEX IF NOT EXISTS idx_list_alias_claims_alias ON session_list_alias_claims(alias_id, row_id);
      CREATE INDEX IF NOT EXISTS idx_session_list_access_owner_activity ON session_list(access_owner, last_activity_ms DESC, id);
      CREATE TEMP VIEW session_list_shared AS SELECT * FROM session_list WHERE access_owner=0;`);
    if (
      !this.db
        .query("SELECT 1 FROM session_list_meta WHERE key='alias_claims_v1'")
        .get()
    ) {
      this.db
        .transaction(() => {
          this.db
            .exec(`INSERT OR IGNORE INTO session_list_alias_claims(row_id, alias_id, position)
          SELECT s.id, j.value, CAST(j.key AS INTEGER) FROM session_list s, json_each(CASE WHEN json_valid(s.payload) THEN s.payload ELSE '{}' END, '$.aliasIds') j WHERE j.type='text';
          INSERT INTO session_list_meta VALUES ('alias_claims_v1','1');`);
        })
        .immediate();
    }
    // `branch` arrived after the first index shipped. Add it in place and drop
    // coverage, so the next rebuild (a catalog page, not a file scan) fills it
    // for every row instead of leaving old rows unmatched by branch.
    const columns = this.db
      .query("PRAGMA table_info(session_list)")
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "branch")) {
      this.db.exec(`
				ALTER TABLE session_list ADD COLUMN branch TEXT;
				DELETE FROM session_list_meta WHERE key LIKE 'covered:%';
			`);
    }
    this.db.exec(`
			CREATE INDEX IF NOT EXISTS idx_session_list_branch
				ON session_list(branch, archived)
				WHERE branch IS NOT NULL;
		`);
    if (path !== ":memory:") {
      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        if (existsSync(file)) chmodSync(file, 0o600);
      }
    }
    this.upsertStatement = this.db.prepare(`
			INSERT INTO session_list (
				id, source, archived, last_activity_ms, workspace_id, worktree_dir,
				automation, repo, started_by, created_by, desk, is_running,
				waiting_for_input, manual_status, branch, payload
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				source = excluded.source,
				archived = excluded.archived,
				last_activity_ms = excluded.last_activity_ms,
				workspace_id = excluded.workspace_id,
				worktree_dir = excluded.worktree_dir,
				automation = excluded.automation,
				repo = excluded.repo,
				started_by = excluded.started_by,
				created_by = excluded.created_by,
				desk = excluded.desk,
				is_running = excluded.is_running,
				waiting_for_input = excluded.waiting_for_input,
				manual_status = excluded.manual_status,
				branch = excluded.branch,
				payload = excluded.payload
		`);
  }

  private write(session: UnifiedSession): void {
    const signals = session as UnifiedSession & { waitingForInput?: boolean };
    this.upsertStatement.run(
      session.id,
      session.source,
      session.archived ? 1 : 0,
      activityMs(session),
      session.workspaceId || null,
      session.worktreeDir || null,
      session.automation || null,
      session.repo || null,
      session.startedBy || null,
      session.createdBy || null,
      session.desk ? 1 : 0,
      session.isRunning ? 1 : 0,
      signals.waitingForInput ? 1 : 0,
      session.manualStatus || null,
      session.branch || null,
      JSON.stringify(session),
    );
    this.db.run("DELETE FROM session_list_alias_claims WHERE row_id=?", [
      session.id,
    ]);
    for (const [position, alias] of (session.aliasIds ?? []).entries()) {
      this.db.run(
        "INSERT OR IGNORE INTO session_list_alias_claims VALUES (?, ?, ?)",
        [session.id, alias, position],
      );
    }
    this.refreshScopeRow(session.id);
  }

  scopeState(): ScopeReplicaState | null {
    const row = this.db
      .query("SELECT value FROM session_list_meta WHERE key='scope_fence'")
      .get() as { value: string } | null;
    const value = row ? JSON.parse(row.value) : null;
    return value && typeof value.replica === "string" ? value : null;
  }

  resetScopeReplica(incarnation: string): void {
    this.db
      .transaction(() => {
        const previous = this.scopeState();
        this.db.exec("DELETE FROM session_list_scope;");
        if (previous)
          this.db.exec(
            "DELETE FROM session_list_meta WHERE key LIKE 'covered:%';",
          );
        if (previous && previous.incarnation !== incarnation)
          this.db.exec(
            "DELETE FROM session_list; DELETE FROM session_list_alias_claims;",
          );
        this.db.run(
          "INSERT OR REPLACE INTO session_list_meta VALUES ('scope_fence', ?)",
          [
            JSON.stringify({
              incarnation,
              generation: 0,
              replica: crypto.randomUUID(),
            }),
          ],
        );
        this.db.exec(
          `UPDATE session_list SET access_owner=CASE WHEN ${accessPredicateSql("payload")} THEN 0 ELSE -1 END`,
        );
      })
      .immediate();
  }

  applyScopeDelta(expected: ScopeReplicaState, delta: ScopeDelta): void {
    this.db
      .transaction(() => {
        const current = this.scopeState();
        if (
          !current ||
          current.incarnation !== expected.incarnation ||
          current.generation !== expected.generation ||
          current.replica !== expected.replica ||
          delta.fence.incarnation !== current.incarnation
        )
          throw new Error("Scope replica changed");
        if (
          delta.rows.length > 1000 ||
          delta.fence.generation < current.generation
        )
          throw new Error("Invalid scope delta");
        let through = current.generation;
        const affected = new Set<string>();
        for (const row of delta.rows) {
          if (
            !Number.isSafeInteger(row.generation) ||
            row.generation <= through ||
            row.generation > delta.fence.generation ||
            !Number.isSafeInteger(row.owner) ||
            row.owner < -1 ||
            !row.id ||
            !row.canonicalId
          )
            throw new Error("Invalid scope row");
          this.db.run(
            "INSERT OR REPLACE INTO session_list_scope VALUES (?, ?, ?, ?, ?)",
            [
              row.id,
              row.canonicalId,
              row.owner,
              row.deleted ? 1 : 0,
              row.generation,
            ],
          );
          through = row.generation;
          affected.add(row.id);
          for (const claim of this.db
            .query(
              "SELECT row_id FROM session_list_alias_claims WHERE alias_id=?",
            )
            .all(row.id) as Array<{ row_id: string }>)
            affected.add(claim.row_id);
          if (affected.size > 10000)
            throw new Error("Scope delta fanout exceeds projection budget");
        }
        for (const id of affected) this.refreshScopeRow(id);
        // Never claim the page's newest clock if later rows were not applied.
        this.db.run(
          "UPDATE session_list_meta SET value=? WHERE key='scope_fence'",
          [
            JSON.stringify({
              incarnation: current.incarnation,
              generation: through,
              replica: current.replica,
            }),
          ],
        );
      })
      .immediate();
  }

  filterScopeIds(ids: string[]): string[] {
    if (ids.length > 1000) throw new Error("Scope identifier batch too large");
    if (!ids.length) return [];
    const scopes = new Map(
      (
        this.db
          .query(
            `SELECT id, owner, deleted FROM session_list_scope WHERE id IN (${ids.map(() => "?").join(",")})`,
          )
          .all(...ids) as Array<{ id: string; owner: number; deleted: number }>
      ).map((row) => [row.id, row]),
    );
    return ids.filter((id) => {
      const scope = scopes.get(id);
      return !scope || (!scope.deleted && scope.owner === 0);
    });
  }

  private personalCoverage(principal?: AccessPrincipal): boolean {
    if (!principal) return true;
    assertAccessPrincipal(principal);
    return !this.db
      .query(`SELECT 1 FROM session_list_scope s LEFT JOIN session_list l ON l.id=s.id
      WHERE s.owner=? AND s.deleted=0 AND s.canonical_id=s.id AND (l.id IS NULL OR l.access_owner<>s.owner) LIMIT 1`)
      .get(principal.githubAccountId);
  }

  private refreshScopeRow(id: string): void {
    const stored = this.db
      .query("SELECT payload FROM session_list WHERE id=?")
      .get(id) as { payload: string } | null;
    if (!stored) return;
    let data: UnifiedSession;
    try {
      data = JSON.parse(stored.payload);
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        data.id !== id
      )
        throw new Error("Invalid session projection");
    } catch {
      this.db.run("UPDATE session_list SET access_owner=-1 WHERE id=?", [id]);
      return;
    }
    const authority = this.db
      .query(
        "SELECT owner, deleted, canonical_id FROM session_list_scope WHERE id=?",
      )
      .get(id) as {
      owner: number;
      deleted: number;
      canonical_id: string;
    } | null;
    const owner = authority
      ? authority.deleted || authority.canonical_id !== id
        ? -1
        : authority.owner
      : canAccessScope(data.accessScope)
        ? 0
        : -1;
    data.accessScope =
      owner === 0
        ? { kind: "shared" }
        : owner > 0
          ? { kind: "personal", ownerGithubAccountId: owner }
          : (null as never);
    const aliases = this.db
      .query(`SELECT c.alias_id FROM session_list_alias_claims c LEFT JOIN session_list_scope s ON s.id=c.alias_id
      WHERE c.row_id=? AND ((s.id IS NULL AND ?=0) OR (s.deleted=0 AND s.owner=? AND (s.canonical_id=? OR s.canonical_id=s.id))) ORDER BY c.position`)
      .all(id, owner, owner, id) as Array<{ alias_id: string }>;
    if (data.aliasIds) data.aliasIds = aliases.map((row) => row.alias_id);
    this.db.run(
      "UPDATE session_list SET access_owner=?, payload=? WHERE id=?",
      [owner, JSON.stringify(data), id],
    );
  }

  upsert(session: UnifiedSession): void {
    this.write(session);
  }

  upsertScopePage(
    sessions: UnifiedSession[],
    expected: ScopeReplicaState,
  ): void {
    this.db
      .transaction(() => {
        const current = this.scopeState();
        if (
          !current ||
          current.incarnation !== expected.incarnation ||
          current.generation !== expected.generation ||
          current.replica !== expected.replica
        )
          throw new Error("Scope changed before projection write");
        this.upsertMany(sessions);
      })
      .immediate();
  }

  upsertMany(sessions: UnifiedSession[]): void {
    this.db.transaction((rows: UnifiedSession[]) => {
      for (const session of rows) this.write(session);
    })(sessions);
  }

  /** One round trip for a rebuild: write the rows, then record coverage. */
  upsertManyCovered(
    sessions: UnifiedSession[],
    slice?: SessionListSlice,
  ): void {
    if (sessions.length) this.upsertMany(sessions);
    if (slice) this.markCovered(slice);
  }

  replaceAll(sessions: UnifiedSession[]): void {
    this.db.transaction((rows: UnifiedSession[]) => {
      this.db.run("DELETE FROM session_list");
      for (const session of rows) this.write(session);
      this.markCovered("include");
    })(sessions);
  }

  markCovered(slice: SessionListSlice): void {
    const slices =
      slice === "include" ? (["include", "exclude", "only"] as const) : [slice];
    for (const covered of slices)
      this.db.run(
        "INSERT OR REPLACE INTO session_list_meta(key, value) VALUES (?, ?)",
        [`covered:${covered}`, String(Date.now())],
      );
  }

  hasCoverage(slice: SessionListSlice): boolean {
    return !!this.db
      .query("SELECT 1 FROM session_list_meta WHERE key = ?")
      .get(`covered:${slice}`);
  }

  remove(id: string): void {
    this.db.run("DELETE FROM session_list WHERE id = ?", [id]);
    this.db.run("DELETE FROM session_list_alias_claims WHERE row_id=?", [id]);
  }

  get(id: string, principal?: AccessPrincipal): UnifiedSession | null {
    const row = this.db
      .query(
        `SELECT payload FROM session_list WHERE id = ? AND ${scopeOwnerPredicate(principal)}`,
      )
      .get(id) as StoredRow | null;
    return row ? (decodeRows([row])[0] ?? null) : null;
  }

  /**
   * The rows a sidebar scope consults to decide one session's visibility:
   * its workspace or worktree group and its parent chain. Group rules
   * (workspace owner, selection, overlays, PR ownership) read siblings and
   * ancestors, so a lone row would be misjudged; the whole list is never
   * needed.
   */
  listVisibilityGroup(
    session: UnifiedSession,
    principal?: AccessPrincipal,
  ): UnifiedSession[] {
    const authorized = this.get(session.id, principal);
    if (!authorized) return [];
    session = authorized;
    const rows = new Map<string, UnifiedSession>([[session.id, session]]);
    // Live siblings only: the sidebar scopes its live slice, so an archived
    // sibling must not lend ownership or attention to this row.
    const members = session.workspaceId
      ? (this.db
          .query(
            `SELECT payload FROM session_list WHERE ${scopeOwnerPredicate(principal)} AND workspace_id = ? AND archived = 0`,
          )
          .all(session.workspaceId) as StoredRow[])
      : session.worktreeDir?.includes("/worktrees/")
        ? (this.db
            .query(
              `SELECT payload FROM session_list WHERE ${scopeOwnerPredicate(principal)} AND worktree_dir = ? AND archived = 0`,
            )
            .all(session.worktreeDir) as StoredRow[])
        : [];
    for (const member of decodeRows(members)) rows.set(member.id, member);
    const seen = new Set<string>();
    let parentId = session.parentSessionId;
    while (parentId && !seen.has(parentId) && seen.size < 16) {
      seen.add(parentId);
      const parent = rows.get(parentId) ?? this.get(parentId, principal);
      if (!parent) break;
      rows.set(parent.id, parent);
      parentId = parent.parentSessionId;
    }
    return [...rows.values()];
  }

  /** One session and its visibility group in one round trip, or null when
   * the index has no row for it (a removed session). */
  getWithVisibilityGroup(
    id: string,
    principal?: AccessPrincipal,
  ): { session: UnifiedSession; group: UnifiedSession[] } | null {
    const session = this.get(id, principal);
    return session
      ? { session, group: this.listVisibilityGroup(session, principal) }
      : null;
  }

  setArchived(
    id: string,
    archived: boolean,
    reason?: string,
    principal?: AccessPrincipal,
  ): void {
    const row = this.db
      .query(
        `SELECT payload FROM session_list WHERE ${scopeOwnerPredicate(principal)} AND id = ?`,
      )
      .get(id) as { payload: string } | null;
    if (!row) return;
    try {
      const session = JSON.parse(row.payload) as UnifiedSession;
      if (archived) {
        session.archived = true;
        if (reason)
          session.archivedReason = reason as UnifiedSession["archivedReason"];
      } else {
        delete session.archived;
        delete session.archivedReason;
      }
      this.write(session);
    } catch {
      this.remove(id);
    }
  }

  count(principal?: AccessPrincipal): number {
    if (!this.personalCoverage(principal))
      throw new Error("Personal scope projection incomplete");
    const row = this.db
      .query(
        `SELECT count(*) AS n FROM session_list WHERE ${scopeOwnerPredicate(principal)}`,
      )
      .get() as {
      n: number;
    };
    return Number(row?.n || 0);
  }

  list(
    slice: SessionListSlice = "include",
    principal?: AccessPrincipal,
  ): UnifiedSession[] {
    const where =
      slice === "include"
        ? ""
        : slice === "only"
          ? "AND archived = 1"
          : "AND archived = 0";
    const rows = this.db
      .query(
        `SELECT payload FROM session_list WHERE ${scopeOwnerPredicate(principal)} ${where} ORDER BY last_activity_ms DESC, id`,
      )
      .all() as StoredRow[];
    return decodeRows(rows);
  }

  /** `list(slice)` when the slice has coverage, else null. */
  listCovered(
    slice: SessionListSlice,
    principal?: AccessPrincipal,
  ): UnifiedSession[] | null {
    return this.hasCoverage(slice) && this.personalCoverage(principal)
      ? this.list(slice, principal)
      : null;
  }

  /** Live rows on any of `branches`. PR state changes fan out to exactly
   * these rows instead of telling every client to refetch its list. */
  listLiveByBranch(
    branches: string[],
    principal?: AccessPrincipal,
  ): UnifiedSession[] {
    if (!branches.length) return [];
    const rows = this.db
      .query(
        `SELECT payload FROM session_list
         WHERE ${scopeOwnerPredicate(principal)} AND archived = 0 AND branch IN (${branches.map(() => "?").join(", ")})`,
      )
      .all(...branches) as StoredRow[];
    return decodeRows(rows);
  }

  /** `listLiveByBranch` when the live slice has coverage, else null: without
   * coverage a branch lookup could miss rows. */
  listLiveByBranchCovered(
    branches: string[],
    principal?: AccessPrincipal,
  ): UnifiedSession[] | null {
    return this.hasCoverage("exclude")
      ? this.listLiveByBranch(branches, principal)
      : null;
  }

  /** Every materialized member of one known workspace, live or archived. */
  listWorkspaceMembers(
    workspaceId: string,
    principal?: AccessPrincipal,
  ): UnifiedSession[] {
    const rows = this.db
      .query(
        `
        SELECT payload FROM session_list
        WHERE ${scopeOwnerPredicate(principal)} AND workspace_id = ?
        ORDER BY last_activity_ms DESC
      `,
      )
      .all(workspaceId) as StoredRow[];
    return decodeRows(rows);
  }

  listWorkspace(
    workspaceId: string,
    worktreeDir?: string | null,
    principal?: AccessPrincipal,
  ): UnifiedSession[] {
    const isolatedWorktree = worktreeDir?.includes("/worktrees/")
      ? worktreeDir
      : null;
    const rows = isolatedWorktree
      ? (this.db
          .query(
            `
						SELECT payload FROM session_list
						WHERE ${scopeOwnerPredicate(principal)} AND archived = 1 AND (workspace_id = ? OR worktree_dir = ?)
						ORDER BY last_activity_ms DESC
					`,
          )
          .all(workspaceId, isolatedWorktree) as StoredRow[])
      : (this.db
          .query(
            `
						SELECT payload FROM session_list
						WHERE ${scopeOwnerPredicate(principal)} AND workspace_id = ? AND archived = 1
						ORDER BY last_activity_ms DESC
					`,
          )
          .all(workspaceId) as StoredRow[]);
    return decodeRows(rows);
  }

  /** `listWorkspace` when the archived slice has coverage, else null. */
  listWorkspaceCovered(
    workspaceId: string,
    worktreeDir?: string | null,
    principal?: AccessPrincipal,
  ): UnifiedSession[] | null {
    return this.hasCoverage("only")
      ? this.listWorkspace(workspaceId, worktreeDir, principal)
      : null;
  }

  /** Workspace ids that can produce a live sidebar row, without decoding the
   * session payloads behind them. */
  activeWorkspaceIds(principal?: AccessPrincipal): string[] {
    return (
      this.db
        .query(
          `SELECT DISTINCT workspace_id FROM session_list WHERE ${scopeOwnerPredicate(principal)} AND archived = 0 AND workspace_id IS NOT NULL`,
        )
        .all() as Array<{ workspace_id: string }>
    ).map((row) => row.workspace_id);
  }

  /** `activeWorkspaceIds` when the live slice has coverage, else null. */
  activeWorkspaceIdsCovered(principal?: AccessPrincipal): string[] | null {
    return this.hasCoverage("exclude")
      ? this.activeWorkspaceIds(principal)
      : null;
  }

  /**
   * Return every human-created live row and only the useful automation tail.
   * Ranking and counting stay inside SQLite, so JavaScript never parses the
   * thousands of automation payloads a collapsed sidebar cannot display.
   */
  listSidebar(
    selectedSessionId?: string,
    principal?: AccessPrincipal,
  ): UnifiedSession[] {
    const rows = this.db
      .query(
        `
				WITH ranked_automation AS (
					SELECT payload, id, last_activity_ms, is_running,
						waiting_for_input, manual_status,
						row_number() OVER (
							PARTITION BY automation
							ORDER BY last_activity_ms DESC, id
						) AS automation_rank,
						count(*) OVER (PARTITION BY automation) AS automation_run_count
					FROM session_list
					WHERE ${scopeOwnerPredicate(principal)} AND archived = 0 AND automation IS NOT NULL
				), selected AS (
					SELECT payload, last_activity_ms, NULL AS automation_run_count
					FROM session_list
					WHERE ${scopeOwnerPredicate(principal)} AND archived = 0 AND automation IS NULL
					UNION ALL
					SELECT payload, last_activity_ms, automation_run_count
					FROM ranked_automation
					WHERE automation_rank <= 5 OR is_running = 1
						OR waiting_for_input = 1 OR manual_status IS NOT NULL OR id = ?
					UNION ALL
					SELECT payload, last_activity_ms, NULL AS automation_run_count
					FROM session_list
					WHERE ${scopeOwnerPredicate(principal)} AND archived = 1 AND id = ?
				)
				SELECT payload, automation_run_count
				FROM selected
				ORDER BY last_activity_ms DESC
			`,
      )
      .all(selectedSessionId || "", selectedSessionId || "") as StoredRow[];
    return decodeRows(rows);
  }

  /** `listSidebar` when the live slice has coverage, else null. */
  listSidebarCovered(
    selectedSessionId?: string,
    principal?: AccessPrincipal,
  ): UnifiedSession[] | null {
    return this.hasCoverage("exclude") && this.personalCoverage(principal)
      ? this.listSidebar(selectedSessionId, principal)
      : null;
  }

  queryPlan(sql: string, ...params: Array<string | number>): string[] {
    return (
      this.db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
        detail: string;
      }>
    ).map((row) => row.detail);
  }

  close(): void {
    this.db.close();
  }
}
