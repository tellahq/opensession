import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the store at a throwaway path BEFORE importing the module — the real
// ~/.opensession-keychain.json holds registered credentials, and a suite that
// truncated it would destroy them.
const STORE = join(
  mkdtempSync(join(tmpdir(), "keychain-test-")),
  "keychain.json",
);
process.env.OPENSESSION_KEYCHAIN_STORE = STORE;

function resetKeychain(): void {
  if (existsSync(STORE)) rmSync(STORE);
  const g = globalThis as any;
  g.__keychainCredentials?.clear();
  g.__keychainGrants?.clear();
  g.__keychainAsks?.clear();
}

let kc: typeof import("./keychain");

beforeEach(async () => {
  // Re-assert the override: another suite in this process may have imported
  // the module first, and the path is resolved per call precisely so this
  // still wins (and so no test can write to a real keychain).
  process.env.OPENSESSION_KEYCHAIN_STORE = STORE;
  resetKeychain();
  kc = await import("./keychain");
});

afterEach(() => resetKeychain());

const cred = (over: Partial<Parameters<typeof kc.addCredential>[0]> = {}) =>
  kc.addCredential({
    owner: "Alex",
    service: "vercel",
    host: "api.vercel.com",
    secret: "sk-live-secret",
    ...over,
  });

describe("credentials", () => {
  test("registering returns metadata and never the secret", () => {
    const meta = cred();
    expect(meta.service).toBe("vercel");
    expect(meta.host).toBe("api.vercel.com");
    expect(JSON.stringify(meta)).not.toContain("sk-live-secret");
    expect(JSON.stringify(kc.listCredentials())).not.toContain(
      "sk-live-secret",
    );
    expect(JSON.stringify(kc.findCredential("vercel"))).not.toContain(
      "sk-live-secret",
    );
  });

  test("normalizes host and service, rejects malformed input", () => {
    const meta = cred({
      service: "  Vercel  ",
      host: "https://api.vercel.com/v1?x=1",
    });
    expect(meta.service).toBe("vercel");
    expect(meta.host).toBe("api.vercel.com");
    expect(() => cred({ service: "has space" })).toThrow(/slug/);
    expect(() =>
      cred({ service: "ahrefs", host: "api.ahrefs.com:8443" }),
    ).toThrow(/host/);
    expect(() => cred({ service: "ahrefs", secret: "   " })).toThrow(/secret/);
    expect(() =>
      cred({ service: "ahrefs", allowedPathPrefixes: ["v1/x"] }),
    ).toThrow(/start with/);
  });

  test("service slugs are unique", () => {
    cred();
    expect(() => cred()).toThrow(/already exists/);
  });

  test("only the owner may delete, and deleting revokes live grants", () => {
    const meta = cred();
    expect(() => kc.deleteCredential(meta.id, "Grant")).toThrow(/owner/);
    expect(kc.deleteCredential(meta.id, "Alex")).toBe(true);
    expect(kc.listCredentials()).toHaveLength(0);
    expect(kc.deleteCredential(meta.id, "Alex")).toBe(false);
  });

  test("findCredential resolves by id or service slug", () => {
    const meta = cred();
    expect(kc.findCredential(meta.id)?.id).toBe(meta.id);
    expect(kc.findCredential("VERCEL")?.id).toBe(meta.id);
    expect(kc.findCredential("nope")).toBeUndefined();
  });
});

describe("owner answers", () => {
  test("button labels map to their modes", () => {
    expect(kc.parseOwnerAnswer("Approve once", "standing")).toEqual({
      approve: true,
      mode: "once",
    });
    expect(kc.parseOwnerAnswer("Approve standing", "once")).toEqual({
      approve: true,
      mode: "standing",
    });
    expect(kc.parseOwnerAnswer("Decline", "once")).toEqual({ approve: false });
  });

  test("free text approves only on an explicit yes, keeping the requested mode", () => {
    expect(kc.parseOwnerAnswer("yes go ahead", "once")).toEqual({
      approve: true,
      mode: "once",
    });
    expect(kc.parseOwnerAnswer("ok, standing is fine", "once")).toEqual({
      approve: true,
      mode: "standing",
    });
    expect(kc.parseOwnerAnswer("no", "once")).toEqual({ approve: false });
  });

  test("anything ambiguous fails closed, keeping the text as the owner's note", () => {
    const r = kc.parseOwnerAnswer("what do you need it for?", "once");
    expect(r.approve).toBe(false);
    expect((r as { note?: string }).note).toBe("what do you need it for?");
  });
});

