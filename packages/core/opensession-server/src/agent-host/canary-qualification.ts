export const CANARY_QUALIFICATION_SCENARIOS = [
  "normal",
  "gateway-sigkill-restart",
  "host-sigkill-restart",
  "disconnect",
  "cancellation",
  "key-rotation",
  "blue-green-drain",
] as const;

export type CanaryQualificationScenario =
  (typeof CANARY_QUALIFICATION_SCENARIOS)[number];

export type CanaryQualificationStep =
  | "submit"
  | "physical-start"
  | "intervention"
  | "visible-terminal"
  | "host-evidence"
  | "receipts"
  | "transcript";

export type CanaryQualificationCode =
  | "QUALIFIED"
  | "AMBIGUOUS_EFFECT"
  | "DEADLINE_EXCEEDED"
  | "PROBE_FAILED"
  | "SCENARIO_MISMATCH"
  | "LOGICAL_COUNT_MISMATCH"
  | "PHYSICAL_COUNT_MISMATCH"
  | "PHYSICAL_RETRY_OBSERVED"
  | "TERMINAL_RESULT_MISMATCH"
  | "RECEIPT_MISMATCH"
  | "TRANSCRIPT_MISMATCH"
  | "ACK_REPLAY_MISMATCH"
  | "GENERATION_MISMATCH"
  | "INFRASTRUCTURE_FALLBACK_OBSERVED"
  | "FORBIDDEN_EXECUTION_PATH";

export interface CanaryOperationRequest {
  readonly scenario: CanaryQualificationScenario;
  readonly effectKinds: readonly ["model", "mcp", "executor"];
  readonly executionPath: "agent-host";
  readonly allowInfrastructureFallback: false;
  readonly physicalRetryLimit: 0;
}

export interface CanaryTerminalResult {
  readonly operationId: string;
  readonly status: "completed" | "cancelled";
  readonly visible: boolean;
}

export interface CanaryAckReplaySample {
  readonly ackSeq: number;
  readonly replaySeq: number;
}

export interface CanaryGatewayEvidence {
  readonly logicalOperationCount: number;
  readonly terminalResults: readonly CanaryTerminalResult[];
  readonly ackReplay: readonly CanaryAckReplaySample[];
}

export interface CanaryPhysicalEffectEvidence {
  readonly kind: "model" | "mcp" | "executor";
  /** Identifies an independently maintained counter, not an operation ID. */
  readonly counterId: string;
  readonly count: number;
}

export interface CanaryHostEvidence {
  readonly operationId: string;
  readonly dispatchCount: number;
  readonly physicalRetryCount: number;
  readonly physicalEffects: readonly CanaryPhysicalEffectEvidence[];
  readonly executionGeneration: string;
  readonly activeGeneration: string;
  readonly infrastructureFallback: boolean;
  readonly executionPaths: readonly string[];
}

export type CanaryProcessEvent =
  | "gateway-sigkill"
  | "gateway-restarted"
  | "host-sigkill"
  | "host-restarted"
  | "transport-disconnected"
  | "transport-reconnected"
  | "cancellation-requested"
  | "cancellation-acknowledged"
  | "key-rotated"
  | "generation-draining"
  | "generation-activated"
  | "generation-drained";

export interface CanaryInterventionEvidence {
  readonly scenario: CanaryQualificationScenario;
  readonly certainty: "settled" | "ambiguous";
  readonly events: readonly CanaryProcessEvent[];
}

export interface CanaryReceiptEvidence {
  readonly kind: "transcript" | "operation" | "kernel";
  readonly operationId: string;
  readonly terminal: "completed" | "cancelled";
}

export interface CanaryTranscriptEvidence {
  readonly terminalEntries: readonly CanaryTerminalResult[];
}

export interface CanaryGatewayProbe {
  submit(
    request: CanaryOperationRequest,
  ): Promise<{ readonly operationId: string }>;
  readEvidence(operationId: string): Promise<CanaryGatewayEvidence>;
}

export interface CanaryHostProbe {
  awaitPhysicalStart(operationId: string): Promise<void>;
  readEvidence(operationId: string): Promise<CanaryHostEvidence>;
}

/** An implementation may simulate process loss. The harness never sends signals. */
export interface CanaryProcessProbe {
  applyScenario(
    scenario: CanaryQualificationScenario,
    operationId: string,
  ): Promise<CanaryInterventionEvidence>;
}

