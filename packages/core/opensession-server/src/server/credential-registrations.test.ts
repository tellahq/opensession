import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Never the real keychain: resolved per call, so set it before any import.
const STORE = join(mkdtempSync(join(tmpdir(), "kc-register-")), "kc.json");
process.env.OPENSESSION_KEYCHAIN_STORE = STORE;

const SECRET = "sk-test-DO-NOT-LEAK-7f3a";

// Everything that could carry the secret out of the server: socket
// broadcasts, audit lines, console output. Captured, then searched.
const broadcasts: unknown[] = [];
const audits: unknown[] = [];
const realHub = await import("./ws-hub");
mock.module("./ws-hub", () => ({
  ...realHub,
  broadcastToSession: (_sessionId: string, msg: object) => {
    broadcasts.push(msg);
  },
}));
const realAudit = await import("./audit");
mock.module("./audit", () => ({
  ...realAudit,
  audit: (event: Record<string, unknown>) => {
    audits.push(event);
  },
}));
// Holds async keychain writes open while a test needs a save in flight.
let writeGate: Promise<void> | null = null;
const realWrite = await import("./shared/atomic-write");
// Captured before mocking: mock.module swaps the namespace in place.
const writeJsonAtomicAsync = realWrite.writeJsonAtomicAsync;
mock.module("./shared/atomic-write", () => ({
  ...realWrite,
  writeJsonAtomicAsync: async (
    ...args: Parameters<typeof writeJsonAtomicAsync>
  ) => {
    await writeGate;
    return writeJsonAtomicAsync(...args);
  },
}));
// A two-person roster: Alex drives sessions, Blair is another teammate.
const ROSTER: Record<string, { name: string; slackId: string; login: string }> =
  {
    alex: { name: "Alex", slackId: "UALEX0001", login: "alex-gh" },
    blair: { name: "Blair", slackId: "UBLAIR001", login: "blair-gh" },
  };
const who = (ref?: string | null) =>
  ref ? ROSTER[ref.trim().toLowerCase()] : undefined;
const realMappings = await import("./shared/user-mappings");
mock.module("./shared/user-mappings", () => ({
  ...realMappings,
  resolveTeammate: (ref?: string | null) => {
    const p = who(ref);
    return p ? { name: p.name, slackId: p.slackId } : null;
  },
  githubLoginFor: (ref?: string | null) => who(ref)?.login ?? null,
}));

const reg = await import("./credential-registrations");
const kc = await import("./keychain");
const { handleKeychainRoutes } = await import("./routes/keychain");
const { crossSiteViolation } = await import("./web-auth");
const { createKeychainMcpServer } =
  await import("../agents/slack/keychain-tools");

const consoleLines: unknown[][] = [];
const originalConsole = { ...console };

function resetKeychain(): void {
  if (existsSync(STORE)) rmSync(STORE);
  const g = globalThis as any;
  g.__keychainCredentials?.clear();
  g.__keychainGrants?.clear();
  g.__keychainAsks?.clear();
  g.__pendingCredentialRegistrations?.clear();
}

beforeEach(() => {
  process.env.OPENSESSION_KEYCHAIN_STORE = STORE;
  resetKeychain();
  broadcasts.length = 0;
  audits.length = 0;
  consoleLines.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    (console as any)[level] = (...args: unknown[]) => consoleLines.push(args);
  }
});

afterEach(() => {
  writeGate = null;
  Object.assign(console, originalConsole);
  resetKeychain();
});

function expectNoSecretLeaked(...extra: unknown[]): void {
  for (const value of [broadcasts, audits, consoleLines, ...extra]) {
    expect(JSON.stringify(value)).not.toContain(SECRET);
  }
}

function open(
  sessionId: string,
  service = "acme-prod",
  signal?: AbortSignal,
  ttlMs?: number,
) {
  return reg.requestCredentialRegistration(
    sessionId,
    {
      owner: "Alex",
      login: "alex-gh",
      spec: { service, host: "https://api.example.test/v1" },
    },
    signal,
    ttlMs,
  );
}

function route(
  path: string,
  authUser: { login: string; name: string; automation?: boolean } | null,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const url = new URL(path, "https://os.example.test");
  return handleKeychainRoutes({
    path: url.pathname,
    url,
    publicPrefix: "",
    authUser,
    req: new Request(
      url,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body),
          },
    ),
  }) as Promise<Response>;
}
const alex = { login: "alex-gh", name: "Alex Example" };
const blair = { login: "blair-gh", name: "Blair Example" };

