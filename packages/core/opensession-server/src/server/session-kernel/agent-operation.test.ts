import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentHostSupervisionSigner } from "./agent-host-supervision-signer";
import {
  decodeAgentOperationRequest,
  type AgentOperationIdentity,
  type AgentOperationRequest,
  type AgentOperationTerminal,
} from "./agent-operation-protocol";
import { SessionKernelStore } from "./store";

const hash = (char: string) =>
  `sha256:${char.repeat(64)}` as `sha256:${string}`;
function fixture(path = ":memory:") {
  const now = Date.now();
  const pair = generateKeyPairSync("ed25519");
  const signer = createAgentHostSupervisionSigner({
    keyId: "agent-host-key-0001",
    privateKeyPkcs8: Uint8Array.from(
      pair.privateKey.export({ type: "pkcs8", format: "der" }),
    ),
    publicKeySpki: Uint8Array.from(
      pair.publicKey.export({ type: "spki", format: "der" }),
    ),
    signingNotBeforeMs: now - 1_000,
    signingNotAfterMs: now + 1_000_000,
    verifyUntilMs: now + 2_000_000,
    status: "active",
  });
  const store = new SessionKernelStore(path, {
    agentHostSupervisionIssuer: {
      kernelServiceEpoch: "kernel-epoch-0001",
      keyId: signer.keyId,
      leaseMs: 60_000,
      now: () => now,
      nonce: () => "nonce-0000000000000001",
      sign: signer.sign,
    },
  });
  store.applyRunEvent({
    sessionId: "session-1",
    event: "prompt",
    runKey: "run-1",
  });
  store.registerAgentHostPlan({
    op: "register_plan",
    registrationId: "registration-1",
    sessionId: "session-1",
    runId: "run-1",
    turnId: "turn-1",
    generation: 1,
    planHash: hash("a"),
  });
  const authority = store.claimAgentHostSupervision({
    op: "claim",
    claimId: "claim-00000001",
    sessionId: "session-1",
    runId: "run-1",
    turnId: "turn-1",
    generation: 1,
    planHash: hash("a"),
    hostId: "host-0001",
    hostGeneration: 1,
    hostIncarnation: "incarnation-0001",
    hostChallenge: "challenge-00000001",
  });
  if (!authority.accepted) throw new Error(authority.reason);
  const identity: AgentOperationIdentity = {
    sessionId: "session-1",
    runId: "run-1",
    turnId: "turn-1",
    generation: 1,
    operationId: "operation-1",
    kind: "model",
    descriptorDigest: hash("b"),
    payloadDigest: hash("c"),
    adapterId: "adapter-1",
    adapterVersion: "1.0",
    authorityHash: authority.receipt.authorityHash as `sha256:${string}`,
    supervisorEpoch: authority.receipt.authority.supervisorEpoch,
    planHash: hash("a"),
    hostId: "host-0001",
    hostGeneration: 1,
    hostIncarnation: "incarnation-0001",
    transcriptAnchor: {
      throughChangeSeq: 10,
      digest: hash("d"),
      entryIds: ["input-1"],
    },
  };
  return { store, identity };
}
function terminal(
  identity: AgentOperationIdentity,
  op: "settle" | "indeterminate" = "settle",
  pendingToolUseEntryIds: readonly string[] = [],
): AgentOperationTerminal {
  const entryIds = [`${identity.operationId}-output`];
  if (identity.kind === "model") entryIds.push(...pendingToolUseEntryIds);
  return {
    op,
    identity,
    gatewayReceiptDigest: hash("e"),
    outputDigest: hash("f"),
    outcomeCode: op === "settle" ? "ok" : "ambiguous_completion",
    transcriptReceipts: [
      {
        appendId: `append-${identity.operationId}`,
        entryIds,
        firstSeq: identity.transcriptAnchor.throughChangeSeq + 1,
        lastSeq: identity.transcriptAnchor.throughChangeSeq + entryIds.length,
        throughChangeSeq: identity.transcriptAnchor.throughChangeSeq + 1,
        requestDigest: hash("1"),
      },
    ],
    ...(identity.kind === "model" ? { pendingToolUseEntryIds } : {}),
  };
}

