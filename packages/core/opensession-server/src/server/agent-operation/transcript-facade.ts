import type {
  AgentOperationDigest,
  AgentOperationKernelTerminalV1,
  AgentTranscriptReceiptRefV1,
} from "@tellahq/opensession-protocol/agent-operation";
import type { TranscriptEntry } from "../types";
import {
  TRANSCRIPT_DESTINATION_MAX_BYTES,
  TRANSCRIPT_DESTINATION_MAX_ENTRIES,
  type TranscriptStore,
} from "../transcript-store";
import type { AgentGatewayAdapterResult, AgentGatewayTranscriptTerminal } from "./gateway";
import type {
  AgentOperationIdentity,
  AgentOperationTerminalReservation,
} from "./ledger";

const APPEND_ID_DOMAIN = "opensession.agent-transcript-append.v1\0";
const MAX_PENDING_TOOL_USES = 64;

export interface AgentTranscriptRenderResult {
  readonly entries: readonly Readonly<TranscriptEntry>[];
  /** Required, including an empty array, for model operations; forbidden for MCP. */
  readonly pendingToolUseEntryIds?: readonly string[];
}

export interface AgentTranscriptReplayHint {
  readonly receipt: Readonly<AgentTranscriptReceiptRefV1>;
  readonly pendingToolUseEntryIds?: readonly string[];
}

export interface AgentOperationTranscriptFacadeOptions {
  readonly store: Pick<
    TranscriptStore,
    "commitTranscriptDestinationAppendReceipt" | "validateAgentTranscriptReceiptRef"
  >;
  /** The only component permitted to turn provider material into transcript rows. */
  readonly render: (
    identity: Readonly<AgentOperationIdentity>,
    result: Readonly<AgentGatewayAdapterResult>,
  ) => AgentTranscriptRenderResult | Promise<AgentTranscriptRenderResult>;
  /** Must return the canonical durable reservation, or undefined on any mismatch. */
  readonly authenticateReservation: (
    identity: Readonly<AgentOperationIdentity>,
    reservation: Readonly<AgentOperationTerminalReservation>,
  ) =>
    | Readonly<AgentOperationTerminalReservation>
    | undefined
    | Promise<Readonly<AgentOperationTerminalReservation> | undefined>;
}

export class AgentTranscriptReservationAuthenticationError extends Error {
  readonly code = "AGENT_TRANSCRIPT_RESERVATION_AUTHENTICATION_FAILED";
  constructor() {
    super("Agent transcript terminal reservation is not authentic");
    this.name = "AgentTranscriptReservationAuthenticationError";
  }
}

/**
 * Production-unwired destination facade. It owns no process resources and has
 * no import-time effects. Provider-private adapter material reaches only the
 * injected renderer and is never included in receipts or errors.
 */
export class AgentOperationTranscriptFacade {
  readonly #options: AgentOperationTranscriptFacadeOptions;
  readonly #replays = new Map<string, AgentTranscriptReplayHint>();

  constructor(options: AgentOperationTranscriptFacadeOptions) {
    this.#options = options;
  }

  appendTerminal(
    identity: Readonly<AgentOperationIdentity>,
    result: Readonly<AgentGatewayAdapterResult>,
    replay?: Readonly<AgentTranscriptReplayHint>,
  ): Promise<AgentGatewayTranscriptTerminal> {
    return this.#append(identity, result, terminalAppendId(identity), replay);
  }

  async appendIndeterminate(
    identity: Readonly<AgentOperationIdentity>,
    reservation: Readonly<AgentOperationTerminalReservation>,
    result: Readonly<AgentGatewayAdapterResult>,
    replay?: Readonly<AgentTranscriptReplayHint>,
  ): Promise<AgentGatewayTranscriptTerminal> {
    // Authentication deliberately precedes receipt lookup, rendering, and all
    // destination callbacks so a forged reservation has no observable effect.
    const authenticated = await this.#options.authenticateReservation(
      identity,
      reservation,
    );
    if (!authenticated || !sameReservation(authenticated, reservation))
      throw new AgentTranscriptReservationAuthenticationError();
    return this.#append(
      identity,
      result,
      reservationAppendId(authenticated.reservationId),
      replay,
    );
  }

  async #append(
    identity: Readonly<AgentOperationIdentity>,
    result: Readonly<AgentGatewayAdapterResult>,
    appendId: string,
    replay?: Readonly<AgentTranscriptReplayHint>,
  ): Promise<AgentGatewayTranscriptTerminal> {
    const existing = replay ?? this.#replays.get(appendId);
    if (existing) {
      const receipt = this.#validateReplay(identity, appendId, existing.receipt);
      const pending = validatePending(identity.kind, existing.pendingToolUseEntryIds, receipt.entryIds);
      return terminal(result, receipt, pending);
    }

    const rendered = validateRendered(
      identity.kind,
      await this.#options.render(identity, result),
    );
    const durable = this.#options.store.commitTranscriptDestinationAppendReceipt({
      sessionId: identity.fence.sessionId,
      runId: identity.fence.runId,
      turnId: identity.fence.turnId,
      generation: identity.fence.generation,
      transcriptAnchor: identity.transcriptAnchor,
      appendId,
      entries: rendered.entries as TranscriptEntry[],
    });
    const receipt = this.#validateReplay(identity, appendId, {
      appendId: durable.appendId,
      entryIds: durable.entryIds,
      firstSeq: durable.firstSeq,
      lastSeq: durable.lastSeq,
      throughChangeSeq: durable.throughChangeSeq,
      requestDigest: durable.requestDigest,
    });
    const pending = validatePending(
      identity.kind,
      rendered.pendingToolUseEntryIds,
      receipt.entryIds,
    );
    this.#replays.set(appendId, Object.freeze({ receipt, ...(pending === undefined ? {} : { pendingToolUseEntryIds: pending }) }));
    return terminal(result, receipt, pending);
  }

  #validateReplay(
    identity: Readonly<AgentOperationIdentity>,
    appendId: string,
    candidate: Readonly<AgentTranscriptReceiptRefV1>,
  ): AgentTranscriptReceiptRefV1 {
    if (candidate.appendId !== appendId)
      throw new TypeError("Agent transcript replay append identity mismatch");
    const canonical = this.#options.store.validateAgentTranscriptReceiptRef({
      sessionId: identity.fence.sessionId,
      runId: identity.fence.runId,
      turnId: identity.fence.turnId,
      generation: identity.fence.generation,
      transcriptAnchor: identity.transcriptAnchor,
      receipt: candidate,
    });
    if (!canonical) throw new TypeError("Agent transcript replay receipt is missing");
    return canonical;
  }
}

