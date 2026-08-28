import { describe, expect, test } from "bun:test";
import { HostLedgerKeyring } from "./ledger-crypto";

const key = (id = "k1", fill = 7) => ({
  id,
  encryptionKey: new Uint8Array(32).fill(fill),
  lookupKey: new Uint8Array(32).fill(8),
  decryptNotBeforeMs: 0,
  decryptNotAfterMs: 10_000,
});
const aad = {
  table: "turns",
  opaquePrimaryKey: "a".repeat(64),
  exactFence: "f".repeat(64),
};
describe("Host ledger crypto", () => {
  test("uses random AES-GCM envelopes and rejects tamper/AAD changes", () => {
    const ring = new HostLedgerKeyring({ activeKeyId: "k1", keys: [key()] });
    const clear = new TextEncoder().encode("forbidden plaintext fixture");
    const one = ring.encrypt(clear, aad, 1),
      two = ring.encrypt(clear, aad, 1);
    expect(one).not.toBe(two);
    expect(new TextDecoder().decode(ring.decrypt(one, aad, 1))).toBe(
      "forbidden plaintext fixture",
    );
    const parts = one.split(".");
    parts[4] = `${parts[4]!.startsWith("A") ? "B" : "A"}${parts[4]!.slice(1)}`;
    expect(() => ring.decrypt(parts.join("."), aad, 1)).toThrow(
      /authentication|envelope/,
    );
    expect(() =>
      ring.decrypt(one, { ...aad, exactFence: "b".repeat(64) }, 1),
    ).toThrow(/authentication/);
  });
  test("rotates writes while bounded old keys remain decrypt-only", () => {
    const old = new HostLedgerKeyring({
      activeKeyId: "old",
      keys: [key("old", 2)],
    });
    const envelope = old.encrypt(new Uint8Array([1, 2, 3]), aad, 1);
    const rotated = new HostLedgerKeyring({
      activeKeyId: "new",
      keys: [key("new", 3), key("old", 2)],
      maxOldKeys: 1,
    });
    expect([...rotated.decrypt(envelope, aad, 1)]).toEqual([1, 2, 3]);
    expect(rotated.encrypt(new Uint8Array([4]), aad, 1).split(".")[1]).toBe(
      "new",
    );
    expect(
      () =>
        new HostLedgerKeyring({
          activeKeyId: "new",
          keys: [key("new"), key("old"), key("extra")],
          maxOldKeys: 1,
        }),
    ).toThrow(/bound/);
  });
  test("HMAC lookup domains do not expose or alias raw IDs", () => {
    const ring = new HostLedgerKeyring({ activeKeyId: "k1", keys: [key()] });
    expect(ring.opaqueId("session", "secret-session")).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(ring.opaqueId("session", "secret-session")).not.toBe(
      ring.opaqueId("turn", "secret-session"),
    );
  });
});