describe("broker", () => {
  test("rejects unknown, revoked and expired grants", () => {
    const r = kc.consumeGrantForBroker("kg-nope", "GET", "/v1/x");
    expect(r).toMatchObject({ status: 404 });
  });

  test("injects Authorization: Bearer by default and honors a custom header", () => {
    expect(
      kc.brokerHeaders({ secret: "s3cr3t" } as Parameters<
        typeof kc.brokerHeaders
      >[0]),
    ).toEqual({ Authorization: "Bearer s3cr3t" });
    expect(
      kc.brokerHeaders({
        secret: "s3cr3t",
        injection: { header: "X-Api-Key" },
      } as Parameters<typeof kc.brokerHeaders>[0]),
    ).toEqual({ "X-Api-Key": "s3cr3t" });
    expect(
      kc.brokerHeaders({
        secret: "s3cr3t",
        injection: { header: "Authorization", scheme: "token" },
      } as Parameters<typeof kc.brokerHeaders>[0]),
    ).toEqual({ Authorization: "token s3cr3t" });
  });

  test("scrubs a secret the upstream echoed back", () => {
    expect(kc.scrubSecret('{"key":"s3cr3t","ok":true}', "s3cr3t")).toBe(
      '{"key":"[redacted]","ok":true}',
    );
    expect(kc.scrubSecret("nothing here", "s3cr3t")).toBe("nothing here");
    expect(kc.scrubSecret("body", "")).toBe("body");
  });
});

describe("grant lifecycle", () => {
  // requestCredential needs the identity roster + the human-asks transport, so
  // the ask path is covered by the route/tool layers. The lifecycle below
  // exercises the parts that own the security properties.
  test("listGrants is empty for a fresh session", () => {
    expect(kc.listGrants({ sessionId: "bks-none" })).toEqual([]);
  });

  test("revoking an unknown grant reports it rather than throwing", () => {
    expect(kc.revokeGrant("kg-missing", "Alex")).toEqual({
      error: "no such grant",
    });
  });

  test("requesting an unknown credential names what exists", () => {
    cred();
    const r = kc.requestCredential({
      credential: "stripe",
      sessionId: "bks-1",
      requestedBy: "Alex",
      purpose: "test",
    });
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toContain("vercel");
  });

  test("a purpose is required — it is what the owner approves", () => {
    cred();
    const r = kc.requestCredential({
      credential: "vercel",
      sessionId: "bks-1",
      requestedBy: "Alex",
      purpose: "   ",
    });
    expect((r as { error: string }).error).toMatch(/purpose/);
  });
});

