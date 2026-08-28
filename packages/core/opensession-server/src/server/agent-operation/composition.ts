import {
  AgentHostClient,
  type AgentHostClientOptions,
} from "../agent-host-client";
import type { SessionKernelActorClient } from "../session-kernel/actor-client";
import {
  AgentGatewayGrantRegistry,
  type AgentGatewayGrantRegistryOptions,
} from "./grants";
import type {
  AgentGatewayDecodedPayload,
  AgentOperationGatewayOptions,
} from "./gateway";
import { AgentOperationKernelFacade } from "./kernel-facade";
import {
  createMcpAgentOperationAdapter,
  MCP_AGENT_OPERATION_ADAPTER_ID,
  MCP_AGENT_OPERATION_ADAPTER_VERSION,
  MCP_AGENT_OPERATION_RECONCILER,
  McpTurnRuntimeRegistry,
} from "./mcp-adapter";
import {
  createPiModelAgentOperationAdapter,
  PI_MODEL_AGENT_OPERATION_ADAPTER_ID,
  PI_MODEL_AGENT_OPERATION_ADAPTER_VERSION,
  PI_MODEL_AGENT_OPERATION_RECONCILER,
  PiRuntimeBindingRegistry,
  type PiBoundModelExecutor,
} from "./pi-model-adapter";
import {
  decodePiModelGatewayPayload,
  decodePiModelOperationReferenceV1,
  PiModelInvocationRegistry,
  type PiModelInvocationRegistryOptions,
} from "./pi-model-operation";
import {
  AgentOperationService,
  type AgentOperationServiceOptions,
} from "./service";
import {
  SQLiteAgentOperationLedger,
  type SQLiteAgentOperationLedgerOptions,
} from "./sqlite-ledger";
import {
  AgentOperationTranscriptFacade,
  type AgentOperationTranscriptFacadeOptions,
} from "./transcript-facade";

const GATEWAY_OPERATION_LEDGER_SCHEMA_VERSION = 2;

type ActorClient = Pick<SessionKernelActorClient, "decideAgentOperationAsync">;
type ServiceGatewayOptions = Omit<
  AgentOperationGatewayOptions,
  | "ledger"
  | "grants"
  | "admission"
  | "adapterFor"
  | "decodePayload"
  | "appendTerminal"
  | "reconcilerFor"
  | "beginLiveExecution"
  | "verifySupervision"
>;
type HostClientBootOptions = Omit<
  AgentHostClientOptions,
  | "dispatchOperation"
  | "queryOperation"
  | "cancelOperation"
  | "acknowledgeOperationStream"
>;

export interface AgentOperationCompositionOptions {
  readonly ledger: SQLiteAgentOperationLedgerOptions;
  readonly grants?: AgentGatewayGrantRegistryOptions;
  readonly actor: ActorClient;
  readonly transcript: AgentOperationTranscriptFacadeOptions;
  readonly piExecutor: PiBoundModelExecutor;
  readonly piInvocations?: PiModelInvocationRegistryOptions;
  /** Strict turn-owned MCP decoder. It must return canonical full-payload and arguments bytes. */
  readonly decodeMcpPayload: (
    payload: unknown,
  ) => AgentGatewayDecodedPayload | undefined;
  readonly gateway: ServiceGatewayOptions;
  readonly verifySupervision: AgentOperationServiceOptions["verifySupervision"];
  readonly hostClient: HostClientBootOptions;
  readonly closeTimeoutMs?: number;
  readonly scheduleTimeout?: AgentOperationServiceOptions["scheduleTimeout"];
  readonly maxPlans?: number;
  readonly maxCanonicalPayloadBytes?: number;
}

export interface AgentOperationReadinessFeed {
  readonly gatewayOperationLedger: Readonly<{
    schemaVersion: 2;
    recoverActiveComplete: boolean;
  }>;
  readonly boundedRegistries: Readonly<{
    gatewayGrants: true;
    gatewayOperations: true;
  }>;
  readonly infrastructureFallback: false;
  readonly capabilities: Readonly<{
    deletion: true;
    recovery: true;
    streamAck: true;
  }>;
}

/**
 * Import-inert production composition for the detached Agent operation path.
 * Construction opens only the explicitly injected SQLite ledger. It does not
 * connect the Host client, schedule work, or change the production route.
 */
export class AgentOperationComposition {
  readonly ledger: SQLiteAgentOperationLedger;
  readonly grants: AgentGatewayGrantRegistry;
  readonly kernel: AgentOperationKernelFacade;
  readonly transcript: AgentOperationTranscriptFacade;
  readonly piBindings: PiRuntimeBindingRegistry;
  readonly piInvocations: PiModelInvocationRegistry;
  readonly mcpRuntimes: McpTurnRuntimeRegistry;
  readonly service: AgentOperationService;
  readonly hostClient: AgentHostClient;

