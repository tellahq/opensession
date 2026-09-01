/**
 * SQLite FTS5 store behind session history search (the Cerebras-KB-inspired
 * "distill, then index lexically with recency decay" design). One row per
 * distilled record — today only sessions, but the row shape is source-generic
 * (source + id + question/summary/resolution/files) so Slack threads, notes or
 * audit events can land in the same index later without a new search surface.
 *
 * Deliberately dependency-light (bun:sqlite + fs only): session-index.ts owns
 * the sweeper/distiller and the runtime singleton; this module must stay
 * importable from tests without dragging in run-rpc or the runner graph.
 *
 * Ranking: FTS5 bm25 (question/resolution weighted above summary/files) times
 * a recency half-life — old sessions describe infrastructure that no longer
 * exists, so when relevance ties, the newer session wins. Queries are quoted
 * per-term (raw error strings full of ':' and '"' must never hit FTS5 query
 * syntax); all-terms-AND first, retry as OR when that finds nothing.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface SearchRecord {
  /** Globally unique: `<source>:<key>` (e.g. "session:bks-..."). */
  id: string;
  source: string;
  /** One-line question an engineer would search for. */
  question: string;
  summary: string;
  resolution: string;
  /** Space-separated file paths / systems touched. */
  files: string;
  repo?: string;
  user?: string;
  pr?: string;
  /** Record timestamp (ms since epoch) — drives recency decay. */
  ts: number;
  /** Source activity timestamp at index time (ms) — staleness check. */
  activityTs: number;
  /** How the record was produced: "llm" distillation or "mech" extraction. */
  distilled: "llm" | "mech";
}

export interface SearchHit extends SearchRecord {
  /** Combined bm25 × recency score (higher is better). */
  score: number;
}

/** Half-life of the recency decay, in days. */
const HALF_LIFE_DAYS = 90;

export class SessionSearchStore {
  private db: Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
			CREATE VIRTUAL TABLE IF NOT EXISTS records USING fts5(
				question, summary, resolution, files,
				id UNINDEXED, source UNINDEXED, repo UNINDEXED, user UNINDEXED,
				pr UNINDEXED, ts UNINDEXED, activity_ts UNINDEXED, distilled UNINDEXED,
				tokenize = 'porter unicode61'
			);
		`);
  }

  upsert(rec: SearchRecord): void {
    this.db.run("DELETE FROM records WHERE id = ?", [rec.id]);
    this.db.run(
      `INSERT INTO records
				(question, summary, resolution, files, id, source, repo, user, pr, ts, activity_ts, distilled)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rec.question,
        rec.summary,
        rec.resolution,
        rec.files,
        rec.id,
        rec.source,
        rec.repo || "",
        rec.user || "",
        rec.pr || "",
        rec.ts,
        rec.activityTs,
        rec.distilled,
      ],
    );
  }

  remove(id: string): void {
    this.db.run("DELETE FROM records WHERE id = ?", [id]);
  }

  /** id → {activityTs, distilled} for the sweeper's skip/upgrade checks. */
  indexState(): Map<string, { activityTs: number; distilled: string }> {
    const rows = this.db
      .query("SELECT id, activity_ts, distilled FROM records")
      .all() as Array<{ id: string; activity_ts: number; distilled: string }>;
    const map = new Map<string, { activityTs: number; distilled: string }>();
    for (const r of rows)
      map.set(r.id, {
        activityTs: Number(r.activity_ts),
        distilled: r.distilled,
      });
    return map;
  }

  count(): number {
    const row = this.db.query("SELECT count(*) AS n FROM records").get() as {
      n: number;
    };
    return row?.n ?? 0;
  }

  search(
    query: string,
    opts: {
      repo?: string;
      limit?: number;
      sinceTs?: number;
      now?: number;
    } = {},
  ): SearchHit[] {
    // Ceiling is generous because the caller folds these rows into pieces of
    // work (session-family.ts) before showing them: a query where one
    // workspace holds every top row must still leave other work to rank.
    const limit = Math.min(Math.max(opts.limit ?? 8, 1), 100);
    const now = opts.now ?? Date.now();
    let rows = this.rawMatch(ftsQuery(query, false), opts.repo);
    // All-terms AND can be too strict for long natural-language queries —
    // retry as any-term OR before giving up (exact multi-token hits still
    // dominate: they match every term and rank above single-term hits).
    if (!rows.length) rows = this.rawMatch(ftsQuery(query, true), opts.repo);
    const hits: SearchHit[] = rows
      .filter((r) => !opts.sinceTs || Number(r.ts) >= opts.sinceTs)
      .map((r) => {
        // FTS5 bm25() is lower-is-better (negative); flip it positive.
        const relevance = Math.max(-r.rank, 0.001);
        const ageDays = Math.max(now - Number(r.ts), 0) / 86_400_000;
        const score = relevance * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
        return {
          id: r.id,
          source: r.source,
          question: r.question,
          summary: r.summary,
          resolution: r.resolution,
          files: r.files,
          repo: r.repo || undefined,
          user: r.user || undefined,
          pr: r.pr || undefined,
          ts: Number(r.ts),
          activityTs: Number(r.activity_ts),
          distilled: r.distilled as "llm" | "mech",
          score,
        };
      });
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  private rawMatch(match: string, repo?: string): RawRow[] {
    if (!match) return [];
    const sql = `
			SELECT question, summary, resolution, files, id, source, repo, user, pr,
			       ts, activity_ts, distilled,
			       bm25(records, 4.0, 2.0, 3.0, 1.5) AS rank
			FROM records
			WHERE records MATCH ?${repo ? " AND repo = ?" : ""}
			ORDER BY rank LIMIT 100`;
    try {
      const params = repo ? [match, repo] : [match];
      return this.db.query(sql).all(...params) as RawRow[];
    } catch {
      // A pathological query string that still upsets FTS5 → no results,
      // never a thrown 500 into the tool/route.
      return [];
    }
  }

  close(): void {
    this.db.close();
  }
}

interface RawRow {
  question: string;
  summary: string;
  resolution: string;
  files: string;
  id: string;
  source: string;
  repo: string;
  user: string;
  pr: string;
  ts: number;
  activity_ts: number;
  distilled: string;
  rank: number;
}

/** Per-term quoting so raw error strings never hit FTS5 query syntax. */
export function ftsQuery(q: string, anyTerm: boolean): string {
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter(Boolean)
    .slice(0, 24)
    .map((t) => `"${t}"`);
  if (!terms.length) return "";
  return terms.join(anyTerm ? " OR " : " ");
}
