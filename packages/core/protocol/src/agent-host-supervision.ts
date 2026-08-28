import {
  AGENT_HOST_SUPERVISION_AUDIENCE,
  AGENT_HOST_SUPERVISION_PURPOSE,
  AGENT_HOST_SUPERVISION_VERSION,
  MAX_AGENT_HOST_SUPERVISION_CLOCK_SKEW_MS,
  decodeAgentHostSupervisionAuthorityV2,
  serializeAgentHostSupervisionAuthorityV2,
  type AgentHostSupervisionAuthorityV2,
  type AgentTurnFence,
} from "./agent-host";

export const AGENT_HOST_SUPERVISION_ENVELOPE_VERSION = 1 as const;
export const AGENT_HOST_SUPERVISION_KEYRING_VERSION = 1 as const;
export const AGENT_HOST_SUPERVISION_SIGNATURE_ALGORITHM = "Ed25519" as const;
export const AGENT_HOST_SUPERVISION_SIGNATURE_DOMAIN =
  "opensession.agent-host.supervision.v2" as const;
export const AGENT_HOST_SUPERVISION_SIGNATURE_RUNTIME =
  "opensession-agent-host-runtime.v1" as const;

const MAX_AUTHORITY_BYTES = 4 * 1024;
const MAX_KEYRING_KEYS = 32;
const ED25519_SIGNATURE_BYTES = 64;
const ED25519_SPKI_BYTES = 44;
const KEY_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const BASE64URL_RE = /^(?:[A-Za-z0-9_-]{2,})$/;
const textEncoder = new TextEncoder();
const strictTextDecoder = new TextDecoder("utf-8", { fatal: true });
const SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);
const SIGNING_PREFIX = textEncoder.encode(
  `OpenSession-Signed-Message\0domain=${AGENT_HOST_SUPERVISION_SIGNATURE_DOMAIN}\0runtime=${AGENT_HOST_SUPERVISION_SIGNATURE_RUNTIME}\0version=${AGENT_HOST_SUPERVISION_VERSION}\0algorithm=${AGENT_HOST_SUPERVISION_SIGNATURE_ALGORITHM}\0`,
);

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const safeTime = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength &&
  left.every((byte, index) => byte === right[index]);
function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeCanonicalBase64Url(
  value: unknown,
  exactBytes: number | undefined,
  maxBytes: number,
): Uint8Array | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil((maxBytes * 4) / 3) ||
    value.length % 4 === 1 ||
    value.includes("=") ||
    !BASE64URL_RE.test(value)
  )
    return undefined;
  try {
    const standard = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(
      standard.padEnd(Math.ceil(standard.length / 4) * 4, "="),
    );
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    if (
      bytes.byteLength > maxBytes ||
      (exactBytes !== undefined && bytes.byteLength !== exactBytes) ||
      encodeBase64Url(bytes) !== value
    )
      return undefined;
    return bytes;
  } catch {
    return undefined;
  }
}

export interface SignedAgentHostSupervisionEnvelopeV1 {
  readonly version: typeof AGENT_HOST_SUPERVISION_ENVELOPE_VERSION;
  readonly algorithm: typeof AGENT_HOST_SUPERVISION_SIGNATURE_ALGORITHM;
  readonly domain: typeof AGENT_HOST_SUPERVISION_SIGNATURE_DOMAIN;
  /** Exact canonical authority bytes, encoded as unpadded base64url. */
  readonly authorityBytes: string;
  /** A 64-byte Ed25519 signature, encoded as unpadded base64url. */
  readonly signature: string;
}

const ENVELOPE_KEYS = [
  "version",
  "algorithm",
  "domain",
  "authorityBytes",
  "signature",
] as const;

export function decodeSignedAgentHostSupervisionEnvelopeV1(
  value: unknown,
): SignedAgentHostSupervisionEnvelopeV1 | undefined {
  if (!record(value) || !exact(value, ENVELOPE_KEYS)) return undefined;
  if (
    value.version !== AGENT_HOST_SUPERVISION_ENVELOPE_VERSION ||
    value.algorithm !== AGENT_HOST_SUPERVISION_SIGNATURE_ALGORITHM ||
    value.domain !== AGENT_HOST_SUPERVISION_SIGNATURE_DOMAIN ||
    !decodeCanonicalBase64Url(
      value.authorityBytes,
      undefined,
      MAX_AUTHORITY_BYTES,
    ) ||
    !decodeCanonicalBase64Url(
      value.signature,
      ED25519_SIGNATURE_BYTES,
      ED25519_SIGNATURE_BYTES,
    )
  )
    return undefined;
  return Object.freeze({
    version: AGENT_HOST_SUPERVISION_ENVELOPE_VERSION,
    algorithm: AGENT_HOST_SUPERVISION_SIGNATURE_ALGORITHM,
    domain: AGENT_HOST_SUPERVISION_SIGNATURE_DOMAIN,
    authorityBytes: value.authorityBytes as string,
    signature: value.signature as string,
  });
}

