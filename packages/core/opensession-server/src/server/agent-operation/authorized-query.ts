import type {
  AgentOperationDigest,
  AgentOperationKind,
} from "@tellahq/opensession-protocol/agent-operation";
import type { AgentTurnFence } from "@tellahq/opensession-protocol/agent-host";

const MAX_ID_BYTES = 512;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const encoder = new TextEncoder();

export interface AgentOperationQueryAuthority {
  readonly planHash: AgentOperationDigest;
  readonly authorityHash: AgentOperationDigest;
  readonly supervisorEpoch: number;
  readonly hostId: string;
  readonly hostGeneration: number;
  readonly hostIncarnation: string;
}

interface AgentOperationAuthorizedQueryBase {
  readonly operationId: string;
  readonly kind: AgentOperationKind;
  readonly fence: Readonly<AgentTurnFence>;
  readonly descriptorDigest: AgentOperationDigest;
  /** Authority freshly obtained by verifying the signed supervision envelope. */
  readonly authority: Readonly<AgentOperationQueryAuthority>;
}

/**
 * A normal query binds the payload. Only an explicitly labelled recovery query
 * may omit it; recovery remains bound to the full fence, descriptor and Host
 * supervision authority.
 */
export type AgentOperationAuthorizedQuery =
  | (AgentOperationAuthorizedQueryBase & {
      readonly mode: "exact";
      readonly payloadDigest: AgentOperationDigest;
    })
  | (AgentOperationAuthorizedQueryBase & {
      readonly mode: "recovery";
      readonly payloadDigest?: AgentOperationDigest;
    });

const BASE_KEYS = [
  "mode",
  "operationId",
  "kind",
  "fence",
  "descriptorDigest",
  "authority",
] as const;

/** Snapshots and strictly validates untrusted coordinator query input. */
export function decodeAgentOperationAuthorizedQuery(
  input: unknown,
): AgentOperationAuthorizedQuery {
  const top = exactDataRecord(
    input,
    hasOwnDataValue(input, "payloadDigest")
      ? [...BASE_KEYS, "payloadDigest"]
      : BASE_KEYS,
    "authorized Agent operation query",
  );
  if (top.mode !== "exact" && top.mode !== "recovery")
    throw new TypeError("invalid authorized Agent operation query mode");
  if (top.mode === "exact" && !hasOwnDataValue(top, "payloadDigest"))
    throw new TypeError("exact Agent operation query requires payload digest");
  if (top.kind !== "model" && top.kind !== "mcp")
    throw new TypeError("invalid Agent operation query kind");

  const fenceRecord = exactDataRecord(
    top.fence,
    ["sessionId", "runId", "turnId", "generation"],
    "Agent operation query fence",
  );
  const authorityRecord = exactDataRecord(
    top.authority,
    [
      "planHash",
      "authorityHash",
      "supervisorEpoch",
      "hostId",
      "hostGeneration",
      "hostIncarnation",
    ],
    "Agent operation query authority",
  );
  const fence = Object.freeze({
    sessionId: validText(fenceRecord.sessionId, "session ID"),
    runId: validText(fenceRecord.runId, "run ID"),
    turnId: validText(fenceRecord.turnId, "turn ID"),
    generation: nonnegative(fenceRecord.generation, "fence generation"),
  });
  const authority = Object.freeze({
    planHash: digest(authorityRecord.planHash, "plan hash"),
    authorityHash: digest(authorityRecord.authorityHash, "authority hash"),
    supervisorEpoch: positive(
      authorityRecord.supervisorEpoch,
      "supervisor epoch",
    ),
    hostId: validText(authorityRecord.hostId, "Host ID"),
    hostGeneration: positive(authorityRecord.hostGeneration, "Host generation"),
    hostIncarnation: validText(
      authorityRecord.hostIncarnation,
      "Host incarnation",
    ),
  });
  const common = {
    mode: top.mode,
    operationId: validText(top.operationId, "operation ID"),
    kind: top.kind,
    fence,
    descriptorDigest: digest(top.descriptorDigest, "descriptor digest"),
    authority,
  };
  return Object.freeze(
    hasOwnDataValue(top, "payloadDigest")
      ? {
          ...common,
          payloadDigest: digest(top.payloadDigest, "payload digest"),
        }
      : common,
  ) as AgentOperationAuthorizedQuery;
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  name: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new TypeError(`invalid ${name}`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  )
    throw new TypeError(`invalid ${name}`);
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      descriptor.value === undefined
    )
      throw new TypeError(`invalid ${name}`);
  }
  return Object.fromEntries(
    (keys as string[]).map((key) => [key, descriptors[key]!.value]),
  );
}

function hasOwnDataValue(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return (
    !!descriptor && "value" in descriptor && descriptor.value !== undefined
  );
}

function validText(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    encoder.encode(value).byteLength > MAX_ID_BYTES ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new TypeError(`invalid ${name}`);
  return value;
}

function digest(value: unknown, name: string): AgentOperationDigest {
  if (typeof value !== "string" || !DIGEST.test(value))
    throw new TypeError(`invalid ${name}`);
  return value as AgentOperationDigest;
}

function nonnegative(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`invalid ${name}`);
  return value as number;
}

function positive(value: unknown, name: string): number {
  const result = nonnegative(value, name);
  if (result < 1) throw new TypeError(`invalid ${name}`);
  return result;
}
