import {
  decodeAgentOperationRequestV1,
  hashAgentMcpArgumentsV1,
  hashAgentMcpPayloadV1,
  hashAgentModelPayloadV1,
  hashAgentOperationDescriptorV1,
  hashAgentOperationReceiptV1,
  type AgentOperationDigest,
  type AgentOperationKernelTerminalV1,
  type AgentOperationOutcomeV1,
  type AgentOperationRequestV1,
  type AgentTranscriptReceiptRefV1,
} from "@tellahq/opensession-protocol/agent-operation";
import type { AgentHostSupervisionAuthorityV2 } from "@tellahq/opensession-protocol/agent-host";
import type { SignedAgentHostSupervisionEnvelopeV1 } from "@tellahq/opensession-protocol/agent-host-supervision";
import {
  type AgentGatewayGrantExpectation,
  type AgentGatewayGrantRegistry,
} from "./grants";
import {
  AgentOperationConflictError,
  type AgentOperationIdentity,
  type AgentOperationIndeterminateReason,
  type AgentOperationLedger,
  type AgentOperationRecord,
  type AgentOperationSettlement,
  type AgentOperationTerminalReservation,
  type ExecutingOperationReconciler,
  reconcileExecutingOperation,
} from "./ledger";

export type AgentGatewayFailpoint =
  | "after_admission"
  | "after_prepared"
  | "after_executing"
  | "after_transcript_append"
  | "after_ledger_settlement"
  | "after_schema_settlement";

export interface VerifiedAgentSupervision {
  readonly authority: AgentHostSupervisionAuthorityV2;
  readonly authorityHash: AgentOperationDigest;
}
export interface AgentGatewayAdmissionFacade {
  admit(identity: AgentOperationIdentity): Promise<{ accepted: boolean }>;
  settle(
    identity: AgentOperationIdentity,
    gatewayReceiptDigest: AgentOperationDigest,
    terminal: Readonly<AgentOperationKernelTerminalV1>,
  ): Promise<void>;
  indeterminate(
    identity: AgentOperationIdentity,
    gatewayReceiptDigest: AgentOperationDigest,
    terminal: Readonly<AgentOperationKernelTerminalV1>,
  ): Promise<void>;
}
export interface AgentGatewayAdapterResult {
  readonly outcome: AgentOperationOutcomeV1;
  /** Ephemeral material consumed by the transcript appender, never persisted. */
  readonly transcript: unknown;
  readonly providerRequestRef?: string;
  readonly providerResponseRef?: string;
}
export interface AgentGatewayLiveEventSink {
  publish(event: Readonly<unknown>): Promise<void>;
  /** Flushes the bounded stream and returns opaque transport evidence. */
  close(): Promise<unknown>;
  fail(reason: unknown): Promise<void>;
}
export interface AgentGatewayAdapter {
  readonly id: string;
  readonly version: string;
  execute(
    request: Readonly<{
      identity: Readonly<AgentOperationIdentity>;
      payload: unknown;
    }>,
    signal: AbortSignal,
    sink?: AgentGatewayLiveEventSink,
  ): Promise<AgentGatewayAdapterResult>;
}
export type AgentGatewayDecodedPayload =
  | Readonly<{
      kind: "model";
      value: unknown;
      canonicalBytes: Uint8Array;
      /** Trusted decoders may retain an already-validated immutable private capability. */
      retainValueIdentity?: true;
    }>
  | Readonly<{
      kind: "mcp";
      value: unknown;
      canonicalBytes: Uint8Array;
      canonicalArgumentsBytes: Uint8Array;
    }>;
