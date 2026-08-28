import type {
  CanaryDeadlineProbe,
  CanaryGatewayEvidence,
  CanaryHostEvidence,
  CanaryInterventionEvidence,
  CanaryOperationRequest,
  CanaryQualificationProbes,
  CanaryQualificationScenario,
  CanaryQualificationStep,
  CanaryReceiptEvidence,
  CanaryTranscriptEvidence,
} from "./canary-qualification";

type MaybePromise<T> = T | Promise<T>;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export interface CanaryProductionGatewayOwner {
  submit(request: CanaryOperationRequest, signal: AbortSignal): MaybePromise<{ readonly operationId: string }>;
  readEvidence(operationId: string, signal: AbortSignal): MaybePromise<CanaryGatewayEvidence>;
}

export interface CanaryGenerationTransitionEvidence {
  readonly drainingGeneration: string;
  readonly admissionGeneration: string;
  readonly oldTerminalDurable: true;
  readonly oldDrainedAfterTerminal: true;
}

export interface CanaryProductionHostEvidence extends Omit<CanaryHostEvidence, "physicalEffects"> {
  readonly scenario: CanaryQualificationScenario;
  readonly fenceDigest: string;
  /** Required only for blue-green-drain. */
  readonly generationTransition?: CanaryGenerationTransitionEvidence;
}

export interface CanaryProductionHostOwner {
  awaitPhysicalStart(operationId: string, signal: AbortSignal): MaybePromise<void>;
  readEvidence(operationId: string, signal: AbortSignal): MaybePromise<CanaryProductionHostEvidence>;
}

export interface CanaryProductionProcessOwner {
  applyScenario(scenario: CanaryQualificationScenario, operationId: string, signal: AbortSignal): MaybePromise<CanaryInterventionEvidence>;
}
export interface CanaryDurableOperationBinding {
  readonly operationId: string;
  readonly fenceDigest: string;
  readonly receiptDigest: string;
  readonly terminalDurable: true;
}
export interface CanaryProductionReceiptOwner {
  read(operationId: string, signal: AbortSignal): MaybePromise<readonly CanaryReceiptEvidence[]>;
  readDurableBinding(operationId: string, signal: AbortSignal): MaybePromise<CanaryDurableOperationBinding>;
}
export interface CanaryProductionTranscriptOwner {
  read(operationId: string, signal: AbortSignal): MaybePromise<CanaryTranscriptEvidence>;
}

export interface CanaryDurablePhysicalCount {
  readonly operationId: string;
  readonly fenceDigest: string;
  readonly receiptDigest: string;
  readonly durable: true;
  readonly count: number;
}

export interface CanaryPhysicalAccountingDomain {
  /** Stable organization-controlled domain identity. Never included in reports. */
  readonly domainId: string;
  readDurableCount(operationId: string, signal: AbortSignal): MaybePromise<CanaryDurablePhysicalCount>;
}

export interface CanaryProductionProbeOwners {
  readonly gateway: CanaryProductionGatewayOwner;
  readonly host: CanaryProductionHostOwner;
  readonly process: CanaryProductionProcessOwner;
  readonly receipts: CanaryProductionReceiptOwner;
  readonly transcript: CanaryProductionTranscriptOwner;
  readonly accounting: Readonly<{
    model: CanaryPhysicalAccountingDomain;
    mcp: CanaryPhysicalAccountingDomain;
    executor: CanaryPhysicalAccountingDomain;
  }>;
  /** Per-step deadline, clamped to 1..30 seconds. */
  readonly deadlineMs?: number;
}

const MAX_DEADLINE_MS = 30_000;
const DEFAULT_DEADLINE_MS = 5_000;
function boundedDeadline(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_DEADLINE_MS;
  return Math.min(MAX_DEADLINE_MS, Math.max(1, Math.trunc(value!)));
}
function validDomainId(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}
function independentAccounting(accounting: CanaryProductionProbeOwners["accounting"]): boolean {
  const domains = [accounting.model, accounting.mcp, accounting.executor];
  return new Set(domains).size === domains.length && domains.every((domain) => validDomainId(domain.domainId)) &&
    new Set(domains.map((domain) => domain.domainId)).size === domains.length;
}
function validCount(
  proof: CanaryDurablePhysicalCount,
  operationId: string,
  fenceDigest: string,
  receiptDigest: string,
): boolean {
  return proof?.durable === true && proof.operationId === operationId &&
    proof.fenceDigest === fenceDigest && proof.receiptDigest === receiptDigest &&
    Number.isSafeInteger(proof.count) && proof.count >= 0;
}
function verifyGeneration(
  scenario: CanaryQualificationScenario,
  host: CanaryProductionHostEvidence,
): string {
  if (scenario !== "blue-green-drain") {
    if (host.generationTransition !== undefined || host.executionGeneration !== host.activeGeneration)
      throw new Error("Generation evidence mismatch");
    return host.activeGeneration;
  }
  const transition = host.generationTransition;
  if (!transition || transition.drainingGeneration !== host.executionGeneration ||
      transition.admissionGeneration !== host.activeGeneration ||
      transition.admissionGeneration === transition.drainingGeneration ||
      transition.oldTerminalDurable !== true || transition.oldDrainedAfterTerminal !== true)
    throw new Error("Blue-green generation evidence mismatch");
  // The generic harness compares these fields. After proving the transition,
  // project the old turn's pinned generation as its own qualification fence.
  return host.executionGeneration;
}

