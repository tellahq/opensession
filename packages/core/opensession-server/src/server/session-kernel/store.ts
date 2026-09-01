import {
  DESTINATION_IDEMPOTENT_GATEWAY_OPERATIONS,
  GATEWAY_COMMAND_OPERATIONS,
} from "./gateway-command-protocol";
import { decodeExecutorId } from "@tellahq/opensession-protocol/executor";
/**
 * Durable state for the session actor boundary.
 *
 * The SQLite file is a journal for decisions, not a second transcript store.
 * A SessionKernel is the only writer. Read projections may consume changes,
 * but they never participate in admission or recovery decisions.
 */
import { Database } from "bun:sqlite";
import {
  nextRunState,
  type RunEvent,
  type RunState,
} from "./run-state-machine";
import {
  nextCreationState,
  type CreationEvent,
  type CreationState,
} from "./creation-state-machine";
import type { StagedCreationActorEffect } from "./creation-effect-protocol";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "fs";
import { dirname } from "path";
import { sessionsDir } from "../paths";
import { selectQueueBatch } from "./queue-batch-reducer";
import type { QueueItem } from "../queue-state";

export type DurableCommandStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "indeterminate";

export interface DurableCommandRecord {
  sessionId: string;
  requestId: string;
  type: string;
  payload: unknown;
  payloadHash: string;
  status: DurableCommandStatus;
  result?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
  replaySafe: boolean;
  retryable?: boolean;
  acknowledgedAt?: number;
  resultHash?: string;
  terminalFailure: boolean;
}

export interface DurableRunState {
  state: string;
  since: string;
  lastEvent?: string;
  generation: number;
  currentRunId?: string;
  changeSeq: number;
}

export interface DurableTimer {
  sessionId: string;
  timerId: string;
  kind: string;
  dueAt: number;
  token: string;
  payload: unknown;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  deadLetteredAt?: number;
  createdAt: number;
}

export type DurableSteerTarget = {
  token: string;
  runId: string;
  generation: number;
};

export type DurableDeliveryState = {
  revision: number;
  queued: unknown[];
  dispatch?: unknown;
  interrupt?: {
    interruptId: string;
    phase: "prepared" | "executing" | "confirmed";
    runGeneration: number;
    dispatchId?: string;
    anchorId: string;
    soloId?: string;
    source?: { slot: "steered"; index: number };
  };
  steered: unknown[];
  pendingSteers: Array<{
    item: unknown;
    index: number;
    preparedAt: number;
    target?: DurableSteerTarget;
  }>;
  updatedAt: number;
};

export type DeliverySlot = "queued" | "dispatch" | "steered";

export type DurableTurnState = {
  revision: number;
  cancel?: {
    cancelId: string;
    phase: "prepared" | "executing" | "settled";
    outcome?: "confirmed" | "not_aborted";
    runId: string;
    runGeneration: number;
    requeueIds: string[];
    source: string;
    user?: string;
  };
  updatedAt: number;
};

export type DurableTurnOutcomeProjection = {
  projectionId: string;
  phase: "pending" | "completed" | "superseded";
  runId: string;
  runGeneration: number;
  errorMessage: string | null;
  engineSessionId?: string;
  noticePersisted: boolean;
  noticeLabel?: string;
  projectedAt: string;
};

export interface DurableOutboxItem {
  id: number;
  effectId: string;
  effectKey: string;
  sessionId: string;
  kind: string;
  payload: unknown;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  deadLetteredAt?: number;
  createdAt: number;
}

const json = (value: unknown): string => JSON.stringify(value ?? null);
const CHANGE_HISTORY_PER_SESSION = 5_000;
const MAINTENANCE_CHANGE_DELETE_BATCH = 250;
const digest = (text: string): string =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");
const resultRecord = (value: unknown) => {
  const text = json(value);
  return {
    text,
    hash: digest(text),
    terminalFailure:
      !!value &&
      typeof value === "object" &&
      (value as Record<string, unknown>).__sessionKernelFailure === true,
  };
};
const parsed = <T>(value: string | null | undefined): T | undefined => {
  if (value == null) return undefined;
  return JSON.parse(value) as T;
};
type ProcessOwnerIdentity = { token: string; bootId?: string; start?: string };
function linuxBootId(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return undefined;
  }
}
function linuxProcessStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    return fields[19];
  } catch {
    return undefined;
  }
}
function parseOwnerIdentity(value: string): ProcessOwnerIdentity | undefined {
  try {
    const parsed = JSON.parse(value) as ProcessOwnerIdentity;
    return typeof parsed?.token === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}
function plausibleLegacyOwner(pid: number): boolean {
  try {
    const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(
      /\0/g,
      " ",
    );
    if (!command.includes("opensession.ts")) return false;
    const environment = readFileSync(`/proc/${pid}/environ`, "utf8").split(
      "\0",
    );
    const stateDir = environment
      .find((entry) => entry.startsWith("OPENSESSION_STATE_DIR="))
      ?.slice("OPENSESSION_STATE_DIR=".length);
    const sessionOverride = environment
      .find((entry) => entry.startsWith("OPENSESSION_SESSIONS_DIR="))
      ?.slice("OPENSESSION_SESSIONS_DIR=".length);
    if (sessionOverride && sessionOverride !== sessionsDir()) return false;
    if (stateDir && !sessionsDir().startsWith(stateDir)) return false;
    return true;
  } catch {
    // Non-Linux and unreadable process evidence fail closed during the one-time
    // migration from pre-identity owner rows.
    return true;
  }
}
const ownerGlobal = globalThis as typeof globalThis & {
  __opensessionSessionKernelOwnerId?: string;
};
const PROCESS_OWNER_ID = (ownerGlobal.__opensessionSessionKernelOwnerId ??=
  JSON.stringify({
    token:
      process.env.OPENSESSION_SESSION_KERNEL_OWNER_ID?.trim() ||
      crypto.randomUUID(),
    bootId: linuxBootId(),
    start: linuxProcessStart(process.pid),
  } satisfies ProcessOwnerIdentity));
export const SESSION_KERNEL_SCHEMA_VERSION = 32;
export const SESSION_KERNEL_MAX_CREATION_EFFECT_RECEIPTS = 256;
export const SESSION_KERNEL_MAX_OPENING_PLAN_BYTES = 16 * 1024 * 1024;

function validCreationSetupPatch(patch: Record<string, unknown>): boolean {
  const keys = Object.keys(patch);
  if (
    keys.some(
      (key) =>
        !["branch", "workspaceId", "attachments", "resolved"].includes(key) ||
        patch[key] === undefined,
    )
  )
    return false;
  if (
    patch.branch !== undefined &&
    (typeof patch.branch !== "string" ||
      !patch.branch ||
      patch.branch.length > 512)
  )
    return false;
  if (
    patch.workspaceId !== undefined &&
    (typeof patch.workspaceId !== "string" ||
      !patch.workspaceId ||
      patch.workspaceId.length > 256)
  )
    return false;
  if (patch.attachments !== undefined) {
    if (!Array.isArray(patch.attachments) || patch.attachments.length > 32)
      return false;
    for (const item of patch.attachments) {
      if (!item || typeof item !== "object" || Array.isArray(item))
        return false;
      const attachment = item as Record<string, unknown>;
      if (
        typeof attachment.attachmentId !== "string" ||
        !/^[A-Za-z0-9_-]{8,128}$/.test(attachment.attachmentId) ||
        typeof attachment.name !== "string" ||
        !attachment.name ||
        attachment.name.length > 1024 ||
        typeof attachment.sourceRef !== "string" ||
        !attachment.sourceRef.startsWith("uploads:") ||
        attachment.sourceRef.length > 8192 ||
        typeof attachment.digest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(attachment.digest)
      )
        return false;
    }
  }
  if (patch.resolved !== undefined) {
    if (
      !patch.resolved ||
      typeof patch.resolved !== "object" ||
      Array.isArray(patch.resolved)
    )
      return false;
    const resolved = patch.resolved as Record<string, unknown>;
    if (
      ["gitEnv", "images", "materializeWorktree"].some((key) => key in resolved)
    )
      return false;
  }
  return true;
}

export function sessionKernelDbPath(): string {
  const explicit = process.env.OPENSESSION_SESSION_KERNEL_DB_PATH?.trim();
  if (explicit) return explicit;
  // Test processes must never open the live instance state. Tests that need
  // restart persistence construct a store at an explicit temporary path.
  if (process.env.NODE_ENV === "test") return ":memory:";
  return `${sessionsDir()}/session-kernel.sqlite`;
}

export function sessionKernelSessionDbPath(
  sessionId: string,
  root = `${sessionsDir()}/session-kernel-sessions`,
): string {
  if (!sessionId || Buffer.byteLength(sessionId) > 1_024)
    throw new Error("Invalid session kernel session id");
  const key = digest(sessionId);
  return `${root}/${key.slice(0, 2)}/${key}.sqlite`;
}

/**
 * Transcript-destination fence surface, retained after the Agent Host program
 * revert because live per-session kernel DBs and the surviving transcript
 * actor destination-append path still use the plan fence.
 */
export type AgentHostPlanRegistration = {
  op: "register_plan";
  registrationId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  generation: number;
  planHash: string;
};
export type AgentHostPlanRegistrationResult =
  | { accepted: true; replayed: boolean }
  | {
      accepted: false;
      reason: "stale_run" | "terminal_run" | "invalid_plan" | "plan_mismatch";
    };
const PLAN_KEYS = [
  "op",
  "registrationId",
  "sessionId",
  "runId",
  "turnId",
  "generation",
  "planHash",
] as const;
const PLAN_HASH_RE = /^sha256:[a-f0-9]{64}$/;
export function decodeAgentHostPlanRegistration(
  value: unknown,
): AgentHostPlanRegistration | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const plan = value as Record<string, unknown>;
  if (
    Object.keys(plan).length !== PLAN_KEYS.length ||
    Object.keys(plan).some((key) => !PLAN_KEYS.includes(key as never)) ||
    plan.op !== "register_plan" ||
    !decodeExecutorId(plan.registrationId) ||
    !decodeExecutorId(plan.sessionId) ||
    !decodeExecutorId(plan.runId) ||
    !decodeExecutorId(plan.turnId) ||
    !Number.isSafeInteger(plan.generation) ||
    (plan.generation as number) < 0 ||
    typeof plan.planHash !== "string" ||
    !PLAN_HASH_RE.test(plan.planHash)
  )
    return undefined;
  return plan as AgentHostPlanRegistration;
}

type DurableAgentHostPlan = AgentHostPlanRegistration & {
  hostId?: string;
  hostGenerationHighWater: number;
  supervisorHighWater: number;
};

function decodeDurableAgentHostPlan(
  sessionId: string,
  row: Record<string, unknown> | null,
): DurableAgentHostPlan | undefined {
  if (!row) return undefined;
  const plan = decodeAgentHostPlanRegistration({
    op: "register_plan",
    registrationId: row.registration_id,
    sessionId,
    runId: row.run_id,
    turnId: row.turn_id,
    generation: row.run_generation,
    planHash: row.plan_hash,
  });
  const hostId =
    row.host_id == null ? undefined : decodeExecutorId(row.host_id);
  const hostGenerationHighWater = Number(row.host_generation_high_water);
  const supervisorHighWater = Number(row.supervisor_high_water);
  if (
    !plan ||
    (row.host_id != null && !hostId) ||
    !Number.isSafeInteger(hostGenerationHighWater) ||
    hostGenerationHighWater < 0 ||
    !Number.isSafeInteger(supervisorHighWater) ||
    supervisorHighWater < 0
  )
    throw new Error("Invalid durable Agent Host plan");
  return {
    ...plan,
    hostId,
    hostGenerationHighWater,
    supervisorHighWater,
  };
}