export type AgentHostSupervisionPublicKeyStatus = "active" | "retiring";
export interface AgentHostSupervisionPublicKeyV1 {
  readonly keyId: string;
  readonly status: AgentHostSupervisionPublicKeyStatus;
  readonly publicKeySpki: string;
  /** Inclusive signing-time boundary. */
  readonly notBeforeMs: number;
  /** Exclusive signing-time boundary. */
  readonly notAfterMs: number;
  /** Null for active keys. Retiring keys remain verifiable until this instant. */
  readonly retiredAtMs: number | null;
}
export interface AgentHostSupervisionPublicKeyringV1 {
  readonly version: typeof AGENT_HOST_SUPERVISION_KEYRING_VERSION;
  readonly algorithm: typeof AGENT_HOST_SUPERVISION_SIGNATURE_ALGORITHM;
  readonly domain: typeof AGENT_HOST_SUPERVISION_SIGNATURE_DOMAIN;
  readonly keys: readonly AgentHostSupervisionPublicKeyV1[];
}

const KEYRING_KEYS = ["version", "algorithm", "domain", "keys"] as const;
const PUBLIC_KEY_KEYS = [
  "keyId",
  "status",
  "publicKeySpki",
  "notBeforeMs",
  "notAfterMs",
  "retiredAtMs",
] as const;

function hasEd25519SpkiPrefix(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength === ED25519_SPKI_BYTES &&
    SPKI_PREFIX.every((byte, index) => bytes[index] === byte)
  );
}

export function decodeAgentHostSupervisionPublicKeyringV1(
  value: unknown,
): AgentHostSupervisionPublicKeyringV1 | undefined {
  if (
    !record(value) ||
    !exact(value, KEYRING_KEYS) ||
    value.version !== AGENT_HOST_SUPERVISION_KEYRING_VERSION ||
    value.algorithm !== AGENT_HOST_SUPERVISION_SIGNATURE_ALGORITHM ||
    value.domain !== AGENT_HOST_SUPERVISION_SIGNATURE_DOMAIN ||
    !Array.isArray(value.keys) ||
    value.keys.length === 0 ||
    value.keys.length > MAX_KEYRING_KEYS
  )
    return undefined;
  const seen = new Set<string>();
  const keys: AgentHostSupervisionPublicKeyV1[] = [];
  for (const candidate of value.keys) {
    if (!record(candidate) || !exact(candidate, PUBLIC_KEY_KEYS))
      return undefined;
    const spki = decodeCanonicalBase64Url(
      candidate.publicKeySpki,
      ED25519_SPKI_BYTES,
      ED25519_SPKI_BYTES,
    );
    if (
      typeof candidate.keyId !== "string" ||
      !KEY_ID_RE.test(candidate.keyId) ||
      seen.has(candidate.keyId) ||
      (candidate.status !== "active" && candidate.status !== "retiring") ||
      !spki ||
      !hasEd25519SpkiPrefix(spki) ||
      !safeTime(candidate.notBeforeMs) ||
      !safeTime(candidate.notAfterMs) ||
      candidate.notAfterMs <= candidate.notBeforeMs ||
      (candidate.status === "active"
        ? candidate.retiredAtMs !== null
        : !safeTime(candidate.retiredAtMs) ||
          candidate.retiredAtMs < candidate.notAfterMs)
    )
      return undefined;
    seen.add(candidate.keyId);
    keys.push(
      Object.freeze({
        keyId: candidate.keyId,
        status: candidate.status,
        publicKeySpki: candidate.publicKeySpki,
        notBeforeMs: candidate.notBeforeMs,
        notAfterMs: candidate.notAfterMs,
        retiredAtMs: candidate.retiredAtMs,
      }) as AgentHostSupervisionPublicKeyV1,
    );
  }
  return Object.freeze({
    version: AGENT_HOST_SUPERVISION_KEYRING_VERSION,
    algorithm: AGENT_HOST_SUPERVISION_SIGNATURE_ALGORITHM,
    domain: AGENT_HOST_SUPERVISION_SIGNATURE_DOMAIN,
    keys: Object.freeze(keys),
  });
}