describe("registration requests", () => {
  test("the driver's secret lands in the keychain; the waiter gets metadata only", async () => {
    const waiting = open("s-ok");
    const { request } = reg.pendingCredentialRegistration("s-ok")!;
    expect(request.host).toBe("api.example.test");
    expect(request.owner).toBe("Alex");

    const meta = await reg.submitCredentialRegistration(
      "s-ok",
      request.id,
      "Alex-GH",
      SECRET,
    );
    const result = await waiting;
    expect(result.status).toBe("registered");
    if (result.status !== "registered") return;
    expect(result.credential).toMatchObject({
      id: meta.id,
      service: "acme-prod",
      host: "api.example.test",
      owner: "Alex",
    });
    // Same store and shape as Settings → Account: the broker can use it.
    expect(readFileSync(STORE, "utf8")).toContain(SECRET);
    expect(kc.findCredential("acme-prod")?.id).toBe(meta.id);
    expect(reg.pendingCredentialRegistration("s-ok")).toBeNull();
    expectNoSecretLeaked(result, meta);
  });

  test("only the driver can answer, and a wrong answer leaves it open", async () => {
    const waiting = open("s-auth");
    const { request } = reg.pendingCredentialRegistration("s-auth")!;
    for (const login of ["blair-gh", ""]) {
      await expect(
        reg.submitCredentialRegistration("s-auth", request.id, login, SECRET),
      ).rejects.toThrow(/Only Alex/);
      expect(() =>
        reg.declineCredentialRegistration("s-auth", request.id, login),
      ).toThrow(/Only Alex/);
    }
    await expect(
      reg.submitCredentialRegistration("s-auth", request.id, "alex-gh", "  "),
    ).rejects.toThrow("Paste the secret first");
    expect(kc.listCredentials()).toEqual([]);
    reg.declineCredentialRegistration("s-auth", request.id, "alex-gh");
    expect(await waiting).toEqual({ status: "declined" });
    expect(kc.listCredentials()).toEqual([]);
  });

  test("a taken service slug is refused before any card, and on a race at submit", async () => {
    kc.addCredential({
      owner: "Blair",
      service: "acme-prod",
      host: "api.example.test",
      secret: "other",
    });
    expect(() => open("s-dup")).toThrow(/already exists/);
    expect(reg.pendingCredentialRegistration("s-dup")).toBeNull();
    expect(broadcasts).toEqual([]);

    const waiting = open("s-race", "acme-sandbox");
    const { request } = reg.pendingCredentialRegistration("s-race")!;
    kc.addCredential({
      owner: "Blair",
      service: "acme-sandbox",
      host: "api.example.test",
      secret: "other",
    });
    await expect(
      reg.submitCredentialRegistration("s-race", request.id, "alex-gh", SECRET),
    ).rejects.toThrow(/already exists/);
    expect(reg.pendingCredentialRegistration("s-race")?.request.id).toBe(
      request.id,
    );
    expect(
      kc.listCredentials().filter((c) => c.service === "acme-sandbox"),
    ).toHaveLength(1);
    reg.declineCredentialRegistration("s-race", request.id, "alex-gh");
    await waiting;
    expectNoSecretLeaked();
  });

  test("one request per session; bad specs and expiry close cleanly", async () => {
    const first = open("s-one");
    expect(() => open("s-one", "other")).toThrow(/already has an open/);
    expect(() =>
      reg.requestCredentialRegistration("s-bad", {
        owner: "Alex",
        login: "alex-gh",
        spec: { service: "Acme Prod!", host: "api.example.test" },
      }),
    ).toThrow(/slug/);
    expect(() =>
      reg.requestCredentialRegistration("s-bad", {
        owner: "Alex",
        login: "alex-gh",
        spec: {
          service: "acme",
          host: "api.example.test",
          injection: { header: "X-Key\r\nEvil: 1" },
        },
      }),
    ).toThrow(/header/);
    const { request } = reg.pendingCredentialRegistration("s-one")!;
    reg.declineCredentialRegistration("s-one", request.id, "alex-gh");
    await first;

    const spoof = reg.requestCredentialRegistration("s-spoof", {
      owner: "Alex",
      login: "alex-gh",
      spec: {
        service: "acme-spoof",
        host: "api.example.test",
        description: "Read-only\u202e key\nfor reports",
      },
    });
    const shown = reg.pendingCredentialRegistration("s-spoof")!.request;
    expect(shown.description).toBe("Read-only  key for reports");
    reg.declineCredentialRegistration("s-spoof", shown.id, "alex-gh");
    await spoof;

    expect(await open("s-expire", "acme-exp", undefined, 5)).toEqual({
      status: "expired",
    });
  });

  test("a cancelled call leaves the card open, and asking again waits on it", async () => {
    const controller = new AbortController();
    const cancelled = open("s-abort", "acme-abort", controller.signal);
    const { request } = reg.pendingCredentialRegistration("s-abort")!;
    controller.abort();

    expect(await cancelled).toEqual({ status: "pending", request });
    expect(reg.pendingCredentialRegistration("s-abort")?.request.id).toBe(
      request.id,
    );
    expect(() => open("s-abort", "acme-other")).toThrow(
      /open credential request for "acme-abort"/,
    );
    const again = open("s-abort", "acme-abort");
    expect(reg.pendingCredentialRegistration("s-abort")?.request.id).toBe(
      request.id,
    );
    const meta = await reg.submitCredentialRegistration(
      "s-abort",
      request.id,
      "alex-gh",
      SECRET,
    );
    expect(await again).toEqual({ status: "registered", credential: meta });
    expect(kc.listCredentials().map((c) => c.service)).toContain("acme-abort");
    expectNoSecretLeaked(meta);
  });
});

