/**
 * Workspace credentials: an owner shares an API credential with every
 * session, which then calls it without an ask, within the same host,
 * method and path ceiling, with the secret still injected server-side and
 * every call audited with its session, caller and purpose. Only the owner
 * can share it or make it personal again, which ends the access sessions
 * got without asking. A login is never shareable.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = join(mkdtempSync(join(tmpdir(), "kc-workspace-")), "kc.json");
process.env.OPENSESSION_KEYCHAIN_STORE = STORE;

const events: Array<Record<string, any>> = [];
const realAudit = await import("./audit");
mock.module("./audit", () => ({
  ...realAudit,
  audit: (e: Record<string, any>) => events.push(e),
  auditAsync: (e: Record<string, any>) => events.push(e),
}));

const kc = await import("./keychain");
const { brokerCall } = await import("./keychain-broker");

const SECRET = "sk-workspace-secret-4321";

function reset(): void {
  if (existsSync(STORE)) rmSync(STORE);
  const g = globalThis as any;
  g.__keychainCredentials?.clear();
  g.__keychainGrants?.clear();
  g.__keychainAsks?.clear();
}

let seen: Array<{ url: string; headers: Headers }> = [];
const fetchImpl = (async (url: URL, init: RequestInit) => {
  seen.push({ url: String(url), headers: new Headers(init.headers) });
  return Response.json(
    { ok: true, echoed: SECRET },
    { headers: { "content-type": "application/json" } },
  );
}) as unknown as typeof fetch;

beforeEach(() => {
  process.env.OPENSESSION_KEYCHAIN_STORE = STORE;
  reset();
  seen = [];
  events.length = 0;
});
afterEach(reset);

function shared(over: Partial<Parameters<typeof kc.addCredential>[0]> = {}) {
  return kc.addCredential({
    owner: "Alex",
    service: "metrics",
    host: "api.example.test",
    secret: SECRET,
    allowedMethods: ["GET", "POST"],
    allowedPathPrefixes: ["/v1/"],
    scope: "workspace",
    ...over,
  });
}

const call = (over: Partial<Parameters<typeof brokerCall>[0]> = {}) =>
  brokerCall({
    sessionId: "s-1",
    credential: "metrics",
    method: "GET",
    path: "/v1/usage",
    requestedBy: "Sam",
    purpose: "check this month's usage",
    fetchImpl,
    ...over,
  });

describe("registering a workspace credential", () => {
  test("an API credential can be workspace-scoped; personal is the default", () => {
    expect(shared().scope).toBe("workspace");
    const personal = kc.addCredential({
      owner: "Alex",
      service: "billing",
      host: "api.example.test",
      secret: "sk-other",
      scope: "personal",
    });
    expect(personal.scope).toBeUndefined();
    expect(kc.listCredentials().map((c) => [c.service, c.scope])).toEqual([
      ["metrics", "workspace"],
      ["billing", undefined],
    ]);
  });

  test("a login can never be workspace-scoped", () => {
    expect(() =>
      kc.addCredential({
        owner: "Alex",
        service: "staging-login",
        kind: "login",
        loginUrl: "https://app.example.test/login",
        username: "qa@example.test",
        secret: "hunter2",
        scope: "workspace",
      }),
    ).toThrow(/login can't be a workspace credential/);
  });

  test("an unknown scope is refused", () => {
    expect(() => shared({ scope: "everyone" as any })).toThrow(/scope must be/);
  });
});

describe("calling a workspace credential", () => {
  test("any session calls it without an ask, and the secret is injected, not returned", async () => {
    shared();
    const result = await call();
    expect("status" in result && result.status).toBe(200);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(seen[0]!.url).toBe("https://api.example.test/v1/usage");
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${SECRET}`);

    // Another session gets its own implicit grant.
    expect("status" in (await call({ sessionId: "s-2" }))).toBe(true);
    const grants = kc.listGrants().filter((g) => g.mode === "workspace");
    expect(grants.map((g) => g.sessionId).sort()).toEqual(["s-1", "s-2"]);
    expect(grants.every((g) => g.implicit && !g.askId)).toBe(true);
    expect(kc.listKeychainAsks()).toHaveLength(0);
  });

  test("one grant per session, reused across calls", async () => {
    shared();
    await call();
    await call({ purpose: "and last month's" });
    expect(kc.listGrants({ sessionId: "s-1" })).toHaveLength(1);
  });

  test("every call is audited with session, caller and purpose", async () => {
    shared();
    await call();
    const line = events.find((e) => e.kind === "keychain_broker_call");
    expect(line).toMatchObject({
      session_id: "s-1",
      requested_by: "Sam",
      purpose: "check this month's usage",
      mode: "workspace",
      service: "metrics",
      path: "/v1/usage",
    });
    expect(
      events.find((e) => e.kind === "keychain_grant_minted"),
    ).toMatchObject({ scope: "workspace", session_id: "s-1" });
  });

  test("a purpose is required", async () => {
    shared();
    const result = await call({ purpose: "  " });
    expect(result).toEqual({
      error: expect.stringMatching(/workspace credential: pass purpose/),
    });
    expect(seen).toHaveLength(0);
    expect(kc.listGrants()).toHaveLength(0);
  });

  test("the method and path ceiling still holds", async () => {
    shared();
    expect(await call({ method: "DELETE" })).toEqual({
      error: expect.stringMatching(/method DELETE is not allowed/),
    });
    expect(await call({ path: "/v1/../admin" })).toEqual({
      error: expect.stringMatching(/outside this credential's allowed/),
    });
    expect(seen).toHaveLength(0);
  });

  test("a personal credential still needs its owner's grant", async () => {
    shared({ scope: undefined });
    expect(await call()).toEqual({
      error: expect.stringMatching(/no live grant/),
    });
    expect(kc.listGrants()).toHaveLength(0);
  });

  test("request_credential hands back the grant without asking anyone", () => {
    shared();
    const result = kc.requestCredential({
      credential: "metrics",
      sessionId: "s-1",
      requestedBy: "Sam",
      purpose: "check usage",
    });
    if (!("grant" in result)) throw new Error(JSON.stringify(result));
    expect(result.grant.mode).toBe("workspace");
    expect(result.instructions).toContain("workspace credential");
    expect(kc.listKeychainAsks()).toHaveLength(0);
    // Asking again returns the same grant.
    const again = kc.requestCredential({
      credential: "metrics",
      sessionId: "s-1",
      requestedBy: "Sam",
      purpose: "something else",
    });
    expect("grant" in again && again.grant.id).toBe(result.grant.id);
  });
});

describe("sharing and unsharing", () => {
  test("only the owner can change the scope", async () => {
    const cred = shared({ scope: undefined });
    await expect(
      kc.setCredentialScopeAsync(cred.id, "Sam", "workspace"),
    ).rejects.toThrow(/only the credential's owner/);
    const done = await kc.setCredentialScopeAsync(cred.id, "Alex", "workspace");
    expect(done.changed).toEqual(["scope"]);
    expect(kc.findCredential("metrics")?.scope).toBe("workspace");
    expect(
      events.find((e) => e.kind === "keychain_credential_updated"),
    ).toMatchObject({ scope: "workspace", fields: ["scope"], by: "Alex" });
  });

  test("making it personal again revokes implicit grants and keeps approved ones", async () => {
    const cred = shared();
    await call();
    const approved = kc.__mintGrantForTest({
      credentialId: cred.id,
      sessionId: "s-2",
      requestedBy: "Bea",
      mode: "standing",
    });
    const done = await kc.setCredentialScopeAsync(cred.id, "Alex", "personal");
    expect(done.grantsRevoked).toBe(1);
    expect(kc.findCredential("metrics")?.scope).toBeUndefined();
    expect(await call()).toEqual({
      error: expect.stringMatching(/no live grant/),
    });
    expect(kc.listGrants().find((g) => g.id === approved.id)?.status).toBe(
      "active",
    );
    expect("status" in (await call({ sessionId: "s-2" }))).toBe(true);
  });

  test("a login can't be shared", async () => {
    const login = kc.addCredential({
      owner: "Alex",
      service: "staging-login",
      kind: "login",
      loginUrl: "https://app.example.test/login",
      username: "qa@example.test",
      secret: "hunter2",
    });
    await expect(
      kc.setCredentialScopeAsync(login.id, "Alex", "workspace"),
    ).rejects.toThrow(/login can't be a workspace credential/);
  });
});

describe("scripted runs with workspace credentials", () => {
  const claim = (over: Partial<Parameters<typeof kc.claimRunGrants>[0]> = {}) =>
    kc.claimRunGrants({
      sessionId: "s-1",
      credentials: ["metrics"],
      command: "bun sync.ts",
      runId: `sr-${crypto.randomUUID()}`,
      deadline: Date.now() + 60_000,
      requestedBy: "Sam",
      purpose: "sync usage into the warehouse",
      ...over,
    });

  test("start without approval, with a stated purpose and cap", async () => {
    shared();
    const result = await claim({ maxCalls: 50 });
    if ("error" in result) throw new Error(result.error);
    const { grant } = result.claims[0]!;
    expect(grant).toMatchObject({
      mode: "run",
      implicit: true,
      purpose: "sync usage into the warehouse",
      run: { command: "bun sync.ts", maxCalls: 50 },
    });
    expect(kc.useRunGrant(grant.id, grant.runId!, "GET", "/v1/x")).toEqual({
      credential: expect.objectContaining({ service: "metrics" }),
    });
  });

  test("the default cap applies when none is given", async () => {
    shared();
    const result = await claim();
    if ("error" in result) throw new Error(result.error);
    expect(result.claims[0]!.grant.run?.maxCalls).toBe(
      kc.DEFAULT_WORKSPACE_RUN_CALLS,
    );
  });

  test("a purpose is required", async () => {
    shared();
    expect(await claim({ purpose: undefined })).toEqual({
      error: expect.stringMatching(/needs a purpose/),
    });
    expect(kc.listGrants()).toHaveLength(0);
  });

  test("a personal credential in the run still needs approval", async () => {
    shared();
    kc.addCredential({
      owner: "Bea",
      service: "billing",
      host: "billing.example.test",
      secret: "sk-billing",
    });
    expect(await claim({ credentials: ["metrics", "billing"] })).toEqual({
      error: expect.stringMatching(/no approved scripted run/),
    });
    expect(kc.listGrants()).toHaveLength(0);
  });

  test("several workspace credentials run together without approval", async () => {
    shared();
    shared({ service: "events", host: "events.example.test" });
    const result = await claim({ credentials: ["metrics", "events"] });
    if ("error" in result) throw new Error(result.error);
    expect(result.claims.map((c) => c.credential.service)).toEqual([
      "metrics",
      "events",
    ]);
    const groups = new Set(result.claims.map((c) => c.grant.run?.group?.id));
    expect(groups.size).toBe(1);
  });

  test("request_credential for a run of workspace credentials needs no owner", () => {
    shared();
    shared({ service: "events", host: "events.example.test" });
    const result = kc.requestCredentialRun({
      credentials: ["metrics", "events"],
      sessionId: "s-1",
      requestedBy: "Sam",
      purpose: "sync",
      run: { command: "bun sync.ts", maxCalls: 10 },
    });
    if (!("grants" in result)) throw new Error(JSON.stringify(result));
    expect(result.grants).toHaveLength(2);
    expect(result.instructions).toContain("needs no approval");
    expect(kc.listKeychainAsks()).toHaveLength(0);
  });

  test("unsharing stops a run's implicit grant", async () => {
    const cred = shared();
    const result = await claim();
    if ("error" in result) throw new Error(result.error);
    const grant = result.claims[0]!.grant;
    await kc.setCredentialScopeAsync(cred.id, "Alex", "personal");
    expect(kc.useRunGrant(grant.id, grant.runId!, "GET", "/v1/x")).toEqual({
      error: expect.stringMatching(/revoked/),
      status: 403,
    });
  });
});

describe("a person's turn in an automation session", () => {
  const server = async () => {
    const { createKeychainMcpServer } =
      await import("../agents/slack/keychain-tools");
    return createKeychainMcpServer({
      sessionId: "s-1",
      user: "Sam",
      automationTurn: true,
    }) as any;
  };

  test("the keychain server carries the ask and use tools only", async () => {
    expect(
      Object.keys((await server()).instance._registeredTools).sort(),
    ).toEqual([
      "call_credential",
      "cancel_credential_ask",
      "credential_run_status",
      "list_credentials",
      "list_grants",
      "request_credential",
      "run_with_credential",
      "stop_credential_run",
    ]);
  });

  test("a login can't be asked for", async () => {
    kc.addCredential({
      owner: "Alex",
      service: "staging-login",
      kind: "login",
      loginUrl: "https://app.example.test/login",
      username: "qa@example.test",
      secret: "hunter2",
    });
    const tool = (await server()).instance._registeredTools.request_credential;
    const result = await tool.handler(
      { credential: "staging-login", purpose: "sign in" },
      {},
    );
    expect(result.content[0].text).toMatch(/is a login/);
    expect(kc.listKeychainAsks()).toHaveLength(0);
  });

  test("a workspace credential is answered without asking anyone", async () => {
    shared();
    const tool = (await server()).instance._registeredTools.request_credential;
    const result = await tool.handler(
      { credential: "metrics", purpose: "check usage" },
      {},
    );
    expect(result.content[0].text).toContain("workspace credential");
    expect(kc.listKeychainAsks()).toHaveLength(0);
  });
});
