/**
 * Versioned control-plane ↔ Executor wire contract.
 *
 * An Executor is a tool/workspace boundary. It can manipulate files, processes,
 * terminals, services, and portals inside a granted execution root. It never
 * receives model-loop state: prompts, model/account configuration, MCP policy,
 * transcript state, and provider credentials belong to the control plane.
 */

export const EXECUTOR_PROTOCOL_VERSION = 3 as const;
export const EXECUTOR_PROTOCOL_MIN_VERSION = EXECUTOR_PROTOCOL_VERSION;

export function executorSocketPath(sessionsDir: string): string {
  return `${sessionsDir}/executor.sock`;
}

/** An authorization capability whose contents are deliberately unspecified. */
declare const executorGrantBrand: unique symbol;
export type ExecutorGrant = string & {
  readonly [executorGrantBrand]: "ExecutorGrant";
};

/** Every operation is scoped to one root and one generation of one run. */
export interface ExecutorFence {
  rootId: string;
  sessionId: string;
  runId: string;
  generation: number;
  /** Epoch milliseconds. Executors reject work once this time has passed. */
  deadlineMs: number;
}

const MAX_GRANT_BYTES = 16 * 1024;
export const EXECUTOR_GRANT_PREFIX = "osexec_operation_v1." as const;
const CAPABILITY_BODY_RE = /^[A-Za-z0-9_-]{32,512}$/;
export const MAX_EXECUTOR_FILE_WRITE_BYTES = 4 * 1024 * 1024;
export const MAX_EXECUTOR_TERMINAL_WRITE_BYTES = 1024 * 1024;
export const MAX_EXECUTOR_STREAM_EVENT_BYTES = 256 * 1024;
const MAX_EXECUTOR_FIELD_BYTES = 256 * 1024;
const MAX_EXECUTOR_ARGUMENT_BYTES = 1024 * 1024;
const MAX_EXECUTOR_ARGUMENTS = 4_096;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const textEncoder = new TextEncoder();

export function decodeExecutorId(value: unknown): string | undefined {
  return typeof value === "string" && ID_RE.test(value) ? value : undefined;
}

/** Runtime domain separation is part of the wire format, not only a TS brand. */
export function encodeExecutorGrant(entropy: string): ExecutorGrant {
  if (!CAPABILITY_BODY_RE.test(entropy))
    throw new Error("Invalid Executor grant entropy");
  return `${EXECUTOR_GRANT_PREFIX}${entropy}` as ExecutorGrant;
}

export function decodeExecutorGrant(value: unknown): ExecutorGrant | undefined {
  if (
    typeof value !== "string" ||
    textEncoder.encode(value).byteLength > MAX_GRANT_BYTES ||
    !value.startsWith(EXECUTOR_GRANT_PREFIX) ||
    !CAPABILITY_BODY_RE.test(value.slice(EXECUTOR_GRANT_PREFIX.length))
  )
    return undefined;
  return value as ExecutorGrant;
}

/** A small pure fence decoder for both transports and provider adapters. */
export function decodeExecutorFence(
  value: unknown,
  nowMs = Date.now(),
): ExecutorFence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const fence = value as Record<string, unknown>;
  if (
    Object.keys(fence).some(
      (key) =>
        !["rootId", "sessionId", "runId", "generation", "deadlineMs"].includes(
          key,
        ),
    ) ||
    typeof fence.rootId !== "string" ||
    !ID_RE.test(fence.rootId) ||
    typeof fence.sessionId !== "string" ||
    !ID_RE.test(fence.sessionId) ||
    typeof fence.runId !== "string" ||
    !ID_RE.test(fence.runId) ||
    !Number.isSafeInteger(fence.generation) ||
    (fence.generation as number) < 0 ||
    !Number.isSafeInteger(fence.deadlineMs) ||
    (fence.deadlineMs as number) <= nowMs
  ) {
    return undefined;
  }
  return {
    rootId: fence.rootId,
    sessionId: fence.sessionId,
    runId: fence.runId,
    generation: fence.generation as number,
    deadlineMs: fence.deadlineMs as number,
  };
}

interface ExecutorMessageBase {
  version: typeof EXECUTOR_PROTOCOL_VERSION;
  requestId: string;
}