describe("saving off the gateway thread", () => {
  test("a second answer during the save is refused, and expiry waits for it", async () => {
    let release!: () => void;
    writeGate = new Promise((resolve) => (release = resolve));
    const waiting = open("s-inflight", "acme-inflight", undefined, 5);
    const { request } = reg.pendingCredentialRegistration("s-inflight")!;
    const first = reg.submitCredentialRegistration(
      "s-inflight",
      request.id,
      "alex-gh",
      SECRET,
    );
    await expect(
      reg.submitCredentialRegistration(
        "s-inflight",
        request.id,
        "alex-gh",
        SECRET,
      ),
    ).rejects.toThrow(/no longer open/);
    // The TTL passes while the write is held.
    await Bun.sleep(30);
    expect(reg.pendingCredentialRegistration("s-inflight")).not.toBeNull();
    writeGate = null;
    release();
    const meta = await first;
    const result = await waiting;
    expect(result.status).toBe("registered");
    expect(kc.findCredential("acme-inflight")?.id).toBe(meta.id);
    expect(
      JSON.parse(readFileSync(STORE, "utf8")).credentials.map(
        (c: { service: string }) => c.service,
      ),
    ).toEqual(["acme-inflight"]);
    expectNoSecretLeaked(result);
  });

  test("cancelling the agent's call during a save keeps the save", async () => {
    let release!: () => void;
    writeGate = new Promise((resolve) => (release = resolve));
    const controller = new AbortController();
    const waiting = open("s-abort-save", "acme-abort-save", controller.signal);
    const { request } = reg.pendingCredentialRegistration("s-abort-save")!;
    const saving = reg.submitCredentialRegistration(
      "s-abort-save",
      request.id,
      "alex-gh",
      SECRET,
    );
    controller.abort();
    expect(await waiting).toEqual({ status: "pending", request });
    expect(reg.pendingCredentialRegistration("s-abort-save")).not.toBeNull();
    expect(broadcasts.some((m: any) => m.status === "declined")).toBe(false);
    writeGate = null;
    release();
    const meta = await saving;
    expect(kc.findCredential("acme-abort-save")?.id).toBe(meta.id);
    expect(
      broadcasts.filter(
        (m: any) => m.type === "credential_registration_resolved",
      ),
    ).toEqual([
      expect.objectContaining({ requestId: request.id, status: "registered" }),
    ]);
    expectNoSecretLeaked(meta);
  });

  test("async and sync writes interleaved end on the latest state", async () => {
    const pendingWrite = kc.addCredentialAsync({
      owner: "Alex",
      service: "acme-a",
      host: "api.example.test",
      secret: "a",
    });
    kc.addCredential({
      owner: "Alex",
      service: "acme-b",
      host: "api.example.test",
      secret: "b",
    });
    await pendingWrite;
    expect(
      JSON.parse(readFileSync(STORE, "utf8"))
        .credentials.map((c: { service: string }) => c.service)
        .sort(),
    ).toEqual(["acme-a", "acme-b"]);
    expect(statSync(STORE).mode & 0o777).toBe(0o600);
  });
});