export interface AgentGatewayTranscriptTerminal {
  readonly refs: readonly AgentTranscriptReceiptRefV1[];
  readonly kernelTerminal: Readonly<AgentOperationKernelTerminalV1>;
}
export interface AgentOperationGatewayOptions {
  readonly ledger: AgentOperationLedger;
  readonly grants: AgentGatewayGrantRegistry;
  readonly verifySupervision: (
    envelope: SignedAgentHostSupervisionEnvelopeV1,
    request: AgentOperationRequestV1,
  ) => Promise<VerifiedAgentSupervision | undefined>;
  readonly admission: AgentGatewayAdmissionFacade;
  readonly adapterFor: (
    request: AgentOperationRequestV1,
  ) => AgentGatewayAdapter | undefined;
  /** Strictly decodes one raw snapshot into an immutable adapter value and canonical bytes. */
  readonly decodePayload: (
    kind: "model" | "mcp",
    payload: unknown,
    request: Readonly<AgentOperationRequestV1>,
  ) => AgentGatewayDecodedPayload | undefined;
  /** Required for MCP, whose descriptor intentionally does not carry a transcript anchor. */
  readonly resolveTranscriptAnchor?: (
    request: AgentOperationRequestV1,
    toolUseEntryId: string,
  ) =>
    | AgentOperationIdentity["transcriptAnchor"]
    | undefined
    | Promise<AgentOperationIdentity["transcriptAnchor"] | undefined>;
  readonly appendTerminal: (
    identity: AgentOperationIdentity,
    result: AgentGatewayAdapterResult,
  ) => Promise<AgentGatewayTranscriptTerminal>;
  readonly appendIndeterminateNotice: (
    record: AgentOperationRecord,
    appendId: string,
  ) => Promise<AgentOperationKernelTerminalV1>;
  /** Optional and production-unwired. Resolves only after Host transport acknowledgement. */
  readonly beginLiveExecution?: (
    record: AgentOperationRecord,
  ) => Promise<AgentGatewayLiveEventSink>;
  readonly reconcilerFor?: (
    record: AgentOperationRecord,
  ) => ExecutingOperationReconciler | undefined;
  readonly now?: () => number;
  readonly failpoint?: (
    point: AgentGatewayFailpoint,
    record: AgentOperationRecord,
  ) => void | Promise<void>;
}

/** Import-inert coordinator. It owns no sockets, timers, listeners, or credentials. */
export class AgentOperationGateway {
  readonly #options: AgentOperationGatewayOptions;
  readonly #mailboxes = new Map<string, Promise<unknown>>();
  constructor(options: AgentOperationGatewayOptions) {
    this.#options = options;
  }

