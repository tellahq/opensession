import { describe, expect, test } from "bun:test";
import {
  CANARY_QUALIFICATION_SCENARIOS,
  qualifyDetachedAgentHostCanary,
  type CanaryDeadlineProbe,
  type CanaryGatewayEvidence,
  type CanaryHostEvidence,
  type CanaryInterventionEvidence,
  type CanaryProcessEvent,
  type CanaryQualificationProbes,
  type CanaryQualificationScenario,
  type CanaryQualificationStep,
  type CanaryReceiptEvidence,
  type CanaryTranscriptEvidence,
} from "./canary-qualification";

const OPERATION_ID = "canary-operation";
const GENERATION = "agent-host:g2";

const EVENTS: Record<CanaryQualificationScenario, CanaryProcessEvent[]> = {
  normal: [],
  "gateway-sigkill-restart": ["gateway-sigkill", "gateway-restarted"],
  "host-sigkill-restart": ["host-sigkill", "host-restarted"],
  disconnect: ["transport-disconnected", "transport-reconnected"],
  cancellation: ["cancellation-requested", "cancellation-acknowledged"],
  "key-rotation": ["key-rotated"],
  "blue-green-drain": [
    "generation-draining",
    "generation-activated",
    "generation-drained",
  ],
};

function expectedTerminal(scenario: CanaryQualificationScenario) {
  return scenario === "cancellation" ? "cancelled" : "completed";
}

function fixture(scenario: CanaryQualificationScenario = "normal") {
  const terminal = expectedTerminal(scenario);
  const data: {
    gateway: CanaryGatewayEvidence;
    host: CanaryHostEvidence;
    intervention: CanaryInterventionEvidence;
    receipts: CanaryReceiptEvidence[];
    transcript: CanaryTranscriptEvidence;
    deadlineStep?: CanaryQualificationStep;
    rejectStep?: CanaryQualificationStep;
  } = {
    gateway: {
      logicalOperationCount: 1,
      terminalResults: [
        { operationId: OPERATION_ID, status: terminal, visible: true },
      ],
      ackReplay: [
        { ackSeq: 1, replaySeq: 0 },
        { ackSeq: 3, replaySeq: 2 },
        { ackSeq: 3, replaySeq: 3 },
      ],
    },
    host: {
      operationId: OPERATION_ID,
      dispatchCount: 1,
      physicalRetryCount: 0,
      physicalEffects: [
        { kind: "model", counterId: "provider-counter", count: 1 },
        { kind: "mcp", counterId: "mcp-counter", count: 1 },
        { kind: "executor", counterId: "executor-counter", count: 1 },
      ],
      executionGeneration: GENERATION,
      activeGeneration: GENERATION,
      infrastructureFallback: false,
      executionPaths: ["agent-host"],
    },
    intervention: {
      scenario,
      certainty: "settled",
      events: [...EVENTS[scenario]],
    },
    receipts: (["transcript", "operation", "kernel"] as const).map((kind) => ({
      kind,
      operationId: OPERATION_ID,
      terminal,
    })),
    transcript: {
      terminalEntries: [
        { operationId: OPERATION_ID, status: terminal, visible: true },
      ],
    },
  };
  const calls = {
    submit: 0,
    physicalStart: 0,
    intervention: 0,
    gatewayEvidence: 0,
    hostEvidence: 0,
    receipts: 0,
    transcript: 0,
  };
  const maybeReject = (step: CanaryQualificationStep) => {
    if (data.rejectStep === step) throw new Error("private probe detail");
  };
  const deadline: CanaryDeadlineProbe = {
    async within(step, task) {
      if (data.deadlineStep === step) return { status: "deadline" };
      return { status: "completed", value: await task() };
    },
  };
  const probes: CanaryQualificationProbes = {
    deadline,
    gateway: {
      async submit(request) {
        calls.submit++;
        maybeReject("submit");
        expect(request).toEqual({
          scenario,
          effectKinds: ["model", "mcp", "executor"],
          executionPath: "agent-host",
          allowInfrastructureFallback: false,
          physicalRetryLimit: 0,
        });
        return { operationId: OPERATION_ID };
      },
      async readEvidence() {
        calls.gatewayEvidence++;
        maybeReject("visible-terminal");
        return data.gateway;
      },
    },
    host: {
      async awaitPhysicalStart() {
        calls.physicalStart++;
        maybeReject("physical-start");
      },
      async readEvidence() {
        calls.hostEvidence++;
        maybeReject("host-evidence");
        return data.host;
      },
    },
    process: {
      async applyScenario() {
        calls.intervention++;
        maybeReject("intervention");
        return data.intervention;
      },
    },
    receipts: {
      async read() {
        calls.receipts++;
        maybeReject("receipts");
        return data.receipts;
      },
    },
    transcript: {
      async read() {
        calls.transcript++;
        maybeReject("transcript");
        return data.transcript;
      },
    },
  };
  return { data, calls, probes };
}