export type ExecutorCapability =
  | "fs"
  | "process"
  | "terminal"
  | "service"
  | "portal";

/** Public incarnation metadata. Authentication happens before this frame is accepted. */
export interface ExecutorConnectionIdentity {
  executorId: string;
  instanceId: string;
  generation: number;
  capabilities: ExecutorCapability[];
}

interface ExecutorAuthorizedMessage extends ExecutorMessageBase {
  grant: ExecutorGrant;
  fence: ExecutorFence;
}

interface ExecutorMutation {
  /** Stable across retries of the same mutation. */
  idempotencyKey: string;
}

export interface ExecutorBinaryStreamMetadata {
  encoding: "base64";
  byteLength: number;
  mediaType?: string;
  sha256?: string;
}

export type ExecutorFsOperation =
  | { kind: "fs.read"; path: string; offset?: number; length?: number }
  | { kind: "fs.list"; path: string; recursive?: boolean }
  | { kind: "fs.stat"; path: string }
  | ({
      kind: "fs.write";
      path: string;
      data: string;
      encoding: "utf8" | "base64";
      create?: boolean;
    } & ExecutorMutation)
  | ({ kind: "fs.mkdir"; path: string; recursive?: boolean } & ExecutorMutation)
  | ({
      kind: "fs.remove";
      path: string;
      recursive?: boolean;
    } & ExecutorMutation)
  | ({
      kind: "fs.move";
      from: string;
      to: string;
      replace?: boolean;
    } & ExecutorMutation);

export type ExecutorProcessOperation =
  | ({
      kind: "process.spawn";
      executable: string;
      args: string[];
      cwd?: string;
      stdin?: "pipe" | "closed";
    } & ExecutorMutation)
  | { kind: "process.status"; processId: string }
  | ({
      kind: "process.signal";
      processId: string;
      signal: "interrupt" | "terminate" | "kill";
    } & ExecutorMutation);

export type ExecutorTerminalOperation =
  | ({
      kind: "terminal.open";
      executable?: string;
      args?: string[];
      cwd?: string;
      columns: number;
      rows: number;
    } & ExecutorMutation)
  | ({
      kind: "terminal.write";
      terminalId: string;
      data: string;
    } & ExecutorMutation)
  | ({
      kind: "terminal.resize";
      terminalId: string;
      columns: number;
      rows: number;
    } & ExecutorMutation)
  | ({ kind: "terminal.close"; terminalId: string } & ExecutorMutation);

export type ExecutorServiceOperation =
  | ({
      kind: "service.start";
      name: string;
      executable: string;
      args: string[];
      cwd?: string;
    } & ExecutorMutation)
  | { kind: "service.status"; serviceId: string }
  | ({ kind: "service.stop"; serviceId: string } & ExecutorMutation);

export type ExecutorPortalOperation =
  | ({ kind: "portal.open"; name: string; port: number } & ExecutorMutation)
  | { kind: "portal.status"; portalId: string }
  | ({ kind: "portal.close"; portalId: string } & ExecutorMutation);

export type ExecutorOperation =
  | ExecutorFsOperation
  | ExecutorProcessOperation
  | ExecutorTerminalOperation
  | ExecutorServiceOperation
  | ExecutorPortalOperation;

const operationKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const nonemptyString = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  textEncoder.encode(value).byteLength <= MAX_EXECUTOR_FIELD_BYTES;
const optionalBoolean = (value: unknown) =>
  value === undefined || typeof value === "boolean";
const optionalString = (value: unknown) =>
  value === undefined ||
  (typeof value === "string" &&
    textEncoder.encode(value).byteLength <= MAX_EXECUTOR_FIELD_BYTES);
const stringArguments = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_EXECUTOR_ARGUMENTS &&
  value.every((arg) => typeof arg === "string") &&
  value.reduce((bytes, arg) => bytes + textEncoder.encode(arg).byteLength, 0) <=
    MAX_EXECUTOR_ARGUMENT_BYTES;
const nonnegativeInteger = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const positiveInteger = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) > 0;
const mutationKey = (value: Record<string, unknown>) =>
  nonemptyString(value.idempotencyKey);
const operationStringWithin = (value: unknown, maxBytes: number) =>
  typeof value === "string" && textEncoder.encode(value).byteLength <= maxBytes;

