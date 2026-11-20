import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { statePath } from "./paths";
import { toolCallIdsIn } from "./mcp-runtime";
import {
  loadMcpOauthStore,
  mcpFreshGrantHeader,
  mcpGrantExists,
  mcpRelayGrant,
  mcpSharedGrantHeader,
  refreshExpiringMcpGrants,
} from "./mcp-oauth";

/**
 * A token endpoint that behaves like AuthKit: every refresh rotates the
 * refresh token, and presenting one that was already used revokes the grant.
 */
function rotatingTokenEndpoint() {
  const state = { current: "rt-0", seq: 0, posts: 0, revoked: false };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = new URLSearchParams(await req.text());
      state.posts++;
      // Long enough for concurrent callers to overlap.
      await Bun.sleep(100);
      if (state.revoked || body.get("refresh_token") !== state.current) {
        state.revoked = true;
        return Response.json(
          { error: "invalid_grant", error_description: "reused" },
          { status: 400 },
        );
      }
      state.current = `rt-${++state.seq}`;
      return Response.json({
        access_token: `at-${state.seq}`,
        refresh_token: state.current,
        expires_in: 300,
      });
    },
  });
  return { state, server, url: `http://127.0.0.1:${server.port}/token` };
}

/** A five-minute grant issued `ageMs` ago. */
function storeWith(tokenUrl: string, ageMs: number) {
  const issued = Date.now() - ageMs;
  return {
    Acme: {
      serverUrl: "https://mcp.example.test/mcp",
      endpoints: { authorize: "https://auth.example.test/a", token: tokenUrl },
      clientInfo: { clientId: "client" },
      shared: {
        tokens: {
          accessToken: "at-0",
          refreshToken: "rt-0",
          expiresAt: issued + 300_000,
        },
        updatedAt: new Date(issued).toISOString(),
      },
    },
  };
}

const storePath = statePath(".opensession-mcp-oauth.json");
let endpoint: ReturnType<typeof rotatingTokenEndpoint>;

beforeAll(() => mkdirSync(dirname(storePath), { recursive: true }));
afterEach(() => endpoint?.server.stop(true));
afterAll(() => rmSync(storePath, { force: true }));

/** Drop per-grant lock files, which also carry the refresh backoff. */
function clearLocks() {
  const dir = dirname(storePath);
  for (const f of readdirSync(dir))
    if (f.startsWith(`${basename(storePath)}.`) && f.endsWith(".lock"))
      rmSync(join(dir, f), { force: true });
}

async function seed(ageMs: number) {
  clearLocks();
  endpoint = rotatingTokenEndpoint();
  writeFileSync(storePath, JSON.stringify(storeWith(endpoint.url, ageMs)));
  await loadMcpOauthStore();
}

function storedTokens() {
  return JSON.parse(readFileSync(storePath, "utf8")).Acme.shared.tokens;
}

