import { afterEach, describe, expect, test } from "bun:test";
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
