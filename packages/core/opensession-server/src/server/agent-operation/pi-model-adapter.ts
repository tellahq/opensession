import type {
  AgentModelOperationDescriptorV1,
  AgentOperationDigest,
  AgentOperationOutcomeV1,
} from "@tellahq/opensession-protocol/agent-operation";
import type { AgentTurnFence } from "@tellahq/opensession-protocol/agent-host";
import type { PiRuntimeBinding } from "../pi-runtime-binding";
import {
  AgentGatewayAmbiguousExecutionError,
  type AgentGatewayAdapter,
  type AgentGatewayAdapterResult,
  type AgentGatewayLiveEventSink,
} from "./gateway";
import type {
  AgentOperationIdentity,
  ExecutingOperationReconciler,
} from "./ledger";
import {
  encodePiModelEventV1,
  type PiModelInvocationLookup,
  type PiModelInvocationRegistry,
  type PiModelPrivateAdapterPayloadV1,
} from "./pi-model-operation";

export const PI_MODEL_AGENT_OPERATION_ADAPTER_ID = "pi-bound-model";
export const PI_MODEL_AGENT_OPERATION_ADAPTER_VERSION = "1.0";
export const PI_MODEL_AGENT_OPERATION_REQUEST_VERSION = "v1";

const REF = /^[A-Za-z0-9_-]{43}$/;

function fenceKey(fence: Readonly<AgentTurnFence>): string {
  return JSON.stringify([
    fence.sessionId,
    fence.runId,
    fence.turnId,
    fence.generation,
  ]);
}

function exactFence(value: Readonly<AgentTurnFence>): boolean {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  return (
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null) &&
    keys.length === 4 &&
    keys.every(
      (key) =>
        typeof key === "string" &&
        ["sessionId", "runId", "turnId", "generation"].includes(key) &&
        "value" in descriptors[key]! &&
        descriptors[key]!.enumerable,
    ) &&
    typeof descriptors.sessionId?.value === "string" &&
    typeof descriptors.runId?.value === "string" &&
    typeof descriptors.turnId?.value === "string" &&
    Number.isSafeInteger(descriptors.generation?.value) &&
    (descriptors.generation?.value as number) >= 0
  );
}

interface BindingEntry {
  readonly binding: PiRuntimeBinding;
  readonly descriptorDigest: AgentOperationDigest;
  readonly modelPolicyHash: AgentOperationDigest;
  readonly provider: string;
  readonly modelId: string;
}

export interface PiRuntimeBindingRegistrationInput {
  readonly fence: Readonly<AgentTurnFence>;
  readonly bindingRef: string;
  readonly binding: PiRuntimeBinding;
  readonly descriptorDigest: AgentOperationDigest;
  readonly modelPolicyHash: AgentOperationDigest;
  /** Exact identity already selected on the binding. */
  readonly modelIdentity: Readonly<{ provider: string; id: string }>;
}

export interface PiRuntimeBindingRegistration {
  /** Owner-only removal capability. Safe to repeat. */
  close(): boolean;
}

/** Turn-owned registry. It only borrows already-created bindings and never replaces one. */
export class PiRuntimeBindingRegistry {
  readonly #active = new Map<string, BindingEntry>();
  readonly #used = new Set<string>();

  register(input: PiRuntimeBindingRegistrationInput): PiRuntimeBindingRegistration {
    if (!exactFence(input.fence) || !REF.test(input.bindingRef))
      throw new TypeError("invalid Pi binding identity");
    if (!input.binding || typeof input.binding !== "object")
      throw new TypeError("invalid Pi runtime binding");
    if (
      input.binding.model.provider !== input.modelIdentity.provider ||
      input.binding.model.id !== input.modelIdentity.id
    ) throw new Error("Pi binding model identity mismatch");
    const key = `${fenceKey(input.fence)}\0${input.bindingRef}`;
    if (this.#used.has(key)) throw new Error("Pi binding already registered");
    const entry = Object.freeze({
      binding: input.binding,
      descriptorDigest: input.descriptorDigest,
      modelPolicyHash: input.modelPolicyHash,
      provider: input.modelIdentity.provider,
      modelId: input.modelIdentity.id,
    });
    this.#used.add(key);
    this.#active.set(key, entry);
    let closed = false;
    return Object.freeze({
      close: () => {
        if (closed) return false;
        closed = true;
        return this.#active.get(key) === entry && this.#active.delete(key);
      },
    });
  }

  get(
    fence: Readonly<AgentTurnFence>,
    bindingRef: string,
  ): BindingEntry | undefined {
    if (!exactFence(fence) || !REF.test(bindingRef)) return undefined;
    return this.#active.get(`${fenceKey(fence)}\0${bindingRef}`);
  }
}

export interface PiBoundModelExecutorResult {
  readonly outcome: Readonly<AgentOperationOutcomeV1>;
  readonly transcript: unknown;
  readonly providerRequestRef?: string;
  readonly providerResponseRef?: string;
}

export interface PiBoundModelExecutor {
  execute(input: Readonly<{
    binding: PiRuntimeBinding;
    invocation: unknown;
    signal: AbortSignal;
    publish(payload: Uint8Array): Promise<void>;
  }>): Promise<PiBoundModelExecutorResult>;
}

function exactPrivatePayload(
  value: unknown,
): value is Readonly<PiModelPrivateAdapterPayloadV1> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  return (
    keys.length === 3 &&
    keys.every(
      (key) =>
        typeof key === "string" &&
        ["version", "identity", "invocation"].includes(key) &&
        "value" in descriptors[key]! &&
        descriptors[key]!.enumerable,
    ) &&
    descriptors.version?.value === 1 &&
    Object.isFrozen(value)
  );
}

