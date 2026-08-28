import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname, parse, resolve } from "node:path";
import {
  GenerationEmergencyReserve,
  type GenerationOwner,
} from "./emergency-reserve";
import {
  HostLedgerKeyring,
  type HostLedgerKeyringInput,
} from "./ledger-crypto";
import {
  assertCommittedBound,
  preflightLiability,
  nodeLedgerPhysicalAccounting,
  type LedgerPhysicalAccounting,
  type LedgerWriteClass,
  type WriteShape,
} from "./ledger-accounting";
import {
  AGENT_HOST_LEDGER_RETENTION_MS,
  AGENT_HOST_LEDGER_SCHEMA_SQL,
  initializeExactLedgerSchema,
} from "./ledger-schema";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DIGEST = /^[a-f0-9]{64}$/;
const PHASE_TERMINAL = new Set([
  "settled",
  "terminal",
  "indeterminate",
  "quarantined",
  "acked",
  "failed",
]);
type Plain =
  null | boolean | number | string | Plain[] | { [key: string]: Plain };
export interface TurnFence {
  sessionId: string;
  runId: string;
  turnId: string;
  generation: number;
}
export interface AdmitTurnInput {
  fence: TurnFence;
  authorityHash: string;
  recoveryDescriptor: Plain;
  admittedAtMs: number;
}
export interface OperationInput {
  fence: TurnFence;
  operationId: string;
  identityDigest: string;
  reconcileRef: Plain;
  atMs: number;
}
export interface ControlInput {
  fence: TurnFence;
  receiptId: string;
  kind: "ask" | "answer" | "steer" | "cancel" | "transcript";
  identityDigest: string;
  reconcileRef?: Plain;
  atMs: number;
}
export interface OutboxInput {
  fence: TurnFence;
  outboxId: string;
  destinationDigest: string;
  temporaryBody: Uint8Array;
  atMs: number;
}
export interface PositiveGatewayReceiptProof {
  readonly type: "positive_gateway_receipt_v1";
  readonly operationKey: string;
  readonly identityDigest: string;
  readonly receiptDigest: string;
  readonly reconciliationRef: Plain;
}
export interface RecoveryRecord {
  kind: "turn" | "operation" | "control" | "outbox";
  opaqueKey: string;
  phase: string;
  replayable: boolean;
}
export type LedgerFaultBoundary =
  | "transaction:before-begin"
  | "transaction:after-begin"
  | "transaction:before-commit"
  | "transaction:after-commit"
  | "checkpoint:before"
  | "checkpoint:after"
  | "reserve:before-consume"
  | "reserve:after-consume"
  | "reserve:before-recreate"
  | "reserve:after-recreate";

export interface SQLiteHostLedgerOptions {
  dbPath: string;
  keyring: HostLedgerKeyringInput;
  writerNonce: string;
  now?: () => number;
  busyTimeoutMs?: number;
  verifyPositiveGatewayReceiptProof?: (
    proof: PositiveGatewayReceiptProof,
  ) => boolean;
  /** Qualification seams. Production callers must use the defaults. */
  physicalAccounting?: LedgerPhysicalAccounting;
  injectFault?: (boundary: LedgerFaultBoundary) => void;
  /** Exact generation StateDirectory owner. Defaults to the current process. */
  generationOwner?: GenerationOwner;
  /** Qualification seam. Production generations must retain the 64 MiB default. */
  emergencyReserveBytes?: number;
}
export class HostLedgerConflictError extends Error {
  constructor(message = "Host ledger identity conflict") {
    super(message);
    this.name = "HostLedgerConflictError";
  }
}
export class HostLedgerDeletedError extends Error {
  constructor() {
    super("authoritatively deleted Host ledger session");
    this.name = "HostLedgerDeletedError";
  }
}
class CommitThenThrow extends Error {
  constructor(readonly rejection: Error) {
    super(rejection.message);
  }
}

