import type { AgentMcpOperationDescriptorV1 } from "@tellahq/opensession-protocol/agent-operation";
import type { AgentTurnFence } from "@tellahq/opensession-protocol/agent-host";
import type {
  McpRuntime,
  McpRuntimeCallResult,
  McpRuntimeContent,
} from "../mcp-runtime";
import {
  AgentGatewayAmbiguousExecutionError,
  type AgentGatewayAdapter,
  type AgentGatewayAdapterResult,
} from "./gateway";
import type {
  AgentOperationIdentity,
  ExecutingOperationReconciler,
} from "./ledger";

export const MCP_AGENT_OPERATION_ADAPTER_ID = "mcp-runtime";
export const MCP_AGENT_OPERATION_ADAPTER_VERSION = "1.0";
export const MCP_AGENT_OPERATION_REQUEST_VERSION = "v1";
export const MAX_MCP_AGENT_TRANSCRIPT_BYTES = 64 * 1024;
const MAX_MCP_AGENT_CONTENT_BLOCKS = 64;
const TRUNCATED = "…[truncated]";
const OMITTED_IMAGE =
  "[image omitted: MCP result exceeded the transcript limit]";

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

export interface McpTurnRuntimeRegistration {
  /** Removes this exact turn runtime and closes it. Safe to call repeatedly. */
  close(): Promise<void>;
}

/**
 * Import-inert registry of credential-bearing runtimes owned by their turns.
 *
 * The registry never creates a runtime and the adapter can only borrow one.
 * Registration returns the sole close capability; a fence remains consumed
 * after close so a stale owner cannot install a replacement runtime.
 */
export class McpTurnRuntimeRegistry {
  readonly #active = new Map<string, McpRuntime>();
  readonly #consumed = new Set<string>();

  register(
    fence: Readonly<AgentTurnFence>,
    runtime: McpRuntime,
  ): McpTurnRuntimeRegistration {
    if (!exactFence(fence)) throw new TypeError("invalid MCP turn fence");
    const key = fenceKey(fence);
    if (this.#consumed.has(key))
      throw new Error("MCP runtime already registered for this turn");
    this.#consumed.add(key);
    this.#active.set(key, runtime);
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      close: () => {
        if (!closePromise) {
          this.#active.delete(key);
          closePromise = Promise.resolve().then(() => runtime.close());
        }
        return closePromise;
      },
    });
  }

  /** Adapter-only borrowing boundary. It transfers neither runtime nor close ownership. */
  get(fence: Readonly<AgentTurnFence>): McpRuntime | undefined {
    if (!exactFence(fence)) return undefined;
    return this.#active.get(fenceKey(fence));
  }
}

export type McpAgentOperationAmbiguityReason =
  "cancellation_ambiguous" | "timeout_ambiguous" | "disconnect_ambiguous";

export class McpAgentOperationAmbiguityError extends AgentGatewayAmbiguousExecutionError {
  declare readonly reason: McpAgentOperationAmbiguityReason;
  constructor(reason: McpAgentOperationAmbiguityReason) {
    super(reason);
    this.name = "McpAgentOperationAmbiguityError";
  }
}

function immutableJson(value: unknown): value is Record<string, unknown> {
  const seen = new Set<object>();
  let values = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++values > 2_048 || depth > 12) return false;
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    )
      return true;
    if (!item || typeof item !== "object" || seen.has(item)) return false;
    if (!Object.isFrozen(item)) return false;
    seen.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    if (Array.isArray(item)) {
      if (
        Object.getPrototypeOf(item) !== Array.prototype ||
        keys.length !== item.length + 1
      )
        return false;
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[String(index)];
        if (
          !descriptor ||
          !("value" in descriptor) ||
          !descriptor.enumerable ||
          descriptor.value === undefined ||
          !visit(descriptor.value, depth + 1)
        )
          return false;
      }
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) return false;
      for (const key of keys) {
        if (typeof key !== "string") return false;
        const descriptor = descriptors[key];
        if (
          !descriptor ||
          !("value" in descriptor) ||
          !descriptor.enumerable ||
          descriptor.value === undefined ||
          /^(?:__proto__|prototype|constructor)$/.test(key) ||
          !visit(descriptor.value, depth + 1)
        )
          return false;
      }
    }
    seen.delete(item);
    return true;
  };
  return visit(value, 0) && !Array.isArray(value);
}

function decodeArgumentsPayload(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!immutableJson(value)) return;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== 1 ||
    keys[0] !== "arguments" ||
    !("value" in descriptors.arguments!) ||
    !immutableJson(descriptors.arguments!.value)
  )
    return;
  return descriptors.arguments!.value;
}

function transcriptBytes(content: readonly McpRuntimeContent[]): number {
  return Buffer.byteLength(JSON.stringify({ kind: "mcp", content }));
}

