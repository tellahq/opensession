import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  AGENT_HOST_SUPERVISION_AUDIENCE,
  AGENT_HOST_SUPERVISION_PURPOSE,
  serializeAgentHostSupervisionAuthorityV2,
} from "@tellahq/opensession-protocol/agent-host";
import {
  decodeAgentHostSupervisionPublicKeyringV2,
  verifySignedAgentHostSupervisionEnvelopeV2,
} from "@tellahq/opensession-protocol/agent-host-supervision";
import { createAgentHostSupervisionSigner } from "./agent-host-supervision-signer";

const now = 1_000_000;
function fixture() {
  const pair = generateKeyPairSync("ed25519");
  const privateKeyPkcs8 = Uint8Array.from(
    pair.privateKey.export({ type: "pkcs8", format: "der" }),
  );
  const publicKeySpki = Uint8Array.from(
    pair.publicKey.export({ type: "spki", format: "der" }),
  );
  const signer = createAgentHostSupervisionSigner({
    keyId: "agent-host-key-0001",
    privateKeyPkcs8,
    publicKeySpki,
    signingNotBeforeMs: now - 1,
    signingNotAfterMs: now + 100_000,
    verifyUntilMs: now + 200_000,
    status: "active",
  });
  const authority = {
    version: 2 as const,
    fence: {
      sessionId: "session-1",
      runId: "run-1",
      turnId: "turn-1",
      generation: 1,
    },
    planHash: `sha256:${"a".repeat(64)}`,
    hostId: "host-0001",
    hostGeneration: 1,
    hostIncarnation: "incarnation-0001",
    supervisorEpoch: 1,
    kernelServiceEpoch: "service-epoch-0001",
    hostChallenge: "challenge-00000001",
    audience: AGENT_HOST_SUPERVISION_AUDIENCE,
    purpose: AGENT_HOST_SUPERVISION_PURPOSE,
    issuedAtMs: now,
    expiresAtMs: now + 60_000,
    nonce: "nonce-000000000001",
    keyId: signer.keyId,
  };
  return {
    signer,
    authority,
    publicKeySpki: signer.publicKeySpki,
    privateKeyPkcs8,
  };
}

describe("synchronous Agent Host signer", () => {
  test("is deterministic, wipes input DER, and verifies exact V3 bindings", async () => {
    const { signer, authority, publicKeySpki, privateKeyPkcs8 } = fixture();
    expect(privateKeyPkcs8.every((byte) => byte === 0)).toBe(true);
    const bytes = serializeAgentHostSupervisionAuthorityV2(authority);
    const first = signer.sign(bytes, now);
    expect(signer.sign(bytes, now)).toEqual(first);
    const keyring = {
      version: 2 as const,
      algorithm: "Ed25519" as const,
      domain: "opensession.agent-host.supervision.v2" as const,
      keys: [
        {
          keyId: signer.keyId,
          status: "active" as const,
          publicKeySpki,
          signingNotBeforeMs: now - 1,
          signingNotAfterMs: now + 100_000,
          verifyUntilMs: now + 200_000,
        },
      ],
    };
    expect(decodeAgentHostSupervisionPublicKeyringV2(keyring)).toBeDefined();
    const expected = {
      fence: authority.fence,
      planHash: authority.planHash,
      hostId: authority.hostId,
      hostGeneration: authority.hostGeneration,
      hostIncarnation: authority.hostIncarnation,
      supervisorEpoch: authority.supervisorEpoch,
      kernelServiceEpoch: authority.kernelServiceEpoch,
      hostChallenge: authority.hostChallenge,
      nonce: authority.nonce,
      audience: authority.audience,
      purpose: authority.purpose,
      keyId: authority.keyId,
      issuedAtMs: authority.issuedAtMs,
      expiresAtMs: authority.expiresAtMs,
    };
    expect(
      await verifySignedAgentHostSupervisionEnvelopeV2(
        first,
        keyring,
        expected,
        now,
      ),
    ).toEqual(authority);
    expect(
      await verifySignedAgentHostSupervisionEnvelopeV2(
        first,
        keyring,
        { ...expected, expiresAtMs: now + 1 },
        now,
      ),
    ).toBeUndefined();
    const shortRetention = {
      ...keyring,
      keys: [
        {
          ...keyring.keys[0]!,
          signingNotAfterMs: now + 1,
          verifyUntilMs: authority.expiresAtMs + 30_000 - 1,
        },
      ],
    };
    expect(
      await verifySignedAgentHostSupervisionEnvelopeV2(
        first,
        shortRetention,
        expected,
        now,
      ),
    ).toBeUndefined();
  });

  test("rejects algorithm/key/window/public mismatch and multiple active keys", () => {
    const pair = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const config = (spki: Buffer) => ({
      keyId: "agent-host-key-0001",
      privateKeyPkcs8: Uint8Array.from(
        pair.privateKey.export({ type: "pkcs8", format: "der" }),
      ),
      publicKeySpki: Uint8Array.from(spki),
      signingNotBeforeMs: now,
      signingNotAfterMs: now + 10,
      verifyUntilMs: now + 20,
      status: "active" as const,
    });
    expect(() =>
      createAgentHostSupervisionSigner(
        config(other.publicKey.export({ type: "spki", format: "der" })),
      ),
    ).toThrow();
    const { signer, authority } = fixture();
    expect(() =>
      signer.sign(
        serializeAgentHostSupervisionAuthorityV2(authority),
        now + 100_000,
      ),
    ).toThrow();
    const key = {
      keyId: signer.keyId,
      status: "active",
      publicKeySpki: signer.publicKeySpki,
      signingNotBeforeMs: now,
      signingNotAfterMs: now + 1,
      verifyUntilMs: now + 2,
    };
    expect(
      decodeAgentHostSupervisionPublicKeyringV2({
        version: 2,
        algorithm: "Ed25519",
        domain: "opensession.agent-host.supervision.v2",
        keys: [key, { ...key, keyId: "agent-host-key-0002" }],
      }),
    ).toBeUndefined();
  });

  test("has bounded sync latency in a Bun Worker-compatible runtime", async () => {
    const { signer, authority } = fixture();
    const bytes = serializeAgentHostSupervisionAuthorityV2(authority);
    const start = performance.now();
    for (let i = 0; i < 100; i += 1) signer.sign(bytes, now);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(typeof Worker).toBe("function");
  });

  test("module is import-inert", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `await import(${JSON.stringify(new URL("./agent-host-supervision-signer.ts", import.meta.url).href)}); console.log("ok")`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("ok\n");
  });
});