/** Strictly decode the untrusted operation union before classifying retries. */
export function decodeExecutorOperation(
  input: unknown,
): ExecutorOperation | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  switch (value.kind) {
    case "fs.read":
      if (
        operationKeys(value, ["kind", "path", "offset", "length"]) &&
        nonemptyString(value.path) &&
        (value.offset === undefined || nonnegativeInteger(value.offset)) &&
        (value.length === undefined || nonnegativeInteger(value.length))
      )
        return value as ExecutorOperation;
      break;
    case "fs.list":
      if (
        operationKeys(value, ["kind", "path", "recursive"]) &&
        nonemptyString(value.path) &&
        optionalBoolean(value.recursive)
      )
        return value as ExecutorOperation;
      break;
    case "fs.stat":
      if (operationKeys(value, ["kind", "path"]) && nonemptyString(value.path))
        return value as ExecutorOperation;
      break;
    case "fs.write":
      if (
        operationKeys(value, [
          "kind",
          "path",
          "data",
          "encoding",
          "create",
          "idempotencyKey",
        ]) &&
        nonemptyString(value.path) &&
        operationStringWithin(value.data, MAX_EXECUTOR_FILE_WRITE_BYTES) &&
        (value.encoding === "utf8" || value.encoding === "base64") &&
        optionalBoolean(value.create) &&
        mutationKey(value)
      )
        return value as ExecutorOperation;
      break;
    case "fs.mkdir":
    case "fs.remove":
      if (
        operationKeys(value, ["kind", "path", "recursive", "idempotencyKey"]) &&
        nonemptyString(value.path) &&
        optionalBoolean(value.recursive) &&
        mutationKey(value)
      )
        return value as ExecutorOperation;
      break;
    case "fs.move":
      if (
        operationKeys(value, [
          "kind",
          "from",
          "to",
          "replace",
          "idempotencyKey",
        ]) &&
        nonemptyString(value.from) &&
        nonemptyString(value.to) &&
        optionalBoolean(value.replace) &&
        mutationKey(value)
      )
        return value as ExecutorOperation;
      break;
    case "process.spawn":
      if (
        operationKeys(value, [
          "kind",
          "executable",
          "args",
          "cwd",
          "stdin",
          "idempotencyKey",
        ]) &&
        nonemptyString(value.executable) &&
        stringArguments(value.args) &&
        optionalString(value.cwd) &&
        (value.stdin === undefined ||
          value.stdin === "pipe" ||
          value.stdin === "closed") &&
        mutationKey(value)
      )
        return value as ExecutorOperation;
      break;
    case "process.status":
      if (
        operationKeys(value, ["kind", "processId"]) &&
        nonemptyString(value.processId)
      )
        return value as ExecutorOperation;
      break;
    case "process.signal":
      if (
        operationKeys(value, [
          "kind",
          "processId",
          "signal",
          "idempotencyKey",
        ]) &&
        nonemptyString(value.processId) &&
        (value.signal === "interrupt" ||
          value.signal === "terminate" ||
          value.signal === "kill") &&
        mutationKey(value)
      )
        return value as ExecutorOperation;
      break;
    case "terminal.open":
      if (
        operationKeys(value, [
          "kind",
          "executable",
          "args",
          "cwd",
          "columns",
          "rows",
          "idempotencyKey",
        ]) &&
        optionalString(value.executable) &&
        (value.args === undefined || stringArguments(value.args)) &&
        optionalString(value.cwd) &&
        positiveInteger(value.columns) &&
        positiveInteger(value.rows) &&
        mutationKey(value)
      )
        return value as ExecutorOperation;
      break;
    case "terminal.write":
      if (
        operationKeys(value, [
          "kind",
          "terminalId",
          "data",
          "idempotencyKey",
        ]) &&
        nonemptyString(value.terminalId) &&
        operationStringWithin(value.data, MAX_EXECUTOR_TERMINAL_WRITE_BYTES) &&
        mutationKey(value)
      )
        return value as ExecutorOperation;
      break;
    case "terminal.resize":
      if (
        operationKeys(value, [
          "kind",
          "terminalId",
          "columns",
          "rows",
          "idempotencyKey",
        ]) &&
        nonemptyString(value.terminalId) &&
        positiveInteger(value.columns) &&
        positiveInteger(value.rows) &&
        mutationKey(value)
      )
        return value as ExecutorOperation;
      break;
    case "terminal.close":
      if (
        operationKeys(value, ["kind", "terminalId", "idempotencyKey"]) &&
        nonemptyString(value.terminalId) &&
        mutationKey(value)
      )
        return value as ExecutorOperation;
      break;
    case "service.start":
      if (
        operationKeys(value, [
          "kind",
          "name",
          "executable",
          "args",
          "cwd",
          "idempotencyKey",
        ]) &&
        nonemptyString(value.name) &&
        nonemptyString(value.executable) &&
        stringArguments(value.args) &&
        optionalString(value.cwd) &&
        mutationKey(value)
      )
        return value as ExecutorOperation;
      break;
    case "service.status":
      if (
        operationKeys(value, ["kind", "serviceId"]) &&
        nonemptyString(value.serviceId)
      )
        return value as ExecutorOperation;
      break;
    case "service.stop":
      if (
        operationKeys(value, ["kind", "serviceId", "idempotencyKey"]) &&
        nonemptyString(value.serviceId) &&
        mutationKey(value)
      )
        return value as ExecutorOperation;
      break;
    case "portal.open":
      if (
        operationKeys(value, ["kind", "name", "port", "idempotencyKey"]) &&
        nonemptyString(value.name) &&
        positiveInteger(value.port) &&
        (value.port as number) <= 65_535 &&
        mutationKey(value)
      )
        return value as ExecutorOperation;
      break;
    case "portal.status":
      if (
        operationKeys(value, ["kind", "portalId"]) &&
        nonemptyString(value.portalId)
      )
        return value as ExecutorOperation;
      break;
    case "portal.close":
      if (
        operationKeys(value, ["kind", "portalId", "idempotencyKey"]) &&
        nonemptyString(value.portalId) &&
        mutationKey(value)
      )
        return value as ExecutorOperation;
      break;
  }
  return undefined;
}