  constructor(options: AgentOperationCompositionOptions) {
    this.ledger = new SQLiteAgentOperationLedger(options.ledger);
    this.grants = new AgentGatewayGrantRegistry(options.grants);
    this.kernel = new AgentOperationKernelFacade(options.actor);
    this.transcript = new AgentOperationTranscriptFacade(options.transcript);
    this.piBindings = new PiRuntimeBindingRegistry();
    this.piInvocations = new PiModelInvocationRegistry(options.piInvocations);
    this.mcpRuntimes = new McpTurnRuntimeRegistry();

    const piAdapter = createPiModelAgentOperationAdapter(
      this.piBindings,
      this.piInvocations,
      options.piExecutor,
    );
    const mcpAdapter = createMcpAgentOperationAdapter(this.mcpRuntimes);
    let service!: AgentOperationService;
    this.hostClient = new AgentHostClient({
      ...options.hostClient,
      dispatchOperation: (intent, signal) =>
        service.dispatchOperation(intent, signal),
      queryOperation: (intent, signal) =>
        service.queryOperation(intent, signal),
      cancelOperation: (intent, signal) =>
        service.cancelOperation(intent, signal),
      acknowledgeOperationStream: (intent) =>
        service.acknowledgeOperationStream(intent),
    });

    const closeOwners = [
      () => this.hostClient.close(),
      () => this.ledger.close(),
    ] as const;
    service = new AgentOperationService({
      grants: this.grants,
      gateway: {
        ...options.gateway,
        ledger: this.ledger,
        admission: this.kernel,
        adapterFor: (request) =>
          request.kind === "model" ? piAdapter : mcpAdapter,
        decodePayload: (kind, payload, request) => {
          if (kind === "mcp") {
            const decoded = options.decodeMcpPayload(payload);
            return decoded?.kind === "mcp" ? decoded : undefined;
          }
          const reference = decodePiModelOperationReferenceV1(payload);
          if (!reference) return undefined;
          return decodePiModelGatewayPayload(
            this.piInvocations,
            {
              fence: request.fence,
              operationId: request.operationId,
              descriptorDigest: request.descriptorDigest,
              bindingRef: reference.bindingRef,
            },
            payload,
          );
        },
        appendTerminal: (identity, result) =>
          this.transcript.appendTerminal(identity, result),
        reconcilerFor: (record) => {
          if (
            record.adapterId === PI_MODEL_AGENT_OPERATION_ADAPTER_ID &&
            record.adapterVersion === PI_MODEL_AGENT_OPERATION_ADAPTER_VERSION
          )
            return PI_MODEL_AGENT_OPERATION_RECONCILER;
          if (
            record.adapterId === MCP_AGENT_OPERATION_ADAPTER_ID &&
            record.adapterVersion === MCP_AGENT_OPERATION_ADAPTER_VERSION
          )
            return MCP_AGENT_OPERATION_RECONCILER;
          return undefined;
        },
      },
      verifySupervision: options.verifySupervision,
      authorizedReceiptReader: (query) => this.ledger.queryAuthorized(query),
      cancellation: this.kernel,
      closeOwners,
      closeTimeoutMs: options.closeTimeoutMs,
      scheduleTimeout: options.scheduleTimeout,
      maxPlans: options.maxPlans,
      maxCanonicalPayloadBytes: options.maxCanonicalPayloadBytes,
    });
    this.service = service;
  }

  start(): Promise<void> {
    return this.service.start();
  }

  close(): Promise<void> {
    return this.service.close();
  }

  readinessFeed(): AgentOperationReadinessFeed {
    const health = this.service.healthSnapshot();
    return Object.freeze({
      gatewayOperationLedger: Object.freeze({
        schemaVersion: GATEWAY_OPERATION_LEDGER_SCHEMA_VERSION,
        recoverActiveComplete:
          health.ready && !health.recovering && !health.failed,
      }),
      boundedRegistries: Object.freeze({
        gatewayGrants: true as const,
        gatewayOperations: true as const,
      }),
      infrastructureFallback: false as const,
      capabilities: Object.freeze({
        deletion: true as const,
        recovery: true as const,
        streamAck: true as const,
      }),
    });
  }
}

export function createAgentOperationComposition(
  options: AgentOperationCompositionOptions,
): AgentOperationComposition {
  return new AgentOperationComposition(options);
}
