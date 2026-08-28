import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createSecretKey,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";

export const AGENT_HOST_LEDGER_ENVELOPE_VERSION = "ahrl1" as const;
export const AGENT_HOST_LEDGER_SCHEMA = 1 as const;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

export interface HostLedgerKey {
  readonly id: string;
  /** Exactly 32 mutable bytes. The constructor copies this into a KeyObject. */
  readonly encryptionKey: Uint8Array;
  /** At least 32 mutable bytes. Used only for domain-separated opaque lookups. */
  readonly lookupKey: Uint8Array;
  readonly decryptNotBeforeMs: number;
  readonly decryptNotAfterMs: number;
}
export interface HostLedgerKeyringInput {
  readonly activeKeyId: string;
  readonly keys: readonly HostLedgerKey[];
  readonly maxOldKeys?: number;
}
interface LoadedKey {
  id: string;
  encryptionKey: KeyObject;
  lookupKey: KeyObject;
  decryptNotBeforeMs: number;
  decryptNotAfterMs: number;
}
export interface LedgerAad {
  readonly table: string;
  readonly opaquePrimaryKey: string;
  readonly exactFence: string;
}

const encoder = new TextEncoder();
function aadBytes(aad: LedgerAad): Uint8Array {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(aad.table))
    throw new Error("invalid ledger AAD table");
  if (!/^[a-f0-9]{64}$/.test(aad.opaquePrimaryKey))
    throw new Error("invalid ledger AAD primary key");
  if (!aad.exactFence || encoder.encode(aad.exactFence).byteLength > 2048)
    throw new Error("invalid ledger AAD fence");
  return encoder.encode(
    `opensession-agent-host-ledger-aad-v1\u0000${AGENT_HOST_LEDGER_SCHEMA}\u0000${aad.table}\u0000${aad.opaquePrimaryKey}\u0000${aad.exactFence}`,
  );
}

/**
 * Application-level ledger keyring. It deliberately accepts mutable buffers so
 * callers can erase provisioning material after construction. Node KeyObjects,
 * OpenSSL internals, strings, SQLite copies and the JS GC cannot be reliably
 * wiped; callers must treat process isolation and short plaintext lifetimes as
 * part of the boundary.
 */
export class HostLedgerKeyring {
  readonly #keys = new Map<string, LoadedKey>();
  readonly #active: LoadedKey;

