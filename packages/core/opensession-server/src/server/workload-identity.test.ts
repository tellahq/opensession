import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = mkdtempSync(join(tmpdir(), "opensession-workload-identity-"));
const previousState = process.env.OPENSESSION_STATE_DIR;
const previousConfig = process.env.OPENSESSION_SANDBOX_CONFIG;
const previousGrants = process.env.OPENSESSION_WORKLOAD_IDENTITY_GRANTS;
process.env.OPENSESSION_STATE_DIR = root;
process.env.OPENSESSION_SANDBOX_CONFIG = join(root, "sandbox.json");
writeFileSync(
  process.env.OPENSESSION_SANDBOX_CONFIG,
  JSON.stringify({ callbackBaseUrl: "https://identity.example.test" }),
);

const identity = await import("./workload-identity");

function claims(token: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
  );
}

async function verifiesWith(token: string, jwk: JsonWebKey): Promise<boolean> {
  const [header, payload, signature] = token.split(".");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    Buffer.from(signature!, "base64url"),
    new TextEncoder().encode(`${header}.${payload}`),
  );
}

afterAll(() => {
  if (previousState === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousState;
  if (previousConfig === undefined)
    delete process.env.OPENSESSION_SANDBOX_CONFIG;
  else process.env.OPENSESSION_SANDBOX_CONFIG = previousConfig;
  if (previousGrants === undefined)
    delete process.env.OPENSESSION_WORKLOAD_IDENTITY_GRANTS;
  else process.env.OPENSESSION_WORKLOAD_IDENTITY_GRANTS = previousGrants;
  rmSync(root, { recursive: true, force: true });
});

describe("sandbox workload identity", () => {
  beforeEach(() => {
    process.env.OPENSESSION_WORKLOAD_IDENTITY_GRANTS = JSON.stringify([
      {
        repoId: "fusion",
        lifecycle: "setup",
        audiences: ["urn:test:artifacts"],
      },
      { repoId: "fusion", lifecycle: "run", audiences: ["urn:test:run"] },
    ]);
  });

  test("publishes discovery and a matching RS256 JWKS", async () => {
    const response = await identity.handleWorkloadIdentityRequest(
      new Request(
        "https://identity.example.test/workload-identity/.well-known/openid-configuration",
      ),
    );
    expect(response?.status).toBe(200);
    const document = (await response?.json()) as Record<string, unknown>;
    expect(document.issuer).toBe(
      "https://identity.example.test/workload-identity",
    );
    expect(document.jwks_uri).toBe(
      "https://identity.example.test/workload-identity/jwks.json",
    );
    expect(document.claims_supported).toEqual([
      "aud",
      "exp",
      "iat",
      "iss",
      "sub",
    ]);
    const jwks = await identity.handleWorkloadIdentityRequest(
      new Request("https://identity.example.test/workload-identity/jwks.json"),
    );
    const keys = (
      (await jwks?.json()) as { keys: Array<Record<string, unknown>> }
    ).keys;
    expect(keys).toHaveLength(1);
    expect(Object.keys(keys[0] || {}).sort()).toEqual([
      "alg",
      "e",
      "kid",
      "kty",
      "n",
      "use",
    ]);
    expect(keys[0]?.alg).toBe("RS256");
    expect(keys[0]?.use).toBe("sig");
  });

  test("exchanges a sandbox lease for an audience-bound identity token", async () => {
    const env = identity.createWorkloadIdentityEnv({
      sandboxId: "sbx-123",
      provider: "daytona",
      lifecycle: "setup",
      sessionId: "os-session",
      repoId: "fusion",
      userId: "user-1",
      trustProfile: "interactive",
    });
    const response = await identity.handleWorkloadIdentityRequest(
      new Request(env.OPENSESSION_WORKLOAD_IDENTITY_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.OPENSESSION_WORKLOAD_IDENTITY_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          audience: "urn:test:artifacts",
          ttl_seconds: 120,
        }),
      }),
    );
    expect(response?.status).toBe(200);
    const token = (await response?.text()) as string;
    expect(token.split(".")).toHaveLength(3);
    const jwks = await identity.handleWorkloadIdentityRequest(
      new Request("https://identity.example.test/workload-identity/jwks.json"),
    );
    const [jwk] = ((await jwks?.json()) as { keys: JsonWebKey[] }).keys;
    expect(await verifiesWith(token, jwk!)).toBe(true);
    expect(claims(token)).toMatchObject({
      iss: "https://identity.example.test/workload-identity",
      aud: "urn:test:artifacts",
      sandbox_id: "sbx-123",
      sandbox_provider: "daytona",
      lifecycle: "setup",
      session_id: "os-session",
      repo_id: "fusion",
      user_id: "user-1",
      trust_profile: "interactive",
      token_use: "exchanged",
    });
  });

  test("rejects malformed requests and revoked sandbox leases", async () => {
    const env = identity.createWorkloadIdentityEnv({
      sandboxId: "sbx-revoke",
      provider: "modal",
      lifecycle: "run",
      repoId: "fusion",
    });
    const malformed = await identity.handleWorkloadIdentityRequest(
      new Request(env.OPENSESSION_WORKLOAD_IDENTITY_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.OPENSESSION_WORKLOAD_IDENTITY_TOKEN}`,
        },
        body: JSON.stringify({ audience: "contains whitespace" }),
      }),
    );
    expect(malformed?.status).toBe(400);
    const forbidden = await identity.handleWorkloadIdentityRequest(
      new Request(env.OPENSESSION_WORKLOAD_IDENTITY_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.OPENSESSION_WORKLOAD_IDENTITY_TOKEN}`,
        },
        body: JSON.stringify({ audience: "urn:test:forbidden" }),
      }),
    );
    expect(forbidden?.status).toBe(403);
    identity.revokeWorkloadIdentityForSandbox("sbx-revoke");
    const revoked = await identity.handleWorkloadIdentityRequest(
      new Request(env.OPENSESSION_WORKLOAD_IDENTITY_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.OPENSESSION_WORKLOAD_IDENTITY_TOKEN}`,
        },
        body: JSON.stringify({ audience: "urn:test:revoked" }),
      }),
    );
    expect(revoked?.status).toBe(401);
  });

  test("does not create a lease without a matching central audience grant", () => {
    const env = identity.createWorkloadIdentityEnv({
      sandboxId: "sbx-no-grant",
      provider: "box",
      lifecycle: "preview",
      repoId: "fusion",
    });
    expect(env).toEqual({});
  });
});
