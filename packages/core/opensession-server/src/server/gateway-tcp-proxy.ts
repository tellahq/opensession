import { createConnection, createServer, type Socket } from "node:net";

export type GatewayTcpProxy = {
  readonly port: number;
  stop(closeActiveConnections?: boolean): void;
};

export type GatewayTcpProxyMetrics = {
  accepted: number;
  connected: number;
  retries: number;
  unavailableRetries: number;
  rejected: number;
  timedOut: number;
  closed: number;
  pending: number;
  active: number;
  maxConnectWaitMs: number;
  fallbackServed: number;
};

export function createGatewayTcpProxyMetrics(): GatewayTcpProxyMetrics {
  return {
    accepted: 0,
    connected: 0,
    retries: 0,
    unavailableRetries: 0,
    rejected: 0,
    timedOut: 0,
    closed: 0,
    pending: 0,
    active: 0,
    maxConnectWaitMs: 0,
    fallbackServed: 0,
  };
}

export interface GatewayTcpProxyOptions {
  hostname: string;
  port: number;
  backendPort(): number;
  retryMs?: number;
  maxRetryMs?: number;
  connectDeadlineMs?: number;
  maxPendingConnections?: number;
  metrics?: GatewayTcpProxyMetrics;
  /** Optional stable HTTP response before a replaceable backend is connected. */
  fallbackHttp?(request: Buffer): Buffer | null;
  /** systemd socket-activation descriptor. PID 1 retains the listening socket. */
  listenFd?: number;
}

function validBackendPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}

function retryDelay(
  initialMs: number,
  maximumMs: number,
  attempt: number,
): number {
  return Math.min(maximumMs, initialMs * 2 ** Math.min(attempt, 10));
}

type ParkedConnection = {
  client: Socket;
  timer?: ReturnType<typeof setTimeout>;
  acceptedAt: number;
  retryAttempt: number;
  admitted: boolean;
  chunks: Buffer[];
  bytes: number;
  served: boolean;
};

/**
 * Stable byte-for-byte TCP front door for gateway children. It deliberately
 * knows nothing about HTTP or WebSockets, so upgrades, streaming bodies and
 * long-lived sockets retain their native semantics. Connections accepted
 * during the child cut-over stay paused until the activated child binds.
 *
 * One implementation serves every install: with `listenFd` it adopts the
 * systemd-owned socket (dedicated ingress), and without it it binds
 * hostname:port directly (supervisor-internal listener, dev, tests), so the
 * tested code path is the production code path.
 */
export function startGatewayTcpProxy(
  options: GatewayTcpProxyOptions,
): GatewayTcpProxy {
  const retryMs = Math.max(1, options.retryMs ?? 25);
  const maxRetryMs = Math.max(retryMs, options.maxRetryMs ?? 250);
  const connectDeadlineMs = Math.max(1, options.connectDeadlineMs ?? 30_000);
  const maxPendingConnections = Math.max(
    1,
    options.maxPendingConnections ?? 2_048,
  );
  const metrics = options.metrics ?? createGatewayTcpProxyMetrics();
  const pending = new Set<ParkedConnection>();
  const active = new Set<Socket>();

  const server = createServer({ pauseOnConnect: true }, (client) => {
    const admitted = metrics.pending < maxPendingConnections;
    const state: ParkedConnection = {
      client,
      acceptedAt: Date.now(),
      retryAttempt: 0,
      admitted,
      chunks: [],
      bytes: 0,
      served: false,
    };
    if (admitted) {
      pending.add(state);
      metrics.pending++;
    }
    metrics.accepted++;
    const deadline = state.acceptedAt + connectDeadlineMs;

    const rejectOverload = () => {
      if (client.destroyed || state.served) return;
      state.served = true;
      metrics.rejected++;
      metrics.closed++;
      client.destroy();
    };
    const schedule = (backendUnavailable: boolean) => {
      if (client.destroyed || state.served) return;
      if (Date.now() >= deadline) {
        if (pending.delete(state)) metrics.pending--;
        metrics.timedOut++;
        client.destroy();
        return;
      }
      metrics.retries++;
      if (backendUnavailable) metrics.unavailableRetries++;
      const delay = retryDelay(retryMs, maxRetryMs, state.retryAttempt++);
      state.timer = setTimeout(connect, delay);
      state.timer.unref?.();
    };
    const connect = () => {
      state.timer = undefined;
      if (client.destroyed || state.served) return;
      const port = options.backendPort();
      if (!validBackendPort(port)) {
        schedule(true);
        return;
      }
      const upstream = createConnection({ host: "127.0.0.1", port });
      const retry = () => {
        upstream.destroy();
        schedule(false);
      };
      upstream.once("error", retry);
      upstream.once("connect", () => {
        upstream.removeListener("error", retry);
        if (state.served) {
          upstream.destroy();
          return;
        }
        if (pending.delete(state)) metrics.pending--;
        metrics.connected++;
        metrics.active++;
        metrics.maxConnectWaitMs = Math.max(
          metrics.maxConnectWaitMs,
          Date.now() - state.acceptedAt,
        );
        active.add(client);
        active.add(upstream);
        client.removeListener("data", onData);
        if (state.bytes > 0)
          upstream.write(Buffer.concat(state.chunks, state.bytes));
        state.chunks = [];
        state.bytes = 0;
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
        const close = () => {
          if (!active.delete(client)) return;
          active.delete(upstream);
          metrics.active--;
          metrics.closed++;
          client.destroy();
          upstream.destroy();
        };
        client.once("close", close);
        upstream.once("close", close);
      });
    };
    const onData = (chunk: Buffer) => {
      if (state.served) return;
      state.chunks.push(chunk);
      state.bytes += chunk.byteLength;
      const request = Buffer.concat(state.chunks, state.bytes);
      let fallback: Buffer | null | undefined;
      try {
        fallback = options.fallbackHttp?.(request);
      } catch (error) {
        console.error("[gateway-proxy] stable HTTP fallback failed", error);
      }
      if (fallback) {
        state.served = true;
        if (state.timer) clearTimeout(state.timer);
        if (pending.delete(state)) metrics.pending--;
        metrics.fallbackServed++;
        client.end(fallback);
        return;
      }
      // The first bytes are backend-bound: dial immediately instead of
      // waiting out the classification grace timer. Only the first attempt
      // short-circuits, so retry backoff is never reset by later chunks.
      if (state.admitted && state.retryAttempt === 0 && state.timer) {
        clearTimeout(state.timer);
        connect();
      }
      if (state.bytes >= 64 * 1024) client.pause();
    };
    client.on("data", onData);
    client.resume();

    client.once("close", () => {
      if (pending.delete(state)) {
        metrics.pending--;
        metrics.closed++;
      }
      if (state.timer) clearTimeout(state.timer);
    });
    state.timer = setTimeout(
      admitted ? connect : rejectOverload,
      options.fallbackHttp ? (admitted ? 2 : 10) : 0,
    );
    state.timer.unref?.();
  });
  if (options.listenFd !== undefined) server.listen({ fd: options.listenFd });
  else server.listen(options.port, options.hostname);
  return {
    get port() {
      const address = server.address();
      return typeof address === "object" && address !== null
        ? address.port
        : options.port;
    },
    stop(closeActiveConnections = false) {
      server.close();
      if (closeActiveConnections) {
        for (const parked of pending) parked.client.destroy();
        pending.clear();
        for (const socket of active) socket.destroy();
        active.clear();
      }
    },
  };
}