function boundedText(
  content: readonly McpRuntimeContent[],
  text: string,
): string | undefined {
  const full = { type: "text" as const, text };
  if (transcriptBytes([...content, full]) <= MAX_MCP_AGENT_TRANSCRIPT_BYTES)
    return text;
  let low = 0;
  let high = text.length;
  let fit: string | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${text.slice(0, middle)}${TRUNCATED}`;
    if (
      transcriptBytes([...content, { type: "text", text: candidate }]) <=
      MAX_MCP_AGENT_TRANSCRIPT_BYTES
    ) {
      fit = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return fit;
}

function boundedTranscript(result: McpRuntimeCallResult): Readonly<{
  kind: "mcp";
  content: readonly McpRuntimeContent[];
}> {
  const content: McpRuntimeContent[] = [];
  for (const block of result.content.slice(0, MAX_MCP_AGENT_CONTENT_BLOCKS)) {
    if (block.type === "text") {
      const text = boundedText(content, block.text);
      if (text === undefined) break;
      content.push(Object.freeze({ type: "text", text }));
      if (text !== block.text) break;
      continue;
    }
    const image = {
      type: "image" as const,
      data: block.data,
      mimeType: block.mimeType,
    };
    if (
      transcriptBytes([...content, image]) <= MAX_MCP_AGENT_TRANSCRIPT_BYTES
    ) {
      content.push(Object.freeze(image));
      continue;
    }
    const omitted = boundedText(content, OMITTED_IMAGE);
    if (omitted !== undefined)
      content.push(Object.freeze({ type: "text", text: omitted }));
    break;
  }
  if (result.content.length > MAX_MCP_AGENT_CONTENT_BLOCKS) {
    const omitted = boundedText(content, "[additional MCP content omitted]");
    if (omitted !== undefined)
      content.push(Object.freeze({ type: "text", text: omitted }));
  }
  return Object.freeze({ kind: "mcp", content: Object.freeze(content) });
}

function ambiguityReason(
  error: unknown,
  signal: AbortSignal,
): McpAgentOperationAmbiguityReason | undefined {
  if (signal.aborted || (error instanceof Error && error.name === "AbortError"))
    return "cancellation_ambiguous";
  const text =
    error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/time(?:d?\s*out|out)|deadline/i.test(text)) return "timeout_ambiguous";
  if (
    /disconnect|connection (?:closed|lost|reset)|socket|broken pipe|econnreset|eof/i.test(
      text,
    )
  )
    return "disconnect_ambiguous";
}

function terminalResult(
  status: "failed" | "cancelled",
  code: "tool_error" | "cancelled",
  text: string,
): AgentGatewayAdapterResult {
  return Object.freeze({
    outcome: Object.freeze({ status, code }),
    transcript: Object.freeze({
      kind: "mcp",
      content: Object.freeze([Object.freeze({ type: "text", text })]),
    }),
  });
}

const failedResult = () =>
  terminalResult("failed", "tool_error", "MCP tool call failed");
const cancelledResult = () =>
  terminalResult("cancelled", "cancelled", "MCP tool call cancelled");

function mcpDescriptor(
  identity: Readonly<AgentOperationIdentity>,
): AgentMcpOperationDescriptorV1 | undefined {
  return identity.kind === "mcp" &&
    identity.descriptor.kind === "mcp" &&
    identity.toolUseEntryId === identity.descriptor.toolUseEntryId &&
    identity.adapterId === MCP_AGENT_OPERATION_ADAPTER_ID &&
    identity.adapterVersion === MCP_AGENT_OPERATION_ADAPTER_VERSION
    ? identity.descriptor
    : undefined;
}

/** Executing MCP calls have no durable provider receipt to query. Fail closed. */
export const MCP_AGENT_OPERATION_RECONCILER: ExecutingOperationReconciler =
  Object.freeze({
    async reconcile() {
      return Object.freeze({
        status: "indeterminate" as const,
        reason: "reconciliation_unsupported" as const,
      });
    },
  });

/** Hardened, turn-scoped MCP adapter. */
export function createMcpAgentOperationAdapter(
  registry: McpTurnRuntimeRegistry,
): AgentGatewayAdapter {
  return Object.freeze({
    id: MCP_AGENT_OPERATION_ADAPTER_ID,
    version: MCP_AGENT_OPERATION_ADAPTER_VERSION,
    async execute(
      request: Parameters<AgentGatewayAdapter["execute"]>[0],
      signal: AbortSignal,
    ) {
      const descriptor = mcpDescriptor(request.identity);
      if (
        !descriptor ||
        descriptor.adapterRequestVersion !== MCP_AGENT_OPERATION_REQUEST_VERSION
      )
        return failedResult();
      const args = decodeArgumentsPayload(request.payload);
      if (!args) return failedResult();
      if (signal.aborted) return cancelledResult();
      const runtime = registry.get(request.identity.fence);
      if (!runtime) return failedResult();
      let catalog: Awaited<ReturnType<McpRuntime["catalog"]>>;
      try {
        catalog = await runtime.catalog();
      } catch {
        return signal.aborted ? cancelledResult() : failedResult();
      }
      if (signal.aborted) return cancelledResult();
      const matches = catalog.filter(
        (tool) =>
          tool.server === descriptor.server &&
          tool.name === descriptor.tool &&
          tool.id === `${descriptor.server}_${descriptor.tool}`,
      );
      if (matches.length !== 1) return failedResult();

      try {
        const result = await runtime.callExact(matches[0]!.id, args, {
          toolCallId: descriptor.toolUseId,
          signal,
        });
        return Object.freeze({
          outcome: Object.freeze({ status: "succeeded", code: "ok" }),
          transcript: boundedTranscript(result),
        });
      } catch (error) {
        const reason = ambiguityReason(error, signal);
        if (reason) throw new McpAgentOperationAmbiguityError(reason);
        return failedResult();
      }
    },
  });
}
