/**
 * Workspace credentials: an owner shares an API credential with every
 * session, which then calls it without an ask, within the same host,
 * method and path ceiling, with the secret still injected server-side and
 * every call audited with its session, caller and purpose. Only the owner
 * can share it or make it personal again, which ends the access sessions
 * got without asking. A shared login has its password released to any
 * interactive session without an ask, each release audited with its purpose.
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

function sharedLogin(
  over: Partial<Parameters<typeof kc.addCredential>[0]> = {},
) {
  return kc.addCredential({
    owner: "Alex",
    service: "mac-mini",
    kind: "login",
    loginUrl: "vnc://192.0.2.10:5900",
    username: "admin",
    secret: "hunter2",
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

  test("a login can be workspace-scoped; personal is the default", () => {
    expect(sharedLogin().scope).toBe("workspace");
    expect(sharedLogin({ service: "mine", scope: undefined }).scope).toBe(
      undefined,
    );
  });

  test("a login may name a machine over VNC or SSH, never plain http", () => {
    expect(sharedLogin({ loginUrl: "vnc://192.0.2.10:5900" })).toMatchObject({
      host: "192.0.2.10",
      loginUrl: "vnc://192.0.2.10:5900",
    });
    expect(
      sharedLogin({ service: "box-ssh", loginUrl: "ssh://box.example.test" })
        .host,
    ).toBe("box.example.test");
    // A machine's host is stored lower-case, like a web page's, so the
    // card's re-check at submit matches it.
    const mixed = sharedLogin({
      service: "lab-mac",
      loginUrl: "vnc://Lab-Mac.Example.test:5900",
      host: "lab-mac.example.test",
    });
    expect(mixed).toMatchObject({
      host: "lab-mac.example.test",
      loginUrl: "vnc://lab-mac.example.test:5900",
    });
    for (const loginUrl of [
      "http://app.example.test/login",
      "ftp://box.example.test",
      "vnc://admin:pw@192.0.2.10",
      "vnc://",
    ])
      expect(() => sharedLogin({ service: "bad", loginUrl })).toThrow(
        /loginUrl must be/,
      );
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

  test("an owner can share a personal login, and only the owner", async () => {
    const login = sharedLogin({ scope: undefined });
    await expect(
      kc.setCredentialScopeAsync(login.id, "Sam", "workspace"),
    ).rejects.toThrow(/only the credential's owner/);
    const done = await kc.setCredentialScopeAsync(
      login.id,
      "Alex",
      "workspace",
    );
    expect(done.changed).toEqual(["scope"]);
    expect(kc.findCredential("mac-mini")).toMatchObject({
      kind: "login",
      scope: "workspace",
    });
  });
});

describe("workspace logins", () => {
  const PASSWORD = "machine-password-987";
  const release = (
    over: Partial<Parameters<typeof kc.claimLoginRelease>[0]> = {},
  ) =>
    kc.claimLoginRelease({
      sessionId: "s-1",
      credential: "mac-mini",
      requestedBy: "Sam",
      purpose: "grant Screen Recording over VNC",
      ...over,
    });

  test("any session gets the password without an ask, audited with who and why", async () => {
    sharedLogin({ secret: PASSWORD });
    const first = await release();
    if ("error" in first) throw new Error(first.error);
    expect(first.credential.secret).toBe(PASSWORD);
    expect(first.grant).toMatchObject({
      mode: "release",
      implicit: true,
      status: "used",
      sessionId: "s-1",
    });
    expect(kc.listKeychainAsks()).toHaveLength(0);
    expect(
      events.find((e) => e.kind === "keychain_login_released"),
    ).toMatchObject({
      session_id: "s-1",
      requested_by: "Sam",
      purpose: "grant Screen Recording over VNC",
      scope: "workspace",
    });
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
    // Each release is its own, from any session.
    const other = await release({ sessionId: "s-2", requestedBy: "Bea" });
    expect("credential" in other).toBe(true);
  });

  test("a purpose is required", async () => {
    sharedLogin();
    expect(await release({ purpose: "  " })).toEqual({
      error: expect.stringMatching(/workspace login: pass a purpose/),
    });
    expect(kc.listGrants()).toHaveLength(0);
  });

  test("a personal login still needs its owner's release", async () => {
    sharedLogin({ scope: undefined });
    expect(await release()).toEqual({
      error: expect.stringMatching(/no approved release/),
    });
  });

  test("request_credential mints a release without asking, and use spends it", async () => {
    sharedLogin();
    const asked = kc.requestCredential({
      credential: "mac-mini",
      sessionId: "s-1",
      requestedBy: "Sam",
      purpose: "sign in over VNC",
    });
    if (!("grant" in asked)) throw new Error("expected a grant");
    expect(asked.grant).toMatchObject({ mode: "release", implicit: true });
    expect(asked.instructions).toContain("workspace login");
    expect(asked.instructions).toContain("use_login");
    expect(kc.listKeychainAsks()).toHaveLength(0);
    const used = await release({ purpose: undefined });
    expect("grant" in used && used.grant.id).toBe(asked.grant.id);
  });

  test("a release asked for one purpose is not spent for another", async () => {
    sharedLogin();
    const asked = kc.requestCredential({
      credential: "mac-mini",
      sessionId: "s-1",
      requestedBy: "Sam",
      purpose: "check the VNC connection",
    });
    if (!("grant" in asked)) throw new Error("expected a grant");
    const used = await release({ purpose: "approve an admin prompt" });
    if ("error" in used) throw new Error(used.error);
    expect(used.grant.id).not.toBe(asked.grant.id);
    expect(used.grant.purpose).toBe("approve an admin prompt");
    expect(kc.listGrants().find((g) => g.id === asked.grant.id)?.status).toBe(
      "active",
    );
    const same = await release({ purpose: "Check the VNC connection" });
    expect("grant" in same && same.grant.id).toBe(asked.grant.id);
  });

  test("a failed write after unsharing doesn't bring the release back", async () => {
    const login = sharedLogin();
    const asked = kc.requestCredential({
      credential: "mac-mini",
      sessionId: "s-1",
      requestedBy: "Sam",
      purpose: "sign in over VNC",
    });
    if (!("grant" in asked)) throw new Error("expected a grant");
    const claimed = await release({ purpose: "sign in over VNC" });
    if ("error" in claimed) throw new Error(claimed.error);
    await kc.setCredentialScopeAsync(login.id, "Alex", "personal");
    await claimed.undo();
    expect(kc.listGrants().find((g) => g.id === asked.grant.id)?.status).toBe(
      "revoked",
    );
    expect(await release()).toEqual({
      error: expect.stringMatching(/no approved release/),
    });
  });

  test("a failed write drops a release minted for it", async () => {
    sharedLogin();
    const first = await release();
    if ("error" in first) throw new Error(first.error);
    await first.undo();
    expect(kc.listGrants()).toHaveLength(0);
  });

  test("making it personal again revokes releases nobody approved", async () => {
    const login = sharedLogin();
    kc.requestCredential({
      credential: "mac-mini",
      sessionId: "s-1",
      requestedBy: "Sam",
      purpose: "sign in over VNC",
    });
    const done = await kc.setCredentialScopeAsync(login.id, "Alex", "personal");
    expect(done.grantsRevoked).toBe(1);
    expect(await release()).toEqual({
      error: expect.stringMatching(/no approved release/),
    });
  });

  test("use_login takes a purpose and writes the password to a file, not the result", async () => {
    sharedLogin({ secret: PASSWORD });
    const written: string[] = [];
    const { createKeychainMcpServer } =
      await import("../agents/slack/keychain-tools");
    const server = createKeychainMcpServer({
      sessionId: "s-1",
      user: "Sam",
      loginTarget: async () => ({
        kind: "sandbox",
        exec: Object.assign(
          async (cmd: string[], opts?: { env?: Record<string, string> }) => {
            if (cmd[0] !== "rm")
              written.push(opts!.env!.KEYCHAIN_LOGIN_PASSWORD!);
            return { exitCode: 0, stdout: "", stderr: "" };
          },
          { sandboxed: true, remote: true } as const,
        ),
      }),
    }) as any;
    const tool = server.instance._registeredTools.use_login;
    const refused = await tool.handler({ credential: "mac-mini" }, {});
    expect(refused.content[0].text).toMatch(/pass a purpose/);
    const result = await tool.handler(
      { credential: "mac-mini", purpose: "approve an admin prompt" },
      {},
    );
    const text = result.content[0].text;
    expect(text).not.toContain(PASSWORD);
    expect(JSON.parse(text)).toMatchObject({
      loginUrl: "vnc://192.0.2.10:5900",
      username: "admin",
    });
    expect(written).toEqual([PASSWORD]);
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

  test("the keychain server carries the ask, use and card tools only", async () => {
    expect(
      Object.keys((await server()).instance._registeredTools).sort(),
    ).toEqual([
      "call_credential",
      "cancel_credential_ask",
      "credential_run_status",
      "delete_credential",
      "list_credentials",
      "list_grants",
      "register_credential",
      "request_credential",
      "run_with_credential",
      "stop_credential_run",
      "update_credential",
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

  test("a workspace login still can't be asked for", async () => {
    sharedLogin();
    const tool = (await server()).instance._registeredTools.request_credential;
    const result = await tool.handler(
      { credential: "mac-mini", purpose: "sign in" },
      {},
    );
    expect(result.content[0].text).toMatch(/is a login/);
    expect(kc.listGrants()).toHaveLength(0);
  });
});
