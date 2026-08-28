import type { Database } from "bun:sqlite";

export const AGENT_HOST_LEDGER_SCHEMA_VERSION = 1;
export const AGENT_HOST_LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const AGENT_HOST_LEDGER_SCHEMA_SQL = `
CREATE TABLE meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL CHECK(schema_version=1), created_at INTEGER NOT NULL, emergency_mode INTEGER NOT NULL DEFAULT 0 CHECK(emergency_mode IN (0,1))) STRICT;
CREATE TABLE writer (singleton INTEGER PRIMARY KEY CHECK(singleton=1), claim_nonce TEXT NOT NULL CHECK(length(claim_nonce) BETWEEN 16 AND 128), process_id INTEGER NOT NULL CHECK(process_id>0), claimed_at INTEGER NOT NULL) STRICT;
CREATE TABLE accounting (singleton INTEGER PRIMARY KEY CHECK(singleton=1), global_charge INTEGER NOT NULL CHECK(global_charge>=0), physical_high_water INTEGER NOT NULL CHECK(physical_high_water>=0), active_liability INTEGER NOT NULL DEFAULT 0 CHECK(active_liability>=0)) STRICT;
CREATE TABLE turns (
 session_key TEXT NOT NULL CHECK(length(session_key)=64), turn_key TEXT PRIMARY KEY CHECK(length(turn_key)=64), run_key TEXT NOT NULL CHECK(length(run_key)=64),
 phase TEXT NOT NULL CHECK(phase IN ('admitted','running','terminal','indeterminate','quarantined','deleted')),
 fence_digest TEXT NOT NULL CHECK(length(fence_digest)=64), fence_ciphertext TEXT NOT NULL, fence_key_id TEXT NOT NULL, authority_ciphertext TEXT NOT NULL, authority_key_id TEXT NOT NULL,
 admitted_at INTEGER NOT NULL, terminal_at INTEGER, charged_bytes INTEGER NOT NULL DEFAULT 0 CHECK(charged_bytes>=0), byte_count INTEGER NOT NULL CHECK(byte_count>=0)
) STRICT;
CREATE INDEX turns_phase_time ON turns(phase,terminal_at);
CREATE INDEX turns_session ON turns(session_key);
CREATE TABLE operations (
 operation_key TEXT PRIMARY KEY CHECK(length(operation_key)=64), session_key TEXT NOT NULL CHECK(length(session_key)=64), turn_key TEXT NOT NULL REFERENCES turns(turn_key) ON DELETE CASCADE,
 phase TEXT NOT NULL CHECK(phase IN ('prepared','executing','settled','indeterminate','quarantined')),
 identity_digest TEXT NOT NULL CHECK(length(identity_digest)=64), descriptor_ciphertext TEXT NOT NULL, descriptor_key_id TEXT NOT NULL,
 reconcile_ciphertext TEXT, reconcile_key_id TEXT, prepared_at INTEGER NOT NULL, executing_at INTEGER, terminal_at INTEGER, byte_count INTEGER NOT NULL CHECK(byte_count>=0)
) STRICT;
CREATE INDEX operations_session_phase ON operations(session_key,phase);
CREATE TABLE control_receipts (
 receipt_key TEXT PRIMARY KEY CHECK(length(receipt_key)=64), session_key TEXT NOT NULL CHECK(length(session_key)=64), turn_key TEXT NOT NULL REFERENCES turns(turn_key) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('ask','answer','steer','cancel','transcript')),
 phase TEXT NOT NULL CHECK(phase IN ('prepared','settled','indeterminate','quarantined')),
 identity_digest TEXT NOT NULL CHECK(length(identity_digest)=64), descriptor_ciphertext TEXT, descriptor_key_id TEXT,
 reconcile_ciphertext TEXT, reconcile_key_id TEXT, created_at INTEGER NOT NULL, terminal_at INTEGER, byte_count INTEGER NOT NULL CHECK(byte_count>=0)
) STRICT;
CREATE INDEX controls_session_phase ON control_receipts(session_key,phase);
CREATE TABLE outbox (
 outbox_key TEXT PRIMARY KEY CHECK(length(outbox_key)=64), session_key TEXT NOT NULL CHECK(length(session_key)=64), turn_key TEXT NOT NULL REFERENCES turns(turn_key) ON DELETE CASCADE,
 phase TEXT NOT NULL CHECK(phase IN ('queued','claimed','acked','failed','quarantined')),
 destination_digest TEXT NOT NULL CHECK(length(destination_digest)=64), body_digest TEXT NOT NULL CHECK(length(body_digest)=64), body_ciphertext TEXT, body_key_id TEXT,
 created_at INTEGER NOT NULL, claimed_at INTEGER, terminal_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 64), byte_count INTEGER NOT NULL CHECK(byte_count>=0)
) STRICT;
CREATE INDEX outbox_claim ON outbox(phase,created_at);
CREATE TABLE quarantine_evidence (
 evidence_key TEXT PRIMARY KEY CHECK(length(evidence_key)=64), session_key TEXT CHECK(session_key IS NULL OR length(session_key)=64), turn_key TEXT REFERENCES turns(turn_key) ON DELETE CASCADE,
 phase TEXT NOT NULL CHECK(phase IN ('quarantined','terminal')), evidence_ciphertext TEXT NOT NULL, evidence_key_id TEXT NOT NULL,
 created_at INTEGER NOT NULL, terminal_at INTEGER NOT NULL, byte_count INTEGER NOT NULL CHECK(byte_count>=0)
) STRICT;
CREATE INDEX evidence_expiry ON quarantine_evidence(terminal_at);
CREATE TABLE deletion_tombstones (
 session_key TEXT PRIMARY KEY CHECK(length(session_key)=64), deleted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>=deleted_at)
) STRICT;
CREATE INDEX tombstone_expiry ON deletion_tombstones(expires_at);
CREATE TABLE migration_history (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, digest TEXT NOT NULL CHECK(length(digest)=64)) STRICT;
`;