export type ExecutorReceiptState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ExecutorReceipt {
  receiptId: string;
  requestId: string;
  state: ExecutorReceiptState;
  acceptedAt: string;
  idempotencyKey?: string;
  completedAt?: string;
}

export type ExecutorOperationOutcome =
  | { kind: "fs.read"; streamId: string; size: number; binary: boolean }
  | {
      kind: "fs.list";
      entries: Array<{
        path: string;
        type: "file" | "directory" | "symlink";
        size?: number;
      }>;
    }
  | {
      kind: "fs.stat";
      entry: {
        path: string;
        type: "file" | "directory" | "symlink";
        size: number;
        modifiedAt?: string;
      };
    }
  | { kind: "fs.changed"; path: string }
  | {
      kind: "process";
      processId: string;
      state: "starting" | "running" | "exited";
      exitCode?: number;
      streamId?: string;
    }
  | {
      kind: "terminal";
      terminalId: string;
      state: "open" | "closed";
      streamId?: string;
    }
  | {
      kind: "service";
      serviceId: string;
      state: "starting" | "running" | "stopped" | "failed";
      streamId?: string;
    }
  | {
      kind: "portal";
      portalId: string;
      state: "opening" | "open" | "closed" | "failed";
    };

/** Reject plausible-looking outcomes that do not belong to the requested operation family. */
export function isExecutorOutcomeCompatible(
  operation: ExecutorOperation,
  outcome: ExecutorOperationOutcome,
): boolean {
  switch (operation.kind) {
    case "fs.read":
      return outcome.kind === "fs.read";
    case "fs.list":
      return outcome.kind === "fs.list";
    case "fs.stat":
      return outcome.kind === "fs.stat";
    case "fs.write":
    case "fs.mkdir":
    case "fs.remove":
      return outcome.kind === "fs.changed" && outcome.path === operation.path;
    case "fs.move":
      return outcome.kind === "fs.changed" && outcome.path === operation.to;
    case "process.spawn":
      return outcome.kind === "process";
    case "process.status":
    case "process.signal":
      return (
        outcome.kind === "process" && outcome.processId === operation.processId
      );
    case "terminal.open":
      return outcome.kind === "terminal";
    case "terminal.write":
    case "terminal.resize":
    case "terminal.close":
      return (
        outcome.kind === "terminal" &&
        outcome.terminalId === operation.terminalId
      );
    case "service.start":
      return outcome.kind === "service";
    case "service.status":
    case "service.stop":
      return (
        outcome.kind === "service" && outcome.serviceId === operation.serviceId
      );
    case "portal.open":
      return outcome.kind === "portal";
    case "portal.status":
    case "portal.close":
      return (
        outcome.kind === "portal" && outcome.portalId === operation.portalId
      );
  }
}

