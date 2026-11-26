/**
 * The Claude host: runs Claude Agent SDK queries on behalf of clients that
 * reach it over a message channel (protocol.ts).
 *
 * This module is the transport-free core. `createClaudeHostConnection` turns
 * one channel into a set of running queries: it starts a query per `start`
 * frame, relays its SDK messages and client tool calls to the client, feeds
 * it the client's input and tool results, and ends every query the client
 * still has when the channel closes. A query never outlives its channel, so a
 * client that disappears cannot leave a Claude Code process running.
 *
 * It holds no account pool and decides nothing about a conversation: which
 * account, what to resume, and when to stop are the client's calls.
 */

import {
  ClaudeInputQueue,
  type ClaudeQueryHandle,
  type ClaudeQueryIo,
  type ClaudeQuerySpec,
  type ClaudeToolReply,
} from "../server/claude-sdk-query";
import {
  CLAUDE_HOST_PROTOCOL,
  filterClaudeHostEnv,
  parseClaudeHostClientFrame,
  type ClaudeHostServerFrame,
} from "./protocol";

export interface ClaudeHostChannel {
  send(frame: ClaudeHostServerFrame): void;
}

export interface ClaudeHostOptions {
  /** Start one query. Called after `prepare` for the spec's account. */
  startQuery: (spec: ClaudeQuerySpec, io: ClaudeQueryIo) => ClaudeQueryHandle;
  /** Create whatever the account's queries need on disk before the first. */
  prepare?: (accountId: string) => Promise<void>;
  /** Queries running across every connection of this host. */
  running: Set<object>;
  /** Refuse a new query once this many are running. */
  maxQueries: number;
}

export interface ClaudeHostConnection {
  /** Handle one text frame from the client. */
  receive(raw: string): void;
  /** The channel closed: end every query it started. */
  close(): void;
}

interface RunningQuery {
  input: ClaudeInputQueue;
  controller: AbortController;
  toolWaiters: Map<string, (reply: ClaudeToolReply) => void>;
  handle?: ClaudeQueryHandle;
  inputEnded: boolean;
  closed: boolean;
}

const CLOSED_TOOL_REPLY: ClaudeToolReply = {
  content: [{ type: "text", text: "The Claude host closed this tool turn" }],
  isError: true,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createClaudeHostConnection(
  channel: ClaudeHostChannel,
  options: ClaudeHostOptions,
): ClaudeHostConnection {
  const queries = new Map<string, RunningQuery>();
  let connected = true;
  const send = (frame: ClaudeHostServerFrame) => {
    if (connected) channel.send(frame);
  };

  const end = (id: string, running: RunningQuery) => {
    if (running.closed) return;
    running.closed = true;
    if (queries.get(id) === running) queries.delete(id);
    options.running.delete(running);
    for (const resolve of running.toolWaiters.values())
      resolve(CLOSED_TOOL_REPLY);
    running.toolWaiters.clear();
    running.input.close();
    running.controller.abort();
    try {
      running.handle?.close();
    } catch {
      // The process is already gone.
    }
  };

  const run = async (id: string, spec: ClaudeQuerySpec, q: RunningQuery) => {
    try {
      await options.prepare?.(spec.accountId);
      if (q.closed) return;
      q.handle = options.startQuery(
        { ...spec, env: filterClaudeHostEnv(spec.env) },
        {
          prompt: q.input,
          abortController: q.controller,
          onToolCall: (toolUseId) => {
            if (q.closed) return Promise.resolve(CLOSED_TOOL_REPLY);
            return new Promise((resolve) => {
              q.toolWaiters.set(toolUseId, resolve);
              send({ t: "tool_call", id, toolUseId });
            });
          },
        },
      );
      for (;;) {
        const next = await q.handle.next();
        if (q.closed) return;
        if (next.done) break;
        send({ t: "message", id, message: next.value });
      }
      send({ t: "end", id });
    } catch (error) {
      if (!q.closed) send({ t: "error", id, message: errorMessage(error) });
    } finally {
      end(id, q);
    }
  };

  send({ t: "ready", protocol: CLAUDE_HOST_PROTOCOL });

  return {
    receive(raw) {
      const frame = parseClaudeHostClientFrame(raw);
      if (!frame) return;
      if (frame.t === "start") {
        if (queries.has(frame.id)) {
          send({
            t: "error",
            id: frame.id,
            message: "A query with this id is already running",
          });
          return;
        }
        if (options.running.size >= options.maxQueries) {
          send({
            t: "error",
            id: frame.id,
            message: `The Claude host is at its limit of ${options.maxQueries} running queries`,
          });
          return;
        }
        const running: RunningQuery = {
          input: new ClaudeInputQueue(),
          controller: new AbortController(),
          toolWaiters: new Map(),
          inputEnded: false,
          closed: false,
        };
        queries.set(frame.id, running);
        options.running.add(running);
        void run(frame.id, frame.spec, running);
        return;
      }
      const running = queries.get(frame.id);
      if (!running) return;
      switch (frame.t) {
        case "input":
          // Input after `input_end` has nowhere to go; drop it.
          if (!running.inputEnded) running.input.push(frame.message);
          return;
        case "input_end":
          running.inputEnded = true;
          running.input.close();
          return;
        case "tool_result": {
          const resolve = running.toolWaiters.get(frame.toolUseId);
          if (!resolve) return;
          running.toolWaiters.delete(frame.toolUseId);
          resolve(frame.reply);
          return;
        }
        case "close":
          end(frame.id, running);
          return;
      }
    },
    close() {
      connected = false;
      for (const [id, running] of [...queries]) end(id, running);
    },
  };
}
