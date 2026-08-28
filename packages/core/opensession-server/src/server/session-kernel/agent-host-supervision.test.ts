import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentHostSupervisionSigner } from "./agent-host-supervision-signer";
import {
  SESSION_KERNEL_SCHEMA_VERSION,
  SessionKernelStore,
} from "./store";
import {
  decodeAgentHostSupervisionClaim,
  type AgentHostPlanRegistration,
  type AgentHostSupervisionClaim,
} from "./agent-host-supervision-protocol";

const planHash = `sha256:${"a".repeat(64)}`;
const plan: AgentHostPlanRegistration = {
  op: "register_plan",
  registrationId: "registration-0001",
  sessionId: "session-1",
  runId: "run-1",
  turnId: "turn-1",
  generation: 1,
  planHash,
};
const claim = (
  overrides: Partial<AgentHostSupervisionClaim> = {},
): AgentHostSupervisionClaim => ({
  op: "claim",
  claimId: "claim-00000001",
  sessionId: "session-1",
  runId: "run-1",
  turnId: "turn-1",
  generation: 1,
  planHash,
  hostId: "host-0001",
  hostGeneration: 1,
  hostIncarnation: "incarnation-0001",
  hostChallenge: "challenge-00000001",
  ...overrides,
});
function issuer(overrides: Record<string, unknown> = {}) {
  const pair = generateKeyPairSync("ed25519");
  const signer = createAgentHostSupervisionSigner({
    keyId: "agent-host-key-0001",
    privateKeyPkcs8: Uint8Array.from(
      pair.privateKey.export({ type: "pkcs8", format: "der" }),
    ),
    publicKeySpki: Uint8Array.from(
      pair.publicKey.export({ type: "spki", format: "der" }),
    ),
    signingNotBeforeMs: 999_000,
    signingNotAfterMs: 2_000_000,
    verifyUntilMs: 3_000_000,
    status: "active",
  });
  let nonce = 0;
  return {
    kernelServiceEpoch: "service-epoch-0001",
    keyId: signer.keyId,
    leaseMs: 60_000,
    now: () => 1_000_000,
    nonce: () => `nonce-${String(++nonce).padStart(16, "0")}`,
    sign: signer.sign,
    ...overrides,
  };
}
function running(path = ":memory:", trusted = issuer()) {
  const store = new SessionKernelStore(path, {
    agentHostSupervisionIssuer: trusted,
  });
  expect(
    store.applyRunEvent({
      sessionId: "session-1",
      event: "prompt",
      runKey: "run-1",
    }).accepted,
  ).toBe(true);
  expect(store.registerAgentHostPlan(plan).accepted).toBe(true);
  return store;
}