  constructor(input: HostLedgerKeyringInput) {
    const maxOldKeys = input.maxOldKeys ?? 3;
    if (
      !KEY_ID.test(input.activeKeyId) ||
      !Number.isSafeInteger(maxOldKeys) ||
      maxOldKeys < 0
    )
      throw new Error("invalid Host ledger keyring");
    if (input.keys.length < 1 || input.keys.length > maxOldKeys + 1)
      throw new Error("Host ledger keyring exceeds decrypt-only key bound");
    for (const supplied of input.keys) {
      if (
        !KEY_ID.test(supplied.id) ||
        this.#keys.has(supplied.id) ||
        supplied.encryptionKey.byteLength !== 32 ||
        supplied.lookupKey.byteLength < 32 ||
        !Number.isSafeInteger(supplied.decryptNotBeforeMs) ||
        !Number.isSafeInteger(supplied.decryptNotAfterMs) ||
        supplied.decryptNotBeforeMs < 0 ||
        supplied.decryptNotAfterMs < supplied.decryptNotBeforeMs
      )
        throw new Error("invalid Host ledger key");
      const encryptionCopy = Buffer.from(supplied.encryptionKey);
      const lookupCopy = Buffer.from(supplied.lookupKey);
      try {
        this.#keys.set(supplied.id, {
          id: supplied.id,
          encryptionKey: createSecretKey(encryptionCopy),
          lookupKey: createSecretKey(lookupCopy),
          decryptNotBeforeMs: supplied.decryptNotBeforeMs,
          decryptNotAfterMs: supplied.decryptNotAfterMs,
        });
      } finally {
        encryptionCopy.fill(0);
        lookupCopy.fill(0);
      }
    }
    const active = this.#keys.get(input.activeKeyId);
    if (!active) throw new Error("active Host ledger write key is absent");
    const lookupProbe = Buffer.from(
      "opensession-agent-host-ledger-lookup-key-probe-v1",
    );
    const expectedLookup = createHmac("sha256", active.lookupKey)
      .update(lookupProbe)
      .digest();
    try {
      for (const key of this.#keys.values()) {
        const candidate = createHmac("sha256", key.lookupKey)
          .update(lookupProbe)
          .digest();
        try {
          if (!timingSafeEqual(expectedLookup, candidate))
            throw new Error(
              "Host ledger lookup key must remain stable across encryption-key rotation",
            );
        } finally {
          candidate.fill(0);
        }
      }
    } finally {
      lookupProbe.fill(0);
      expectedLookup.fill(0);
    }
    this.#active = active;
  }

  get activeKeyId(): string {
    return this.#active.id;
  }

  opaqueId(
    kind: "session" | "run" | "turn" | "operation" | "receipt",
    rawId: string,
  ): string {
    if (!rawId || encoder.encode(rawId).byteLength > 1024)
      throw new Error(`invalid ${kind} id`);
    return createHmac("sha256", this.#active.lookupKey)
      .update(`opensession-agent-host-ledger-lookup-v1\u0000${kind}\u0000`)
      .update(rawId, "utf8")
      .digest("hex");
  }

  encrypt(plaintext: Uint8Array, aad: LedgerAad, nowMs: number): string {
    if (
      !Number.isSafeInteger(nowMs) ||
      nowMs < this.#active.decryptNotBeforeMs ||
      nowMs > this.#active.decryptNotAfterMs
    )
      throw new Error("active Host ledger key is outside its write window");
    const nonce = randomBytes(12);
    const copy = Buffer.from(plaintext);
    try {
      const cipher = createCipheriv(
        "aes-256-gcm",
        this.#active.encryptionKey,
        nonce,
        { authTagLength: 16 },
      );
      cipher.setAAD(aadBytes(aad));
      const ciphertext = Buffer.concat([cipher.update(copy), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${AGENT_HOST_LEDGER_ENVELOPE_VERSION}.${this.#active.id}.${nonce.toString("base64url")}.${ciphertext.toString("base64url")}.${tag.toString("base64url")}`;
    } finally {
      copy.fill(0);
      nonce.fill(0);
    }
  }

  decrypt(envelope: string, aad: LedgerAad, nowMs: number): Uint8Array {
    const parts = envelope.split(".");
    if (
      parts.length !== 5 ||
      parts[0] !== AGENT_HOST_LEDGER_ENVELOPE_VERSION ||
      !KEY_ID.test(parts[1]!) ||
      !parts.slice(2).every((v) => B64URL.test(v))
    )
      throw new Error("invalid Host ledger ciphertext envelope");
    const key = this.#keys.get(parts[1]!);
    if (
      !key ||
      !Number.isSafeInteger(nowMs) ||
      nowMs < key.decryptNotBeforeMs ||
      nowMs > key.decryptNotAfterMs
    )
      throw new Error("Host ledger decrypt key unavailable or outside window");
    const nonce = Buffer.from(parts[2]!, "base64url");
    const ciphertext = Buffer.from(parts[3]!, "base64url");
    const tag = Buffer.from(parts[4]!, "base64url");
    if (nonce.byteLength !== 12 || tag.byteLength !== 16)
      throw new Error("invalid Host ledger ciphertext envelope");
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key.encryptionKey,
        nonce,
        { authTagLength: 16 },
      );
      decipher.setAAD(aadBytes(aad));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error("Host ledger ciphertext authentication failed");
    } finally {
      nonce.fill(0);
      ciphertext.fill(0);
      tag.fill(0);
    }
  }

  verifyOpaqueId(
    kind: "session" | "run" | "turn" | "operation" | "receipt",
    rawId: string,
    expected: string,
  ): boolean {
    if (!/^[a-f0-9]{64}$/.test(expected)) return false;
    const actual = Buffer.from(this.opaqueId(kind, rawId), "hex");
    const wanted = Buffer.from(expected, "hex");
    try {
      return timingSafeEqual(actual, wanted);
    } finally {
      actual.fill(0);
      wanted.fill(0);
    }
  }
}
