import { decodeAgentOperationReceiptV1 } from "@tellahq/opensession-protocol/agent-operation";
import type {
  AgentAdapterReconciliationProofV1,
  AgentOperationDescriptorV1,
  AgentOperationDigest,
  AgentOperationKernelTerminalV1,
  AgentOperationKind,
  AgentOperationOutcomeV1,
  AgentOperationReceiptV1,
  AgentOperationState,
  AgentTranscriptAnchorV1,
  AgentTranscriptReceiptRefV1,
} from "@tellahq/opensession-protocol/agent-operation";
import type { AgentTurnFence } from "@tellahq/opensession-protocol/agent-host";
import type { AgentOperationAuthorizedQuery } from "./authorized-query";

export interface AgentOperationIdentity {
  operationId: string;
  kind: AgentOperationKind;
  fence: Readonly<AgentTurnFence>;
  planHash: AgentOperationDigest;
  authorityHash: AgentOperationDigest;
  supervisorEpoch: number;
  hostId: string;
  hostGeneration: number;
  hostIncarnation: string;
  transcriptAnchor: Readonly<AgentTranscriptAnchorV1>;
  toolUseEntryId?: string;
  descriptor: AgentOperationDescriptorV1;
  descriptorDigest: AgentOperationDigest;
  payloadDigest: AgentOperationDigest;
  adapterId: string;
  adapterVersion: string;
}
export type AgentOperationQuarantineReason =
  | "claim_identity_mismatch"
  | "get_identity_mismatch"
  | "transition_identity_mismatch";
export interface AgentOperationTerminalReservation {
  reservationId: string;
  reason: AgentOperationIndeterminateReason;
  reservedAtMs: number;
}
export interface AgentOperationRecord extends AgentOperationIdentity {
  receipt: AgentOperationReceiptV1;
  terminalReservation?: Readonly<AgentOperationTerminalReservation>;
  quarantineReason?: AgentOperationQuarantineReason;
}
export interface AgentOperationSettlement {
  completedAtMs: number;
  outcome: AgentOperationOutcomeV1;
  transcriptRefs: readonly AgentTranscriptReceiptRefV1[];
  kernelTerminal: Readonly<AgentOperationKernelTerminalV1>;
  providerRequestRef?: string;
  providerResponseRef?: string;
}
export type AgentOperationIndeterminateReason =
  | "reconciliation_unsupported"
  | "reconciliation_failed"
  | "ambiguous_completion"
  | "identity_mismatch"
  | "cancellation_ambiguous"
  | "timeout_ambiguous"
  | "disconnect_ambiguous";

export interface AgentOperationLedger {
  claimPrepared(
    identity: AgentOperationIdentity,
    acceptedAtMs: number,
  ): Promise<{ record: AgentOperationRecord; claimed: boolean }>;
  markExecuting(
    identity: AgentOperationIdentity,
    executingAtMs: number,
  ): Promise<AgentOperationRecord>;
  settle(
    identity: AgentOperationIdentity,
    settlement: AgentOperationSettlement,
  ): Promise<AgentOperationRecord>;
  reserveIndeterminate(
    identity: AgentOperationIdentity,
    reason: AgentOperationIndeterminateReason,
    reservedAtMs: number,
  ): Promise<Readonly<AgentOperationTerminalReservation>>;
  markIndeterminate(
    identity: AgentOperationIdentity,
    reservation: Readonly<AgentOperationTerminalReservation>,
    completedAtMs: number,
    kernelTerminal: Readonly<AgentOperationKernelTerminalV1>,
  ): Promise<AgentOperationRecord>;
  /** Both the primary key and every expected identity field are required. */
  getExact(
    identity: AgentOperationIdentity,
  ): Promise<AgentOperationRecord | undefined>;
  /**
   * Reads a durable receipt using freshly verified supervision authority.
   * Authorization mismatch is indistinguishable from absence and never mutates.
   */
  queryAuthorized(
    query: AgentOperationAuthorizedQuery,
  ): Promise<AgentOperationRecord | undefined>;
  scanActive(): Promise<AgentOperationRecord[]>;
  retireSession(sessionId: string): Promise<number>;
  deleteSession(sessionId: string): Promise<number>;
  close(): Promise<void>;
}