const REQUIRED_OBJECTS = [
  "accounting",
  "control_receipts",
  "controls_session_phase",
  "deletion_tombstones",
  "evidence_expiry",
  "migration_history",
  "meta",
  "operations",
  "operations_session_phase",
  "outbox",
  "outbox_claim",
  "quarantine_evidence",
  "tombstone_expiry",
  "turns",
  "turns_phase_time",
  "turns_session",
  "writer",
].sort();

export function initializeExactLedgerSchema(
  db: Database,
  nowMs: number,
  schemaDigest: string,
): void {
  const version = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()!.user_version;
  const objects = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  if (version === 0 && objects.length === 0) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(AGENT_HOST_LEDGER_SCHEMA_SQL);
      db.query(
        "INSERT INTO meta(singleton,schema_version,created_at) VALUES(1,1,?)",
      ).run(nowMs);
      db.exec(
        "INSERT INTO accounting(singleton,global_charge,physical_high_water) VALUES(1,0,0)",
      );
      db.query(
        "INSERT INTO migration_history(version,applied_at,digest) VALUES(1,?,?)",
      ).run(nowMs, schemaDigest);
      db.exec(`PRAGMA user_version=${AGENT_HOST_LEDGER_SCHEMA_VERSION}`);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  } else if (version !== AGENT_HOST_LEDGER_SCHEMA_VERSION) {
    throw new Error(`unsupported Agent Host ledger schema ${version}`);
  }
  const actual = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  if (
    actual.length !== REQUIRED_OBJECTS.length ||
    actual.some((name, index) => name !== REQUIRED_OBJECTS[index])
  )
    throw new Error("Agent Host ledger schema residue or missing object");
  const meta = db
    .query<{ schema_version: number }, []>(
      "SELECT schema_version FROM meta WHERE singleton=1",
    )
    .get();
  if (!meta || meta.schema_version !== AGENT_HOST_LEDGER_SCHEMA_VERSION)
    throw new Error("Agent Host ledger metadata mismatch");
}