  dispatch(
    rawRequest: unknown,
    payload: unknown,
    signal = new AbortController().signal,
  ) {
    const request = decodeAgentOperationRequestV1(rawRequest);
    if (!request)
      return Promise.reject(new AgentGatewayRequestError("invalid request"));
    return this.#serialize(keyForRequest(request), () =>
      this.#dispatch(request, payload, signal),
    );
  }

  async recoverActive(): Promise<{
    prepared: AgentOperationRecord[];
    recovered: AgentOperationRecord[];
  }> {
    const active = await this.#options.ledger.scanActive();
    const prepared: AgentOperationRecord[] = [];
    const recovered: AgentOperationRecord[] = [];
    await Promise.all(
      active.map((record) =>
        this.#serialize(keyFor(record), async () => {
          if (record.receipt.state === "prepared") {
            // Payloads and bearer grants are intentionally not durable. A fresh dispatch
            // must reauthorize this record before it can become executing.
            prepared.push(record);
            return;
          }
          if (record.receipt.state !== "executing") return;
          const terminal = await reconcileExecutingOperation(
            this.#options.ledger,
            record,
            this.#options.reconcilerFor?.(record),
            async (authenticated, reservation) =>
              this.#options.appendIndeterminateNotice(
                authenticated,
                indeterminateAppendId(
                  authenticated.operationId,
                  reservation.reservationId,
                ),
              ),
            this.#now(),
          );
          if (
            terminal.receipt.state !== "settled" &&
            terminal.receipt.state !== "indeterminate"
          )
            throw new AgentOperationConflictError(
              "recovery did not reach terminal state",
            );
          await this.#settleActor(terminal);
          recovered.push(terminal);
        }),
      ),
    );
    return { prepared, recovered };
  }

  async #dispatch(
    request: AgentOperationRequestV1,
    payload: unknown,
    signal: AbortSignal,
  ) {
    const verified = await this.#options.verifySupervision(
      request.supervisionEnvelope,
      request,
    );
    if (!verified)
      throw new AgentGatewayAuthorizationError("invalid supervision");
    const descriptorDigest = await hashAgentOperationDescriptorV1(
      request.descriptor,
    );
    if (descriptorDigest !== request.descriptorDigest)
      throw new AgentGatewayAuthorizationError("descriptor digest mismatch");
    let decoded: AgentGatewayDecodedPayload | undefined;
    try {
      decoded = this.#options.decodePayload(request.kind, payload, request);
    } catch {
      throw new AgentGatewayRequestError("invalid payload");
    }
    if (
      !decoded ||
      decoded.kind !== request.kind ||
      !(decoded.canonicalBytes instanceof Uint8Array) ||
      (decoded.kind === "mcp" &&
        !(decoded.canonicalArgumentsBytes instanceof Uint8Array))
    )
      throw new AgentGatewayRequestError("invalid payload decoding");
    let adapterPayload: unknown;
    try {
      adapterPayload =
        decoded.kind === "model" && decoded.retainValueIdentity
          ? validateDecodedValue(decoded.value)
          : snapshotDecodedValue(decoded.value);
    } catch {
      throw new AgentGatewayRequestError("invalid decoded payload");
    }
    const payloadBytes = decoded.canonicalBytes.slice();
    const payloadDigest =
      request.kind === "model"
        ? await hashAgentModelPayloadV1(payloadBytes)
        : await hashAgentMcpPayloadV1(payloadBytes);
    if (request.kind === "mcp") {
      if (decoded.kind !== "mcp" || request.descriptor.kind !== "mcp")
        throw new AgentGatewayRequestError("invalid MCP payload decoding");
      const argumentsDigest = await hashAgentMcpArgumentsV1(
        decoded.canonicalArgumentsBytes.slice(),
      );
      if (argumentsDigest !== request.descriptor.argumentsDigest)
        throw new AgentGatewayAuthorizationError("arguments digest mismatch");
    }
    const authority = verified.authority;
    if (!sameFence(request.fence, authority.fence))
      throw new AgentGatewayAuthorizationError("supervision fence mismatch");
    const adapter = this.#options.adapterFor(request);
    if (!adapter)
      throw new AgentGatewayAuthorizationError("adapter unavailable");
    const transcriptAnchor =
      request.descriptor.kind === "model"
        ? request.descriptor.transcript
        : await this.#options.resolveTranscriptAnchor?.(
            request,
            request.descriptor.toolUseEntryId,
          );
    if (!transcriptAnchor)
      throw new AgentGatewayRequestError("missing transcript anchor");
    const identity = this.#provisionalIdentity(
      request,
      verified,
      payloadDigest,
      transcriptAnchor,
      adapter.id,
      adapter.version,
    );
    const authorization = this.#options.grants.authorize(
      request.dispatchGrant,
      grantExpectation(identity),
    );
    if (!authorization.authorized)
      throw new AgentGatewayAuthorizationError(authorization.reason);

    const existing = await this.#options.ledger.getExact(identity);
    if (
      existing?.receipt.state === "settled" ||
      existing?.receipt.state === "indeterminate"
    ) {
      await this.#settleActor(existing);
      return existing;
    }
    const admitted = await this.#options.admission.admit(identity);
    if (!admitted.accepted) throw new AgentGatewayAdmissionError();
    await this.#hit("after_admission", existing ?? synthetic(identity));
    const claim = await this.#options.ledger.claimPrepared(
      identity,
      this.#now(),
    );
    await this.#hit("after_prepared", claim.record);
    if (claim.record.receipt.state !== "prepared") {
      if (claim.record.receipt.state === "executing")
        throw new AgentGatewayInheritedExecutionError();
      await this.#settleActor(claim.record);
      return claim.record;
    }
    const executing = await this.#options.ledger.markExecuting(
      identity,
      this.#now(),
    );
    await this.#hit("after_executing", executing);
    let sink: AgentGatewayLiveEventSink | undefined;
    try {
      if (this.#options.beginLiveExecution) {
        let liveSink: AgentGatewayLiveEventSink;
        try {
          liveSink = await this.#options.beginLiveExecution(executing);
        } catch {
          throw new AgentGatewayAmbiguousExecutionError("disconnect_ambiguous");
        }
        sink = guardedLiveEventSink(liveSink);
      }
      const result = await adapter.execute(
        Object.freeze({ identity, payload: adapterPayload }),
        signal,
        sink,
      );
      await sink?.close();
      const appended = await this.#options.appendTerminal(identity, result);
      await this.#hit("after_transcript_append", executing);
      const settlement: AgentOperationSettlement = {
        completedAtMs: this.#now(),
        outcome: result.outcome,
        transcriptRefs: appended.refs,
        kernelTerminal: appended.kernelTerminal,
        ...(result.providerRequestRef === undefined
          ? {}
          : { providerRequestRef: result.providerRequestRef }),
        ...(result.providerResponseRef === undefined
          ? {}
          : { providerResponseRef: result.providerResponseRef }),
      };
      const settled = await this.#options.ledger.settle(identity, settlement);
      await this.#hit("after_ledger_settlement", settled);
      await this.#settleActor(settled);
      await this.#hit("after_schema_settlement", settled);
      return settled;
    } catch (error) {
      const ambiguity =
        error instanceof AgentGatewayAmbiguousExecutionError
          ? error
          : undefined;
      if (!ambiguity) throw error;
      try {
        await sink?.fail(ambiguity);
      } catch {
        // The durable terminal reservation, not best-effort stream cleanup, owns settlement.
      }
      return this.#settleAmbiguous(executing, ambiguity.reason);
    }
  }

  async #settleAmbiguous(
    executing: AgentOperationRecord,
    reason: AgentOperationIndeterminateReason,
  ) {
    const reservation = await this.#options.ledger.reserveIndeterminate(
      executing,
      reason,
      this.#now(),
    );
    const authenticated = await this.#options.ledger.getExact(executing);
    if (
      !authenticated ||
      authenticated.receipt.state !== "executing" ||
      !authenticated.terminalReservation ||
      !sameReservation(authenticated.terminalReservation, reservation)
    )
      throw new AgentOperationConflictError(
        "agent operation terminal reservation mismatch",
      );
    const terminal = await this.#options.appendIndeterminateNotice(
      authenticated,
      indeterminateAppendId(
        authenticated.operationId,
        authenticated.terminalReservation.reservationId,
      ),
    );
    const settled = await this.#options.ledger.markIndeterminate(
      authenticated,
      authenticated.terminalReservation,
      this.#now(),
      terminal,
    );
    await this.#settleActor(settled);
    return settled;
  }

  #provisionalIdentity(
    request: AgentOperationRequestV1,
    verified: VerifiedAgentSupervision,
    payloadDigest: AgentOperationDigest,
    transcriptAnchor: AgentOperationIdentity["transcriptAnchor"],
    adapterId: string,
    adapterVersion: string,
  ): AgentOperationIdentity {
    const authority = verified.authority;
    return {
      operationId: request.operationId,
      kind: request.kind,
      fence: request.fence,
      planHash: authority.planHash as AgentOperationDigest,
      authorityHash: verified.authorityHash,
      supervisorEpoch: authority.supervisorEpoch,
      hostId: authority.hostId,
      hostGeneration: authority.hostGeneration,
      hostIncarnation: authority.hostIncarnation,
      transcriptAnchor,
      ...(request.descriptor.kind === "mcp"
        ? { toolUseEntryId: request.descriptor.toolUseEntryId }
        : {}),
      descriptor: request.descriptor,
      descriptorDigest: request.descriptorDigest,
      payloadDigest,
      adapterId,
      adapterVersion,
    };
  }

  async #settleActor(record: AgentOperationRecord) {
    const terminal = record.receipt.kernelTerminal;
    if (!terminal)
      throw new AgentOperationConflictError("terminal actor evidence missing");
    const digest = await hashAgentOperationReceiptV1(record.receipt);
    if (record.receipt.state === "settled")
      await this.#options.admission.settle(record, digest, terminal);
    else if (record.receipt.state === "indeterminate")
      await this.#options.admission.indeterminate(record, digest, terminal);
  }
  #now() {
    const now = (this.#options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new TypeError("invalid gateway clock");
    return now;
  }
  async #hit(point: AgentGatewayFailpoint, record: AgentOperationRecord) {
    await this.#options.failpoint?.(point, record);
  }
  #serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prior = this.#mailboxes.get(key) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(work);
    this.#mailboxes.set(key, next);
    void next
      .finally(() => {
        if (this.#mailboxes.get(key) === next) this.#mailboxes.delete(key);
      })
      .catch(() => undefined);
    return next;
  }
}