export interface CanaryReceiptProbe {
  read(operationId: string): Promise<readonly CanaryReceiptEvidence[]>;
}

export interface CanaryTranscriptProbe {
  read(operationId: string): Promise<CanaryTranscriptEvidence>;
}

export type CanaryDeadlineResult<T> =
  | { readonly status: "completed"; readonly value: T }
  | { readonly status: "deadline" };

/** Bounds each probe independently. Implementations own clocks and timers. */
export interface CanaryDeadlineProbe {
  within<T>(
    step: CanaryQualificationStep,
    task: () => Promise<T>,
  ): Promise<CanaryDeadlineResult<T>>;
}

export interface CanaryQualificationProbes {
  readonly gateway: CanaryGatewayProbe;
  readonly host: CanaryHostProbe;
  readonly process: CanaryProcessProbe;
  readonly receipts: CanaryReceiptProbe;
  readonly transcript: CanaryTranscriptProbe;
  readonly deadline: CanaryDeadlineProbe;
}

export interface CanaryQualificationReport {
  readonly version: 1;
  readonly scenario: CanaryQualificationScenario;
  readonly outcome: "qualified" | "failed" | "indeterminate";
  /** Fixed vocabulary only. Probe errors and identifiers are never copied here. */
  readonly codes: readonly CanaryQualificationCode[];
  readonly redacted: true;
}

const EXPECTED_EVENTS = Object.freeze({
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
} as const satisfies Readonly<
  Record<CanaryQualificationScenario, readonly CanaryProcessEvent[]>
>);

class QualificationFailure extends Error {
  constructor(readonly code: CanaryQualificationCode) {
    super(code);
  }
}

function fail(code: CanaryQualificationCode): never {
  throw new QualificationFailure(code);
}

function exactStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function exactTerminalStatus(
  scenario: CanaryQualificationScenario,
): "completed" | "cancelled" {
  return scenario === "cancellation" ? "cancelled" : "completed";
}

async function bounded<T>(
  deadline: CanaryDeadlineProbe,
  step: CanaryQualificationStep,
  task: () => Promise<T>,
): Promise<T> {
  const result = await deadline.within(step, task);
  if (result.status === "deadline") fail("DEADLINE_EXCEEDED");
  return result.value;
}

function validateGateway(
  evidence: CanaryGatewayEvidence,
  operationId: string,
  terminal: "completed" | "cancelled",
): void {
  if (evidence.logicalOperationCount !== 1) fail("LOGICAL_COUNT_MISMATCH");
  if (
    evidence.terminalResults.length !== 1 ||
    evidence.terminalResults[0]?.operationId !== operationId ||
    evidence.terminalResults[0]?.status !== terminal ||
    evidence.terminalResults[0]?.visible !== true
  )
    fail("TERMINAL_RESULT_MISMATCH");

  if (evidence.ackReplay.length === 0) fail("ACK_REPLAY_MISMATCH");
  let previousAck = -1;
  let previousReplay = -1;
  for (const sample of evidence.ackReplay) {
    if (
      !Number.isSafeInteger(sample.ackSeq) ||
      !Number.isSafeInteger(sample.replaySeq) ||
      sample.ackSeq < 0 ||
      sample.replaySeq < 0 ||
      sample.ackSeq < previousAck ||
      sample.replaySeq < previousReplay ||
      sample.replaySeq > sample.ackSeq
    )
      fail("ACK_REPLAY_MISMATCH");
    previousAck = sample.ackSeq;
    previousReplay = sample.replaySeq;
  }
}

function validateHost(evidence: CanaryHostEvidence, operationId: string): void {
  if (evidence.operationId !== operationId || evidence.dispatchCount !== 1)
    fail("PHYSICAL_COUNT_MISMATCH");
  if (evidence.physicalRetryCount !== 0) fail("PHYSICAL_RETRY_OBSERVED");

  const expectedKinds = ["model", "mcp", "executor"] as const;
  if (
    evidence.physicalEffects.length !== expectedKinds.length ||
    !expectedKinds.every((kind) => {
      const matches = evidence.physicalEffects.filter(
        (effect) => effect.kind === kind,
      );
      return matches.length === 1 && matches[0]?.count === 1;
    }) ||
    new Set(evidence.physicalEffects.map((effect) => effect.counterId)).size !==
      expectedKinds.length ||
    evidence.physicalEffects.some((effect) => effect.counterId.length === 0)
  )
    fail("PHYSICAL_COUNT_MISMATCH");

  if (
    evidence.activeGeneration.length === 0 ||
    evidence.executionGeneration !== evidence.activeGeneration
  )
    fail("GENERATION_MISMATCH");
  if (evidence.infrastructureFallback !== false)
    fail("INFRASTRUCTURE_FALLBACK_OBSERVED");
  if (!exactStrings(evidence.executionPaths, ["agent-host"]))
    fail("FORBIDDEN_EXECUTION_PATH");
}

