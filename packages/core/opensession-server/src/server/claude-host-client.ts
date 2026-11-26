/**
 * Client side of the Claude host protocol (src/claude-host/protocol.ts): runs
 * one Claude Agent SDK query on a Claude host service and presents it as the
 * same handle a local query returns.
 *
 * One WebSocket per query. The query ends when this side closes the handle,
 * aborts, or loses the socket; a lost socket surfaces as a rejected `next()`
 * so the provider treats it like any failed SDK turn and replays the next
 * step, instead of waiting on a process that no longer exists.
 */

import {
  CLAUDE_HOST_PROTOCOL,
  CLAUDE_HOST_QUERY_PATH,
  type ClaudeHostClientFrame,
  type ClaudeHostServerFrame,
} from "../claude-host/protocol";
import type { ClaudeHostEndpoint } from "./claude-host-endpoint";
import type {
  ClaudeQueryHandle,
  ClaudeQueryIo,
  ClaudeQuerySpec,
} from "./claude-sdk-query";

type Item =
  | { kind: "value"; value: Record<string, any> }
  | { kind: "done" }
  | { kind: "error"; error: Error };

function queryUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}${CLAUDE_HOST_QUERY_PATH}`;
}

export function startRemoteClaudeQuery(
  spec: ClaudeQuerySpec,
  io: ClaudeQueryIo,
  endpoint: Promise<ClaudeHostEndpoint>,
): ClaudeQueryHandle {
  const id = crypto.randomUUID();
  const items: Item[] = [];
  const waiters: Array<(item: Item) => void> = [];
  let socket: WebSocket | undefined;
  let ready = false;
  let finished = false;
  let hostUrl = "the Claude host";

  const deliver = (item: Item) => {
    const waiter = waiters.shift();
    if (waiter) waiter(item);
    else items.push(item);
  };
  /** Settle the stream once; later frames and socket events are ignored. */
  const finish = (item: Item) => {
    if (finished) return;
    finished = true;
    deliver(item);
    io.abortController.signal.removeEventListener("abort", close);
    try {
      socket?.close();
    } catch {
      // Already closed.
    }
  };
  const send = (frame: ClaudeHostClientFrame) => {
    if (finished || !ready || !socket) return;
    socket.send(JSON.stringify(frame));
  };
  function close() {
    send({ t: "close", id });
    finish({ kind: "done" });
  }

  const pumpInput = async () => {
    try {
      for await (const message of io.prompt) {
        if (finished) return;
        send({ t: "input", id, message });
      }
      send({ t: "input_end", id });
    } catch (error) {
      finish({
        kind: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  };

  const onFrame = (frame: ClaudeHostServerFrame) => {
    if (frame.t === "ready") {
      if (frame.protocol !== CLAUDE_HOST_PROTOCOL) {
        finish({
          kind: "error",
          error: new Error(
            `The Claude host at ${hostUrl} speaks protocol ${frame.protocol}, this server speaks ${CLAUDE_HOST_PROTOCOL}. Run both from the same release.`,
          ),
        });
        return;
      }
      ready = true;
      send({ t: "start", id, spec });
      void pumpInput();
      return;
    }
    if (frame.id !== id) return;
    switch (frame.t) {
      case "message":
        deliver({ kind: "value", value: frame.message });
        return;
      case "tool_call": {
        const toolUseId = frame.toolUseId;
        void io
          .onToolCall(toolUseId)
          .then((reply) => send({ t: "tool_result", id, toolUseId, reply }));
        return;
      }
      case "end":
        finish({ kind: "done" });
        return;
      case "error":
        finish({ kind: "error", error: new Error(frame.message) });
        return;
    }
  };

  io.abortController.signal.addEventListener("abort", close, { once: true });

  void endpoint.then(
    ({ url, token }) => {
      hostUrl = url;
      if (finished) return;
      // Bun's WebSocket accepts request headers; the DOM type does not know.
      socket = new (WebSocket as any)(queryUrl(url), {
        headers: { authorization: `Bearer ${token}` },
      }) as WebSocket;
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let frame: ClaudeHostServerFrame;
        try {
          frame = JSON.parse(event.data);
        } catch {
          return;
        }
        onFrame(frame);
      });
      const lost = () =>
        finish({
          kind: "error",
          error: new Error(
            ready
              ? `Lost the connection to the Claude host at ${url}`
              : `Could not connect to the Claude host at ${url}: it is not running, or it rejected this server's token. Start it, or set anthropicTransport back to "inprocess" in pi.json.`,
          ),
        });
      socket.addEventListener("close", lost);
      socket.addEventListener("error", lost);
    },
    (error) =>
      finish({
        kind: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      }),
  );

  return {
    next() {
      const item = items.shift();
      const settle = (
        settled: Item,
      ): Promise<IteratorResult<Record<string, any>>> => {
        if (settled.kind === "value")
          return Promise.resolve({ value: settled.value, done: false });
        // A finished stream stays finished for every later call.
        items.unshift(settled);
        return settled.kind === "error"
          ? Promise.reject(settled.error)
          : Promise.resolve({ value: undefined, done: true });
      };
      if (item) return settle(item);
      return new Promise<Item>((resolve) => waiters.push(resolve)).then(settle);
    },
    close,
  };
}