export class AgentOperationConflictError extends Error {
  constructor(message = "agent operation identity conflict") {
    super(message);
    this.name = "AgentOperationConflictError";
  }
}
export class AgentOperationTerminalReservedError extends Error {
  constructor() {
    super("agent operation terminal is reserved as indeterminate");
    this.name = "AgentOperationTerminalReservedError";
  }
}
export class AgentOperationNotFoundError extends Error {
  constructor() {
    super("agent operation not found for exact identity");
    this.name = "AgentOperationNotFoundError";
  }
}
export class AgentOperationTransitionError extends Error {
  constructor(current: AgentOperationState, next: AgentOperationState) {
    super(`illegal agent operation transition: ${current} -> ${next}`);
    this.name = "AgentOperationTransitionError";
  }
}
export class AgentOperationLedgerFullError extends Error {
  constructor() {
    super("agent operation ledger is full");
    this.name = "AgentOperationLedgerFullError";
  }
}
export class AgentOperationSessionActiveError extends Error {
  constructor() {
    super("cannot retire a session with active agent operations");
    this.name = "AgentOperationSessionActiveError";
  }
}

export interface ExecutingOperationReconciler {
  reconcile(record: AgentOperationRecord): Promise<
    | {
        status: "settled";
        proof: AgentAdapterReconciliationProofV1;
        settlement: AgentOperationSettlement;
      }
    | { status: "not_started"; proof: AgentAdapterReconciliationProofV1 }
    | {
        status: "indeterminate";
        reason:
          | "reconciliation_unsupported"
          | "reconciliation_failed"
          | "ambiguous_completion";
      }
  >;
}
/**
 * Recover one inherited executing operation. There is deliberately no retry path:
 * not_started proof is retained as indeterminate because executing was committed
 * before invocation and this foundation cannot roll state backward.
 */