export type ExecutorStreamEvent =
  | {
      kind: "text";
      streamId: string;
      sequence: number;
      channel: "stdout" | "stderr" | "terminal" | "file";
      data: string;
      eof?: boolean;
    }
  | {
      kind: "binary";
      streamId: string;
      sequence: number;
      offset: number;
      data: string;
      metadata: ExecutorBinaryStreamMetadata;
      eof?: boolean;
    }
  | {
      kind: "exit";
      streamId: string;
      sequence: number;
      exitCode: number | null;
      signal?: string;
    };

/** Exact-version handshake followed by fenced, capability-authorized work. */
export type ExecutorClientMessage =
  | (ExecutorMessageBase & ExecutorConnectionIdentity & { t: "hello" })
  | (ExecutorAuthorizedMessage & { t: "execute"; operation: ExecutorOperation })
  | (ExecutorAuthorizedMessage & { t: "receipt_status"; receiptId: string })
  | (ExecutorAuthorizedMessage & {
      t: "cancel";
      target:
        | { requestId: string }
        | { receiptId: string }
        | { streamId: string; requestId: string };
      idempotencyKey: string;
    })
  | (ExecutorAuthorizedMessage & {
      t: "stream_credit";
      streamId: string;
      bytes: number;
    });

export type ExecutorErrorCode =
  | "unsupported_version"
  | "invalid_request"
  | "invalid_grant"
  | "stale_generation"
  | "deadline_exceeded"
  | "not_found"
  | "conflict"
  | "cancelled"
  | "operation_failed"
  | "executor_busy"
  | "unsupported";

export type ExecutorServerMessage =
  | (ExecutorMessageBase &
      ExecutorConnectionIdentity & { t: "hello"; accepted: true })
  | (ExecutorMessageBase & { t: "receipt"; receipt: ExecutorReceipt })
  | (ExecutorMessageBase & {
      t: "receipt_status";
      receipt: ExecutorReceipt;
      outcome?: ExecutorOperationOutcome;
      error?: { code: ExecutorErrorCode; message: string; ambiguous?: boolean };
      eventsComplete?: true;
    })
  | (ExecutorMessageBase & { t: "event"; event: ExecutorStreamEvent })
  | (ExecutorMessageBase & {
      t: "error";
      code: ExecutorErrorCode;
      message: string;
      receipt?: ExecutorReceipt;
    });

const executorErrorCodes = new Set<ExecutorErrorCode>([
  "unsupported_version",
  "invalid_request",
  "invalid_grant",
  "stale_generation",
  "deadline_exceeded",
  "not_found",
  "conflict",
  "cancelled",
  "operation_failed",
  "executor_busy",
  "unsupported",
]);