describe("schema 27 signed Agent Host receipts", () => {
  test("hard-cuts V3 claims and rejects every gateway issuer field", () => {
    expect(decodeAgentHostSupervisionClaim(claim())).toEqual(claim());
    for (const field of [
      "kernelServiceEpoch",
      "issuedAtMs",
      "expiresAtMs",
      "nonce",
      "keyId",
      "audience",
      "purpose",
      "signature",
      "authorityBytes",
    ])
      expect(
        decodeAgentHostSupervisionClaim({ ...claim(), [field]: "gateway" }),
      ).toBeUndefined();
  });

  test("fails closed without production issuer and signs atomically", () => {
    const unavailable = new SessionKernelStore(":memory:");
    unavailable.applyRunEvent({
      sessionId: "session-1",
      event: "prompt",
      runKey: "run-1",
    });
    unavailable.registerAgentHostPlan(plan);
    expect(unavailable.claimAgentHostSupervision(claim())).toEqual({
      accepted: false,
      reason: "issuer_unavailable",
    });
    const store = running();
    const result = store.claimAgentHostSupervision(claim());
    expect(result.accepted && result.receipt.format).toBe("signed_v1");
    expect(
      result.accepted &&
        Buffer.from(
          result.receipt.envelope.authorityBytes,
          "base64url",
        ).toString("base64"),
    ).toBe(result.accepted && result.receipt.authorityBytes);
  });

  test("sign failure rolls back row, active status, and high water", () => {
    const store = running(
      ":memory:",
      issuer({
        sign: () => {
          throw new Error("sign failed");
        },
      }),
    );
    expect(() => store.claimAgentHostSupervision(claim())).toThrow(
      "sign failed",
    );
    const db = (store as unknown as { db: Database }).db;
    expect(
      (
        db
          .query(
            "SELECT count(*) AS n FROM session_kernel_agent_host_supervision",
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);
    expect(
      (
        db
          .query(
            "SELECT supervisor_high_water AS n FROM session_kernel_agent_host_plan",
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });

  test("exact replay is byte-identical after reopen without signer or old key", () => {
    const dir = mkdtempSync(join(tmpdir(), "sk27-replay-"));
    const path = join(dir, "db.sqlite");
    let store = running(path);
    const first = store.claimAgentHostSupervision(claim());
    store.close();
    store = new SessionKernelStore(path);
    const replay = store.claimAgentHostSupervision(claim());
    expect(replay).toEqual(
      first.accepted ? { ...first, replayed: true } : first,
    );
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("challenge and kernel nonce are unique and corrupt envelopes fail closed", () => {
    const fixedNonce = issuer({ nonce: () => "nonce-fixed-00000001" });
    const store = running(":memory:", fixedNonce);
    expect(store.claimAgentHostSupervision(claim()).accepted).toBe(true);
    expect(
      store.claimAgentHostSupervision(
        claim({
          claimId: "claim-00000002",
          hostChallenge: "challenge-00000002",
        }),
      ),
    ).toEqual({ accepted: false, reason: "nonce_reused" });
    const db = (store as unknown as { db: Database }).db;
    db.run(
      "UPDATE session_kernel_agent_host_supervision SET signature='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'",
    );
    expect(() => store.claimAgentHostSupervision(claim())).toThrow(
      "Contradictory durable signed Agent Host receipt",
    );
  });

  test("migrates populated v26 receipts as legacy and rolls contradictions back", () => {
    function makeV26(path: string, corrupt = false) {
      const store = running(path);
      expect(store.claimAgentHostSupervision(claim()).accepted).toBe(true);
      store.close();
      const db = new Database(path);
      db.exec(`
        DROP TABLE session_kernel_agent_operation_cancellations;
        DROP TABLE session_kernel_agent_operations;
        DROP TABLE session_kernel_agent_operation_high_water;
        DROP INDEX idx_skahs_active;
        DROP INDEX idx_skahs_prune;
        ALTER TABLE session_kernel_agent_host_supervision RENAME TO signed_source;
        CREATE TABLE session_kernel_agent_host_supervision (
          session_id TEXT NOT NULL, supervisor_epoch INTEGER NOT NULL,
          claim_id TEXT NOT NULL, request_hash TEXT NOT NULL, run_id TEXT NOT NULL,
          run_generation INTEGER NOT NULL, host_id TEXT NOT NULL,
          host_generation INTEGER NOT NULL, host_incarnation TEXT NOT NULL,
          kernel_service_epoch TEXT NOT NULL, challenge TEXT NOT NULL, nonce TEXT NOT NULL,
          status TEXT NOT NULL, authority TEXT NOT NULL, authority_bytes TEXT NOT NULL,
          authority_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY(session_id, supervisor_epoch), UNIQUE(session_id, claim_id),
          UNIQUE(session_id, challenge), UNIQUE(session_id, nonce));
        INSERT INTO session_kernel_agent_host_supervision
        SELECT session_id,supervisor_epoch,claim_id,request_hash,run_id,run_generation,
          host_id,host_generation,host_incarnation,kernel_service_epoch,challenge,nonce,
          status,authority,authority_bytes,authority_hash,expires_at,created_at FROM signed_source;
        DROP TABLE signed_source;
        CREATE UNIQUE INDEX idx_skahs_active ON session_kernel_agent_host_supervision(session_id) WHERE status='active';
        PRAGMA user_version=26;
      `);
      if (corrupt)
        db.run(
          "UPDATE session_kernel_agent_host_supervision SET authority_bytes='broken'",
        );
      db.close();
    }
    const dir = mkdtempSync(join(tmpdir(), "sk27-migrate-"));
    const validPath = join(dir, "valid.sqlite");
    makeV26(validPath);
    const migrated = new SessionKernelStore(validPath);
    expect(migrated.claimAgentHostSupervision(claim())).toEqual({
      accepted: false,
      reason: "issuer_unavailable",
    });
    migrated.close();
    const validDb = new Database(validPath, { readonly: true });
    expect(
      (
        validDb
          .query(
            "SELECT receipt_format FROM session_kernel_agent_host_supervision",
          )
          .get() as { receipt_format: string }
      ).receipt_format,
    ).toBe("legacy_unsigned_v2");
    expect(
      (validDb.query("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    ).toBe(SESSION_KERNEL_SCHEMA_VERSION);
    validDb.close();

    const corruptPath = join(dir, "corrupt.sqlite");
    makeV26(corruptPath, true);
    expect(() => new SessionKernelStore(corruptPath)).toThrow(
      "Contradictory durable Agent Host authority",
    );
    const corruptDb = new Database(corruptPath, { readonly: true });
    expect(
      (corruptDb.query("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    ).toBe(26);
    expect(
      (
        corruptDb
          .query("PRAGMA table_info(session_kernel_agent_host_supervision)")
          .all() as Array<{ name: string }>
      ).some((column) => column.name === "receipt_format"),
    ).toBe(false);
    corruptDb.close();

    function expectV26Rollback(
      name: string,
      mutate: (db: Database) => void,
      message?: string,
    ) {
      const path = join(dir, `${name}.sqlite`);
      makeV26(path);
      const db = new Database(path);
      mutate(db);
      db.close();
      expect(() => new SessionKernelStore(path)).toThrow(message);
      const after = new Database(path, { readonly: true });
      expect(
        (after.query("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      ).toBe(26);
      expect(
        (
          after
            .query("PRAGMA table_info(session_kernel_agent_host_supervision)")
            .all() as Array<{ name: string }>
        ).some((column) => column.name === "receipt_format"),
      ).toBe(false);
      after.close();
    }
    expectV26Rollback("rebuild-index-collision", (db) =>
      db.exec(
        "CREATE INDEX idx_skahs_prune ON session_kernel_agent_host_plan(session_id)",
      ),
    );
    expectV26Rollback(
      "null-plan-host",
      (db) => db.run("UPDATE session_kernel_agent_host_plan SET host_id=NULL"),
      "Agent Host plan high-water regression",
    );
    expectV26Rollback(
      "active-plan-mismatch",
      (db) =>
        db.run("UPDATE session_kernel_agent_host_plan SET plan_hash=?", [
          `sha256:${"b".repeat(64)}`,
        ]),
      "Agent Host plan high-water regression",
    );
    rmSync(dir, { recursive: true, force: true });
  });
});
