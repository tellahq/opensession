import { Database } from "bun:sqlite";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  TranscriptStore,
  validateTranscriptAppendReceiptRow,
  type TranscriptAppendReceiptRow,
} from "../transcript-store";
import { SessionKernelStore, sessionKernelSessionDbPath } from "./store";
import { assertTranscriptActorResponse } from "./transcript-protocol";

const TABLES = [
  {
    name: "transcript_events",
    columns: "session_id, seq, uuid, ts, kind, data, full_ref, change_seq",
  },
  {
    name: "transcript_outline",
    columns:
      "session_id, seq, uuid, change_seq, ts, render_role, content_length, review_pr_number",
  },
  {
    name: "transcript_blobs",
    columns: "id, session_id, uuid, data",
  },
  {
    name: "transcript_sessions",
    columns:
      "session_id, next_seq, next_change_seq, reset_change_seq, last_ts, imported_at, import_src, import_watermark",
  },
  {
    name: "transcript_append_receipts",
    columns:
      "session_id, append_id, request_digest, fence_json, result_json, created_at",
  },
] as const;

type TableName = (typeof TABLES)[number]["name"];
type TableTotals = Record<TableName, number>;

export interface TranscriptMigrationResult {
  dryRun: boolean;
  migrated: number;
  adopted: number;
  migratedLegacyKernel: number;
  claimedTranscriptOnly: number;
  sessions: Array<{ sessionId: string; receipt: string }>;
}

function scalar(db: Database, sql: string, ...bindings: any[]): number {
  return Number((db.query(sql).get(...bindings) as { value: number }).value);
}

function emptyTotals(): TableTotals {
  return Object.fromEntries(TABLES.map(({ name }) => [name, 0])) as TableTotals;
}

function sessionTotals(
  db: Database,
  schema: "main" | "source",
  sessionId: string,
): TableTotals {
  const totals = emptyTotals();
  for (const { name } of TABLES)
    totals[name] = scalar(
      db,
      `SELECT COUNT(*) AS value FROM ${schema}.${name} WHERE session_id = ?`,
      sessionId,
    );
  return totals;
}

function sourceInventory(db: Database): Map<string, TableTotals> {
  const inventory = new Map<string, TableTotals>();
  for (const { name } of TABLES) {
    const rows = db
      .query(`
      SELECT session_id, COUNT(*) AS value
      FROM ${name} GROUP BY session_id
    `)
      .all() as Array<{ session_id: string; value: number }>;
    for (const row of rows) {
      const totals = inventory.get(row.session_id) ?? emptyTotals();
      totals[name] = Number(row.value);
      inventory.set(row.session_id, totals);
    }
  }
  return inventory;
}

function addTotals(into: TableTotals, add: TableTotals): void {
  for (const { name } of TABLES) into[name] += add[name];
}

function totalsAreEmpty(totals: TableTotals): boolean {
  return TABLES.every(({ name }) => totals[name] === 0);
}