/** Strictly decode untrusted non-handshake messages from an Executor. */
export function decodeExecutorServerMessage(
  value: unknown,
): Exclude<ExecutorServerMessage, { t: "hello" }> | undefined {
  if (!plainRecord(value)) return undefined;
  const common = ["t", "version", "requestId"];
  const only = (extra: string[]) =>
    Object.keys(value).every(
      (key) => common.includes(key) || extra.includes(key),
    );
  if (
    value.version !== EXECUTOR_PROTOCOL_VERSION ||
    !decodeExecutorId(value.requestId)
  )
    return undefined;
  if (value.t === "receipt") {
    const receipt = decodeReceipt(value.receipt);
    return receipt && only(["receipt"])
      ? {
          t: "receipt",
          version: EXECUTOR_PROTOCOL_VERSION,
          requestId: value.requestId as string,
          receipt,
        }
      : undefined;
  }
  if (value.t === "event") {
    const event = decodeStreamEvent(value.event);
    return event && only(["event"])
      ? {
          t: "event",
          version: EXECUTOR_PROTOCOL_VERSION,
          requestId: value.requestId as string,
          event,
        }
      : undefined;
  }
  if (value.t === "error") {
    const receipt =
      value.receipt === undefined ? undefined : decodeReceipt(value.receipt);
    if (
      !only(["code", "message", "receipt"]) ||
      typeof value.code !== "string" ||
      !executorErrorCodes.has(value.code as ExecutorErrorCode) ||
      !boundedWireString(value.message, 256 * 1024, true) ||
      (value.receipt !== undefined && !receipt)
    )
      return undefined;
    return {
      t: "error",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: value.requestId as string,
      code: value.code as ExecutorErrorCode,
      message: value.message,
      ...(receipt ? { receipt } : {}),
    };
  }
  if (value.t === "receipt_status") {
    const receipt = decodeReceipt(value.receipt);
    const outcome =
      value.outcome === undefined ? undefined : decodeOutcome(value.outcome);
    const error =
      value.error === undefined ? undefined : decodeTerminalError(value.error);
    if (
      !receipt ||
      !only(["receipt", "outcome", "error", "eventsComplete"]) ||
      (value.eventsComplete !== undefined && value.eventsComplete !== true) ||
      (value.outcome !== undefined && !outcome) ||
      (value.error !== undefined && !error)
    )
      return undefined;
    if (
      receipt.state === "succeeded"
        ? !outcome || !!error
        : receipt.state === "failed" || receipt.state === "cancelled"
          ? !error || !!outcome
          : !!outcome || !!error
    )
      return undefined;
    return {
      t: "receipt_status",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: value.requestId as string,
      receipt,
      ...(outcome ? { outcome } : {}),
      ...(error ? { error } : {}),
      ...(value.eventsComplete === true ? { eventsComplete: true } : {}),
    };
  }
  return undefined;
}

