import type {
  AgentHostInitialOperationV4,
  AgentHostOperationCancelV4,
  AgentHostOperationQueryV4,
  AgentHostOperationStreamV4,
  AgentTurnSpec,
} from "@tellahq/opensession-protocol";

export type AgentTurnResult =
  { status: "completed" | "cancelled" } | { status: "failed"; error: string };

/** Descriptor-only operation intent. Authority and dispatch policy stay in the
 * coordinator that implements the transport. */
export type AgentHostOperationRequest = Readonly<AgentHostInitialOperationV4>;

export type AgentHostOperationQuery = Readonly<
  Pick<
    AgentHostOperationQueryV4,
    | "operationId"
    | "kind"
    | "descriptorDigest"
    | "payloadDigest"
    | "afterStreamSeq"
  >
>;

export type AgentHostOperationCancel = Readonly<
  Pick<
    AgentHostOperationCancelV4,
    "operationId" | "cancelId" | "reason"
  >
>;

/** Opaque operation bytes. The driver cannot recover provider or tool policy
 * from this envelope. */
export type AgentHostOperationStream = Readonly<
  Pick<
    AgentHostOperationStreamV4,
    "operationId" | "streamSeq" | "encoding" | "bytes"
  >
>;

/** The only coordinator capability exposed to a model-loop driver. Each
 * promise settles only when the coordinator has accepted or rejected the
 * operation intent. */
export interface AgentHostOperationTransport {
  requestOperation(request: AgentHostOperationRequest): Promise<void>;
  queryOperation(query: AgentHostOperationQuery): Promise<void>;
  cancelOperation(cancel: AgentHostOperationCancel): Promise<void>;
}

/** One model-loop implementation for one descriptor-only turn. */
export interface AgentTurnDriver {
  run(
    spec: AgentTurnSpec,
    transport: AgentHostOperationTransport,
  ): Promise<AgentTurnResult>;

  /** Resolve only after the opaque chunk has been consumed. The Host must not
   * issue a cumulative stream ACK before this promise resolves. */
  deliverOperationStream(stream: AgentHostOperationStream): Promise<void>;
  cancel(): Promise<void>;
  shutdown(): Promise<void>;
}

export type AgentTurnDriverFactory = (spec: AgentTurnSpec) => AgentTurnDriver;