describe("schema 28 actor-owned Agent operations", () => {
  test("strictly rejects unknown, secret, body, crossover, nonfinite and deep inputs", () => {
    const { identity } = fixture();
    const valid = { op: "admit", identity } as const;
    expect(decodeAgentOperationRequest(valid)).toBeDefined();
    for (const bad of [
      { ...valid, unknown: true },
      { ...valid, body: "secret" },
      { ...valid, identity: { ...identity, kind: "provider" } },
      { ...valid, identity: { ...identity, generation: NaN } },
      { ...valid, identity: { ...identity, prompt: "x" } },
    ])
      expect(decodeAgentOperationRequest(bad)).toBeUndefined();
    let nested: unknown = "x";
    for (let i = 0; i < 20; i++) nested = { x: nested };
    expect(
      decodeAgentOperationRequest({
        ...valid,
        identity: {
          ...identity,
          transcriptAnchor: { ...identity.transcriptAnchor, digest: nested },
        },
      }),
    ).toBeUndefined();
    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, "op", {
      enumerable: true,
      get: () => "admit",
    });
    expect(decodeAgentOperationRequest(accessor)).toBeUndefined();
    expect(
      decodeAgentOperationRequest(
        new Proxy(valid, { ownKeys: () => ["op", "identity", "secret"] }),
      ),
    ).toBeUndefined();
    const contradictory = terminal(identity);
    expect(
      decodeAgentOperationRequest({
        ...contradictory,
        transcriptReceipts: contradictory.transcriptReceipts.map((ref) => ({
          ...ref,
          lastSeq: ref.lastSeq + 1,
        })),
      }),
    ).toBeUndefined();
  });
  test("admits a declared two-tool batch in exact order and requires cumulative result anchors", () => {
    const { store, identity } = fixture();
    const first = store.decideAgentOperation({ op: "admit", identity });
    expect(first.accepted && first.replayed).toBe(false);
    expect(store.decideAgentOperation({ op: "admit", identity })).toEqual(
      first.accepted ? { ...first, replayed: true } : first,
    );
    const activeMcp = {
      ...identity,
      operationId: "operation-active",
      kind: "mcp" as const,
      toolUseEntryId: "tool-a",
    };
    expect(
      store.decideAgentOperation({ op: "admit", identity: activeMcp }),
    ).toEqual({
      accepted: false,
      reason: "operation_barrier",
    });
    const reversed = terminal(identity, "settle", ["tool-a", "tool-b"]);
    expect(
      store.decideAgentOperation({
        ...reversed,
        pendingToolUseEntryIds: ["tool-b", "tool-a"],
      }),
    ).toEqual({ accepted: false, reason: "invalid_request" });
    expect(
      store.decideAgentOperation(
        terminal(identity, "settle", ["tool-a", "tool-b"]),
      ).accepted,
    ).toBe(true);

    const modelEntries = ["operation-1-output", "tool-a", "tool-b"];
    const mcpBase = {
      ...identity,
      kind: "mcp" as const,
      transcriptAnchor: {
        throughChangeSeq: 11,
        digest: hash("2"),
        entryIds: modelEntries,
      },
    };
    expect(
      store.decideAgentOperation({
        op: "admit",
        identity: {
          ...mcpBase,
          operationId: "operation-skipped",
          toolUseEntryId: "tool-b",
        },
      }),
    ).toEqual({ accepted: false, reason: "operation_order" });
    const mcpA = {
      ...mcpBase,
      operationId: "operation-2",
      toolUseEntryId: "tool-a",
    };
    expect(
      store.decideAgentOperation({ op: "admit", identity: mcpA }).accepted,
    ).toBe(true);
    expect(store.decideAgentOperation(terminal(mcpA)).accepted).toBe(true);
    expect(
      store.decideAgentOperation({
        op: "admit",
        identity: {
          ...mcpBase,
          operationId: "operation-duplicate",
          toolUseEntryId: "tool-a",
          transcriptAnchor: {
            throughChangeSeq: 12,
            digest: hash("2"),
            entryIds: [...modelEntries, "operation-2-output"],
          },
        },
      }),
    ).toEqual({ accepted: false, reason: "operation_order" });

    const mcpB = {
      ...mcpBase,
      operationId: "operation-3",
      toolUseEntryId: "tool-b",
      transcriptAnchor: {
        throughChangeSeq: 12,
        digest: hash("3"),
        entryIds: [...modelEntries, "operation-2-output"],
      },
    };
    expect(
      store.decideAgentOperation({ op: "admit", identity: mcpB }).accepted,
    ).toBe(true);
    expect(store.decideAgentOperation(terminal(mcpB)).accepted).toBe(true);

    const nextModel = {
      ...identity,
      operationId: "operation-4",
      payloadDigest: hash("4"),
      transcriptAnchor: {
        throughChangeSeq: 13,
        digest: hash("4"),
        entryIds: [...modelEntries, "operation-3-output"],
      },
    };
    expect(
      store.decideAgentOperation({ op: "admit", identity: nextModel }),
    ).toEqual({
      accepted: false,
      reason: "transcript_barrier",
    });
    nextModel.transcriptAnchor.entryIds.push("operation-2-output");
    expect(
      store.decideAgentOperation({ op: "admit", identity: nextModel }).accepted,
    ).toBe(true);
    store.close();
  });
  test("indeterminate is terminal, exactly replayable and blocks continuation", () => {
    const { store, identity } = fixture();
    store.decideAgentOperation({ op: "admit", identity });
    const request = terminal(identity, "indeterminate");
    const first = store.decideAgentOperation(request);
    expect(first.accepted).toBe(true);
    expect(store.decideAgentOperation(request)).toEqual(
      first.accepted ? { ...first, replayed: true } : first,
    );
    expect(
      store.decideAgentOperation({
        op: "admit",
        identity: {
          ...identity,
          operationId: "operation-2",
          kind: "mcp",
          toolUseEntryId: "tool-a",
        },
      }),
    ).toEqual({ accepted: false, reason: "indeterminate_turn" });
    expect(store.decideAgentOperation(terminal(identity))).toEqual({
      accepted: false,
      reason: "operation_barrier",
    });
    expect(store.quarantinedSession("session-1")?.reason).toContain(
      "terminal receipt crossover",
    );
  });
  test("continues a declared tool batch exactly across actor-store restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-op-batch-"));
    const path = join(dir, "kernel.sqlite");
    const setup = fixture(path);
    setup.store.decideAgentOperation({ op: "admit", identity: setup.identity });
    setup.store.decideAgentOperation(
      terminal(setup.identity, "settle", ["tool-a", "tool-b"]),
    );
    setup.store.close();

    const reopened = new SessionKernelStore(path);
    const mcp = {
      ...setup.identity,
      operationId: "operation-2",
      kind: "mcp" as const,
      toolUseEntryId: "tool-a",
      transcriptAnchor: {
        throughChangeSeq: 11,
        digest: hash("2"),
        entryIds: ["operation-1-output", "tool-a", "tool-b"],
      },
    };
    expect(
      reopened.decideAgentOperation({ op: "admit", identity: mcp }).accepted,
    ).toBe(true);
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("fails closed and quarantines runtime receipt tampering", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-op-tamper-"));
    const path = join(dir, "kernel.sqlite");
    const setup = fixture(path);
    setup.store.decideAgentOperation({ op: "admit", identity: setup.identity });
    const db = new Database(path);
    db.run(
      "UPDATE session_kernel_agent_operations SET receipt='{}' WHERE session_id='session-1'",
    );
    db.close();
    expect(
      setup.store.decideAgentOperation({
        op: "query",
        identity: setup.identity,
      }),
    ).toEqual({ accepted: false, reason: "operation_barrier" });
    expect(setup.store.quarantinedSession("session-1")?.reason).toContain(
      "Corrupt or contradictory",
    );
    const unrelatedIdentity = {
      ...setup.identity,
      operationId: "operation-unrelated",
    };
    expect(
      setup.store.decideAgentOperation({
        op: "query",
        identity: unrelatedIdentity,
      }),
    ).toEqual({ accepted: false, reason: "operation_barrier" });
    expect(setup.store.releaseQuarantine("session-1")).toBe(false);
    setup.store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("admission rejects contradictory active signed authority bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-op-authority-tamper-"));
    const path = join(dir, "kernel.sqlite");
    const setup = fixture(path);
    const db = new Database(path);
    db.run(
      "UPDATE session_kernel_agent_host_supervision SET authority_bytes='dGFtcGVy' WHERE session_id='session-1'",
    );
    db.close();
    expect(() =>
      setup.store.decideAgentOperation({
        op: "admit",
        identity: setup.identity,
      }),
    ).toThrow("Contradictory durable Agent Host authority");
    setup.store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("strict startup scan rejects denormalized receipt contradictions", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-op-startup-tamper-"));
    const path = join(dir, "kernel.sqlite");
    const setup = fixture(path);
    setup.store.decideAgentOperation({ op: "admit", identity: setup.identity });
    setup.store.close();
    const db = new Database(path);
    db.run(
      "UPDATE session_kernel_agent_operations SET admitted_at=admitted_at+1 WHERE session_id='session-1'",
    );
    db.close();
    expect(() => new SessionKernelStore(path)).toThrow(
      "contradicts its receipt identity",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("strict schema validation rejects a missing required index", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-op-schema-tamper-"));
    const path = join(dir, "kernel.sqlite");
    const setup = fixture(path);
    setup.store.close();
    const db = new Database(path);
    db.exec("DROP INDEX idx_skao_prune");
    db.close();
    expect(() => new SessionKernelStore(path)).toThrow(
      "schema indexes do not match exact schema 28",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("strict startup scan rejects a missing operation high-water row", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-op-high-water-tamper-"));
    const path = join(dir, "kernel.sqlite");
    const setup = fixture(path);
    setup.store.decideAgentOperation({ op: "admit", identity: setup.identity });
    setup.store.close();
    const db = new Database(path);
    db.run(
      "DELETE FROM session_kernel_agent_operation_high_water WHERE session_id='session-1'",
    );
    db.close();
    expect(() => new SessionKernelStore(path)).toThrow(
      "high-water contradicts receipts",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("strict startup scan rejects unsafe orphan high-water values", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-op-high-water-overflow-"));
    const path = join(dir, "kernel.sqlite");
    const setup = fixture(path);
    setup.store.close();
    const db = new Database(path);
    db.run(
      `INSERT INTO session_kernel_agent_operation_high_water
       (session_id,operation_sequence,updated_at)
       VALUES ('orphan-session',9007199254740992,0)`,
    );
    db.close();
    expect(() => new SessionKernelStore(path)).toThrow(
      "Invalid Agent operation high-water",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("persists sequence across restart and removes operation state with deletion", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-op-"));
    const path = join(dir, "kernel.sqlite");
    let setup = fixture(path);
    expect(
      setup.store.decideAgentOperation({
        op: "admit",
        identity: setup.identity,
      }).accepted,
    ).toBe(true);
    setup.store.close();
    const reopened = new SessionKernelStore(path);
    expect(
      reopened.decideAgentOperation({ op: "query", identity: setup.identity })
        .accepted,
    ).toBe(true);
    reopened.tombstoneSession("session-1");
    expect(() =>
      reopened.decideAgentOperation({ op: "query", identity: setup.identity }),
    ).toThrow();
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("strictly decodes cancellation requests and rejects accessors and extra keys", () => {
    const { store, identity } = fixture();
    const valid = {
      op: "cancel",
      identity,
      cancelId: "cancel-1",
      reason: "user",
    } as const;
    expect(decodeAgentOperationRequest(valid)).toEqual(valid);
    expect(
      decodeAgentOperationRequest({ ...valid, extra: true }),
    ).toBeUndefined();
    expect(
      decodeAgentOperationRequest({ ...valid, reason: "timeout" }),
    ).toBeUndefined();
    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, "cancelId", {
      enumerable: true,
      get: () => "cancel-1",
    });
    expect(decodeAgentOperationRequest(accessor)).toBeUndefined();
    store.close();
  });

  test("persists exact requested intent before terminal settlement and fails conflicts closed", () => {
    const { store, identity } = fixture();
    expect(store.decideAgentOperation({ op: "admit", identity }).accepted).toBe(
      true,
    );
    const before = Date.now();
    const request = {
      op: "cancel",
      identity,
      cancelId: "cancel-1",
      reason: "user",
    } as const;
    const first = store.decideAgentOperation(request);
    expect(first).toMatchObject({
      accepted: true,
      replayed: false,
      intent: {
        cancelId: "cancel-1",
        reason: "user",
        disposition: "requested",
      },
    });
    if (first.accepted)
      expect(first.intent.requestedAtMs).toBeGreaterThanOrEqual(before);
    expect(store.decideAgentOperation(request)).toEqual(
      first.accepted ? { ...first, replayed: true } : first,
    );
    expect(store.agentOperationCancellationIntent(identity)).toEqual(
      first.accepted ? first.intent : undefined,
    );
    expect(store.decideAgentOperation(terminal(identity)).accepted).toBe(true);
    const terminalReceipt = store.decideAgentOperation({
      op: "query",
      identity,
    });
    expect(terminalReceipt.accepted && terminalReceipt.receipt.state).toBe(
      "settled",
    );
    expect(
      store.decideAgentOperation({
        ...request,
        cancelId: "cancel-2",
      }),
    ).toEqual({ accepted: false, reason: "operation_barrier" });
    expect(store.quarantinedSession(identity.sessionId)?.reason).toContain(
      "crossover",
    );
    store.close();
  });

  test("durably records too_late without changing an existing terminal receipt", () => {
    const { store, identity } = fixture();
    store.decideAgentOperation({ op: "admit", identity });
    const settled = store.decideAgentOperation(terminal(identity));
    const cancelled = store.decideAgentOperation({
      op: "cancel",
      identity,
      cancelId: "cancel-late",
      reason: "turn_deadline",
    });
    expect(cancelled).toMatchObject({
      accepted: true,
      replayed: false,
      intent: { disposition: "too_late" },
    });
    expect(store.decideAgentOperation({ op: "query", identity })).toEqual(
      settled.accepted ? { ...settled, replayed: true } : settled,
    );
    store.close();
  });

  test("migrates schema 31 and recovers exact cancellation intent after restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-op-cancel-restart-"));
    const path = join(dir, "kernel.sqlite");
    const setup = fixture(path);
    setup.store.decideAgentOperation({ op: "admit", identity: setup.identity });
    const cancellation = setup.store.decideAgentOperation({
      op: "cancel",
      identity: setup.identity,
      cancelId: "cancel-restart",
      reason: "shutdown",
    });
    setup.store.close();
    const reopened = new SessionKernelStore(path);
    expect(reopened.agentOperationCancellationIntent(setup.identity)).toEqual(
      cancellation.accepted ? cancellation.intent : undefined,
    );
    reopened.close();

    const legacy = new Database(path);
    legacy.exec(
      `DROP TABLE session_kernel_agent_operation_cancellations; PRAGMA user_version = 31`,
    );
    legacy.close();
    const migrated = new SessionKernelStore(path);
    expect(migrated.stats().schemaVersion).toBe(32);
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("quarantines tampered cancellation evidence and isolates unrelated operations", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-op-cancel-tamper-"));
    const path = join(dir, "kernel.sqlite");
    const setup = fixture(path);
    setup.store.decideAgentOperation({ op: "admit", identity: setup.identity });
    setup.store.decideAgentOperation({
      op: "cancel",
      identity: setup.identity,
      cancelId: "cancel-tamper",
      reason: "reconnect_deadline",
    });
    const unrelated = { ...setup.identity, operationId: "operation-unrelated" };
    const unrelatedSession = { ...setup.identity, sessionId: "session-unrelated" };
    expect(
      setup.store.agentOperationCancellationIntent(unrelated),
    ).toBeUndefined();
    expect(
      setup.store.agentOperationCancellationIntent(unrelatedSession),
    ).toBeUndefined();
    expect(setup.store.quarantinedSession("session-unrelated")).toBeUndefined();
    const tamper = new Database(path);
    tamper.run(
      `UPDATE session_kernel_agent_operation_cancellations SET reason='user'
       WHERE session_id=? AND operation_id=?`,
      [setup.identity.sessionId, setup.identity.operationId],
    );
    tamper.close();
    expect(
      setup.store.agentOperationCancellationIntent(setup.identity),
    ).toBeUndefined();
    expect(
      setup.store.quarantinedSession(setup.identity.sessionId)?.reason,
    ).toContain("cancellation");
    setup.store.clearSession(setup.identity.sessionId);
    const inspect = new Database(path, { readonly: true });
    expect(
      (
        inspect
          .query(
            "SELECT COUNT(*) AS count FROM session_kernel_agent_operation_cancellations",
          )
          .get() as { count: number }
      ).count,
    ).toBe(0);
    inspect.close();
    setup.store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
