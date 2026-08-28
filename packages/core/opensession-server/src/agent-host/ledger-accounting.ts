import { statfsSync, statSync } from "node:fs";

export const LEDGER_PAGE_BYTES = 4096;
export const LEDGER_WAL_FRAME_BYTES = 4096 + 24;
export const LEDGER_ENCRYPTED_CHUNK_BYTES = 2048;
export const LEDGER_TURN_PHYSICAL_MAX = 32 * 1024 * 1024;
export const LEDGER_ORDINARY_PHYSICAL_MAX = 448 * 1024 * 1024;
export const LEDGER_TOTAL_PHYSICAL_MAX = 512 * 1024 * 1024;
export const LEDGER_PROTECTED_PHYSICAL_BYTES = 64 * 1024 * 1024;

export type LedgerWriteClass = "ordinary" | "emergency";
export interface PhysicalSnapshot {
  readonly mainBytes: number;
  readonly walBytes: number;
  readonly shmBytes: number;
  readonly totalBytes: number;
  readonly availableBytes: number;
}
export interface WriteShape {
  readonly encryptedPlaintextBytes: number;
  readonly rowsInserted: number;
  readonly rowsUpdated: number;
  readonly rowsDeleted: number;
  readonly affectedIndexes: number;
  readonly checkpointPossible?: boolean;
}
export interface Liability {
  readonly bytes: number;
  readonly writeClass: LedgerWriteClass;
  readonly turnCharge: number;
}
export class LedgerCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerCapacityError";
  }
}
export class LedgerAccountingContradictionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerAccountingContradictionError";
  }
}

const fileBytes = (path: string): number => {
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
};
export interface LedgerPhysicalAccounting {
  snapshot(dbPath: string): PhysicalSnapshot;
}

export const nodeLedgerPhysicalAccounting: LedgerPhysicalAccounting = {
  snapshot: snapshotPhysical,
};

export function snapshotPhysical(dbPath: string): PhysicalSnapshot {
  const mainBytes = fileBytes(dbPath);
  const walBytes = fileBytes(`${dbPath}-wal`);
  const shmBytes = fileBytes(`${dbPath}-shm`);
  const fs = statfsSync(dbPath);
  return {
    mainBytes,
    walBytes,
    shmBytes,
    totalBytes: mainBytes + walBytes + shmBytes,
    availableBytes: Number(fs.bavail) * Number(fs.bsize),
  };
}

/**
 * Proven-conservative transaction model for this schema, not exact SQLite
 * attribution. Each 2 KiB plaintext chunk is charged for one data leaf and one
 * overflow page; each touched index is charged a leaf plus parent/root split.
 * Every dirty page is charged both its database page and a WAL frame. The fixed
 * twelve-page term covers schema/accounting rows, freelist/trunk churn, WAL
 * header rounding and an extra root split. A checkpoint-capable transaction is
 * charged a second database-page copy for every dirty page. This deliberately
 * overstates ordinary writes. Bun does not expose SQLite's dirty-page set or
 * checkpoint peak, so measured post-commit deltas can validate this upper bound
 * but cannot prove exact per-turn physical attribution.
 */
export function conservativeTransactionBound(shape: WriteShape): number {
  for (const value of [
    shape.encryptedPlaintextBytes,
    shape.rowsInserted,
    shape.rowsUpdated,
    shape.rowsDeleted,
    shape.affectedIndexes,
  ])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("invalid ledger write shape");
  const chunks = Math.max(
    1,
    Math.ceil(shape.encryptedPlaintextBytes / LEDGER_ENCRYPTED_CHUNK_BYTES),
  );
  const rowTouches = shape.rowsInserted + shape.rowsUpdated + shape.rowsDeleted;
  const dataPages = chunks * 2 + rowTouches * 3;
  const indexPages = Math.max(1, rowTouches) * shape.affectedIndexes * 3;
  const dirtyPages = 12 + dataPages + indexPages;
  const wal = 32 + dirtyPages * LEDGER_WAL_FRAME_BYTES;
  const database = dirtyPages * LEDGER_PAGE_BYTES;
  return wal + database + (shape.checkpointPossible ? database : 0);
}

function capacityInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new LedgerCapacityError(`invalid ${label}`);
}

export function preflightLiability(input: {
  shape: WriteShape;
  writeClass: LedgerWriteClass;
  currentPhysicalBytes: number;
  globalChargedBytes: number;
  turnChargedBytes: number;
  activeLiabilityBytes: number;
  availableBytes: number;
  /** Physically allocated generation reserve available only to emergency writes. */
  reserveAvailableBytes?: number;
  chargeTurn?: boolean;
}): Liability {
  for (const [value, label] of [
    [input.currentPhysicalBytes, "current physical bytes"],
    [input.globalChargedBytes, "global charged bytes"],
    [input.turnChargedBytes, "turn charged bytes"],
    [input.activeLiabilityBytes, "active liability bytes"],
    [input.availableBytes, "available bytes"],
    [input.reserveAvailableBytes ?? 0, "reserve available bytes"],
  ] as const)
    capacityInteger(value, label);
  const bytes = conservativeTransactionBound(input.shape);
  if (
    input.chargeTurn !== false &&
    input.turnChargedBytes + bytes > LEDGER_TURN_PHYSICAL_MAX
  )
    throw new LedgerCapacityError("turn physical charge would exceed 32 MiB");
  const projected =
    input.globalChargedBytes + input.activeLiabilityBytes + bytes;
  const physicalProjected =
    input.currentPhysicalBytes + input.activeLiabilityBytes + bytes;
  const ceiling =
    input.writeClass === "ordinary"
      ? LEDGER_ORDINARY_PHYSICAL_MAX
      : LEDGER_TOTAL_PHYSICAL_MAX;
  if (projected > ceiling || physicalProjected > ceiling)
    throw new LedgerCapacityError(
      `${input.writeClass} Host ledger ceiling would be exceeded`,
    );
  const reserveAvailable = input.reserveAvailableBytes ?? 0;
  if (input.writeClass === "emergency" && bytes > reserveAvailable)
    throw new LedgerCapacityError(
      "emergency liability exceeds physically allocated reserve",
    );
  if (
    bytes >
    input.availableBytes +
      (input.writeClass === "emergency" ? reserveAvailable : 0)
  )
    throw new LedgerCapacityError(
      "insufficient filesystem bytes for conservative ledger liability",
    );
  return { bytes, writeClass: input.writeClass, turnCharge: bytes };
}

export function assertCommittedBound(
  before: PhysicalSnapshot,
  after: PhysicalSnapshot,
  liability: Liability,
): number {
  const growth = Math.max(0, after.totalBytes - before.totalBytes);
  if (growth > liability.bytes)
    throw new LedgerAccountingContradictionError(
      `committed physical growth ${growth} exceeded modeled bound ${liability.bytes}`,
    );
  return growth;
}