export interface ExpectedAgentHostSupervisionBindingsV2 {
  readonly fence: Readonly<AgentTurnFence>;
  readonly planHash: string;
  readonly hostId: string;
  readonly hostGeneration: number;
  readonly hostIncarnation: string;
  readonly supervisorEpoch: number;
  readonly kernelServiceEpoch: string;
  readonly hostChallenge: string;
  readonly nonce: string;
  readonly audience: typeof AGENT_HOST_SUPERVISION_AUDIENCE;
  readonly purpose: typeof AGENT_HOST_SUPERVISION_PURPOSE;
}

const EXPECTED_KEYS = [
  "fence",
  "planHash",
  "hostId",
  "hostGeneration",
  "hostIncarnation",
  "supervisorEpoch",
  "kernelServiceEpoch",
  "hostChallenge",
  "nonce",
  "audience",
  "purpose",
] as const;

function expectedMatches(
  authority: AgentHostSupervisionAuthorityV2,
  value: unknown,
): value is ExpectedAgentHostSupervisionBindingsV2 {
  if (!record(value) || !exact(value, EXPECTED_KEYS) || !record(value.fence))
    return false;
  const fence = value.fence;
  return (
    exact(fence, ["sessionId", "runId", "turnId", "generation"]) &&
    authority.fence.sessionId === fence.sessionId &&
    authority.fence.runId === fence.runId &&
    authority.fence.turnId === fence.turnId &&
    authority.fence.generation === fence.generation &&
    authority.planHash === value.planHash &&
    authority.hostId === value.hostId &&
    authority.hostGeneration === value.hostGeneration &&
    authority.hostIncarnation === value.hostIncarnation &&
    authority.supervisorEpoch === value.supervisorEpoch &&
    authority.kernelServiceEpoch === value.kernelServiceEpoch &&
    authority.hostChallenge === value.hostChallenge &&
    authority.nonce === value.nonce &&
    authority.audience === value.audience &&
    authority.purpose === value.purpose
  );
}

export function decodeCanonicalAgentHostSupervisionAuthorityBytesV2(
  bytes: Uint8Array,
  nowMs?: number,
): AgentHostSupervisionAuthorityV2 | undefined {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_AUTHORITY_BYTES)
    return undefined;
  try {
    const parsed: unknown = JSON.parse(strictTextDecoder.decode(bytes));
    const authority = decodeAgentHostSupervisionAuthorityV2(parsed, nowMs);
    if (!authority) return undefined;
    const canonical = serializeAgentHostSupervisionAuthorityV2(authority);
    return bytesEqual(bytes, canonical) ? authority : undefined;
  } catch {
    return undefined;
  }
}

/** Builds the immutable, length-delimited bytes signed and verified by both
 * services. This never signs an authority object or envelope JSON. */
export function agentHostSupervisionSigningBytesV1(
  canonicalAuthorityBytes: Uint8Array,
): Uint8Array {
  if (
    !(canonicalAuthorityBytes instanceof Uint8Array) ||
    canonicalAuthorityBytes.byteLength === 0 ||
    canonicalAuthorityBytes.byteLength > MAX_AUTHORITY_BYTES
  )
    throw new Error("Invalid canonical Agent Host authority bytes");
  const output = new Uint8Array(
    SIGNING_PREFIX.byteLength + 4 + canonicalAuthorityBytes.byteLength,
  );
  output.set(SIGNING_PREFIX);
  new DataView(output.buffer).setUint32(
    SIGNING_PREFIX.byteLength,
    canonicalAuthorityBytes.byteLength,
    false,
  );
  output.set(canonicalAuthorityBytes, SIGNING_PREFIX.byteLength + 4);
  return output;
}

