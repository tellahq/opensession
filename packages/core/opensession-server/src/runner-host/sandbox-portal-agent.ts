/**
 * Outbound-only HTTP relay for one supervised Sandbox Portal. It has no
 * provider URL or network destination beyond Open Session and localhost.
 */
const HOP = new Set([
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
export const PORTAL_RESPONSE_CHUNK_BYTES = 256 * 1024;
export const PORTAL_RESPONSE_MAX_BYTES = 128 * 1024 * 1024;
const headersFrom = (value: unknown) => {
  const headers = new Headers();
  if (value && typeof value === "object" && !Array.isArray(value))
    for (const [name, item] of Object.entries(value as Record<string, unknown>))
      if (
        !HOP.has(name.toLowerCase()) &&
        typeof item === "string" &&
        item.length <= 8192
      )
        headers.set(name, item);
  return headers;
};

export function loopbackHeaders(value: unknown, port: number): Headers {
  const headers = headersFrom(value);
  // Match a direct local-dev request. Passing the public Portal host makes
  // frameworks treat the request as a custom domain, while forwarding the
  // browser's compression negotiation lets fetch decompress a body whose
  // content-encoding header would then be stale on the relayed response.
  headers.set("host", `localhost:${port}`);
  headers.set("accept-encoding", "identity");
  return headers;
}

export type PortalResponseSender = (message: string) => Promise<void>;

/** Serialize large HTTP result frames until the previous frame has left the
 * client-side WebSocket buffer. Browser requests may still fetch loopback in
 * parallel; only the one constrained outbound connection is paced. */
export function createPortalResponseSender(
  socket: WebSocket,
  wait: () => Promise<unknown> = () => Bun.sleep(2),
): PortalResponseSender {
  let tail = Promise.resolve();
  return (message: string) => {
    const sending = tail.then(async () => {
      while (socket.readyState === WebSocket.OPEN && socket.bufferedAmount > 0)
        await wait();
      if (socket.readyState !== WebSocket.OPEN)
        throw new Error("Portal relay socket closed");
      socket.send(message);
    });
    tail = sending.catch(() => {});
    return sending;
  };
}

export type PortalRequestControllers = Map<string, AbortController>;

export function cancelPortalRequest(
  requests: PortalRequestControllers,
  msg: any,
): void {
  const id = typeof msg.id === "string" ? msg.id : "";
  if (id) requests.get(id)?.abort();
}

export async function sendPortalResponse(
  send: PortalResponseSender,
  id: string,
  response: Response,
  limits: { chunkBytes?: number; maxBytes?: number } = {},
): Promise<void> {
  const chunkBytes = limits.chunkBytes ?? PORTAL_RESPONSE_CHUNK_BYTES;
  const maxBytes = limits.maxBytes ?? PORTAL_RESPONSE_MAX_BYTES;
  if (
    !Number.isInteger(chunkBytes) ||
    chunkBytes < 1 ||
    !Number.isInteger(maxBytes) ||
    maxBytes < chunkBytes
  )
    throw new Error("Invalid Portal response limits");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes)
    throw new Error("response too large");
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers)
    if (!HOP.has(name.toLowerCase())) headers[name] = value;
  await send(
    JSON.stringify({
      t: "http_result_start",
      id,
      status: response.status,
      headers,
    }),
  );
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new Error("response too large");
        for (let offset = 0; offset < value.byteLength; offset += chunkBytes) {
          const chunk = value.subarray(
            offset,
            Math.min(offset + chunkBytes, value.byteLength),
          );
          await send(
            JSON.stringify({
              t: "http_result_chunk",
              id,
              body: Buffer.from(chunk).toString("base64"),
            }),
          );
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  await send(JSON.stringify({ t: "http_result_end", id }));
}

async function respond(
  send: PortalResponseSender,
  msg: any,
  port: number,
  requests: PortalRequestControllers,
): Promise<void> {
  const id = typeof msg.id === "string" ? msg.id : "";
  const path = typeof msg.path === "string" ? msg.path : "";
  const method =
    typeof msg.method === "string" ? msg.method.toUpperCase() : "GET";
  if (
    !id ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    !/^[A-Z]{3,10}$/.test(method)
  )
    return;
  const controller = new AbortController();
  requests.set(id, controller);
  const timeout = setTimeout(() => controller.abort(), 240_000);
  try {
    const body =
      typeof msg.body === "string"
        ? Buffer.from(msg.body, "base64")
        : undefined;
    if (body && body.byteLength > 5 * 1024 * 1024)
      throw new Error("request too large");
    // A first visit to a large Next/Turbopack route can compile for several
    // minutes. Keep the request bounded, but do not sever a healthy Portal
    // midway through its cold build and turn it into an empty proxy 502.
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: loopbackHeaders(msg.headers, port),
      body: body && method !== "GET" && method !== "HEAD" ? body : undefined,
      redirect: "manual",
      signal: controller.signal,
    });
    await sendPortalResponse(send, id, response);
  } catch {
    try {
      await send(
        JSON.stringify({
          t: "http_result_abort",
          id,
          status: controller.signal.aborted ? 499 : 502,
        }),
      );
    } catch {}
  } finally {
    clearTimeout(timeout);
    if (requests.get(id) === controller) requests.delete(id);
  }
}

