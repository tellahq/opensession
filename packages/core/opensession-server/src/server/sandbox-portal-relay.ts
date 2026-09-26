/**
 * Session-scoped credentials for the outbound Sandbox Portal relay.
 *
 * This deliberately records no provider URL. A Sandbox agent may authenticate
 * only with the token minted for its exact {session, sandbox, port} tuple.
 */
import { randomBytes, timingSafeEqual } from "crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { portalNavigationRequest } from "./portal-sign-in";
import { portalWaitingResponse } from "./portal-waiting-page";
import { sandboxHttpsPortFor } from "./sandbox/preview-ports";
import { hostSessionScratchDir } from "./session-scratch";

export type SandboxPortalGrant = {
  sessionId: string;
  sandboxId: string;
  port: number;
  token: string;
  expiresAt: number;
};
type StoredGrant = Omit<SandboxPortalGrant, "token">;
const g = globalThis as Record<string, unknown>;
const grants: Map<string, StoredGrant> = (g.__opensessionSandboxPortalGrants ??=
  new Map()) as Map<string, StoredGrant>;
type RelayRequestLimiter = <T>(task: () => Promise<T>) => Promise<T>;
export type RelayResponse = {
  status: number;
  headers: Record<string, string>;
  body?: Buffer;
};
export type RelayResponseAssembly = {
  status?: number;
  headers: Record<string, string>;
  chunks: Buffer[];
  byteLength: number;
};
type PendingRelayResponse = RelayResponseAssembly & {
  resolve: (value: RelayResponse) => void;
  timer: ReturnType<typeof setTimeout>;
};
type Connection = {
  ws: any;
  sessionId: string;
  sandboxId: string;
  port: number;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout>;
  pending: Map<string, PendingRelayResponse>;
  limitRequests: RelayRequestLimiter;
  limitAssets: RelayRequestLimiter;
};

/** Which lanes a request takes: built static files (`/_next/static/`, which
 *  a dev server answers from memory) never wait behind a page or API route
 *  that is still compiling. */
export function relayLane(path: string): "assets" | "requests" {
  return path.startsWith("/_next/static/") ? "assets" : "requests";
}

/** A browser can ask Turbopack for dozens of multi-megabyte chunks at once.
 * The outbound Portal rides one WebSocket. Before the sidecar sent responses
 * in bounded frames behind its actual send buffer, responses finishing
 * together overflowed it, so relayed requests were held to two at a time.
 * That limit then made the Portal slow instead: a page's first API calls each
 * compile for seconds on a fresh dev server, and its 90 script chunks queued
 * behind them, so a warmed page took half a minute to render. The gate stays
 * bounded, per Portal connection so sibling services never block each other,
 * and static build output has lanes of its own (relayLane). */
export const RELAY_LANES = 6;

export function createRelayRequestLimiter(
  maxConcurrent = RELAY_LANES,
): RelayRequestLimiter {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)
    throw new Error("Portal relay concurrency must be positive");
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) =>
      waiters.push(() => {
        active += 1;
        resolve();
      }),
    );
  };
  const release = () => {
    active -= 1;
    waiters.shift()?.();
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}
const connections: Map<string, Connection> =
  (g.__opensessionSandboxPortalConnections ??= new Map()) as Map<
    string,
    Connection
  >;
type Relay = {
  server: ReturnType<typeof Bun.serve>;
  sessionId: string;
  sandboxId: string;
  port: number;
  /** The Portal name last written to its local address record. */
  recordedName?: string | null;
};
const relays: Map<string, Relay> = (g.__opensessionSandboxPortalRelays ??=
  new Map()) as Map<string, Relay>;
const routeOps: Map<
  string,
  Promise<void>
> = (g.__opensessionSandboxPortalRouteOps ??= new Map()) as Map<
  string,
  Promise<void>
>;
type BrowserSocket = { ws: any; connection: Connection };
const browserSockets: Map<string, BrowserSocket> =
  (g.__opensessionSandboxPortalBrowserSockets ??= new Map()) as Map<
    string,
    BrowserSocket
  >;
const HOP_HEADERS = new Set([
  "connection",
  "host",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
]);
// The sidecar aborts its loopback fetch at 240s. Give its final error frame ten
// seconds to cross the WebSocket before the coordinator declares the request lost.
const RELAY_REQUEST_TIMEOUT_MS = 250_000;
export const PORTAL_RESPONSE_CHUNK_BYTES = 256 * 1024;
export const PORTAL_RESPONSE_MAX_BYTES = 128 * 1024 * 1024;