/** Public-key-only Host verifier. Every authority binding is mandatory. */
export async function verifySignedAgentHostSupervisionEnvelopeV1(
  envelopeValue: unknown,
  keyringValue: unknown,
  expectedBindings: ExpectedAgentHostSupervisionBindingsV2,
  nowMs: number,
): Promise<AgentHostSupervisionAuthorityV2 | undefined> {
  if (!safeTime(nowMs)) return undefined;
  const envelope = decodeSignedAgentHostSupervisionEnvelopeV1(envelopeValue);
  const keyring = decodeAgentHostSupervisionPublicKeyringV1(keyringValue);
  if (!envelope || !keyring) return undefined;
  const authorityBytes = decodeCanonicalBase64Url(
    envelope.authorityBytes,
    undefined,
    MAX_AUTHORITY_BYTES,
  )!;
  const authority = decodeCanonicalAgentHostSupervisionAuthorityBytesV2(
    authorityBytes,
    nowMs,
  );
  if (!authority || !KEY_ID_RE.test(authority.keyId)) return undefined;
  if (!expectedMatches(authority, expectedBindings)) return undefined;
  const key = keyring.keys.find(
    (candidate) => candidate.keyId === authority.keyId,
  );
  if (
    !key ||
    authority.issuedAtMs < key.notBeforeMs ||
    authority.issuedAtMs >= key.notAfterMs ||
    (key.status === "retiring" &&
      key.retiredAtMs! <
        authority.expiresAtMs + MAX_AGENT_HOST_SUPERVISION_CLOCK_SKEW_MS)
  )
    return undefined;
  try {
    const publicKey = await crypto.subtle.importKey(
      "spki",
      ownedArrayBuffer(
        decodeCanonicalBase64Url(
          key.publicKeySpki,
          ED25519_SPKI_BYTES,
          ED25519_SPKI_BYTES,
        )!,
      ),
      { name: AGENT_HOST_SUPERVISION_SIGNATURE_ALGORITHM },
      false,
      ["verify"],
    );
    const signature = decodeCanonicalBase64Url(
      envelope.signature,
      ED25519_SIGNATURE_BYTES,
      ED25519_SIGNATURE_BYTES,
    )!;
    const valid = await crypto.subtle.verify(
      AGENT_HOST_SUPERVISION_SIGNATURE_ALGORITHM,
      publicKey,
      ownedArrayBuffer(signature),
      ownedArrayBuffer(agentHostSupervisionSigningBytesV1(authorityBytes)),
    );
    return valid ? authority : undefined;
  } catch {
    return undefined;
  }
}

export const AGENT_HOST_SUPERVISION_KEYRING_VERSION_V2 = 2 as const;
export interface AgentHostSupervisionPublicKeyV2 {
  readonly keyId: string;
  readonly status: "active" | "retiring";
  readonly publicKeySpki: string;
  readonly signingNotBeforeMs: number;
  readonly signingNotAfterMs: number;
  readonly verifyUntilMs: number;
}
export interface AgentHostSupervisionPublicKeyringV2 {
  readonly version: typeof AGENT_HOST_SUPERVISION_KEYRING_VERSION_V2;
  readonly algorithm: typeof AGENT_HOST_SUPERVISION_SIGNATURE_ALGORITHM;
  readonly domain: typeof AGENT_HOST_SUPERVISION_SIGNATURE_DOMAIN;
  readonly keys: readonly AgentHostSupervisionPublicKeyV2[];
}
const PUBLIC_KEY_V2_KEYS = [
  "keyId",
  "status",
  "publicKeySpki",
  "signingNotBeforeMs",
  "signingNotAfterMs",
  "verifyUntilMs",
] as const;
export function decodeAgentHostSupervisionPublicKeyringV2(
  value: unknown,
): AgentHostSupervisionPublicKeyringV2 | undefined {
  if (
    !record(value) ||
    !exact(value, KEYRING_KEYS) ||
    value.version !== 2 ||
    value.algorithm !== AGENT_HOST_SUPERVISION_SIGNATURE_ALGORITHM ||
    value.domain !== AGENT_HOST_SUPERVISION_SIGNATURE_DOMAIN ||
    !Array.isArray(value.keys) ||
    value.keys.length === 0 ||
    value.keys.length > MAX_KEYRING_KEYS
  )
    return undefined;
  const seen = new Set<string>();
  let active = 0;
  const keys: AgentHostSupervisionPublicKeyV2[] = [];
  for (const candidate of value.keys) {
    if (!record(candidate) || !exact(candidate, PUBLIC_KEY_V2_KEYS))
      return undefined;
    const spki = decodeCanonicalBase64Url(
      candidate.publicKeySpki,
      ED25519_SPKI_BYTES,
      ED25519_SPKI_BYTES,
    );
    if (
      typeof candidate.keyId !== "string" ||
      !KEY_ID_RE.test(candidate.keyId) ||
      seen.has(candidate.keyId) ||
      (candidate.status !== "active" && candidate.status !== "retiring") ||
      !spki ||
      !hasEd25519SpkiPrefix(spki) ||
      !safeTime(candidate.signingNotBeforeMs) ||
      !safeTime(candidate.signingNotAfterMs) ||
      candidate.signingNotAfterMs <= candidate.signingNotBeforeMs ||
      !safeTime(candidate.verifyUntilMs) ||
      candidate.verifyUntilMs < candidate.signingNotAfterMs
    )
      return undefined;
    if (candidate.status === "active") active += 1;
    seen.add(candidate.keyId);
    keys.push(
      Object.freeze({
        keyId: candidate.keyId,
        status: candidate.status,
        publicKeySpki: candidate.publicKeySpki as string,
        signingNotBeforeMs: candidate.signingNotBeforeMs as number,
        signingNotAfterMs: candidate.signingNotAfterMs as number,
        verifyUntilMs: candidate.verifyUntilMs as number,
      }),
    );
  }
  if (active !== 1) return undefined;
  return Object.freeze({
    version: 2,
    algorithm: AGENT_HOST_SUPERVISION_SIGNATURE_ALGORITHM,
    domain: AGENT_HOST_SUPERVISION_SIGNATURE_DOMAIN,
    keys: Object.freeze(keys),
  });
}
export interface ExpectedAgentHostSupervisionBindingsV3 extends ExpectedAgentHostSupervisionBindingsV2 {
  readonly keyId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}
