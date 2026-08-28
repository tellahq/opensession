import type { AgentOperationKernelTerminalV1 } from "@tellahq/opensession-protocol/agent-operation";
import type { AgentHostCancelIntent } from "../agent-host-client";
import {
  SessionKernelActorError,
  SessionKernelQuarantinedError,
  type SessionKernelActorClient,
} from "../session-kernel/actor-client";
import {
  canonicalAgentOperationIdentity,
  canonicalAgentOperationTerminal,
  decodeAgentOperationCancellationIntent,
  decodeAgentOperationIdentity,
  decodeAgentOperationReceipt,
  type AgentOperationCancellationResult,
  type AgentOperationIdentity as ActorAgentOperationIdentity,
  type AgentOperationReceipt as ActorAgentOperationReceipt,
  type AgentOperationRequest as ActorAgentOperationRequest,
  type AgentOperationResult,
  type AgentOperationTerminal,
} from "../session-kernel/agent-operation-protocol";
import type { AgentGatewayAdmissionFacade } from "./gateway";
import type { AgentOperationCancellationFacade } from "./service";
import type { AgentOperationIdentity } from "./ledger";

export type AgentOperationKernelRejectionReason =
  | Exclude<Extract<AgentOperationResult, { accepted: false }>["reason"], "not_found">
  | Extract<AgentOperationCancellationResult, { accepted: false }>["reason"]
  | "not_found";

/** A durable actor decision rejected the exact operation. Callers must fail closed. */
export class AgentOperationKernelRejectedError extends Error {
  constructor(
    readonly operation: ActorAgentOperationRequest["op"],
    readonly reason: AgentOperationKernelRejectionReason,
  ) {
    super(`SessionKernel rejected Agent operation ${operation}: ${reason}`);
    this.name = "AgentOperationKernelRejectedError";
  }
}

/** The actor accepted a mutation but returned evidence that does not prove it. */
export class AgentOperationKernelEvidenceError extends Error {
  constructor(readonly operation: ActorAgentOperationRequest["op"], message: string) {
    super(`Invalid SessionKernel Agent operation ${operation} evidence: ${message}`);
    this.name = "AgentOperationKernelEvidenceError";
  }
}

/** A quarantined session cannot authorize, settle, query, or cancel an operation. */
export class AgentOperationKernelQuarantinedError extends Error {
  constructor(readonly sessionId: string) {
    super(`SessionKernel quarantined Agent operation session ${sessionId}`);
    this.name = "AgentOperationKernelQuarantinedError";
  }
}

/**
 * Mutation transport failure is ambiguous. This error is deliberately non-retryable:
 * replay, if desired, must be an explicit later call with the exact same request.
 */
export class AgentOperationKernelTransportError extends Error {
  readonly ambiguous = true;
  readonly retryable = false;
  constructor(
    readonly operation: ActorAgentOperationRequest["op"],
    options: { cause: unknown },
  ) {
    super(`Ambiguous SessionKernel transport while deciding Agent operation ${operation}`, options);
    this.name = "AgentOperationKernelTransportError";
  }
}

type ActorClient = Pick<SessionKernelActorClient, "decideAgentOperationAsync">;

export interface AgentOperationKernelFacades {
  readonly admission: AgentGatewayAdmissionFacade;
  readonly cancellation: AgentOperationCancellationFacade;
  readonly queryAuthorized: (
    identity: Readonly<AgentOperationIdentity>,
  ) => Promise<ActorAgentOperationReceipt | undefined>;
}

/**
 * Import-inert schema-32 adapter. Every call is one bounded actor decision; provider
 * and transcript work remains outside the actor mailbox.
 */
