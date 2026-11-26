/**
 * The Claude host's listener: one authenticated WebSocket endpoint that hands
 * each connection to the transport-free core in host.ts, plus a liveness
 * probe. Nothing here starts at import; `startClaudeHostServer` binds.
 */

import { timingSafeEqual } from "node:crypto";
import {
  createClaudeHostConnection,
  type ClaudeHostConnection,
  type ClaudeHostOptions,
} from "./host";
import { CLAUDE_HOST_PROTOCOL, CLAUDE_HOST_QUERY_PATH } from "./protocol";

export interface ClaudeHostServerOptions extends Pick<
  ClaudeHostOptions,
  "startQuery" | "prepare"
> {
  hostname: string;
  port: number;
  /** Bearer token every client must present. */
  token: string;
  maxQueries: number;
}

export interface ClaudeHostServer {
  port: number;
  /** Queries running now, across every connection. */
  queries(): number;
  /** Close every connection, which ends every query. */
  stop(): void;
}

/** One input frame can carry a turn's images; one output frame is one SDK
 *  message. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

function presentsToken(request: Request, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match) return false;
  const presented = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

export function startClaudeHostServer(
  options: ClaudeHostServerOptions,
): ClaudeHostServer {
  const running = new Set<object>();
  const connections = new Set<ClaudeHostConnection>();
  const server = Bun.serve<{ connection?: ClaudeHostConnection }>({
    hostname: options.hostname,
    port: options.port,
    fetch(request, bunServer) {
      const { pathname } = new URL(request.url);
      if (pathname === "/live")
        return Response.json({
          ok: true,
          protocol: CLAUDE_HOST_PROTOCOL,
          queries: running.size,
        });
      if (pathname !== CLAUDE_HOST_QUERY_PATH)
        return new Response("Not found", { status: 404 });
      if (!presentsToken(request, options.token))
        return new Response("Unauthorized", { status: 401 });
      if (bunServer.upgrade(request, { data: {} })) return undefined;
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    },
    websocket: {
      maxPayloadLength: MAX_FRAME_BYTES,
      open(socket) {
        const connection = createClaudeHostConnection(
          { send: (frame) => void socket.send(JSON.stringify(frame)) },
          {
            startQuery: options.startQuery,
            prepare: options.prepare,
            running,
            maxQueries: options.maxQueries,
          },
        );
        socket.data.connection = connection;
        connections.add(connection);
      },
      message(socket, message) {
        if (typeof message === "string")
          socket.data.connection?.receive(message);
      },
      close(socket) {
        const connection = socket.data.connection;
        if (!connection) return;
        connections.delete(connection);
        connection.close();
      },
    },
  });
  return {
    port: server.port ?? options.port,
    queries: () => running.size,
    stop: () => {
      // End the queries now; the socket close callbacks may run later.
      for (const connection of [...connections]) connection.close();
      connections.clear();
      void server.stop(true);
    },
  };
}