test("processes sharing the store refresh a rotating grant once", async () => {
  endpoint = rotatingTokenEndpoint();
  const dir = mkdtempSync(join(tmpdir(), "mcp-oauth-refresh-"));
  try {
    const path = join(dir, ".opensession-mcp-oauth.json");
    writeFileSync(path, JSON.stringify(storeWith(endpoint.url, 270_000)));
    // Each child is a run host: it reads a header and runs the refresh tick.
    const code = `const m = await import(${JSON.stringify(
      join(import.meta.dir, "mcp-oauth.ts"),
    )}); m.mcpSharedGrantHeader("Acme"); await m.refreshExpiringMcpGrants(); process.exit(0);`;
    const children = Array.from({ length: 6 }, () =>
      Bun.spawn([process.execPath, "-e", code], {
        env: { ...process.env, OPENSESSION_STATE_DIR: dir },
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    expect(await Promise.all(children.map((c) => c.exited))).toEqual(
      children.map(() => 0),
    );
    expect(endpoint.state).toMatchObject({ posts: 1, revoked: false });
    const stored = JSON.parse(readFileSync(path, "utf8")).Acme.shared.tokens;
    expect(stored.refreshToken).toBe(endpoint.state.current);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("a freshly issued five-minute token is not refreshed", async () => {
  await seed(10_000);
  expect(mcpSharedGrantHeader("Acme")).toBe("Bearer at-0");
  await refreshExpiringMcpGrants();
  expect(endpoint.state.posts).toBe(0);
});

test("one process refreshes an expiring grant once however often it is read", async () => {
  await seed(200_000);
  for (let i = 0; i < 5; i++) mcpSharedGrantHeader("Acme");
  await Promise.all([
    refreshExpiringMcpGrants(),
    mcpFreshGrantHeader("Acme"),
    refreshExpiringMcpGrants(),
  ]);
  expect(endpoint.state).toMatchObject({ posts: 1, revoked: false });
  expect(storedTokens().refreshToken).toBe("rt-1");
});

test("an expired grant still exists, and the relay waits for its refresh", async () => {
  await seed(310_000);
  expect(mcpSharedGrantHeader("Acme")).toBeUndefined();
  expect(mcpGrantExists("Acme")).toBe(true);
  expect(await mcpFreshGrantHeader("Acme")).toBe("Bearer at-1");
  expect(endpoint.state.posts).toBe(1);
});

test("a rejected refresh is logged without tokens and keeps the grant", async () => {
  await seed(310_000);
  endpoint.state.current = "rt-other";
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await mcpFreshGrantHeader("Acme")).toBeUndefined();
    const logged = error.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("HTTP 400 invalid_grant");
    // The provider's description is not logged: it could echo the token.
    expect(logged).not.toContain("reused");
    expect(logged).not.toContain("rt-0");
    expect(storedTokens().refreshToken).toBe("rt-0");
  } finally {
    error.mockRestore();
  }
});

test("a lock held by a process that died does not block the next change", async () => {
  await seed(310_000);
  const code = `const { dlopen, FFIType } = await import("bun:ffi");
const lib = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
const h = await (await import("fs/promises")).open(${JSON.stringify(`${storePath}.lock`)}, "a");
if (lib.symbols.flock(h.fd, 2) !== 0) process.exit(2);
process.kill(process.pid, "SIGKILL");`;
  const holder = Bun.spawn([process.execPath, "-e", code]);
  await holder.exited;
  expect(holder.signalCode).toBe("SIGKILL");
  expect(await mcpFreshGrantHeader("Acme")).toBe("Bearer at-1");
});

test("a grant another process refreshed is read back after a no-op refresh", async () => {
  await seed(310_000);
  expect(mcpSharedGrantHeader("Acme")).toBeUndefined();
  // Another process refreshes and writes the store; this one's cache is stale.
  const store = JSON.parse(readFileSync(storePath, "utf8"));
  store.Acme.shared = {
    tokens: {
      accessToken: "at-9",
      refreshToken: "rt-9",
      expiresAt: Date.now() + 300_000,
    },
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(storePath, JSON.stringify(store));
  expect(await mcpFreshGrantHeader("Acme")).toBe("Bearer at-9");
  expect(endpoint.state.posts).toBe(0);
});

test("a failed refresh is not retried at once", async () => {
  await seed(310_000);
  endpoint.state.current = "rt-other";
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await mcpFreshGrantHeader("Acme")).toBeUndefined();
    expect(await mcpFreshGrantHeader("Acme")).toBeUndefined();
    await refreshExpiringMcpGrants();
    expect(endpoint.state.posts).toBe(1);
  } finally {
    error.mockRestore();
  }
});

test("a slow token endpoint does not hold up another grant's refresh", async () => {
  clearLocks();
  endpoint = rotatingTokenEndpoint();
  const slow = Bun.serve({
    port: 0,
    async fetch() {
      await Bun.sleep(3_000);
      return Response.json(
        { error: "temporarily_unavailable" },
        { status: 503 },
      );
    },
  });
  try {
    const store = {
      ...storeWith(endpoint.url, 310_000),
      Slow: storeWith(`http://127.0.0.1:${slow.port}/token`, 310_000).Acme,
    };
    writeFileSync(storePath, JSON.stringify(store));
    await loadMcpOauthStore();
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const slowRefresh = mcpFreshGrantHeader("Slow");
      await Bun.sleep(50);
      const started = Date.now();
      expect(await mcpFreshGrantHeader("Acme")).toBe("Bearer at-1");
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(await slowRefresh).toBeUndefined();
    } finally {
      error.mockRestore();
    }
  } finally {
    slow.stop(true);
  }
}, 15_000);

test("the relay grant names no person when it falls back to the shared grant", async () => {
  await seed(10_000);
  expect(await mcpRelayGrant("Acme", ["nobody@example.test"])).toEqual({
    header: "Bearer at-0",
  });
});

test("a refresh with no definite answer is never replayed with the same token", async () => {
  await seed(310_000);
  // A success status with an unreadable body: the provider may have rotated.
  endpoint.server.reload({
    async fetch() {
      endpoint.state.posts++;
      return new Response("<html>", { status: 200 });
    },
  });
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await mcpFreshGrantHeader("Acme")).toBeUndefined();
    await refreshExpiringMcpGrants();
    expect(await mcpFreshGrantHeader("Acme")).toBeUndefined();
    expect(endpoint.state.posts).toBe(1);
    expect(error.mock.calls.map((c) => c.join(" ")).join("\n")).toContain(
      "reconnect to restore it",
    );
  } finally {
    error.mockRestore();
  }
  // Reconnecting stores a new refresh token, which refreshes normally.
  endpoint.server.stop(true);
  endpoint = rotatingTokenEndpoint();
  const store = storeWith(endpoint.url, 310_000);
  store.Acme.shared.tokens.refreshToken = "rt-0";
  writeFileSync(storePath, JSON.stringify(store));
  await loadMcpOauthStore();
  // Same refresh token as the doubtful attempt: still held back.
  expect(await mcpFreshGrantHeader("Acme")).toBeUndefined();
  expect(endpoint.state.posts).toBe(0);
  endpoint.state.current = "rt-new";
  store.Acme.shared.tokens.refreshToken = "rt-new";
  writeFileSync(storePath, JSON.stringify(store));
  await loadMcpOauthStore();
  expect(await mcpFreshGrantHeader("Acme")).toBe("Bearer at-1");
});

test("tool call ids are read from single and batched JSON-RPC bodies", () => {
  const call = (id: string) => ({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "x", _meta: { opensessionToolCallId: id } },
  });
  expect(toolCallIdsIn(JSON.stringify(call("a")))).toEqual(["a"]);
  expect(
    toolCallIdsIn(
      JSON.stringify([call("b"), { jsonrpc: "2.0", method: "ping" }]),
    ),
  ).toEqual(["b"]);
  expect(toolCallIdsIn("not json")).toEqual([]);
});
