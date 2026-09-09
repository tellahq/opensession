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
import { chmodSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { UnifiedSession } from "./types";

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
  }

  upsert(session: UnifiedSession): void {
    this.write(session);
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
  }

  get(id: string): UnifiedSession | null {
    const row = this.db
      .query("SELECT payload FROM session_list WHERE id = ?")
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
  listVisibilityGroup(session: UnifiedSession): UnifiedSession[] {
    const rows = new Map<string, UnifiedSession>([[session.id, session]]);
    // Live siblings only: the sidebar scopes its live slice, so an archived
    // sibling must not lend ownership or attention to this row.
    const members = session.workspaceId
      ? (this.db
          .query(
            "SELECT payload FROM session_list WHERE workspace_id = ? AND archived = 0",
          )
          .all(session.workspaceId) as StoredRow[])
      : session.worktreeDir?.includes("/worktrees/")
        ? (this.db
            .query(
              "SELECT payload FROM session_list WHERE worktree_dir = ? AND archived = 0",
            )
            .all(session.worktreeDir) as StoredRow[])
        : [];
    for (const member of decodeRows(members)) rows.set(member.id, member);
    const seen = new Set<string>();
    let parentId = session.parentSessionId;
    while (parentId && !seen.has(parentId) && seen.size < 16) {
      seen.add(parentId);
      const parent = rows.get(parentId) ?? this.get(parentId);
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
  ): { session: UnifiedSession; group: UnifiedSession[] } | null {
    const session = this.get(id);
    return session
      ? { session, group: this.listVisibilityGroup(session) }
      : null;
  }

  setArchived(id: string, archived: boolean, reason?: string): void {
    const row = this.db
      .query("SELECT payload FROM session_list WHERE id = ?")
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

  count(): number {
    const row = this.db
      .query("SELECT count(*) AS n FROM session_list")
      .get() as {
      n: number;
    };
    return Number(row?.n || 0);
  }

  list(slice: SessionListSlice = "include"): UnifiedSession[] {
    const where =
      slice === "include"
        ? ""
        : slice === "only"
          ? "WHERE archived = 1"
          : "WHERE archived = 0";
    const rows = this.db
      .query(
        `SELECT payload FROM session_list ${where} ORDER BY last_activity_ms DESC, id`,
      )
      .all() as StoredRow[];
    return decodeRows(rows);
  }

  /** `list(slice)` when the slice has coverage, else null. */
  listCovered(slice: SessionListSlice): UnifiedSession[] | null {
    return this.hasCoverage(slice) ? this.list(slice) : null;
  }

  /** Live rows on any of `branches`. PR state changes fan out to exactly
   * these rows instead of telling every client to refetch its list. */
  listLiveByBranch(branches: string[]): UnifiedSession[] {
    if (!branches.length) return [];
    const rows = this.db
      .query(
        `SELECT payload FROM session_list
         WHERE archived = 0 AND branch IN (${branches.map(() => "?").join(", ")})`,
      )
      .all(...branches) as StoredRow[];
    return decodeRows(rows);
  }

  /** `listLiveByBranch` when the live slice has coverage, else null: without
   * coverage a branch lookup could miss rows. */
  listLiveByBranchCovered(branches: string[]): UnifiedSession[] | null {
    return this.hasCoverage("exclude") ? this.listLiveByBranch(branches) : null;
  }

  /** Every materialized member of one known workspace, live or archived. */
  listWorkspaceMembers(workspaceId: string): UnifiedSession[] {
    const rows = this.db
      .query(
        `
        SELECT payload FROM session_list
        WHERE workspace_id = ?
        ORDER BY last_activity_ms DESC
      `,
      )
      .all(workspaceId) as StoredRow[];
    return decodeRows(rows);
  }

  listWorkspace(
    workspaceId: string,
    worktreeDir?: string | null,
  ): UnifiedSession[] {
    const isolatedWorktree = worktreeDir?.includes("/worktrees/")
      ? worktreeDir
      : null;
    const rows = isolatedWorktree
      ? (this.db
          .query(
            `
						SELECT payload FROM session_list
						WHERE archived = 1 AND (workspace_id = ? OR worktree_dir = ?)
						ORDER BY last_activity_ms DESC
					`,
          )
          .all(workspaceId, isolatedWorktree) as StoredRow[])
      : (this.db
          .query(
            `
						SELECT payload FROM session_list
						WHERE workspace_id = ? AND archived = 1
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
  ): UnifiedSession[] | null {
    return this.hasCoverage("only")
      ? this.listWorkspace(workspaceId, worktreeDir)
      : null;
  }

  /** Workspace ids that can produce a live sidebar row, without decoding the
   * session payloads behind them. */
  activeWorkspaceIds(): string[] {
    return (
      this.db
        .query(
          "SELECT DISTINCT workspace_id FROM session_list WHERE archived = 0 AND workspace_id IS NOT NULL",
        )
        .all() as Array<{ workspace_id: string }>
    ).map((row) => row.workspace_id);
  }

  /** `activeWorkspaceIds` when the live slice has coverage, else null. */
  activeWorkspaceIdsCovered(): string[] | null {
    return this.hasCoverage("exclude") ? this.activeWorkspaceIds() : null;
  }

  /**
   * Return every human-created live row and only the useful automation tail.
   * Ranking and counting stay inside SQLite, so JavaScript never parses the
   * thousands of automation payloads a collapsed sidebar cannot display.
   */
  listSidebar(selectedSessionId?: string): UnifiedSession[] {
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
					WHERE archived = 0 AND automation IS NOT NULL
				), selected AS (
					SELECT payload, last_activity_ms, NULL AS automation_run_count
					FROM session_list
					WHERE archived = 0 AND automation IS NULL
					UNION ALL
					SELECT payload, last_activity_ms, automation_run_count
					FROM ranked_automation
					WHERE automation_rank <= 5 OR is_running = 1
						OR waiting_for_input = 1 OR manual_status IS NOT NULL OR id = ?
					UNION ALL
					SELECT payload, last_activity_ms, NULL AS automation_run_count
					FROM session_list
					WHERE archived = 1 AND id = ?
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
  listSidebarCovered(selectedSessionId?: string): UnifiedSession[] | null {
    return this.hasCoverage("exclude")
      ? this.listSidebar(selectedSessionId)
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