function migrateAgentHostSupervisionSchema(
  db: Database,
  schemaVersion: number,
): void {
  if (schemaVersion >= 26) return;
  const tx = db.transaction(() => {
    const supervisionColumns = new Set(
      (
        db
          .query("PRAGMA table_info(session_kernel_agent_host_supervision)")
          .all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    if (!supervisionColumns.has("expires_at"))
      db.exec(
        "ALTER TABLE session_kernel_agent_host_supervision ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0",
      );
    const planColumns = new Set(
      (
        db
          .query("PRAGMA table_info(session_kernel_agent_host_plan)")
          .all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    if (!planColumns.has("host_generation_high_water"))
      db.exec(
        "ALTER TABLE session_kernel_agent_host_plan ADD COLUMN host_generation_high_water INTEGER NOT NULL DEFAULT 0",
      );
    db.exec("PRAGMA user_version = 26");
  });
  tx.immediate();
}

function assertAgentOperationSchema28(db: Database): void {
  const expected = {
    session_kernel_agent_operation_high_water: [
      ["session_id", "TEXT", 1, 1],
      ["operation_sequence", "INTEGER", 1, 0],
      ["updated_at", "INTEGER", 1, 0],
    ],
    session_kernel_agent_operations: [
      ["session_id", "TEXT", 1, 1],
      ["operation_id", "TEXT", 1, 2],
      ["semantic_hash", "TEXT", 1, 0],
      ["identity_hash", "TEXT", 1, 0],
      ["identity", "TEXT", 1, 0],
      ["operation_sequence", "INTEGER", 1, 0],
      ["run_id", "TEXT", 1, 0],
      ["turn_id", "TEXT", 1, 0],
      ["run_generation", "INTEGER", 1, 0],
      ["kind", "TEXT", 1, 0],
      ["state", "TEXT", 1, 0],
      ["anchor_change_seq", "INTEGER", 1, 0],
      ["terminal_change_seq", "INTEGER", 0, 0],
      ["terminal_entry_ids", "TEXT", 0, 0],
      ["terminal_request", "TEXT", 0, 0],
      ["receipt", "TEXT", 1, 0],
      ["admitted_at", "INTEGER", 1, 0],
      ["terminal_at", "INTEGER", 0, 0],
    ],
  } as const;
  const normalize = (value: string) =>
    value.toLowerCase().replace(/\s+/g, " ").trim();
  for (const [table, columns] of Object.entries(expected)) {
    const row = db
      .query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get(table) as { sql: string } | null;
    const actual = (
      db.query(`PRAGMA table_xinfo(${table})`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
        hidden: number;
      }>
    ).map(({ name, type, notnull, pk, hidden }) => [
      name,
      type,
      notnull,
      pk,
      hidden,
    ]);
    const wanted = columns.map(([name, type, notnull, pk]) => [
      name,
      type,
      notnull,
      pk,
      0,
    ]);
    if (
      !row?.sql ||
      !normalize(row.sql).endsWith(") strict") ||
      JSON.stringify(actual) !== JSON.stringify(wanted)
    )
      throw new Error("Agent operation schema does not match exact schema 28");
    const sql = normalize(row.sql);
    const required =
      table === "session_kernel_agent_operation_high_water"
        ? [
            "primary key",
            "check(operation_sequence >= 0)",
            "check(updated_at >= 0)",
          ]
        : [
            "primary key(session_id, operation_id)",
            "unique(session_id, semantic_hash)",
            "unique(session_id, operation_sequence)",
            "check(semantic_hash glob 'sha256:*' and length(semantic_hash)=71)",
            "check(identity_hash glob 'sha256:*' and length(identity_hash)=71)",
            "check(operation_sequence >= 1)",
            "check(run_generation >= 0)",
            "check(kind in ('model','mcp'))",
            "check(state in ('admitted','settled','indeterminate'))",
            "check(anchor_change_seq >= 0)",
            "check(admitted_at >= 0)",
            "check((state='admitted' and terminal_change_seq is null",
            "(state!='admitted' and terminal_change_seq is not null",
          ];
    if (required.some((fragment) => !sql.includes(fragment)))
      throw new Error(
        "Agent operation schema constraints do not match schema 28",
      );
  }
  const indexes = db
    .query(
      `SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name IN ('session_kernel_agent_operations','session_kernel_agent_operation_high_water') AND sql IS NOT NULL ORDER BY name`,
    )
    .all() as Array<{ name: string; sql: string }>;
  const wantedIndexes = [
    [
      "idx_skao_prune",
      "create index idx_skao_prune on session_kernel_agent_operations(session_id,terminal_at) where state='settled'",
    ],
    [
      "idx_skao_turn_sequence",
      "create index idx_skao_turn_sequence on session_kernel_agent_operations(session_id,run_id,run_generation,turn_id,operation_sequence)",
    ],
  ];
  if (
    JSON.stringify(indexes.map(({ name, sql }) => [name, normalize(sql)])) !==
    JSON.stringify(wantedIndexes)
  )
    throw new Error(
      "Agent operation schema indexes do not match exact schema 28",
    );
  const integrity = db.query("PRAGMA quick_check").get() as Record<
    string,
    unknown
  >;
  if (!Object.values(integrity).includes("ok"))
    throw new Error("Agent operation schema integrity check failed");
}

function assertAgentOperationCancellationSchema32(db: Database): void {
  const row = db
    .query(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_kernel_agent_operation_cancellations'",
    )
    .get() as { sql: string } | null;
  const normalize = (value: string) =>
    value.toLowerCase().replace(/\s+/g, " ").trim();
  const columns = db
    .query("PRAGMA table_xinfo(session_kernel_agent_operation_cancellations)")
    .all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
    hidden: number;
  }>;
  const expected = [
    ["session_id", "TEXT", 1, 1, 0],
    ["operation_id", "TEXT", 1, 2, 0],
    ["identity_hash", "TEXT", 1, 0, 0],
    ["identity", "TEXT", 1, 0, 0],
    ["cancel_id", "TEXT", 1, 0, 0],
    ["reason", "TEXT", 1, 0, 0],
    ["disposition", "TEXT", 1, 0, 0],
    ["requested_at", "INTEGER", 1, 0, 0],
    ["intent", "TEXT", 1, 0, 0],
  ];
  const actual = columns.map(({ name, type, notnull, pk, hidden }) => [
    name,
    type,
    notnull,
    pk,
    hidden,
  ]);
  const sql = row?.sql ? normalize(row.sql) : "";
  if (
    !sql.endsWith(") strict") ||
    JSON.stringify(actual) !== JSON.stringify(expected) ||
    !sql.includes("primary key(session_id, operation_id)") ||
    !sql.includes(
      "check(identity_hash glob 'sha256:*' and length(identity_hash)=71)",
    ) ||
    !sql.includes(
      "check(reason in ('user','turn_deadline','shutdown','reconnect_deadline'))",
    ) ||
    !sql.includes("check(disposition in ('requested','too_late'))") ||
    !sql.includes("check(requested_at >= 0)")
  )
    throw new Error(
      "Agent operation cancellation schema does not match exact schema 32",
    );
  const integrity = db.query("PRAGMA quick_check").get() as Record<
    string,
    unknown
  >;
  if (!Object.values(integrity).includes("ok"))
    throw new Error(
      "Agent operation cancellation schema integrity check failed",
    );
}

function migrateAgentOperationCancellationSchema32(
  db: Database,
  schemaVersion: number,
): void {
  if (schemaVersion >= 32) return;
  const tx = db.transaction(() => {
    const prior = db
      .query(
        "SELECT name FROM sqlite_master WHERE name='session_kernel_agent_operation_cancellations'",
      )
      .get();
    if (prior)
      throw new Error(
        "Partial Agent operation cancellation schema is unsupported",
      );
    db.exec(`
      CREATE TABLE session_kernel_agent_operation_cancellations (
        session_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        identity_hash TEXT NOT NULL CHECK(identity_hash GLOB 'sha256:*' AND length(identity_hash)=71),
        identity TEXT NOT NULL,
        cancel_id TEXT NOT NULL,
        reason TEXT NOT NULL CHECK(reason IN ('user','turn_deadline','shutdown','reconnect_deadline')),
        disposition TEXT NOT NULL CHECK(disposition IN ('requested','too_late')),
        requested_at INTEGER NOT NULL CHECK(requested_at >= 0),
        intent TEXT NOT NULL,
        PRIMARY KEY(session_id, operation_id)
      ) STRICT;
      PRAGMA user_version = 32;
    `);
  });
  tx.immediate();
}

function migrateSparseProjectionSchema29(
  db: Database,
  schemaVersion: number,
): void {
  if (schemaVersion >= 29) return;
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_kernel_sparse_projections (
        session_id TEXT PRIMARY KEY,
        ask_record TEXT,
        delivery_state TEXT,
        dirty INTEGER NOT NULL DEFAULT 1 CHECK(dirty IN (0, 1)),
        updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_sksp_dirty
        ON session_kernel_sparse_projections(dirty, session_id);
      PRAGMA user_version = 29;
    `);
  });
  tx.immediate();
}

function migrateQuarantineProjectionSchema30(
  db: Database,
  schemaVersion: number,
): void {
  if (schemaVersion >= 30) return;
  const tx = db.transaction(() => {
    const quarantine = (
      db
        .query("PRAGMA table_info(session_kernel_sparse_projections)")
        .all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>
    ).find((column) => column.name === "quarantine_state");
    if (!quarantine) {
      db.exec(`
        ALTER TABLE session_kernel_sparse_projections
          ADD COLUMN quarantine_state TEXT;
      `);
    } else if (
      quarantine.type !== "TEXT" ||
      quarantine.notnull !== 0 ||
      quarantine.dflt_value !== null
    ) {
      throw new Error("Schema 30 requires exact quarantine projection storage");
    }
    db.exec(`
      UPDATE session_kernel_sparse_projections SET dirty = 1;
      PRAGMA user_version = 30;
    `);
  });
  tx.immediate();
}

function migrateAgentOperationSchema28(
  db: Database,
  schemaVersion: number,
): void {
  if (schemaVersion >= 28) return;
  const tx = db.transaction(() => {
    const partial = db
      .query(
        `SELECT name FROM sqlite_master WHERE name IN
       ('session_kernel_agent_operations','session_kernel_agent_operation_high_water')`,
      )
      .all() as Array<{ name: string }>;
    if (partial.length !== 0)
      throw new Error("Partial Agent operation schema is unsupported");
    const supervisionColumns = new Set(
      (
        db
          .query("PRAGMA table_info(session_kernel_agent_host_supervision)")
          .all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    for (const required of [
      "receipt_format",
      "envelope",
      "authority_hash",
      "supervisor_epoch",
      "status",
    ])
      if (!supervisionColumns.has(required))
        throw new Error(
          "Schema 28 requires exact schema 27 signed supervision storage",
        );
    db.exec(`
      CREATE TABLE session_kernel_agent_operation_high_water (
        session_id TEXT PRIMARY KEY,
        operation_sequence INTEGER NOT NULL CHECK(operation_sequence >= 0),
        updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
      ) STRICT;
      CREATE TABLE session_kernel_agent_operations (
        session_id TEXT NOT NULL, operation_id TEXT NOT NULL,
        semantic_hash TEXT NOT NULL CHECK(semantic_hash GLOB 'sha256:*' AND length(semantic_hash)=71),
        identity_hash TEXT NOT NULL CHECK(identity_hash GLOB 'sha256:*' AND length(identity_hash)=71),
        identity TEXT NOT NULL, operation_sequence INTEGER NOT NULL CHECK(operation_sequence >= 1),
        run_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        run_generation INTEGER NOT NULL CHECK(run_generation >= 0),
        kind TEXT NOT NULL CHECK(kind IN ('model','mcp')),
        state TEXT NOT NULL CHECK(state IN ('admitted','settled','indeterminate')),
        anchor_change_seq INTEGER NOT NULL CHECK(anchor_change_seq >= 0),
        terminal_change_seq INTEGER, terminal_entry_ids TEXT, terminal_request TEXT,
        receipt TEXT NOT NULL, admitted_at INTEGER NOT NULL CHECK(admitted_at >= 0), terminal_at INTEGER,
        PRIMARY KEY(session_id, operation_id), UNIQUE(session_id, semantic_hash),
        UNIQUE(session_id, operation_sequence),
        CHECK((state='admitted' AND terminal_change_seq IS NULL AND terminal_entry_ids IS NULL AND terminal_request IS NULL AND terminal_at IS NULL) OR
              (state!='admitted' AND terminal_change_seq IS NOT NULL AND terminal_entry_ids IS NOT NULL AND terminal_request IS NOT NULL AND terminal_at IS NOT NULL))
      ) STRICT;
      CREATE INDEX idx_skao_turn_sequence ON session_kernel_agent_operations(session_id,run_id,run_generation,turn_id,operation_sequence);
      CREATE INDEX idx_skao_prune ON session_kernel_agent_operations(session_id,terminal_at) WHERE state='settled';
      PRAGMA user_version = 28;
    `);
  });
  tx.immediate();
}

function migrateTranscriptAuthoritySchema31(
  db: Database,
  schemaVersion: number,
): void {
  if (schemaVersion >= 31) return;
  const tx = db.transaction(() => {
    type Column = {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    };
    const columns = new Map(
      (
        db
          .query("PRAGMA table_info(session_kernel_placements)")
          .all() as Column[]
      ).map((column) => [column.name, column]),
    );
    const authority = columns.get("transcript_authority");
    if (!authority) {
      db.exec(`
        ALTER TABLE session_kernel_placements
          ADD COLUMN transcript_authority TEXT NOT NULL DEFAULT 'shared'
          CHECK (transcript_authority IN ('shared', 'actor'));
      `);
    } else if (
      authority.type !== "TEXT" ||
      authority.notnull !== 1 ||
      authority.dflt_value !== "'shared'"
    ) {
      throw new Error("Schema 31 requires exact transcript authority storage");
    }

    const receipt = columns.get("transcript_migration_receipt");
    if (!receipt) {
      db.exec(`
        ALTER TABLE session_kernel_placements
          ADD COLUMN transcript_migration_receipt TEXT;
      `);
    } else if (
      receipt.type !== "TEXT" ||
      receipt.notnull !== 0 ||
      receipt.dflt_value !== null
    ) {
      throw new Error("Schema 31 requires exact transcript migration receipts");
    }

    const published = columns.get("transcript_published_at");
    if (!published) {
      db.exec(`
        ALTER TABLE session_kernel_placements
          ADD COLUMN transcript_published_at INTEGER;
      `);
    } else if (
      published.type !== "INTEGER" ||
      published.notnull !== 0 ||
      published.dflt_value !== null
    ) {
      throw new Error(
        "Schema 31 requires exact transcript publication storage",
      );
    }

    const placementSql = (
      db
        .query(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_kernel_placements'",
        )
        .get() as { sql: string } | null
    )?.sql;
    if (
      !placementSql ||
      !/CHECK\s*\(\s*transcript_authority\s+IN\s*\(\s*'shared'\s*,\s*'actor'\s*\)\s*\)/i.test(
        placementSql,
      )
    ) {
      throw new Error(
        "Schema 31 requires constrained transcript authority storage",
      );
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_skp_transcript_authority
        ON session_kernel_placements(transcript_authority, session_id);

    `);
    const indexColumns = db
      .query("PRAGMA index_info(idx_skp_transcript_authority)")
      .all() as Array<{ seqno: number; name: string }>;
    if (
      indexColumns.length !== 2 ||
      indexColumns[0]?.name !== "transcript_authority" ||
      indexColumns[1]?.name !== "session_id"
    ) {
      throw new Error("Schema 31 requires exact transcript authority index");
    }
    db.exec("PRAGMA user_version = 31");
  });
  tx.immediate();
}

function migrateAgentHostSupervisionSchema27(
  db: Database,
  schemaVersion: number,
): void {
  if (schemaVersion >= 27) return;
  const tx = db.transaction(() => {
    db.exec(`
      DROP INDEX IF EXISTS idx_skahs_active;
      ALTER TABLE session_kernel_agent_host_supervision RENAME TO session_kernel_agent_host_supervision_v26;
      CREATE TABLE session_kernel_agent_host_supervision (
        session_id TEXT NOT NULL, supervisor_epoch INTEGER NOT NULL CHECK(supervisor_epoch >= 1),
        claim_id TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(request_hash GLOB 'sha256:*' AND length(request_hash)=71),
        run_id TEXT NOT NULL, run_generation INTEGER NOT NULL CHECK(run_generation >= 0),
        host_id TEXT NOT NULL, host_generation INTEGER NOT NULL CHECK(host_generation >= 0),
        host_incarnation TEXT NOT NULL, kernel_service_epoch TEXT NOT NULL,
        challenge TEXT NOT NULL, nonce TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','superseded','settled')),
        receipt_format TEXT NOT NULL CHECK(receipt_format IN ('legacy_unsigned_v2','signed_v1')),
        key_id TEXT, signature TEXT, envelope TEXT,
        authority TEXT NOT NULL, authority_bytes TEXT NOT NULL,
        authority_hash TEXT NOT NULL CHECK(authority_hash GLOB 'sha256:*' AND length(authority_hash)=71),
        expires_at INTEGER NOT NULL CHECK(expires_at >= 0), created_at INTEGER NOT NULL CHECK(created_at >= 0),
        CHECK((receipt_format='legacy_unsigned_v2' AND key_id IS NULL AND signature IS NULL AND envelope IS NULL) OR
              (receipt_format='signed_v1' AND key_id IS NOT NULL AND signature IS NOT NULL AND envelope IS NOT NULL)),
        PRIMARY KEY(session_id, supervisor_epoch), UNIQUE(session_id, claim_id),
        UNIQUE(session_id, challenge), UNIQUE(session_id, nonce)
      );
      INSERT INTO session_kernel_agent_host_supervision
       (session_id,supervisor_epoch,claim_id,request_hash,run_id,run_generation,
        host_id,host_generation,host_incarnation,kernel_service_epoch,challenge,nonce,
        status,receipt_format,key_id,signature,envelope,authority,authority_bytes,
        authority_hash,expires_at,created_at)
      SELECT session_id,supervisor_epoch,claim_id,request_hash,run_id,run_generation,
        host_id,host_generation,host_incarnation,kernel_service_epoch,challenge,nonce,
        status,'legacy_unsigned_v2',NULL,NULL,NULL,authority,authority_bytes,
        authority_hash,expires_at,created_at
      FROM session_kernel_agent_host_supervision_v26;
      DROP TABLE session_kernel_agent_host_supervision_v26;
      CREATE UNIQUE INDEX idx_skahs_active ON session_kernel_agent_host_supervision(session_id) WHERE status='active';
      CREATE INDEX idx_skahs_prune ON session_kernel_agent_host_supervision(session_id, expires_at) WHERE status!='active';
      PRAGMA user_version = 27;
    `);
  });
  tx.immediate();
}

export type RunEventDecision = {
  sessionId: string;
  event: RunEvent;
  detail?: Record<string, unknown>;
  runKey?: string;
};

export type CreationEventDecision = {
  sessionId: string;
  identity: string;
  event: CreationEvent;
  /** Effect result being applied, fenced against the current effect. */
  effectId?: string;
  /** Stable effect emitted by this reduction, when it advances physical work. */
  nextEffectId?: string;
  effect?: StagedCreationActorEffect;
  /** Write-once setup decisions retained until opening launch is committed. */
  planPatch?: Record<string, unknown>;
  /** Serializable, non-secret opening input committed with its launch effect. */
  openingPlan?: Record<string, unknown>;
  detail?: Record<string, unknown>;
};

export type DurableCreationState = {
  state: CreationState;
  identity: string;
  generation: number;
  currentEffectId?: string;
  completedEffectIds: string[];
  setupPlan?: Record<string, unknown>;
  openingPlan?: Record<string, unknown>;
  changeSeq: number;
  updatedAt: number;
};

export type DurableSessionQuarantine = {
  sessionId: string;
  reason: string;
  commandKind: string;
  quarantinedAt: number;
  /** True only when durable state proves that releasing the safety fence cannot
   * resume an ambiguous command, claimed timer, outbox effect, or live run. */
  repairable: boolean;
};

export type CreationEventDecisionResult = {
  accepted: boolean;
  from?: CreationState;
  to?: CreationState;
  reason?:
    | "invalid_transition"
    | "identity_mismatch"
    | "stale_effect"
    | "invalid_effect"
    | "invalid_setup_plan"
    | "setup_plan_conflict"
    | "invalid_opening_plan"
    | "effect_receipt_capacity";
  state?: DurableCreationState;
};

export type RunEventDecisionResult = {
  accepted: boolean;
  from: RunState;
  to: RunState;
  reason?: "invalid_transition" | "stale_run";
  currentRunId?: string;
  rejectedRunId?: string;
  state: DurableRunState;
};

export type SessionKernelStoreOptions = {
  readonly?: boolean;
  /** Internal migration reader for additive schemas with unchanged session tables. */
  compatibleReadSchemaFloor?: number;
  allocateOutboxId?: (sessionId: string) => number;
  busyTimeoutMs?: number;
  hydrateRunStateCache?: boolean;
};

const SESSION_KERNEL_SESSION_TABLES = [
  "session_kernel_tombstones",
  "session_kernel_quarantine",
  "session_kernel_state",
  "session_kernel_creation",
  "session_kernel_asks",
  "session_kernel_delivery",
  "session_kernel_turn",
  "session_kernel_turn_projections",
  "session_kernel_agent_host_plan",
  "session_kernel_agent_host_supervision",
  "session_kernel_agent_operations",
  "session_kernel_agent_operation_cancellations",
  "session_kernel_agent_operation_high_water",
  "session_kernel_commands",
  "session_kernel_changes",
  "session_kernel_timers",
  "session_kernel_outbox",
] as const;

export type DurableSessionPlacement = {
  sessionId: string;
  placement: "isolated";
  transcriptAuthority: "shared" | "actor";
  transcriptMigrationReceipt?: string;
  transcriptPublishedAt?: number;
  needsScan: boolean;
  nextTimerAt?: number;
  nextOutboxAt?: number;
  updatedAt: number;
};

export class SessionKernelStore {
  private readonly db: Database;
  private readonly closeable: boolean;
  private readonly runStateCache = new Map<string, DurableRunState>();
  private readonly dirtyChangeSessions = new Set<string>();
  private readonly path: string;
  private readonly allocateOutboxId?: (sessionId: string) => number;

  constructor(
    path = sessionKernelDbPath(),
    options: SessionKernelStoreOptions = {},
  ) {
    this.path = path;
    this.allocateOutboxId = options.allocateOutboxId;
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (
      !Number.isInteger(busyTimeoutMs) ||
      busyTimeoutMs < 0 ||
      busyTimeoutMs > 60_000
    )
      throw new Error("Invalid session kernel SQLite busy timeout");
    if (options.readonly) {
      if (path === ":memory:")
        throw new Error(
          "A read-only session kernel store requires a file path",
        );
      this.db = new Database(path, { readonly: true });
      this.closeable = true;
      this.db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 50;");
      const schemaVersion = Number(
        (this.db.query("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      );
      const compatibleFloor = options.compatibleReadSchemaFloor;
      if (
        schemaVersion !== SESSION_KERNEL_SCHEMA_VERSION &&
        (compatibleFloor === undefined ||
          schemaVersion < compatibleFloor ||
          schemaVersion > SESSION_KERNEL_SCHEMA_VERSION)
      )
        throw new Error(
          `Session kernel read mirror schema ${schemaVersion} does not match supported ${SESSION_KERNEL_SCHEMA_VERSION}`,
        );
      if (options.hydrateRunStateCache !== false) this.hydrateRunStateCache();
      return;
    }
    if (path !== ":memory:") {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(path);
    this.closeable = true;
    this.db.exec("PRAGMA journal_mode = WAL;");
    // NORMAL, not FULL: with WAL, NORMAL still guarantees no corruption and
    // no torn transactions — an OS crash or power loss can only drop the most
    // recent commit(s) that had not yet reached the WAL fsync point; an
    // application crash loses nothing. Every kernel command is designed for
    // exactly that window: admissions replay by request id, effects are
    // destination-idempotent at-least-once, and interrupted physical work
    // fails closed. FULL cost ~3.3 ms of fsync per commit on this class of
    // disk vs ~0.005 ms at NORMAL — with two kernel commits wrapping every
    // transcript append, that fsync tax dominated the append path (measured
    // p50 ~18 ms per append pair) and drove lane saturation at ~100
    // concurrent sessions. Approved trade (Jaap, 2026-08-26).
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
    this.db.exec(`
			CREATE TABLE IF NOT EXISTS session_kernel_owner (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				owner_id TEXT NOT NULL,
				pid INTEGER NOT NULL,
				claimed_at INTEGER NOT NULL
			);
		`);
    // Claim before inspecting or mutating any durable schema. A concurrent old
    // actor must never observe migrations performed by a losing process.
    this.claimWriter();
    const schemaVersion = Number(
      (this.db.query("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    );
    if (schemaVersion > SESSION_KERNEL_SCHEMA_VERSION)
      throw new Error(
        `Session kernel schema ${schemaVersion} is newer than supported ${SESSION_KERNEL_SCHEMA_VERSION}`,
      );
    this.db.exec(`
			CREATE TABLE IF NOT EXISTS session_kernel_owner (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				owner_id TEXT NOT NULL,
				pid INTEGER NOT NULL,
				claimed_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS session_kernel_migrations (
				name TEXT PRIMARY KEY,
				completed_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS session_kernel_tombstones (
				session_id TEXT PRIMARY KEY,
				deleted_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS session_kernel_quarantine (
				session_id TEXT PRIMARY KEY,
				reason TEXT NOT NULL,
				command_kind TEXT NOT NULL,
				quarantined_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS session_kernel_placements (
				session_id TEXT PRIMARY KEY,
				placement TEXT NOT NULL CHECK (placement = 'isolated'),
				needs_scan INTEGER NOT NULL DEFAULT 1,
				next_timer_at INTEGER,
				next_outbox_at INTEGER,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS session_kernel_outbox_routes (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_skp_wake
				ON session_kernel_placements(needs_scan, next_timer_at, next_outbox_at);
			CREATE INDEX IF NOT EXISTS idx_skor_session
				ON session_kernel_outbox_routes(session_id, id);
			CREATE TABLE IF NOT EXISTS session_kernel_state (
				session_id TEXT PRIMARY KEY,
				run_state TEXT NOT NULL DEFAULT 'idle',
				run_since TEXT NOT NULL,
				last_event TEXT,
				generation INTEGER NOT NULL DEFAULT 0,
				current_run_id TEXT,
				change_seq INTEGER NOT NULL DEFAULT 0,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS session_kernel_creation (
				session_id TEXT PRIMARY KEY,
				identity TEXT NOT NULL,
				state TEXT NOT NULL,
				generation INTEGER NOT NULL DEFAULT 0,
				current_effect_id TEXT,
				completed_effects TEXT NOT NULL DEFAULT '[]',
				setup_plan TEXT,
				opening_plan TEXT,
				change_seq INTEGER NOT NULL DEFAULT 0,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS session_kernel_asks (
				session_id TEXT PRIMARY KEY,
				revision INTEGER NOT NULL DEFAULT 0,
				record TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS session_kernel_delivery (
				session_id TEXT PRIMARY KEY,
				revision INTEGER NOT NULL DEFAULT 0,
				queued TEXT NOT NULL DEFAULT '[]',
				dispatch TEXT,
				interrupt TEXT,
				steered TEXT NOT NULL DEFAULT '[]',
				pending_steers TEXT NOT NULL DEFAULT '[]',
				updated_at INTEGER NOT NULL
			);
      CREATE TABLE IF NOT EXISTS session_kernel_turn (
        session_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0,
        cancel TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_kernel_agent_host_plan (
        session_id TEXT PRIMARY KEY,
        registration_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        run_generation INTEGER NOT NULL,
        turn_id TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        host_id TEXT,
        host_generation_high_water INTEGER NOT NULL DEFAULT 0,
        supervisor_high_water INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_kernel_agent_host_supervision (
        session_id TEXT NOT NULL,
        supervisor_epoch INTEGER NOT NULL,
        claim_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        run_id TEXT NOT NULL,
        run_generation INTEGER NOT NULL,
        host_id TEXT NOT NULL,
        host_generation INTEGER NOT NULL,
        host_incarnation TEXT NOT NULL,
        kernel_service_epoch TEXT NOT NULL,
        challenge TEXT NOT NULL,
        nonce TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'settled')),
        authority TEXT NOT NULL,
        authority_bytes TEXT NOT NULL,
        authority_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, supervisor_epoch),
        UNIQUE (session_id, claim_id),
        UNIQUE (session_id, challenge),
        UNIQUE (session_id, nonce)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_skahs_active
        ON session_kernel_agent_host_supervision(session_id) WHERE status = 'active';
      CREATE TABLE IF NOT EXISTS session_kernel_turn_projections (
        session_id TEXT NOT NULL,
        projection_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        phase TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, projection_id),
        UNIQUE (session_id, generation)
      );
			CREATE TABLE IF NOT EXISTS session_kernel_commands (
				session_id TEXT NOT NULL,
				request_id TEXT NOT NULL,
				type TEXT NOT NULL,
				payload TEXT NOT NULL,
				payload_hash TEXT,
				status TEXT NOT NULL,
				replay_safe INTEGER NOT NULL DEFAULT 0,
				retryable INTEGER,
				result TEXT,
				result_hash TEXT,
				terminal_failure INTEGER NOT NULL DEFAULT 0,
				acknowledged_at INTEGER,
				error TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (session_id, request_id)
			);
			CREATE TABLE IF NOT EXISTS session_kernel_changes (
				session_id TEXT NOT NULL,
				change_seq INTEGER NOT NULL,
				kind TEXT NOT NULL,
				payload TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (session_id, change_seq)
			);
			CREATE TABLE IF NOT EXISTS session_kernel_timers (
				session_id TEXT NOT NULL,
				timer_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				due_at INTEGER NOT NULL,
				token TEXT,
				payload TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				next_attempt_at INTEGER NOT NULL DEFAULT 0,
				last_error TEXT,
				dead_lettered_at INTEGER,
				created_at INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (session_id, timer_id)
			);
			CREATE INDEX IF NOT EXISTS idx_skt_due
				ON session_kernel_timers(due_at);
			CREATE TABLE IF NOT EXISTS session_kernel_outbox (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				effect_id TEXT NOT NULL,
				effect_key TEXT NOT NULL,
				session_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				payload TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				next_attempt_at INTEGER NOT NULL DEFAULT 0,
				last_error TEXT,
				dead_lettered_at INTEGER,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_sko_session
				ON session_kernel_outbox(session_id, id);
		`);
    const deliveryColumns = new Set(
      (
        this.db
          .query("PRAGMA table_info(session_kernel_delivery)")
          .all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    if (!deliveryColumns.has("interrupt"))
      this.db.exec(
        "ALTER TABLE session_kernel_delivery ADD COLUMN interrupt TEXT",
      );
    const creationColumns = new Set(
      (
        this.db
          .query("PRAGMA table_info(session_kernel_creation)")
          .all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    if (!creationColumns.has("completed_effects"))
      this.db.exec(
        "ALTER TABLE session_kernel_creation ADD COLUMN completed_effects TEXT NOT NULL DEFAULT '[]'",
      );
    if (!creationColumns.has("opening_plan"))
      this.db.exec(
        "ALTER TABLE session_kernel_creation ADD COLUMN opening_plan TEXT",
      );
    if (!creationColumns.has("setup_plan"))
      this.db.exec(
        "ALTER TABLE session_kernel_creation ADD COLUMN setup_plan TEXT",
      );
    const commandColumns = new Set(
      (
        this.db
          .query("PRAGMA table_info(session_kernel_commands)")
          .all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    if (!commandColumns.has("payload_hash"))
      this.db.exec(
        "ALTER TABLE session_kernel_commands ADD COLUMN payload_hash TEXT",
      );
    if (!commandColumns.has("replay_safe")) {
      this.db.exec(
        "ALTER TABLE session_kernel_commands ADD COLUMN replay_safe INTEGER NOT NULL DEFAULT 0",
      );
      // Pre-policy releases re-admitted every interrupted command. Preserve that
      // contract across the upgrade instead of turning live receipts indeterminate.
      this.db.run("UPDATE session_kernel_commands SET replay_safe = 1");
    }
    if (!commandColumns.has("retryable"))
      this.db.exec(
        "ALTER TABLE session_kernel_commands ADD COLUMN retryable INTEGER",
      );
    if (!commandColumns.has("result_hash"))
      this.db.exec(
        "ALTER TABLE session_kernel_commands ADD COLUMN result_hash TEXT",
      );
    if (!commandColumns.has("result_released"))
      this.db.exec(
        "ALTER TABLE session_kernel_commands ADD COLUMN result_released INTEGER NOT NULL DEFAULT 0",
      );
    if (schemaVersion < 6) {
      this.db.exec("DROP INDEX IF EXISTS idx_skc_compact");
      this.db.run(
        `UPDATE session_kernel_commands SET result_released = 1
				 WHERE result LIKE '%"__sessionKernelResultReleased":true%'`,
      );
    }
    if (!commandColumns.has("terminal_failure")) {
      this.db.exec(
        "ALTER TABLE session_kernel_commands ADD COLUMN terminal_failure INTEGER NOT NULL DEFAULT 0",
      );
      this.db.run(
        `UPDATE session_kernel_commands SET terminal_failure = 1
				 WHERE result LIKE '%"__sessionKernelFailure":true%'`,
      );
    }
    if (!commandColumns.has("acknowledged_at"))
      this.db.exec(
        "ALTER TABLE session_kernel_commands ADD COLUMN acknowledged_at INTEGER",
      );
    if (schemaVersion < 4) {
      const unhashedCommands = this.db
        .query(
          "SELECT session_id, request_id, payload FROM session_kernel_commands WHERE payload_hash IS NULL",
        )
        .all() as Array<{
        session_id: string;
        request_id: string;
        payload: string;
      }>;
      const setPayloadHash = this.db.query(
        "UPDATE session_kernel_commands SET payload_hash = ? WHERE session_id = ? AND request_id = ?",
      );
      for (const command of unhashedCommands)
        setPayloadHash.run(
          digest(command.payload),
          command.session_id,
          command.request_id,
        );
      const unhashedResults = this.db
        .query(
          "SELECT session_id, request_id, result FROM session_kernel_commands WHERE result IS NOT NULL AND result_hash IS NULL",
        )
        .all() as Array<{
        session_id: string;
        request_id: string;
        result: string;
      }>;
      const setResultHash = this.db.query(
        "UPDATE session_kernel_commands SET result_hash = ? WHERE session_id = ? AND request_id = ?",
      );
      for (const command of unhashedResults)
        setResultHash.run(
          digest(command.result),
          command.session_id,
          command.request_id,
        );
    }

    const outboxColumns = new Set(
      (
        this.db
          .query("PRAGMA table_info(session_kernel_outbox)")
          .all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    if (!outboxColumns.has("effect_id"))
      this.db.exec(
        "ALTER TABLE session_kernel_outbox ADD COLUMN effect_id TEXT",
      );
    if (!outboxColumns.has("effect_key"))
      this.db.exec(
        "ALTER TABLE session_kernel_outbox ADD COLUMN effect_key TEXT",
      );
    if (!outboxColumns.has("next_attempt_at"))
      this.db.exec(
        "ALTER TABLE session_kernel_outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0",
      );
    if (!outboxColumns.has("last_error"))
      this.db.exec(
        "ALTER TABLE session_kernel_outbox ADD COLUMN last_error TEXT",
      );
    if (!outboxColumns.has("dead_lettered_at"))
      this.db.exec(
        "ALTER TABLE session_kernel_outbox ADD COLUMN dead_lettered_at INTEGER",
      );
    const timerColumns = new Set(
      (
        this.db
          .query("PRAGMA table_info(session_kernel_timers)")
          .all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    if (!timerColumns.has("token")) {
      this.db.exec("ALTER TABLE session_kernel_timers ADD COLUMN token TEXT");
      this.db.run(
        "UPDATE session_kernel_timers SET token = lower(hex(randomblob(16))) WHERE token IS NULL",
      );
    }
    if (!timerColumns.has("attempts"))
      this.db.exec(
        "ALTER TABLE session_kernel_timers ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
      );
    if (!timerColumns.has("next_attempt_at"))
      this.db.exec(
        "ALTER TABLE session_kernel_timers ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0",
      );
    if (!timerColumns.has("last_error"))
      this.db.exec(
        "ALTER TABLE session_kernel_timers ADD COLUMN last_error TEXT",
      );
    if (!timerColumns.has("dead_lettered_at"))
      this.db.exec(
        "ALTER TABLE session_kernel_timers ADD COLUMN dead_lettered_at INTEGER",
      );
    if (!timerColumns.has("created_at")) {
      this.db.exec(
        "ALTER TABLE session_kernel_timers ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0",
      );
      this.db.run(
        "UPDATE session_kernel_timers SET created_at = due_at WHERE created_at = 0",
      );
    }
    if (schemaVersion < 4)
      this.db.run(
        "UPDATE session_kernel_outbox SET effect_id = COALESCE(effect_id, 'legacy:' || id), effect_key = COALESCE(effect_key, 'legacy:' || id)",
      );
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_sko_effect ON session_kernel_outbox(session_id, kind, effect_key)",
    );
    this.db.exec(`
			CREATE INDEX IF NOT EXISTS idx_skc_active_created
				ON session_kernel_commands(created_at)
				WHERE status IN ('pending', 'processing', 'indeterminate');
			CREATE INDEX IF NOT EXISTS idx_skc_active_session_status
				ON session_kernel_commands(session_id, status, created_at)
				WHERE status IN ('pending', 'processing', 'indeterminate');
			CREATE INDEX IF NOT EXISTS idx_skc_compact
				ON session_kernel_commands(acknowledged_at)
				WHERE status = 'completed' AND terminal_failure = 0
				  AND acknowledged_at IS NOT NULL AND result_hash IS NOT NULL
				  AND result_released = 0 AND length(result) > 65536;
			CREATE INDEX IF NOT EXISTS idx_skt_pending
				ON session_kernel_timers(next_attempt_at, due_at)
				WHERE dead_lettered_at IS NULL;
			CREATE INDEX IF NOT EXISTS idx_skt_kind_pending
				ON session_kernel_timers(kind, next_attempt_at, due_at)
				WHERE dead_lettered_at IS NULL;
			CREATE INDEX IF NOT EXISTS idx_skt_live_created
				ON session_kernel_timers(created_at)
				WHERE dead_lettered_at IS NULL;
			CREATE INDEX IF NOT EXISTS idx_skt_dead
				ON session_kernel_timers(dead_lettered_at DESC)
				WHERE dead_lettered_at IS NOT NULL;
			CREATE INDEX IF NOT EXISTS idx_sko_pending
				ON session_kernel_outbox(next_attempt_at, id)
				WHERE dead_lettered_at IS NULL;
			CREATE INDEX IF NOT EXISTS idx_sko_kind_pending
				ON session_kernel_outbox(kind, next_attempt_at, id)
				WHERE dead_lettered_at IS NULL;
			CREATE INDEX IF NOT EXISTS idx_sko_live_created
				ON session_kernel_outbox(created_at)
				WHERE dead_lettered_at IS NULL;
			CREATE INDEX IF NOT EXISTS idx_sko_dead
				ON session_kernel_outbox(dead_lettered_at DESC)
				WHERE dead_lettered_at IS NOT NULL;
		`);
    this.db.exec(
      "DROP INDEX IF EXISTS idx_skc_updated; DROP INDEX IF EXISTS idx_skc_status_created;",
    );
    migrateAgentHostSupervisionSchema(this.db, schemaVersion);
    // Additive migrations write user_version last inside IMMEDIATE transactions.
    migrateAgentHostSupervisionSchema27(this.db, schemaVersion);
    migrateAgentOperationSchema28(this.db, schemaVersion);
    migrateSparseProjectionSchema29(this.db, schemaVersion);
    migrateQuarantineProjectionSchema30(this.db, schemaVersion);
    migrateTranscriptAuthoritySchema31(this.db, schemaVersion);
    migrateAgentOperationCancellationSchema32(this.db, schemaVersion);
    assertAgentOperationSchema28(this.db);
    assertAgentOperationCancellationSchema32(this.db);
    if (path !== ":memory:") {
      try {
        chmodSync(path, 0o600);
      } catch {}
    }
    // A processing execution dies with its actor. Keep replay-safe intent pending
    // so the client's receipt outbox can re-admit the exact same command id.
    this.db.run(
      "UPDATE session_kernel_commands SET status = 'pending', error = 'actor restarted before acknowledgement', updated_at = ? WHERE status = 'processing' AND replay_safe = 1",
      [Date.now()],
    );
    // Pending means the actor committed admission but never marked execution
    // started. No physical effect can have run, so preserve the receipt as a
    // retryable failure instead of leaving readiness degraded forever.
    this.db.run(
      `UPDATE session_kernel_commands
			 SET status = 'failed', replay_safe = 1, retryable = 1,
			     error = 'actor restarted before execution admission', updated_at = ?
			 WHERE status = 'pending'`,
      [Date.now()],
    );
    this.db.run(
      "UPDATE session_kernel_commands SET status = 'indeterminate', error = 'actor restarted after execution began', retryable = 0, updated_at = ? WHERE status = 'processing'",
      [Date.now()],
    );
    this.hydrateRunStateCache();
    // A restart used to mark every known session dirty. The first runtime
    // maintenance pass then issued up to 100 FULL-synchronous DELETEs, which
    // could monopolize the actor for minutes on a large journal. Rebuild only
    // the actual over-retention candidates; new writes still mark themselves.
    const compactableChangeRows = this.db
      .query(
        `SELECT session_id FROM session_kernel_changes
				 GROUP BY session_id HAVING COUNT(*) > ?`,
      )
      .all(CHANGE_HISTORY_PER_SESSION) as Array<{ session_id: string }>;
    for (const row of compactableChangeRows)
      this.dirtyChangeSessions.add(row.session_id);
  }

  private hydrateRunStateCache(): void {
    this.runStateCache.clear();
    const stateRows = this.db
      .query(
        `SELECT session_id, run_state, run_since, last_event, generation,
				 current_run_id, change_seq FROM session_kernel_state`,
      )
      .all() as Record<string, unknown>[];
    for (const row of stateRows)
      this.runStateCache.set(String(row.session_id), {
        state: String(row.run_state),
        since: String(row.run_since),
        lastEvent: row.last_event == null ? undefined : String(row.last_event),
        generation: Number(row.generation),
        currentRunId:
          row.current_run_id == null ? undefined : String(row.current_run_id),
        changeSeq: Number(row.change_seq),
      });
  }

  private claimWriter(): void {
    const transaction = this.db.transaction(() => {
      const current = this.db
        .query(
          "SELECT owner_id, pid FROM session_kernel_owner WHERE singleton = 1",
        )
        .get() as { owner_id: string; pid: number } | null;
      if (current && current.owner_id !== PROCESS_OWNER_ID) {
        let alive = false;
        try {
          process.kill(current.pid, 0);
          alive = true;
        } catch {}
        if (alive) {
          const recorded = parseOwnerIdentity(current.owner_id);
          const bootId = linuxBootId();
          const start = linuxProcessStart(current.pid);
          if (
            recorded?.bootId &&
            recorded.start &&
            bootId &&
            start &&
            (recorded.bootId !== bootId || recorded.start !== start)
          )
            alive = false;
          else if (!recorded && !plausibleLegacyOwner(current.pid))
            alive = false;
        }
        if (alive)
          throw new Error(
            `Session kernel already owned by live process ${current.pid}`,
          );
      }
      this.db.run(
        `INSERT INTO session_kernel_owner (singleton, owner_id, pid, claimed_at)
				 VALUES (1, ?, ?, ?)
				 ON CONFLICT(singleton) DO UPDATE SET owner_id = excluded.owner_id,
					pid = excluded.pid, claimed_at = excluded.claimed_at`,
        [PROCESS_OWNER_ID, process.pid, Date.now()],
      );
    });
    transaction.immediate();
  }

  close(): void {
    if (this.closeable) this.db.close();
  }

  quarantineSession(
    sessionId: string,
    reason: string,
    commandKind: string,
  ): DurableSessionQuarantine {
    const quarantinedAt = Date.now();
    this.db.run(
      `INSERT INTO session_kernel_quarantine
			 (session_id, reason, command_kind, quarantined_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(session_id) DO NOTHING`,
      [
        sessionId,
        reason.slice(0, 2_000),
        commandKind.slice(0, 200),
        quarantinedAt,
      ],
    );
    return this.quarantinedSession(sessionId)!;
  }

  private recoverableGatewaySettlementCommands(
    sessionId: string,
    commandKind: string,
  ): Array<{ requestId: string; retryable: boolean }> | undefined {
    if (commandKind !== "gateway:complete" && commandKind !== "gateway:fail")
      return;
    const rows = this.db
      .query(
        `SELECT request_id, type, status, replay_safe
			 FROM session_kernel_commands
			 WHERE session_id = ? AND status IN ('pending', 'processing', 'indeterminate')`,
      )
      .all(sessionId) as Array<Record<string, unknown>>;
    if (
      !rows.every((row) => {
        const replaySafeSubmit =
          row.type === "submit_prompt" && Number(row.replay_safe) === 1;
        const strandedGatewaySettlement =
          row.status === "indeterminate" &&
          Number(row.replay_safe) === 0 &&
          GATEWAY_COMMAND_OPERATIONS.includes(
            String(row.type) as (typeof GATEWAY_COMMAND_OPERATIONS)[number],
          );
        return replaySafeSubmit || strandedGatewaySettlement;
      })
    )
      return;
    return rows.map((row) => ({
      requestId: String(row.request_id),
      retryable: row.type === "submit_prompt",
    }));
  }

  private recoverableDeliverySettlementCommands(
    sessionId: string,
    commandKind: string,
    reason?: string,
  ): Array<{ requestId: string; retryable: boolean }> | undefined {
    if (
      (commandKind !== "delivery:complete_submit_command" &&
        commandKind !== "delivery:fail_submit_command") ||
      (reason !== "actor restarted before execution admission" &&
        reason !== "actor restarted before acknowledgement" &&
        reason !== "actor restarted after execution began")
    )
      return;
    const rows = this.db
      .query(
        `SELECT request_id, type, status, replay_safe
			 FROM session_kernel_commands
			 WHERE session_id = ? AND status IN ('pending', 'processing', 'indeterminate')`,
      )
      .all(sessionId) as Array<Record<string, unknown>>;
    if (
      !rows.every((row) => {
        const replaySafeSubmit =
          row.type === "submit_prompt" && Number(row.replay_safe) === 1;
        const strandedGatewaySettlement =
          row.status === "indeterminate" &&
          Number(row.replay_safe) === 0 &&
          GATEWAY_COMMAND_OPERATIONS.includes(
            String(row.type) as (typeof GATEWAY_COMMAND_OPERATIONS)[number],
          );
        return replaySafeSubmit || strandedGatewaySettlement;
      })
    )
      return;
    return rows.map((row) => ({
      requestId: String(row.request_id),
      retryable: row.type === "submit_prompt",
    }));
  }

  quarantineRepairEvidence(
    sessionId: string,
    commandKind = "unknown",
    reason?: string,
    verifiedCommittedOutboxSettlement = false,
  ): boolean {
    const recoverableSettlement =
      this.recoverableGatewaySettlementCommands(sessionId, commandKind) ??
      this.recoverableDeliverySettlementCommands(
        sessionId,
        commandKind,
        reason,
      );
    const recoverableOutboxSettlement =
      verifiedCommittedOutboxSettlement &&
      (commandKind === "core:ack_outbox" ||
        commandKind === "core:fail_outbox") &&
      /^Outbox \d+ crossed session ownership$/.test(reason ?? "");
    if (
      [
        "preparing",
        "starting",
        "running",
        "ask_blocked",
        "interrupted",
        "reattaching",
      ].includes(this.runState(sessionId).state) &&
      !recoverableSettlement
    )
      return false;
    const ambiguousCommands = this.db
      .query(
        `SELECT 1 FROM session_kernel_commands
			 WHERE session_id = ? AND status IN ('pending', 'processing', 'indeterminate') LIMIT 1`,
      )
      .get(sessionId);
    if (ambiguousCommands && !recoverableSettlement) return false;
    const claimedTimer = this.db
      .query(
        "SELECT 1 FROM session_kernel_timers WHERE session_id = ? AND token IS NOT NULL LIMIT 1",
      )
      .get(sessionId);
    if (claimedTimer) return false;
    const pendingEffects = this.db
      .query(
        `SELECT kind FROM session_kernel_outbox
			 WHERE session_id = ? AND dead_lettered_at IS NULL`,
      )
      .all(sessionId) as Array<{ kind: string }>;
    // Turn outcome and cancellation effects are actor-owned state machines with
    // immutable run/dispatch identities. Keep them available to finish after
    // releasing a proven gateway-restart fence; externally delivered effects
    // and creation work remain fail-closed.
    const recoverableLifecycleEffects = new Set([
      "turn_outcome_project",
      "turn_cancel",
      "delivery_interrupt_cancel",
    ]);
    const onlyRecoverableLifecycleEffects =
      (!!recoverableSettlement || recoverableOutboxSettlement) &&
      pendingEffects.length > 0 &&
      pendingEffects.every((effect) =>
        recoverableLifecycleEffects.has(effect.kind),
      );
    if (pendingEffects.length > 0 && !onlyRecoverableLifecycleEffects)
      return false;
    return true;
  }

  quarantinedSession(sessionId: string): DurableSessionQuarantine | undefined {
    const row = this.db
      .query(
        `SELECT session_id, reason, command_kind, quarantined_at
				 FROM session_kernel_quarantine WHERE session_id = ?`,
      )
      .get(sessionId) as Record<string, unknown> | null;
    if (!row) return undefined;
    const commandKind = String(row.command_kind);
    const reason = String(row.reason);
    return {
      sessionId: String(row.session_id),
      reason,
      commandKind,
      quarantinedAt: Number(row.quarantined_at),
      repairable: this.quarantineRepairEvidence(sessionId, commandKind, reason),
    };
  }

  quarantinedSessions(limit = 100, offset = 0): DurableSessionQuarantine[] {
    const rows = this.db
      .query(
        `SELECT session_id, reason, command_kind, quarantined_at
				 FROM session_kernel_quarantine
				 ORDER BY quarantined_at DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Record<string, unknown>[];
    return rows.map((row) => {
      const sessionId = String(row.session_id);
      const commandKind = String(row.command_kind);
      const reason = String(row.reason);
      return {
        sessionId,
        reason,
        commandKind,
        quarantinedAt: Number(row.quarantined_at),
        repairable: this.quarantineRepairEvidence(
          sessionId,
          commandKind,
          reason,
        ),
      };
    });
  }

  releaseQuarantine(
    sessionId: string,
    verifiedCommittedOutboxSettlement = false,
  ): boolean {
    let released = false;
    const transaction = this.db.transaction(() => {
      const quarantine = this.quarantinedSession(sessionId);
      if (
        !quarantine ||
        !this.quarantineRepairEvidence(
          sessionId,
          quarantine.commandKind,
          quarantine.reason,
          verifiedCommittedOutboxSettlement,
        )
      )
        return;
      const recoverable =
        this.recoverableGatewaySettlementCommands(
          sessionId,
          quarantine.commandKind,
        ) ??
        this.recoverableDeliverySettlementCommands(
          sessionId,
          quarantine.commandKind,
          quarantine.reason,
        );
      for (const command of recoverable ?? []) {
        this.failCommand(
          sessionId,
          command.requestId,
          command.retryable
            ? "Replay-safe delivery settlement was re-admitted during session recovery"
            : "Ambiguous gateway settlement was abandoned during safe session recovery",
          command.retryable,
        );
      }
      released =
        this.db.run(
          "DELETE FROM session_kernel_quarantine WHERE session_id = ?",
          [sessionId],
        ).changes > 0;
    });
    transaction.immediate();
    return released;
  }

  command(
    sessionId: string,
    requestId: string,
  ): DurableCommandRecord | undefined {
    const row = this.db
      .query(
        `SELECT session_id, request_id, type, payload, payload_hash, status, replay_safe, retryable, result, result_hash, terminal_failure, acknowledged_at, error,
				created_at, updated_at FROM session_kernel_commands
				WHERE session_id = ? AND request_id = ?`,
      )
      .get(sessionId, requestId) as Record<string, unknown> | null;
    if (!row) return undefined;
    return {
      sessionId: String(row.session_id),
      requestId: String(row.request_id),
      type: String(row.type),
      payload: parsed(row.payload as string),
      payloadHash: String(row.payload_hash),
      status: row.status as DurableCommandStatus,
      result: parsed(row.result as string | null),
      error: row.error == null ? undefined : String(row.error),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      replaySafe: Number(row.replay_safe) === 1,
      retryable:
        row.retryable == null ? undefined : Number(row.retryable) === 1,
      acknowledgedAt:
        row.acknowledged_at == null ? undefined : Number(row.acknowledged_at),
      resultHash: row.result_hash == null ? undefined : String(row.result_hash),
      terminalFailure: Number(row.terminal_failure) === 1,
    };
  }

  acceptCommand(input: {
    sessionId: string;
    requestId: string;
    type: string;
    payload?: unknown;
    replaySafe?: boolean;
  }): DurableCommandRecord {
    const now = Date.now();
    const payloadText = json(input.payload);
    const payloadHash = digest(payloadText);
    this.db.run(
      `INSERT INTO session_kernel_commands
				(session_id, request_id, type, payload, payload_hash, status, replay_safe, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
			 ON CONFLICT(session_id, request_id) DO NOTHING`,
      [
        input.sessionId,
        input.requestId,
        input.type,
        payloadText,
        payloadHash,
        input.replaySafe ? 1 : 0,
        now,
        now,
      ],
    );
    let record = this.command(input.sessionId, input.requestId);
    if (!record) throw new Error("Session command was not persisted");
    if (record.type !== input.type || record.payloadHash !== payloadHash) {
      throw new Error(
        `Session command id ${input.requestId} was reused with another payload`,
      );
    }
    if (
      input.replaySafe &&
      !record.replaySafe &&
      record.status !== "indeterminate"
    ) {
      this.db.run(
        "UPDATE session_kernel_commands SET replay_safe = 1 WHERE session_id = ? AND request_id = ?",
        [input.sessionId, input.requestId],
      );
      record = this.command(input.sessionId, input.requestId)!;
    }
    return record;
  }

  markProcessing(sessionId: string, requestId: string): void {
    this.db.run(
      `UPDATE session_kernel_commands SET status = 'processing',
       payload = CASE WHEN type IN ('cancel_session', 'websocket_command') THEN payload ELSE 'null' END,
       error = NULL, retryable = NULL,
				updated_at = ? WHERE session_id = ? AND request_id = ?`,
      [Date.now(), sessionId, requestId],
    );
  }

  completeCommand(sessionId: string, requestId: string, result: unknown): void {
    const stored = resultRecord(result);
    this.db.run(
      `UPDATE session_kernel_commands SET status = 'completed',
       payload = CASE WHEN type IN ('cancel_session', 'websocket_command') THEN payload ELSE 'null' END,
				result = ?, result_hash = ?, result_released = 0, terminal_failure = ?, error = NULL,
				retryable = NULL, updated_at = ? WHERE session_id = ? AND request_id = ?`,
      [
        stored.text,
        stored.hash,
        stored.terminalFailure ? 1 : 0,
        Date.now(),
        sessionId,
        requestId,
      ],
    );
  }

  failCommand(
    sessionId: string,
    requestId: string,
    error: string,
    retryable = false,
  ): void {
    this.db.run(
      `UPDATE session_kernel_commands SET status = 'failed',
       payload = CASE WHEN type IN ('cancel_session', 'websocket_command') THEN payload ELSE 'null' END,
       error = ?, retryable = ?,
				updated_at = ? WHERE session_id = ? AND request_id = ?`,
      [
        error.slice(0, 2_000),
        retryable ? 1 : 0,
        Date.now(),
        sessionId,
        requestId,
      ],
    );
  }

  runState(sessionId: string): DurableRunState {
    // Global compatibility turns can mutate an isolated session through the
    // catalog lane while its stable session lane still has the same database
    // open. The mailbox barrier serializes those writers, but it cannot refresh
    // another worker's in-memory cache. Read the durable row before deriving the
    // next change sequence so a later session turn never reuses a journal key.
    const row = this.db
      .query(
        `SELECT run_state, run_since, last_event, generation,
				 current_run_id, change_seq FROM session_kernel_state
				 WHERE session_id = ?`,
      )
      .get(sessionId) as Record<string, unknown> | null;
    if (!row) {
      this.runStateCache.delete(sessionId);
      return {
        state: "idle",
        since: new Date(0).toISOString(),
        generation: 0,
        changeSeq: 0,
      };
    }
    const state: DurableRunState = {
      state: String(row.run_state),
      since: String(row.run_since),
      lastEvent: row.last_event == null ? undefined : String(row.last_event),
      generation: Number(row.generation),
      currentRunId:
        row.current_run_id == null ? undefined : String(row.current_run_id),
      changeSeq: Number(row.change_seq),
    };
    this.runStateCache.set(sessionId, state);
    return { ...state };
  }

  runStates(): Array<DurableRunState & { sessionId: string }> {
    // Catalog/global reads may run on a different actor-host lane from the
    // session's stable mailbox. Refresh this projection from SQLite instead of
    // returning a lane-local cache snapshot.
    this.hydrateRunStateCache();
    return [...this.runStateCache].map(([sessionId, state]) => ({
      sessionId,
      ...state,
    }));
  }

  appendChange(sessionId: string, kind: string, payload?: unknown): number {
    const now = Date.now();
    let changeSeq = 0;
    const tx = this.db.transaction(() => {
      const prior = this.runState(sessionId);
      changeSeq = prior.changeSeq + 1;
      this.db.run(
        `INSERT INTO session_kernel_state
					(session_id, run_state, run_since, last_event, generation,
					 current_run_id, change_seq, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET
					change_seq = excluded.change_seq,
					updated_at = excluded.updated_at`,
        [
          sessionId,
          prior.state,
          prior.since === new Date(0).toISOString()
            ? new Date(now).toISOString()
            : prior.since,
          prior.lastEvent ?? null,
          prior.generation,
          prior.currentRunId ?? null,
          changeSeq,
          now,
        ],
      );
      this.db.run(
        `INSERT INTO session_kernel_changes
					(session_id, change_seq, kind, payload, created_at)
				 VALUES (?, ?, ?, ?, ?)`,
        [sessionId, changeSeq, kind, json(payload), now],
      );
    });
    tx.immediate();
    const prior = this.runState(sessionId);
    this.runStateCache.set(sessionId, { ...prior, changeSeq });
    this.dirtyChangeSessions.add(sessionId);
    return changeSeq;
  }

  changesSince(
    sessionId: string,
    afterChangeSeq: number,
    limit = 500,
  ): Array<{
    changeSeq: number;
    kind: string;
    payload: unknown;
    createdAt: number;
  }> {
    const rows = this.db
      .query(
        `SELECT change_seq, kind, payload, created_at
				FROM session_kernel_changes
				WHERE session_id = ? AND change_seq > ?
				ORDER BY change_seq LIMIT ?`,
      )
      .all(sessionId, afterChangeSeq, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      changeSeq: Number(row.change_seq),
      kind: String(row.kind),
      payload: parsed(row.payload as string),
      createdAt: Number(row.created_at),
    }));
  }

  creationState(sessionId: string): DurableCreationState | undefined {
    const row = this.db
      .query(
        `SELECT identity, state, generation, current_effect_id, completed_effects,
                setup_plan, opening_plan, change_seq, updated_at
         FROM session_kernel_creation WHERE session_id = ?`,
      )
      .get(sessionId) as Record<string, unknown> | null;
    if (!row) return undefined;
    return {
      identity: String(row.identity),
      state: String(row.state) as CreationState,
      generation: Number(row.generation),
      currentEffectId:
        row.current_effect_id == null
          ? undefined
          : String(row.current_effect_id),
      completedEffectIds: [
        ...(parsed<string[]>(row.completed_effects as string) ?? []),
      ],
      setupPlan: parsed<Record<string, unknown>>(row.setup_plan as string),
      openingPlan: parsed<Record<string, unknown>>(row.opening_plan as string),
      changeSeq: Number(row.change_seq),
      updatedAt: Number(row.updated_at),
    };
  }

  applyCreationEvent(
    input: CreationEventDecision,
  ): CreationEventDecisionResult {
    if (this.isTombstoned(input.sessionId))
      throw new Error(`Session ${input.sessionId} was deleted`);
    const now = Date.now();
    let result!: CreationEventDecisionResult;
    const tx = this.db.transaction(() => {
      const prior = this.creationState(input.sessionId);
      if (prior && prior.identity !== input.identity) {
        result = {
          accepted: false,
          from: prior.state,
          to: prior.state,
          reason: "identity_mismatch",
          state: prior,
        };
        return;
      }
      const requiresEffectResult =
        !!prior?.currentEffectId &&
        [
          "preparation_started",
          "opening_dispatched",
          "succeeded",
          "failed",
          "cancelled",
        ].includes(input.event);
      if (
        (requiresEffectResult || input.effectId !== undefined) &&
        prior?.currentEffectId !== input.effectId
      ) {
        result = {
          accepted: false,
          from: prior?.state,
          to: prior?.state,
          reason: "stale_effect",
          state: prior,
        };
        return;
      }
      const from = prior?.state;
      const to = nextCreationState(from, input.event);
      if (!to) {
        result = {
          accepted: false,
          from,
          to: from,
          reason: "invalid_transition",
          state: prior,
        };
        return;
      }
      const run = this.runState(input.sessionId);
      const changeSeq = run.changeSeq + 1;
      const generation = prior?.generation ?? 1;
      const effect = input.effect;
      const completedEffectIds = [...(prior?.completedEffectIds ?? [])];
      const completesNewEffect =
        input.effectId !== undefined &&
        !completedEffectIds.includes(input.effectId);
      if (
        (completesNewEffect || effect !== undefined) &&
        completedEffectIds.length >= SESSION_KERNEL_MAX_CREATION_EFFECT_RECEIPTS
      ) {
        result = {
          accepted: false,
          from,
          to: from,
          reason: "effect_receipt_capacity",
          state: prior,
        };
        return;
      }
      if (completesNewEffect) completedEffectIds.push(input.effectId!);
      const invalidEffect =
        (input.event === "opening_dispatched" && !effect) ||
        (input.nextEffectId !== undefined && !effect) ||
        (!!effect && input.nextEffectId !== effect.effectKey) ||
        (!!effect && completedEffectIds.includes(effect.effectKey)) ||
        (!!effect &&
          (effect.payload.creationIdentity !== input.identity ||
            effect.payload.creationGeneration !== generation)) ||
        (!!effect &&
          input.event === "opening_dispatched" &&
          effect.kind !== "creation_opening_turn") ||
        (!!effect &&
          input.event === "preparation_started" &&
          effect.kind === "creation_opening_turn") ||
        (!!effect &&
          !["preparation_started", "opening_dispatched"].includes(input.event));
      if (invalidEffect) {
        result = {
          accepted: false,
          from,
          to: from,
          reason: "invalid_effect",
          state: prior,
        };
        return;
      }
      let setupPlan = prior?.setupPlan;
      if (input.planPatch !== undefined) {
        const invalidPatch =
          input.event !== "plan" ||
          !input.planPatch ||
          Array.isArray(input.planPatch) ||
          !validCreationSetupPatch(input.planPatch);
        if (invalidPatch) {
          result = {
            accepted: false,
            from,
            to: from,
            reason: "invalid_setup_plan",
            state: prior,
          };
          return;
        }
        const nextSetupPlan = { ...(setupPlan ?? {}) };
        for (const [key, value] of Object.entries(input.planPatch)) {
          if (
            Object.hasOwn(nextSetupPlan, key) &&
            json(nextSetupPlan[key]) !== json(value)
          ) {
            result = {
              accepted: false,
              from,
              to: from,
              reason: "setup_plan_conflict",
              state: prior,
            };
            return;
          }
          nextSetupPlan[key] = value;
        }
        if (
          Buffer.byteLength(json(nextSetupPlan)) >
          SESSION_KERNEL_MAX_OPENING_PLAN_BYTES
        ) {
          result = {
            accepted: false,
            from,
            to: from,
            reason: "invalid_setup_plan",
            state: prior,
          };
          return;
        }
        setupPlan = nextSetupPlan;
      }
      const openingPlanText =
        input.openingPlan === undefined ? undefined : json(input.openingPlan);
      const invalidOpeningPlan =
        (input.event === "opening_dispatched" &&
          (!openingPlanText ||
            Buffer.byteLength(openingPlanText) >
              SESSION_KERNEL_MAX_OPENING_PLAN_BYTES)) ||
        (input.event !== "opening_dispatched" &&
          input.openingPlan !== undefined);
      if (invalidOpeningPlan) {
        result = {
          accepted: false,
          from,
          to: from,
          reason: "invalid_opening_plan",
          state: prior,
        };
        return;
      }
      if (["opening_dispatched", "ready", "failed", "cancelled"].includes(to))
        setupPlan = undefined;
      const openingPlan = ["ready", "failed", "cancelled"].includes(to)
        ? undefined
        : (input.openingPlan ?? prior?.openingPlan);
      const currentEffectId = ["ready", "failed", "cancelled"].includes(to)
        ? undefined
        : (effect?.effectKey ??
          (input.effectId === undefined ? prior?.currentEffectId : undefined));
      this.db.run(
        `INSERT INTO session_kernel_creation
          (session_id, identity, state, generation, current_effect_id,
           completed_effects, setup_plan, opening_plan, change_seq, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
          state = excluded.state,
          generation = excluded.generation,
          current_effect_id = excluded.current_effect_id,
          completed_effects = excluded.completed_effects,
          setup_plan = excluded.setup_plan,
          opening_plan = excluded.opening_plan,
          change_seq = excluded.change_seq,
          updated_at = excluded.updated_at`,
        [
          input.sessionId,
          input.identity,
          to,
          generation,
          currentEffectId ?? null,
          json(completedEffectIds),
          setupPlan === undefined ? null : json(setupPlan),
          openingPlan === undefined ? null : json(openingPlan),
          changeSeq,
          now,
        ],
      );
      this.db.run(
        `INSERT INTO session_kernel_state
          (session_id, run_state, run_since, last_event, generation,
           current_run_id, change_seq, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
          change_seq = excluded.change_seq,
          updated_at = excluded.updated_at`,
        [
          input.sessionId,
          run.state,
          run.since === new Date(0).toISOString()
            ? new Date(now).toISOString()
            : run.since,
          run.lastEvent ?? null,
          run.generation,
          run.currentRunId ?? null,
          changeSeq,
          now,
        ],
      );
      if (effect)
        this.enqueueOutbox(
          input.sessionId,
          effect.kind,
          effect.payload,
          effect.effectKey,
        );
      this.db.run(
        `INSERT INTO session_kernel_changes
          (session_id, change_seq, kind, payload, created_at)
         VALUES (?, ?, 'creation_state', ?, ?)`,
        [
          input.sessionId,
          changeSeq,
          json({
            identity: input.identity,
            state: to,
            event: input.event,
            effectId: input.effectId,
            nextEffectId: input.nextEffectId,
            detail: input.detail,
          }),
          now,
        ],
      );
      const state: DurableCreationState = {
        identity: input.identity,
        state: to,
        generation,
        currentEffectId,
        completedEffectIds,
        setupPlan,
        openingPlan,
        changeSeq,
        updatedAt: now,
      };
      result = { accepted: true, from, to, state };
    });
    tx.immediate();
    if (result.accepted) {
      const run = this.runState(input.sessionId);
      this.runStateCache.set(input.sessionId, {
        ...run,
        changeSeq: result.state!.changeSeq,
      });
      this.dirtyChangeSessions.add(input.sessionId);
    }
    return result;
  }

  assertTranscriptDestinationFence(input: {
    sessionId: string;
    runId: string;
    turnId: string;
    generation: number;
  }): void {
    const run = this.runState(input.sessionId);
    if (
      run.currentRunId !== input.runId ||
      run.generation !== input.generation ||
      ![
        "starting",
        "running",
        "ask_blocked",
        "interrupted",
        "reattaching",
      ].includes(run.state)
    )
      throw new Error(
        `Transcript destination run fence rejected ${input.sessionId}`,
      );
    const plan = decodeDurableAgentHostPlan(
      input.sessionId,
      this.db
        .query(
          `SELECT registration_id, run_id, run_generation, turn_id, plan_hash,
                host_id, host_generation_high_water, supervisor_high_water
         FROM session_kernel_agent_host_plan WHERE session_id = ?`,
        )
        .get(input.sessionId) as Record<string, unknown> | null,
    );
    if (
      !plan ||
      plan.runId !== input.runId ||
      plan.generation !== input.generation ||
      plan.turnId !== input.turnId
    )
      throw new Error(
        `Transcript destination turn fence rejected ${input.sessionId}`,
      );
  }

  registerAgentHostPlan(
    input: AgentHostPlanRegistration,
  ): AgentHostPlanRegistrationResult {
    if (!decodeAgentHostPlanRegistration(input))
      return { accepted: false, reason: "invalid_plan" };
    if (this.isTombstoned(input.sessionId))
      throw new Error(`Session ${input.sessionId} was deleted`);
    const run = this.runState(input.sessionId);
    if (run.currentRunId !== input.runId || run.generation !== input.generation)
      return { accepted: false, reason: "stale_run" };
    if (
      ![
        "starting",
        "running",
        "ask_blocked",
        "interrupted",
        "reattaching",
      ].includes(run.state)
    )
      return { accepted: false, reason: "terminal_run" };
    const prior = decodeDurableAgentHostPlan(
      input.sessionId,
      this.db
        .query(
          `SELECT registration_id, run_id, run_generation, turn_id, plan_hash,
                host_id, host_generation_high_water, supervisor_high_water
         FROM session_kernel_agent_host_plan WHERE session_id = ?`,
        )
        .get(input.sessionId) as Record<string, unknown> | null,
    );
    if (
      prior &&
      prior.runId === input.runId &&
      prior.generation === input.generation
    ) {
      return prior.turnId === input.turnId && prior.planHash === input.planHash
        ? { accepted: true, replayed: true }
        : { accepted: false, reason: "plan_mismatch" };
    }
    this.db.run(
      `INSERT INTO session_kernel_agent_host_plan
       (session_id, registration_id, run_id, run_generation, turn_id,
        plan_hash, host_id, host_generation_high_water,
        supervisor_high_water, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
        registration_id = excluded.registration_id,
        run_id = excluded.run_id,
        run_generation = excluded.run_generation,
        turn_id = excluded.turn_id,
        plan_hash = excluded.plan_hash,
        host_id = excluded.host_id,
        host_generation_high_water = excluded.host_generation_high_water,
        supervisor_high_water = excluded.supervisor_high_water,
        updated_at = excluded.updated_at`,
      [
        input.sessionId,
        input.registrationId,
        input.runId,
        input.generation,
        input.turnId,
        input.planHash,
        prior?.hostId ?? null,
        prior?.hostGenerationHighWater ?? 0,
        prior?.supervisorHighWater ?? 0,
        Date.now(),
      ],
    );
    return { accepted: true, replayed: false };
  }

  applyRunEvent(input: RunEventDecision): RunEventDecisionResult {
    const now = Date.now();
    const since = new Date(now).toISOString();
    let result!: RunEventDecisionResult;
    const tx = this.db.transaction(() => {
      if (this.isTombstoned(input.sessionId))
        throw new Error(`Session ${input.sessionId} was deleted`);
      const prior = this.runState(input.sessionId);
      const from = prior.state as RunState;
      if (
        input.runKey &&
        ["turn_end", "run_failed", "start_failed", "start_aborted"].includes(
          input.event,
        ) &&
        prior.currentRunId !== input.runKey
      ) {
        result = {
          accepted: false,
          from,
          to: from,
          reason: "stale_run",
          currentRunId: prior.currentRunId,
          rejectedRunId: input.runKey,
          state: prior,
        };
        return;
      }
      const to = nextRunState(from, input.event);
      if (!to) {
        result = {
          accepted: false,
          from,
          to: from,
          reason: "invalid_transition",
          state: prior,
        };
        return;
      }
      const canceledDispatch = this.turnSnapshot(input.sessionId).cancel;
      if (
        (input.event === "run_registered" ||
          input.event === "boot_journal_found") &&
        input.runKey &&
        canceledDispatch?.runId === input.runKey &&
        canceledDispatch.runGeneration === prior.generation
      ) {
        result = {
          accepted: false,
          from,
          to: from,
          reason: "stale_run",
          currentRunId: prior.currentRunId,
          rejectedRunId: input.runKey,
          state: prior,
        };
        return;
      }
      if (
        (input.event === "prompt" || input.event === "run_registered") &&
        input.runKey &&
        prior.currentRunId &&
        prior.currentRunId !== input.runKey &&
        [
          "preparing",
          "starting",
          "running",
          "ask_blocked",
          "interrupted",
          "reattaching",
        ].includes(from)
      ) {
        result = {
          accepted: false,
          from,
          to: from,
          reason: "stale_run",
          currentRunId: prior.currentRunId,
          rejectedRunId: input.runKey,
          state: prior,
        };
        return;
      }
      const claimsRun =
        !!input.runKey &&
        (input.event === "prompt" ||
          input.event === "run_registered" ||
          input.event === "boot_journal_found");
      const generation =
        claimsRun && prior.currentRunId !== input.runKey
          ? prior.generation + 1
          : prior.generation;
      const currentRunId = ["idle", "stopped", "failed"].includes(to)
        ? undefined
        : claimsRun
          ? input.runKey
          : prior.currentRunId;
      const changeSeq = prior.changeSeq + 1;
      this.db.run(
        `INSERT INTO session_kernel_state
					(session_id, run_state, run_since, last_event, generation,
					 current_run_id, change_seq, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET
					run_state = excluded.run_state,
					run_since = excluded.run_since,
					last_event = excluded.last_event,
					generation = excluded.generation,
					current_run_id = excluded.current_run_id,
					change_seq = excluded.change_seq,
					updated_at = excluded.updated_at`,
        [
          input.sessionId,
          to,
          since,
          input.event,
          generation,
          currentRunId ?? null,
          changeSeq,
          now,
        ],
      );
      this.db.run(
        `INSERT INTO session_kernel_changes
					(session_id, change_seq, kind, payload, created_at)
				 VALUES (?, ?, 'run_state', ?, ?)`,
        [
          input.sessionId,
          changeSeq,
          json({ state: to, event: input.event, detail: input.detail }),
          now,
        ],
      );
      const state: DurableRunState = {
        state: to,
        since,
        lastEvent: input.event,
        generation,
        currentRunId,
        changeSeq,
      };
      result = { accepted: true, from, to, state };
    });
    tx.immediate();
    if (result.accepted) {
      this.runStateCache.set(input.sessionId, result.state);
      this.dirtyChangeSessions.add(input.sessionId);
    }
    return result;
  }

  setRunState(input: {
    sessionId: string;
    state: string;
    event: string;
    detail?: unknown;
    generation?: number;
    currentRunId?: string | null;
  }): DurableRunState {
    const now = Date.now();
    const since = new Date(now).toISOString();
    let next!: DurableRunState;
    const tx = this.db.transaction(() => {
      const prior = this.runState(input.sessionId);
      const changeSeq = prior.changeSeq + 1;
      const generation = input.generation ?? prior.generation;
      const currentRunId = ["idle", "stopped", "failed"].includes(input.state)
        ? undefined
        : (input.currentRunId ?? prior.currentRunId);
      this.db.run(
        `INSERT INTO session_kernel_state
					(session_id, run_state, run_since, last_event, generation,
					 current_run_id, change_seq, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET
					run_state = excluded.run_state,
					run_since = excluded.run_since,
					last_event = excluded.last_event,
					generation = excluded.generation,
					current_run_id = excluded.current_run_id,
					change_seq = excluded.change_seq,
					updated_at = excluded.updated_at`,
        [
          input.sessionId,
          input.state,
          since,
          input.event,
          generation,
          currentRunId ?? null,
          changeSeq,
          now,
        ],
      );
      this.db.run(
        `INSERT INTO session_kernel_changes
					(session_id, change_seq, kind, payload, created_at)
				 VALUES (?, ?, 'run_state', ?, ?)`,
        [
          input.sessionId,
          changeSeq,
          json({
            state: input.state,
            event: input.event,
            detail: input.detail,
          }),
          now,
        ],
      );
      next = {
        state: input.state,
        since,
        lastEvent: input.event,
        generation,
        currentRunId,
        changeSeq,
      };
    });
    tx.immediate();
    this.runStateCache.set(input.sessionId, next);
    this.dirtyChangeSessions.add(input.sessionId);
    return next;
  }

  isTombstoned(sessionId: string, now = Date.now()): boolean {
    const row = this.db
      .query(
        "SELECT deleted_at FROM session_kernel_tombstones WHERE session_id = ?",
      )
      .get(sessionId) as { deleted_at: number } | null;
    if (!row) return false;
    void now;
    return true;
  }

  tombstoneSession(sessionId: string): void {
    const tx = this.db.transaction(() => {
      for (const table of [
        "session_kernel_state",
        "session_kernel_creation",
        "session_kernel_asks",
        "session_kernel_delivery",
        "session_kernel_turn",
        "session_kernel_turn_projections",
        "session_kernel_agent_host_plan",
        "session_kernel_agent_host_supervision",
        "session_kernel_agent_operations",
        "session_kernel_agent_operation_cancellations",
        "session_kernel_agent_operation_high_water",
        "session_kernel_quarantine",
        "session_kernel_commands",
        "session_kernel_changes",
        "session_kernel_timers",
        "session_kernel_outbox",
      ])
        this.db.run(`DELETE FROM ${table} WHERE session_id = ?`, [sessionId]);
      this.db.run(
        `INSERT INTO session_kernel_tombstones (session_id, deleted_at) VALUES (?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET deleted_at = excluded.deleted_at`,
        [sessionId, Date.now()],
      );
    });
    tx.immediate();
    this.runStateCache.delete(sessionId);
    this.dirtyChangeSessions.delete(sessionId);
  }

  clearSession(sessionId: string): void {
    const tx = this.db.transaction(() => {
      for (const table of [
        "session_kernel_state",
        "session_kernel_creation",
        "session_kernel_asks",
        "session_kernel_delivery",
        "session_kernel_turn",
        "session_kernel_turn_projections",
        "session_kernel_agent_host_plan",
        "session_kernel_agent_host_supervision",
        "session_kernel_agent_operations",
        "session_kernel_agent_operation_cancellations",
        "session_kernel_agent_operation_high_water",
        "session_kernel_quarantine",
        "session_kernel_commands",
        "session_kernel_changes",
        "session_kernel_timers",
        "session_kernel_outbox",
      ]) {
        this.db.run(`DELETE FROM ${table} WHERE session_id = ?`, [sessionId]);
      }
    });
    tx.immediate();
    this.runStateCache.delete(sessionId);
    this.dirtyChangeSessions.delete(sessionId);
  }

  askMigrationComplete(): boolean {
    return !!this.db
      .query("SELECT 1 FROM session_kernel_migrations WHERE name = 'ask_v1'")
      .get();
  }

  markAskMigrationComplete(): void {
    this.db.run(
      "INSERT OR IGNORE INTO session_kernel_migrations (name, completed_at) VALUES ('ask_v1', ?)",
      [Date.now()],
    );
  }

  deliveryMigrationComplete(): boolean {
    return !!this.db
      .query(
        "SELECT 1 FROM session_kernel_migrations WHERE name = 'delivery_v1'",
      )
      .get();
  }

  markDeliveryMigrationComplete(): void {
    this.db.run(
      "INSERT OR IGNORE INTO session_kernel_migrations (name, completed_at) VALUES ('delivery_v1', ?)",
      [Date.now()],
    );
  }

  askSnapshot(sessionId: string): unknown | undefined {
    const row = this.db
      .query("SELECT record FROM session_kernel_asks WHERE session_id = ?")
      .get(sessionId) as { record: string } | null;
    return row ? parsed(row.record) : undefined;
  }

  askEntries(): Array<[string, unknown]> {
    return (
      this.db
        .query(
          "SELECT session_id, record FROM session_kernel_asks ORDER BY session_id",
        )
        .all() as Array<{ session_id: string; record: string }>
    ).map((row) => [row.session_id, parsed(row.record)]);
  }

  private mutateAskRecord(
    sessionId: string,
    value: unknown | undefined,
  ): boolean {
    if (value !== undefined && this.isTombstoned(sessionId))
      throw new Error(`Session ${sessionId} was deleted`);
    const existed = this.askSnapshot(sessionId) !== undefined;
    if (value === undefined && !existed) return false;
    const now = Date.now();
    let nextRunState!: DurableRunState;
    const tx = this.db.transaction(() => {
      if (value === undefined)
        this.db.run("DELETE FROM session_kernel_asks WHERE session_id = ?", [
          sessionId,
        ]);
      else {
        const prior = this.db
          .query(
            "SELECT revision FROM session_kernel_asks WHERE session_id = ?",
          )
          .get(sessionId) as { revision: number } | null;
        this.db.run(
          `INSERT INTO session_kernel_asks
					 (session_id, revision, record, updated_at) VALUES (?, ?, ?, ?)
					 ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision,
					 record = excluded.record, updated_at = excluded.updated_at`,
          [sessionId, Number(prior?.revision ?? 0) + 1, json(value), now],
        );
      }
      const priorRun = this.runState(sessionId);
      const changeSeq = priorRun.changeSeq + 1;
      const since =
        priorRun.since === new Date(0).toISOString()
          ? new Date(now).toISOString()
          : priorRun.since;
      this.db.run(
        `INSERT INTO session_kernel_state
				 (session_id, run_state, run_since, last_event, generation,
				  current_run_id, change_seq, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET
				 change_seq = excluded.change_seq, updated_at = excluded.updated_at`,
        [
          sessionId,
          priorRun.state,
          since,
          priorRun.lastEvent ?? null,
          priorRun.generation,
          priorRun.currentRunId ?? null,
          changeSeq,
          now,
        ],
      );
      this.db.run(
        `INSERT INTO session_kernel_changes
				 (session_id, change_seq, kind, payload, created_at)
				 VALUES (?, ?, 'ask_state', ?, ?)`,
        [sessionId, changeSeq, json({ active: value !== undefined }), now],
      );
      nextRunState = { ...priorRun, since, changeSeq };
    });
    tx.immediate();
    this.runStateCache.set(sessionId, nextRunState);
    this.dirtyChangeSessions.add(sessionId);
    return existed;
  }

  setAskRecord(sessionId: string, value: unknown): void {
    this.mutateAskRecord(sessionId, value);
  }

  /** Settle one pending ask durably under the caller's retry identity.
   * Idempotent: the same requestId replays matched; a different caller
   * against an already-answered ask is rejected. The gateway-side
   * `answerReceived` flag is deliberately left to the resolvers, whose
   * side effects (escalation cancel, broadcast, persistence) read it. */
  answerAskRecord(
    sessionId: string,
    questionId: string | null,
    answers: Record<string, string> | null,
    answeredVia: string,
  ): { matched: boolean } {
    const record = this.askSnapshot(sessionId) as
      | {
          questionId?: string;
          answer?: {
            requestId: string;
            answers: Record<string, string> | null;
          };
        }
      | undefined;
    if (!record) return { matched: false };
    if (record.answer)
      return {
        matched: record.answer.requestId === answeredVia,
        // An exact replay must resolve with the already-committed answers,
        // never the retry call's payload.
        ...(record.answer.requestId === answeredVia
          ? { answers: record.answer.answers }
          : {}),
      };
    if (questionId !== null && (record.questionId ?? null) !== questionId)
      return { matched: false };
    this.setAskRecord(sessionId, {
      ...record,
      answer: { requestId: answeredVia, answers },
    });
    return { matched: true };
  }

  deleteAskRecord(sessionId: string): boolean {
    return this.mutateAskRecord(sessionId, undefined);
  }

  clearAskRecords(): void {
    for (const [sessionId] of this.askEntries())
      this.deleteAskRecord(sessionId);
  }

  private deliveryRow(sessionId: string): DurableDeliveryState {
    const row = this.db
      .query(
        "SELECT revision, queued, dispatch, interrupt, steered, pending_steers, updated_at FROM session_kernel_delivery WHERE session_id = ?",
      )
      .get(sessionId) as Record<string, unknown> | null;
    if (!row)
      return {
        revision: 0,
        queued: [],
        steered: [],
        pendingSteers: [],
        updatedAt: 0,
      };
    return {
      revision: Number(row.revision),
      queued: parsed<unknown[]>(String(row.queued)) ?? [],
      dispatch: parsed(row.dispatch as string | null),
      interrupt: parsed(row.interrupt as string | null),
      steered: parsed<unknown[]>(String(row.steered)) ?? [],
      pendingSteers:
        parsed<DurableDeliveryState["pendingSteers"]>(
          String(row.pending_steers),
        ) ?? [],
      updatedAt: Number(row.updated_at),
    };
  }

  private commandSettlementMayRecover(record: DurableCommandRecord): boolean {
    if (record.status === "processing") return true;
    if (
      record.status === "indeterminate" &&
      record.error === "actor restarted after execution began"
    )
      return true;
    return (
      record.status === "failed" &&
      record.replaySafe &&
      record.retryable === true &&
      (record.error === "actor restarted before acknowledgement" ||
        record.error === "actor restarted before execution admission")
    );
  }

  requestGatewayCommand(input: {
    sessionId: string;
    requestId: string;
    operation: import("./gateway-command-protocol").GatewayCommandOperation;
    identity?: unknown;
  }):
    | { status: "execute" }
    | { status: "in_progress" }
    | { status: "completed"; result: unknown; duplicate: true } {
    if (!input.requestId || input.requestId.length > 256)
      throw new Error("Invalid gateway command intent");
    if (this.isTombstoned(input.sessionId)) {
      if (input.operation === "delete_session")
        return {
          status: "completed",
          result: { status: 200, body: { ok: true } },
          duplicate: true,
        };
      if (input.operation === "transcript_delete") return { status: "execute" };
      throw new Error(`Session ${input.sessionId} was deleted`);
    }
    const record = this.acceptCommand({
      sessionId: input.sessionId,
      requestId: input.requestId,
      type: input.operation,
      payload: input.identity,
      replaySafe: DESTINATION_IDEMPOTENT_GATEWAY_OPERATIONS.has(
        input.operation,
      ),
    });
    if (record.status === "completed")
      return { status: "completed", result: record.result, duplicate: true };
    if (record.status === "processing") return { status: "in_progress" };
    if (
      record.status === "indeterminate" ||
      (record.status === "failed" && (!record.retryable || !record.replaySafe))
    )
      throw new Error(record.error || "Gateway command failed");
    this.markProcessing(input.sessionId, input.requestId);
    return { status: "execute" };
  }

  completeGatewayCommand(input: {
    sessionId: string;
    requestId: string;
    operation: import("./gateway-command-protocol").GatewayCommandOperation;
    result: unknown;
  }): unknown {
    const record = this.command(input.sessionId, input.requestId);
    if (!record || record.type !== input.operation) {
      if (
        (input.operation === "delete_session" ||
          input.operation === "transcript_delete") &&
        this.isTombstoned(input.sessionId)
      )
        return input.result;
      throw new Error("Gateway command receipt is missing");
    }
    if (record.status === "completed") return record.result;
    if (!this.commandSettlementMayRecover(record))
      throw new Error(record.error || "Gateway command is not executing");
    this.completeCommand(input.sessionId, input.requestId, input.result);
    return input.result;
  }

  failGatewayCommand(input: {
    sessionId: string;
    requestId: string;
    operation: import("./gateway-command-protocol").GatewayCommandOperation;
    error: string;
    retryable: boolean;
  }): void {
    const record = this.command(input.sessionId, input.requestId);
    if (!record || record.type !== input.operation) {
      if (
        (input.operation === "delete_session" ||
          input.operation === "transcript_delete") &&
        this.isTombstoned(input.sessionId)
      )
        return;
      throw new Error("Gateway command receipt is missing");
    }
    if (record.status === "completed") return;
    if (!this.commandSettlementMayRecover(record))
      throw new Error(record.error || "Gateway command is not executing");
    this.failCommand(
      input.sessionId,
      input.requestId,
      input.error,
      input.retryable,
    );
  }

  requestSubmitPromptCommand(input: {
    sessionId: string;
    requestId: string;
    identity: unknown;
  }):
    | { status: "execute" }
    | { status: "in_progress" }
    | { status: "completed"; result: unknown; duplicate: true } {
    if (!input.requestId || input.requestId.length > 256)
      throw new Error("Invalid submit prompt command intent");
    if (this.isTombstoned(input.sessionId))
      throw new Error(`Session ${input.sessionId} was deleted`);
    const record = this.acceptCommand({
      sessionId: input.sessionId,
      requestId: input.requestId,
      type: "submit_prompt",
      payload: input.identity,
      replaySafe: true,
    });
    if (record.status === "completed")
      return { status: "completed", result: record.result, duplicate: true };
    if (record.status === "processing") return { status: "in_progress" };
    if (
      record.status === "indeterminate" ||
      (record.status === "failed" && (!record.retryable || !record.replaySafe))
    )
      throw new Error(record.error || "Submit prompt command failed");
    this.markProcessing(input.sessionId, input.requestId);
    return { status: "execute" };
  }

  completeSubmitPromptCommand(input: {
    sessionId: string;
    requestId: string;
    result: unknown;
  }): unknown {
    const record = this.command(input.sessionId, input.requestId);
    if (!record || record.type !== "submit_prompt")
      throw new Error("Submit prompt command receipt is missing");
    if (record.status === "completed") return record.result;
    if (!this.commandSettlementMayRecover(record))
      throw new Error(record.error || "Submit prompt command failed");
    this.completeCommand(input.sessionId, input.requestId, input.result);
    return input.result;
  }

  failSubmitPromptCommand(input: {
    sessionId: string;
    requestId: string;
    error: string;
  }): void {
    const record = this.command(input.sessionId, input.requestId);
    if (!record || record.type !== "submit_prompt")
      throw new Error("Submit prompt command receipt is missing");
    if (record.status === "completed") return;
    this.failCommand(input.sessionId, input.requestId, input.error, false);
  }

  deliverySnapshot(sessionId: string): DurableDeliveryState {
    return this.deliveryRow(sessionId);
  }

  deliveryEntries(slot: DeliverySlot): Array<[string, unknown]> {
    const column =
      slot === "queued"
        ? "queued"
        : slot === "steered"
          ? "steered"
          : "dispatch";
    const rows = this.db
      .query(
        `SELECT session_id, ${column} AS value FROM session_kernel_delivery
			 WHERE ${column} IS NOT NULL${slot === "dispatch" ? "" : ` AND ${column} != '[]'`}`,
      )
      .all() as Array<{ session_id: string; value: string }>;
    return rows.map((row) => [row.session_id, parsed(row.value)]);
  }

  private writeDeliveryRow(
    sessionId: string,
    state: DurableDeliveryState,
  ): void {
    this.db.run(
      `INSERT INTO session_kernel_delivery
       (session_id, revision, queued, dispatch, interrupt, steered, pending_steers, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
       revision = excluded.revision, queued = excluded.queued,
       dispatch = excluded.dispatch, interrupt = excluded.interrupt,
       steered = excluded.steered,
       pending_steers = excluded.pending_steers,
       updated_at = excluded.updated_at`,
      [
        sessionId,
        state.revision,
        json(state.queued),
        state.dispatch === undefined ? null : json(state.dispatch),
        state.interrupt === undefined ? null : json(state.interrupt),
        json(state.steered),
        json(state.pendingSteers),
        state.updatedAt,
      ],
    );
  }

  private mutateDelivery(
    sessionId: string,
    kind: string,
    mutate: (state: DurableDeliveryState) => unknown,
  ): { state: DurableDeliveryState; result: unknown } {
    if (this.isTombstoned(sessionId))
      throw new Error(`Session ${sessionId} was deleted`);
    let state!: DurableDeliveryState;
    let result: unknown;
    let nextRunState!: DurableRunState;
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const priorDelivery = this.deliveryRow(sessionId);
      const working: DurableDeliveryState = {
        ...priorDelivery,
        queued: [...priorDelivery.queued],
        steered: [...priorDelivery.steered],
        pendingSteers: [...priorDelivery.pendingSteers],
      };
      // Creation owns its opening dispatch until the opening effect settles.
      // A crash can commit that terminal settlement before the follow-up
      // ack_dispatch runs. Leaving the create dispatch behind permanently blocks
      // every later idle prompt with "A prompt dispatch is already active".
      // Retire only an exactly completed opening effect, never an ambiguous one.
      const dispatch = working.dispatch as
        | { promptEntryId?: string; kind?: string }
        | undefined;
      const openingEffectId = dispatch?.promptEntryId
        ? `opening:${dispatch.promptEntryId}`
        : undefined;
      if (
        kind !== "delivery_dispatch_acknowledged" &&
        kind !== "delivery_dispatch_failed" &&
        dispatch?.kind === "create" &&
        openingEffectId
      ) {
        const creation = this.creationState(sessionId);
        if (
          creation &&
          ["ready", "failed", "cancelled"].includes(creation.state) &&
          creation.completedEffectIds.includes(openingEffectId)
        ) {
          working.dispatch = undefined;
        }
      }
      result = mutate(working);
      state = {
        ...working,
        revision: priorDelivery.revision + 1,
        updatedAt: now,
      };
      this.db.run(
        `INSERT INTO session_kernel_delivery
				 (session_id, revision, queued, dispatch, interrupt, steered, pending_steers, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET
				 revision = excluded.revision, queued = excluded.queued,
				 dispatch = excluded.dispatch, interrupt = excluded.interrupt,
					 steered = excluded.steered,
				 pending_steers = excluded.pending_steers,
				 updated_at = excluded.updated_at`,
        [
          sessionId,
          state.revision,
          json(state.queued),
          state.dispatch === undefined ? null : json(state.dispatch),
          state.interrupt === undefined ? null : json(state.interrupt),
          json(state.steered),
          json(state.pendingSteers),
          now,
        ],
      );
      const priorRun = this.runState(sessionId);
      const changeSeq = priorRun.changeSeq + 1;
      const since =
        priorRun.since === new Date(0).toISOString()
          ? new Date(now).toISOString()
          : priorRun.since;
      this.db.run(
        `INSERT INTO session_kernel_state
				 (session_id, run_state, run_since, last_event, generation,
				  current_run_id, change_seq, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET
				 change_seq = excluded.change_seq, updated_at = excluded.updated_at`,
        [
          sessionId,
          priorRun.state,
          since,
          priorRun.lastEvent ?? null,
          priorRun.generation,
          priorRun.currentRunId ?? null,
          changeSeq,
          now,
        ],
      );
      this.db.run(
        `INSERT INTO session_kernel_changes
				 (session_id, change_seq, kind, payload, created_at)
				 VALUES (?, ?, ?, ?, ?)`,
        [sessionId, changeSeq, kind, json({ revision: state.revision }), now],
      );
      nextRunState = { ...priorRun, since, changeSeq };
    });
    tx.immediate();
    this.runStateCache.set(sessionId, nextRunState);
    this.dirtyChangeSessions.add(sessionId);
    return { state, result };
  }

  setDeliverySlot(sessionId: string, slot: DeliverySlot, value: unknown): void {
    this.mutateDelivery(sessionId, `delivery_${slot}_set`, (state) => {
      if (slot === "queued") state.queued = Array.isArray(value) ? value : [];
      else if (slot === "steered")
        state.steered = Array.isArray(value) ? value : [];
      else state.dispatch = value;
    });
  }

  enqueueDelivery(sessionId: string, item: unknown, front = false): boolean {
    return this.mutateDelivery(
      sessionId,
      "delivery_queued_enqueue",
      (state) => {
        const queue = state.queued as Array<{ id?: string }>;
        const id =
          item && typeof item === "object"
            ? (item as { id?: unknown }).id
            : undefined;
        if (typeof id === "string" && queue.some((queued) => queued.id === id))
          return false;
        if (front) queue.unshift(item as { id?: string });
        else queue.push(item as { id?: string });
        return true;
      },
    ).result as boolean;
  }

  promoteQueuedDelivery(
    sessionId: string,
    itemId: string,
    promptEntryId: string,
    directItem?: unknown,
  ): unknown | undefined {
    if (!itemId || !promptEntryId || promptEntryId.length > 256)
      throw new Error("Invalid promoted prompt identity");
    return this.mutateDelivery(
      sessionId,
      "delivery_queued_promoted",
      (state) => {
        const queue = state.queued as Array<
          Record<string, unknown> & { id?: string }
        >;
        const index = queue.findIndex((item) => item.id === itemId);
        if (index < 0 && directItem === undefined) return undefined;
        const queuedItem = index >= 0 ? queue.splice(index, 1)[0] : undefined;
        const item = {
          ...(queuedItem ?? {}),
          ...(directItem && typeof directItem === "object"
            ? (directItem as Record<string, unknown>)
            : {}),
          id: itemId,
          promptEntryId,
        };
        // "Send now" outranks ordinary queued work if physical steering cannot
        // target the run. It is still queue-owned recovery state, not a composer
        // row, because promptEntryId marks it as already sent.
        state.queued = [
          item,
          ...queue.filter((candidate) => candidate.id !== itemId),
        ];
        return item;
      },
    ).result;
  }

  deleteDeliverySlot(sessionId: string, slot: DeliverySlot): boolean {
    const prior = this.deliveryRow(sessionId);
    const existed =
      slot === "dispatch"
        ? prior.dispatch !== undefined
        : (slot === "queued" ? prior.queued : prior.steered).length > 0;
    if (!existed) return false;
    this.mutateDelivery(sessionId, `delivery_${slot}_delete`, (state) => {
      if (slot === "queued") state.queued = [];
      else if (slot === "steered") state.steered = [];
      else state.dispatch = undefined;
    });
    return true;
  }

  clearDeliverySlot(slot: DeliverySlot): void {
    for (const [sessionId] of this.deliveryEntries(slot))
      this.deleteDeliverySlot(sessionId, slot);
  }

  prepareSteerDelivery(
    sessionId: string,
    itemId: string,
    target: DurableSteerTarget,
    directItem?: unknown,
  ): unknown | undefined {
    return this.mutateDelivery(
      sessionId,
      "delivery_steer_prepared",
      (state) => {
        const run = this.runState(sessionId);
        if (
          run.currentRunId !== target.runId ||
          run.generation !== target.generation
        )
          return undefined;
        const queue = state.queued as Array<{ id?: string }>;
        const index = queue.findIndex((item) => item.id === itemId);
        if (index < 0 && directItem === undefined) return undefined;
        const queuedItem = index >= 0 ? queue.splice(index, 1)[0] : undefined;
        const item =
          directItem && typeof directItem === "object"
            ? {
                ...(queuedItem as Record<string, unknown> | undefined),
                ...(directItem as Record<string, unknown>),
                id: itemId,
              }
            : (queuedItem ?? { id: itemId, value: directItem });
        state.queued = queue;
        state.pendingSteers.push({
          item,
          index: index >= 0 ? index : 0,
          preparedAt: Date.now(),
          target,
        });
        return item;
      },
    ).result;
  }

  acceptSteerDelivery(
    sessionId: string,
    itemId: string,
    target: DurableSteerTarget,
  ): boolean {
    return this.mutateDelivery(
      sessionId,
      "delivery_steer_accepted",
      (state) => {
        const run = this.runState(sessionId);
        if (
          run.currentRunId !== target.runId ||
          run.generation !== target.generation
        )
          return false;
        const index = state.pendingSteers.findIndex(
          (pending) =>
            (pending.item as { id?: string }).id === itemId &&
            pending.target?.token === target.token &&
            pending.target.runId === target.runId &&
            pending.target.generation === target.generation,
        );
        if (index < 0) return false;
        const [pending] = state.pendingSteers.splice(index, 1);
        state.steered.push({
          ...(pending.item as Record<string, unknown>),
          steeredAt: Date.now(),
        });
        return true;
      },
    ).result as boolean;
  }

  rejectSteerDelivery(
    sessionId: string,
    itemId: string,
    target: DurableSteerTarget,
  ): boolean {
    return this.mutateDelivery(
      sessionId,
      "delivery_steer_rejected",
      (state) => {
        const index = state.pendingSteers.findIndex(
          (pending) =>
            (pending.item as { id?: string }).id === itemId &&
            pending.target?.token === target.token &&
            pending.target.runId === target.runId &&
            pending.target.generation === target.generation,
        );
        if (index < 0) return false;
        const [pending] = state.pendingSteers.splice(index, 1);
        state.queued.splice(
          Math.min(pending.index, state.queued.length),
          0,
          pending.item,
        );
        return true;
      },
    ).result as boolean;
  }

  requeueSteerDeliveries(sessionId: string, items: unknown[]): number {
    if (items.length === 0 && this.deliveryRow(sessionId).steered.length === 0)
      return 0;
    this.mutateDelivery(sessionId, "delivery_steers_requeued", (state) => {
      const ids = new Set(
        (items as Array<{ id?: string }>)
          .map((item) => item.id)
          .filter(Boolean),
      );
      state.queued = [
        ...items,
        ...(state.queued as Array<{ id?: string }>).filter(
          (item) => !item.id || !ids.has(item.id),
        ),
      ];
      state.steered = [];
    });
    return items.length;
  }

  hasPendingSteers(): boolean {
    return !!this.db
      .query(
        "SELECT 1 FROM session_kernel_delivery WHERE pending_steers != '[]' LIMIT 1",
      )
      .get();
  }

  settlePendingSteers(): number {
    const rows = this.db
      .query(
        "SELECT session_id FROM session_kernel_delivery WHERE pending_steers != '[]'",
      )
      .all() as Array<{ session_id: string }>;
    let count = 0;
    for (const row of rows) {
      this.mutateDelivery(
        row.session_id,
        "delivery_steer_recovered",
        (state) => {
          for (const pending of state.pendingSteers) {
            state.steered.push({
              ...(pending.item as Record<string, unknown>),
              steeredAt: pending.preparedAt,
            });
            count += 1;
          }
          state.pendingSteers = [];
        },
      );
    }
    return count;
  }

  turnSnapshot(sessionId: string): DurableTurnState {
    const row = this.db
      .query(
        "SELECT revision, cancel, updated_at FROM session_kernel_turn WHERE session_id = ?",
      )
      .get(sessionId) as {
      revision: number;
      cancel: string | null;
      updated_at: number;
    } | null;
    return row
      ? {
          revision: Number(row.revision),
          cancel: parsed(row.cancel),
          updatedAt: Number(row.updated_at),
        }
      : { revision: 0, updatedAt: 0 };
  }

  requestTurnCancelCommand(input: {
    sessionId: string;
    requestId: string;
    fallbackRunId: string | null;
  }):
    | {
        status: "execute";
        targetRunId: string;
        targetRunGeneration: number;
      }
    | { status: "completed"; result: boolean; duplicate: boolean } {
    if (
      !input.requestId ||
      input.requestId.length > 256 ||
      (input.fallbackRunId !== null &&
        (!input.fallbackRunId || input.fallbackRunId.length > 256))
    )
      throw new Error("Invalid cancel command intent");
    if (this.isTombstoned(input.sessionId))
      throw new Error(`Session ${input.sessionId} was deleted`);

    const existing = this.command(input.sessionId, input.requestId);
    if (existing) {
      if (existing.type !== "cancel_session")
        throw new Error(
          `Session command id ${input.requestId} was reused with another operation`,
        );
      if (existing.status === "completed")
        return {
          status: "completed",
          result: existing.result === true,
          duplicate: true,
        };
      if (
        existing.status === "indeterminate" ||
        (existing.status === "failed" &&
          (!existing.retryable || !existing.replaySafe))
      )
        throw new Error(existing.error || "Session cancel command failed");
      const payload = existing.payload as {
        targetRunId?: unknown;
        targetRunGeneration?: unknown;
      } | null;
      const targetRunId = payload?.targetRunId;
      const targetRunGeneration = payload?.targetRunGeneration;
      if (
        targetRunId === null &&
        Number.isSafeInteger(targetRunGeneration) &&
        Number(targetRunGeneration) >= 0
      ) {
        this.completeCommand(input.sessionId, input.requestId, false);
        return { status: "completed", result: false, duplicate: true };
      }
      if (
        typeof targetRunId !== "string" ||
        !targetRunId ||
        !Number.isSafeInteger(targetRunGeneration) ||
        Number(targetRunGeneration) < 0
      )
        throw new Error("Durable cancel command target is invalid");
      this.markProcessing(input.sessionId, input.requestId);
      return {
        status: "execute",
        targetRunId,
        targetRunGeneration: Number(targetRunGeneration),
      };
    }

    const priorCancel = this.turnSnapshot(input.sessionId).cancel;
    const cancelId = `stop:${input.requestId}`;
    const priorRun = this.runState(input.sessionId);
    const replayedTarget =
      priorCancel?.cancelId === cancelId
        ? {
            runId: priorCancel.runId,
            generation: priorCancel.runGeneration,
          }
        : undefined;
    const targetRunId =
      replayedTarget?.runId ||
      priorRun.currentRunId ||
      (priorRun.state === "starting" || priorRun.state === "preparing"
        ? input.fallbackRunId
        : null);
    const targetRunGeneration =
      replayedTarget?.generation ?? priorRun.generation;
    this.acceptCommand({
      sessionId: input.sessionId,
      requestId: input.requestId,
      type: "cancel_session",
      payload: { targetRunId, targetRunGeneration },
      replaySafe: true,
    });
    if (!targetRunId) {
      this.completeCommand(input.sessionId, input.requestId, false);
      return { status: "completed", result: false, duplicate: false };
    }
    this.markProcessing(input.sessionId, input.requestId);
    return {
      status: "execute",
      targetRunId,
      targetRunGeneration,
    };
  }

  completeTurnCancelCommand(input: {
    sessionId: string;
    requestId: string;
    result: boolean;
  }): boolean {
    const record = this.command(input.sessionId, input.requestId);
    if (!record || record.type !== "cancel_session")
      throw new Error("Cancel command receipt is missing");
    if (record.status === "completed") return record.result === true;
    if (record.status === "indeterminate" || record.status === "failed")
      throw new Error(record.error || "Session cancel command failed");
    const payload = record.payload as {
      targetRunId?: unknown;
      targetRunGeneration?: unknown;
    } | null;
    if (input.result) {
      const cancel = this.turnSnapshot(input.sessionId).cancel;
      if (
        cancel?.cancelId !== `stop:${input.requestId}` ||
        cancel.runId !== payload?.targetRunId ||
        cancel.runGeneration !== payload?.targetRunGeneration
      )
        throw new Error("Cancel command completed without its durable receipt");
    }
    this.completeCommand(input.sessionId, input.requestId, input.result);
    return input.result;
  }

  failTurnCancelCommand(input: {
    sessionId: string;
    requestId: string;
    error: string;
  }): void {
    const record = this.command(input.sessionId, input.requestId);
    if (!record || record.type !== "cancel_session")
      throw new Error("Cancel command receipt is missing");
    if (record.status === "completed") return;
    this.failCommand(input.sessionId, input.requestId, input.error, false);
  }

  prepareTurnCancel(input: {
    sessionId: string;
    cancelId: string;
    expectedRunId: string;
    expectedGeneration: number;
    dispatchId: string;
    requeueIds: string[];
    source: string;
    user?: string;
  }): {
    cancel: NonNullable<DurableTurnState["cancel"]>;
    runState: DurableRunState;
  } {
    if (
      !input.cancelId ||
      input.cancelId.length > 256 ||
      !input.expectedRunId ||
      input.expectedRunId.length > 256 ||
      !Number.isSafeInteger(input.expectedGeneration) ||
      input.expectedGeneration < 0 ||
      !input.dispatchId ||
      input.dispatchId.length > 256 ||
      input.dispatchId !== input.expectedRunId ||
      input.requeueIds.length > 256 ||
      input.requeueIds.some((id) => !id || id.length > 256) ||
      !input.source ||
      input.source.length > 100 ||
      (input.user !== undefined && (!input.user || input.user.length > 200))
    )
      throw new Error("Invalid turn cancel intent");
    if (this.isTombstoned(input.sessionId))
      throw new Error(`Session ${input.sessionId} was deleted`);
    let result!: NonNullable<DurableTurnState["cancel"]>;
    let nextRun!: DurableRunState;
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const priorTurn = this.turnSnapshot(input.sessionId);
      if (priorTurn.cancel?.cancelId === input.cancelId) {
        if (
          priorTurn.cancel.runId !== input.expectedRunId ||
          priorTurn.cancel.runGeneration !== input.expectedGeneration ||
          json(priorTurn.cancel.requeueIds) !== json(input.requeueIds) ||
          priorTurn.cancel.source !== input.source ||
          priorTurn.cancel.user !== input.user
        )
          throw new Error(
            "Turn cancel identity was reused with another payload",
          );
        result = priorTurn.cancel;
        nextRun = this.runState(input.sessionId);
        return;
      }
      const priorRun = this.runState(input.sessionId);
      const ownsTarget =
        priorRun.currentRunId === input.expectedRunId ||
        (!priorRun.currentRunId &&
          (priorRun.state === "starting" || priorRun.state === "preparing") &&
          input.dispatchId === input.expectedRunId);
      if (!ownsTarget || priorRun.generation !== input.expectedGeneration)
        throw new Error("The run targeted by this cancel has already changed");
      const reducedState = nextRunState(priorRun.state as RunState, "cancel");
      if (!reducedState)
        throw new Error(`Cannot cancel a run while ${priorRun.state}`);
      // Explicit Stop parks accepted delivery even when physical setup has not
      // reached journal registration yet. The generic preparing→cancel reducer
      // returns idle for non-turn workspace preparation; this operation is the
      // stronger user intent and remains stopped until their next prompt.
      const targetState =
        priorRun.state === "preparing" ? "stopped" : reducedState;

      const priorDelivery = this.deliveryRow(input.sessionId);
      const steered = priorDelivery.steered as QueueItem[];
      const requeueIds = new Set(input.requeueIds);
      const requeued = steered.filter(
        (item) => typeof item.id === "string" && requeueIds.has(item.id),
      );
      if (requeued.length !== requeueIds.size)
        throw new Error("A cancel requeue receipt is no longer actor-owned");
      const duplicateIds = new Set(requeued.map((item) => item.id));
      const delivery: DurableDeliveryState = {
        ...priorDelivery,
        revision: priorDelivery.revision + 1,
        queued: [
          ...requeued,
          ...(priorDelivery.queued as QueueItem[]).filter(
            (item) => !duplicateIds.has(item.id),
          ),
        ],
        steered: [],
        pendingSteers: [...priorDelivery.pendingSteers],
        updatedAt: now,
      };
      this.writeDeliveryRow(input.sessionId, delivery);

      result = {
        cancelId: input.cancelId,
        phase: "prepared",
        runId: input.expectedRunId,
        runGeneration: input.expectedGeneration,
        requeueIds: [...input.requeueIds],
        source: input.source,
        ...(input.user ? { user: input.user } : {}),
      };
      this.db.run(
        `INSERT INTO session_kernel_turn (session_id, revision, cancel, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
         revision = excluded.revision, cancel = excluded.cancel,
         updated_at = excluded.updated_at`,
        [input.sessionId, priorTurn.revision + 1, json(result), now],
      );
      const changeSeq = priorRun.changeSeq + 1;
      const since = new Date(now).toISOString();
      this.db.run(
        `UPDATE session_kernel_state SET run_state = ?, run_since = ?,
         last_event = 'cancel', current_run_id = NULL, change_seq = ?, updated_at = ?
         WHERE session_id = ?`,
        [targetState, since, changeSeq, now, input.sessionId],
      );
      this.db.run(
        `INSERT INTO session_kernel_changes
         (session_id, change_seq, kind, payload, created_at)
         VALUES (?, ?, 'turn_cancel_prepared', ?, ?)`,
        [
          input.sessionId,
          changeSeq,
          json({
            cancelId: input.cancelId,
            runId: input.expectedRunId,
            runGeneration: input.expectedGeneration,
            deliveryRevision: delivery.revision,
            source: input.source,
            ...(input.user ? { user: input.user } : {}),
          }),
          now,
        ],
      );
      this.enqueueOutbox(
        input.sessionId,
        "turn_cancel",
        {
          cancelId: input.cancelId,
          dispatchId: input.dispatchId,
          runGeneration: input.expectedGeneration,
        },
        input.cancelId,
      );
      nextRun = {
        ...priorRun,
        state: targetState,
        since,
        lastEvent: "cancel",
        currentRunId: undefined,
        changeSeq,
      };
    });
    tx.immediate();
    this.runStateCache.set(input.sessionId, nextRun);
    this.dirtyChangeSessions.add(input.sessionId);
    return { cancel: result, runState: nextRun };
  }

  beginTurnCancelEffect(input: {
    sessionId: string;
    cancelId: string;
    runGeneration: number;
  }): "execute" | "retry" | "adopt_confirmed" | "settled" | "missing" {
    const prior = this.turnSnapshot(input.sessionId).cancel;
    if (!prior || prior.cancelId !== input.cancelId) return "missing";
    if (prior.phase === "settled") return "settled";
    if (
      prior.runGeneration !== input.runGeneration ||
      this.runState(input.sessionId).generation !== input.runGeneration
    )
      return "adopt_confirmed";
    if (prior.phase === "executing") return "retry";
    this.updateTurnCancel(input.sessionId, { ...prior, phase: "executing" });
    return "execute";
  }

  settleTurnCancel(input: {
    sessionId: string;
    cancelId: string;
    outcome: "confirmed" | "not_aborted";
  }): boolean {
    const prior = this.turnSnapshot(input.sessionId).cancel;
    if (!prior || prior.cancelId !== input.cancelId) return false;
    if (prior.phase === "settled") return true;
    this.updateTurnCancel(input.sessionId, {
      ...prior,
      phase: "settled",
      outcome: input.outcome,
    });
    return true;
  }

  private turnOutcomeProjection(
    sessionId: string,
    projectionId: string,
  ): DurableTurnOutcomeProjection | undefined {
    const row = this.db
      .query(
        `SELECT phase, payload FROM session_kernel_turn_projections
         WHERE session_id = ? AND projection_id = ?`,
      )
      .get(sessionId, projectionId) as {
      phase: "pending" | "completed" | "superseded";
      payload: string;
    } | null;
    if (!row) return undefined;
    return {
      ...(parsed(row.payload) as Omit<DurableTurnOutcomeProjection, "phase">),
      phase: row.phase,
    };
  }

  prepareTurnOutcomeProjection(input: {
    sessionId: string;
    projectionId: string;
    runId: string;
    runGeneration: number;
    errorMessage: string | null;
    engineSessionId?: string;
    noticePersisted: boolean;
    noticeLabel?: string;
    projectedAt: string;
  }): DurableTurnOutcomeProjection | "stale" {
    if (
      !input.projectionId ||
      input.projectionId.length > 256 ||
      !input.runId ||
      input.runId.length > 256 ||
      !Number.isSafeInteger(input.runGeneration) ||
      input.runGeneration < 1 ||
      (input.errorMessage !== null && input.errorMessage.length > 500) ||
      (input.engineSessionId !== undefined &&
        (!input.engineSessionId || input.engineSessionId.length > 256)) ||
      typeof input.noticePersisted !== "boolean" ||
      (input.noticeLabel !== undefined &&
        (!input.noticeLabel || input.noticeLabel.length > 100)) ||
      !input.projectedAt ||
      input.projectedAt.length > 64 ||
      !Number.isFinite(Date.parse(input.projectedAt))
    )
      throw new Error("Invalid turn outcome projection");
    if (this.isTombstoned(input.sessionId))
      throw new Error(`Session ${input.sessionId} was deleted`);
    const payload: Omit<DurableTurnOutcomeProjection, "phase"> = {
      projectionId: input.projectionId,
      runId: input.runId,
      runGeneration: input.runGeneration,
      errorMessage: input.errorMessage,
      ...(input.engineSessionId
        ? { engineSessionId: input.engineSessionId }
        : {}),
      noticePersisted: input.noticePersisted,
      ...(input.noticeLabel ? { noticeLabel: input.noticeLabel } : {}),
      projectedAt: input.projectedAt,
    };
    const existing = this.turnOutcomeProjection(
      input.sessionId,
      input.projectionId,
    );
    if (existing) {
      const { phase: _phase, ...existingPayload } = existing;
      if (JSON.stringify(existingPayload) !== JSON.stringify(payload))
        throw new Error(
          "Turn outcome projection identity was reused with another payload",
        );
      return existing;
    }
    const priorRun = this.runState(input.sessionId);
    const cancel = this.turnSnapshot(input.sessionId).cancel;
    if (
      priorRun.generation !== input.runGeneration ||
      (priorRun.currentRunId !== undefined &&
        priorRun.currentRunId !== input.runId) ||
      (cancel?.runId === input.runId &&
        cancel.runGeneration === input.runGeneration &&
        cancel.phase === "settled" &&
        cancel.outcome === "confirmed")
    )
      return "stale";
    const generationOwner = this.db
      .query(
        `SELECT projection_id FROM session_kernel_turn_projections
         WHERE session_id = ? AND generation = ? LIMIT 1`,
      )
      .get(input.sessionId, input.runGeneration) as {
      projection_id: string;
    } | null;
    if (generationOwner)
      throw new Error("Turn outcome projection generation is already owned");

    const now = Date.now();
    const changeSeq = priorRun.changeSeq + 1;
    const tx = this.db.transaction(() => {
      this.db.run(
        `INSERT INTO session_kernel_turn_projections
         (session_id, projection_id, generation, phase, payload, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
        [
          input.sessionId,
          input.projectionId,
          input.runGeneration,
          json(payload),
          now,
        ],
      );
      this.db.run(
        `UPDATE session_kernel_state SET change_seq = ?, updated_at = ?
         WHERE session_id = ?`,
        [changeSeq, now, input.sessionId],
      );
      this.db.run(
        `INSERT INTO session_kernel_changes
         (session_id, change_seq, kind, payload, created_at)
         VALUES (?, ?, 'turn_outcome_projection_prepared', ?, ?)`,
        [input.sessionId, changeSeq, json(payload), now],
      );
      this.enqueueOutbox(
        input.sessionId,
        "turn_outcome_project",
        payload,
        input.projectionId,
      );
    });
    tx.immediate();
    this.runStateCache.set(input.sessionId, { ...priorRun, changeSeq });
    this.dirtyChangeSessions.add(input.sessionId);
    return { ...payload, phase: "pending" };
  }

  beginTurnOutcomeProjection(input: {
    sessionId: string;
    projectionId: string;
    runGeneration: number;
  }): "execute" | "wait" | "completed" | "missing" {
    if (this.isTombstoned(input.sessionId)) return "missing";
    const projection = this.turnOutcomeProjection(
      input.sessionId,
      input.projectionId,
    );
    if (!projection || projection.runGeneration !== input.runGeneration)
      return "missing";
    if (projection.phase === "completed") return "completed";
    if (projection.phase === "superseded") return "missing";
    const higherCompleted = this.db
      .query(
        `SELECT 1 FROM session_kernel_turn_projections
         WHERE session_id = ? AND generation > ? AND phase = 'completed'
         LIMIT 1`,
      )
      .get(input.sessionId, input.runGeneration);
    if (higherCompleted) {
      this.db.run(
        `UPDATE session_kernel_turn_projections
         SET phase = 'superseded', updated_at = ?
         WHERE session_id = ? AND projection_id = ? AND phase = 'pending'`,
        [Date.now(), input.sessionId, input.projectionId],
      );
      return "missing";
    }
    this.db.run(
      `UPDATE session_kernel_turn_projections AS p
       SET phase = 'superseded', updated_at = ?
       WHERE p.session_id = ? AND p.generation < ? AND p.phase = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM session_kernel_outbox o
           WHERE o.session_id = p.session_id
             AND o.kind = 'turn_outcome_project'
             AND o.effect_key = p.projection_id
             AND o.dead_lettered_at IS NULL
         )`,
      [Date.now(), input.sessionId, input.runGeneration],
    );
    const predecessor = this.db
      .query(
        `SELECT 1 FROM session_kernel_turn_projections p
         JOIN session_kernel_outbox o
           ON o.session_id = p.session_id
          AND o.kind = 'turn_outcome_project'
          AND o.effect_key = p.projection_id
         WHERE p.session_id = ? AND p.phase = 'pending'
           AND p.generation < ? AND o.dead_lettered_at IS NULL
         LIMIT 1`,
      )
      .get(input.sessionId, input.runGeneration);
    return predecessor ? "wait" : "execute";
  }

  settleTurnOutcomeProjection(input: {
    sessionId: string;
    projectionId: string;
    runGeneration: number;
  }): boolean {
    const projection = this.turnOutcomeProjection(
      input.sessionId,
      input.projectionId,
    );
    if (!projection || projection.runGeneration !== input.runGeneration)
      return false;
    if (projection.phase === "completed") return true;
    if (projection.phase === "superseded") return false;
    const priorRun = this.runState(input.sessionId);
    const now = Date.now();
    const changeSeq = priorRun.changeSeq + 1;
    const tx = this.db.transaction(() => {
      this.db.run(
        `UPDATE session_kernel_turn_projections
         SET phase = 'completed', updated_at = ?
         WHERE session_id = ? AND projection_id = ? AND generation = ?`,
        [now, input.sessionId, input.projectionId, input.runGeneration],
      );
      this.db.run(
        `UPDATE session_kernel_state SET change_seq = ?, updated_at = ?
         WHERE session_id = ?`,
        [changeSeq, now, input.sessionId],
      );
      this.db.run(
        `INSERT INTO session_kernel_changes
         (session_id, change_seq, kind, payload, created_at)
         VALUES (?, ?, 'turn_outcome_projection_completed', ?, ?)`,
        [input.sessionId, changeSeq, json(projection), now],
      );
    });
    tx.immediate();
    this.runStateCache.set(input.sessionId, { ...priorRun, changeSeq });
    this.dirtyChangeSessions.add(input.sessionId);
    return true;
  }

  private updateTurnCancel(
    sessionId: string,
    cancel: NonNullable<DurableTurnState["cancel"]>,
  ): void {
    const now = Date.now();
    let nextRunStateCache!: DurableRunState;
    const tx = this.db.transaction(() => {
      const priorTurn = this.turnSnapshot(sessionId);
      const priorRun = this.runState(sessionId);
      const changeSeq = priorRun.changeSeq + 1;
      this.db.run(
        `INSERT INTO session_kernel_turn (session_id, revision, cancel, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
         revision = excluded.revision, cancel = excluded.cancel,
         updated_at = excluded.updated_at`,
        [sessionId, priorTurn.revision + 1, json(cancel), now],
      );
      this.db.run(
        `UPDATE session_kernel_state SET change_seq = ?, updated_at = ?
         WHERE session_id = ?`,
        [changeSeq, now, sessionId],
      );
      this.db.run(
        `INSERT INTO session_kernel_changes
         (session_id, change_seq, kind, payload, created_at)
         VALUES (?, ?, 'turn_cancel_updated', ?, ?)`,
        [sessionId, changeSeq, json(cancel), now],
      );
      nextRunStateCache = { ...priorRun, changeSeq };
    });
    tx.immediate();
    this.runStateCache.set(sessionId, nextRunStateCache);
    this.dirtyChangeSessions.add(sessionId);
  }

  prepareDeliveryInterrupt(input: {
    sessionId: string;
    interruptId: string;
    anchorId: string;
    dispatchId: string;
    soloId?: string;
  }): {
    interruptId: string;
    phase: "prepared" | "executing" | "confirmed";
    runGeneration: number;
    anchorId: string;
    soloId?: string;
  } {
    if (
      !input.interruptId ||
      input.interruptId.length > 256 ||
      !input.anchorId ||
      input.anchorId.length > 256 ||
      !input.dispatchId ||
      input.dispatchId.length > 256 ||
      (input.soloId !== undefined &&
        (!input.soloId || input.soloId.length > 256))
    )
      throw new Error("Invalid prompt interrupt identity");
    return this.mutateDelivery(
      input.sessionId,
      "delivery_interrupt_prepared",
      (state) => {
        if (state.dispatch)
          throw new Error("A prompt dispatch is already active");
        const queued = state.queued as QueueItem[];
        const steered = state.steered as QueueItem[];
        const queuedIndex = queued.findIndex(
          (item) => item.id === input.anchorId,
        );
        const steeredIndex = steered.findIndex(
          (item) => item.id === input.anchorId,
        );
        if (queuedIndex < 0 && steeredIndex < 0)
          throw new Error("Interrupted prompt is no longer delivery-owned");
        const existing = state.interrupt;
        if (existing) {
          if (existing.interruptId === input.interruptId) {
            if (
              (existing.dispatchId &&
                existing.dispatchId !== input.dispatchId) ||
              existing.anchorId !== input.anchorId ||
              existing.soloId !== input.soloId
            )
              throw new Error(
                "Prompt interrupt identity was reused with another payload",
              );
            return existing;
          }
          throw new Error("A prompt interrupt is already pending");
        }
        const runGeneration = this.runState(input.sessionId).generation;
        const source =
          queuedIndex < 0 && steeredIndex >= 0
            ? { slot: "steered" as const, index: steeredIndex }
            : undefined;
        if (source) {
          const [receipt] = steered.splice(steeredIndex, 1);
          state.queued = [receipt, ...queued];
          state.steered = steered;
        }
        state.interrupt = {
          interruptId: input.interruptId,
          phase: "prepared",
          runGeneration,
          dispatchId: input.dispatchId,
          anchorId: input.anchorId,
          ...(input.soloId ? { soloId: input.soloId } : {}),
          ...(source ? { source } : {}),
        };
        this.enqueueOutbox(
          input.sessionId,
          "delivery_interrupt_cancel",
          {
            interruptId: input.interruptId,
            dispatchId: input.dispatchId,
            runGeneration,
          },
          input.interruptId,
        );
        return state.interrupt;
      },
    ).result as {
      interruptId: string;
      phase: "prepared" | "executing" | "confirmed";
      runGeneration: number;
      anchorId: string;
      soloId?: string;
    };
  }

  beginDeliveryInterruptEffect(input: {
    sessionId: string;
    interruptId: string;
    runGeneration: number;
  }): "execute" | "retry" | "adopt_confirmed" | "confirmed" | "settled" {
    return this.mutateDelivery(
      input.sessionId,
      "delivery_interrupt_effect_started",
      (state) => {
        const dispatchInterrupt = (
          state.dispatch as
            | { interrupt?: DurableDeliveryState["interrupt"] }
            | undefined
        )?.interrupt;
        const interrupt = state.interrupt || dispatchInterrupt;
        if (!interrupt || interrupt.interruptId !== input.interruptId)
          return "settled" as const;
        if (interrupt.phase === "confirmed") return "confirmed" as const;
        if (
          interrupt.runGeneration !== input.runGeneration ||
          this.runState(input.sessionId).generation !== input.runGeneration
        )
          return "adopt_confirmed" as const;
        if (interrupt.phase === "executing") return "retry" as const;
        state.interrupt = { ...interrupt, phase: "executing" };
        return "execute" as const;
      },
    ).result as
      | "execute"
      | "retry"
      | "adopt_confirmed"
      | "confirmed"
      | "settled";
  }

  settleDeliveryInterrupt(input: {
    sessionId: string;
    interruptId: string;
    outcome: "confirmed" | "not_aborted";
  }): boolean {
    return this.mutateDelivery(
      input.sessionId,
      "delivery_interrupt_settled",
      (state) => {
        const interrupt = state.interrupt;
        if (!interrupt || interrupt.interruptId !== input.interruptId)
          return false;
        if (input.outcome === "not_aborted") {
          if (interrupt.source?.slot === "steered") {
            const queued = state.queued as QueueItem[];
            const index = queued.findIndex(
              (item) => item.id === interrupt.anchorId,
            );
            if (index >= 0) {
              const [receipt] = queued.splice(index, 1);
              const steered = state.steered as QueueItem[];
              if (!steered.some((item) => item.id === interrupt.anchorId))
                steered.splice(
                  Math.min(interrupt.source.index, steered.length),
                  0,
                  receipt,
                );
              state.queued = queued;
              state.steered = steered;
            }
          }
          state.interrupt = undefined;
        } else state.interrupt = { ...interrupt, phase: "confirmed" };
        return true;
      },
    ).result as boolean;
  }

  claimNextDeliveryDispatch(input: {
    sessionId: string;
    promptEntryId: string;
    stillWorking?: boolean;
  }):
    | { kind: "empty"; revision: number }
    | { kind: "hold"; heldCount: number; revision: number }
    | {
        kind: "deliver";
        promptEntryId: string;
        items: QueueItem[];
        interrupted: boolean;
        revision: number;
      } {
    if (!input.promptEntryId || input.promptEntryId.length > 256)
      throw new Error("Invalid next prompt dispatch identity");
    const mutation = this.mutateDelivery(
      input.sessionId,
      "delivery_next_dispatch_claimed",
      (state) => {
        if (state.dispatch)
          throw new Error("A prompt dispatch is already active");
        const interrupt = state.interrupt;
        const queued = state.queued as QueueItem[];
        if (!queued.length) {
          state.interrupt = undefined;
          return { kind: "empty" as const };
        }
        const anchorQueued =
          interrupt !== undefined &&
          queued.some((item) => item.id === interrupt.anchorId);
        if (interrupt && !anchorQueued) state.interrupt = undefined;
        const confirmedInterrupt =
          anchorQueued && interrupt.phase === "confirmed";
        const retryDispatchId = queued.find(
          (item) => item.retryDispatchId,
        )?.retryDispatchId;
        const plan = retryDispatchId
          ? {
              kind: "deliver" as const,
              batch: queued.filter(
                (item) => item.retryDispatchId === retryDispatchId,
              ),
              rest: queued.filter(
                (item) => item.retryDispatchId !== retryDispatchId,
              ),
            }
          : selectQueueBatch(queued, {
              soloId: confirmedInterrupt ? interrupt.soloId : undefined,
              interruptMark: confirmedInterrupt,
              stillWorking: input.stillWorking,
            });
        if (plan.kind === "hold") return plan;
        const batchOwnsInterrupt =
          anchorQueued &&
          plan.batch.some((item) => item.id === interrupt.anchorId);
        if (batchOwnsInterrupt && interrupt.phase !== "confirmed")
          return { kind: "hold" as const, heldCount: plan.batch.length };
        const applyInterrupt = confirmedInterrupt && batchOwnsInterrupt;
        if (applyInterrupt) state.interrupt = undefined;
        const promptEntryId =
          retryDispatchId ||
          plan.batch[0]?.promptEntryId ||
          (plan.batch.length === 1 ? plan.batch[0]?.id : undefined) ||
          input.promptEntryId;
        if (!promptEntryId || promptEntryId.length > 256)
          throw new Error("Invalid claimed prompt dispatch identity");
        state.queued = plan.rest;
        state.dispatch = {
          promptEntryId,
          items: plan.batch,
          ...(applyInterrupt ? { interrupt } : {}),
        };
        return {
          kind: "deliver" as const,
          promptEntryId,
          items: plan.batch,
          interrupted: applyInterrupt,
        };
      },
    );
    return {
      ...(mutation.result as
        | { kind: "empty" }
        | { kind: "hold"; heldCount: number }
        | {
            kind: "deliver";
            promptEntryId: string;
            items: QueueItem[];
            interrupted: boolean;
          }),
      revision: mutation.state.revision,
    };
  }

  claimDeliveryDispatch(input: {
    sessionId: string;
    items: Array<
      { id?: string; promptEntryId?: string } & Record<string, unknown>
    >;
    promptEntryId: string;
    kind?: "create";
    requireQueued?: boolean;
  }): { promptEntryId: string; items: unknown[]; revision: number } {
    const mutation = this.mutateDelivery(
      input.sessionId,
      "delivery_dispatch_claimed",
      (state) => {
        const existing = state.dispatch as
          | { promptEntryId?: string; items?: unknown[] }
          | undefined;
        if (existing?.promptEntryId === input.promptEntryId) return existing;
        if (existing) throw new Error("A prompt dispatch is already active");
        const ids = new Set(
          input.items.flatMap(
            (item) => [item.id, item.promptEntryId].filter(Boolean) as string[],
          ),
        );
        const queued = state.queued as Array<{
          id?: string;
          promptEntryId?: string;
        }>;
        if (input.requireQueued) {
          const queuedIds = new Set(
            queued.flatMap(
              (item) =>
                [item.id, item.promptEntryId].filter(Boolean) as string[],
            ),
          );
          if (
            !input.items.every(
              (item) =>
                !!(item.id || item.promptEntryId) &&
                !![item.id, item.promptEntryId].find(
                  (id) => id && queuedIds.has(id),
                ),
            )
          )
            throw new Error("Queued prompt changed before dispatch claim");
        }
        const dispatchItems = input.items;
        state.queued = queued.filter(
          (item) =>
            !(
              (item.id && ids.has(item.id)) ||
              (item.promptEntryId && ids.has(item.promptEntryId))
            ),
        );
        state.dispatch = {
          promptEntryId: input.promptEntryId,
          items: dispatchItems,
          ...(input.kind ? { kind: input.kind } : {}),
        };
        return state.dispatch;
      },
    );
    const dispatch = mutation.result as {
      promptEntryId: string;
      items: unknown[];
    };
    return { ...dispatch, revision: mutation.state.revision };
  }

  ackDeliveryDispatch(sessionId: string, promptEntryId: string): boolean {
    const current = this.deliveryRow(sessionId).dispatch as
      | { promptEntryId?: string }
      | undefined;
    if (current?.promptEntryId !== promptEntryId) return false;
    this.mutateDelivery(
      sessionId,
      "delivery_dispatch_acknowledged",
      (state) => {
        const dispatch = state.dispatch as
          | { promptEntryId?: string }
          | undefined;
        if (dispatch?.promptEntryId !== promptEntryId)
          throw new Error("Prompt dispatch changed before acknowledgement");
        state.dispatch = undefined;
      },
    );
    return true;
  }

  failDeliveryDispatch(sessionId: string, promptEntryId: string): boolean {
    const current = this.deliveryRow(sessionId).dispatch as
      | { promptEntryId?: string }
      | undefined;
    if (current?.promptEntryId !== promptEntryId) return false;
    this.mutateDelivery(sessionId, "delivery_dispatch_failed", (state) => {
      const dispatch = state.dispatch as
        | {
            promptEntryId?: string;
            items?: unknown[];
            interrupt?: DurableDeliveryState["interrupt"];
          }
        | undefined;
      if (dispatch?.promptEntryId !== promptEntryId)
        throw new Error("Prompt dispatch changed before failure settlement");
      const restored = (dispatch.items ?? []).map((item, index) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? {
              ...(item as Record<string, unknown>),
              retryDispatchId: promptEntryId,
              ...(index === 0 ? { promptEntryId } : {}),
            }
          : item,
      );
      const restoredIds = new Set(
        (restored as Array<{ id?: string }>)
          .map((item) => item.id)
          .filter(Boolean),
      );
      state.queued = [
        ...restored,
        ...(state.queued as Array<{ id?: string }>).filter(
          (item) => !item.id || !restoredIds.has(item.id),
        ),
      ];
      if (dispatch.interrupt) {
        if (state.interrupt)
          throw new Error("A successor prompt interrupt is already pending");
        state.interrupt = { ...dispatch.interrupt, phase: "confirmed" };
      }
      state.dispatch = undefined;
    });
    return true;
  }

  beginTimerExecution(input: {
    sessionId: string;
    timerId: string;
    token: string;
  }): "execute" | "completed" | "missing" {
    if (!input.timerId || !input.token)
      throw new Error("Invalid timer execution intent");
    const timer = this.timer(input.sessionId, input.timerId);
    if (!timer || timer.token !== input.token) return "missing";
    const requestId = `timer:${input.timerId}:${input.token}`;
    const existing = this.command(input.sessionId, requestId);
    if (existing?.status === "completed") {
      this.settleTimerSuccess(input.sessionId, input.timerId, input.token);
      return "completed";
    }
    if (
      existing?.status === "indeterminate" ||
      (existing?.status === "failed" &&
        (!existing.retryable || !existing.replaySafe))
    )
      throw new Error(existing.error || "Timer execution failed");
    this.acceptCommand({
      sessionId: input.sessionId,
      requestId,
      type: "timer_fired",
      payload: {
        timerId: timer.timerId,
        kind: timer.kind,
        dueAt: timer.dueAt,
        payload: timer.payload,
      },
      replaySafe: true,
    });
    this.markProcessing(input.sessionId, requestId);
    return "execute";
  }

  completeTimerExecution(input: {
    sessionId: string;
    timerId: string;
    token: string;
  }): boolean {
    const requestId = `timer:${input.timerId}:${input.token}`;
    const record = this.command(input.sessionId, requestId);
    if (!record || record.type !== "timer_fired")
      throw new Error("Timer execution receipt is missing");
    if (record.status !== "completed")
      this.completeCommand(input.sessionId, requestId, true);
    return this.settleTimerSuccess(input.sessionId, input.timerId, input.token);
  }

  failTimerExecution(input: {
    sessionId: string;
    timerId: string;
    token: string;
    error: string;
    maxAttempts: number;
  }): { updated: boolean; deadLetteredNow: boolean } {
    if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1)
      throw new Error("Invalid timer attempt limit");
    const requestId = `timer:${input.timerId}:${input.token}`;
    const record = this.command(input.sessionId, requestId);
    if (!record || record.type !== "timer_fired")
      throw new Error("Timer execution receipt is missing");
    const settled = this.noteTimerFailure(
      input.sessionId,
      input.timerId,
      input.error,
      input.maxAttempts,
      input.token,
    );
    if (record.status !== "completed")
      this.failCommand(input.sessionId, requestId, input.error, true);
    return settled;
  }

  recordTimerRuntimeFailure(input: {
    sessionId: string;
    timerId: string;
    token: string;
    error: string;
    maxAttempts: number;
    observedAttempts: number;
  }): { updated: boolean; deadLetteredNow: boolean } {
    if (
      !Number.isSafeInteger(input.maxAttempts) ||
      input.maxAttempts < 1 ||
      !Number.isSafeInteger(input.observedAttempts) ||
      input.observedAttempts < 0
    )
      throw new Error("Invalid timer runtime failure intent");
    const current = this.timer(input.sessionId, input.timerId);
    if (!current || current.token !== input.token)
      return { updated: false, deadLetteredNow: false };
    if (current.attempts !== input.observedAttempts)
      return {
        updated: false,
        deadLetteredNow: current.deadLetteredAt !== undefined,
      };
    return this.noteTimerFailure(
      input.sessionId,
      input.timerId,
      input.error,
      input.maxAttempts,
      input.token,
    );
  }

  scheduleTimer(
    timer: Omit<
      DurableTimer,
      | "token"
      | "attempts"
      | "nextAttemptAt"
      | "lastError"
      | "deadLetteredAt"
      | "createdAt"
    >,
  ): void {
    const token = crypto.randomUUID();
    this.db.run(
      `INSERT INTO session_kernel_timers
			 (session_id, timer_id, kind, due_at, token, payload, attempts, next_attempt_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
			 ON CONFLICT(session_id, timer_id) DO UPDATE SET
			 kind = excluded.kind, due_at = excluded.due_at, token = excluded.token,
			 payload = excluded.payload, attempts = 0,
			 next_attempt_at = excluded.next_attempt_at, last_error = NULL,
			 dead_lettered_at = NULL, created_at = excluded.created_at`,
      [
        timer.sessionId,
        timer.timerId,
        timer.kind,
        timer.dueAt,
        token,
        json(timer.payload),
        timer.dueAt,
        Date.now(),
      ],
    );
  }

  timer(sessionId: string, timerId: string): DurableTimer | undefined {
    const row = this.db
      .query(
        `SELECT session_id, timer_id, kind, due_at, token, payload, attempts, next_attempt_at, last_error, dead_lettered_at, created_at
         FROM session_kernel_timers WHERE session_id = ? AND timer_id = ?`,
      )
      .get(sessionId, timerId) as Record<string, unknown> | null;
    return row
      ? {
          sessionId: String(row.session_id),
          timerId: String(row.timer_id),
          kind: String(row.kind),
          dueAt: Number(row.due_at),
          token: String(row.token),
          payload: parsed(row.payload as string),
          attempts: Number(row.attempts),
          nextAttemptAt: Number(row.next_attempt_at),
          lastError:
            row.last_error == null ? undefined : String(row.last_error),
          deadLetteredAt:
            row.dead_lettered_at == null
              ? undefined
              : Number(row.dead_lettered_at),
          createdAt: Number(row.created_at),
        }
      : undefined;
  }

  cancelTimer(sessionId: string, timerId: string): void {
    this.db.run(
      "DELETE FROM session_kernel_timers WHERE session_id = ? AND timer_id = ?",
      [sessionId, timerId],
    );
  }

  settleTimerSuccess(
    sessionId: string,
    timerId: string,
    token: string,
  ): boolean {
    return (
      this.db.run(
        "DELETE FROM session_kernel_timers WHERE session_id = ? AND timer_id = ? AND token = ?",
        [sessionId, timerId, token],
      ).changes > 0
    );
  }

  dueTimers(
    now = Date.now(),
    limit = 100,
    kinds?: readonly string[],
  ): DurableTimer[] {
    if (kinds && kinds.length === 0) return [];
    const kindFilter = kinds?.length
      ? ` AND kind IN (${kinds.map(() => "?").join(",")})`
      : "";
    const rows = this.db
      .query(
        `SELECT session_id, timer_id, kind, due_at, token, payload, attempts, next_attempt_at,
					last_error, dead_lettered_at, created_at
				 FROM session_kernel_timers
				 WHERE due_at <= ? AND next_attempt_at <= ? AND dead_lettered_at IS NULL
				   AND NOT EXISTS (
					 SELECT 1 FROM session_kernel_quarantine q
					 WHERE q.session_id = session_kernel_timers.session_id
				   )${kindFilter}
				 ORDER BY next_attempt_at, due_at LIMIT ?`,
      )
      .all(now, now, ...(kinds || []), limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      sessionId: String(row.session_id),
      timerId: String(row.timer_id),
      kind: String(row.kind),
      dueAt: Number(row.due_at),
      token: String(row.token),
      payload: parsed(row.payload as string),
      attempts: Number(row.attempts),
      nextAttemptAt: Number(row.next_attempt_at),
      lastError: row.last_error == null ? undefined : String(row.last_error),
      deadLetteredAt:
        row.dead_lettered_at == null ? undefined : Number(row.dead_lettered_at),
      createdAt: Number(row.created_at),
    }));
  }

  noteTimerFailure(
    sessionId: string,
    timerId: string,
    error: string,
    maxAttempts = 20,
    expectedToken?: string,
  ): { updated: boolean; deadLetteredNow: boolean } {
    const row = this.timer(sessionId, timerId);
    if (!row || (expectedToken !== undefined && row.token !== expectedToken))
      return { updated: false, deadLetteredNow: false };
    const attempts = row.attempts + 1;
    const deadLetteredAt = attempts >= maxAttempts ? Date.now() : null;
    const delay = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(attempts - 1, 8));
    this.db.run(
      `UPDATE session_kernel_timers SET attempts = ?, next_attempt_at = ?, last_error = ?,
				dead_lettered_at = ? WHERE session_id = ? AND timer_id = ? AND token = ?`,
      [
        attempts,
        Date.now() + delay,
        error.slice(0, 2_000),
        deadLetteredAt,
        sessionId,
        timerId,
        row.token,
      ],
    );
    return { updated: true, deadLetteredNow: deadLetteredAt !== null };
  }

  enqueueOutbox(
    sessionId: string,
    kind: string,
    payload: unknown,
    effectKey: string = crypto.randomUUID(),
  ): number {
    const effectId = `${sessionId}:${kind}:${effectKey}`;
    const existing = this.db
      .query(
        "SELECT id FROM session_kernel_outbox WHERE session_id = ? AND kind = ? AND effect_key = ?",
      )
      .get(sessionId, kind, effectKey) as { id: number } | null;
    if (existing) return Number(existing.id);
    const allocatedId = this.allocateOutboxId?.(sessionId);
    this.db.run(
      allocatedId === undefined
        ? `INSERT INTO session_kernel_outbox
					(effect_id, effect_key, session_id, kind, payload, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id, kind, effect_key) DO NOTHING`
        : `INSERT INTO session_kernel_outbox
					(id, effect_id, effect_key, session_id, kind, payload, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id, kind, effect_key) DO NOTHING`,
      allocatedId === undefined
        ? [effectId, effectKey, sessionId, kind, json(payload), Date.now()]
        : [
            allocatedId,
            effectId,
            effectKey,
            sessionId,
            kind,
            json(payload),
            Date.now(),
          ],
    );
    const row = this.db
      .query(
        "SELECT id FROM session_kernel_outbox WHERE session_id = ? AND kind = ? AND effect_key = ?",
      )
      .get(sessionId, kind, effectKey) as { id: number } | null;
    if (!row) throw new Error("Outbox effect was not persisted");
    return Number(row.id);
  }

  enqueueOutboxMany(
    sessionId: string,
    effects: Array<{ kind: string; payload: unknown; effectKey: string }>,
  ): number[] {
    if (effects.length === 0) return [];
    const ids: number[] = [];
    const tx = this.db.transaction(() => {
      for (const effect of effects)
        ids.push(
          this.enqueueOutbox(
            sessionId,
            effect.kind,
            effect.payload,
            effect.effectKey,
          ),
        );
    });
    tx.immediate();
    return ids;
  }

  completeCommandDecision(input: {
    sessionId: string;
    requestId: string;
    type: string;
    result: unknown;
    effects: Array<{ kind: string; payload: unknown; effectKey: string }>;
  }): void {
    const now = Date.now();
    const stored = resultRecord(input.result);
    let changeSeq = 0;
    const tx = this.db.transaction(() => {
      this.db.run(
        `UPDATE session_kernel_commands SET status = 'completed',
         payload = CASE WHEN type IN ('cancel_session', 'websocket_command') THEN payload ELSE 'null' END,
				 result = ?, result_hash = ?, result_released = 0, terminal_failure = ?, error = NULL,
				 retryable = NULL, updated_at = ? WHERE session_id = ? AND request_id = ?`,
        [
          stored.text,
          stored.hash,
          stored.terminalFailure ? 1 : 0,
          now,
          input.sessionId,
          input.requestId,
        ],
      );
      const prior = this.runState(input.sessionId);
      changeSeq = prior.changeSeq + 1;
      this.db.run(
        `INSERT INTO session_kernel_state
				 (session_id, run_state, run_since, last_event, generation, current_run_id, change_seq, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET change_seq = excluded.change_seq, updated_at = excluded.updated_at`,
        [
          input.sessionId,
          prior.state,
          prior.since === new Date(0).toISOString()
            ? new Date(now).toISOString()
            : prior.since,
          prior.lastEvent ?? null,
          prior.generation,
          prior.currentRunId ?? null,
          changeSeq,
          now,
        ],
      );
      this.db.run(
        `INSERT INTO session_kernel_changes (session_id, change_seq, kind, payload, created_at)
				 VALUES (?, ?, ?, ?, ?)`,
        [
          input.sessionId,
          changeSeq,
          `command:${input.type}`,
          json({ requestId: input.requestId }),
          now,
        ],
      );
      for (const effect of input.effects)
        this.enqueueOutbox(
          input.sessionId,
          effect.kind,
          effect.payload,
          effect.effectKey,
        );
    });
    tx.immediate();
    const prior = this.runState(input.sessionId);
    this.runStateCache.set(input.sessionId, { ...prior, changeSeq });
    this.dirtyChangeSessions.add(input.sessionId);
  }

  pendingOutbox(
    now = Date.now(),
    limit = 100,
    kinds?: readonly string[],
    excludedIds: readonly number[] = [],
  ): DurableOutboxItem[] {
    if (kinds && kinds.length === 0) return [];
    const kindFilter = kinds?.length
      ? ` AND kind IN (${kinds.map(() => "?").join(",")})`
      : "";
    const exclusionFilter = excludedIds.length
      ? ` AND id NOT IN (${excludedIds.map(() => "?").join(",")})`
      : "";
    const rows = this.db
      .query(
        `SELECT id, effect_id, effect_key, session_id, kind, payload, attempts,
         next_attempt_at, last_error, dead_lettered_at, created_at
         FROM session_kernel_outbox
         WHERE dead_lettered_at IS NULL AND next_attempt_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM session_kernel_quarantine q
             WHERE q.session_id = session_kernel_outbox.session_id
           )${kindFilter}${exclusionFilter}
         ORDER BY next_attempt_at, id LIMIT ?`,
      )
      .all(now, ...(kinds || []), ...excludedIds, limit) as Record<
      string,
      unknown
    >[];
    return rows.map((row) => ({
      id: Number(row.id),
      effectId: String(row.effect_id),
      effectKey: String(row.effect_key),
      sessionId: String(row.session_id),
      kind: String(row.kind),
      payload: parsed(row.payload as string),
      attempts: Number(row.attempts),
      nextAttemptAt: Number(row.next_attempt_at),
      lastError: row.last_error == null ? undefined : String(row.last_error),
      deadLetteredAt:
        row.dead_lettered_at == null ? undefined : Number(row.dead_lettered_at),
      createdAt: Number(row.created_at),
    }));
  }

  stats(): {
    sessions: number;
    quarantinedSessions: number;
    pendingCommands: number;
    indeterminateCommands: number;
    pendingTimers: number;
    pendingOutbox: number;
    deadLetteredOutbox: number;
    deadLetteredTimers: number;
    oldestPendingCommandAt?: number;
    oldestIndeterminateCommandAt?: number;
    oldestPendingTimerAt?: number;
    oldestPendingOutboxAt?: number;
    dbBytes: number;
    walBytes: number;
    pageCount: number;
    freePages: number;
    schemaVersion: number;
  } {
    const count = (table: string, where = "") =>
      Number(
        (
          this.db
            .query(`SELECT COUNT(*) AS n FROM ${table} ${where}`)
            .get() as {
            n: number;
          }
        ).n,
      );
    const oldest = (
      table: string,
      column: string,
      where = "",
    ): number | undefined => {
      const row = this.db
        .query(`SELECT MIN(${column}) AS oldest FROM ${table} ${where}`)
        .get() as { oldest: number | null };
      return row.oldest == null ? undefined : Number(row.oldest);
    };
    const pragma = (name: string) =>
      Number(
        Object.values(
          this.db.query(`PRAGMA ${name}`).get() as Record<string, unknown>,
        )[0] ?? 0,
      );
    const fileBytes = (path: string) => {
      try {
        return statSync(path).size;
      } catch {
        return 0;
      }
    };
    return {
      sessions: count("session_kernel_state"),
      quarantinedSessions: count("session_kernel_quarantine"),
      pendingCommands: count(
        "session_kernel_commands",
        "WHERE status IN ('pending', 'processing')",
      ),
      indeterminateCommands: count(
        "session_kernel_commands",
        "WHERE status = 'indeterminate'",
      ),
      pendingTimers: count("session_kernel_timers"),
      pendingOutbox: count(
        "session_kernel_outbox",
        "WHERE dead_lettered_at IS NULL",
      ),
      deadLetteredOutbox: count(
        "session_kernel_outbox",
        "WHERE dead_lettered_at IS NOT NULL",
      ),
      deadLetteredTimers: count(
        "session_kernel_timers",
        "WHERE dead_lettered_at IS NOT NULL",
      ),
      oldestPendingCommandAt: oldest(
        "session_kernel_commands",
        "created_at",
        "WHERE status IN ('pending', 'processing')",
      ),
      oldestIndeterminateCommandAt: oldest(
        "session_kernel_commands",
        "created_at",
        "WHERE status = 'indeterminate'",
      ),
      oldestPendingTimerAt: oldest(
        "session_kernel_timers",
        "created_at",
        "WHERE dead_lettered_at IS NULL",
      ),
      oldestPendingOutboxAt: oldest(
        "session_kernel_outbox",
        "created_at",
        "WHERE dead_lettered_at IS NULL",
      ),
      dbBytes: this.path === ":memory:" ? 0 : fileBytes(this.path),
      walBytes: this.path === ":memory:" ? 0 : fileBytes(`${this.path}-wal`),
      pageCount: pragma("page_count"),
      freePages: pragma("freelist_count"),
      schemaVersion: pragma("user_version"),
    };
  }

  acknowledgeCommand(sessionId: string, requestId: string): boolean {
    const result = this.db.run(
      `UPDATE session_kernel_commands SET acknowledged_at = COALESCE(acknowledged_at, ?)
			 WHERE session_id = ? AND request_id = ? AND status = 'completed'`,
      [Date.now(), sessionId, requestId],
    );
    return result.changes > 0;
  }

  compact(
    now = Date.now(),
    commandRetentionMs = 30 * 24 * 60 * 60_000,
    changesPerSession = CHANGE_HISTORY_PER_SESSION,
  ): void {
    // Request fingerprints and completion state are permanent. Large semantic
    // results stay replayable until the client confirms local receipt, then age
    // into a bounded digest marker. Terminal failures always keep their message.
    this.db.run(
      `UPDATE session_kernel_commands
			 SET result = '{"__sessionKernelResultReleased":true,"sha256":"' || result_hash || '"}',
			     result_released = 1
			 WHERE rowid IN (
				SELECT rowid FROM session_kernel_commands
				WHERE status = 'completed' AND terminal_failure = 0
				  AND acknowledged_at IS NOT NULL AND acknowledged_at < ?
				  AND result_hash IS NOT NULL AND result_released = 0 AND length(result) > ?
				LIMIT 500
			 )`,
      [now - commandRetentionMs, 64 * 1024],
    );
    for (const sessionId of [...this.dirtyChangeSessions].slice(0, 100)) {
      const result = this.db.run(
        `DELETE FROM session_kernel_changes WHERE rowid IN (
					SELECT rowid FROM session_kernel_changes
					WHERE session_id = ? AND change_seq <= (
						SELECT MAX(change_seq) - ? FROM session_kernel_changes WHERE session_id = ?
					)
					LIMIT 5000
				 )`,
        [sessionId, changesPerSession, sessionId],
      );
      if (result.changes < 5000) this.dirtyChangeSessions.delete(sessionId);
    }
  }

  maintain(): boolean {
    // Bounded semantic compaction only. VACUUM/optimize/checkpoint are offline
    // operator work because this actor also serves synchronous compatibility RPCs.
    this.db.run(
      `UPDATE session_kernel_commands
			 SET result = '{"__sessionKernelResultReleased":true,"sha256":"' || result_hash || '"}',
			     result_released = 1
			 WHERE rowid IN (
				SELECT rowid FROM session_kernel_commands
				WHERE status = 'completed' AND terminal_failure = 0
				  AND acknowledged_at IS NOT NULL AND acknowledged_at < ?
				  AND result_hash IS NOT NULL AND result_released = 0 AND length(result) > ?
				LIMIT 50
			 )`,
      [Date.now() - 30 * 24 * 60 * 60_000, 64 * 1024],
    );
    const sessionId = this.dirtyChangeSessions.values().next().value as
      | string
      | undefined;
    if (!sessionId) return false;
    const result = this.db.run(
      `DELETE FROM session_kernel_changes WHERE rowid IN (
				SELECT rowid FROM session_kernel_changes
				WHERE session_id = ? AND change_seq <= (
					SELECT MAX(change_seq) - ? FROM session_kernel_changes WHERE session_id = ?
				)
				LIMIT ?
			 )`,
      [
        sessionId,
        CHANGE_HISTORY_PER_SESSION,
        sessionId,
        MAINTENANCE_CHANGE_DELETE_BATCH,
      ],
    );
    if (result.changes < MAINTENANCE_CHANGE_DELETE_BATCH)
      this.dirtyChangeSessions.delete(sessionId);
    return this.dirtyChangeSessions.size > 0;
  }

  deadLetters(limit = 100, offset = 0) {
    const timers = this.db
      .query(
        `SELECT session_id, timer_id, kind, due_at, attempts, next_attempt_at, last_error, dead_lettered_at, created_at
			 FROM session_kernel_timers WHERE dead_lettered_at IS NOT NULL
			 ORDER BY dead_lettered_at DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Record<string, unknown>[];
    const outbox = this.db
      .query(
        `SELECT id, effect_id, effect_key, session_id, kind, attempts, next_attempt_at, last_error, dead_lettered_at, created_at
			 FROM session_kernel_outbox WHERE dead_lettered_at IS NOT NULL
			 ORDER BY dead_lettered_at DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Record<string, unknown>[];
    const quarantines = this.quarantinedSessions(limit, offset);
    return {
      quarantines,
      timers: timers.map((row) => ({
        sessionId: String(row.session_id),
        timerId: String(row.timer_id),
        kind: String(row.kind),
        dueAt: Number(row.due_at),
        nextAttemptAt: Number(row.next_attempt_at),
        createdAt: Number(row.created_at),
        attempts: Number(row.attempts),
        lastError: row.last_error == null ? undefined : String(row.last_error),
        deadLetteredAt: Number(row.dead_lettered_at),
      })),
      outbox: outbox.map((row) => ({
        id: Number(row.id),
        effectId: String(row.effect_id),
        effectKey: String(row.effect_key),
        nextAttemptAt: Number(row.next_attempt_at),
        createdAt: Number(row.created_at),
        sessionId: String(row.session_id),
        kind: String(row.kind),
        attempts: Number(row.attempts),
        lastError: row.last_error == null ? undefined : String(row.last_error),
        deadLetteredAt: Number(row.dead_lettered_at),
      })),
      totals: {
        quarantines: Number(
          (
            this.db
              .query("SELECT COUNT(*) AS n FROM session_kernel_quarantine")
              .get() as { n: number }
          ).n,
        ),
        timers: Number(
          (
            this.db
              .query(
                "SELECT COUNT(*) AS n FROM session_kernel_timers WHERE dead_lettered_at IS NOT NULL",
              )
              .get() as { n: number }
          ).n,
        ),
        outbox: Number(
          (
            this.db
              .query(
                "SELECT COUNT(*) AS n FROM session_kernel_outbox WHERE dead_lettered_at IS NOT NULL",
              )
              .get() as { n: number }
          ).n,
        ),
      },
      nextOffset:
        quarantines.length === limit ||
        timers.length === limit ||
        outbox.length === limit
          ? offset + limit
          : undefined,
    };
  }

  discardDeadTimer(sessionId: string, timerId: string): boolean {
    const result = this.db.run(
      "DELETE FROM session_kernel_timers WHERE session_id = ? AND timer_id = ? AND dead_lettered_at IS NOT NULL",
      [sessionId, timerId],
    );
    return result.changes > 0;
  }

  discardDeadOutbox(id: number): boolean {
    const result = this.db.run(
      "DELETE FROM session_kernel_outbox WHERE id = ? AND dead_lettered_at IS NOT NULL",
      [id],
    );
    return result.changes > 0;
  }

  retryDeadTimer(sessionId: string, timerId: string): boolean {
    const result = this.db.run(
      `UPDATE session_kernel_timers SET attempts = 0, next_attempt_at = ?,
			 last_error = NULL, dead_lettered_at = NULL
			 WHERE session_id = ? AND timer_id = ? AND dead_lettered_at IS NOT NULL`,
      [Date.now(), sessionId, timerId],
    );
    return result.changes > 0;
  }

  retryDeadOutbox(id: number): boolean {
    const result = this.db.run(
      `UPDATE session_kernel_outbox SET attempts = 0, next_attempt_at = ?,
			 last_error = NULL, dead_lettered_at = NULL
			 WHERE id = ? AND dead_lettered_at IS NOT NULL`,
      [Date.now(), id],
    );
    return result.changes > 0;
  }

  hasCreationBranchDeadLetters(): boolean {
    return !!this.db
      .query(
        `SELECT 1
			 FROM session_kernel_outbox AS outbox
			 JOIN session_kernel_creation AS creation
			   ON creation.session_id = outbox.session_id
			  AND creation.state = 'preparing'
			  AND creation.current_effect_id = outbox.effect_key
			 WHERE outbox.kind = 'creation_branch_prepare'
			   AND outbox.dead_lettered_at IS NOT NULL
			 LIMIT 1`,
      )
      .get();
  }

  /**
   * Re-admit branch effects rejected before physical work by compatibility bugs:
   * the former shared-checkout classifier and the old empty-base decoder. The
   * caller supplies trusted shared destinations; every other failure stays dead.
   */
  retryCompatibleCreationBranchDeadLetters(
    destinations: ReadonlyArray<{ project: string; worktreePath: string }>,
    now = Date.now(),
  ): Array<{
    id: number;
    sessionId: string;
    reason:
      | "shared_checkout_destination_adoptable"
      | "legacy_empty_base_branch";
  }> {
    const allowed = new Set(
      destinations.map(({ project, worktreePath }) =>
        JSON.stringify([project, worktreePath]),
      ),
    );
    const rows = this.db
      .query(
        `SELECT outbox.id, outbox.session_id, outbox.payload, outbox.last_error
				 FROM session_kernel_outbox AS outbox
				 JOIN session_kernel_creation AS creation
				   ON creation.session_id = outbox.session_id
				  AND creation.state = 'preparing'
				  AND creation.current_effect_id = outbox.effect_key
				 WHERE outbox.kind = 'creation_branch_prepare'
				   AND outbox.dead_lettered_at IS NOT NULL
				 ORDER BY outbox.id
				 LIMIT 1000`,
      )
      .all() as Array<{
      id: number;
      session_id: string;
      payload: string;
      last_error: string | null;
    }>;
    const retried: Array<{
      id: number;
      sessionId: string;
      reason:
        | "shared_checkout_destination_adoptable"
        | "legacy_empty_base_branch";
    }> = [];
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        let payload: Record<string, unknown>;
        try {
          const parsed = JSON.parse(row.payload);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            continue;
          payload = parsed as Record<string, unknown>;
        } catch {
          continue;
        }
        if (
          typeof payload.creationIdentity !== "string" ||
          payload.creationIdentity.length === 0 ||
          !Number.isSafeInteger(payload.creationGeneration) ||
          Number(payload.creationGeneration) < 1 ||
          typeof payload.project !== "string" ||
          typeof payload.worktreePath !== "string" ||
          typeof payload.branch !== "string" ||
          payload.branch.length === 0 ||
          payload.mode !== "adopt_or_create" ||
          typeof payload.isolated !== "boolean"
        )
          continue;
        const sharedCheckoutFalsePositive =
          payload.isolated === false &&
          allowed.has(
            JSON.stringify([payload.project, payload.worktreePath]),
          ) &&
          row.last_error ===
            `Worktree destination ${payload.worktreePath} exists without a registered branch`;
        // This decoder rejection happened before any executor or physical Git
        // action. Current additive decoding treats the old empty sentinel as
        // an omitted optional base, so replay cannot duplicate prior work.
        const legacyEmptyBaseBranch =
          payload.baseBranch === "" &&
          row.last_error ===
            "Invalid creation_branch_prepare effect payload: baseBranch";
        if (!sharedCheckoutFalsePositive && !legacyEmptyBaseBranch) continue;
        const result = this.db.run(
          `UPDATE session_kernel_outbox
					 SET attempts = 0, next_attempt_at = ?, last_error = NULL,
					     dead_lettered_at = NULL
					 WHERE id = ? AND dead_lettered_at IS NOT NULL`,
          [now, row.id],
        );
        if (result.changes > 0)
          retried.push({
            id: Number(row.id),
            sessionId: row.session_id,
            reason: sharedCheckoutFalsePositive
              ? "shared_checkout_destination_adoptable"
              : "legacy_empty_base_branch",
          });
      }
    });
    tx.immediate();
    return retried;
  }

  hasSessionDurableState(sessionId: string): boolean {
    const row = this.db
      .query(`
			SELECT 1 AS present FROM (
				SELECT session_id FROM session_kernel_tombstones WHERE session_id = ?
				UNION ALL SELECT session_id FROM session_kernel_quarantine WHERE session_id = ?
				UNION ALL SELECT session_id FROM session_kernel_state WHERE session_id = ?
				UNION ALL SELECT session_id FROM session_kernel_creation WHERE session_id = ?
				UNION ALL SELECT session_id FROM session_kernel_asks WHERE session_id = ?
				UNION ALL SELECT session_id FROM session_kernel_delivery WHERE session_id = ?
				UNION ALL SELECT session_id FROM session_kernel_turn WHERE session_id = ?
				UNION ALL SELECT session_id FROM session_kernel_turn_projections WHERE session_id = ?
				UNION ALL SELECT session_id FROM session_kernel_commands WHERE session_id = ?
				UNION ALL SELECT session_id FROM session_kernel_changes WHERE session_id = ?
				UNION ALL SELECT session_id FROM session_kernel_timers WHERE session_id = ?
				UNION ALL SELECT session_id FROM session_kernel_outbox WHERE session_id = ?
			) LIMIT 1
		`)
      .get(...Array(12).fill(sessionId)) as { present: number } | null;
    return row !== null;
  }

  legacySessionIds(limit = 1): string[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid legacy migration limit");
    return (
      this.db
        .query(`
			SELECT session_id FROM (
				SELECT session_id FROM session_kernel_tombstones
				UNION SELECT session_id FROM session_kernel_quarantine
				UNION SELECT session_id FROM session_kernel_state
				UNION SELECT session_id FROM session_kernel_creation
				UNION SELECT session_id FROM session_kernel_asks
				UNION SELECT session_id FROM session_kernel_delivery
				UNION SELECT session_id FROM session_kernel_turn
				UNION SELECT session_id FROM session_kernel_turn_projections
				UNION SELECT session_id FROM session_kernel_commands
				UNION SELECT session_id FROM session_kernel_changes
				UNION SELECT session_id FROM session_kernel_timers
				UNION SELECT session_id FROM session_kernel_outbox
			) legacy
			WHERE NOT EXISTS (
				SELECT 1 FROM session_kernel_placements placement
				WHERE placement.session_id = legacy.session_id
			)
			ORDER BY session_id
			LIMIT ?
		`)
        .all(limit) as Array<{ session_id: string }>
    ).map((row) => row.session_id);
  }

  migrateLegacySession(sessionId: string, targetPath: string): boolean {
    if (this.path === ":memory:" || targetPath === ":memory:")
      throw new Error(
        "Legacy session migration requires durable database paths",
      );
    if (this.sessionPlacement(sessionId)) return false;
    if (!this.hasSessionDurableState(sessionId)) return false;

    const temporaryPath = `${targetPath}.migrating-${crypto.randomUUID()}`;
    for (const path of [
      targetPath,
      `${targetPath}-wal`,
      `${targetPath}-shm`,
      temporaryPath,
      `${temporaryPath}-wal`,
      `${temporaryPath}-shm`,
    ])
      rmSync(path, { force: true });
    const initialized = new SessionKernelStore(temporaryPath, {
      busyTimeoutMs: 250,
    });
    initialized.close();

    let attached = false;
    let nextTimerAt: number | undefined;
    let nextOutboxAt: number | undefined;
    try {
      this.db
        .query("ATTACH DATABASE ? AS session_migration")
        .run(temporaryPath);
      attached = true;
      const columnsByTable = new Map<string, string>();
      for (const table of SESSION_KERNEL_SESSION_TABLES) {
        const sourceColumns = (
          this.db.query(`PRAGMA main.table_info(${table})`).all() as Array<{
            name: string;
          }>
        ).map((column) => column.name);
        const targetColumns = (
          this.db
            .query(`PRAGMA session_migration.table_info(${table})`)
            .all() as Array<{ name: string }>
        ).map((column) => column.name);
        if (
          sourceColumns.length !== targetColumns.length ||
          targetColumns.some((column) => !sourceColumns.includes(column))
        )
          throw new Error(`Session migration schema mismatch for ${table}`);
        columnsByTable.set(
          table,
          targetColumns
            .map((column) => `"${column.replaceAll('"', '""')}"`)
            .join(", "),
        );
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const table of SESSION_KERNEL_SESSION_TABLES) {
          const columns = columnsByTable.get(table)!;
          this.db
            .query(
              `INSERT INTO session_migration.${table} (${columns}) SELECT ${columns} FROM main.${table} WHERE session_id = ?`,
            )
            .run(sessionId);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }

      for (const table of SESSION_KERNEL_SESSION_TABLES) {
        const source = this.db
          .query(
            `SELECT COUNT(*) AS count FROM main.${table} WHERE session_id = ?`,
          )
          .get(sessionId) as { count: number };
        const target = this.db
          .query(
            `SELECT COUNT(*) AS count FROM session_migration.${table} WHERE session_id = ?`,
          )
          .get(sessionId) as { count: number };
        if (Number(source.count) !== Number(target.count))
          throw new Error(`Session migration count mismatch for ${table}`);
        const columns = columnsByTable.get(table)!;
        const sourceDifference = this.db
          .query(`
					SELECT 1 AS differs FROM (
						SELECT ${columns} FROM main.${table} WHERE session_id = ?
						EXCEPT
						SELECT ${columns} FROM session_migration.${table} WHERE session_id = ?
					) LIMIT 1
				`)
          .get(sessionId, sessionId);
        const targetDifference = this.db
          .query(`
					SELECT 1 AS differs FROM (
						SELECT ${columns} FROM session_migration.${table} WHERE session_id = ?
						EXCEPT
						SELECT ${columns} FROM main.${table} WHERE session_id = ?
					) LIMIT 1
				`)
          .get(sessionId, sessionId);
        if (sourceDifference || targetDifference)
          throw new Error(`Session migration row mismatch for ${table}`);
      }
      const integrity = this.db
        .query("PRAGMA session_migration.integrity_check")
        .get() as { integrity_check: string };
      if (integrity.integrity_check !== "ok")
        throw new Error(
          `Session migration integrity check failed: ${integrity.integrity_check}`,
        );
      const timerWake = this.db
        .query(`
				SELECT MIN(CASE WHEN next_attempt_at > due_at THEN next_attempt_at ELSE due_at END) AS next_at
				FROM session_migration.session_kernel_timers
				WHERE session_id = ? AND dead_lettered_at IS NULL
			`)
        .get(sessionId) as { next_at: number | null };
      const outboxWake = this.db
        .query(`
				SELECT MIN(next_attempt_at) AS next_at
				FROM session_migration.session_kernel_outbox
				WHERE session_id = ? AND dead_lettered_at IS NULL
			`)
        .get(sessionId) as { next_at: number | null };
      nextTimerAt =
        timerWake.next_at === null ? undefined : Number(timerWake.next_at);
      nextOutboxAt =
        outboxWake.next_at === null ? undefined : Number(outboxWake.next_at);
      this.db.exec("PRAGMA session_migration.wal_checkpoint(TRUNCATE)");
      this.db.exec("DETACH DATABASE session_migration");
      attached = false;

      for (const suffix of ["-wal", "-shm"])
        rmSync(`${temporaryPath}${suffix}`, { force: true });
      const file = openSync(temporaryPath, "r");
      try {
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      renameSync(temporaryPath, targetPath);
      const directory = openSync(dirname(targetPath), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }

      const publish = this.db.transaction(() => {
        if (this.sessionPlacement(sessionId)) return false;
        if (!this.hasSessionDurableState(sessionId))
          throw new Error("Legacy session state disappeared before cutover");
        const outboxIds = this.db
          .query(`
					SELECT id FROM session_kernel_outbox
					WHERE session_id = ? ORDER BY id
				`)
          .all(sessionId) as Array<{ id: number }>;
        for (const row of outboxIds)
          this.db.run(
            `
						INSERT INTO session_kernel_outbox_routes (id, session_id, created_at)
						VALUES (?, ?, ?)
					`,
            [Number(row.id), sessionId, Date.now()],
          );
        this.db.run(
          `
					INSERT INTO session_kernel_placements
						(session_id, placement, needs_scan, next_timer_at, next_outbox_at, updated_at)
					VALUES (?, 'isolated', 0, ?, ?, ?)
				`,
          [sessionId, nextTimerAt ?? null, nextOutboxAt ?? null, Date.now()],
        );
        for (const table of SESSION_KERNEL_SESSION_TABLES)
          this.db
            .query(`DELETE FROM ${table} WHERE session_id = ?`)
            .run(sessionId);
        this.runStateCache.delete(sessionId);
        this.dirtyChangeSessions.delete(sessionId);
        return true;
      });
      return publish.immediate();
    } catch (error) {
      if (attached) {
        try {
          this.db.exec("DETACH DATABASE session_migration");
        } catch {}
      }
      if (!this.sessionPlacement(sessionId)) {
        for (const path of [
          targetPath,
          `${targetPath}-wal`,
          `${targetPath}-shm`,
          temporaryPath,
          `${temporaryPath}-wal`,
          `${temporaryPath}-shm`,
        ])
          rmSync(path, { force: true });
      }
      throw error;
    }
  }

  sessionPlacement(sessionId: string): DurableSessionPlacement | undefined {
    const row = this.db
      .query(`
			SELECT session_id, placement, transcript_authority,
                   transcript_migration_receipt, transcript_published_at,
                   needs_scan, next_timer_at, next_outbox_at, updated_at
			FROM session_kernel_placements WHERE session_id = ?
		`)
      .get(sessionId) as {
      session_id: string;
      placement: "isolated";
      transcript_authority: "shared" | "actor";
      transcript_migration_receipt: string | null;
      transcript_published_at: number | null;
      needs_scan: number;
      next_timer_at: number | null;
      next_outbox_at: number | null;
      updated_at: number;
    } | null;
    if (!row) return undefined;
    return {
      sessionId: row.session_id,
      placement: row.placement,
      transcriptAuthority: row.transcript_authority,
      ...(row.transcript_migration_receipt === null
        ? {}
        : { transcriptMigrationReceipt: row.transcript_migration_receipt }),
      ...(row.transcript_published_at === null
        ? {}
        : { transcriptPublishedAt: Number(row.transcript_published_at) }),
      needsScan: row.needs_scan === 1,
      ...(row.next_timer_at === null
        ? {}
        : { nextTimerAt: Number(row.next_timer_at) }),
      ...(row.next_outbox_at === null
        ? {}
        : { nextOutboxAt: Number(row.next_outbox_at) }),
      updatedAt: Number(row.updated_at),
    };
  }

  actorTranscriptSessionIds(limit = 100, afterSessionId = ""): string[] {
    return (
      this.db
        .query(`
      SELECT session_id FROM session_kernel_placements
      WHERE placement = 'isolated'
        AND transcript_authority = 'actor'
        AND session_id > ?
      ORDER BY session_id LIMIT ?
    `)
        .all(afterSessionId, Math.max(1, limit)) as Array<{
        session_id: string;
      }>
    ).map((row) => row.session_id);
  }

  transcriptMigrationSessionIds(limit = 1_000, afterSessionId = ""): string[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
      throw new Error("Invalid transcript migration session limit");
    return (
      this.db
        .query(`
      SELECT session_id FROM (
        SELECT session_id FROM session_kernel_tombstones
        UNION SELECT session_id FROM session_kernel_quarantine
        UNION SELECT session_id FROM session_kernel_state
        UNION SELECT session_id FROM session_kernel_creation
        UNION SELECT session_id FROM session_kernel_asks
        UNION SELECT session_id FROM session_kernel_delivery
        UNION SELECT session_id FROM session_kernel_turn
        UNION SELECT session_id FROM session_kernel_turn_projections
        UNION SELECT session_id FROM session_kernel_commands
        UNION SELECT session_id FROM session_kernel_changes
        UNION SELECT session_id FROM session_kernel_timers
        UNION SELECT session_id FROM session_kernel_outbox
        UNION SELECT session_id FROM session_kernel_placements
          WHERE placement = 'isolated' AND transcript_authority = 'shared'
      ) candidates
      WHERE session_id > ?
      ORDER BY session_id LIMIT ?
    `)
        .all(afterSessionId, limit) as Array<{ session_id: string }>
    ).map((row) => row.session_id);
  }

  publishActorTranscriptAuthorities(
    entries: ReadonlyArray<{ sessionId: string; migrationReceipt: string }>,
  ): void {
    const publish = this.db.transaction(() => {
      for (const { sessionId, migrationReceipt } of entries) {
        if (
          !migrationReceipt ||
          Buffer.byteLength(migrationReceipt) > 16 * 1024
        )
          throw new Error("Invalid transcript migration receipt");
        const existing = this.sessionPlacement(sessionId);
        if (!existing || existing.placement !== "isolated")
          throw new Error(`Session ${sessionId} has no isolated placement`);
        if (
          existing.transcriptAuthority === "actor" &&
          existing.transcriptMigrationReceipt !== migrationReceipt
        )
          throw new Error(
            `Session ${sessionId} transcript authority receipt conflict`,
          );
      }
      const now = Date.now();
      for (const { sessionId, migrationReceipt } of entries) {
        const existing = this.sessionPlacement(sessionId)!;
        if (existing.transcriptAuthority === "actor") continue;
        const result = this.db.run(
          `
          UPDATE session_kernel_placements
          SET transcript_authority = 'actor', transcript_migration_receipt = ?,
              transcript_published_at = ?, updated_at = ?
          WHERE session_id = ? AND placement = 'isolated'
            AND transcript_authority = 'shared'
        `,
          [migrationReceipt, now, now, sessionId],
        );
        if (result.changes !== 1)
          throw new Error(
            `Session ${sessionId} transcript authority publication raced`,
          );
      }
    });
    publish.immediate();
  }

  publishActorTranscriptAuthority(
    sessionId: string,
    migrationReceipt: string,
  ): DurableSessionPlacement {
    if (!migrationReceipt || Buffer.byteLength(migrationReceipt) > 16 * 1024)
      throw new Error("Invalid transcript migration receipt");
    const existing = this.sessionPlacement(sessionId);
    if (!existing)
      throw new Error(`Session ${sessionId} has no isolated placement`);
    if (existing.transcriptAuthority === "actor") {
      if (existing.transcriptMigrationReceipt !== migrationReceipt)
        throw new Error(
          `Session ${sessionId} transcript authority receipt conflict`,
        );
      return existing;
    }
    const result = this.db.run(
      `
      UPDATE session_kernel_placements
      SET transcript_authority = 'actor', transcript_migration_receipt = ?,
          transcript_published_at = ?, updated_at = ?
      WHERE session_id = ? AND placement = 'isolated'
        AND transcript_authority = 'shared'
    `,
      [migrationReceipt, Date.now(), Date.now(), sessionId],
    );
    if (result.changes !== 1)
      throw new Error(
        `Session ${sessionId} transcript authority publication raced`,
      );
    return this.sessionPlacement(sessionId)!;
  }

  rollbackActorTranscriptAuthorities(sessionIds: readonly string[]): void {
    const rollback = this.db.transaction(() => {
      const now = Date.now();
      for (const sessionId of sessionIds) {
        const result = this.db.run(
          `
          UPDATE session_kernel_placements
          SET transcript_authority = 'shared', transcript_published_at = NULL,
              updated_at = ?
          WHERE session_id = ? AND placement = 'isolated'
            AND transcript_authority = 'actor'
        `,
          [now, sessionId],
        );
        if (result.changes !== 1)
          throw new Error(
            `Session ${sessionId} has no actor transcript authority`,
          );
      }
    });
    rollback.immediate();
  }

  rollbackActorTranscriptAuthority(sessionId: string): DurableSessionPlacement {
    const result = this.db.run(
      `
      UPDATE session_kernel_placements
      SET transcript_authority = 'shared', transcript_published_at = NULL,
          updated_at = ?
      WHERE session_id = ? AND placement = 'isolated'
        AND transcript_authority = 'actor'
    `,
      [Date.now(), sessionId],
    );
    if (result.changes !== 1)
      throw new Error(`Session ${sessionId} has no actor transcript authority`);
    return this.sessionPlacement(sessionId)!;
  }

  claimIsolatedSessionForTranscriptMigration(
    sessionId: string,
  ): DurableSessionPlacement {
    if (this.hasSessionDurableState(sessionId))
      throw new Error(`Session ${sessionId} still has central kernel state`);
    this.db.run(
      `
      INSERT INTO session_kernel_placements
        (session_id, placement, transcript_authority, needs_scan, updated_at)
      VALUES (?, 'isolated', 'shared', 0, ?)
      ON CONFLICT(session_id) DO NOTHING
    `,
      [sessionId, Date.now()],
    );
    const placement = this.sessionPlacement(sessionId);
    if (!placement || placement.placement !== "isolated")
      throw new Error(
        `Session ${sessionId} isolated migration placement was not persisted`,
      );
    return placement;
  }

  claimIsolatedSessionsForTranscriptMigration(
    sessionIds: readonly string[],
  ): DurableSessionPlacement[] {
    if (sessionIds.length === 0) return [];
    const unique = [...new Set(sessionIds)];
    const claim = this.db.transaction(() => {
      const now = Date.now();
      for (const sessionId of unique) {
        if (this.hasSessionDurableState(sessionId))
          throw new Error(
            `Session ${sessionId} still has central kernel state`,
          );
        this.db.run(
          `
          INSERT INTO session_kernel_placements
            (session_id, placement, transcript_authority, needs_scan, updated_at)
          VALUES (?, 'isolated', 'shared', 0, ?)
          ON CONFLICT(session_id) DO NOTHING
        `,
          [sessionId, now],
        );
        const placement = this.sessionPlacement(sessionId);
        if (!placement || placement.placement !== "isolated")
          throw new Error(
            `Session ${sessionId} isolated migration placement was not persisted`,
          );
      }
    });
    claim.immediate();
    return unique.map((sessionId) => this.sessionPlacement(sessionId)!);
  }

  claimIsolatedSession(sessionId: string): DurableSessionPlacement {
    if (this.hasSessionDurableState(sessionId))
      throw new Error(`Session ${sessionId} already has central kernel state`);
    this.db.run(
      `
			INSERT INTO session_kernel_placements
				(session_id, placement, transcript_authority, needs_scan, updated_at)
			VALUES (?, 'isolated', 'actor', 1, ?)
			ON CONFLICT(session_id) DO NOTHING
		`,
      [sessionId, Date.now()],
    );
    const placement = this.sessionPlacement(sessionId);
    if (!placement) throw new Error("Session placement was not persisted");
    // New actors always publish an empty projection eagerly. Historical
    // projection repair is an offline migration; the online host must never
    // discover it by walking every actor database.
    this.settleIsolatedSessionProjection(sessionId, undefined, undefined);
    if (
      !this.sparseProjectionMigrationComplete() &&
      this.isolatedProjectionPendingSessionIds(1).length === 0
    )
      this.markSparseProjectionMigrationComplete();
    return placement;
  }

  sparseProjectionMigrationComplete(): boolean {
    return !!this.db
      .query(
        "SELECT 1 FROM session_kernel_migrations WHERE name = 'sparse_projection_v2'",
      )
      .get();
  }

  markSparseProjectionMigrationComplete(): void {
    if (this.isolatedProjectionPendingSessionIds(1).length > 0)
      throw new Error("Sparse session projection backfill is incomplete");
    this.db.run(
      "INSERT OR IGNORE INTO session_kernel_migrations (name, completed_at) VALUES ('sparse_projection_v2', ?)",
      [Date.now()],
    );
  }

  isolatedProjectionPendingSessionIds(limit = 16): string[] {
    return (
      this.db
        .query(`
			SELECT placement.session_id
			FROM session_kernel_placements placement
			LEFT JOIN session_kernel_sparse_projections projection
			  ON projection.session_id = placement.session_id
			WHERE placement.placement = 'isolated'
			  AND (projection.session_id IS NULL OR projection.dirty = 1)
			ORDER BY placement.session_id
			LIMIT ?
		`)
        .all(Math.max(1, limit)) as Array<{ session_id: string }>
    ).map((row) => row.session_id);
  }

  markIsolatedSessionProjectionDirty(sessionId: string): void {
    if (!this.sessionPlacement(sessionId))
      throw new Error(`Session ${sessionId} has no isolated placement`);
    this.db.run(
      `
			INSERT INTO session_kernel_sparse_projections
			  (session_id, dirty, updated_at) VALUES (?, 1, ?)
			ON CONFLICT(session_id) DO UPDATE SET
			  dirty = 1, updated_at = excluded.updated_at
		`,
      [sessionId, Date.now()],
    );
  }

  settleIsolatedSessionProjection(
    sessionId: string,
    askRecord: unknown | undefined,
    deliveryState: DurableDeliveryState | undefined,
    quarantineState: DurableSessionQuarantine | undefined = undefined,
  ): void {
    if (!this.sessionPlacement(sessionId))
      throw new Error(`Session ${sessionId} has no isolated placement`);
    this.db.run(
      `
			INSERT INTO session_kernel_sparse_projections
			  (session_id, ask_record, delivery_state, quarantine_state, dirty, updated_at)
			VALUES (?, ?, ?, ?, 0, ?)
			ON CONFLICT(session_id) DO UPDATE SET
			  ask_record = excluded.ask_record,
			  delivery_state = excluded.delivery_state,
			  quarantine_state = excluded.quarantine_state,
			  dirty = 0,
			  updated_at = excluded.updated_at
		`,
      [
        sessionId,
        askRecord === undefined ? null : json(askRecord),
        deliveryState === undefined ? null : json(deliveryState),
        quarantineState === undefined ? null : json(quarantineState),
        Date.now(),
      ],
    );
  }

  isolatedQuarantineProjectionEntries(): DurableSessionQuarantine[] {
    return (
      this.db
        .query(`
			SELECT quarantine_state
			FROM session_kernel_sparse_projections
			WHERE dirty = 0 AND quarantine_state IS NOT NULL
			ORDER BY session_id
		`)
        .all() as Array<{ quarantine_state: string }>
    ).map((row) => parsed(row.quarantine_state) as DurableSessionQuarantine);
  }

  isolatedAskProjectionEntries(): Array<[string, unknown]> {
    return (
      this.db
        .query(`
			SELECT session_id, ask_record
			FROM session_kernel_sparse_projections
			WHERE dirty = 0 AND ask_record IS NOT NULL
			ORDER BY session_id
		`)
        .all() as Array<{ session_id: string; ask_record: string }>
    ).map((row) => [row.session_id, parsed(row.ask_record)]);
  }

  isolatedDeliveryProjectionEntries(
    slot: DeliverySlot,
  ): Array<[string, unknown]> {
    const states = this.db
      .query(`
			SELECT session_id, delivery_state
			FROM session_kernel_sparse_projections
			WHERE dirty = 0 AND delivery_state IS NOT NULL
			ORDER BY session_id
		`)
      .all() as Array<{ session_id: string; delivery_state: string }>;
    const entries: Array<[string, unknown]> = [];
    for (const row of states) {
      const state = parsed(row.delivery_state) as DurableDeliveryState;
      const value =
        slot === "queued"
          ? state.queued
          : slot === "steered"
            ? state.steered
            : state.dispatch;
      if (value === undefined || (Array.isArray(value) && value.length === 0))
        continue;
      entries.push([row.session_id, value]);
    }
    return entries;
  }

  isolatedPendingSteerProjectionSessionIds(): string[] {
    const rows = this.db
      .query(`
			SELECT session_id, delivery_state
			FROM session_kernel_sparse_projections
			WHERE dirty = 0 AND delivery_state IS NOT NULL
			ORDER BY session_id
		`)
      .all() as Array<{ session_id: string; delivery_state: string }>;
    return rows
      .filter((row) => {
        const state = parsed(row.delivery_state) as DurableDeliveryState;
        return state.pendingSteers.length > 0;
      })
      .map((row) => row.session_id);
  }

  markIsolatedSessionDirty(sessionId: string): void {
    const result = this.db.run(
      `
			UPDATE session_kernel_placements
			SET needs_scan = 1, updated_at = ?
			WHERE session_id = ? AND placement = 'isolated'
		`,
      [Date.now(), sessionId],
    );
    if (result.changes !== 1)
      throw new Error(`Session ${sessionId} has no isolated placement`);
  }

  settleIsolatedSessionWake(
    sessionId: string,
    nextTimerAt?: number,
    nextOutboxAt?: number,
  ): void {
    const result = this.db.run(
      `
			UPDATE session_kernel_placements
			SET needs_scan = 0, next_timer_at = ?, next_outbox_at = ?, updated_at = ?
			WHERE session_id = ? AND placement = 'isolated'
		`,
      [nextTimerAt ?? null, nextOutboxAt ?? null, Date.now(), sessionId],
    );
    if (result.changes !== 1)
      throw new Error(`Session ${sessionId} has no isolated placement`);
  }

  isolatedWakeCandidates(
    now = Date.now(),
    limit = 100,
    afterSessionId = "",
  ): string[] {
    return (
      this.db
        .query(`
			SELECT session_id FROM session_kernel_placements
			WHERE placement = 'isolated'
			  AND session_id > ?
			  AND NOT EXISTS (
				SELECT 1 FROM session_kernel_quarantine q
				WHERE q.session_id = session_kernel_placements.session_id
			  )
			  AND (needs_scan = 1 OR next_timer_at <= ? OR next_outbox_at <= ?)
			ORDER BY session_id
			LIMIT ?
		`)
        .all(afterSessionId, now, now, Math.max(1, limit)) as Array<{
        session_id: string;
      }>
    ).map((row) => row.session_id);
  }

  /** Newly dirtied actors outrank the historical wake-index sweep. A restore
   * can conservatively mark thousands of old placements dirty; ordering that
   * backlog only by session id otherwise leaves a brand-new creation outbox
   * undiscoverable for minutes. The ordinary cursor scan still receives the
   * rest of each runtime batch, so old work continues to make progress. */
  isolatedRecentDirtyWakeCandidates(limit = 4): string[] {
    return (
      this.db
        .query(`
			SELECT session_id FROM session_kernel_placements
			WHERE placement = 'isolated'
			  AND needs_scan = 1
			  AND NOT EXISTS (
				SELECT 1 FROM session_kernel_quarantine q
				WHERE q.session_id = session_kernel_placements.session_id
			  )
			ORDER BY updated_at DESC, session_id
			LIMIT ?
		`)
        .all(Math.max(1, limit)) as Array<{ session_id: string }>
    ).map((row) => row.session_id);
  }

  /** Due work gets its own cursor instead of waiting for the larger recovery
   * scan. A long-running effect remains due until acknowledgement, so this
   * list must rotate rather than repeatedly returning the same active actors. */
  isolatedDueWakeCandidates(
    now = Date.now(),
    limit = 2,
    afterSessionId = "",
  ): string[] {
    return (
      this.db
        .query(`
			SELECT session_id FROM session_kernel_placements
			WHERE placement = 'isolated'
			  AND needs_scan = 0
			  AND session_id > ?
			  AND (next_timer_at <= ? OR next_outbox_at <= ?)
			  AND NOT EXISTS (
				SELECT 1 FROM session_kernel_quarantine q
				WHERE q.session_id = session_kernel_placements.session_id
			  )
			ORDER BY session_id
			LIMIT ?
		`)
        .all(afterSessionId, now, now, Math.max(1, limit)) as Array<{
        session_id: string;
      }>
    ).map((row) => row.session_id);
  }

  nextTimerWakeAt(): number | undefined {
    const row = this.db
      .query(`
			SELECT MIN(CASE WHEN next_attempt_at > due_at THEN next_attempt_at ELSE due_at END) AS next_at
			FROM session_kernel_timers WHERE dead_lettered_at IS NULL
		`)
      .get() as { next_at: number | null };
    return row.next_at === null ? undefined : Number(row.next_at);
  }

  nextOutboxWakeAt(
    activeIds: readonly number[] = [],
    activeRecheckAt = Date.now(),
  ): number | undefined {
    const activeWake = activeIds.length
      ? `CASE WHEN id IN (${activeIds.map(() => "?").join(",")}) THEN ? ELSE next_attempt_at END`
      : "next_attempt_at";
    const row = this.db
      .query(`
			SELECT MIN(${activeWake}) AS next_at
			FROM session_kernel_outbox WHERE dead_lettered_at IS NULL
		`)
      .get(...activeIds, ...(activeIds.length ? [activeRecheckAt] : [])) as {
      next_at: number | null;
    };
    return row.next_at === null ? undefined : Number(row.next_at);
  }

  allocateIsolatedOutboxId(sessionId: string): number {
    const floor = 4_000_000_000_000_000;
    let id = floor;
    const tx = this.db.transaction(() => {
      const seeded = this.db.run(
        `
				UPDATE sqlite_sequence SET seq = MAX(seq, ?)
				WHERE name = 'session_kernel_outbox_routes'
			`,
        [floor - 1],
      );
      if (seeded.changes === 0)
        this.db.run(
          "INSERT INTO sqlite_sequence(name, seq) VALUES ('session_kernel_outbox_routes', ?)",
          [floor - 1],
        );
      const inserted = this.db.run(
        "INSERT INTO session_kernel_outbox_routes (session_id, created_at) VALUES (?, ?)",
        [sessionId, Date.now()],
      );
      id = Number(inserted.lastInsertRowid);
      if (!Number.isSafeInteger(id))
        throw new Error("Isolated outbox identity space is exhausted");
    });
    tx.immediate();
    return id;
  }

  isolatedOutboxRoutes(
    limit = 100,
    afterId = 0,
  ): Array<{ id: number; sessionId: string }> {
    return (
      this.db
        .query(`
			SELECT id, session_id FROM session_kernel_outbox_routes
			WHERE id > ? ORDER BY id LIMIT ?
		`)
        .all(afterId, Math.max(1, limit)) as Array<{
        id: number;
        session_id: string;
      }>
    ).map((row) => ({ id: Number(row.id), sessionId: row.session_id }));
  }

  isolatedOutboxSessionId(id: number): string | undefined {
    const row = this.db
      .query("SELECT session_id FROM session_kernel_outbox_routes WHERE id = ?")
      .get(id) as { session_id: string } | null;
    return row?.session_id;
  }

  forgetIsolatedOutboxRoute(id: number): void {
    this.db.run("DELETE FROM session_kernel_outbox_routes WHERE id = ?", [id]);
  }

  outboxSessionId(id: number): string | undefined {
    const row = this.db
      .query("SELECT session_id FROM session_kernel_outbox WHERE id = ?")
      .get(id) as { session_id: string } | null;
    return row?.session_id;
  }

  ackOutbox(id: number): void {
    this.db.run("DELETE FROM session_kernel_outbox WHERE id = ?", [id]);
  }

  deferOutbox(id: number, delayMs = 250): void {
    const delay = Number.isFinite(delayMs) ? Math.max(1, delayMs) : 250;
    this.db.run(
      `UPDATE session_kernel_outbox SET next_attempt_at = ?
       WHERE id = ? AND dead_lettered_at IS NULL`,
      [Date.now() + delay, id],
    );
  }

  noteOutboxFailure(
    id: number,
    error: string,
    maxAttempts = 20,
  ): { updated: boolean; deadLetteredNow: boolean } {
    const row = this.db
      .query("SELECT attempts FROM session_kernel_outbox WHERE id = ?")
      .get(id) as { attempts: number } | null;
    if (!row) return { updated: false, deadLetteredNow: false };
    const attempts = Number(row.attempts) + 1;
    const deadLetteredAt = attempts >= maxAttempts ? Date.now() : null;
    const delay = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(attempts - 1, 8));
    this.db.run(
      `UPDATE session_kernel_outbox SET attempts = ?, next_attempt_at = ?, last_error = ?,
       dead_lettered_at = ? WHERE id = ?`,
      [attempts, Date.now() + delay, error.slice(0, 2_000), deadLetteredAt, id],
    );
    return { updated: true, deadLetteredNow: deadLetteredAt !== null };
  }
}

/** Structural runtime surface implemented locally in tests and by the actor proxy in production. */
export type SessionKernelStoreApi = Omit<
  SessionKernelStore,
  | "hasSessionDurableState"
  | "hasPendingSteers"
  | "hasCreationBranchDeadLetters"
  | "assertTranscriptDestinationFence"
  | "legacySessionIds"
  | "migrateLegacySession"
  | "sessionPlacement"
  | "isolatedSessionPlacements"
  | "actorTranscriptSessionIds"
  | "transcriptMigrationSessionIds"
  | "publishActorTranscriptAuthority"
  | "publishActorTranscriptAuthorities"
  | "rollbackActorTranscriptAuthority"
  | "rollbackActorTranscriptAuthorities"
  | "claimIsolatedSession"
  | "claimIsolatedSessionForTranscriptMigration"
  | "claimIsolatedSessionsForTranscriptMigration"
  | "markIsolatedSessionDirty"
  | "settleIsolatedSessionWake"
  | "isolatedWakeCandidates"
  | "nextTimerWakeAt"
  | "nextOutboxWakeAt"
  | "allocateIsolatedOutboxId"
  | "isolatedOutboxRoutes"
  | "isolatedOutboxSessionId"
  | "forgetIsolatedOutboxRoute"
>;