function modelDescriptor(
  identity: Readonly<AgentOperationIdentity>,
): AgentModelOperationDescriptorV1 | undefined {
  return identity.kind === "model" &&
    identity.descriptor.kind === "model" &&
    identity.adapterId === PI_MODEL_AGENT_OPERATION_ADAPTER_ID &&
    identity.adapterVersion === PI_MODEL_AGENT_OPERATION_ADAPTER_VERSION
    ? identity.descriptor
    : undefined;
}

function sameFence(a: Readonly<AgentTurnFence>, b: Readonly<AgentTurnFence>) {
  return fenceKey(a) === fenceKey(b);
}

function exactLookup(
  lookup: Readonly<PiModelInvocationLookup>,
  identity: Readonly<AgentOperationIdentity>,
): boolean {
  return (
    sameFence(lookup.fence, identity.fence) &&
    lookup.operationId === identity.operationId &&
    lookup.descriptorDigest === identity.descriptorDigest
  );
}

function terminal(
  status: "failed" | "cancelled",
  code: "provider_error" | "cancelled",
): AgentGatewayAdapterResult {
  const outcome: AgentOperationOutcomeV1 = { status, code };
  return Object.freeze({
    outcome: Object.freeze(outcome),
    transcript: Object.freeze({ kind: "model", status }),
  });
}

const failed = () => terminal("failed", "provider_error");
const cancelled = () => terminal("cancelled", "cancelled");

function ambiguity(error: unknown, signal: AbortSignal) {
  if (signal.aborted || (error instanceof Error && error.name === "AbortError"))
    return "cancellation_ambiguous" as const;
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/time(?:d?\s*out|out)|deadline/i.test(text))
    return "timeout_ambiguous" as const;
  return "disconnect_ambiguous" as const;
}

/** Pi provider execution has no supported durable query/reconciliation surface. */
export const PI_MODEL_AGENT_OPERATION_RECONCILER: ExecutingOperationReconciler =
  Object.freeze({
    async reconcile() {
      return Object.freeze({
        status: "indeterminate" as const,
        reason: "reconciliation_unsupported" as const,
      });
    },
  });

/** Production-unwired adapter over a turn-owned binding and invocation capability. */
export function createPiModelAgentOperationAdapter(
  bindings: PiRuntimeBindingRegistry,
  invocations: PiModelInvocationRegistry,
  executor: PiBoundModelExecutor,
): AgentGatewayAdapter {
  return Object.freeze({
    id: PI_MODEL_AGENT_OPERATION_ADAPTER_ID,
    version: PI_MODEL_AGENT_OPERATION_ADAPTER_VERSION,
    async execute(
      request: Parameters<AgentGatewayAdapter["execute"]>[0],
      signal: AbortSignal,
      sink?: AgentGatewayLiveEventSink,
    ) {
      const descriptor = modelDescriptor(request.identity);
      if (
        !descriptor ||
        descriptor.adapterRequestVersion !== PI_MODEL_AGENT_OPERATION_REQUEST_VERSION ||
        !exactPrivatePayload(request.payload)
      ) return failed();
      const payload = request.payload;
      const lookup = payload.identity;
      if (!exactLookup(lookup, request.identity)) return failed();
      if (signal.aborted) return cancelled();
      if (!sink) return failed();
      const registered = bindings.get(request.identity.fence, lookup.bindingRef);
      if (
        !registered ||
        registered.descriptorDigest !== request.identity.descriptorDigest ||
        registered.modelPolicyHash !== descriptor.modelPolicyHash ||
        registered.binding.model.provider !== registered.provider ||
        registered.binding.model.id !== registered.modelId
      ) return failed();

      let rejectAbort: ((reason: unknown) => void) | undefined;
      let abortObserved = false;
      const onAbort = () => {
        abortObserved = true;
        rejectAbort?.(new DOMException("aborted", "AbortError"));
      };
      const abort = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      if (abortObserved) {
        void abort.catch(() => undefined);
        signal.removeEventListener("abort", onAbort);
        return cancelled();
      }

      const consumed = invocations.consumeAdapterPayloadExact(lookup, payload);
      if (!consumed) {
        signal.removeEventListener("abort", onAbort);
        return failed();
      }

      let sequence = 0;
      let previousDigest: AgentOperationDigest | null = null;
      let publishTail: Promise<void> = Promise.resolve();
      let invoked = false;
      try {
        invoked = true;
        const physical = executor.execute(Object.freeze({
          binding: registered.binding,
          invocation: consumed.invocation,
          signal,
          publish: (eventPayload: Uint8Array) => {
            const queued = publishTail.then(async () => {
              const envelope = encodePiModelEventV1({
                operationId: request.identity.operationId,
                eventSeq: sequence,
                previousDigest,
                payload: eventPayload,
              });
              await sink.publish(envelope);
              sequence++;
              previousDigest = envelope.eventDigest;
            });
            publishTail = queued;
            return queued;
          },
        }));
        const result = await Promise.race([physical, abort]);
        await Promise.race([publishTail, abort]);
        return Object.freeze({
          outcome: result.outcome,
          transcript: result.transcript,
          ...(result.providerRequestRef === undefined
            ? {}
            : { providerRequestRef: result.providerRequestRef }),
          ...(result.providerResponseRef === undefined
            ? {}
            : { providerResponseRef: result.providerResponseRef }),
        });
      } catch (error) {
        if (!invoked) return signal.aborted ? cancelled() : failed();
        throw new AgentGatewayAmbiguousExecutionError(ambiguity(error, signal));
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  });
}