type SocketPayload = string | Buffer;
export type PortalSocketState = { socket: WebSocket; pending: SocketPayload[] };
type WebSocketFactory = (url: string, options: unknown) => WebSocket;

export function openWebSocket(
  socket: WebSocket,
  sockets: Map<string, PortalSocketState>,
  msg: any,
  port: number,
  createWebSocket: WebSocketFactory = (url, options) =>
    new WebSocket(url, options as any),
): void {
  const id = typeof msg.id === "string" ? msg.id : "";
  const path = typeof msg.path === "string" ? msg.path : "";
  if (!id || !path.startsWith("/") || path.startsWith("//")) return;
  try {
    const local = createWebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: loopbackHeaders(msg.headers, port),
    });
    const state: PortalSocketState = { socket: local, pending: [] };
    sockets.set(id, state);
    local.addEventListener("open", () => {
      if (sockets.get(id) !== state) return;
      while (state.pending.length > 0 && local.readyState === WebSocket.OPEN)
        local.send(state.pending.shift()!);
    });
    local.addEventListener("message", (event: any) => {
      if (sockets.get(id) !== state) return;
      try {
        socket.send(
          JSON.stringify({
            t: "ws_event",
            id,
            binary: typeof event.data !== "string",
            data:
              typeof event.data === "string"
                ? event.data
                : Buffer.from(event.data).toString("base64"),
          }),
        );
      } catch {}
    });
    const closed = () => {
      if (sockets.get(id) !== state) return;
      sockets.delete(id);
      try {
        socket.send(JSON.stringify({ t: "ws_closed", id }));
      } catch {}
    };
    local.addEventListener("close", closed);
    local.addEventListener("error", closed);
  } catch {
    try {
      socket.send(JSON.stringify({ t: "ws_closed", id }));
    } catch {}
  }
}

export function sendWebSocket(
  sockets: Map<string, PortalSocketState>,
  msg: any,
): void {
  const state = sockets.get(String(msg.id));
  if (!state) return;
  const payload =
    msg.binary === true && typeof msg.data === "string"
      ? Buffer.from(msg.data, "base64")
      : String(msg.data ?? "");
  if (state.socket.readyState === WebSocket.CONNECTING)
    state.pending.push(payload);
  else if (state.socket.readyState === WebSocket.OPEN)
    state.socket.send(payload);
}

export function relayRetryDelayMs(failedAttempts: number): number {
  return Math.min(
    30_000,
    1_000 * 2 ** Math.min(Math.max(0, failedAttempts), 5),
  );
}

async function run(
  endpoint: string,
  token: string,
  port: number,
  expiresAt: number,
): Promise<void> {
  let failedAttempts = 0;
  while (Date.now() < expiresAt) {
    const connected = await new Promise<boolean>((resolve) => {
      const sockets = new Map<string, PortalSocketState>();
      const requests: PortalRequestControllers = new Map();
      let socket: WebSocket;
      let opened = false;
      try {
        socket = new WebSocket(endpoint, {
          headers: { authorization: `Bearer ${token}` },
        } as any);
      } catch {
        resolve(false);
        return;
      }
      const sendResponse = createPortalResponseSender(socket);
      socket.addEventListener("open", () => {
        opened = true;
      });
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.t === "http")
            void respond(sendResponse, message, port, requests);
          else if (message.t === "http_cancel")
            cancelPortalRequest(requests, message);
          else if (message.t === "ws_open")
            openWebSocket(socket, sockets, message, port);
          else if (message.t === "ws_send") sendWebSocket(sockets, message);
          else if (message.t === "ws_close") {
            const state = sockets.get(String(message.id));
            if (state)
              try {
                state.socket.close();
              } catch {}
          }
        } catch {}
      });
      socket.addEventListener(
        "close",
        () => {
          for (const request of requests.values()) request.abort();
          requests.clear();
          for (const state of sockets.values())
            try {
              state.socket.close();
            } catch {}
          sockets.clear();
          resolve(opened);
        },
        { once: true },
      );
      socket.addEventListener("error", () => {
        try {
          socket.close();
        } catch {}
      });
    });
    failedAttempts = connected ? 0 : failedAttempts + 1;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) break;
    await Bun.sleep(Math.min(remaining, relayRetryDelayMs(failedAttempts)));
  }
}

if (import.meta.main) {
  const endpoint = process.env.OPENSESSION_SANDBOX_PORTAL_WS_URL || "";
  const token = process.env.OPENSESSION_SANDBOX_PORTAL_TOKEN || "";
  const port = Number(process.env.OPENSESSION_SANDBOX_PORTAL_PORT);
  const expiresAt = Number(process.env.OPENSESSION_SANDBOX_PORTAL_EXPIRES_AT);
  if (
    !endpoint ||
    !token ||
    !Number.isInteger(port) ||
    !Number.isFinite(expiresAt)
  )
    process.exit(2);
  await run(endpoint, token, port, expiresAt);
}