describe("grant enforcement", () => {
  test("a once grant is consumed by its first call and dead thereafter", () => {
    const meta = cred();
    const gr = kc.__mintGrantForTest({
      credentialId: meta.id,
      sessionId: "bks-1",
      requestedBy: "Grant",
      mode: "once",
    });
    const first = kc.consumeGrantForBroker(gr.id, "GET", "/v1/deployments");
    expect(first).toHaveProperty("credential");
    expect(
      (first as { credential: { secret: string } }).credential.secret,
    ).toBe("sk-live-secret");
    const second = kc.consumeGrantForBroker(gr.id, "GET", "/v1/deployments");
    expect(second).toMatchObject({ status: 403 });
    expect((second as { error: string }).error).toContain("used");
  });

  test("a standing grant survives repeated calls until revoked", () => {
    const meta = cred();
    const gr = kc.__mintGrantForTest({
      credentialId: meta.id,
      sessionId: "bks-1",
      requestedBy: "Grant",
      mode: "standing",
    });
    expect(kc.consumeGrantForBroker(gr.id, "GET", "/v1/x")).toHaveProperty(
      "credential",
    );
    expect(kc.consumeGrantForBroker(gr.id, "GET", "/v1/x")).toHaveProperty(
      "credential",
    );
    expect(kc.revokeGrant(gr.id, "Alex")).toEqual({ ok: true });
    expect(kc.consumeGrantForBroker(gr.id, "GET", "/v1/x")).toMatchObject({
      status: 403,
    });
  });

  test("an expired grant is refused and settles to expired", () => {
    const meta = cred();
    const gr = kc.__mintGrantForTest({
      credentialId: meta.id,
      sessionId: "bks-1",
      requestedBy: "Grant",
      mode: "standing",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(kc.consumeGrantForBroker(gr.id, "GET", "/v1/x")).toMatchObject({
      status: 403,
    });
    expect(kc.listGrants({ sessionId: "bks-1" })[0]!.status).toBe("expired");
  });

  test("the credential's method and path limits bound every grant", () => {
    const meta = cred({
      allowedMethods: ["GET"],
      allowedPathPrefixes: ["/v1/deployments"],
    });
    const grant = () =>
      kc.__mintGrantForTest({
        credentialId: meta.id,
        sessionId: "bks-1",
        requestedBy: "Grant",
        mode: "standing",
      });
    const gr = grant();
    expect(
      kc.consumeGrantForBroker(gr.id, "GET", "/v1/deployments/abc"),
    ).toHaveProperty("credential");
    expect(
      kc.consumeGrantForBroker(gr.id, "DELETE", "/v1/deployments/abc"),
    ).toMatchObject({
      status: 403,
    });
    expect(kc.consumeGrantForBroker(gr.id, "GET", "/v1/teams")).toMatchObject({
      status: 403,
    });
  });

  test("deleting the credential kills its live grants", () => {
    const meta = cred();
    const gr = kc.__mintGrantForTest({
      credentialId: meta.id,
      sessionId: "bks-1",
      requestedBy: "Grant",
      mode: "standing",
    });
    kc.deleteCredential(meta.id, "Alex");
    expect(kc.consumeGrantForBroker(gr.id, "GET", "/v1/x")).toMatchObject({
      status: 403,
    });
  });

  test("either side may revoke, nobody else", () => {
    const meta = cred();
    const gr = kc.__mintGrantForTest({
      credentialId: meta.id,
      sessionId: "bks-1",
      requestedBy: "Grant",
      mode: "standing",
    });
    expect(kc.revokeGrant(gr.id, "Kent")).toHaveProperty("error");
    expect(kc.revokeGrant(gr.id, "Grant")).toEqual({ ok: true });
  });

  test("grants are listed per session, so one session cannot see another's", () => {
    const meta = cred();
    kc.__mintGrantForTest({
      credentialId: meta.id,
      sessionId: "bks-1",
      requestedBy: "Grant",
      mode: "standing",
    });
    expect(kc.listGrants({ sessionId: "bks-1" })).toHaveLength(1);
    expect(kc.listGrants({ sessionId: "bks-2" })).toHaveLength(0);
  });
});

describe("grant instructions", () => {
  test("name the broker URL, the limits and the single-use rule", () => {
    const meta = cred({
      allowedMethods: ["GET"],
      allowedPathPrefixes: ["/v1/deployments"],
    });
    const text = kc.grantInstructions(
      {
        id: "kg-abc",
        credentialId: meta.id,
        owner: "Alex",
        sessionId: "bks-1",
        requestedBy: "Grant",
        purpose: "check the failing preview deploy",
        mode: "once",
        status: "active",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      meta,
    );
    expect(text).toContain("kg-abc");
    expect(text).toContain("api.vercel.com");
    expect(text).toContain("SINGLE-USE");
    expect(text).toContain("GET");
    expect(text).toContain("/v1/deployments");
    expect(text).toContain("check the failing preview deploy");
    expect(text).not.toContain("sk-live-secret");
  });
});