interface StepContext { readonly signal: AbortSignal }

/** Import-inert adapter over organization-controlled production evidence owners. */
export function createCanaryProductionProbes(
  owners: Readonly<CanaryProductionProbeOwners>,
): CanaryQualificationProbes {
  const contexts = new Map<CanaryQualificationStep, StepContext>();
  let submitted: { readonly operationId: string; readonly scenario: CanaryQualificationScenario } | undefined;
  const context = (step: CanaryQualificationStep): StepContext => {
    const value = contexts.get(step);
    if (!value) throw new Error("Canary production probe called outside its bounded step");
    return value;
  };
  const deadline: CanaryDeadlineProbe = {
    async within<T>(step: CanaryQualificationStep, task: () => Promise<T>) {
      if (contexts.has(step)) throw new Error("Concurrent canary qualification step");
      const controller = new AbortController();
      contexts.set(step, Object.freeze({ signal: controller.signal }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const expired = new Promise<{ readonly status: "deadline" }>((resolve) => {
          timer = setTimeout(() => { controller.abort(); resolve({ status: "deadline" }); }, boundedDeadline(owners.deadlineMs));
        });
        return await Promise.race([
          Promise.resolve().then(task).then((value) => ({ status: "completed" as const, value })),
          expired,
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        contexts.delete(step);
      }
    },
  };

  const probes: CanaryQualificationProbes = {
    deadline,
    gateway: {
      async submit(request: CanaryOperationRequest) {
        if (submitted) throw new Error("A canary qualification is already active");
        const result = await owners.gateway.submit(request, context("submit").signal);
        if (result.operationId) submitted = Object.freeze({ operationId: result.operationId, scenario: request.scenario });
        return result;
      },
      async readEvidence(operationId: string) {
        return owners.gateway.readEvidence(operationId, context("visible-terminal").signal);
      },
    },
    host: {
      async awaitPhysicalStart(operationId: string) {
        await owners.host.awaitPhysicalStart(operationId, context("physical-start").signal);
      },
      async readEvidence(operationId: string): Promise<CanaryHostEvidence> {
        const signal = context("host-evidence").signal;
        const expected = submitted;
        submitted = undefined;
        if (!expected || expected.operationId !== operationId || !independentAccounting(owners.accounting))
          throw new Error("Missing qualification or independent physical accounting domains");
        const [host, binding, model, mcp, executor] = await Promise.all([
          owners.host.readEvidence(operationId, signal),
          owners.receipts.readDurableBinding(operationId, signal),
          owners.accounting.model.readDurableCount(operationId, signal),
          owners.accounting.mcp.readDurableCount(operationId, signal),
          owners.accounting.executor.readDurableCount(operationId, signal),
        ]);
        if (binding?.terminalDurable !== true || binding.operationId !== operationId ||
            !DIGEST.test(binding.fenceDigest) || !DIGEST.test(binding.receiptDigest) ||
            host.operationId !== operationId || host.fenceDigest !== binding.fenceDigest ||
            ![model, mcp, executor].every((proof) =>
              validCount(proof, operationId, binding.fenceDigest, binding.receiptDigest)))
          throw new Error("Physical accounting proof is not durable or bound to the operation");
        if (host.scenario !== expected.scenario) throw new Error("Qualification scenario evidence mismatch");
        const projectedGeneration = verifyGeneration(expected.scenario, host);
        return Object.freeze({
          operationId: host.operationId,
          dispatchCount: host.dispatchCount,
          physicalRetryCount: host.physicalRetryCount,
          executionGeneration: host.executionGeneration,
          activeGeneration: projectedGeneration,
          infrastructureFallback: host.infrastructureFallback,
          executionPaths: host.executionPaths,
          physicalEffects: Object.freeze([
            Object.freeze({ kind: "model", counterId: "organization:model", count: model.count }),
            Object.freeze({ kind: "mcp", counterId: "organization:mcp", count: mcp.count }),
            Object.freeze({ kind: "executor", counterId: "organization:executor", count: executor.count }),
          ]),
        });
      },
    },
    process: {
      async applyScenario(scenario: CanaryQualificationScenario, operationId: string) {
        return owners.process.applyScenario(scenario, operationId, context("intervention").signal);
      },
    },
    receipts: { async read(operationId: string) { return owners.receipts.read(operationId, context("receipts").signal); } },
    transcript: { async read(operationId: string) { return owners.transcript.read(operationId, context("transcript").signal); } },
  };
  return Object.freeze(probes);
}