function validateDecodedValue(value: unknown): unknown {
  immutableSnapshot(value);
  // structuredClone rejects Proxy objects. Run it only after the descriptor walk,
  // which rejects accessors without invoking them.
  structuredClone(value);
  return value;
}

function snapshotDecodedValue(value: unknown): unknown {
  validateDecodedValue(value);
  return immutableSnapshot(value);
}

function immutableSnapshot(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype)
      throw new TypeError("invalid decoded payload array");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some((key) => typeof key !== "string") ||
      keys.length !== value.length + 1
    )
      throw new TypeError("invalid decoded payload array");
    const snapshot = Array.from({ length: value.length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        throw new TypeError("invalid decoded payload array");
      return immutableSnapshot(descriptor.value);
    });
    return Object.freeze(snapshot);
  }
  if (typeof value !== "object")
    throw new TypeError("invalid decoded payload value");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError("invalid decoded payload object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string")
      throw new TypeError("invalid decoded payload object");
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      descriptor.value === undefined ||
      /^(?:__proto__|prototype|constructor)$/.test(key)
    )
      throw new TypeError("invalid decoded payload object");
    snapshot[key] = immutableSnapshot(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function grantExpectation(
  identity: AgentOperationIdentity,
): AgentGatewayGrantExpectation {
  return {
    operationId: identity.operationId,
    kind: identity.kind,
    fence: identity.fence,
    planHash: identity.planHash,
    authorityHash: identity.authorityHash,
    supervisorEpoch: identity.supervisorEpoch,
    hostId: identity.hostId,
    hostGeneration: identity.hostGeneration,
    hostIncarnation: identity.hostIncarnation,
    descriptorDigest: identity.descriptorDigest,
    payloadDigest: identity.payloadDigest,
    transcriptAnchor: identity.transcriptAnchor,
    ...(identity.kind === "mcp"
      ? { toolUseEntryId: identity.toolUseEntryId! }
      : {}),
    adapterId: identity.adapterId,
    adapterVersion: identity.adapterVersion,
  };
}
function sameFence(
  a: AgentOperationRequestV1["fence"],
  b: AgentOperationRequestV1["fence"],
) {
  return (
    a.sessionId === b.sessionId &&
    a.runId === b.runId &&
    a.turnId === b.turnId &&
    a.generation === b.generation
  );
}
function keyForRequest(request: AgentOperationRequestV1) {
  return `${request.fence.sessionId}\0${request.operationId}`;
}
function keyFor(record: AgentOperationRecord) {
  return `${record.fence.sessionId}\0${record.operationId}`;
}
function sameReservation(
  a: Readonly<AgentOperationTerminalReservation>,
  b: Readonly<AgentOperationTerminalReservation>,
) {
  return (
    a.reservationId === b.reservationId &&
    a.reason === b.reason &&
    a.reservedAtMs === b.reservedAtMs
  );
}
function guardedLiveEventSink(
  sink: AgentGatewayLiveEventSink,
): AgentGatewayLiveEventSink {
  let closed = false;
  let failed = false;
  return Object.freeze({
    async publish(event: Readonly<unknown>) {
      if (closed)
        throw new AgentGatewayAmbiguousExecutionError("disconnect_ambiguous");
      try {
        await sink.publish(event);
      } catch {
        closed = true;
        throw new AgentGatewayAmbiguousExecutionError("disconnect_ambiguous");
      }
    },
    async close() {
      if (closed)
        throw new AgentGatewayAmbiguousExecutionError("disconnect_ambiguous");
      closed = true;
      try {
        return await sink.close();
      } catch {
        throw new AgentGatewayAmbiguousExecutionError("disconnect_ambiguous");
      }
    },
    async fail(reason: unknown) {
      if (failed) return;
      failed = true;
      closed = true;
      await sink.fail(reason);
    },
  });
}
function indeterminateAppendId(operationId: string, reservationId: string) {
  return `agent-indeterminate:${operationId}:${reservationId}`;
}
function synthetic(identity: AgentOperationIdentity): AgentOperationRecord {
  return {
    ...identity,
    receipt: {
      version: 1,
      operationId: identity.operationId,
      kind: identity.kind,
      fence: identity.fence,
      planHash: identity.planHash,
      authorityHash: identity.authorityHash,
      descriptorDigest: identity.descriptorDigest,
      payloadDigest: identity.payloadDigest,
      actorIdentity: {
        supervisorEpoch: identity.supervisorEpoch,
        hostId: identity.hostId,
        hostGeneration: identity.hostGeneration,
        hostIncarnation: identity.hostIncarnation,
        transcriptAnchor: identity.transcriptAnchor,
        ...(identity.kind === "mcp"
          ? { toolUseEntryId: identity.toolUseEntryId }
          : {}),
      },
      state: "prepared",
      acceptedAtMs: 0,
      providerRef: {
        adapterId: identity.adapterId,
        adapterVersion: identity.adapterVersion,
      },
    },
  };
}
export class AgentGatewayAmbiguousExecutionError extends Error {
  readonly reason: AgentOperationIndeterminateReason;
  constructor(reason: AgentOperationIndeterminateReason) {
    super(`agent operation completion is ambiguous: ${reason}`);
    this.name = "AgentGatewayAmbiguousExecutionError";
    this.reason = reason;
  }
}
export class AgentGatewayRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentGatewayRequestError";
  }
}
export class AgentGatewayAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentGatewayAuthorizationError";
  }
}
export class AgentGatewayAdmissionError extends Error {
  constructor() {
    super("agent operation admission rejected");
    this.name = "AgentGatewayAdmissionError";
  }
}
export class AgentGatewayInheritedExecutionError extends Error {
  constructor() {
    super("inherited executing operation requires recovery");
    this.name = "AgentGatewayInheritedExecutionError";
  }
}