function validateReceipts(
  receipts: readonly CanaryReceiptEvidence[],
  operationId: string,
  terminal: "completed" | "cancelled",
): void {
  const kinds = ["transcript", "operation", "kernel"] as const;
  if (
    receipts.length !== kinds.length ||
    !kinds.every((kind) => {
      const matches = receipts.filter((receipt) => receipt.kind === kind);
      return (
        matches.length === 1 &&
        matches[0]?.operationId === operationId &&
        matches[0]?.terminal === terminal
      );
    })
  )
    fail("RECEIPT_MISMATCH");
}

function validateTranscript(
  evidence: CanaryTranscriptEvidence,
  operationId: string,
  terminal: "completed" | "cancelled",
): void {
  if (
    evidence.terminalEntries.length !== 1 ||
    evidence.terminalEntries[0]?.operationId !== operationId ||
    evidence.terminalEntries[0]?.status !== terminal ||
    evidence.terminalEntries[0]?.visible !== true
  )
    fail("TRANSCRIPT_MISMATCH");
}

function report(
  scenario: CanaryQualificationScenario,
  outcome: CanaryQualificationReport["outcome"],
  code: CanaryQualificationCode,
): CanaryQualificationReport {
  return Object.freeze({
    version: 1,
    scenario,
    outcome,
    codes: Object.freeze([code]),
    redacted: true,
  });
}

/**
 * Runs one fail-closed qualification case. It submits exactly once and has no
 * operation retry branch. All production interaction is supplied by probes.
 */
export async function qualifyDetachedAgentHostCanary(
  scenario: CanaryQualificationScenario,
  probes: CanaryQualificationProbes,
): Promise<CanaryQualificationReport> {
  try {
    const submitted = await bounded(probes.deadline, "submit", () =>
      probes.gateway.submit({
        scenario,
        effectKinds: ["model", "mcp", "executor"],
        executionPath: "agent-host",
        allowInfrastructureFallback: false,
        physicalRetryLimit: 0,
      }),
    );
    if (!submitted.operationId) fail("LOGICAL_COUNT_MISMATCH");
    const operationId = submitted.operationId;

    await bounded(probes.deadline, "physical-start", () =>
      probes.host.awaitPhysicalStart(operationId),
    );
    const intervention = await bounded(probes.deadline, "intervention", () =>
      probes.process.applyScenario(scenario, operationId),
    );
    if (intervention.certainty === "ambiguous") {
      if (
        scenario !== "gateway-sigkill-restart" &&
        scenario !== "host-sigkill-restart"
      )
        fail("SCENARIO_MISMATCH");
      return report(scenario, "indeterminate", "AMBIGUOUS_EFFECT");
    }
    if (
      intervention.scenario !== scenario ||
      !exactStrings(intervention.events, EXPECTED_EVENTS[scenario])
    )
      fail("SCENARIO_MISMATCH");

    const terminal = exactTerminalStatus(scenario);
    const gateway = await bounded(probes.deadline, "visible-terminal", () =>
      probes.gateway.readEvidence(operationId),
    );
    validateGateway(gateway, operationId, terminal);

    const host = await bounded(probes.deadline, "host-evidence", () =>
      probes.host.readEvidence(operationId),
    );
    validateHost(host, operationId);

    const receipts = await bounded(probes.deadline, "receipts", () =>
      probes.receipts.read(operationId),
    );
    validateReceipts(receipts, operationId, terminal);

    const transcript = await bounded(probes.deadline, "transcript", () =>
      probes.transcript.read(operationId),
    );
    validateTranscript(transcript, operationId, terminal);

    return report(scenario, "qualified", "QUALIFIED");
  } catch (error) {
    return report(
      scenario,
      "failed",
      error instanceof QualificationFailure ? error.code : "PROBE_FAILED",
    );
  }
}
