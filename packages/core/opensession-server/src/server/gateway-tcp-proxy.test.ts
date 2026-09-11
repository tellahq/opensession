import { afterEach, describe, expect, test } from "bun:test";
import { createConnection, createServer } from "node:net";
import { once } from "node:events";
import {
  createGatewayTcpProxyMetrics,
  startGatewayTcpProxy,
} from "./gateway-tcp-proxy";

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

async function until(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await Bun.sleep(5);
  }
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function backend(body: string) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(body),
  });
  servers.push(server);
  return server;
}

describe("gateway TCP proxy", () => {
  test("passes WebSocket upgrades and frames without interpreting them", async () => {
    const websocketBackend = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        return server.upgrade(request)
          ? undefined
          : new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message(socket, message) {
          socket.send(message);
        },
      },
    });
    servers.push(websocketBackend);
    const proxy = startGatewayTcpProxy({
      hostname: "127.0.0.1",
      port: 0,
      backendPort: () => websocketBackend.port!,
    });
    servers.push(proxy);

    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/ws`);
      socket.onopen = () => socket.send("through-proxy");
      socket.onmessage = (event) => {
        resolve(String(event.data));
        socket.close();
      };
      socket.onerror = () => reject(new Error("WebSocket proxy failed"));
    });
    expect(echoed).toBe("through-proxy");
  });

  test("serves frontend fallback before touching an available backend", async () => {
    let backendRequests = 0;
    const available = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        backendRequests++;
        return new Response("backend");
      },
    });
    servers.push(available);
    const proxy = startGatewayTcpProxy({
      hostname: "127.0.0.1",
      port: 0,
      backendPort: () => available.port!,
      fallbackHttp(request) {
        if (!request.toString().includes("\r\n\r\n")) return null;
        return Buffer.from(
          "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nstable",
        );
      },
    });
    servers.push(proxy);
    expect(
      await fetch(`http://127.0.0.1:${proxy.port}/`).then((r) => r.text()),
    ).toBe("stable");
    expect(backendRequests).toBe(0);
  });

  for (const partial of ["", "GET / HTTP/1.1\r\nHost: localhost\r\n"]) {
    test(`waits for ${partial ? "fragmented headers" : "delayed first bytes"} before dialing`, async () => {
      const metrics = createGatewayTcpProxyMetrics();
      const available = backend("backend");
      const proxy = startGatewayTcpProxy({
        hostname: "127.0.0.1",
        port: 0,
        backendPort: () => available.port!,
        metrics,
        fallbackHttp(request) {
          return request.includes("\r\n\r\n")
            ? Buffer.from(
                "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nstable",
              )
            : null;
        },
      });
      servers.push(proxy);
      const client = createConnection({ host: "127.0.0.1", port: proxy.port });
      servers.push({ stop: () => client.destroy() });
      const chunks: Buffer[] = [];
      client.on("data", (chunk) =>
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
      );
      await once(client, "connect");
      if (partial) client.write(partial);
      // Longer than the old 2ms dial grace, with no dependency on HTTP fetch timing.
      await Bun.sleep(30);
      const prematureConnections = metrics.connected;
      const ended = once(client, "end");
      client.write(
        `${partial ? "" : "GET / HTTP/1.1\r\nHost: localhost\r\n"}Connection: close\r\n\r\n`,
      );
      await ended;
      expect(prematureConnections).toBe(0);
      expect(Buffer.concat(chunks).toString()).toEndWith("stable");
      expect(metrics.connected).toBe(0);
      expect(metrics.fallbackServed).toBe(1);
    });
  }

  test("expires an idle HTTP classifier without dialing a backend", async () => {
    const metrics = createGatewayTcpProxyMetrics();
    const available = backend("backend");
    const proxy = startGatewayTcpProxy({
      hostname: "127.0.0.1",
      port: 0,
      backendPort: () => available.port!,
      fallbackHttp: () => null,
      connectDeadlineMs: 50,
      metrics,
    });
    servers.push(proxy);
    const client = createConnection({ host: "127.0.0.1", port: proxy.port });
    servers.push({ stop: () => client.destroy() });
    client.resume();
    await once(client, "end");
    await until(() => metrics.pending === 0);
    expect(metrics.timedOut).toBe(1);
    expect(metrics.closed).toBe(1);
    expect(metrics.connected).toBe(0);
  });

  test("forwards backend request bodies unchanged with a fallback configured", async () => {
    const available = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => new Response(await request.text()),
    });
    servers.push(available);
    const metrics = createGatewayTcpProxyMetrics();
    const proxy = startGatewayTcpProxy({
      hostname: "127.0.0.1",
      port: 0,
      backendPort: () => available.port!,
      fallbackHttp: () => null,
      metrics,
    });
    servers.push(proxy);
    const body = "payload".repeat(12_000);
    const response = await fetch(`http://127.0.0.1:${proxy.port}/api/echo`, {
      method: "POST",
      body,
    });
    expect(await response.text()).toBe(body);
    expect(metrics.connected).toBe(1);
    expect(metrics.fallbackServed).toBe(0);
  });

  test("bounds classification at 64 KiB and forwards every buffered byte", async () => {
    const received: Buffer[] = [];
    let bytes = 0;
    const available = createServer((socket) => {
      servers.push({ stop: () => socket.destroy() });
      socket.on("data", (chunk) => {
        const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        received.push(data);
        bytes += data.byteLength;
        if (bytes >= 64 * 1024) socket.end("backend");
      });
    });
    servers.push({ stop: () => available.close() });
    available.listen(0, "127.0.0.1");
    await once(available, "listening");
    const address = available.address();
    if (!address || typeof address === "string")
      throw new Error("No backend port");
    const metrics = createGatewayTcpProxyMetrics();
    const proxy = startGatewayTcpProxy({
      hostname: "127.0.0.1",
      port: 0,
      backendPort: () => address.port,
      fallbackHttp: () => null,
      metrics,
    });
    servers.push(proxy);
    const client = createConnection({ host: "127.0.0.1", port: proxy.port });
    servers.push({ stop: () => client.destroy() });
    client.resume();
    const ended = once(client, "end");
    const body = Buffer.alloc(64 * 1024, "x");
    client.write(body);
    await ended;
    expect(Buffer.concat(received)).toEqual(body);
    expect(metrics.connected).toBe(1);
  });

  test("serves a stable HTTP fallback while no backend is selected", async () => {
    const metrics = createGatewayTcpProxyMetrics();
    const body = "stable shell";
    const proxy = startGatewayTcpProxy({
      hostname: "127.0.0.1",
      port: 0,
      backendPort: () => 0,
      retryMs: 5,
      connectDeadlineMs: 1_000,
      metrics,
      fallbackHttp(request) {
        if (!request.toString().includes("\r\n\r\n")) return null;
        return Buffer.from(
          `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
        );
      },
    });
    servers.push(proxy);

    expect(
      await fetch(`http://127.0.0.1:${proxy.port}/`).then((r) => r.text()),
    ).toBe(body);
    expect(metrics.fallbackServed).toBe(1);
    expect(metrics.connected).toBe(0);
    expect(metrics.pending).toBe(0);
  });

  test("keeps the public listener while the selected backend changes", async () => {
    const first = backend("first");
    let backendPort = first.port!;
    const metrics = createGatewayTcpProxyMetrics();
    const proxy = startGatewayTcpProxy({
      hostname: "127.0.0.1",
      port: 0,
      backendPort: () => backendPort,
      retryMs: 5,
      connectDeadlineMs: 1_000,
      metrics,
    });
    servers.push(proxy);

    expect(
      await fetch(`http://127.0.0.1:${proxy.port}/`).then((r) => r.text()),
    ).toBe("first");

    first.stop(true);
    const waiting = fetch(`http://127.0.0.1:${proxy.port}/`).then((r) =>
      r.text(),
    );
    await Bun.sleep(25);
    const second = backend("second");
    backendPort = second.port!;

    expect(await waiting).toBe("second");
    expect(proxy.port).toBeGreaterThan(0);
    expect(metrics.accepted).toBe(2);
    expect(metrics.connected).toBe(2);
    expect(metrics.retries).toBeGreaterThan(0);
    expect(metrics.maxConnectWaitMs).toBeGreaterThan(0);
  });

  test("backs off without dialing while no backend is selected", async () => {
    let backendPort = 0;
    const metrics = createGatewayTcpProxyMetrics();
    const proxy = startGatewayTcpProxy({
      hostname: "127.0.0.1",
      port: 0,
      backendPort: () => backendPort,
      retryMs: 5,
      maxRetryMs: 20,
      connectDeadlineMs: 1_000,
      metrics,
    });
    servers.push(proxy);

    const waiting = fetch(`http://127.0.0.1:${proxy.port}/`).then((response) =>
      response.text(),
    );
    await until(() => metrics.unavailableRetries >= 4);
    const available = backend("ready");
    backendPort = available.port!;

    expect(await waiting).toBe("ready");
    expect(metrics.unavailableRetries).toBeLessThan(9);
    expect(metrics.connected).toBe(1);
  });

  test("bounds parked backend traffic while still serving the stable shell", async () => {
    const metrics = createGatewayTcpProxyMetrics();
    const proxy = startGatewayTcpProxy({
      hostname: "127.0.0.1",
      port: 0,
      backendPort: () => 0,
      retryMs: 5,
      connectDeadlineMs: 1_000,
      maxPendingConnections: 1,
      metrics,
      fallbackHttp(request) {
        if (!request.toString().startsWith("GET / HTTP/")) return null;
        return Buffer.from(
          "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nstable",
        );
      },
    });
    servers.push(proxy);

    const heldAbort = new AbortController();
    const held = fetch(`http://127.0.0.1:${proxy.port}/api/held`, {
      signal: heldAbort.signal,
    }).catch(() => null);
    await until(() => metrics.pending === 1);

    expect(
      await fetch(`http://127.0.0.1:${proxy.port}/`).then((response) =>
        response.text(),
      ),
    ).toBe("stable");
    void fetch(`http://127.0.0.1:${proxy.port}/api/rejected`, {
      signal: AbortSignal.timeout(500),
    }).catch(() => null);
    await until(() => metrics.rejected === 1);
    expect(metrics.pending).toBe(1);
    expect(metrics.fallbackServed).toBe(1);

    heldAbort.abort();
    await held;
  });
});
