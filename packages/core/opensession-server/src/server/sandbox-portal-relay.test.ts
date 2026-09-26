import { expect, test } from "bun:test";
import {
  applyRelayResponseFrame,
  createRelayRequestLimiter,
  RELAY_LANES,
  relayLane,
  handleSandboxPortalRelayUpgrade,
  mintSandboxPortalGrant,
  PORTAL_RESPONSE_CHUNK_BYTES,
  relayFetch,
  revokeSandboxPortalGrants,
  revokeSandboxPortalRelay,
  sandboxPortalRelayClose,
  sandboxPortalRelayMessage,
  sandboxPortalRelayOpen,
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

test("static build output takes its own relay lanes", () => {
  expect(relayLane("/_next/static/chunks/app.js")).toBe("assets");
  expect(relayLane("/api/flags")).toBe("requests");
  expect(relayLane("/videos")).toBe("requests");
});

test("bounds relay concurrency to its lanes by default", async () => {
  const limit = createRelayRequestLimiter();
  const releases: Array<() => void> = [];
  const started: number[] = [];
  const ids = Array.from({ length: RELAY_LANES + 1 }, (_, i) => i + 1);
  const tasks = ids.map((id) =>
    limit(async () => {
      started.push(id);
      await new Promise<void>((resolve) => releases.push(resolve));
    }),
  );
  await Bun.sleep(0);
  expect(started).toEqual(ids.slice(0, RELAY_LANES));
  releases.shift()!();
  await Bun.sleep(0);
  expect(started).toEqual(ids);
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

test("a page opened while the app is not listening gets the waiting page", async () => {
  const target = { sessionId: "s-wait", sandboxId: "sb-wait", port: 4000 };
  const ws: any = {
    data: {
      kind: "sandbox-portal-relay",
      ...target,
      expiresAt: Date.now() + 60_000,
    },
    close() {},
    // The agent answers every request the way it does when the dev server
    // refuses the connection.
    send(raw: string) {
      const message = JSON.parse(raw);
      if (message.t === "http")
        queueMicrotask(() =>
          sandboxPortalRelayMessage(
            ws,
            JSON.stringify({
              t: "http_result_abort",
              id: message.id,
              status: 502,
            }),
          ),
        );
    },
  };
  sandboxPortalRelayOpen(ws);
  try {
    const page = await relayFetch(
      target,
      new Request("http://127.0.0.1/videos", {
        headers: { "sec-fetch-mode": "navigate" },
      }),
    );
    expect(page.status).toBe(503);
    expect(page.headers.get("retry-after")).toBe("3");
    expect(await page.text()).toContain("Starting the Portal");
    const asset = await relayFetch(
      target,
      new Request("http://127.0.0.1/_next/static/a.js", {
        headers: { "sec-fetch-mode": "no-cors" },
      }),
    );
    expect(asset.status).toBe(502);
  } finally {
    sandboxPortalRelayClose(ws);
  }
});
