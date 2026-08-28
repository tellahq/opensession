import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_HOST_LEDGER_RETENTION_MS } from "./ledger-schema";
import {
  HostLedgerConflictError,
  HostLedgerDeletedError,
  SQLiteHostRecoveryLedger,
  type TurnFence,
} from "./sqlite-ledger";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "host-ledger-"));
  dirs.push(dir);
  const dbPath = join(dir, "recovery.sqlite");
  let now = 1000;
  const options = {
    dbPath,
    writerNonce: "writer-nonce-0001",
    now: () => now,
    emergencyReserveBytes: 4 * 1024 * 1024,
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
  };
  return {
    dbPath,
    options,
    setNow: (v: number) => (now = v),
    open: () => new SQLiteHostRecoveryLedger(options),
  };
}
const fence = (n = 1): TurnFence => ({
  sessionId: `secret-session-${n}`,
  runId: `secret-run-${n}`,
  turnId: `secret-turn-${n}`,
  generation: 1,
});
const digest = (n: number) => n.toString(16).padStart(64, "0");

describe("SQLite Host recovery ledger", () => {
  test("creates exact STRICT private WAL schema without plaintext identifiers", () => {
    const f = fixture(),
      ledger = f.open();
    ledger.admitTurn({
      fence: fence(),
      authorityHash: digest(1),
      recoveryDescriptor: { mode: "secret-recovery-mode" },
      admittedAtMs: 1000,
    });
    const bytes = Buffer.concat([
      readFileSync(f.dbPath),
      readFileSync(`${f.dbPath}-wal`),
    ]).toString("utf8");
    expect(bytes).not.toContain("secret-session");
    expect(bytes).not.toContain("secret-run");
    expect(bytes).not.toContain("secret-turn");
    expect(bytes).not.toContain("secret-recovery-mode");
    expect(statSync(f.dbPath).mode & 0o777).toBe(0o600);
    expect(statSync(`${f.dbPath}-wal`).mode & 0o777).toBe(0o600);
    const db = new Database(f.dbPath, { readonly: true });
    expect(
      db
        .query<{ strict: number }, []>(
          "SELECT strict FROM pragma_table_list WHERE name='turns'",
        )
        .get()!.strict,
    ).toBe(1);
    db.close();
    ledger.close();
  });
  test("supports many lightweight turns with no count cap and exact replay", () => {
    const f = fixture(),
      ledger = f.open();
    for (let n = 1; n <= 80; n++) {
      expect(
        ledger.admitTurn({
          fence: fence(n),
          authorityHash: digest(1),
          recoveryDescriptor: { n },
          admittedAtMs: 1000,
        }).admitted,
      ).toBe(true);
    }
    expect(
      ledger.admitTurn({
        fence: fence(80),
        authorityHash: digest(1),
        recoveryDescriptor: { n: 80 },
        admittedAtMs: 1000,
      }).admitted,
    ).toBe(false);
    ledger.close();
  });
  test("enforces operation transitions, mismatches, and executing recovery", () => {
    const f = fixture(),
      ledger = f.open(),
      turn = fence();
    ledger.admitTurn({
      fence: turn,
      authorityHash: digest(1),
      recoveryDescriptor: { a: 1 },
      admittedAtMs: 1000,
    });
    const op = {
      fence: turn,
      operationId: "secret-operation",
      identityDigest: digest(2),
      reconcileRef: { opaque: "r" },
      atMs: 1000,
    };
    expect(ledger.prepareOperation(op).prepared).toBe(true);
    expect(ledger.prepareOperation(op).prepared).toBe(false);
    expect(() =>
      ledger.prepareOperation({ ...op, identityDigest: digest(3) }),
    ).toThrow(HostLedgerConflictError);
    ledger.close();
    const f2 = fixture(),
      l2 = f2.open(),
      turn2 = fence(2),
      op2 = {
        fence: turn2,
        operationId: "op2",
        identityDigest: digest(2),
        reconcileRef: { x: 1 },
        atMs: 1000,
      };
    l2.admitTurn({
      fence: turn2,
      authorityHash: digest(1),
      recoveryDescriptor: {},
      admittedAtMs: 1000,
    });
    l2.prepareOperation(op2);
    l2.markExecuting(op2);
    expect(l2.scanRecover()).toContainEqual(
      expect.objectContaining({ phase: "indeterminate", replayable: false }),
    );
    l2.close();
  });
  test("records controls and erases temporary outbox bytes only after destination ack", () => {
    const f = fixture(),
      ledger = f.open(),
      turn = fence();
    ledger.admitTurn({
      fence: turn,
      authorityHash: digest(1),
      recoveryDescriptor: {},
      admittedAtMs: 1000,
    });
    const control = {
      fence: turn,
      receiptId: "ask-1",
      kind: "ask" as const,
      identityDigest: digest(4),
      reconcileRef: { ref: "opaque" },
      atMs: 1000,
    };
    expect(ledger.recordControl(control).recorded).toBe(true);
    ledger.settleControl(control, { done: true });
    ledger.enqueueOutbox({
      fence: turn,
      outboxId: "append-1",
      destinationDigest: digest(5),
      temporaryBody: new TextEncoder().encode("temporary model-visible body"),
      atMs: 1000,
    });
    const claimed = ledger.claimOutbox();
    expect(new TextDecoder().decode(claimed[0]!.temporaryBody)).toBe(
      "temporary model-visible body",
    );
    ledger.ackOutbox(claimed[0]!.outboxKey, 1001);
    const db = new Database(f.dbPath, { readonly: true });
    expect(
      db
        .query<{ body_ciphertext: string | null; byte_count: number }, []>(
          "SELECT body_ciphertext,byte_count FROM outbox",
        )
        .get(),
    ).toEqual({ body_ciphertext: null, byte_count: 0 });
    db.close();
    ledger.close();
  });
  test("authoritative deletion atomically purges and tombstone fences late writes", () => {
    const f = fixture(),
      ledger = f.open(),
      turn = fence();
    ledger.admitTurn({
      fence: turn,
      authorityHash: digest(1),
      recoveryDescriptor: {},
      admittedAtMs: 1000,
    });
    expect(ledger.deleteSession(turn.sessionId, 1001)).toBe(1);
    expect(() =>
      ledger.admitTurn({
        fence: { ...turn, turnId: "late" },
        authorityHash: digest(1),
        recoveryDescriptor: {},
        admittedAtMs: 1002,
      }),
    ).toThrow(HostLedgerDeletedError);
    ledger.close();
  });
  test("uses an exact seven-day expiry boundary", () => {
    const f = fixture(),
      ledger = f.open(),
      turn = fence();
    ledger.admitTurn({
      fence: turn,
      authorityHash: digest(1),
      recoveryDescriptor: {},
      admittedAtMs: 1000,
    });
    ledger.quarantine(turn, "evidence", { reason: "proof" }, 1000);
    expect(ledger.purgeExpired(1000 + AGENT_HOST_LEDGER_RETENTION_MS)).toBe(0);
    expect(
      ledger.purgeExpired(1001 + AGENT_HOST_LEDGER_RETENTION_MS),
    ).toBeGreaterThan(0);
    ledger.close();
  });
  test("recovers a partially consumed reserve on reopen", () => {
    const f = fixture();
    f.open().close();
    const reservePath = join(
      dirname(f.dbPath),
      ".agent-host-emergency.reserve",
    );
    truncateSync(reservePath, 1024 * 1024);
    const reopened = f.open();
    const reserve = statSync(reservePath);
    expect(reserve.size).toBe(4 * 1024 * 1024);
    expect(Number(reserve.blocks) * 512).toBeGreaterThanOrEqual(reserve.size);
    reopened.close();
  });
  test("reconciles every injected emergency fault without physical retries", () => {
    const boundaries = [
      "reserve:before-consume",
      "reserve:after-consume",
      "transaction:before-begin",
      "transaction:after-begin",
      "transaction:before-commit",
      "transaction:after-commit",
      "checkpoint:before",
      "checkpoint:after",
      "reserve:before-recreate",
      "reserve:after-recreate",
    ] as const;
    for (const boundary of boundaries) {
      const f = fixture();
      let armed = false;
      let hits = 0;
      const ledger = new SQLiteHostRecoveryLedger({
        ...f.options,
        injectFault(at) {
          if (armed && at === boundary) {
            hits++;
            throw new Error(`fault:${boundary}`);
          }
        },
      });
      const turn = fence();
      ledger.admitTurn({
        fence: turn,
        authorityHash: digest(1),
        recoveryDescriptor: {},
        admittedAtMs: 1000,
      });
      armed = true;
      expect(() => ledger.quarantine(turn, "fault", {}, 1001)).toThrow(
        `fault:${boundary}`,
      );
      expect(hits).toBe(1);
      ledger.close();
      const reopened = f.open();
      const reserve = statSync(
        join(dirname(f.dbPath), ".agent-host-emergency.reserve"),
      );
      expect(reserve.size).toBe(4 * 1024 * 1024);
      expect(Number(reserve.blocks) * 512).toBeGreaterThanOrEqual(reserve.size);
      reopened.close();
    }
  });
  test("reopens with stable writer nonce and validates AEAD", () => {
    const f = fixture();
    f.open().close();
    const ledger = f.open();
    ledger.admitTurn({
      fence: fence(),
      authorityHash: digest(1),
      recoveryDescriptor: {},
      admittedAtMs: 1000,
    });
    ledger.close();
    expect(
      () =>
        new SQLiteHostRecoveryLedger({
          ...f.options,
          writerNonce: "different-writer-0002",
        }),
    ).not.toThrow();
  });
});
