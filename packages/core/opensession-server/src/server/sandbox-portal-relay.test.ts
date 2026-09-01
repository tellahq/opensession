import { expect, test } from "bun:test";
import {
  applyRelayResponseFrame,
  createRelayRequestLimiter,
  handleSandboxPortalRelayUpgrade,
  mintSandboxPortalGrant,
  PORTAL_RESPONSE_CHUNK_BYTES,
  revokeSandboxPortalGrants,
  revokeSandboxPortalRelay,
  verifySandboxPortalGrant,
  type RelayResponseAssembly,
} from "./sandbox-portal-relay";

test("Sandbox Portal grants bind one session, Sandbox, and port", () => {
  const grant = mintSandboxPortalGrant({
    sessionId: "bks-test",
    sandboxId: "sandbox-test",
    port: 4300,
  });
  expect(
    verifySandboxPortalGrant(grant.token, {
      sessionId: "bks-test",
      sandboxId: "sandbox-test",
      port: 4300,
    }),
  ).toBe(true);
  expect(
    verifySandboxPortalGrant(grant.token, {
      sessionId: "bks-other",
      sandboxId: "sandbox-test",
      port: 4300,
    }),
  ).toBe(false);
  expect(
    verifySandboxPortalGrant(grant.token, {
      sessionId: "bks-test",
      sandboxId: "sandbox-test",
      port: 4301,
    }),
  ).toBe(false);
  revokeSandboxPortalGrants("sandbox-test");
  expect(
    verifySandboxPortalGrant(grant.token, {
      sessionId: "bks-test",
      sandboxId: "sandbox-test",
      port: 4300,
    }),
  ).toBe(false);
});

test("stopping one Portal revokes only its bound credential", () => {
  const api = mintSandboxPortalGrant({
    sessionId: "bks-stop",
    sandboxId: "sandbox-stop",
    port: 4500,
  });
  const web = mintSandboxPortalGrant({
    sessionId: "bks-stop",
    sandboxId: "sandbox-stop",
    port: 4501,
  });
  revokeSandboxPortalRelay("sandbox-stop", 4500);
  expect(
    verifySandboxPortalGrant(api.token, {
      sessionId: "bks-stop",
      sandboxId: "sandbox-stop",
      port: 4500,
    }),
  ).toBe(false);
  expect(
    verifySandboxPortalGrant(web.token, {
      sessionId: "bks-stop",
      sandboxId: "sandbox-stop",
      port: 4501,
    }),
  ).toBe(true);
});

test("uses two relay lanes by default", async () => {
  const limit = createRelayRequestLimiter();
  const releases: Array<() => void> = [];
  const started: number[] = [];
  const tasks = [1, 2, 3].map((id) =>
    limit(async () => {
      started.push(id);
      await new Promise<void>((resolve) => releases.push(resolve));
    }),
  );
  await Bun.sleep(0);
  expect(started).toEqual([1, 2]);
  releases.shift()!();
  await Bun.sleep(0);
  expect(started).toEqual([1, 2, 3]);
  for (const release of releases) release();
  await Promise.all(tasks);
});

test("bounds explicit relay concurrency without dropping queued work", async () => {
  const limit = createRelayRequestLimiter(2);
  const releases: Array<() => void> = [];
  const started: number[] = [];
  const tasks = [1, 2, 3, 4].map((id) =>
    limit(async () => {
      started.push(id);
      await new Promise<void>((resolve) => releases.push(resolve));
      return id;
    }),
  );

  await Bun.sleep(0);
  expect(started).toEqual([1, 2]);
  releases.shift()!();
  await Bun.sleep(0);
  expect(started).toEqual([1, 2, 3]);
  releases.shift()!();
  releases.shift()!();
  await Bun.sleep(0);
  expect(started).toEqual([1, 2, 3, 4]);
  releases.shift()!();
  expect(await Promise.all(tasks)).toEqual([1, 2, 3, 4]);
});

test("rejects invalid relay concurrency", () => {
  expect(() => createRelayRequestLimiter(0)).toThrow(
    "Portal relay concurrency must be positive",
  );
});

test("relay upgrade rejects an unbound credential before WebSocket upgrade", () => {
  const grant = mintSandboxPortalGrant({
    sessionId: "bks-relay",
    sandboxId: "sandbox-relay",
    port: 4400,
  });
  let upgraded: unknown;
  const server = {
    upgrade(_req: Request, options?: { data?: unknown }) {
      upgraded = options?.data;
      return true;
    },
  };
  const accepted = handleSandboxPortalRelayUpgrade(
    new Request(
      "https://sessions.test/sandbox-portal-ws?session=bks-relay&sandbox=sandbox-relay&port=4400",
      { headers: { authorization: `Bearer ${grant.token}` } },
    ),
    server,
    "/sandbox-portal-ws",
  );
  expect(accepted).toBeUndefined();
  expect(upgraded).toMatchObject({
    kind: "sandbox-portal-relay",
    sessionId: "bks-relay",
    sandboxId: "sandbox-relay",
    port: 4400,
  });
  const denied = handleSandboxPortalRelayUpgrade(
    new Request(
      "https://sessions.test/sandbox-portal-ws?session=bks-relay&sandbox=sandbox-relay&port=4401",
      { headers: { authorization: `Bearer ${grant.token}` } },
    ),
    server,
    "/sandbox-portal-ws",
  );
  expect(denied?.status).toBe(403);
});

test("reassembles bounded Portal response frames", () => {
  const assembly: RelayResponseAssembly = {
    headers: {},
    chunks: [],
    byteLength: 0,
  };
  expect(
    applyRelayResponseFrame(assembly, {
      t: "http_result_start",
      status: 200,
      headers: { "content-type": "text/javascript", connection: "close" },
    }),
  ).toBeUndefined();
  expect(
    applyRelayResponseFrame(assembly, {
      t: "http_result_chunk",
      body: Buffer.from("large ").toString("base64"),
    }),
  ).toBeUndefined();
  expect(
    applyRelayResponseFrame(assembly, {
      t: "http_result_chunk",
      body: Buffer.from("chunk").toString("base64"),
    }),
  ).toBeUndefined();
  const result = applyRelayResponseFrame(assembly, { t: "http_result_end" });
  expect(result?.status).toBe(200);
  expect(result?.headers).toEqual({ "content-type": "text/javascript" });
  expect(result?.body?.toString()).toBe("large chunk");
});

test("rejects oversized individual Portal response frames", () => {
  const assembly: RelayResponseAssembly = {
    status: 200,
    headers: {},
    chunks: [],
    byteLength: 0,
  };
  const result = applyRelayResponseFrame(assembly, {
    t: "http_result_chunk",
    body: Buffer.alloc(PORTAL_RESPONSE_CHUNK_BYTES + 1).toString("base64"),
  });
  expect(result).toEqual({ status: 502, headers: {} });
  expect(assembly.byteLength).toBe(0);
});