async function codeFor(
  mutate: (value: ReturnType<typeof fixture>["data"]) => void,
  scenario: CanaryQualificationScenario = "normal",
) {
  const value = fixture(scenario);
  mutate(value.data);
  const result = await qualifyDetachedAgentHostCanary(scenario, value.probes);
  expect(result.outcome).toBe("failed");
  expect(result.redacted).toBe(true);
  return result.codes[0];
}

describe("detached Agent Host canary qualification", () => {
  for (const scenario of CANARY_QUALIFICATION_SCENARIOS) {
    test(`qualifies ${scenario}`, async () => {
      const { calls, probes } = fixture(scenario);
      const result = await qualifyDetachedAgentHostCanary(scenario, probes);
      expect(result).toEqual({
        version: 1,
        scenario,
        outcome: "qualified",
        codes: ["QUALIFIED"],
        redacted: true,
      });
      expect(calls).toEqual({
        submit: 1,
        physicalStart: 1,
        intervention: 1,
        gatewayEvidence: 1,
        hostEvidence: 1,
        receipts: 1,
        transcript: 1,
      });
    });
  }

  test("fails a scenario whose injected process evidence is incomplete", async () => {
    expect(
      await codeFor((data) => {
        data.intervention = {
          ...data.intervention,
          events: ["gateway-sigkill"],
        };
      }, "gateway-sigkill-restart"),
    ).toBe("SCENARIO_MISMATCH");
  });

  test("fails missing or duplicate logical operations", async () => {
    for (const count of [0, 2]) {
      expect(
        await codeFor((data) => {
          data.gateway = { ...data.gateway, logicalOperationCount: count };
        }),
      ).toBe("LOGICAL_COUNT_MISMATCH");
    }
  });

  test("fails missing, duplicate, or non-independent physical effects", async () => {
    const mutations = [
      (data: ReturnType<typeof fixture>["data"]) => {
        data.host = {
          ...data.host,
          physicalEffects: data.host.physicalEffects.slice(1),
        };
      },
      (data: ReturnType<typeof fixture>["data"]) => {
        data.host = {
          ...data.host,
          physicalEffects: [
            ...data.host.physicalEffects,
            data.host.physicalEffects[0]!,
          ],
        };
      },
      (data: ReturnType<typeof fixture>["data"]) => {
        data.host = {
          ...data.host,
          physicalEffects: data.host.physicalEffects.map((effect) => ({
            ...effect,
            counterId: "shared-counter",
          })),
        };
      },
    ];
    for (const mutation of mutations)
      expect(await codeFor(mutation)).toBe("PHYSICAL_COUNT_MISMATCH");
  });

  test("fails duplicate dispatch and any physical retry", async () => {
    expect(
      await codeFor((data) => {
        data.host = { ...data.host, dispatchCount: 2 };
      }),
    ).toBe("PHYSICAL_COUNT_MISMATCH");
    expect(
      await codeFor((data) => {
        data.host = { ...data.host, physicalRetryCount: 1 };
      }),
    ).toBe("PHYSICAL_RETRY_OBSERVED");
  });

  test("fails missing, duplicate, hidden, or wrong terminal results", async () => {
    const variants: CanaryGatewayEvidence["terminalResults"][] = [
      [],
      [
        { operationId: OPERATION_ID, status: "completed", visible: true },
        { operationId: OPERATION_ID, status: "completed", visible: true },
      ],
      [{ operationId: OPERATION_ID, status: "completed", visible: false }],
      [{ operationId: "other", status: "completed", visible: true }],
    ];
    for (const terminalResults of variants)
      expect(
        await codeFor((data) => {
          data.gateway = { ...data.gateway, terminalResults };
        }),
      ).toBe("TERMINAL_RESULT_MISMATCH");
  });

  test("fails missing, duplicate, or mismatched exact receipts", async () => {
    const base = fixture().data.receipts;
    const variants: CanaryReceiptEvidence[][] = [
      base.slice(1),
      [...base, base[0]!],
      base.map((receipt, index) =>
        index === 0 ? { ...receipt, operationId: "other" } : receipt,
      ),
    ];
    for (const receipts of variants)
      expect(
        await codeFor((data) => {
          data.receipts = receipts;
        }),
      ).toBe("RECEIPT_MISMATCH");
  });

  test("fails missing, duplicate, or mismatched transcript terminals", async () => {
    const entry = fixture().data.transcript.terminalEntries[0]!;
    for (const terminalEntries of [
      [],
      [entry, entry],
      [{ ...entry, visible: false }],
    ])
      expect(
        await codeFor((data) => {
          data.transcript = { terminalEntries };
        }),
      ).toBe("TRANSCRIPT_MISMATCH");
  });

  test("fails absent, regressing, invalid, or ahead-of-ACK replay evidence", async () => {
    const variants = [
      [],
      [
        { ackSeq: 2, replaySeq: 1 },
        { ackSeq: 1, replaySeq: 1 },
      ],
      [
        { ackSeq: 2, replaySeq: 2 },
        { ackSeq: 3, replaySeq: 1 },
      ],
      [{ ackSeq: 1, replaySeq: 2 }],
      [{ ackSeq: -1, replaySeq: 0 }],
    ];
    for (const ackReplay of variants)
      expect(
        await codeFor((data) => {
          data.gateway = { ...data.gateway, ackReplay };
        }),
      ).toBe("ACK_REPLAY_MISMATCH");
  });

  test("fails stale or missing active generation evidence", async () => {
    for (const activeGeneration of ["agent-host:g3", ""])
      expect(
        await codeFor((data) => {
          data.host = { ...data.host, activeGeneration };
        }),
      ).toBe("GENERATION_MISMATCH");
  });

  test("fails infrastructure fallback and runner-host or direct paths", async () => {
    expect(
      await codeFor((data) => {
        data.host = { ...data.host, infrastructureFallback: true };
      }),
    ).toBe("INFRASTRUCTURE_FALLBACK_OBSERVED");
    for (const executionPaths of [
      ["runner-host"],
      ["direct"],
      ["agent-host", "direct"],
    ])
      expect(
        await codeFor((data) => {
          data.host = { ...data.host, executionPaths };
        }),
      ).toBe("FORBIDDEN_EXECUTION_PATH");
  });

  test("rejects ambiguity outside a kill scenario", async () => {
    expect(
      await codeFor((data) => {
        data.intervention = { ...data.intervention, certainty: "ambiguous" };
      }),
    ).toBe("SCENARIO_MISMATCH");
  });

  for (const scenario of [
    "gateway-sigkill-restart",
    "host-sigkill-restart",
  ] as const) {
    test(`returns indeterminate without retry after ambiguous ${scenario}`, async () => {
      const { data, calls, probes } = fixture(scenario);
      data.intervention = { ...data.intervention, certainty: "ambiguous" };
      const result = await qualifyDetachedAgentHostCanary(scenario, probes);
      expect(result).toEqual({
        version: 1,
        scenario,
        outcome: "indeterminate",
        codes: ["AMBIGUOUS_EFFECT"],
        redacted: true,
      });
      expect(calls.submit).toBe(1);
      expect(calls.physicalStart).toBe(1);
      expect(calls.intervention).toBe(1);
      expect(calls.gatewayEvidence).toBe(0);
      expect(calls.hostEvidence).toBe(0);
    });
  }

  test("fails closed on every bounded deadline", async () => {
    for (const deadlineStep of [
      "submit",
      "physical-start",
      "intervention",
      "visible-terminal",
      "host-evidence",
      "receipts",
      "transcript",
    ] as const) {
      const { data, probes } = fixture();
      data.deadlineStep = deadlineStep;
      const result = await qualifyDetachedAgentHostCanary("normal", probes);
      expect(result.codes).toEqual(["DEADLINE_EXCEEDED"]);
      expect(result.outcome).toBe("failed");
    }
  });

  test("redacts arbitrary probe failures into fixed vocabulary", async () => {
    const { data, probes } = fixture();
    data.rejectStep = "receipts";
    const result = await qualifyDetachedAgentHostCanary("normal", probes);
    expect(result).toEqual({
      version: 1,
      scenario: "normal",
      outcome: "failed",
      codes: ["PROBE_FAILED"],
      redacted: true,
    });
    expect(JSON.stringify(result)).not.toContain("private probe detail");
  });
});