function decodeReceipt(value: unknown): ExecutorReceipt | undefined {
  if (
    !plainRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "receiptId",
          "requestId",
          "state",
          "acceptedAt",
          "idempotencyKey",
          "completedAt",
        ].includes(key),
    ) ||
    !decodeExecutorId(value.receiptId) ||
    !decodeExecutorId(value.requestId) ||
    !["queued", "running", "succeeded", "failed", "cancelled"].includes(
      value.state as string,
    ) ||
    !isoWireDate(value.acceptedAt) ||
    (value.idempotencyKey !== undefined &&
      !boundedWireString(value.idempotencyKey, 256 * 1024, true))
  )
    return undefined;
  const terminal =
    value.state === "succeeded" ||
    value.state === "failed" ||
    value.state === "cancelled";
  if (
    terminal !== (value.completedAt !== undefined) ||
    (value.completedAt !== undefined && !isoWireDate(value.completedAt))
  )
    return undefined;
  return value as unknown as ExecutorReceipt;
}
function decodeOutcome(value: unknown): ExecutorOperationOutcome | undefined {
  if (!plainRecord(value) || typeof value.kind !== "string") return undefined;
  const only = (keys: string[]) =>
    Object.keys(value).every((key) => keys.includes(key));
  const id = (input: unknown) => !!decodeExecutorId(input);
  if (
    value.kind === "fs.read" &&
    only(["kind", "streamId", "size", "binary"]) &&
    id(value.streamId) &&
    nonnegativeInteger(value.size) &&
    typeof value.binary === "boolean"
  )
    return value as unknown as ExecutorOperationOutcome;
  if (
    value.kind === "fs.list" &&
    only(["kind", "entries"]) &&
    Array.isArray(value.entries) &&
    value.entries.length <= 4096 &&
    value.entries.every(
      (e) =>
        plainRecord(e) &&
        Object.keys(e).every((k) => ["path", "type", "size"].includes(k)) &&
        boundedWireString(e.path, 256 * 1024, true) &&
        ["file", "directory", "symlink"].includes(e.type as string) &&
        (e.size === undefined || nonnegativeInteger(e.size)),
    )
  )
    return value as unknown as ExecutorOperationOutcome;
  if (
    value.kind === "fs.stat" &&
    only(["kind", "entry"]) &&
    plainRecord(value.entry) &&
    Object.keys(value.entry).every((k) =>
      ["path", "type", "size", "modifiedAt"].includes(k),
    ) &&
    boundedWireString(value.entry.path, 256 * 1024, true) &&
    ["file", "directory", "symlink"].includes(value.entry.type as string) &&
    nonnegativeInteger(value.entry.size) &&
    (value.entry.modifiedAt === undefined ||
      isoWireDate(value.entry.modifiedAt))
  )
    return value as unknown as ExecutorOperationOutcome;
  if (
    value.kind === "fs.changed" &&
    only(["kind", "path"]) &&
    boundedWireString(value.path, 256 * 1024, true)
  )
    return value as unknown as ExecutorOperationOutcome;
  const ids: Record<string, string> = {
    process: "processId",
    terminal: "terminalId",
    service: "serviceId",
    portal: "portalId",
  };
  const states: Record<string, string[]> = {
    process: ["starting", "running", "exited"],
    terminal: ["open", "closed"],
    service: ["starting", "running", "stopped", "failed"],
    portal: ["opening", "open", "closed", "failed"],
  };
  const idKey = ids[value.kind];
  if (!idKey) return undefined;
  const allowed = [
    "kind",
    idKey,
    "state",
    ...(value.kind === "portal" ? [] : ["streamId"]),
    ...(value.kind === "process" ? ["exitCode"] : []),
  ];
  if (
    only(allowed) &&
    id(value[idKey]) &&
    states[value.kind]!.includes(value.state as string) &&
    (value.streamId === undefined || id(value.streamId)) &&
    (value.exitCode === undefined || Number.isSafeInteger(value.exitCode))
  )
    return value as unknown as ExecutorOperationOutcome;
  return undefined;
}
function decodeStreamEvent(value: unknown): ExecutorStreamEvent | undefined {
  if (
    !plainRecord(value) ||
    !decodeExecutorId(value.streamId) ||
    !nonnegativeInteger(value.sequence)
  )
    return undefined;
  const only = (keys: string[]) =>
    Object.keys(value).every((key) => keys.includes(key));
  const eof = value.eof === undefined || typeof value.eof === "boolean";
  if (
    value.kind === "text" &&
    only(["kind", "streamId", "sequence", "channel", "data", "eof"]) &&
    ["stdout", "stderr", "terminal", "file"].includes(
      value.channel as string,
    ) &&
    boundedWireString(value.data, 256 * 1024) &&
    eof
  )
    return value as unknown as ExecutorStreamEvent;
  if (
    value.kind === "exit" &&
    only(["kind", "streamId", "sequence", "exitCode", "signal"]) &&
    (value.exitCode === null || Number.isSafeInteger(value.exitCode)) &&
    (value.signal === undefined || boundedWireString(value.signal, 256, true))
  )
    return value as unknown as ExecutorStreamEvent;
  if (
    value.kind === "binary" &&
    only([
      "kind",
      "streamId",
      "sequence",
      "offset",
      "data",
      "metadata",
      "eof",
    ]) &&
    nonnegativeInteger(value.offset) &&
    boundedWireString(value.data, 256 * 1024) &&
    eof &&
    plainRecord(value.metadata) &&
    Object.keys(value.metadata).every((k) =>
      ["encoding", "byteLength", "mediaType", "sha256"].includes(k),
    ) &&
    value.metadata.encoding === "base64" &&
    nonnegativeInteger(value.metadata.byteLength) &&
    canonicalBase64(
      value.data as string,
      value.metadata.byteLength as number,
    ) &&
    (value.metadata.mediaType === undefined ||
      boundedWireString(value.metadata.mediaType, 256, true)) &&
    (value.metadata.sha256 === undefined ||
      (typeof value.metadata.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(value.metadata.sha256)))
  )
    return value as unknown as ExecutorStreamEvent;
  return undefined;
}
function decodeTerminalError(
  value: unknown,
):
  | { code: ExecutorErrorCode; message: string; ambiguous?: boolean }
  | undefined {
  if (
    !plainRecord(value) ||
    Object.keys(value).some(
      (key) => !["code", "message", "ambiguous"].includes(key),
    ) ||
    typeof value.code !== "string" ||
    !executorErrorCodes.has(value.code as ExecutorErrorCode) ||
    !boundedWireString(value.message, 256 * 1024, true) ||
    (value.ambiguous !== undefined && typeof value.ambiguous !== "boolean")
  )
    return undefined;
  return value as {
    code: ExecutorErrorCode;
    message: string;
    ambiguous?: boolean;
  };
}
function canonicalBase64(value: string, length: number): boolean {
  try {
    const binary = atob(value);
    return binary.length === length && btoa(binary) === value;
  } catch {
    return false;
  }
}
function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function boundedWireString(
  value: unknown,
  max: number,
  nonempty = false,
): value is string {
  return (
    typeof value === "string" &&
    (!nonempty || value.length > 0) &&
    textEncoder.encode(value).byteLength <= max
  );
}
function isoWireDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 32) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** Decode only the handshake because version negotiation must fail before work. */
export function decodeExecutorHello(
  value: unknown,
): Extract<ExecutorClientMessage, { t: "hello" }> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const message = value as Record<string, unknown>;
  const allowed = [
    "t",
    "version",
    "requestId",
    "executorId",
    "instanceId",
    "generation",
    "capabilities",
  ];
  if (
    Object.keys(message).some((key) => !allowed.includes(key)) ||
    message.t !== "hello" ||
    message.version !== EXECUTOR_PROTOCOL_VERSION ||
    typeof message.requestId !== "string" ||
    !ID_RE.test(message.requestId) ||
    typeof message.executorId !== "string" ||
    !ID_RE.test(message.executorId) ||
    typeof message.instanceId !== "string" ||
    !ID_RE.test(message.instanceId) ||
    !Number.isSafeInteger(message.generation) ||
    (message.generation as number) < 0 ||
    !Array.isArray(message.capabilities) ||
    message.capabilities.some(
      (capability) =>
        !["fs", "process", "terminal", "service", "portal"].includes(
          capability as string,
        ),
    ) ||
    new Set(message.capabilities).size !== message.capabilities.length
  ) {
    return undefined;
  }
  return {
    t: "hello",
    version: EXECUTOR_PROTOCOL_VERSION,
    requestId: message.requestId,
    executorId: message.executorId,
    instanceId: message.instanceId,
    generation: message.generation as number,
    capabilities: message.capabilities as ExecutorCapability[],
  };
}