function key(sessionId: string, sandboxId: string, port: number): string {
  return `${sessionId}:${sandboxId}:${port}`;
}

/** Caddy route removal and replacement are asynchronous. Serialize them per
 * Portal so a delayed stop cannot delete the route installed by an immediate
 * restart. */
function queueRouteOperation<T>(
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  const run = (routeOps.get(id) ?? Promise.resolve()).then(
    operation,
    operation,
  );
  const barrier = run.then(
    () => {},
    () => {},
  );
  routeOps.set(id, barrier);
  void barrier.then(() => {
    if (routeOps.get(id) === barrier) routeOps.delete(id);
  });
  return run;
}

/**
 * Where an agent shell on this machine finds a Sandbox Portal: the relay's
 * loopback server, which answers without sign-in exactly like a Portal
 * running on this machine answers on its own port. One JSON record per
 * Sandbox app port, `{ name, port, url }`, in the session's scratch dir
 * (`$OPENSESSION_SCRATCH/sandbox-portals/`), so repo scripts that drive the
 * app locally (screenshots, CDP) can find it. The relay's port changes when
 * this process restarts; the record is rewritten when the relay is rebuilt.
 */
export function sandboxPortalLocalDir(sessionId: string): string {
  return join(hostSessionScratchDir(sessionId), "sandbox-portals");
}

const localRecordOps: Map<
  string,
  Promise<void>
> = (g.__opensessionSandboxPortalLocalRecordOps ??= new Map()) as Map<
  string,
  Promise<void>
>;

function queueLocalRecord(path: string, task: () => Promise<void>): void {
  const next = (localRecordOps.get(path) ?? Promise.resolve())
    .then(task)
    .catch((error) =>
      console.warn(
        `[sandbox-portal] could not update ${path}:`,
        error instanceof Error ? error.message : String(error),
      ),
    );
  localRecordOps.set(path, next);
  void next.finally(() => {
    if (localRecordOps.get(path) === next) localRecordOps.delete(path);
  });
}

