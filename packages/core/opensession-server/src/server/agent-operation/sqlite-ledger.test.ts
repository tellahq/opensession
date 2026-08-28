import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentOperationAuthorizedQuery } from "./authorized-query";
import type {
  AgentOperationIdentity,
  AgentOperationIndeterminateReason,
  AgentOperationRecord,
  AgentOperationTerminalReservation,
} from "./ledger";
import {
  AgentOperationConflictError,
  AgentOperationLedgerFullError,
  AgentOperationSessionActiveError,
  AgentOperationTerminalReservedError,
  AgentOperationTransitionError,
  reconcileExecutingOperation,
} from "./ledger";
import { SQLiteAgentOperationLedger } from "./sqlite-ledger";

const roots: string[] = [];
const path = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-operation-"));
  roots.push(root);
  return join(root, "operations.sqlite");
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const d = (c: string) => `sha256:${c.repeat(64)}` as const;
const identity = (
  overrides: Partial<AgentOperationIdentity> = {},
): AgentOperationIdentity => ({
  operationId: "operation-1",
  kind: "model",
  fence: {
    sessionId: "session-1",
    runId: "run-1",
    turnId: "turn-1",
    generation: 1,
  },
  planHash: d("a"),
  authorityHash: d("b"),
  supervisorEpoch: 4,
  hostId: "host-1",
  hostGeneration: 2,
  hostIncarnation: "incarnation-1",
  transcriptAnchor: {
    throughChangeSeq: 2,
    entryIds: ["entry-1"],
    digest: d("c"),
  },
  descriptor: {
    version: 1,
    kind: "model",
    stepId: "step-1",
    transcript: { throughChangeSeq: 2, entryIds: ["entry-1"], digest: d("c") },
    modelPolicyHash: d("d"),
    adapterRequestVersion: "v1",
  },
  descriptorDigest:
    "sha256:4eff910ea108e76902e2dbc225430801b9b121ea84932063a6269ef671d4ac5e",
  payloadDigest: d("f"),
  adapterId: "adapter-1",
  adapterVersion: "1.0",
  ...overrides,
});
const authorizedQuery = (
  source: AgentOperationIdentity = identity(),
  overrides: Partial<AgentOperationAuthorizedQuery> = {},
): AgentOperationAuthorizedQuery =>
  ({
    mode: "exact",
    operationId: source.operationId,
    kind: source.kind,
    fence: source.fence,
    descriptorDigest: source.descriptorDigest,
    payloadDigest: source.payloadDigest,
    authority: {
      planHash: source.planHash,
      authorityHash: source.authorityHash,
      supervisorEpoch: source.supervisorEpoch,
      hostId: source.hostId,
      hostGeneration: source.hostGeneration,
      hostIncarnation: source.hostIncarnation,
    },
    ...overrides,
  }) as AgentOperationAuthorizedQuery;
const transcriptRefs = [
  {
    appendId: "append-1",
    entryIds: ["entry-2"],
    firstSeq: 3,
    lastSeq: 3,
    throughChangeSeq: 3,
    requestDigest: d("2"),
  },
];
const settlement = {
  completedAtMs: 3,
  outcome: {
    status: "succeeded" as const,
    outputDigest: d("1"),
    usage: { inputTokens: 4, outputTokens: 2 },
  },
  transcriptRefs,
  kernelTerminal: {
    outputDigest: d("1"),
    outcomeCode: "ok",
    transcriptRefs,
    pendingToolUseEntryIds: [] as string[],
  },
};
const terminalFor = (reason: AgentOperationIndeterminateReason) => ({
  outputDigest: d("3"),
  outcomeCode: reason,
  transcriptRefs,
  pendingToolUseEntryIds: [] as string[],
});
const indeterminateTerminal = async (
  _record: AgentOperationIdentity,
  reservation: Readonly<AgentOperationTerminalReservation>,
) => terminalFor(reservation.reason);