/** Authorizing future-path verifier. V1 remains legacy and non-authorizing. */
export async function verifySignedAgentHostSupervisionEnvelopeV2(
  envelopeValue: unknown,
  keyringValue: unknown,
  expected: ExpectedAgentHostSupervisionBindingsV3,
  nowMs: number,
): Promise<AgentHostSupervisionAuthorityV2 | undefined> {
  if (
    !safeTime(nowMs) ||
    !record(expected) ||
    !exact(expected, [...EXPECTED_KEYS, "keyId", "issuedAtMs", "expiresAtMs"])
  )
    return undefined;
  const envelope = decodeSignedAgentHostSupervisionEnvelopeV1(envelopeValue);
  const keyring = decodeAgentHostSupervisionPublicKeyringV2(keyringValue);
  if (!envelope || !keyring) return undefined;
  const authorityBytes = decodeCanonicalBase64Url(
    envelope.authorityBytes,
    undefined,
    MAX_AUTHORITY_BYTES,
  )!;
  const authority = decodeCanonicalAgentHostSupervisionAuthorityBytesV2(
    authorityBytes,
    nowMs,
  );
  const legacyExpected = {
    fence: expected.fence,
    planHash: expected.planHash,
    hostId: expected.hostId,
    hostGeneration: expected.hostGeneration,
    hostIncarnation: expected.hostIncarnation,
    supervisorEpoch: expected.supervisorEpoch,
    kernelServiceEpoch: expected.kernelServiceEpoch,
    hostChallenge: expected.hostChallenge,
    nonce: expected.nonce,
    audience: expected.audience,
    purpose: expected.purpose,
  };
  if (
    !authority ||
    !expectedMatches(authority, legacyExpected) ||
    authority.keyId !== expected.keyId ||
    authority.issuedAtMs !== expected.issuedAtMs ||
    authority.expiresAtMs !== expected.expiresAtMs
  )
    return undefined;
  const key = keyring.keys.find(
    (candidate) => candidate.keyId === authority.keyId,
  );
  if (
    !key ||
    nowMs >= key.verifyUntilMs ||
    authority.expiresAtMs >
      key.verifyUntilMs - MAX_AGENT_HOST_SUPERVISION_CLOCK_SKEW_MS ||
    authority.issuedAtMs < key.signingNotBeforeMs ||
    authority.issuedAtMs >= key.signingNotAfterMs
  )
    return undefined;
  try {
    const publicKey = await crypto.subtle.importKey(
      "spki",
      ownedArrayBuffer(
        decodeCanonicalBase64Url(
          key.publicKeySpki,
          ED25519_SPKI_BYTES,
          ED25519_SPKI_BYTES,
        )!,
      ),
      { name: AGENT_HOST_SUPERVISION_SIGNATURE_ALGORITHM },
      false,
      ["verify"],
    );
    return (await crypto.subtle.verify(
      AGENT_HOST_SUPERVISION_SIGNATURE_ALGORITHM,
      publicKey,
      ownedArrayBuffer(
        decodeCanonicalBase64Url(
          envelope.signature,
          ED25519_SIGNATURE_BYTES,
          ED25519_SIGNATURE_BYTES,
        )!,
      ),
      ownedArrayBuffer(agentHostSupervisionSigningBytesV1(authorityBytes)),
    ))
      ? authority
      : undefined;
  } catch {
    return undefined;
  }
}
