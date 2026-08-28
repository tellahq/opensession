import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEDGER_ORDINARY_PHYSICAL_MAX,
  type LedgerPhysicalAccounting,
  type PhysicalSnapshot,
} from "./ledger-accounting";
import {
  SQLiteHostRecoveryLedger,
  type LedgerFaultBoundary,
  type SQLiteHostLedgerOptions,
  type TurnFence,
} from "./sqlite-ledger";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const fence = (n = 1): TurnFence => ({
  sessionId: `qualification-session-${n}`,
  runId: `qualification-run-${n}`,
  turnId: `qualification-turn-${n}`,
  generation: 1,
});
const digest = (n: number) => n.toString(16).padStart(64, "0");
const enospc = () =>
  Object.assign(new Error("qualified ENOSPC"), { code: "ENOSPC" });

function fixture(overrides: Partial<SQLiteHostLedgerOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "host-ledger-enospc-"));
  dirs.push(dir);
  const dbPath = join(dir, "recovery.sqlite");
  const options: SQLiteHostLedgerOptions = {
    dbPath,
    writerNonce: "qualification-writer-0001",
    now: () => 1_000,
    keyring: {
      activeKeyId: "active",
      keys: [
        {
          id: "active",
          encryptionKey: new Uint8Array(32).fill(4),
          lookupKey: new Uint8Array(32).fill(9),
          decryptNotBeforeMs: 0,
          decryptNotAfterMs: Number.MAX_SAFE_INTEGER,
        },
      ],
    },
    ...overrides,
  };
  return { dbPath, options, open: () => new SQLiteHostRecoveryLedger(options) };
}
function admit(ledger: SQLiteHostRecoveryLedger, n = 1) {
  return ledger.admitTurn({
    fence: fence(n),
    authorityHash: digest(1),
    recoveryDescriptor: { qualification: n },
    admittedAtMs: 1_000,
  });
}
function rows(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM turns")
      .get()!.count;
  } finally {
    db.close();
  }
}

describe("Agent Host ledger physical/ENOSPC qualification", () => {
  const transactionBoundaries: LedgerFaultBoundary[] = [
    "transaction:before-begin",
    "transaction:after-begin",
    "transaction:before-commit",
    "transaction:after-commit",
  ];
  for (const boundary of transactionBoundaries) {
    test(`fails closed exactly once at ${boundary}`, () => {
      let armed = false;
      let hits = 0;
      const f = fixture({
        injectFault: (seen) => {
          if (armed && seen === boundary) {
            hits++;
            throw enospc();
          }
        },
      });
      const ledger = f.open();
      armed = true;
      expect(() => admit(ledger)).toThrow("qualified ENOSPC");
      expect(hits).toBe(1);
      expect(rows(f.dbPath)).toBe(
        boundary === "transaction:after-commit" ? 1 : 0,
      );
      armed = false;
      expect(() => admit(ledger, 2)).not.toThrow();
      ledger.close();
      const reopened = f.open();
      expect(
        reopened.scanRecover().filter((record) => record.kind === "turn"),
      ).toHaveLength(boundary === "transaction:after-commit" ? 2 : 1);
      reopened.close();
    });
  }

  for (const boundary of [
    "checkpoint:before",
    "checkpoint:after",
    "reserve:before-recreate",
    "reserve:after-recreate",
  ] as const) {
    test(`does not retry committed recovery work at ${boundary}`, () => {
      let armed = false;
      let hits = 0;
      const f = fixture({
        injectFault: (seen) => {
          if (armed && seen === boundary) {
            hits++;
            throw enospc();
          }
        },
      });
      const ledger = f.open();
      admit(ledger);
      armed = true;
      expect(() => ledger.deleteSession(fence().sessionId, 1_001)).toThrow(
        "qualified ENOSPC",
      );
      expect(hits).toBe(1);
      expect(rows(f.dbPath)).toBe(0);
      armed = false;
      ledger.close();
      const reopened = f.open();
      expect(() => admit(reopened, 2)).not.toThrow();
      reopened.close();
    });
  }

  test("ordinary admission cannot consume reserve; emergency quarantine can; checkpoint restores it", () => {
    let projected = 0;
    const physical: LedgerPhysicalAccounting = {
      snapshot(path): PhysicalSnapshot {
        const mainBytes = statSync(path).size;
        return {
          mainBytes,
          walBytes: 0,
          shmBytes: 0,
          totalBytes: projected || mainBytes,
          availableBytes: 1024 ** 4,
        };
      },
    };
    const f = fixture({ physicalAccounting: physical });
    const ledger = f.open();
    admit(ledger);
    projected = LEDGER_ORDINARY_PHYSICAL_MAX;
    expect(() => admit(ledger, 2)).toThrow("ordinary Host ledger ceiling");
    expect(() =>
      ledger.quarantine(fence(), "evidence", { reason: "recover" }, 1_001),
    ).not.toThrow();
    projected = statSync(f.dbPath).size;
    expect(() => ledger.deleteSession(fence().sessionId, 1_002)).not.toThrow();
    expect(() => admit(ledger, 2)).not.toThrow();
    ledger.close();
  });

  test("a live sole writer fences another generation and crash/reopen preserves committed work", () => {
    let fault = true;
    const f = fixture({
      injectFault: (boundary) => {
        if (fault && boundary === "transaction:after-commit") throw enospc();
      },
    });
    const first = f.open();
    expect(() => admit(first)).toThrow("qualified ENOSPC");
    fault = false;
    expect(
      () =>
        new SQLiteHostRecoveryLedger({
          ...f.options,
          writerNonce: "qualification-writer-0002",
        }),
    ).toThrow("live sole writer");
    first.close();
    const nextGeneration = new SQLiteHostRecoveryLedger({
      ...f.options,
      writerNonce: "qualification-writer-0002",
    });
    expect(nextGeneration.scanRecover()).toContainEqual(
      expect.objectContaining({ kind: "turn", phase: "admitted" }),
    );
    nextGeneration.close();
  });
});