function exactFence(fence: TurnFence): string {
  if (
    !fence ||
    typeof fence !== "object" ||
    !fence.sessionId ||
    !fence.runId ||
    !fence.turnId ||
    !Number.isSafeInteger(fence.generation) ||
    fence.generation < 1
  )
    throw new Error("invalid exact turn fence");
  return JSON.stringify({
    sessionId: fence.sessionId,
    runId: fence.runId,
    turnId: fence.turnId,
    generation: fence.generation,
  });
}
function canonical(value: Plain): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error("ledger values require safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("ledger value must be plain JSON");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
    .join(",")}}`;
}
const validTime = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("invalid ledger timestamp");
};
const validDigest = (value: string) => {
  if (!DIGEST.test(value)) throw new Error("invalid opaque digest");
};
const keyId = (envelope: string) => envelope.split(".")[1]!;

export class SQLiteHostRecoveryLedger {
  readonly #db: Database;
  readonly #path: string;
  readonly #keys: HostLedgerKeyring;
  readonly #writerNonce: string;
  readonly #now: () => number;
  readonly #verifyPositiveProof?: (
    proof: PositiveGatewayReceiptProof,
  ) => boolean;
  readonly #physical: LedgerPhysicalAccounting;
  readonly #injectFault: (boundary: LedgerFaultBoundary) => void;
  readonly #reserve: GenerationEmergencyReserve;
  #closed = false;
  #activeLiability = 0;

  constructor(options: SQLiteHostLedgerOptions) {
    this.#path = resolve(options.dbPath);
    if (
      !options.dbPath ||
      options.dbPath === ":memory:" ||
      !/^[A-Za-z0-9._:-]{16,128}$/.test(options.writerNonce)
    )
      throw new Error("invalid Host ledger path or writer nonce");
    this.#keys = new HostLedgerKeyring(options.keyring);
    this.#writerNonce = options.writerNonce;
    this.#now = options.now ?? Date.now;
    this.#verifyPositiveProof = options.verifyPositiveGatewayReceiptProof;
    this.#physical = options.physicalAccounting ?? nodeLedgerPhysicalAccounting;
    this.#injectFault = options.injectFault ?? (() => {});
    preparePrivatePath(this.#path);
    preflightSidecars(this.#path);
    const existed = exists(this.#path);
    const db = new Database(this.#path, { create: true, strict: true });
    let claimedWriter = false;
    try {
      db.exec(
        `PRAGMA busy_timeout=${options.busyTimeoutMs ?? 5000}; PRAGMA page_size=4096; PRAGMA foreign_keys=ON;`,
      );
      if (
        Number(
          db.query<{ page_size: number }, []>("PRAGMA page_size").get()!
            .page_size,
        ) !== 4096
      )
        throw new Error("Host ledger page size is not 4096");
      initializeExactLedgerSchema(
        db,
        this.#now(),
        createHash("sha256").update(AGENT_HOST_LEDGER_SCHEMA_SQL).digest("hex"),
      );
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000;",
      );
      const integrity = db
        .query<{ quick_check: string }, []>("PRAGMA quick_check")
        .all();
      if (integrity.length !== 1 || integrity[0]!.quick_check !== "ok")
        throw new Error("Host ledger structural corruption");
      this.#db = db;
      this.#claimWriter();
      claimedWriter = true;
      secureFiles(this.#path);
      const reserve = new GenerationEmergencyReserve({
        stateDirectory: dirname(this.#path),
        owner: options.generationOwner,
        bytes: options.emergencyReserveBytes,
      });
      this.#reserve = reserve;
      try {
        // A crash may leave released reserve blocks occupied by SQLite WAL.
        // Recover/checkpoint first, then make one allocation pass.
        this.#checkpoint(false);
        reserve.replenish();
      } catch (error) {
        reserve.close();
        throw error;
      }
      if (!existed) this.#updatePhysicalHighWater();
      this.validateEncryptedRows();
    } catch (error) {
      if (claimedWriter) {
        try {
          db.query(
            "DELETE FROM writer WHERE singleton=1 AND claim_nonce=? AND process_id=?",
          ).run(this.#writerNonce, process.pid);
        } catch {}
      }
      db.close();
      throw error;
    }
  }

  admitTurn(input: AdmitTurnInput): { admitted: boolean; turnKey: string } {
    validTime(input.admittedAtMs);
    validDigest(input.authorityHash);
    const fenceText = exactFence(input.fence),
      sessionKey = this.#id("session", input.fence.sessionId),
      turnKey = this.#id("turn", input.fence.turnId),
      runKey = this.#id("run", input.fence.runId);
    const descriptor = encoder.encode(canonical(input.recoveryDescriptor));
    const authority = encoder.encode(input.authorityHash);
    try {
      return this.#write(
        turnKey,
        "ordinary",
        {
          encryptedPlaintextBytes:
            descriptor.byteLength +
            authority.byteLength +
            encoder.encode(fenceText).byteLength,
          rowsInserted: 1,
          rowsUpdated: 1,
          rowsDeleted: 0,
          affectedIndexes: 3,
        },
        () => {
          this.#assertNotDeleted(sessionKey);
          const row = this.#db
            .query<
              {
                run_key: string;
                fence_ciphertext: string;
                authority_ciphertext: string;
              },
              [string]
            >(
              "SELECT run_key,fence_ciphertext,authority_ciphertext FROM turns WHERE turn_key=?",
            )
            .get(turnKey);
          if (row) {
            const storedFence = this.#decrypt(
              row.fence_ciphertext,
              "turns",
              turnKey,
              fenceText,
            );
            const storedAuthority = this.#decrypt(
              row.authority_ciphertext,
              "turns",
              turnKey,
              fenceText,
            );
            let mismatch: boolean;
            try {
              mismatch =
                row.run_key !== runKey ||
                decoder.decode(storedFence) !== fenceText ||
                decoder.decode(storedAuthority) !==
                  canonical({
                    authorityHash: input.authorityHash,
                    recoveryDescriptor: input.recoveryDescriptor,
                  });
            } finally {
              storedFence.fill(0);
              storedAuthority.fill(0);
            }
            if (mismatch) {
              this.#quarantineTurn(
                turnKey,
                sessionKey,
                fenceText,
                "turn identity mismatch",
                input.admittedAtMs,
              );
              throw new CommitThenThrow(new HostLedgerConflictError());
            }
            return { admitted: false, turnKey };
          }
          const fenceCiphertext = this.#encrypt(
            encoder.encode(fenceText),
            "turns",
            turnKey,
            fenceText,
            input.admittedAtMs,
          );
          const authorityCiphertext = this.#encrypt(
            encoder.encode(
              canonical({
                authorityHash: input.authorityHash,
                recoveryDescriptor: input.recoveryDescriptor,
              }),
            ),
            "turns",
            turnKey,
            fenceText,
            input.admittedAtMs,
          );
          this.#db
            .query(
              `INSERT INTO turns(session_key,turn_key,run_key,phase,fence_digest,fence_ciphertext,fence_key_id,authority_ciphertext,authority_key_id,admitted_at,byte_count) VALUES(?,?,?,'admitted',?,?,?,?,?,?,?)`,
            )
            .run(
              sessionKey,
              turnKey,
              runKey,
              this.#fenceBinding(fenceText),
              fenceCiphertext,
              keyId(fenceCiphertext),
              authorityCiphertext,
              keyId(authorityCiphertext),
              input.admittedAtMs,
              descriptor.byteLength,
            );
          return { admitted: true, turnKey };
        },
      );
    } finally {
      descriptor.fill(0);
      authority.fill(0);
    }
  }

  markTurnRunning(fence: TurnFence, atMs: number): void {
    this.#turnTransition(fence, "admitted", "running", atMs, "ordinary");
  }
  settleTurn(
    fence: TurnFence,
    phase: "terminal" | "indeterminate",
    atMs: number,
  ): void {
    this.#turnTransition(fence, "running", phase, atMs, "emergency");
  }

  prepareOperation(input: OperationInput): {
    prepared: boolean;
    operationKey: string;
    phase: string;
  } {
    return this.#prepareReceipt(
      "operations",
      input,
      "operation",
      input.operationId,
    );
  }
  markExecuting(input: OperationInput): void {
    this.#operationTransition(input, "prepared", "executing", "ordinary");
  }
  settleOperation(input: OperationInput, reconciliationRef: Plain): void {
    this.#operationTerminal(input, "settled", reconciliationRef);
  }
  markOperationIndeterminate(
    input: OperationInput,
    reconciliationRef: Plain,
  ): void {
    this.#operationTerminal(input, "indeterminate", reconciliationRef);
  }

  recordControl(input: ControlInput): {
    recorded: boolean;
    receiptKey: string;
    phase: string;
  } {
    validDigest(input.identityDigest);
    validTime(input.atMs);
    const fenceText = exactFence(input.fence),
      sessionKey = this.#id("session", input.fence.sessionId),
      turnKey = this.#id("turn", input.fence.turnId),
      receiptKey = this.#id("receipt", input.receiptId);
    const ref =
      input.reconcileRef === undefined
        ? undefined
        : encoder.encode(canonical(input.reconcileRef));
    try {
      return this.#write(
        turnKey,
        input.kind === "cancel" ? "emergency" : "ordinary",
        {
          encryptedPlaintextBytes: ref?.byteLength ?? 0,
          rowsInserted: 1,
          rowsUpdated: 1,
          rowsDeleted: 0,
          affectedIndexes: 2,
        },
        () => {
          this.#requireTurn(turnKey, sessionKey, fenceText);
          this.#assertNotDeleted(sessionKey);
          const row = this.#db
            .query<
              {
                identity_digest: string;
                kind: string;
                phase: string;
                descriptor_ciphertext: string | null;
              },
              [string]
            >(
              "SELECT identity_digest,kind,phase,descriptor_ciphertext FROM control_receipts WHERE receipt_key=?",
            )
            .get(receiptKey);
          if (row) {
            const storedRef = row.descriptor_ciphertext
              ? this.#decrypt(
                  row.descriptor_ciphertext,
                  "control_receipts",
                  receiptKey,
                  fenceText,
                )
              : undefined;
            const refMatches =
              storedRef === undefined
                ? ref === undefined
                : ref !== undefined &&
                  Buffer.from(storedRef).equals(Buffer.from(ref));
            storedRef?.fill(0);
            if (
              row.identity_digest !== input.identityDigest ||
              row.kind !== input.kind ||
              !refMatches
            ) {
              this.#quarantineTurn(
                turnKey,
                sessionKey,
                fenceText,
                "control identity mismatch",
                input.atMs,
              );
              throw new CommitThenThrow(new HostLedgerConflictError());
            }
            return { recorded: false, receiptKey, phase: row.phase };
          }
          const cipher = ref
            ? this.#encrypt(
                ref,
                "control_receipts",
                receiptKey,
                fenceText,
                input.atMs,
              )
            : null;
          this.#db
            .query(
              `INSERT INTO control_receipts(receipt_key,session_key,turn_key,kind,phase,identity_digest,descriptor_ciphertext,descriptor_key_id,created_at,byte_count) VALUES(?,?,?,?,'prepared',?,?,?,?,?)`,
            )
            .run(
              receiptKey,
              sessionKey,
              turnKey,
              input.kind,
              input.identityDigest,
              cipher,
              cipher ? keyId(cipher) : null,
              input.atMs,
              ref?.byteLength ?? 0,
            );
          return { recorded: true, receiptKey, phase: "prepared" };
        },
      );
    } finally {
      ref?.fill(0);
    }
  }
  settleControl(input: ControlInput, reconciliationRef?: Plain): void {
    this.#controlTerminal(input, "settled", reconciliationRef);
  }
  indeterminateControl(input: ControlInput, reconciliationRef?: Plain): void {
    this.#controlTerminal(input, "indeterminate", reconciliationRef);
  }

  enqueueOutbox(input: OutboxInput): { enqueued: boolean; outboxKey: string } {
    validTime(input.atMs);
    validDigest(input.destinationDigest);
    const fenceText = exactFence(input.fence),
      sessionKey = this.#id("session", input.fence.sessionId),
      turnKey = this.#id("turn", input.fence.turnId),
      outboxKey = this.#id("receipt", input.outboxId),
      bodyDigest = this.#id(
        "receipt",
        `outbox-body-v1:${createHash("sha256").update(input.temporaryBody).digest("hex")}`,
      );
    return this.#write(
      turnKey,
      "ordinary",
      {
        encryptedPlaintextBytes: input.temporaryBody.byteLength,
        rowsInserted: 1,
        rowsUpdated: 1,
        rowsDeleted: 0,
        affectedIndexes: 2,
      },
      () => {
        this.#requireTurn(turnKey, sessionKey, fenceText);
        this.#assertNotDeleted(sessionKey);
        const row = this.#db
          .query<
            {
              destination_digest: string;
              body_digest: string;
              body_ciphertext: string | null;
              phase: string;
            },
            [string]
          >(
            "SELECT destination_digest,body_digest,body_ciphertext,phase FROM outbox WHERE outbox_key=?",
          )
          .get(outboxKey);
        if (row) {
          const storedBody = row.body_ciphertext
            ? this.#decrypt(row.body_ciphertext, "outbox", outboxKey, fenceText)
            : undefined;
          const bodyMatches =
            (storedBody !== undefined &&
              Buffer.from(storedBody).equals(
                Buffer.from(input.temporaryBody),
              )) ||
            (storedBody === undefined &&
              row.body_digest === bodyDigest &&
              (row.phase === "acked" || row.phase === "failed"));
          storedBody?.fill(0);
          if (
            row.destination_digest !== input.destinationDigest ||
            row.body_digest !== bodyDigest ||
            !bodyMatches
          ) {
            this.#quarantineTurn(
              turnKey,
              sessionKey,
              fenceText,
              "outbox identity mismatch",
              input.atMs,
            );
            throw new CommitThenThrow(new HostLedgerConflictError());
          }
          return { enqueued: false, outboxKey };
        }
        const body = this.#encrypt(
          input.temporaryBody,
          "outbox",
          outboxKey,
          fenceText,
          input.atMs,
        );
        this.#db
          .query(
            `INSERT INTO outbox(outbox_key,session_key,turn_key,phase,destination_digest,body_digest,body_ciphertext,body_key_id,created_at,byte_count) VALUES(?,?,?,'queued',?,?,?,?,?,?)`,
          )
          .run(
            outboxKey,
            sessionKey,
            turnKey,
            input.destinationDigest,
            bodyDigest,
            body,
            keyId(body),
            input.atMs,
            input.temporaryBody.byteLength,
          );
        return { enqueued: true, outboxKey };
      },
    );
  }
  claimOutbox(
    limit = 32,
  ): Array<{ outboxKey: string; temporaryBody: Uint8Array }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)
      throw new Error("invalid outbox claim limit");
    const rows = this.#db
      .query<
        {
          outbox_key: string;
          turn_key: string;
          body_ciphertext: string;
          fence_ciphertext: string;
        },
        [number]
      >(
        `SELECT o.outbox_key,o.turn_key,o.body_ciphertext,t.fence_ciphertext FROM outbox o JOIN turns t ON t.turn_key=o.turn_key WHERE o.phase='queued' ORDER BY o.created_at LIMIT ?`,
      )
      .all(limit);
    const result: Array<{ outboxKey: string; temporaryBody: Uint8Array }> = [];
    for (const row of rows)
      this.#write(
        row.turn_key,
        "ordinary",
        {
          encryptedPlaintextBytes: 0,
          rowsInserted: 0,
          rowsUpdated: 1,
          rowsDeleted: 0,
          affectedIndexes: 1,
        },
        () => {
          const changed = this.#db
            .query(
              "UPDATE outbox SET phase='claimed',claimed_at=?,attempts=attempts+1 WHERE outbox_key=? AND phase='queued'",
            )
            .run(this.#now(), row.outbox_key);
          if (changed.changes === 1) {
            const fence = decoder.decode(
              this.#decrypt(
                row.fence_ciphertext,
                "turns",
                row.turn_key,
                this.#fenceFor(row.turn_key),
              ),
            );
            result.push({
              outboxKey: row.outbox_key,
              temporaryBody: this.#decrypt(
                row.body_ciphertext,
                "outbox",
                row.outbox_key,
                fence,
              ),
            });
          }
        },
      );
    return result;
  }
  ackOutbox(outboxKey: string, atMs: number): void {
    validTime(atMs);
    this.#outboxTerminal(outboxKey, "acked", atMs);
  }
  failOutbox(outboxKey: string, atMs: number): void {
    validTime(atMs);
    this.#outboxTerminal(outboxKey, "failed", atMs);
  }

  scanRecover(
    proofs: ReadonlyMap<string, PositiveGatewayReceiptProof> = new Map(),
  ): RecoveryRecord[] {
    const records: RecoveryRecord[] = [];
    const operations = this.#db
      .query<
        {
          operation_key: string;
          turn_key: string;
          phase: string;
          identity_digest: string;
        },
        []
      >(
        "SELECT operation_key,turn_key,phase,identity_digest FROM operations WHERE phase IN ('prepared','executing')",
      )
      .all();
    for (const row of operations) {
      let recoveredPhase = row.phase;
      if (row.phase === "executing") {
        const proof = proofs.get(row.operation_key);
        if (
          proof?.type === "positive_gateway_receipt_v1" &&
          proof.operationKey === row.operation_key &&
          proof.identityDigest === row.identity_digest &&
          DIGEST.test(proof.identityDigest) &&
          DIGEST.test(proof.receiptDigest) &&
          this.#verifyPositiveProof?.(proof) === true
        ) {
          const fence = this.#fenceFor(row.turn_key);
          const bytes = encoder.encode(canonical(proof.reconciliationRef));
          try {
            const cipher = this.#encrypt(
              bytes,
              "operations",
              row.operation_key,
              fence,
              this.#now(),
            );
            this.#write(
              row.turn_key,
              "emergency",
              {
                encryptedPlaintextBytes: bytes.byteLength,
                rowsInserted: 0,
                rowsUpdated: 1,
                rowsDeleted: 0,
                affectedIndexes: 1,
              },
              () =>
                this.#db
                  .query(
                    "UPDATE operations SET phase='settled',reconcile_ciphertext=?,reconcile_key_id=?,terminal_at=? WHERE operation_key=? AND phase='executing'",
                  )
                  .run(cipher, keyId(cipher), this.#now(), row.operation_key),
            );
          } finally {
            bytes.fill(0);
          }
          recoveredPhase = "settled";
        } else {
          this.#write(
            row.turn_key,
            "emergency",
            {
              encryptedPlaintextBytes: 0,
              rowsInserted: 0,
              rowsUpdated: 1,
              rowsDeleted: 0,
              affectedIndexes: 1,
            },
            () =>
              this.#db
                .query(
                  "UPDATE operations SET phase='indeterminate',terminal_at=? WHERE operation_key=? AND phase='executing'",
                )
                .run(this.#now(), row.operation_key),
          );
          recoveredPhase = "indeterminate";
        }
      }
      records.push({
        kind: "operation",
        opaqueKey: row.operation_key,
        phase: recoveredPhase,
        replayable: recoveredPhase === "prepared",
      });
    }
    for (const row of this.#db
      .query<{ turn_key: string; phase: string }, []>(
        "SELECT turn_key,phase FROM turns WHERE phase IN ('admitted','running')",
      )
      .all())
      records.push({
        kind: "turn",
        opaqueKey: row.turn_key,
        phase: row.phase,
        replayable: false,
      });
    for (const row of this.#db
      .query<{ receipt_key: string; phase: string }, []>(
        "SELECT receipt_key,phase FROM control_receipts WHERE phase='prepared'",
      )
      .all())
      records.push({
        kind: "control",
        opaqueKey: row.receipt_key,
        phase: row.phase,
        replayable: false,
      });
    for (const row of this.#db
      .query<{ outbox_key: string; turn_key: string; phase: string }, []>(
        "SELECT outbox_key,turn_key,phase FROM outbox WHERE phase IN ('queued','claimed')",
      )
      .all()) {
      if (row.phase === "claimed")
        this.#write(
          row.turn_key,
          "emergency",
          {
            encryptedPlaintextBytes: 0,
            rowsInserted: 0,
            rowsUpdated: 1,
            rowsDeleted: 0,
            affectedIndexes: 1,
          },
          () =>
            this.#db
              .query(
                "UPDATE outbox SET phase='queued',claimed_at=NULL WHERE outbox_key=? AND phase='claimed'",
              )
              .run(row.outbox_key),
        );
      records.push({
        kind: "outbox",
        opaqueKey: row.outbox_key,
        phase: "queued",
        replayable: true,
      });
    }
    return records;
  }

  quarantine(
    fence: TurnFence,
    evidenceId: string,
    evidence: Plain,
    atMs: number,
  ): void {
    validTime(atMs);
    const fenceText = exactFence(fence),
      sessionKey = this.#id("session", fence.sessionId),
      turnKey = this.#id("turn", fence.turnId),
      evidenceKey = this.#id("receipt", evidenceId);
    const bytes = encoder.encode(canonical(evidence));
    try {
      this.#write(
        turnKey,
        "emergency",
        {
          encryptedPlaintextBytes: bytes.byteLength,
          rowsInserted: 1,
          rowsUpdated: 1,
          rowsDeleted: 0,
          affectedIndexes: 2,
        },
        () => {
          this.#requireTurn(turnKey, sessionKey, fenceText);
          const cipher = this.#encrypt(
            bytes,
            "quarantine_evidence",
            evidenceKey,
            fenceText,
            atMs,
          );
          this.#db
            .query(
              "UPDATE turns SET phase='quarantined',terminal_at=? WHERE turn_key=?",
            )
            .run(atMs, turnKey);
          this.#db
            .query(
              `INSERT OR IGNORE INTO quarantine_evidence(evidence_key,session_key,turn_key,phase,evidence_ciphertext,evidence_key_id,created_at,terminal_at,byte_count) VALUES(?,?,?,'quarantined',?,?,?,?,?)`,
            )
            .run(
              evidenceKey,
              sessionKey,
              turnKey,
              cipher,
              keyId(cipher),
              atMs,
              atMs,
              bytes.byteLength,
            );
        },
      );
    } finally {
      bytes.fill(0);
    }
  }
  purgeExpired(nowMs: number): number {
    validTime(nowMs);
    const cutoff = nowMs - AGENT_HOST_LEDGER_RETENTION_MS;
    const rowsDeleted = this.#db
      .query<{ count: number }, [number, number, number, number, number]>(
        `SELECT
          (SELECT COUNT(*) FROM quarantine_evidence WHERE terminal_at < ?) +
          (SELECT COUNT(*) FROM operations WHERE turn_key IN (SELECT turn_key FROM turns WHERE phase IN ('terminal','indeterminate','quarantined') AND terminal_at < ?)) +
          (SELECT COUNT(*) FROM control_receipts WHERE turn_key IN (SELECT turn_key FROM turns WHERE phase IN ('terminal','indeterminate','quarantined') AND terminal_at < ?)) +
          (SELECT COUNT(*) FROM outbox WHERE turn_key IN (SELECT turn_key FROM turns WHERE phase IN ('terminal','indeterminate','quarantined') AND terminal_at < ?)) +
          (SELECT COUNT(*) FROM turns WHERE phase IN ('terminal','indeterminate','quarantined') AND terminal_at < ?) +
          (SELECT COUNT(*) FROM deletion_tombstones WHERE expires_at < ${nowMs}) AS count`,
      )
      .get(cutoff, cutoff, cutoff, cutoff, cutoff)!.count;
    return this.#write(
      undefined,
      "emergency",
      {
        encryptedPlaintextBytes: 0,
        rowsInserted: 0,
        rowsUpdated: 0,
        rowsDeleted,
        affectedIndexes: 4,
        checkpointPossible: true,
      },
      () => {
        const a = this.#db
          .query("DELETE FROM quarantine_evidence WHERE terminal_at < ?")
          .run(cutoff).changes;
        const b = this.#db
          .query(
            "DELETE FROM turns WHERE phase IN ('terminal','indeterminate','quarantined') AND terminal_at < ?",
          )
          .run(cutoff).changes;
        const c = this.#db
          .query("DELETE FROM deletion_tombstones WHERE expires_at < ?")
          .run(nowMs).changes;
        return a + b + c;
      },
    );
  }
  deleteSession(sessionId: string, atMs: number): number {
    validTime(atMs);
    const sessionKey = this.#id("session", sessionId);
    const rowsDeleted = this.#db
      .query<{ count: number }, [string, string, string, string, string]>(
        `SELECT
          (SELECT COUNT(*) FROM operations WHERE session_key=?) +
          (SELECT COUNT(*) FROM control_receipts WHERE session_key=?) +
          (SELECT COUNT(*) FROM outbox WHERE session_key=?) +
          (SELECT COUNT(*) FROM quarantine_evidence WHERE session_key=?) +
          (SELECT COUNT(*) FROM turns WHERE session_key=?) AS count`,
      )
      .get(sessionKey, sessionKey, sessionKey, sessionKey, sessionKey)!.count;
    return this.#write(
      undefined,
      "emergency",
      {
        encryptedPlaintextBytes: 0,
        rowsInserted: 1,
        rowsUpdated: 0,
        rowsDeleted,
        affectedIndexes: 8,
        checkpointPossible: true,
      },
      () => {
        const count = this.#db
          .query("DELETE FROM turns WHERE session_key=?")
          .run(sessionKey).changes;
        this.#db
          .query("DELETE FROM quarantine_evidence WHERE session_key=?")
          .run(sessionKey);
        this.#db
          .query(
            "INSERT INTO deletion_tombstones(session_key,deleted_at,expires_at) VALUES(?,?,?) ON CONFLICT(session_key) DO UPDATE SET deleted_at=excluded.deleted_at,expires_at=excluded.expires_at",
          )
          .run(sessionKey, atMs, atMs + AGENT_HOST_LEDGER_RETENTION_MS);
        return count;
      },
    );
  }
  validateEncryptedRows(): void {
    for (const row of this.#db
      .query<
        {
          turn_key: string;
          fence_ciphertext: string;
          authority_ciphertext: string;
        },
        []
      >("SELECT turn_key,fence_ciphertext,authority_ciphertext FROM turns")
      .all()) {
      const fence = this.#fenceFor(row.turn_key);
      const a = this.#decrypt(
        row.authority_ciphertext,
        "turns",
        row.turn_key,
        fence,
      );
      a.fill(0);
    }
  }
  close(): void {
    if (this.#closed) return;
    this.#db
      .query(
        "DELETE FROM writer WHERE singleton=1 AND claim_nonce=? AND process_id=?",
      )
      .run(this.#writerNonce, process.pid);
    this.#db.close();
    this.#reserve.close();
    this.#closed = true;
  }

  #turnTransition(
    fence: TurnFence,
    from: "admitted" | "running",
    to: "running" | "terminal" | "indeterminate",
    atMs: number,
    writeClass: LedgerWriteClass,
  ): void {
    validTime(atMs);
    const fenceText = exactFence(fence);
    const sessionKey = this.#id("session", fence.sessionId);
    const turnKey = this.#id("turn", fence.turnId);
    this.#write(
      turnKey,
      writeClass,
      {
        encryptedPlaintextBytes: 0,
        rowsInserted: 0,
        rowsUpdated: 1,
        rowsDeleted: 0,
        affectedIndexes: 1,
      },
      () => {
        this.#requireTurn(turnKey, sessionKey, fenceText);
        const changed = this.#db
          .query(
            "UPDATE turns SET phase=?,terminal_at=? WHERE turn_key=? AND phase=?",
          )
          .run(to, to === "running" ? null : atMs, turnKey, from);
        if (changed.changes !== 1)
          throw new HostLedgerConflictError("illegal turn transition");
      },
    );
  }

  #prepareReceipt(
    _table: "operations",
    input: OperationInput,
    idKind: "operation",
    rawId: string,
  ) {
    validDigest(input.identityDigest);
    validTime(input.atMs);
    const fenceText = exactFence(input.fence),
      sessionKey = this.#id("session", input.fence.sessionId),
      turnKey = this.#id("turn", input.fence.turnId),
      operationKey = this.#id(idKind, rawId);
    const bytes = encoder.encode(canonical(input.reconcileRef));
    try {
      return this.#write(
        turnKey,
        "ordinary",
        {
          encryptedPlaintextBytes: bytes.byteLength,
          rowsInserted: 1,
          rowsUpdated: 1,
          rowsDeleted: 0,
          affectedIndexes: 2,
        },
        () => {
          this.#requireTurn(turnKey, sessionKey, fenceText);
          this.#assertNotDeleted(sessionKey);
          const row = this.#db
            .query<
              {
                identity_digest: string;
                phase: string;
                descriptor_ciphertext: string;
              },
              [string]
            >(
              "SELECT identity_digest,phase,descriptor_ciphertext FROM operations WHERE operation_key=?",
            )
            .get(operationKey);
          if (row) {
            const storedDescriptor = this.#decrypt(
              row.descriptor_ciphertext,
              "operations",
              operationKey,
              fenceText,
            );
            const descriptorMatches = Buffer.from(storedDescriptor).equals(
              Buffer.from(bytes),
            );
            storedDescriptor.fill(0);
            if (
              row.identity_digest !== input.identityDigest ||
              !descriptorMatches
            ) {
              this.#quarantineTurn(
                turnKey,
                sessionKey,
                fenceText,
                "operation identity mismatch",
                input.atMs,
              );
              throw new CommitThenThrow(new HostLedgerConflictError());
            }
            return { prepared: false, operationKey, phase: row.phase };
          }
          const descriptor = this.#encrypt(
            bytes,
            "operations",
            operationKey,
            fenceText,
            input.atMs,
          );
          this.#db
            .query(
              `INSERT INTO operations(operation_key,session_key,turn_key,phase,identity_digest,descriptor_ciphertext,descriptor_key_id,prepared_at,byte_count) VALUES(?,?,?,'prepared',?,?,?,?,?)`,
            )
            .run(
              operationKey,
              sessionKey,
              turnKey,
              input.identityDigest,
              descriptor,
              keyId(descriptor),
              input.atMs,
              bytes.byteLength,
            );
          return { prepared: true, operationKey, phase: "prepared" };
        },
      );
    } finally {
      bytes.fill(0);
    }
  }
  #operationTransition(
    input: OperationInput,
    from: string,
    to: string,
    writeClass: LedgerWriteClass,
  ) {
    validTime(input.atMs);
    const fenceText = exactFence(input.fence),
      sessionKey = this.#id("session", input.fence.sessionId),
      turnKey = this.#id("turn", input.fence.turnId),
      operationKey = this.#id("operation", input.operationId);
    this.#write(
      turnKey,
      writeClass,
      {
        encryptedPlaintextBytes: 0,
        rowsInserted: 0,
        rowsUpdated: 1,
        rowsDeleted: 0,
        affectedIndexes: 1,
      },
      () => {
        this.#requireTurn(turnKey, sessionKey, fenceText);
        const row = this.#db
          .query<
            { identity_digest: string; phase: string; turn_key: string },
            [string]
          >(
            "SELECT identity_digest,phase,turn_key FROM operations WHERE operation_key=?",
          )
          .get(operationKey);
        if (
          !row ||
          row.identity_digest !== input.identityDigest ||
          row.turn_key !== turnKey ||
          row.phase !== from
        )
          throw new HostLedgerConflictError(
            `illegal operation transition to ${to}`,
          );
        this.#db
          .query(
            `UPDATE operations SET phase=?,executing_at=? WHERE operation_key=?`,
          )
          .run(to, input.atMs, operationKey);
      },
    );
  }
  #operationTerminal(
    input: OperationInput,
    phase: "settled" | "indeterminate",
    ref: Plain,
  ) {
    validTime(input.atMs);
    const fenceText = exactFence(input.fence),
      sessionKey = this.#id("session", input.fence.sessionId),
      turnKey = this.#id("turn", input.fence.turnId),
      operationKey = this.#id("operation", input.operationId),
      bytes = encoder.encode(canonical(ref));
    try {
      this.#write(
        turnKey,
        "emergency",
        {
          encryptedPlaintextBytes: bytes.byteLength,
          rowsInserted: 0,
          rowsUpdated: 1,
          rowsDeleted: 0,
          affectedIndexes: 1,
        },
        () => {
          this.#requireTurn(turnKey, sessionKey, fenceText);
          const cipher = this.#encrypt(
            bytes,
            "operations",
            operationKey,
            fenceText,
            input.atMs,
          );
          const changed = this.#db
            .query(
              "UPDATE operations SET phase=?,reconcile_ciphertext=?,reconcile_key_id=?,terminal_at=? WHERE operation_key=? AND turn_key=? AND identity_digest=? AND phase='executing'",
            )
            .run(
              phase,
              cipher,
              keyId(cipher),
              input.atMs,
              operationKey,
              turnKey,
              input.identityDigest,
            );
          if (changed.changes !== 1)
            throw new HostLedgerConflictError(
              "illegal operation terminal transition",
            );
        },
      );
    } finally {
      bytes.fill(0);
    }
  }
  #controlTerminal(
    input: ControlInput,
    phase: "settled" | "indeterminate",
    ref?: Plain,
  ) {
    validTime(input.atMs);
    const receiptKey = this.#id("receipt", input.receiptId),
      sessionKey = this.#id("session", input.fence.sessionId),
      turnKey = this.#id("turn", input.fence.turnId),
      fenceText = exactFence(input.fence),
      bytes = ref === undefined ? undefined : encoder.encode(canonical(ref));
    try {
      this.#write(
        turnKey,
        "emergency",
        {
          encryptedPlaintextBytes: bytes?.byteLength ?? 0,
          rowsInserted: 0,
          rowsUpdated: 1,
          rowsDeleted: 0,
          affectedIndexes: 1,
        },
        () => {
          this.#requireTurn(turnKey, sessionKey, fenceText);
          const cipher = bytes
            ? this.#encrypt(
                bytes,
                "control_receipts",
                receiptKey,
                fenceText,
                input.atMs,
              )
            : null;
          const changed = this.#db
            .query(
              "UPDATE control_receipts SET phase=?,reconcile_ciphertext=?,reconcile_key_id=?,terminal_at=? WHERE receipt_key=? AND turn_key=? AND identity_digest=? AND kind=? AND phase='prepared'",
            )
            .run(
              phase,
              cipher,
              cipher ? keyId(cipher) : null,
              input.atMs,
              receiptKey,
              turnKey,
              input.identityDigest,
              input.kind,
            );
          if (changed.changes !== 1)
            throw new HostLedgerConflictError("illegal control transition");
        },
      );
    } finally {
      bytes?.fill(0);
    }
  }
  #outboxTerminal(outboxKey: string, phase: "acked" | "failed", atMs: number) {
    if (!DIGEST.test(outboxKey)) throw new Error("outbox key must be opaque");
    const row = this.#db
      .query<{ turn_key: string }, [string]>(
        "SELECT turn_key FROM outbox WHERE outbox_key=?",
      )
      .get(outboxKey);
    if (!row) throw new HostLedgerConflictError("unknown outbox row");
    this.#write(
      row.turn_key,
      "emergency",
      {
        encryptedPlaintextBytes: 0,
        rowsInserted: 0,
        rowsUpdated: 1,
        rowsDeleted: 0,
        affectedIndexes: 1,
      },
      () => {
        const changed = this.#db
          .query(
            "UPDATE outbox SET phase=?,body_ciphertext=NULL,body_key_id=NULL,byte_count=0,terminal_at=? WHERE outbox_key=? AND phase='claimed'",
          )
          .run(phase, atMs, outboxKey);
        if (changed.changes !== 1)
          throw new HostLedgerConflictError(
            "illegal outbox terminal transition",
          );
      },
    );
  }
  #write<T>(
    turnKey: string | undefined,
    writeClass: LedgerWriteClass,
    shape: WriteShape,
    fn: () => T,
  ): T {
    this.#open();
    const before = this.#physical.snapshot(this.#path);
    const accounting = this.#db
      .query<{ global_charge: number }, []>(
        "SELECT global_charge FROM accounting WHERE singleton=1",
      )
      .get()!;
    const turn = turnKey
      ? this.#db
          .query<{ charged_bytes: number }, [string]>(
            "SELECT charged_bytes FROM turns WHERE turn_key=?",
          )
          .get(turnKey)
      : undefined;
    const emergency = writeClass === "emergency";
    const effectiveShape = emergency
      ? { ...shape, checkpointPossible: true }
      : shape;
    const reserve = this.#reserve.snapshot();
    const liability = preflightLiability({
      shape: effectiveShape,
      writeClass,
      currentPhysicalBytes: before.totalBytes,
      globalChargedBytes: accounting.global_charge,
      turnChargedBytes: turn?.charged_bytes ?? 0,
      activeLiabilityBytes: this.#activeLiability,
      availableBytes: before.availableBytes,
      reserveAvailableBytes: Math.min(
        reserve.logicalBytes,
        reserve.allocatedBytes,
      ),
      chargeTurn: turnKey !== undefined,
    });
    this.#activeLiability += liability.bytes;
    let reserveConsumed = false;
    let committed = false;
    try {
      if (emergency) {
        this.#injectFault("reserve:before-consume");
        this.#reserve.consume(liability.bytes);
        reserveConsumed = true;
        this.#injectFault("reserve:after-consume");
      }
      this.#injectFault("transaction:before-begin");
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#injectFault("transaction:after-begin");
        const result = fn();
        this.#applyCharge(
          turnKey,
          liability.bytes,
          liability.turnCharge,
          before.totalBytes + liability.bytes,
        );
        this.#injectFault("transaction:before-commit");
        this.#db.exec("COMMIT");
        committed = true;
        this.#injectFault("transaction:after-commit");
        const after = this.#physical.snapshot(this.#path);
        assertCommittedBound(before, after, liability);
        if (emergency) {
          this.#checkpointAndRestoreReserve(true);
          reserveConsumed = false;
        } else if (shape.checkpointPossible) {
          this.#checkpointAndRestoreReserve(true);
        }
        return result;
      } catch (error) {
        if (error instanceof CommitThenThrow && !committed) {
          this.#applyCharge(
            turnKey,
            liability.bytes,
            liability.turnCharge,
            before.totalBytes + liability.bytes,
          );
          this.#injectFault("transaction:before-commit");
          this.#db.exec("COMMIT");
          committed = true;
          this.#injectFault("transaction:after-commit");
          const after = this.#physical.snapshot(this.#path);
          assertCommittedBound(before, after, liability);
          if (emergency) {
            this.#checkpointAndRestoreReserve(true);
            reserveConsumed = false;
          }
          throw error.rejection;
        }
        if (!committed) {
          try {
            this.#db.exec("ROLLBACK");
          } catch {}
        }
        throw error;
      }
    } finally {
      if (reserveConsumed) {
        try {
          if (committed) this.#checkpointAndRestoreReserve(false);
          else this.#reserve.replenish();
        } catch {
          // Preserve the operation failure. Reopen reconciliation checkpoints
          // before its single reserve allocation pass.
        }
      }
      this.#activeLiability -= liability.bytes;
    }
  }
  #applyCharge(
    turnKey: string | undefined,
    bytes: number,
    turnCharge: number,
    physicalUpperBound: number,
  ) {
    this.#db
      .query(
        "UPDATE accounting SET global_charge=global_charge+?,physical_high_water=MAX(physical_high_water,?),active_liability=0 WHERE singleton=1",
      )
      .run(bytes, physicalUpperBound);
    if (turnKey)
      this.#db
        .query(
          "UPDATE turns SET charged_bytes=charged_bytes+? WHERE turn_key=?",
        )
        .run(turnCharge, turnKey);
  }
  #checkpoint(inject: boolean) {
    if (inject) this.#injectFault("checkpoint:before");
    const checkpoint = this.#db
      .query<{ busy: number; log: number; checkpointed: number }, []>(
        "PRAGMA wal_checkpoint(TRUNCATE)",
      )
      .get();
    if (
      !checkpoint ||
      checkpoint.busy !== 0 ||
      checkpoint.log !== checkpoint.checkpointed
    )
      throw new Error("Host ledger checkpoint did not complete");
    if (inject) this.#injectFault("checkpoint:after");
  }
  #checkpointAndRestoreReserve(inject: boolean) {
    this.#checkpoint(inject);
    const physical = this.#physical.snapshot(this.#path);
    if (inject) this.#injectFault("reserve:before-recreate");
    this.#db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      this.#db
        .query(
          "UPDATE accounting SET global_charge=?,physical_high_water=MAX(physical_high_water,?),active_liability=0 WHERE singleton=1",
        )
        .run(physical.totalBytes, physical.totalBytes);
      this.#db.exec("COMMIT");
      committed = true;
    } finally {
      if (!committed) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {}
      }
    }
    // The accounting update itself wrote a WAL frame. Retire it before taking
    // the released filesystem blocks back for the generation.
    this.#checkpoint(false);
    this.#reserve.replenish();
    if (inject) this.#injectFault("reserve:after-recreate");
  }
  #encrypt(
    bytes: Uint8Array,
    table: string,
    pk: string,
    fence: string,
    now: number,
  ) {
    return this.#keys.encrypt(
      bytes,
      {
        table,
        opaquePrimaryKey: pk,
        exactFence: DIGEST.test(fence) ? fence : this.#fenceBinding(fence),
      },
      now,
    );
  }
  #decrypt(value: string, table: string, pk: string, fence: string) {
    return this.#keys.decrypt(
      value,
      {
        table,
        opaquePrimaryKey: pk,
        exactFence: DIGEST.test(fence) ? fence : this.#fenceBinding(fence),
      },
      this.#now(),
    );
  }
  #id(kind: "session" | "run" | "turn" | "operation" | "receipt", raw: string) {
    return this.#keys.opaqueId(kind, raw);
  }
  #fenceBinding(fence: string) {
    return this.#keys.opaqueId("receipt", `exact-fence-v1:${fence}`);
  }
  #fenceFor(turnKey: string): string {
    const row = this.#db
      .query<{ fence_digest: string }, [string]>(
        "SELECT fence_digest FROM turns WHERE turn_key=?",
      )
      .get(turnKey);
    if (!row) throw new HostLedgerConflictError("unknown turn");
    return row.fence_digest;
  }
  #requireTurn(turnKey: string, sessionKey: string, fence: string) {
    const row = this.#db
      .query<{ session_key: string; fence_ciphertext: string }, [string]>(
        "SELECT session_key,fence_ciphertext FROM turns WHERE turn_key=?",
      )
      .get(turnKey);
    if (!row) throw new HostLedgerConflictError("turn not admitted");
    if (row.session_key !== sessionKey) {
      this.#quarantineTurn(
        turnKey,
        row.session_key,
        this.#fenceFor(turnKey),
        "session fence mismatch",
        this.#now(),
      );
      throw new CommitThenThrow(
        new HostLedgerConflictError("turn session mismatch"),
      );
    }
    let clear: Uint8Array;
    try {
      clear = this.#decrypt(row.fence_ciphertext, "turns", turnKey, fence);
    } catch {
      this.#quarantineTurn(
        turnKey,
        row.session_key,
        this.#fenceFor(turnKey),
        "exact fence authentication mismatch",
        this.#now(),
      );
      throw new CommitThenThrow(
        new HostLedgerConflictError("exact fence mismatch"),
      );
    }
    try {
      if (decoder.decode(clear) !== fence) {
        this.#quarantineTurn(
          turnKey,
          row.session_key,
          this.#fenceFor(turnKey),
          "exact fence mismatch",
          this.#now(),
        );
        throw new CommitThenThrow(
          new HostLedgerConflictError("exact fence mismatch"),
        );
      }
    } finally {
      clear.fill(0);
    }
  }
  #assertNotDeleted(sessionKey: string) {
    if (
      this.#db
        .query("SELECT 1 FROM deletion_tombstones WHERE session_key=?")
        .get(sessionKey)
    )
      throw new HostLedgerDeletedError();
  }
  #quarantineTurn(
    turnKey: string,
    sessionKey: string,
    fence: string,
    reason: string,
    atMs: number,
  ) {
    const evidenceKey = this.#id("receipt", `${turnKey}:${atMs}:${reason}`),
      bytes = encoder.encode(canonical({ reason }));
    try {
      const cipher = this.#encrypt(
        bytes,
        "quarantine_evidence",
        evidenceKey,
        fence,
        atMs,
      );
      this.#db
        .query(
          "UPDATE turns SET phase='quarantined',terminal_at=? WHERE turn_key=?",
        )
        .run(atMs, turnKey);
      this.#db
        .query(
          `INSERT OR IGNORE INTO quarantine_evidence(evidence_key,session_key,turn_key,phase,evidence_ciphertext,evidence_key_id,created_at,terminal_at,byte_count) VALUES(?,?,?,'quarantined',?,?,?,?,?)`,
        )
        .run(
          evidenceKey,
          sessionKey,
          turnKey,
          cipher,
          keyId(cipher),
          atMs,
          atMs,
          bytes.byteLength,
        );
    } finally {
      bytes.fill(0);
    }
  }
  #claimWriter() {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#db
        .query<{ process_id: number }, []>(
          "SELECT process_id FROM writer WHERE singleton=1",
        )
        .get();
      if (existing && processIsAlive(existing.process_id))
        throw new Error("Host ledger already has a live sole writer");
      this.#db
        .query(
          "INSERT INTO writer(singleton,claim_nonce,process_id,claimed_at) VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET claim_nonce=excluded.claim_nonce,process_id=excluded.process_id,claimed_at=excluded.claimed_at",
        )
        .run(this.#writerNonce, process.pid, this.#now());
      this.#db.exec("COMMIT");
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  #updatePhysicalHighWater() {
    const size = this.#physical.snapshot(this.#path).totalBytes;
    this.#db
      .query("UPDATE accounting SET physical_high_water=? WHERE singleton=1")
      .run(size);
  }
  #open() {
    if (this.#closed) throw new Error("Host ledger is closed");
  }
}
function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
function exists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function preparePrivatePath(path: string) {
  const root = parse(path).root;
  let current = root;
  for (const part of dirname(path)
    .slice(root.length)
    .split("/")
    .filter(Boolean)) {
    current = resolve(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("unsafe Host ledger path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
  }
  if (exists(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error("unsafe Host ledger file");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    closeSync(fd);
  }
}
function preflightSidecars(path: string) {
  for (const suffix of ["-wal", "-shm"]) {
    const side = `${path}${suffix}`;
    if (exists(side)) {
      const stat = lstatSync(side);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error("unsafe Host ledger sidecar");
    }
  }
}
function secureFiles(path: string) {
  for (const file of [path, `${path}-wal`, `${path}-shm`])
    if (exists(file)) chmodSync(file, 0o600);
}