export class AgentOperationKernelFacade
  implements AgentGatewayAdmissionFacade, AgentOperationCancellationFacade
{
  constructor(private readonly actor: ActorClient) {}

  async admit(identity: AgentOperationIdentity): Promise<{ accepted: boolean }> {
    const request = { op: "admit", identity: actorIdentity(identity) } as const;
    const result = await this.decide(request);
    if (!result.accepted) throw rejected(request.op, result.reason);
    assertReceipt(request.op, request.identity, result.receipt);
    return { accepted: true };
  }

  async settle(
    identity: AgentOperationIdentity,
    gatewayReceiptDigest: `sha256:${string}`,
    terminal: Readonly<AgentOperationKernelTerminalV1>,
  ): Promise<void> {
    await this.terminal("settle", identity, gatewayReceiptDigest, terminal);
  }

  async indeterminate(
    identity: AgentOperationIdentity,
    gatewayReceiptDigest: `sha256:${string}`,
    terminal: Readonly<AgentOperationKernelTerminalV1>,
  ): Promise<void> {
    await this.terminal("indeterminate", identity, gatewayReceiptDigest, terminal);
  }

  async request(
    identity: AgentOperationIdentity,
    cancelId: string,
    reason: AgentHostCancelIntent["reason"],
  ): Promise<"requested" | "too_late"> {
    const request = {
      op: "cancel",
      identity: actorIdentity(identity),
      cancelId,
      reason,
    } as const;
    const result = await this.decide(request);
    if (!result.accepted) throw rejected(request.op, result.reason);
    const decodedIntent = decodeAgentOperationCancellationIntent(result.intent);
    const expected = JSON.stringify({
      identity: request.identity,
      cancelId,
      reason,
      disposition: result.intent.disposition,
    });
    const actual = decodedIntent && JSON.stringify({
      identity: decodedIntent.identity,
      cancelId: decodedIntent.cancelId,
      reason: decodedIntent.reason,
      disposition: decodedIntent.disposition,
    });
    if (actual !== expected)
      throw new AgentOperationKernelEvidenceError("cancel", "intent mismatch");
    return result.intent.disposition;
  }

  async queryAuthorized(
    identity: Readonly<AgentOperationIdentity>,
  ): Promise<ActorAgentOperationReceipt | undefined> {
    const request = { op: "query", identity: actorIdentity(identity) } as const;
    const result = await this.decide(request);
    if (!result.accepted) {
      if (result.reason === "not_found") return undefined;
      throw rejected(request.op, result.reason);
    }
    assertReceipt(request.op, request.identity, result.receipt);
    return result.receipt;
  }

  asFacades(): AgentOperationKernelFacades {
    return Object.freeze({
      admission: this,
      cancellation: this,
      queryAuthorized: this.queryAuthorized.bind(this),
    });
  }

  private async terminal(
    op: "settle" | "indeterminate",
    identity: AgentOperationIdentity,
    gatewayReceiptDigest: `sha256:${string}`,
    terminal: Readonly<AgentOperationKernelTerminalV1>,
  ): Promise<void> {
    if (
      (identity.kind === "model" && terminal.pendingToolUseEntryIds === undefined) ||
      (identity.kind === "mcp" && terminal.pendingToolUseEntryIds !== undefined)
    )
      throw new AgentOperationKernelEvidenceError(op, "invalid pending tool evidence");
    const request: AgentOperationTerminal = {
      op,
      identity: actorIdentity(identity),
      gatewayReceiptDigest,
      outputDigest: terminal.outputDigest,
      outcomeCode: terminal.outcomeCode,
      transcriptReceipts: terminal.transcriptRefs,
      ...(identity.kind === "model"
        ? { pendingToolUseEntryIds: terminal.pendingToolUseEntryIds! }
        : {}),
    };
    const result = await this.decide(request);
    if (!result.accepted) throw rejected(op, result.reason);
    assertReceipt(op, request.identity, result.receipt);
    if (result.receipt.state !== opState(op))
      throw new AgentOperationKernelEvidenceError(op, "terminal state mismatch");
    const replay: AgentOperationTerminal = {
      op,
      identity: result.receipt.identity,
      gatewayReceiptDigest: result.receipt.gatewayReceiptDigest!,
      outputDigest: result.receipt.outputDigest!,
      outcomeCode: result.receipt.outcomeCode!,
      transcriptReceipts: result.receipt.transcriptReceipts!,
      ...(identity.kind === "model"
        ? { pendingToolUseEntryIds: result.receipt.pendingToolUseEntryIds! }
        : {}),
    };
    if (
      canonicalAgentOperationTerminal(request) !==
      canonicalAgentOperationTerminal(replay)
    )
      throw new AgentOperationKernelEvidenceError(op, "terminal evidence mismatch");
  }

  private async decide<T extends ActorAgentOperationRequest>(request: T) {
    try {
      return await this.actor.decideAgentOperationAsync(request);
    } catch (error) {
      if (error instanceof AgentOperationKernelRejectedError ||
          error instanceof AgentOperationKernelEvidenceError ||
          error instanceof AgentOperationKernelQuarantinedError ||
          error instanceof AgentOperationKernelTransportError)
        throw error;
      if (error instanceof SessionKernelQuarantinedError)
        throw new AgentOperationKernelQuarantinedError(error.sessionId);
      // Even a retryable-labelled actor error is ambiguous for schema-32 commands.
      if (error instanceof SessionKernelActorError || error instanceof Error)
        throw new AgentOperationKernelTransportError(request.op, { cause: error });
      throw new AgentOperationKernelTransportError(request.op, { cause: error });
    }
  }
}

export function createAgentOperationKernelFacades(
  actor: ActorClient,
): AgentOperationKernelFacades {
  return new AgentOperationKernelFacade(actor).asFacades();
}

function actorIdentity(identity: Readonly<AgentOperationIdentity>): ActorAgentOperationIdentity {
  const mapped = decodeAgentOperationIdentity({
    sessionId: identity.fence.sessionId,
    runId: identity.fence.runId,
    turnId: identity.fence.turnId,
    generation: identity.fence.generation,
    operationId: identity.operationId,
    kind: identity.kind,
    descriptorDigest: identity.descriptorDigest,
    payloadDigest: identity.payloadDigest,
    adapterId: identity.adapterId,
    adapterVersion: identity.adapterVersion,
    authorityHash: identity.authorityHash,
    supervisorEpoch: identity.supervisorEpoch,
    planHash: identity.planHash,
    hostId: identity.hostId,
    hostGeneration: identity.hostGeneration,
    hostIncarnation: identity.hostIncarnation,
    transcriptAnchor: identity.transcriptAnchor,
    ...(identity.kind === "mcp" ? { toolUseEntryId: identity.toolUseEntryId } : {}),
  });
  if (!mapped)
    throw new AgentOperationKernelEvidenceError("admit", "invalid gateway identity");
  return mapped;
}

function assertReceipt(
  op: ActorAgentOperationRequest["op"],
  identity: ActorAgentOperationIdentity,
  receipt: ActorAgentOperationReceipt,
): void {
  const decoded = decodeAgentOperationReceipt(receipt);
  if (!decoded || JSON.stringify(decoded) !== JSON.stringify(receipt))
    throw new AgentOperationKernelEvidenceError(op, "malformed receipt");
  if (
    canonicalAgentOperationIdentity(identity) !==
    canonicalAgentOperationIdentity(decoded.identity)
  )
    throw new AgentOperationKernelEvidenceError(op, "identity mismatch");
}

function rejected(
  operation: ActorAgentOperationRequest["op"],
  reason: AgentOperationKernelRejectionReason,
) {
  return new AgentOperationKernelRejectedError(operation, reason);
}

function opState(op: "settle" | "indeterminate") {
  return op === "settle" ? "settled" : "indeterminate";
}