export async function reconcileExecutingOperation(
  ledger: AgentOperationLedger,
  record: AgentOperationRecord,
  reconciler: ExecutingOperationReconciler | undefined,
  createIndeterminateTerminal: (
    record: AgentOperationRecord,
    reservation: Readonly<AgentOperationTerminalReservation>,
  ) => Promise<Readonly<AgentOperationKernelTerminalV1>>,
  completedAtMs: number,
): Promise<AgentOperationRecord> {
  if (record.receipt.state !== "executing")
    throw new AgentOperationTransitionError(
      record.receipt.state,
      "indeterminate",
    );
  const authenticateReservation = async (
    expected: Readonly<AgentOperationTerminalReservation>,
  ): Promise<
    | { terminal: AgentOperationRecord }
    | {
        record: AgentOperationRecord;
        reservation: Readonly<AgentOperationTerminalReservation>;
      }
  > => {
    const latest = await ledger.getExact(record);
    if (!latest) throw new AgentOperationNotFoundError();
    if (
      latest.receipt.state === "settled" ||
      latest.receipt.state === "indeterminate"
    )
      return { terminal: latest };
    if (
      latest.receipt.state !== "executing" ||
      !latest.terminalReservation ||
      !sameTerminalReservation(latest.terminalReservation, expected)
    )
      throw new AgentOperationConflictError(
        "agent operation terminal reservation mismatch",
      );
    return {
      record: latest,
      reservation: latest.terminalReservation,
    };
  };
  const finalizeReservation = async (
    expected: Readonly<AgentOperationTerminalReservation>,
  ): Promise<AgentOperationRecord> => {
    const authenticated = await authenticateReservation(expected);
    if ("terminal" in authenticated) return authenticated.terminal;
    try {
      // Callers bind append identity to reservationId, making restart and
      // concurrent reservation recovery destination-idempotent.
      const terminal = await createIndeterminateTerminal(
        authenticated.record,
        authenticated.reservation,
      );
      return await ledger.markIndeterminate(
        authenticated.record,
        authenticated.reservation,
        completedAtMs,
        terminal,
      );
    } catch (error) {
      const latest = await ledger.getExact(authenticated.record);
      if (latest?.receipt.state === "indeterminate") return latest;
      throw error;
    }
  };
  const failClosed = async (
    reason:
      | "reconciliation_unsupported"
      | "reconciliation_failed"
      | "ambiguous_completion",
  ): Promise<AgentOperationRecord> => {
    try {
      // This durable reservation wins terminal ownership before transcript I/O.
      // Settlement checks the same row and cannot commit once it exists.
      return await finalizeReservation(
        await ledger.reserveIndeterminate(record, reason, completedAtMs),
      );
    } catch (error) {
      const latest = await ledger.getExact(record);
      if (
        latest &&
        (latest.receipt.state === "settled" ||
          latest.receipt.state === "indeterminate")
      )
        return latest;
      throw error;
    }
  };
  // Once terminal ownership is reserved, never consult the adapter again.
  if (record.terminalReservation)
    return finalizeReservation(record.terminalReservation);
  if (!reconciler) return failClosed("reconciliation_unsupported");
  let result: unknown;
  try {
    // Snapshot once so adapter accessors/Proxies cannot change shape between
    // runtime validation and durable settlement.
    result = structuredClone(await reconciler.reconcile(record));
  } catch {
    return failClosed("reconciliation_failed");
  }
  if (!plain(result) || typeof result.status !== "string")
    return failClosed("reconciliation_failed");
  if (result.status === "settled") {
    if (
      !exact(result, ["status", "proof", "settlement"]) ||
      !proofMatches(record, result.proof) ||
      !validSettlement(record, result.settlement) ||
      !plain(result.proof) ||
      result.proof.providerRequestRef !==
        (result.settlement as AgentOperationSettlement).providerRequestRef ||
      result.proof.providerResponseRef !==
        (result.settlement as AgentOperationSettlement).providerResponseRef
    )
      return failClosed("reconciliation_failed");
    try {
      return await ledger.settle(
        record,
        result.settlement as AgentOperationSettlement,
      );
    } catch {
      return failClosed("reconciliation_failed");
    }
  }
  if (result.status === "not_started") {
    if (
      !exact(result, ["status", "proof"]) ||
      !proofMatches(record, result.proof)
    )
      return failClosed("reconciliation_failed");
    return failClosed("ambiguous_completion");
  }
  if (
    result.status === "indeterminate" &&
    exact(result, ["status", "reason"]) &&
    (result.reason === "reconciliation_unsupported" ||
      result.reason === "reconciliation_failed" ||
      result.reason === "ambiguous_completion")
  )
    return failClosed(result.reason);
  return failClosed("reconciliation_failed");
}
function sameTerminalReservation(
  a: Readonly<AgentOperationTerminalReservation>,
  b: Readonly<AgentOperationTerminalReservation>,
): boolean {
  return (
    a.reservationId === b.reservationId &&
    a.reason === b.reason &&
    a.reservedAtMs === b.reservedAtMs
  );
}
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
function proofMatches(
  record: AgentOperationRecord,
  candidate: unknown,
): candidate is AgentAdapterReconciliationProofV1 {
  if (
    !plain(candidate) ||
    !Object.keys(candidate).every((key) =>
      [
        "adapterId",
        "adapterVersion",
        "operationId",
        "kind",
        "fence",
        "planHash",
        "authorityHash",
        "descriptorDigest",
        "payloadDigest",
        "providerRequestRef",
        "providerResponseRef",
      ].includes(key),
    ) ||
    !plain(candidate.fence)
  )
    return false;
  const proof = candidate as unknown as AgentAdapterReconciliationProofV1;
  return (
    proof.adapterId === record.adapterId &&
    proof.adapterVersion === record.adapterVersion &&
    proof.operationId === record.operationId &&
    proof.kind === record.kind &&
    proof.fence.sessionId === record.fence.sessionId &&
    proof.fence.runId === record.fence.runId &&
    proof.fence.turnId === record.fence.turnId &&
    proof.fence.generation === record.fence.generation &&
    proof.planHash === record.planHash &&
    proof.authorityHash === record.authorityHash &&
    proof.descriptorDigest === record.descriptorDigest &&
    proof.payloadDigest === record.payloadDigest &&
    (proof.providerRequestRef === undefined ||
      typeof proof.providerRequestRef === "string") &&
    (proof.providerResponseRef === undefined ||
      typeof proof.providerResponseRef === "string")
  );
}
function validSettlement(
  record: AgentOperationRecord,
  candidate: unknown,
): candidate is AgentOperationSettlement {
  if (
    !plain(candidate) ||
    !Object.keys(candidate).every((key) =>
      [
        "completedAtMs",
        "outcome",
        "transcriptRefs",
        "kernelTerminal",
        "providerRequestRef",
        "providerResponseRef",
      ].includes(key),
    )
  )
    return false;
  return !!decodeAgentOperationReceiptV1({
    ...record.receipt,
    state: "settled",
    completedAtMs: candidate.completedAtMs,
    outcome: candidate.outcome,
    transcriptRefs: candidate.transcriptRefs,
    kernelTerminal: candidate.kernelTerminal,
    providerRef: {
      adapterId: record.adapterId,
      adapterVersion: record.adapterVersion,
      ...(candidate.providerRequestRef === undefined
        ? {}
        : { requestId: candidate.providerRequestRef }),
      ...(candidate.providerResponseRef === undefined
        ? {}
        : { responseId: candidate.providerResponseRef }),
    },
  });
}