/*
 * Transitional local host-launch contract. The current local coordinator uses
 * these names until its runtime cutover to ExecutorClientMessage. New Executor
 * implementations must use the contract above.
 */

/** @deprecated Transitional local run-host launch state. */
export type ExecutorLaunchState =
  | "starting"
  | "started"
  | "stopped"
  | "failed"
  | "uncertain"
  | "unknown";

/** @deprecated Transitional local run-host launch status. */
export interface ExecutorHostStatus {
  hostId: string;
  specHash?: string;
  unit: string;
  state: ExecutorLaunchState;
  ready: boolean;
  pid?: number;
  error?: string;
}

interface LegacyExecutorRequestBase {
  requestId: string;
  /** @deprecated Replaced by an opaque, operation-scoped ExecutorGrant. */
  token: string;
}

/** @deprecated Use ExecutorClientMessage after the local runtime cutover. */
export type ExecutorRequest =
  | (LegacyExecutorRequestBase & {
      t: "hello";
      minVersion: number;
      maxVersion: number;
    })
  | (LegacyExecutorRequestBase & {
      t: "launch_host";
      version: number;
      hostId: string;
      specHash: string;
    })
  | (LegacyExecutorRequestBase & {
      t: "host_status";
      version: number;
      hostId: string;
      specHash?: string;
    })
  | (LegacyExecutorRequestBase & {
      t: "stop_host";
      version: number;
      hostId: string;
      specHash: string;
    });

/** @deprecated Use ExecutorServerMessage after the local runtime cutover. */
export type ExecutorResponse =
  | {
      requestId: string;
      ok: true;
      version: number;
      compatible?: boolean;
      status?: ExecutorHostStatus;
    }
  | {
      requestId: string;
      ok: false;
      version: number;
      code:
        | "unsupported_version"
        | "invalid_request"
        | "invalid_host"
        | "spec_not_found"
        | "spec_hash_mismatch"
        | "launch_failed"
        | "launch_uncertain"
        | "executor_busy"
        | "stop_failed";
      error: string;
    };
