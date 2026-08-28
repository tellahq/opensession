import {
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { MAX_AGENT_HOST_SUPERVISION_CLOCK_SKEW_MS } from "@tellahq/opensession-protocol/agent-host";
import {
  AGENT_HOST_SUPERVISION_ENVELOPE_VERSION,
  AGENT_HOST_SUPERVISION_SIGNATURE_ALGORITHM,
  AGENT_HOST_SUPERVISION_SIGNATURE_DOMAIN,
  agentHostSupervisionSigningBytesV1,
  decodeCanonicalAgentHostSupervisionAuthorityBytesV2,
  type SignedAgentHostSupervisionEnvelopeV1,
} from "@tellahq/opensession-protocol/agent-host-supervision";

const ED25519_PKCS8_BYTES = 48;
const ED25519_SPKI_BYTES = 44;
const KEY_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const PKCS8_PREFIX = Buffer.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);
const SPKI_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/** Trusted credential material. Mutable DER inputs are wiped after import.
 * Node KeyObject internals cannot be explicitly zeroized, and JavaScript cannot
 * wipe prior string copies. Callers should load credentials directly into
 * mutable buffers and keep the signer scoped to the kernel process. */
export interface AgentHostSupervisionPrivateSigningKeyV2 {
  readonly keyId: string;
  readonly privateKeyPkcs8: Uint8Array;
  readonly publicKeySpki: Uint8Array;
  readonly signingNotBeforeMs: number;
  readonly signingNotAfterMs: number;
  readonly verifyUntilMs: number;
  readonly status: "active";
}

export interface AgentHostSupervisionSynchronousSigner {
  readonly keyId: string;
  readonly publicKeySpki: string;
  readonly signingNotBeforeMs: number;
  readonly signingNotAfterMs: number;
  readonly verifyUntilMs: number;
  sign(
    canonicalAuthorityBytes: Uint8Array,
    nowMs: number,
  ): SignedAgentHostSupervisionEnvelopeV1;
}

function exactConfig(value: AgentHostSupervisionPrivateSigningKeyV2): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    Object.keys(value).length === 7 &&
    Object.keys(value).every((key) =>
      [
        "keyId",
        "privateKeyPkcs8",
        "publicKeySpki",
        "signingNotBeforeMs",
        "signingNotAfterMs",
        "verifyUntilMs",
        "status",
      ].includes(key),
    ) &&
    KEY_ID_RE.test(value.keyId) &&
    value.status === "active" &&
    value.privateKeyPkcs8 instanceof Uint8Array &&
    value.privateKeyPkcs8.byteLength === ED25519_PKCS8_BYTES &&
    value.publicKeySpki instanceof Uint8Array &&
    value.publicKeySpki.byteLength === ED25519_SPKI_BYTES &&
    Number.isSafeInteger(value.signingNotBeforeMs) &&
    value.signingNotBeforeMs >= 0 &&
    Number.isSafeInteger(value.signingNotAfterMs) &&
    value.signingNotAfterMs > value.signingNotBeforeMs &&
    Number.isSafeInteger(value.verifyUntilMs) &&
    value.verifyUntilMs >= value.signingNotAfterMs
  );
}

function exportSpki(key: KeyObject): Buffer {
  return key.export({ type: "spki", format: "der" }) as Buffer;
}

/** Import-inert Node-only signer. Key import and public-key derivation happen
 * exactly once; each mailbox call performs only bounded CPU work. */
export function createAgentHostSupervisionSigner(
  config: AgentHostSupervisionPrivateSigningKeyV2,
): AgentHostSupervisionSynchronousSigner {
  if (!exactConfig(config))
    throw new Error("Invalid Agent Host signing key metadata");
  const pkcs8 = Buffer.from(config.privateKeyPkcs8);
  const expectedSpki = Buffer.from(config.publicKeySpki);
  // Take ownership semantics seriously: wipe caller-provided mutable DER too.
  config.privateKeyPkcs8.fill(0);
  try {
    if (!pkcs8.subarray(0, PKCS8_PREFIX.length).equals(PKCS8_PREFIX))
      throw new Error("Invalid exact Ed25519 PKCS8 key");
    if (!expectedSpki.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX))
      throw new Error("Invalid exact Ed25519 SPKI key");
    const privateKey = createPrivateKey({
      key: pkcs8,
      format: "der",
      type: "pkcs8",
    });
    if (privateKey.asymmetricKeyType !== "ed25519")
      throw new Error("Signing key is not Ed25519");
    const derived = exportSpki(createPublicKey(privateKey));
    try {
      if (
        derived.byteLength !== expectedSpki.byteLength ||
        !timingSafeEqual(derived, expectedSpki)
      )
        throw new Error("Agent Host public key does not match private key");
    } finally {
      derived.fill(0);
    }
    const publicKeySpki = expectedSpki.toString("base64url");
    const { keyId, signingNotBeforeMs, signingNotAfterMs, verifyUntilMs } =
      config;
    return Object.freeze({
      keyId,
      publicKeySpki,
      signingNotBeforeMs,
      signingNotAfterMs,
      verifyUntilMs,
      sign(canonicalAuthorityBytes: Uint8Array, nowMs: number) {
        if (
          !Number.isSafeInteger(nowMs) ||
          nowMs < signingNotBeforeMs ||
          nowMs >= signingNotAfterMs
        )
          throw new Error(
            "Agent Host signing key is outside its signing window",
          );
        const authorityBytes = Uint8Array.from(canonicalAuthorityBytes);
        const authority = decodeCanonicalAgentHostSupervisionAuthorityBytesV2(
          authorityBytes,
          nowMs,
        );
        if (
          !authority ||
          authority.keyId !== keyId ||
          authority.issuedAtMs < signingNotBeforeMs ||
          authority.issuedAtMs >= signingNotAfterMs ||
          authority.expiresAtMs >
            verifyUntilMs - MAX_AGENT_HOST_SUPERVISION_CLOCK_SKEW_MS
        )
          throw new Error(
            "Agent Host authority is invalid for this signing key",
          );
        const signingBytes = agentHostSupervisionSigningBytesV1(authorityBytes);
        const signature = sign(null, signingBytes, privateKey);
        if (signature.byteLength !== 64)
          throw new Error("Invalid Ed25519 signature length");
        return Object.freeze({
          version: AGENT_HOST_SUPERVISION_ENVELOPE_VERSION,
          algorithm: AGENT_HOST_SUPERVISION_SIGNATURE_ALGORITHM,
          domain: AGENT_HOST_SUPERVISION_SIGNATURE_DOMAIN,
          authorityBytes: Buffer.from(authorityBytes).toString("base64url"),
          signature: signature.toString("base64url"),
        });
      },
    });
  } finally {
    pkcs8.fill(0);
    expectedSpki.fill(0);
  }
}