function recordLocalAddress(relay: Relay, name: string | undefined): void {
  if (
    relay.recordedName !== undefined &&
    (!name || name === relay.recordedName)
  )
    return;
  const dir = sandboxPortalLocalDir(relay.sessionId);
  const path = join(dir, `${relay.port}.json`);
  const url = `http://127.0.0.1:${relay.server.port}`;
  relay.recordedName = name ?? null;
  queueLocalRecord(path, async () => {
    // A relay rebuilt after a restart does not know its Portal's name; the
    // record it replaces does.
    let known = name;
    if (!known)
      try {
        const previous = JSON.parse(await readFile(path, "utf8"));
        if (previous?.port === relay.port && typeof previous.name === "string")
          known = previous.name;
      } catch {}
    if (known) relay.recordedName = known;
    await mkdir(dir, { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({ name: known ?? null, port: relay.port, url })}\n`,
    );
  });
}

function forgetLocalAddress(relay: Relay): void {
  const path = join(
    sandboxPortalLocalDir(relay.sessionId),
    `${relay.port}.json`,
  );
  queueLocalRecord(path, () => rm(path, { force: true }));
}

/** The loopback URLs of this session's relayed Sandbox Portals, by Portal
 *  name, as recorded for agent shells on this machine. Never throws. */
export async function sandboxPortalLocalUrls(
  sessionId: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const dir = sandboxPortalLocalDir(sessionId);
  try {
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const record = JSON.parse(await readFile(join(dir, file), "utf8"));
        if (typeof record?.name === "string" && typeof record.url === "string")
          out.set(record.name, record.url);
      } catch {}
    }
  } catch {}
  return out;
}

function dropPortalRoute(id: string, sandboxId: string, port: number): void {
  void queueRouteOperation(id, async () => {
    const { dropAuthenticatedPortalRoute } = await import("./preview");
    await dropAuthenticatedPortalRoute(sandboxHttpsPortFor(sandboxId, port));
  }).catch((error) =>
    console.warn(
      `[sandbox-portal] could not drop route for ${sandboxId}:${port}:`,
      error,
    ),
  );
}

function safeHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers)
    if (!HOP_HEADERS.has(name.toLowerCase()) && value.length <= 8192)
      result[name] = value;
  return result;
}

function relayResponseHeaders(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    return headers;
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      !HOP_HEADERS.has(name.toLowerCase()) &&
      typeof item === "string" &&
      item.length <= 8192
    )
      headers[name] = item;
  }
  return headers;
}

/** Assemble bounded frames from a sandbox response. Individual WebSocket
 * messages stay small enough for provider relays while Turbopack may emit
 * development chunks much larger than the old 10 MB whole-response ceiling. */
export function applyRelayResponseFrame(
  assembly: RelayResponseAssembly,
  message: any,
): RelayResponse | undefined {
  if (message.t === "http_result_start") {
    if (assembly.status !== undefined) return { status: 502, headers: {} };
    assembly.status =
      Number.isInteger(message.status) &&
      message.status >= 100 &&
      message.status <= 599
        ? message.status
        : 502;
    assembly.headers = relayResponseHeaders(message.headers);
    return;
  }
  if (message.t === "http_result_abort") {
    return {
      status:
        Number.isInteger(message.status) &&
        message.status >= 400 &&
        message.status <= 599
          ? message.status
          : 502,
      headers: {},
    };
  }
  if (assembly.status === undefined) return { status: 502, headers: {} };
  if (message.t === "http_result_chunk") {
    if (
      typeof message.body !== "string" ||
      message.body.length > Math.ceil(PORTAL_RESPONSE_CHUNK_BYTES / 3) * 4 + 4
    )
      return { status: 502, headers: {} };
    const chunk = Buffer.from(message.body, "base64");
    if (
      chunk.byteLength > PORTAL_RESPONSE_CHUNK_BYTES ||
      assembly.byteLength + chunk.byteLength > PORTAL_RESPONSE_MAX_BYTES
    )
      return { status: 502, headers: {} };
    assembly.chunks.push(chunk);
    assembly.byteLength += chunk.byteLength;
    return;
  }
  if (message.t === "http_result_end") {
    return {
      status: assembly.status,
      headers: assembly.headers,
      ...(assembly.byteLength > 0
        ? { body: Buffer.concat(assembly.chunks, assembly.byteLength) }
        : {}),
    };
  }
  return { status: 502, headers: {} };
}

export function mintSandboxPortalGrant(input: {
  sessionId: string;
  sandboxId: string;
  port: number;
  ttlMs?: number;
}): SandboxPortalGrant {
  if (
    !/^[A-Za-z0-9_.-]{3,160}$/.test(input.sessionId) ||
    !/^[A-Za-z0-9_.-]{3,240}$/.test(input.sandboxId) ||
    !Number.isInteger(input.port) ||
    input.port < 1024 ||
    input.port > 19000
  )
    throw new Error("Invalid Sandbox Portal registration");
  const now = Date.now();
  for (const [token, grant] of grants)
    if (grant.expiresAt <= now) grants.delete(token);
  const token = randomBytes(24).toString("base64url");
  const expiresAt =
    Date.now() +
    Math.min(Math.max(input.ttlMs ?? 10 * 60_000, 10_000), 60 * 60_000);
  grants.set(token, {
    sessionId: input.sessionId,
    sandboxId: input.sandboxId,
    port: input.port,
    expiresAt,
  });
  return { ...grants.get(token)!, token };
}

export function verifySandboxPortalGrant(
  token: string,
  expected: Omit<StoredGrant, "expiresAt">,
): boolean {
  return grantForSandboxPortal(token, expected) !== undefined;
}

function grantForSandboxPortal(
  token: string,
  expected: Omit<StoredGrant, "expiresAt">,
): StoredGrant | undefined {
  const grant = grants.get(token);
  if (!grant || grant.expiresAt <= Date.now()) {
    grants.delete(token);
    return undefined;
  }
  const a = Buffer.from(
    `${grant.sessionId}\0${grant.sandboxId}\0${grant.port}`,
  );
  const b = Buffer.from(
    `${expected.sessionId}\0${expected.sandboxId}\0${expected.port}`,
  );
  return a.length === b.length && timingSafeEqual(a, b) ? grant : undefined;
}

function teardownConnection(
  connection: Connection,
  code: number,
  reason: string,
): void {
  clearTimeout(connection.expiryTimer);
  for (const pending of connection.pending.values()) {
    clearTimeout(pending.timer);
    pending.resolve({ status: 502, headers: {} });
  }
  connection.pending.clear();
  for (const [id, browser] of browserSockets) {
    if (browser.connection !== connection) continue;
    browserSockets.delete(id);
    try {
      browser.ws.close();
    } catch {}
  }
  try {
    connection.ws.close(code, reason);
  } catch {}
}

export function revokeSandboxPortalGrants(sandboxId: string): void {
  for (const [token, grant] of grants)
    if (grant.sandboxId === sandboxId) grants.delete(token);
  for (const [id, connection] of connections)
    if (connection.sandboxId === sandboxId) {
      teardownConnection(connection, 1008, "portal revoked");
      connections.delete(id);
    }
  for (const [id, relay] of relays)
    if (relay.sandboxId === sandboxId) {
      try {
        relay.server.stop(true);
      } catch {}
      dropPortalRoute(id, sandboxId, relay.port);
      forgetLocalAddress(relay);
      relays.delete(id);
    }
}

/** Stop one service's public surface without affecting sibling Portals in the
 * same Sandbox. Used for explicit stop and failed restarts. */
export function revokeSandboxPortalRelay(
  sandboxId: string,
  port: number,
): void {
  for (const [token, grant] of grants)
    if (grant.sandboxId === sandboxId && grant.port === port)
      grants.delete(token);
  for (const [id, connection] of connections)
    if (connection.sandboxId === sandboxId && connection.port === port) {
      teardownConnection(connection, 1008, "portal stopped");
      connections.delete(id);
    }
  for (const [id, relay] of relays)
    if (relay.sandboxId === sandboxId && relay.port === port) {
      try {
        relay.server.stop(true);
      } catch {}
      dropPortalRoute(id, sandboxId, port);
      forgetLocalAddress(relay);
      relays.delete(id);
    }
}

/** Upgrade only an outbound Sandbox relay whose expiring grant exactly matches
 * the declared session, sandbox, and loopback service port. */
export function handleSandboxPortalRelayUpgrade(
  req: Request,
  server: { upgrade(req: Request, opts?: { data?: unknown }): boolean },
  path: string,
): Response | undefined {
  if (path !== "/sandbox-portal-ws") return undefined;
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session") || "";
  const sandboxId = url.searchParams.get("sandbox") || "";
  const port = Number(url.searchParams.get("port"));
  const auth = req.headers.get("authorization") || "";
  const token =
    auth.match(/^Bearer\s+(.+)$/i)?.[1] || url.searchParams.get("token") || "";
  const grant = grantForSandboxPortal(token, { sessionId, sandboxId, port });
  if (!grant) return new Response("unauthorized", { status: 403 });
  return server.upgrade(req, {
    data: {
      kind: "sandbox-portal-relay",
      sessionId,
      sandboxId,
      port,
      expiresAt: grant.expiresAt,
    },
  })
    ? undefined
    : new Response("WebSocket upgrade failed", { status: 400 });
}

export function sandboxPortalRelayOpen(ws: any): boolean {
  if (ws.data?.kind !== "sandbox-portal-relay") return false;
  const { sessionId, sandboxId, port } = ws.data;
  const id = key(sessionId, sandboxId, port);
  const previous = connections.get(id);
  if (previous) teardownConnection(previous, 1000, "replaced");
  const expiresAt = Number(ws.data.expiresAt);
  const closeAtExpiry = setTimeout(
    () => {
      try {
        ws.close(1008, "portal credential expired");
      } catch {}
    },
    Math.max(0, expiresAt - Date.now()),
  );
  closeAtExpiry.unref?.();
  connections.set(id, {
    ws,
    sessionId,
    sandboxId,
    port,
    expiresAt,
    expiryTimer: closeAtExpiry,
    pending: new Map(),
    limitRequests: createRelayRequestLimiter(),
    limitAssets: createRelayRequestLimiter(),
  });
  return true;
}
export function sandboxPortalRelayMessage(
  ws: any,
  raw: string | Buffer,
): boolean {
  if (ws.data?.kind !== "sandbox-portal-relay") return false;
  let message: any;
  try {
    message = JSON.parse(typeof raw === "string" ? raw : raw.toString());
  } catch {
    return true;
  }
  const connection = connections.get(
    key(ws.data.sessionId, ws.data.sandboxId, ws.data.port),
  );
  if (connection && connection.expiresAt <= Date.now()) {
    try {
      connection.ws.close(1008, "portal credential expired");
    } catch {}
    return true;
  }
  if (message.t === "ws_event" || message.t === "ws_closed") {
    const id = typeof message.id === "string" ? message.id : "";
    const browser = browserSockets.get(id);
    if (!browser || browser.connection !== connection) return true;
    if (message.t === "ws_event") {
      try {
        message.binary === true && typeof message.data === "string"
          ? browser.ws.send(Buffer.from(message.data, "base64"))
          : typeof message.data === "string" && browser.ws.send(message.data);
      } catch {}
    } else {
      browserSockets.delete(id);
      try {
        browser.ws.close();
      } catch {}
    }
    return true;
  }
  if (
    typeof message.id !== "string" ||
    ![
      "http_result",
      "http_result_start",
      "http_result_chunk",
      "http_result_end",
      "http_result_abort",
    ].includes(message.t)
  )
    return true;
  if (!connection) return true;
  const pending = connection.pending.get(message.id);
  if (!pending) return true;
  if (message.t === "http_result") {
    const encoded = typeof message.body === "string" ? message.body : "";
    const encodedTooLarge =
      encoded.length > Math.ceil(PORTAL_RESPONSE_MAX_BYTES / 3) * 4 + 4;
    const body =
      encoded && !encodedTooLarge ? Buffer.from(encoded, "base64") : undefined;
    pending.resolve(
      encodedTooLarge || (body && body.byteLength > PORTAL_RESPONSE_MAX_BYTES)
        ? { status: 502, headers: {} }
        : {
            status: Number.isInteger(message.status) ? message.status : 502,
            headers: relayResponseHeaders(message.headers),
            ...(body ? { body } : {}),
          },
    );
    return true;
  }
  const result = applyRelayResponseFrame(pending, message);
  if (result) pending.resolve(result);
  return true;
}
/** Wait for a newly launched outbound sidecar before redirecting the browser
 * back through Caddy. Without this, recovery replaces the stale route but the
 * immediate retry races the WebSocket dial and surfaces a transient 503. */
export async function waitForSandboxPortalRelay(
  input: { sessionId: string; sandboxId: string; port: number },
  timeoutMs = 60_000,
): Promise<boolean> {
  const id = key(input.sessionId, input.sandboxId, input.port);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connection = connections.get(id);
    if (connection && connection.expiresAt > Date.now()) return true;
    await Bun.sleep(100);
  }
  return false;
}

export function sandboxPortalRelayConnected(input: {
  sessionId: string;
  sandboxId: string;
  port: number;
}): boolean {
  const connection = connections.get(
    key(input.sessionId, input.sandboxId, input.port),
  );
  return Boolean(connection && connection.expiresAt > Date.now());
}

export function sandboxPortalRelayClose(ws: any): boolean {
  if (ws.data?.kind !== "sandbox-portal-relay") return false;
  const connection = connections.get(
    key(ws.data.sessionId, ws.data.sandboxId, ws.data.port),
  );
  if (connection && connection.ws === ws) {
    teardownConnection(connection, 1000, "closed");
    connections.delete(key(ws.data.sessionId, ws.data.sandboxId, ws.data.port));
  }
  return true;
}

/** Exported for tests; the relay server calls it for each HTTP request. */
export async function relayFetch(
  input: { sessionId: string; sandboxId: string; port: number },
  request: Request,
): Promise<Response> {
  const connection = connections.get(
    key(input.sessionId, input.sandboxId, input.port),
  );
  if (!connection)
    return new Response("Sandbox Portal is not connected", { status: 503 });
  const limit =
    relayLane(new URL(request.url).pathname) === "assets"
      ? connection.limitAssets
      : connection.limitRequests;
  return limit(async () => {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    if (
      connections.get(key(input.sessionId, input.sandboxId, input.port)) !==
      connection
    )
      return new Response("Sandbox Portal connection changed", { status: 503 });
    if (connection.expiresAt <= Date.now()) {
      try {
        connection.ws.close(1008, "portal credential expired");
      } catch {}
      return new Response("Sandbox Portal credential expired", { status: 503 });
    }
    const bytes =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : new Uint8Array(await request.arrayBuffer());
    if (bytes && bytes.byteLength > 5 * 1024 * 1024)
      return new Response("Portal request is too large", { status: 413 });
    const id = crypto.randomUUID();
    const result = await new Promise<RelayResponse>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: RelayResponse) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        request.signal.removeEventListener("abort", cancel);
        connection.pending.delete(id);
        resolve(value);
      };
      const cancel = () => {
        try {
          connection.ws.send(JSON.stringify({ t: "http_cancel", id }));
        } catch {}
        finish({ status: 499, headers: {} });
      };
      request.signal.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(
        () => finish({ status: 504, headers: {} }),
        RELAY_REQUEST_TIMEOUT_MS,
      );
      timer.unref?.();
      connection.pending.set(id, {
        resolve: finish,
        timer,
        headers: {},
        chunks: [],
        byteLength: 0,
      });
      try {
        connection.ws.send(
          JSON.stringify({
            t: "http",
            id,
            method: request.method,
            path: new URL(request.url).pathname + new URL(request.url).search,
            headers: safeHeaders(request.headers),
            ...(bytes ? { body: Buffer.from(bytes).toString("base64") } : {}),
          }),
        );
      } catch {
        clearTimeout(timer);
        finish({ status: 502, headers: {} });
      }
    });
    // The agent could not reach the app: its dev server is (re)starting
    // after a wake, or was restarted by hand. A person opening a page gets
    // the self-refreshing waiting page rather than a bare 502.
    if (
      result.status === 502 &&
      !result.body &&
      portalNavigationRequest(request)
    )
      return portalWaitingResponse({ state: "waking", retrySeconds: 3 });
    const headers = new Headers();
    for (const [name, value] of Object.entries(result.headers))
      if (!HOP_HEADERS.has(name.toLowerCase()) && typeof value === "string")
        headers.set(name, value);
    const body = result.body ? new Uint8Array(result.body) : undefined;
    return new Response(body, { status: result.status, headers });
  });
}

/** Bind the browser-facing Portal route to a local-only server. The Sandbox
 * can reach it only through its one registered outbound control connection. */
export async function ensureSandboxPortalRelay(input: {
  sessionId: string;
  sandboxId: string;
  port: number;
  /** The Portal's name, when the caller knows it (sandboxPortalLocalDir). */
  name?: string;
}): Promise<string | null> {
  const id = key(input.sessionId, input.sandboxId, input.port);
  let relay = relays.get(id);
  if (!relay) {
    const server = Bun.serve<{
      id: string;
      connection: Connection;
      path: string;
      headers: Record<string, string>;
    }>({
      hostname: "127.0.0.1",
      port: 0,
      // Browser asset bursts wait behind the sidecar's response-frame queue,
      // and cold Next/Turbopack routes may not send headers for minutes. Bun's
      // short default closes those healthy upstream sockets and Caddy turns
      // the EOF into a misleading 502. Keep this below the sidecar's bounded
      // four-minute app fetch timeout.
      idleTimeout: 255,
      fetch: (request, relayServer) => {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
          return relayFetch(input, request);
        const connection = connections.get(id);
        if (!connection || connection.expiresAt <= Date.now())
          return new Response("Sandbox Portal is not connected", {
            status: 503,
          });
        const socketId = crypto.randomUUID();
        return relayServer.upgrade(request, {
          data: {
            id: socketId,
            connection,
            path: new URL(request.url).pathname + new URL(request.url).search,
            headers: safeHeaders(request.headers),
          },
        })
          ? undefined
          : new Response("WebSocket upgrade failed", { status: 400 });
      },
      websocket: {
        open(ws) {
          const data = ws.data;
          browserSockets.set(data.id, { ws, connection: data.connection });
          try {
            data.connection.ws.send(
              JSON.stringify({
                t: "ws_open",
                id: data.id,
                path: data.path,
                headers: data.headers,
              }),
            );
          } catch {
            try {
              ws.close();
            } catch {}
          }
        },
        message(ws, message) {
          const data = ws.data;
          try {
            data.connection.ws.send(
              JSON.stringify({
                t: "ws_send",
                id: data.id,
                binary: typeof message !== "string",
                data:
                  typeof message === "string"
                    ? message
                    : Buffer.from(message as any).toString("base64"),
              }),
            );
          } catch {
            try {
              ws.close();
            } catch {}
          }
        },
        close(ws) {
          const data = ws.data;
          browserSockets.delete(data.id);
          try {
            data.connection.ws.send(
              JSON.stringify({ t: "ws_close", id: data.id }),
            );
          } catch {}
        },
      },
    });
    relay = {
      sessionId: input.sessionId,
      sandboxId: input.sandboxId,
      port: input.port,
      server,
    };
    relays.set(id, relay);
  }
  recordLocalAddress(relay, input.name);
  const upstream = `127.0.0.1:${relay.server.port}`;
  return queueRouteOperation(id, async () => {
    const { ensureAuthenticatedPortalRoute } = await import("./preview");
    return ensureAuthenticatedPortalRoute(
      sandboxHttpsPortFor(input.sandboxId, input.port),
      upstream,
    );
  });
}