function terminal(
  result: Readonly<AgentGatewayAdapterResult>,
  receipt: AgentTranscriptReceiptRefV1,
  pending: readonly string[] | undefined,
): AgentGatewayTranscriptTerminal {
  const refs = Object.freeze([receipt]);
  const outputDigest = result.outcome.outputDigest ?? receipt.requestDigest;
  const kernelTerminal: AgentOperationKernelTerminalV1 = Object.freeze({
    outputDigest,
    outcomeCode: outcomeCode(result),
    transcriptRefs: refs,
    ...(pending === undefined ? {} : { pendingToolUseEntryIds: pending }),
  });
  return Object.freeze({ refs, kernelTerminal });
}

function outcomeCode(result: Readonly<AgentGatewayAdapterResult>): string {
  return result.outcome.code ??
    (result.outcome.status === "succeeded"
      ? "ok"
      : result.outcome.status === "cancelled"
        ? "cancelled"
        : "operation_failed");
}

function validateRendered(
  kind: AgentOperationIdentity["kind"],
  rendered: AgentTranscriptRenderResult,
): AgentTranscriptRenderResult {
  if (!rendered || typeof rendered !== "object" || !Object.isFrozen(rendered))
    throw new TypeError("Agent transcript renderer returned mutable evidence");
  if (!Array.isArray(rendered.entries) || !Object.isFrozen(rendered.entries) || rendered.entries.length < 1)
    throw new TypeError("Agent transcript renderer returned invalid entries");
  if (rendered.entries.length > TRANSCRIPT_DESTINATION_MAX_ENTRIES)
    throw new RangeError("Agent transcript renderer exceeded entry limit");
  if (rendered.entries.some((entry) => !entry || typeof entry !== "object" || !Object.isFrozen(entry)))
    throw new TypeError("Agent transcript renderer returned mutable entries");
  if (new Set(rendered.entries.map((entry) => entry.id)).size !== rendered.entries.length)
    throw new TypeError("Agent transcript renderer returned duplicate entry IDs");
  // Bound before invoking the store. JSON serialization also rejects cycles;
  // the store remains authoritative for the complete strict entry schema.
  let json: string;
  try { json = JSON.stringify(rendered.entries); } catch { throw new TypeError("Agent transcript renderer returned invalid entries"); }
  if (Buffer.byteLength(json) > TRANSCRIPT_DESTINATION_MAX_BYTES)
    throw new RangeError("Agent transcript renderer exceeded byte limit");
  const pending = validatePending(kind, rendered.pendingToolUseEntryIds, rendered.entries.map((entry) => entry.id));
  return Object.freeze({ entries: rendered.entries, ...(pending === undefined ? {} : { pendingToolUseEntryIds: pending }) });
}

function validatePending(
  kind: AgentOperationIdentity["kind"],
  value: readonly string[] | undefined,
  entryIds: readonly string[],
): readonly string[] | undefined {
  if (kind === "mcp") {
    if (value !== undefined) throw new TypeError("MCP transcript cannot carry pending tool uses");
    return undefined;
  }
  if (!Array.isArray(value) || !Object.isFrozen(value) || value.length > MAX_PENDING_TOOL_USES)
    throw new TypeError("Model transcript pending tool uses are invalid");
  let prior = -1;
  for (const id of value) {
    if (typeof id !== "string" || id.length < 1 || id.length > 256)
      throw new TypeError("Model transcript pending tool use ID is invalid");
    const index = entryIds.indexOf(id);
    if (index <= prior) throw new TypeError("Model transcript pending tool uses are not ordered entries");
    prior = index;
  }
  return Object.freeze([...value]);
}

function terminalAppendId(identity: Readonly<AgentOperationIdentity>): string {
  return digestAppendId("terminal", canonicalIdentity(identity));
}

function reservationAppendId(reservationId: string): string {
  if (typeof reservationId !== "string" || reservationId.length < 1)
    throw new TypeError("Invalid Agent transcript reservation identity");
  return digestAppendId("indeterminate", reservationId);
}

function digestAppendId(kind: string, material: string): string {
  const digest = new Bun.CryptoHasher("sha256")
    .update(APPEND_ID_DOMAIN)
    .update(kind)
    .update("\0")
    .update(material)
    .digest("hex");
  return `agent-${kind}:${digest}`;
}

function canonicalIdentity(identity: Readonly<AgentOperationIdentity>): string {
  // Descriptor and anchors are protocol-decoded plain immutable JSON. Sorting
  // recursively avoids caller property insertion order influencing ownership.
  return canonicalJson(identity);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sameReservation(
  a: Readonly<AgentOperationTerminalReservation>,
  b: Readonly<AgentOperationTerminalReservation>,
): boolean {
  return a.reservationId === b.reservationId && a.reason === b.reason && a.reservedAtMs === b.reservedAtMs;
}