function verifySourceCoherence(
  db: Database,
  sessionId: string,
  totals = sessionTotals(db, "source", sessionId),
): void {
  const metadata = db
    .query(`
    SELECT next_seq, next_change_seq, reset_change_seq, last_ts, imported_at,
      import_src, import_watermark
    FROM source.transcript_sessions WHERE session_id = ?
  `)
    .all(sessionId) as Array<{
    next_seq: number;
    next_change_seq: number;
    reset_change_seq: number;
    last_ts: number | null;
    imported_at: number | null;
    import_src: string | null;
    import_watermark: number | null;
  }>;
  if (metadata.length === 0 && totalsAreEmpty(totals)) return;
  if (metadata.length !== 1)
    throw new Error(
      `${sessionId} has ${metadata.length} transcript metadata rows`,
    );

  const dense = db
    .query(`
    SELECT COUNT(*) AS count, COUNT(DISTINCT seq) AS distinct_seq,
      COUNT(DISTINCT change_seq) AS distinct_change_seq,
      MIN(seq) AS min_seq, MAX(seq) AS max_seq,
      MIN(change_seq) AS min_change_seq, MAX(change_seq) AS max_change_seq
    FROM source.transcript_events WHERE session_id = ?
  `)
    .get(sessionId) as {
    count: number;
    distinct_seq: number;
    distinct_change_seq: number;
    min_seq: number | null;
    max_seq: number | null;
    min_change_seq: number | null;
    max_change_seq: number | null;
  };
  const row = metadata[0]!;
  const expectedSeq = (dense.max_seq ?? 0) + 1;
  const expectedChange =
    Math.max(dense.max_change_seq ?? 0, row.reset_change_seq) + 1;
  if (
    dense.distinct_seq !== dense.count ||
    dense.distinct_change_seq !== dense.count ||
    (dense.count > 0 &&
      (dense.min_seq! < 1 ||
        dense.min_change_seq! < 1 ||
        dense.max_change_seq! >= row.next_change_seq)) ||
    row.next_seq !== expectedSeq ||
    row.next_change_seq !== expectedChange ||
    row.reset_change_seq < 0 ||
    row.reset_change_seq >= row.next_change_seq
  )
    throw new Error(`${sessionId} transcript sequence metadata is incoherent`);
  if (
    (row.imported_at === null) !== (row.import_src === null) ||
    (row.imported_at === null && row.import_watermark !== null) ||
    (row.imported_at !== null &&
      (!Number.isSafeInteger(row.imported_at) || row.imported_at < 0)) ||
    (row.last_ts !== null &&
      (!Number.isSafeInteger(row.last_ts) || row.last_ts < 0)) ||
    (row.import_watermark !== null &&
      (!Number.isSafeInteger(row.import_watermark) || row.import_watermark < 0))
  )
    throw new Error(`${sessionId} transcript import metadata is incoherent`);

  // The outline was introduced as a lazy projection: an old session may have
  // no rows (or only the pages a client has visited) and the actor store will
  // finish that backfill on demand. Existing rows still must map exactly to a
  // canonical event; orphaned or mismatched projection evidence fails closed.
  const outlineMismatch = scalar(
    db,
    `
    SELECT COUNT(*) AS value FROM (
      SELECT seq, uuid FROM source.transcript_outline WHERE session_id = ?
      EXCEPT
      SELECT seq, uuid FROM source.transcript_events WHERE session_id = ?
    )
  `,
    sessionId,
    sessionId,
  );
  if (outlineMismatch !== 0)
    throw new Error(`${sessionId} transcript outline is incoherent`);

  const blobMismatch = scalar(
    db,
    `
    SELECT COUNT(*) AS value
    FROM source.transcript_blobs blob
    LEFT JOIN source.transcript_events event
      ON event.full_ref = blob.id
     AND event.session_id = blob.session_id
     AND event.uuid = blob.uuid
    WHERE blob.session_id = ? AND event.seq IS NULL
  `,
    sessionId,
  );
  const danglingBlobs = scalar(
    db,
    `
    SELECT COUNT(*) AS value
    FROM source.transcript_events event
    LEFT JOIN source.transcript_blobs blob
      ON blob.id = event.full_ref
     AND blob.session_id = event.session_id
     AND blob.uuid = event.uuid
    WHERE event.session_id = ? AND event.full_ref IS NOT NULL AND blob.id IS NULL
  `,
    sessionId,
  );
  if (blobMismatch !== 0 || danglingBlobs !== 0)
    throw new Error(`${sessionId} transcript blob references are incoherent`);
  const blobs = db
    .query(`
    SELECT data FROM source.transcript_blobs WHERE session_id = ? ORDER BY id
  `)
    .all(sessionId) as Array<{ data: string }>;
  for (const blob of blobs) {
    try {
      assertTranscriptActorResponse(JSON.parse(blob.data));
    } catch {
      throw new Error(
        `${sessionId} transcript blob exceeds the actor read contract`,
      );
    }
  }

  const receipts = db
    .query(`
    SELECT session_id, append_id, request_digest, fence_json, result_json, created_at
    FROM source.transcript_append_receipts WHERE session_id = ?
    ORDER BY append_id
  `)
    .all(sessionId) as TranscriptAppendReceiptRow[];
  for (const receipt of receipts) validateTranscriptAppendReceiptRow(receipt);
}

function verifySession(
  db: Database,
  sessionId: string,
  expectedReceipt: string,
): void {
  const actualReceipt = receiptFor(db, sessionId, "main");
  if (actualReceipt !== expectedReceipt)
    throw new Error(
      `${sessionId} target transcript digest differs from source`,
    );
}

function verifyEmptyTarget(db: Database, sessionId: string): void {
  for (const { name } of TABLES) {
    const count = scalar(db, `SELECT COUNT(*) AS value FROM main.${name}`);
    if (count !== 0)
      throw new Error(
        `Session ${sessionId} empty transcript target contains ${name}`,
      );
  }
  const foreignReceipts = scalar(
    db,
    `SELECT COUNT(*) AS value FROM session_kernel_transcript_migrations
     WHERE session_id <> ?`,
    sessionId,
  );
  if (foreignReceipts !== 0)
    throw new Error(
      `Session ${sessionId} empty transcript target has foreign receipts`,
    );
}