describe("SQLite Agent operation ledger", () => {
  test("persists exact prepared, executing and settled replay across every reopen boundary", async () => {
    const dbPath = path();
    const exact = identity();
    let ledger = new SQLiteAgentOperationLedger({ dbPath });
    expect((await ledger.claimPrepared(exact, 1)).claimed).toBe(true);
    await ledger.close();
    ledger = new SQLiteAgentOperationLedger({ dbPath });
    expect(
      (await ledger.claimPrepared(exact, 99)).record.receipt.acceptedAtMs,
    ).toBe(1);
    expect((await ledger.markExecuting(exact, 2)).receipt.state).toBe(
      "executing",
    );
    await ledger.close();
    ledger = new SQLiteAgentOperationLedger({ dbPath });
    const terminal = await ledger.settle(exact, settlement);
    expect(terminal.receipt).toMatchObject({
      state: "settled",
      completedAtMs: 3,
      outcome: settlement.outcome,
    });
    await ledger.close();
    ledger = new SQLiteAgentOperationLedger({ dbPath });
    expect((await ledger.claimPrepared(exact, 100)).record.receipt).toEqual(
      terminal.receipt,
    );
    expect(await ledger.scanActive()).toEqual([]);
    await ledger.close();
  });

  test("queries active and terminal receipts across reopen without dispatch grant or policy state", async () => {
    const dbPath = path();
    const exact = identity();
    const query = authorizedQuery(exact);
    let ledger = new SQLiteAgentOperationLedger({ dbPath });
    const prepared = (await ledger.claimPrepared(exact, 1)).record;
    expect(await ledger.queryAuthorized(query)).toEqual(prepared);
    await ledger.markExecuting(exact, 2);
    await ledger.close();

    ledger = new SQLiteAgentOperationLedger({ dbPath });
    expect((await ledger.queryAuthorized(query))?.receipt.state).toBe(
      "executing",
    );
    const terminal = await ledger.settle(exact, settlement);
    await ledger.close();

    ledger = new SQLiteAgentOperationLedger({ dbPath });
    expect(await ledger.queryAuthorized(query)).toEqual(terminal);
    expect(JSON.stringify(query)).not.toMatch(/grant|policy/i);
    await ledger.close();
  });

  test("returns no authorized receipt for every identity or authority crossover with zero mutation", async () => {
    const dbPath = path();
    const exact = identity();
    const ledger = new SQLiteAgentOperationLedger({ dbPath });
    const original = (await ledger.claimPrepared(exact, 1)).record;
    const base = authorizedQuery(exact);
    const alternateMcp = identity({
      operationId: exact.operationId,
      kind: "mcp",
      toolUseEntryId: "entry-1",
      descriptorDigest:
        "sha256:436fa9871b12e7650a5df3675f2683c79d080d64dcdd81a7632cb1dc9dc0eb1c",
      descriptor: {
        version: 1,
        kind: "mcp",
        toolUseEntryId: "entry-1",
        toolUseId: "use-1",
        server: "server-1",
        tool: "tool-1",
        argumentsDigest: d("9"),
        adapterRequestVersion: "v1",
      },
    });
    const mismatches: AgentOperationAuthorizedQuery[] = [
      authorizedQuery(exact, { operationId: "operation-2" }),
      authorizedQuery(exact, {
        fence: { ...exact.fence, sessionId: "session-2" },
      }),
      authorizedQuery(exact, { fence: { ...exact.fence, runId: "run-2" } }),
      authorizedQuery(exact, {
        fence: { ...exact.fence, turnId: "turn-2" },
      }),
      authorizedQuery(exact, {
        fence: { ...exact.fence, generation: 2 },
      }),
      authorizedQuery(exact, { kind: alternateMcp.kind }),
      authorizedQuery(exact, { descriptorDigest: d("1") }),
      authorizedQuery(exact, { payloadDigest: d("2") }),
      authorizedQuery(exact, {
        authority: { ...base.authority, planHash: d("3") },
      }),
      authorizedQuery(exact, {
        authority: { ...base.authority, authorityHash: d("4") },
      }),
      authorizedQuery(exact, {
        authority: { ...base.authority, supervisorEpoch: 3 },
      }),
      authorizedQuery(exact, {
        authority: { ...base.authority, hostId: "host-2" },
      }),
      authorizedQuery(exact, {
        authority: { ...base.authority, hostGeneration: 1 },
      }),
      authorizedQuery(exact, {
        authority: {
          ...base.authority,
          hostIncarnation: "incarnation-stale",
        },
      }),
    ];
    for (const mismatch of mismatches)
      expect(await ledger.queryAuthorized(mismatch)).toBeUndefined();

    const inspection = new Database(dbPath, { readonly: true });
    expect(
      inspection
        .query<{ quarantine_reason: string | null }, []>(
          "SELECT quarantine_reason FROM agent_operation_receipts",
        )
        .get()!.quarantine_reason,
    ).toBeNull();
    inspection.close();
    expect(await ledger.queryAuthorized(base)).toEqual(original);
    await ledger.close();
  });

  test("allows payload omission only for explicit recovery without weakening other bindings", async () => {
    const dbPath = path();
    const exact = identity();
    let ledger = new SQLiteAgentOperationLedger({ dbPath });
    await ledger.claimPrepared(exact, 1);
    const { payloadDigest: _payload, ...recoveryBase } = authorizedQuery(exact);
    const recovery = { ...recoveryBase, mode: "recovery" as const };
    expect((await ledger.queryAuthorized(recovery))?.operationId).toBe(
      exact.operationId,
    );
    await expect(
      ledger.queryAuthorized({ ...recoveryBase, mode: "exact" } as never),
    ).rejects.toThrow("requires payload digest");
    expect(
      await ledger.queryAuthorized({
        ...recovery,
        fence: { ...recovery.fence, generation: 2 },
      }),
    ).toBeUndefined();
    expect(
      await ledger.queryAuthorized({
        ...recovery,
        descriptorDigest: d("8"),
      }),
    ).toBeUndefined();
    expect(
      await ledger.queryAuthorized({
        ...recovery,
        payloadDigest: d("7"),
      }),
    ).toBeUndefined();
    expect(
      await ledger.queryAuthorized({
        ...recovery,
        authority: { ...recovery.authority, hostGeneration: 1 },
      }),
    ).toBeUndefined();
    await ledger.markExecuting(exact, 2);
    const terminal = await ledger.settle(exact, settlement);
    await ledger.close();
    ledger = new SQLiteAgentOperationLedger({ dbPath });
    expect(await ledger.queryAuthorized(recovery)).toEqual(terminal);
    await ledger.close();
  });

  test("strictly rejects prototypes, accessors and diagnostic secrets before reading", async () => {
    const dbPath = path();
    const exact = identity();
    const ledger = new SQLiteAgentOperationLedger({ dbPath });
    await ledger.claimPrepared(exact, 1);
    const base = authorizedQuery(exact);
    let getterCalls = 0;
    const accessor = { ...base } as Record<string, unknown>;
    Object.defineProperty(accessor, "operationId", {
      enumerable: true,
      get() {
        getterCalls++;
        return exact.operationId;
      },
    });
    await expect(ledger.queryAuthorized(accessor as never)).rejects.toThrow(
      "invalid authorized Agent operation query",
    );
    expect(getterCalls).toBe(0);

    const inherited = Object.assign(Object.create({ leaked: true }), base);
    await expect(ledger.queryAuthorized(inherited)).rejects.toThrow(
      "invalid authorized Agent operation query",
    );
    const secret = { ...base, bearerGrant: "diagnostic-secret-value" };
    let message = "";
    try {
      await ledger.queryAuthorized(secret as never);
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain("diagnostic-secret-value");
    expect(await ledger.queryAuthorized(base)).toBeDefined();
    await ledger.close();
  });

  test("serializes concurrent duplicate claims to one durable record", async () => {
    const dbPath = path();
    const first = new SQLiteAgentOperationLedger({ dbPath });
    const second = new SQLiteAgentOperationLedger({ dbPath });
    const results = await Promise.all([
      first.claimPrepared(identity(), 1),
      second.claimPrepared(identity(), 1),
    ]);
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(results[0].record.receipt).toEqual(results[1].record.receipt);
    await first.close();
    await second.close();
  });

  test("strictly canonicalizes and verifies descriptors before any durable write", async () => {
    const dbPath = path();
    const ledger = new SQLiteAgentOperationLedger({ dbPath });
    const malicious = identity({
      descriptor: {
        ...identity().descriptor,
        prompt: "do not persist",
        credentials: { token: "secret-value" },
      } as never,
    });
    await expect(ledger.claimPrepared(malicious, 1)).rejects.toThrow();
    await expect(
      ledger.claimPrepared(
        identity({ operationId: "operation-2", descriptorDigest: d("3") }),
        1,
      ),
    ).rejects.toThrow("descriptor digest does not match");
    const inspection = new Database(dbPath, { readonly: true });
    expect(
      JSON.stringify(
        inspection.query("SELECT * FROM agent_operation_receipts").all(),
      ),
    ).not.toMatch(/do not persist|secret-value/);
    inspection.close();
    await ledger.close();
  });

  test("atomically quarantines every exact identity mismatch without overwriting", async () => {
    const dbPath = path();
    const ledger = new SQLiteAgentOperationLedger({ dbPath });
    const original = identity();
    await ledger.claimPrepared(original, 1);
    const mismatches: AgentOperationIdentity[] = [
      identity({
        kind: "mcp",
        toolUseEntryId: "entry-1",
        descriptorDigest:
          "sha256:436fa9871b12e7650a5df3675f2683c79d080d64dcdd81a7632cb1dc9dc0eb1c",
        descriptor: {
          version: 1,
          kind: "mcp",
          toolUseEntryId: "entry-1",
          toolUseId: "use-1",
          server: "server-1",
          tool: "tool-1",
          argumentsDigest: d("9"),
          adapterRequestVersion: "v1",
        },
      }),
      identity({ fence: { ...original.fence, runId: "run-2" } }),
      identity({ fence: { ...original.fence, turnId: "turn-2" } }),
      identity({ fence: { ...original.fence, generation: 2 } }),
      identity({ planHash: d("1") }),
      identity({ authorityHash: d("2") }),
      identity({ supervisorEpoch: 5 }),
      identity({ hostId: "host-2" }),
      identity({ hostGeneration: 3 }),
      identity({ hostIncarnation: "incarnation-2" }),
      identity({ payloadDigest: d("4") }),
      identity({ adapterId: "adapter-2" }),
      identity({ adapterVersion: "2.0" }),
    ];
    for (const mismatch of mismatches)
      await expect(ledger.claimPrepared(mismatch, 1)).rejects.toBeInstanceOf(
        AgentOperationConflictError,
      );
    expect((await ledger.getExact(original))?.quarantineReason).toContain(
      "mismatch",
    );
    expect((await ledger.getExact(original))?.planHash).toBe(original.planHash);
    expect(await ledger.scanActive()).toEqual([]);
    await expect(ledger.claimPrepared(original, 1)).rejects.toBeInstanceOf(
      AgentOperationConflictError,
    );
    await expect(ledger.markExecuting(original, 2)).rejects.toBeInstanceOf(
      AgentOperationConflictError,
    );
    await ledger.close();
  });

  test("rejects illegal and backward transitions", async () => {
    const ledger = new SQLiteAgentOperationLedger({ dbPath: path() });
    const exact = identity();
    await ledger.claimPrepared(exact, 1);
    await expect(ledger.settle(exact, settlement)).rejects.toBeInstanceOf(
      AgentOperationTransitionError,
    );
    await ledger.markExecuting(exact, 2);
    await ledger.settle(exact, settlement);
    await expect(ledger.markExecuting(exact, 4)).rejects.toBeInstanceOf(
      AgentOperationTransitionError,
    );
    await expect(
      ledger.reserveIndeterminate(exact, "ambiguous_completion", 4),
    ).rejects.toBeInstanceOf(AgentOperationTransitionError);
    await ledger.close();
  });

  test("leaves prepared replayable and makes inherited executing visibly indeterminate when reconciliation is unsupported", async () => {
    const dbPath = path();
    let ledger = new SQLiteAgentOperationLedger({ dbPath });
    await ledger.claimPrepared(identity(), 1);
    await ledger.claimPrepared(identity({ operationId: "operation-2" }), 1);
    await ledger.markExecuting(identity({ operationId: "operation-2" }), 2);
    await ledger.close();
    ledger = new SQLiteAgentOperationLedger({ dbPath });
    const active = await ledger.scanActive();
    expect(active.map((r) => r.receipt.state)).toEqual([
      "prepared",
      "executing",
    ]);
    const recovered = await reconcileExecutingOperation(
      ledger,
      active[1],
      undefined,
      indeterminateTerminal,
      4,
    );
    expect(recovered.receipt).toMatchObject({
      state: "indeterminate",
      errorCode: "reconciliation_unsupported",
      transcriptRefs,
      kernelTerminal: terminalFor("reconciliation_unsupported"),
    });
    expect((await ledger.scanActive()).map((r) => r.receipt.state)).toEqual([
      "prepared",
    ]);
    await ledger.close();
    ledger = new SQLiteAgentOperationLedger({ dbPath });
    expect((await ledger.getExact(active[1]))!.receipt).toEqual(
      recovered.receipt,
    );
    await ledger.close();
  });

  test("reserves indeterminate ownership before transcript I/O and survives restart", async () => {
    const dbPath = path();
    const exact = identity();
    let ledger = new SQLiteAgentOperationLedger({ dbPath });
    await ledger.claimPrepared(exact, 1);
    await ledger.markExecuting(exact, 2);
    const reservation = await ledger.reserveIndeterminate(
      exact,
      "reconciliation_unsupported",
      3,
    );
    await ledger.close();

    ledger = new SQLiteAgentOperationLedger({ dbPath });
    const reservedRecord = (await ledger.getExact(exact))!;
    expect(reservedRecord.terminalReservation).toEqual(reservation);
    expect(
      await ledger.reserveIndeterminate(exact, "reconciliation_failed", 4),
    ).toEqual(reservation);
    await expect(ledger.settle(exact, settlement)).rejects.toBeInstanceOf(
      AgentOperationTerminalReservedError,
    );
    let callbackCalls = 0;
    let adapterCalls = 0;
    const recovered = await reconcileExecutingOperation(
      ledger,
      reservedRecord,
      {
        reconcile: async () => {
          adapterCalls += 1;
          throw new Error("reserved recovery must not consult adapter");
        },
      },
      async (record, owned) => {
        callbackCalls += 1;
        expect(owned).toEqual(reservation);
        await expect(ledger.settle(record, settlement)).rejects.toBeInstanceOf(
          AgentOperationTerminalReservedError,
        );
        return terminalFor(owned.reason);
      },
      4,
    );
    expect(adapterCalls).toBe(0);
    expect(callbackCalls).toBe(1);
    expect(recovered.receipt).toMatchObject({
      state: "indeterminate",
      errorCode: "reconciliation_unsupported",
    });
    expect(recovered.terminalReservation).toBeUndefined();
    await ledger.close();
  });

  test("does not append indeterminate evidence after settlement wins terminal ownership", async () => {
    const ledger = new SQLiteAgentOperationLedger({ dbPath: path() });
    const exact = identity();
    await ledger.claimPrepared(exact, 1);
    const staleExecuting = await ledger.markExecuting(exact, 2);
    const settled = await ledger.settle(exact, settlement);
    let callbackCalls = 0;
    const recovered = await reconcileExecutingOperation(
      ledger,
      staleExecuting,
      undefined,
      async () => {
        callbackCalls += 1;
        return terminalFor("reconciliation_unsupported");
      },
      4,
    );
    expect(callbackCalls).toBe(0);
    expect(recovered.receipt).toEqual(settled.receipt);
    await ledger.close();
  });

  test("authenticates a recovered reservation before transcript I/O", async () => {
    const ledger = new SQLiteAgentOperationLedger({ dbPath: path() });
    const exact = identity();
    await ledger.claimPrepared(exact, 1);
    const executing = await ledger.markExecuting(exact, 2);
    let callbackCalls = 0;
    const callback = async (
      _record: AgentOperationRecord,
      reservation: Readonly<AgentOperationTerminalReservation>,
    ) => {
      callbackCalls += 1;
      return terminalFor(reservation.reason);
    };
    const forgedReservation = {
      reservationId: `reservation:${"9".repeat(64)}`,
      reason: "reconciliation_unsupported" as const,
      reservedAtMs: 3,
    };
    await expect(
      reconcileExecutingOperation(
        ledger,
        { ...executing, terminalReservation: forgedReservation },
        undefined,
        callback,
        3,
      ),
    ).rejects.toBeInstanceOf(AgentOperationConflictError);
    expect(callbackCalls).toBe(0);
    expect((await ledger.getExact(exact))?.terminalReservation).toBeUndefined();

    const durable = await ledger.reserveIndeterminate(
      exact,
      "reconciliation_unsupported",
      3,
    );
    const reserved = (await ledger.getExact(exact))!;
    await expect(
      reconcileExecutingOperation(
        ledger,
        {
          ...reserved,
          terminalReservation: {
            ...durable,
            reservationId: `reservation:${"8".repeat(64)}`,
          },
        },
        undefined,
        callback,
        4,
      ),
    ).rejects.toBeInstanceOf(AgentOperationConflictError);
    expect(callbackCalls).toBe(0);
    expect((await ledger.getExact(exact))?.terminalReservation).toEqual(
      durable,
    );
    await ledger.close();
  });

  test("requires exact adapter reconciliation proof and adopts a supported terminal proof", async () => {
    const ledger = new SQLiteAgentOperationLedger({ dbPath: path() });
    const exact = identity();
    await ledger.claimPrepared(exact, 1);
    const executing = await ledger.markExecuting(exact, 2);
    const result = await reconcileExecutingOperation(
      ledger,
      executing,
      {
        reconcile: async () => ({
          status: "settled",
          proof: {
            adapterId: exact.adapterId,
            adapterVersion: exact.adapterVersion,
            operationId: exact.operationId,
            kind: exact.kind,
            fence: exact.fence,
            planHash: exact.planHash,
            authorityHash: exact.authorityHash,
            descriptorDigest: exact.descriptorDigest,
            payloadDigest: exact.payloadDigest,
            providerResponseRef: "response-1",
          },
          settlement: { ...settlement, providerResponseRef: "response-1" },
        }),
      },
      indeterminateTerminal,
      4,
    );
    expect(result.receipt.state).toBe("settled");
    await ledger.close();
  });

  test("fails closed on malformed or contradictory reconciliation output", async () => {
    for (const malformed of [
      { status: "settled" },
      {
        status: "settled",
        proof: {
          adapterId: "adapter-1",
          adapterVersion: "1.0",
          operationId: "operation-1",
          kind: "model",
          fence: identity().fence,
          planHash: identity().planHash,
          authorityHash: identity().authorityHash,
          descriptorDigest: identity().descriptorDigest,
          payloadDigest: identity().payloadDigest,
          providerResponseRef: "different-response",
        },
        settlement,
      },
    ]) {
      const ledger = new SQLiteAgentOperationLedger({ dbPath: path() });
      const exact = identity();
      await ledger.claimPrepared(exact, 1);
      const executing = await ledger.markExecuting(exact, 2);
      const result = await reconcileExecutingOperation(
        ledger,
        executing,
        { reconcile: async () => malformed as never },
        indeterminateTerminal,
        3,
      );
      expect(result.receipt).toMatchObject({
        state: "indeterminate",
        errorCode: "reconciliation_failed",
      });
      await ledger.close();
    }
  });

  test("does not treat cancellation, timeout, AbortError or disconnect as settlement", async () => {
    for (const reason of [
      "cancellation_ambiguous",
      "timeout_ambiguous",
      "disconnect_ambiguous",
    ] as const) {
      const ledger = new SQLiteAgentOperationLedger({ dbPath: path() });
      const exact = identity();
      await ledger.claimPrepared(exact, 1);
      await ledger.markExecuting(exact, 2);
      const reservation = await ledger.reserveIndeterminate(exact, reason, 3);
      expect(
        (
          await ledger.markIndeterminate(
            exact,
            reservation,
            3,
            terminalFor(reason),
          )
        ).receipt.state,
      ).toBe("indeterminate");
      await ledger.close();
    }
    const ledger = new SQLiteAgentOperationLedger({ dbPath: path() });
    const exact = identity();
    await ledger.claimPrepared(exact, 1);
    const executing = await ledger.markExecuting(exact, 2);
    const recovered = await reconcileExecutingOperation(
      ledger,
      executing,
      {
        reconcile: async () => {
          throw new DOMException("aborted", "AbortError");
        },
      },
      indeterminateTerminal,
      3,
    );
    expect(recovered.receipt.errorCode).toBe("reconciliation_failed");
    await ledger.close();
  });

  test("enforces capacity, row bounds, retirement and authoritative session deletion", async () => {
    const ledger = new SQLiteAgentOperationLedger({
      dbPath: path(),
      capacity: 1,
    });
    await ledger.claimPrepared(identity(), 1);
    await expect(
      ledger.claimPrepared(identity({ operationId: "operation-2" }), 1),
    ).rejects.toBeInstanceOf(AgentOperationLedgerFullError);
    await expect(ledger.retireSession("session-1")).rejects.toBeInstanceOf(
      AgentOperationSessionActiveError,
    );
    expect(await ledger.deleteSession("session-1")).toBe(1);
    expect(await ledger.scanActive()).toEqual([]);
    await ledger.close();
    const bounded = new SQLiteAgentOperationLedger({
      dbPath: path(),
      maxRowBytes: 256,
    });
    await expect(bounded.claimPrepared(identity(), 1)).rejects.toBeInstanceOf(
      AgentOperationLedgerFullError,
    );
    await bounded.close();
  });

  test("creates an exact private schema with no body/secret columns or serialized payloads", async () => {
    const dbPath = path();
    const ledger = new SQLiteAgentOperationLedger({ dbPath });
    await ledger.claimPrepared(identity(), 1);
    const inspection = new Database(dbPath, { readonly: true });
    const sql = inspection
      .query<{ sql: string }, [string]>(
        "SELECT sql FROM sqlite_master WHERE name=?",
      )
      .get("agent_operation_receipts")!.sql;
    const columns = inspection
      .query<{ name: string }, []>(
        "PRAGMA table_info('agent_operation_receipts')",
      )
      .all()
      .map((r) => r.name);
    const rows = JSON.stringify(
      inspection.query("SELECT * FROM agent_operation_receipts").all(),
    );
    inspection.close();
    expect(sql).toContain("PRIMARY KEY(session_id,operation_id)");
    expect(columns).not.toEqual(
      expect.arrayContaining([
        "body",
        "prompt",
        "arguments",
        "credentials",
        "headers",
        "url",
        "response_body",
      ]),
    );
    expect(rows).not.toMatch(
      /authorization|apiKey|credentials|prompt|responseBody|toolInput/i,
    );
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    await ledger.close();
  });

  test("fails closed on unsafe sidecars, schema and row tampering", async () => {
    const sidecar = path();
    const target = `${sidecar}.target`;
    writeFileSync(target, "x");
    symlinkSync(target, `${sidecar}-wal`);
    expect(() => new SQLiteAgentOperationLedger({ dbPath: sidecar })).toThrow(
      "unsafe Agent operation ledger SQLite file",
    );
    const lookalike = path();
    const weak = new Database(lookalike);
    weak.exec(`CREATE TABLE agent_operation_receipts (
      session_id TEXT, operation_id TEXT, kind TEXT, run_id TEXT, turn_id TEXT, generation INTEGER,
      plan_hash TEXT, authority_hash TEXT, descriptor_digest TEXT, payload_digest TEXT,
      adapter_id TEXT, adapter_version TEXT, state TEXT, accepted_at INTEGER, executing_at INTEGER,
      completed_at INTEGER, descriptor_json TEXT, receipt_json TEXT, quarantine_reason TEXT, ordinal INTEGER
    ); PRAGMA user_version=1;`);
    weak.close();
    expect(() => new SQLiteAgentOperationLedger({ dbPath: lookalike })).toThrow(
      "unsupported Agent operation ledger schema: 1",
    );

    const unknown = path();
    const db = new Database(unknown);
    db.exec("PRAGMA user_version=3");
    db.close();
    expect(() => new SQLiteAgentOperationLedger({ dbPath: unknown })).toThrow(
      "unsupported Agent operation ledger schema",
    );
    const tampered = path();
    let ledger = new SQLiteAgentOperationLedger({ dbPath: tampered });
    await ledger.claimPrepared(identity(), 1);
    await ledger.close();
    const mutation = new Database(tampered);
    mutation
      .query("UPDATE agent_operation_receipts SET receipt_json=?")
      .run('{"body":"secret"}');
    mutation.close();
    ledger = new SQLiteAgentOperationLedger({ dbPath: tampered });
    await expect(ledger.scanActive()).rejects.toThrow(
      "corrupt Agent operation ledger row",
    );
    await ledger.close();

    const authorizedPath = path();
    ledger = new SQLiteAgentOperationLedger({ dbPath: authorizedPath });
    await ledger.claimPrepared(identity(), 1);
    await ledger.close();
    const authorizedTamper = new Database(authorizedPath);
    authorizedTamper
      .query("UPDATE agent_operation_receipts SET plan_hash=?")
      .run(d("9"));
    authorizedTamper.close();
    ledger = new SQLiteAgentOperationLedger({ dbPath: authorizedPath });
    await expect(ledger.queryAuthorized(authorizedQuery())).rejects.toThrow(
      "tampered Agent operation ledger receipt",
    );
    await ledger.close();

    const reservationPath = path();
    ledger = new SQLiteAgentOperationLedger({ dbPath: reservationPath });
    await ledger.claimPrepared(identity(), 1);
    await ledger.markExecuting(identity(), 2);
    await ledger.reserveIndeterminate(
      identity(),
      "reconciliation_unsupported",
      3,
    );
    await ledger.close();
    const reservationTamper = new Database(reservationPath);
    reservationTamper
      .query(
        "UPDATE agent_operation_receipts SET terminal_reservation_reason=?",
      )
      .run("reconciliation_failed");
    reservationTamper.close();
    ledger = new SQLiteAgentOperationLedger({ dbPath: reservationPath });
    await expect(ledger.scanActive()).rejects.toThrow(
      "tampered Agent operation ledger receipt",
    );
    await ledger.close();

    const quarantinePath = path();
    ledger = new SQLiteAgentOperationLedger({ dbPath: quarantinePath });
    await ledger.claimPrepared(identity(), 1);
    await ledger.close();
    const quarantineTamper = new Database(quarantinePath);
    quarantineTamper.exec("PRAGMA ignore_check_constraints=ON");
    quarantineTamper
      .query("UPDATE agent_operation_receipts SET quarantine_reason=?")
      .run("secret arbitrary metadata");
    quarantineTamper.close();
    expect(
      () => new SQLiteAgentOperationLedger({ dbPath: quarantinePath }),
    ).toThrow();
  });

  test("close is idempotent, drains WAL and rejects later access", async () => {
    const dbPath = path();
    const ledger = new SQLiteAgentOperationLedger({ dbPath });
    await ledger.claimPrepared(identity(), 1);
    await ledger.close();
    await ledger.close();
    expect(readFileSync(dbPath).subarray(0, 16).toString()).toBe(
      "SQLite format 3\u0000",
    );
    await expect(ledger.scanActive()).rejects.toThrow("closed");
    chmodSync(dbPath, 0o644);
    const reopened = new SQLiteAgentOperationLedger({ dbPath });
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    await reopened.close();
  });
});
