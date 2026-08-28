import { describe, expect, test } from "bun:test";
import { qualifyDetachedAgentHostCanary, type CanaryQualificationScenario } from "./canary-qualification";
import { createCanaryProductionProbes, type CanaryProductionProbeOwners } from "./canary-production-probes";

const ID = "operation-1";
const GENERATION = "generation-2";
const FENCE = `sha256:${"a".repeat(64)}`;
const RECEIPT = `sha256:${"b".repeat(64)}`;
const durableCount = () => ({
  operationId: ID, fenceDigest: FENCE, receiptDigest: RECEIPT, durable: true as const, count: 1,
});
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type TestOwners = Mutable<CanaryProductionProbeOwners> & {
  gateway: Mutable<CanaryProductionProbeOwners["gateway"]>;
  host: Mutable<CanaryProductionProbeOwners["host"]>;
  process: Mutable<CanaryProductionProbeOwners["process"]>;
  accounting: Mutable<CanaryProductionProbeOwners["accounting"]>;
};

function fixture(): TestOwners {
  return {
    deadlineMs: 50,
    gateway: {
      submit: () => ({ operationId: ID }),
      readEvidence: () => ({
        logicalOperationCount: 1,
        terminalResults: [{ operationId: ID, status: "completed", visible: true }],
        ackReplay: [{ ackSeq: 1, replaySeq: 1 }],
      }),
    },
    host: {
      awaitPhysicalStart: () => {},
      readEvidence: () => ({
        operationId: ID, dispatchCount: 1, physicalRetryCount: 0,
        executionGeneration: GENERATION, activeGeneration: GENERATION,
        infrastructureFallback: false, executionPaths: ["agent-host"],
        scenario: "normal", fenceDigest: FENCE,
      }),
    },
    process: {
      applyScenario: (scenario: CanaryQualificationScenario) => ({
        scenario, certainty: "settled",
        events: scenario === "blue-green-drain"
          ? ["generation-draining", "generation-activated", "generation-drained"]
          : [],
      }),
    },
    receipts: {
      read: () => (["transcript", "operation", "kernel"] as const).map((kind) => ({
        kind, operationId: ID, terminal: "completed" as const,
      })),
      readDurableBinding: () => ({
        operationId: ID, fenceDigest: FENCE, receiptDigest: RECEIPT, terminalDurable: true,
      }),
    },
    transcript: {
      read: () => ({ terminalEntries: [{ operationId: ID, status: "completed", visible: true }] }),
    },
    accounting: {
      model: { domainId: "billing:model", readDurableCount: durableCount },
      mcp: { domainId: "audit:mcp", readDurableCount: durableCount },
      executor: { domainId: "executor:physical", readDurableCount: durableCount },
    },
  };
}

describe("production canary probes", () => {
  test("qualifies independent organization-controlled physical counters", async () => {
    const result = await qualifyDetachedAgentHostCanary("normal", createCanaryProductionProbes(fixture()));
    expect(result).toEqual({
      version: 1, scenario: "normal", outcome: "qualified", codes: ["QUALIFIED"], redacted: true,
    });
  });

  test("fails closed when counter domains collide by identity or domain id", async () => {
    const identityCollision = fixture();
    identityCollision.accounting.mcp = identityCollision.accounting.model;
    expect((await qualifyDetachedAgentHostCanary(
      "normal", createCanaryProductionProbes(identityCollision),
    )).codes).toEqual(["PROBE_FAILED"]);

    const idCollision = fixture();
    idCollision.accounting.executor = { domainId: "billing:model", readDurableCount: durableCount };
    expect((await qualifyDetachedAgentHostCanary(
      "normal", createCanaryProductionProbes(idCollision),
    )).codes).toEqual(["PROBE_FAILED"]);
  });

  test("detects fallback and direct execution evidence", async () => {
    const owners = fixture();
    owners.host.readEvidence = () => ({
      operationId: ID, dispatchCount: 1, physicalRetryCount: 0,
      executionGeneration: GENERATION, activeGeneration: GENERATION,
      infrastructureFallback: true, executionPaths: ["agent-host", "direct"],
      scenario: "normal", fenceDigest: FENCE,
    });
    expect((await qualifyDetachedAgentHostCanary(
      "normal", createCanaryProductionProbes(owners),
    )).codes).toEqual(["INFRASTRUCTURE_FALLBACK_OBSERVED"]);
  });

  test("binds durable counters to operation, fence, and receipt digests", async () => {
    const owners = fixture();
    owners.accounting.model.readDurableCount = () => ({
      ...durableCount(), receiptDigest: `sha256:${"c".repeat(64)}`,
    });
    expect((await qualifyDetachedAgentHostCanary(
      "normal", createCanaryProductionProbes(owners),
    )).codes).toEqual(["PROBE_FAILED"]);
  });

  test("proves old turns drain after durable terminal while new admissions use active generation", async () => {
    const owners = fixture();
    owners.host.readEvidence = () => ({
      operationId: ID, dispatchCount: 1, physicalRetryCount: 0,
      executionGeneration: "generation-old", activeGeneration: "generation-new",
      infrastructureFallback: false, executionPaths: ["agent-host"],
      scenario: "blue-green-drain", fenceDigest: FENCE,
      generationTransition: {
        drainingGeneration: "generation-old", admissionGeneration: "generation-new",
        oldTerminalDurable: true, oldDrainedAfterTerminal: true,
      },
    });
    expect((await qualifyDetachedAgentHostCanary(
      "blue-green-drain", createCanaryProductionProbes(owners),
    )).codes).toEqual(["QUALIFIED"]);
  });

  test("bounds owners, aborts the signal, and redacts failures", async () => {
    const owners = fixture();
    owners.deadlineMs = 2;
    let aborted = false;
    owners.gateway.submit = (_request, signal) => new Promise<{ readonly operationId: string }>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("provider payload token /private/config"));
      }, { once: true });
    });
    const result = await qualifyDetachedAgentHostCanary("normal", createCanaryProductionProbes(owners));
    expect(result.codes).toEqual(["DEADLINE_EXCEEDED"]);
    expect(aborted).toBe(true);
    expect(JSON.stringify(result)).not.toContain("provider");
    expect(JSON.stringify(result)).not.toContain("/private");
  });

  test("construction is inert until qualification invokes owners", async () => {
    let calls = 0;
    const owners = fixture();
    owners.gateway.submit = () => { calls++; throw new Error("private token"); };
    const probes = createCanaryProductionProbes(owners);
    expect(calls).toBe(0);
    const result = await qualifyDetachedAgentHostCanary("normal", probes);
    expect(calls).toBe(1);
    expect(result.codes).toEqual(["PROBE_FAILED"]);
  });
});