function receiptFor(
  db: Database,
  sessionId: string,
  schema: "main" | "source" = "source",
): string {
  const digest = new Bun.CryptoHasher("sha256");
  digest.update("opensession.actor-transcript-migration.v2\0");
  digest.update(sessionId);
  for (const table of TABLES) {
    const rows = db
      .query(
        `SELECT ${table.columns} FROM ${schema}.${table.name}
       WHERE session_id = ? ORDER BY ${table.columns}`,
      )
      .iterate(sessionId);
    digest.update("[");
    let first = true;
    for (const row of rows) {
      if (!first) digest.update(",");
      digest.update(JSON.stringify(row));
      first = false;
    }
    digest.update("]");
  }
  return `sha256:${digest.digest("hex")}`;
}

function readonlySourceSnapshot(
  sourceTranscriptPath: string,
  centralPath: string,
): { source: Database; snapshotPath: string; close: () => void } {
  let snapshotDir = "";
  try {
    snapshotDir = mkdtempSync(
      join(dirname(centralPath), ".transcript-source-"),
    );
    const snapshotPath = join(snapshotDir, "transcripts.db");
    if (statSync(sourceTranscriptPath).size <= 512 * 1024 * 1024) {
      const original = new Database(sourceTranscriptPath, { readonly: true });
      try {
        // Serialized WAL databases may still require SQLite to create private
        // -shm/-wal companions on macOS even for a readonly connection. The
        // snapshot directory is mode 0700 and has no writers, so keep the file
        // owner-writable rather than making the VFS fail with SQLITE_CANTOPEN.
        writeFileSync(snapshotPath, original.serialize(), { mode: 0o600 });
      } finally {
        original.close();
      }
    } else {
      // Database.serialize() materializes the whole store in one JS buffer and
      // cannot represent production transcript databases above Bun's buffer
      // limit. SQLite streams large snapshots in a short-lived process so its
      // VACUUM VFS state cannot affect later actor WAL opens in this process.
      const vacuum = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `import { Database } from "bun:sqlite";
         const source = new Database(process.argv[1], { readonly: true });
         source.run("VACUUM INTO ?", [process.argv[2]]);
         source.close();`,
          sourceTranscriptPath,
          snapshotPath,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (vacuum.exitCode !== 0)
        throw new Error(
          `Could not snapshot transcript source: ${vacuum.stderr.toString().trim()}`,
        );
      chmodSync(snapshotPath, 0o600);
    }
    // Open the private copy read-write so SQLite's WAL VFS can initialize its
    // companion files on macOS, then enforce query-only semantics at SQL level.
    // No source path or actor target is writable through this handle.
    const source = new Database(snapshotPath);
    source.exec("PRAGMA query_only = ON");
    return {
      source,
      snapshotPath,
      close: () => {
        source.close();
        rmSync(snapshotDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (snapshotDir) rmSync(snapshotDir, { recursive: true, force: true });
    throw error;
  }
}

function createActorDatabaseTemplate(snapshotPath: string): string {
  const templatePath = join(dirname(snapshotPath), "actor-template.sqlite");
  new SessionKernelStore(templatePath).close();
  new TranscriptStore(templatePath).close();
  const template = new Database(templatePath);
  template.exec(
    "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;",
  );
  template.close();
  return templatePath;
}

function initializeActorTarget(targetPath: string, templatePath: string): void {
  if (!existsSync(targetPath)) {
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(templatePath, targetPath);
    chmodSync(targetPath, 0o600);
    return;
  }
  // A failed pre-publication attempt may have left a transcript-only schema 0
  // database. Upgrade it in place before it can become an actor read mirror.
  new SessionKernelStore(targetPath).close();
  new TranscriptStore(targetPath).close();
}

/** Offline, all-at-once authority cutover. The caller must stop the gateway,
 * executor, and actor services before entering. Rollback is permitted only
 * while every actor-owned transcript is still row-for-row equal to the frozen
 * shared source. */
export function rollbackActorTranscriptsOffline(options: {
  centralPath: string;
  sourceTranscriptPath: string;
  isolatedRoot?: string;
}): number {
  const central = new SessionKernelStore(options.centralPath);
  let snapshot: ReturnType<typeof readonlySourceSnapshot>;
  try {
    snapshot = readonlySourceSnapshot(
      options.sourceTranscriptPath,
      options.centralPath,
    );
  } catch (error) {
    central.close();
    throw error;
  }
  const isolatedRoot =
    options.isolatedRoot ??
    `${dirname(options.centralPath)}/session-kernel-sessions`;
  try {
    const sessionIds: string[] = [];
    let after = "";
    while (true) {
      const page = central.actorTranscriptSessionIds(1_000, after);
      sessionIds.push(...page);
      if (page.length < 1_000) break;
      after = page[page.length - 1]!;
    }
    for (const sessionId of sessionIds) {
      const placement = central.sessionPlacement(sessionId)!;
      const target = new Database(
        sessionKernelSessionDbPath(sessionId, isolatedRoot),
      );
      target.exec("PRAGMA query_only = ON");
      try {
        target.run("ATTACH DATABASE ? AS source", [snapshot.snapshotPath]);
        verifySourceCoherence(target, sessionId);
        const expectedReceipt = receiptFor(target, sessionId);
        verifySession(target, sessionId, expectedReceipt);
        const targetReceipt = target
          .query(
            `SELECT receipt FROM session_kernel_transcript_migrations
           WHERE session_id = ?`,
          )
          .get(sessionId) as { receipt: string } | null;
        if (
          placement.transcriptMigrationReceipt !== expectedReceipt ||
          targetReceipt?.receipt !== expectedReceipt
        )
          throw new Error(
            `Session ${sessionId} rollback transcript receipt mismatch`,
          );
        target.exec("DETACH DATABASE source");
      } finally {
        target.close();
      }
    }
    central.rollbackActorTranscriptAuthorities(sessionIds);
    return sessionIds.length;
  } finally {
    snapshot.close();
    central.close();
  }
}

export function migrateActorTranscriptsOffline(options: {
  centralPath: string;
  sourceTranscriptPath: string;
  isolatedRoot?: string;
  dryRun?: boolean;
  /** Test-only assertion seam after the source is attached read-only. */
  afterSourceAttached?: (db: Database) => void;
  /** Test-only crash seam after verified target commit, before catalog publish. */
  beforePublish?: (sessionId: string) => void;
  onProgress?: (progress: {
    completed: number;
    total: number;
    migrated: number;
    adopted: number;
  }) => void;
}): TranscriptMigrationResult {
  const central = new SessionKernelStore(options.centralPath);
  let snapshot: ReturnType<typeof readonlySourceSnapshot>;
  try {
    snapshot = readonlySourceSnapshot(
      options.sourceTranscriptPath,
      options.centralPath,
    );
  } catch (error) {
    central.close();
    throw error;
  }
  const source = snapshot.source;
  const isolatedRoot =
    options.isolatedRoot ??
    `${dirname(options.centralPath)}/session-kernel-sessions`;
  const result: TranscriptMigrationResult = {
    dryRun: options.dryRun === true,
    migrated: 0,
    adopted: 0,
    migratedLegacyKernel: 0,
    claimedTranscriptOnly: 0,
    sessions: [],
  };
  const classifiedTotals = emptyTotals();
  const verified: Array<{ sessionId: string; migrationReceipt: string }> = [];
  let auditDb: Database | undefined;
  try {
    const inventory = sourceInventory(source);
    const sessionIdSet = new Set(inventory.keys());
    let afterSessionId = "";
    while (true) {
      const page = central.transcriptMigrationSessionIds(1_000, afterSessionId);
      for (const sessionId of page) sessionIdSet.add(sessionId);
      if (page.length < 1_000) break;
      afterSessionId = page[page.length - 1]!;
    }
    const sessionIds = [...sessionIdSet].sort();
    const actorTemplatePath = options.dryRun
      ? undefined
      : createActorDatabaseTemplate(snapshot.snapshotPath);

    if (!options.dryRun) {
      const transcriptOnly: string[] = [];
      for (const sessionId of sessionIds) {
        if (
          !central.sessionPlacement(sessionId) &&
          !central.hasSessionDurableState(sessionId)
        )
          transcriptOnly.push(sessionId);
      }
      central.claimIsolatedSessionsForTranscriptMigration(transcriptOnly);
      result.claimedTranscriptOnly = transcriptOnly.length;
    }

    for (const sessionId of sessionIds) {
      const totals = inventory.get(sessionId) ?? emptyTotals();
      let placement = central.sessionPlacement(sessionId);
      if (options.dryRun) {
        if (!auditDb) {
          auditDb = new Database(":memory:");
          auditDb.run("ATTACH DATABASE ? AS source", [snapshot.snapshotPath]);
          auditDb.exec("PRAGMA query_only = ON");
          options.afterSourceAttached?.(auditDb);
        }
        verifySourceCoherence(auditDb, sessionId);
        if (!placement && central.hasSessionDurableState(sessionId))
          result.migratedLegacyKernel++;
        else if (!placement) result.claimedTranscriptOnly++;
        const receipt = receiptFor(auditDb, sessionId);
        result.sessions.push({ sessionId, receipt });
        addTotals(classifiedTotals, totals);
        continue;
      }
      if (!placement && central.hasSessionDurableState(sessionId)) {
        const targetPath = sessionKernelSessionDbPath(sessionId, isolatedRoot);
        if (!central.migrateLegacySession(sessionId, targetPath))
          throw new Error(
            `Could not migrate legacy kernel placement for ${sessionId}`,
          );
        result.migratedLegacyKernel++;
        placement = central.sessionPlacement(sessionId);
      }
      if (!placement)
        throw new Error(
          `Transcript session ${sessionId} has no migration placement`,
        );
      if (placement.placement !== "isolated")
        throw new Error(
          `Transcript session ${sessionId} has invalid kernel placement`,
        );

      const targetPath = sessionKernelSessionDbPath(sessionId, isolatedRoot);
      initializeActorTarget(targetPath, actorTemplatePath!);
      const target = new Database(targetPath);
      try {
        target.run("ATTACH DATABASE ? AS source", [snapshot.snapshotPath]);
        target.exec("PRAGMA query_only = ON");
        options.afterSourceAttached?.(target);
        verifySourceCoherence(target, sessionId, totals);
        target.exec("PRAGMA query_only = OFF");
        target.exec(`
          CREATE TABLE IF NOT EXISTS session_kernel_transcript_migrations (
            session_id TEXT PRIMARY KEY,
            receipt TEXT NOT NULL,
            verified_at INTEGER NOT NULL
          );
        `);
        const receipt = receiptFor(target, sessionId);
        const existing = target
          .query(
            "SELECT receipt FROM session_kernel_transcript_migrations WHERE session_id = ?",
          )
          .get(sessionId) as { receipt: string } | null;
        if (existing && existing.receipt !== receipt)
          throw new Error(
            `Session ${sessionId} target migration receipt conflict`,
          );
        if (totalsAreEmpty(totals)) verifyEmptyTarget(target, sessionId);

        if (!existing) {
          const copy = target.transaction(() => {
            for (const table of TABLES) {
              target.run(
                `DELETE FROM main.${table.name} WHERE session_id = ?`,
                [sessionId],
              );
              target.run(
                `INSERT INTO main.${table.name} (${table.columns})
                 SELECT ${table.columns} FROM source.${table.name} WHERE session_id = ?`,
                [sessionId],
              );
            }
            verifySession(target, sessionId, receipt);
            target.run(
              `INSERT INTO session_kernel_transcript_migrations
                 (session_id, receipt, verified_at) VALUES (?, ?, ?)`,
              [sessionId, receipt, Date.now()],
            );
          });
          copy.immediate();
          result.migrated++;
        } else {
          verifySession(target, sessionId, receipt);
          result.adopted++;
        }
        verified.push({ sessionId, migrationReceipt: receipt });
        addTotals(classifiedTotals, totals);
        target.exec("DETACH DATABASE source");
      } finally {
        target.close();
      }
      const completed = result.sessions.length + verified.length;
      if (completed === sessionIds.length || completed % 100 === 0)
        options.onProgress?.({
          completed,
          total: sessionIds.length,
          migrated: result.migrated,
          adopted: result.adopted,
        });
    }

    const sourceTotals = emptyTotals();
    for (const totals of inventory.values()) addTotals(sourceTotals, totals);
    for (const { name } of TABLES)
      if (sourceTotals[name] !== classifiedTotals[name])
        throw new Error(
          `Global ${name} total mismatch: source=${sourceTotals[name]}, ` +
            `classified=${classifiedTotals[name]}`,
        );
    if (options.dryRun) return result;
    for (const { sessionId } of verified) options.beforePublish?.(sessionId);
    central.publishActorTranscriptAuthorities(verified);
    result.sessions = verified.map(
      ({ sessionId, migrationReceipt: receipt }) => ({
        sessionId,
        receipt,
      }),
    );
    return result;
  } finally {
    auditDb?.close();
    snapshot.close();
    central.close();
  }
}
