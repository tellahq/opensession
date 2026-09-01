import { expect, test } from "bun:test";
import {
  cancelPortalRequest,
  createPortalResponseSender,
  loopbackHeaders,
  openWebSocket,
  relayRetryDelayMs,
  sendPortalResponse,
  sendWebSocket,
  type PortalRequestControllers,
  type PortalSocketState,
} from "./sandbox-portal-agent";

test("uses local-dev host semantics and disables upstream compression", () => {
  const headers = loopbackHeaders(
    {
      host: "portal.example:22000",
      "accept-encoding": "gzip, br",
      cookie: "session=abc",
    },
    4300,
  );
  expect(headers.get("host")).toBe("localhost:4300");
  expect(headers.get("accept-encoding")).toBe("identity");
  expect(headers.get("cookie")).toBe("session=abc");
});

test("aborts loopback fetches when the browser cancels a relayed request", () => {
  const controller = new AbortController();
  const requests: PortalRequestControllers = new Map([
    ["request-1", controller],
  ]);
  cancelPortalRequest(requests, { id: "request-1" });
  expect(controller.signal.aborted).toBe(true);
});

test("backs stale relay credentials off instead of flooding public ingress", () => {
  expect([0, 1, 2, 3, 4, 5, 20].map(relayRetryDelayMs)).toEqual([
    1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
  ]);
});

class FakeWebSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  readonly sent: Array<string | Buffer> = [];

  send(data: string | Buffer): void {
    if (this.readyState !== WebSocket.OPEN)
      throw new Error("socket is not open");
    this.sent.push(data);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }
}

test("paces HTTP result frames behind WebSocket backpressure", async () => {
  const sent: string[] = [];
  const waits: Array<() => void> = [];
  const relay = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send(message: string) {
      sent.push(message);
      relay.bufferedAmount = message.length;
    },
  };
  const socket = relay as unknown as WebSocket;
  const send = createPortalResponseSender(
    socket,
    () => new Promise<void>((resolve) => waits.push(resolve)),
  );

  await send("first");
  const second = send("second");
  await Promise.resolve();
  expect(sent).toEqual(["first"]);
  (socket as unknown as { bufferedAmount: number }).bufferedAmount = 0;
  waits.shift()!();
  await second;
  expect(sent).toEqual(["first", "second"]);
});

test("queues immediate WebSocket frames until the loopback socket opens", () => {
  const relay = { send() {} } as unknown as WebSocket;
  const local = new FakeWebSocket();
  const sockets = new Map<string, PortalSocketState>();

  openWebSocket(
    relay,
    sockets,
    { id: "socket-1", path: "/events" },
    4300,
    () => local as unknown as WebSocket,
  );
  sendWebSocket(sockets, { id: "socket-1", data: "first" });
  sendWebSocket(sockets, { id: "socket-1", data: "second" });

  expect(local.sent).toEqual([]);
  local.open();
  expect(local.sent).toEqual(["first", "second"]);
});

test("ignores close events from a replaced loopback socket", () => {
  const relayMessages: string[] = [];
  const relay = {
    send(message: string) {
      relayMessages.push(message);
    },
  } as unknown as WebSocket;
  const first = new FakeWebSocket();
  const replacement = new FakeWebSocket();
  const locals = [first, replacement];
  const sockets = new Map<string, PortalSocketState>();

  openWebSocket(
    relay,
    sockets,
    { id: "socket-1", path: "/first" },
    4300,
    () => locals.shift()! as unknown as WebSocket,
  );
  openWebSocket(
    relay,
    sockets,
    { id: "socket-1", path: "/replacement" },
    4300,
    () => locals.shift()! as unknown as WebSocket,
  );
  first.close();

  expect(sockets.get("socket-1")?.socket).toBe(
    replacement as unknown as WebSocket,
  );
  expect(relayMessages).toEqual([]);
  replacement.close();
  expect(sockets.has("socket-1")).toBe(false);
  expect(relayMessages).toEqual([
    JSON.stringify({ t: "ws_closed", id: "socket-1" }),
  ]);
});

test("frames large Portal responses instead of sending one oversized WebSocket message", async () => {
  const messages: any[] = [];
  await sendPortalResponse(
    async (message) => {
      messages.push(JSON.parse(message));
    },
    "request-1",
    new Response("abcdefghijklmnop", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }),
    { chunkBytes: 5, maxBytes: 20 },
  );

  expect(messages.map((message) => message.t)).toEqual([
    "http_result_start",
    "http_result_chunk",
    "http_result_chunk",
    "http_result_chunk",
    "http_result_chunk",
    "http_result_end",
  ]);
  const body = Buffer.concat(
    messages
      .filter((message) => message.t === "http_result_chunk")
      .map((message) => Buffer.from(message.body, "base64")),
  );
  expect(body.toString()).toBe("abcdefghijklmnop");
  expect(
    Math.max(
      ...messages.map((message) =>
        message.body ? Buffer.from(message.body, "base64").byteLength : 0,
      ),
    ),
  ).toBe(5);
});

test("relays a development asset larger than the former 10 MB ceiling", async () => {
  const size = 10 * 1024 * 1024 + 1;
  let received = 0;
  let frames = 0;
  await sendPortalResponse(
    async (message) => {
      const frame = JSON.parse(message);
      if (frame.t !== "http_result_chunk") return;
      frames += 1;
      received += Buffer.from(frame.body, "base64").byteLength;
    },
    "request-large",
    new Response(Buffer.alloc(size, 7)),
  );
  expect(received).toBe(size);
  expect(frames).toBeGreaterThan(1);
});

test("rejects Portal responses beyond the bounded total size", async () => {
  await expect(
    sendPortalResponse(async () => {}, "request-1", new Response("too large"), {
      chunkBytes: 4,
      maxBytes: 8,
    }),
  ).rejects.toThrow("response too large");
});