describe("registration routes", () => {
  test("answering needs the driver's own verified sign-in", async () => {
    const waiting = open("s-route");
    const { request } = reg.pendingCredentialRegistration("s-route")!;
    const path = `/api/keychain/registrations/${request.id}`;
    const body = { sessionId: "s-route", secret: SECRET };

    for (const auth of [null, { ...alex, automation: true }]) {
      expect((await route(path, auth, body)).status).toBe(401);
    }
    expect((await route(path, blair, body)).status).toBe(403);
    // The gateway's cross-site guard covers this path; the route itself
    // must not compare Origin with its (internal) request URL.
    expect(
      crossSiteViolation(
        new Request(`https://os.example.test${path}`, {
          method: "POST",
          headers: {
            host: "os.example.test",
            origin: "https://evil.example.test",
          },
        }),
      ),
    ).not.toBeNull();
    expect(kc.listCredentials()).toEqual([]);

    const peek = `/api/keychain/registrations?sessionId=s-route`;
    expect((await (await route(peek, blair)).json()).canAnswer).toBe(false);
    const own = await (await route(peek, alex)).json();
    expect(own.canAnswer).toBe(true);
    expect(own.request.id).toBe(request.id);

    // A same-site browser answer behind the proxy: public Origin, internal
    // request URL.
    const res = await route(path, alex, body, {
      origin: "https://os.public.example.test",
      "sec-fetch-site": "same-origin",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text).credential.owner).toBe("Alex");
    expect((await waiting).status).toBe("registered");
    // Answered: a replay finds nothing open.
    expect((await route(path, alex, body)).status).toBe(409);
    expectNoSecretLeaked(text);
  });

  test("decline over HTTP", async () => {
    const waiting = open("s-decline");
    const { request } = reg.pendingCredentialRegistration("s-decline")!;
    const res = await route(
      `/api/keychain/registrations/${request.id}/decline`,
      alex,
      { sessionId: "s-decline" },
    );
    expect(res.status).toBe(200);
    expect(await waiting).toEqual({ status: "declined" });
  });
});

describe("register_credential tool", () => {
  type Call = (args: Record<string, unknown>) => Promise<string>;
  async function toolFor(
    user: string,
    session: { automation?: string; automationId?: string } = {},
  ): Promise<Call> {
    const server = createKeychainMcpServer({
      sessionId: `s-tool-${user}`,
      user,
      session: () => session,
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    return async (args) => {
      const result = await client.callTool(
        { name: "register_credential", arguments: args },
        undefined,
        { timeout: 5_000 },
      );
      return (result.content as { text?: string }[])
        .map((c) => c.text ?? "")
        .join("\n");
    };
  }
  const args = { service: "acme-prod", host: "api.example.test" };

  test("automation runs and unknown drivers get a clear refusal, and no card", async () => {
    const auto = await (await toolFor("alex", { automation: "nightly" }))(args);
    expect(auto).toMatch(/automation run/);
    const bot = await (await toolFor("Open Session"))(args);
    expect(bot).toMatch(/signed-in teammate/);
    expect(broadcasts).toEqual([]);
    expect(reg.pendingCredentialRegistration("s-tool-alex")).toBeNull();
  });

  test("returns metadata owned by the driver, never the secret", async () => {
    const call = (await toolFor("alex"))({ ...args, allowedMethods: ["GET"] });
    let open: ReturnType<typeof reg.pendingCredentialRegistration> = null;
    for (let i = 0; i < 100 && !open; i++) {
      await Bun.sleep(5);
      open = reg.pendingCredentialRegistration("s-tool-alex");
    }
    const { request } = open!;
    expect(request.allowedMethods).toEqual(["GET"]);
    await reg.submitCredentialRegistration(
      "s-tool-alex",
      request.id,
      "alex-gh",
      SECRET,
    );
    const out = await call;
    const parsed = JSON.parse(out);
    expect(parsed.registered).toMatchObject({
      service: "acme-prod",
      host: "api.example.test",
      owner: "Alex",
    });
    expectNoSecretLeaked(out);
  });

  test("a taken slug is reported without opening a card", async () => {
    kc.addCredential({
      owner: "Blair",
      service: "acme-prod",
      host: "api.example.test",
      secret: "other",
    });
    const out = await (await toolFor("alex"))(args);
    expect(out).toMatch(/already exists.*Nothing was registered/);
    expect(broadcasts).toEqual([]);
  });
});
