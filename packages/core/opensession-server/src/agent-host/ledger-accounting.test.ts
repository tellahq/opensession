import { describe, expect, test } from "bun:test";
import {
  LEDGER_ORDINARY_PHYSICAL_MAX,
  LEDGER_PROTECTED_PHYSICAL_BYTES,
  LEDGER_TOTAL_PHYSICAL_MAX,
  LedgerAccountingContradictionError,
  LedgerCapacityError,
  assertCommittedBound,
  conservativeTransactionBound,
  preflightLiability,
} from "./ledger-accounting";

describe("Host ledger physical accounting", () => {
  test("keeps the protected 64 MiB inside the 512 MiB ceiling", () => {
    expect(LEDGER_TOTAL_PHYSICAL_MAX - LEDGER_ORDINARY_PHYSICAL_MAX).toBe(
      LEDGER_PROTECTED_PHYSICAL_BYTES,
    );
  });
  test("bounds 2 KiB chunks, B-tree splits, WAL frames and checkpoint peak", () => {
    const small = conservativeTransactionBound({
      encryptedPlaintextBytes: 1,
      rowsInserted: 1,
      rowsUpdated: 0,
      rowsDeleted: 0,
      affectedIndexes: 1,
    });
    const split = conservativeTransactionBound({
      encryptedPlaintextBytes: 8192,
      rowsInserted: 2,
      rowsUpdated: 1,
      rowsDeleted: 0,
      affectedIndexes: 4,
      checkpointPossible: true,
    });
    expect(split).toBeGreaterThan(small);
    expect(split).toBeGreaterThan(8192);
  });
  test("fails closed for turn, ordinary global, free-space and model contradictions", () => {
    const shape = {
      encryptedPlaintextBytes: 1,
      rowsInserted: 1,
      rowsUpdated: 0,
      rowsDeleted: 0,
      affectedIndexes: 1,
    };
    const bound = conservativeTransactionBound(shape);
    expect(() =>
      preflightLiability({
        shape,
        writeClass: "ordinary",
        currentPhysicalBytes: 0,
        globalChargedBytes: 0,
        turnChargedBytes: 32 * 1024 * 1024 - bound + 1,
        activeLiabilityBytes: 0,
        availableBytes: 1e9,
      }),
    ).toThrow(LedgerCapacityError);
    expect(() =>
      preflightLiability({
        shape,
        writeClass: "ordinary",
        currentPhysicalBytes: LEDGER_ORDINARY_PHYSICAL_MAX - bound + 1,
        globalChargedBytes: 0,
        turnChargedBytes: 0,
        activeLiabilityBytes: 0,
        availableBytes: 1e9,
      }),
    ).toThrow(LedgerCapacityError);
    expect(() =>
      preflightLiability({
        shape,
        writeClass: "emergency",
        currentPhysicalBytes: 0,
        globalChargedBytes: 0,
        turnChargedBytes: 0,
        activeLiabilityBytes: 0,
        availableBytes: 0,
        reserveAvailableBytes: bound - 1,
      }),
    ).toThrow(LedgerCapacityError);
    const snapshot = {
      mainBytes: 0,
      walBytes: 0,
      shmBytes: 0,
      totalBytes: 0,
      availableBytes: 1e9,
    };
    expect(() =>
      assertCommittedBound(
        snapshot,
        { ...snapshot, totalBytes: bound + 1 },
        { bytes: bound, writeClass: "ordinary", turnCharge: bound },
      ),
    ).toThrow(LedgerAccountingContradictionError);
  });
  test("accepts exact turn/global/free-space boundaries and rejects one byte beyond", () => {
    const shape = {
      encryptedPlaintextBytes: 1,
      rowsInserted: 1,
      rowsUpdated: 0,
      rowsDeleted: 0,
      affectedIndexes: 1,
    };
    const bound = conservativeTransactionBound(shape);
    const base = {
      shape,
      writeClass: "ordinary" as const,
      currentPhysicalBytes: 0,
      globalChargedBytes: LEDGER_ORDINARY_PHYSICAL_MAX - bound,
      turnChargedBytes: 32 * 1024 * 1024 - bound,
      activeLiabilityBytes: 0,
      availableBytes: bound,
    };
    expect(preflightLiability(base).bytes).toBe(bound);
    expect(() =>
      preflightLiability({
        ...base,
        turnChargedBytes: base.turnChargedBytes + 1,
      }),
    ).toThrow(LedgerCapacityError);
    expect(() =>
      preflightLiability({
        ...base,
        globalChargedBytes: base.globalChargedBytes + 1,
      }),
    ).toThrow(LedgerCapacityError);
    expect(() =>
      preflightLiability({ ...base, availableBytes: bound - 1 }),
    ).toThrow(LedgerCapacityError);
    expect(() =>
      preflightLiability({
        ...base,
        availableBytes: 0,
        reserveAvailableBytes: bound,
      }),
    ).toThrow(LedgerCapacityError);
    const emergency = {
      ...base,
      writeClass: "emergency" as const,
      globalChargedBytes: LEDGER_TOTAL_PHYSICAL_MAX - bound,
      turnChargedBytes: 0,
      availableBytes: 0,
      reserveAvailableBytes: bound,
    };
    expect(preflightLiability(emergency).bytes).toBe(bound);
    expect(() =>
      preflightLiability({
        ...emergency,
        globalChargedBytes: emergency.globalChargedBytes + 1,
      }),
    ).toThrow(LedgerCapacityError);
  });
  test("serializes concurrent liabilities at the ordinary boundary", () => {
    const shape = {
      encryptedPlaintextBytes: 1,
      rowsInserted: 1,
      rowsUpdated: 0,
      rowsDeleted: 0,
      affectedIndexes: 1,
    };
    const bound = conservativeTransactionBound(shape);
    const admitted = preflightLiability({
      shape,
      writeClass: "ordinary",
      currentPhysicalBytes: 0,
      globalChargedBytes: LEDGER_ORDINARY_PHYSICAL_MAX - 2 * bound,
      turnChargedBytes: 0,
      activeLiabilityBytes: bound,
      availableBytes: bound,
    });
    expect(admitted.bytes).toBe(bound);
    expect(() =>
      preflightLiability({
        shape,
        writeClass: "ordinary",
        currentPhysicalBytes: 0,
        globalChargedBytes: LEDGER_ORDINARY_PHYSICAL_MAX - 2 * bound + 1,
        turnChargedBytes: 0,
        activeLiabilityBytes: bound,
        availableBytes: bound,
      }),
    ).toThrow(LedgerCapacityError);
  });
  test("charges checkpoint peak as a second database-page copy", () => {
    const shape = {
      encryptedPlaintextBytes: 4096,
      rowsInserted: 2,
      rowsUpdated: 1,
      rowsDeleted: 1,
      affectedIndexes: 3,
    };
    const walOnly = conservativeTransactionBound(shape);
    const checkpoint = conservativeTransactionBound({
      ...shape,
      checkpointPossible: true,
    });
    expect(checkpoint - walOnly).toBeGreaterThan(0);
    expect((checkpoint - walOnly) % 4096).toBe(0);
  });
});
