#!/usr/bin/env bun
/**
 * Claude host service: runs the Claude Code processes for the pi Anthropic
 * provider's "remote" transport (pi.json `anthropicTransport`), so they live
 * outside the process that drives a session's turn.
 *
 *   bun packages/core/opensession-server/src/claude-host/main.ts
 *
 * Environment:
 *   OPENSESSION_CLAUDE_HOST_PORT         listen port (default 3847)
 *   OPENSESSION_CLAUDE_HOST_BIND         listen address (default 127.0.0.1)
 *   OPENSESSION_CLAUDE_HOST_MAX_QUERIES  running-query limit (default 48)
 *   OPENSESSION_CLAUDE_HOST_TOKEN_FILE   bearer token file (default: the
 *                                        instance's claude-host-token)
 *
 * It needs no model credential of its own: a client sends a placeholder and a
 * proxy address with each query (server/claude-token-proxy.ts).
 */

import { ensureClaudeHostToken } from "../server/claude-host-endpoint";
import {
  ensureClaudeQueryDirs,
  localClaudeQueryRuntime,
} from "../server/claude-query-runtime";
import { startLocalClaudeQuery } from "../server/claude-sdk-query";
import { CLAUDE_HOST_DEFAULT_PORT } from "./protocol";
import { startClaudeHostServer } from "./server";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function runClaudeHost(): Promise<void> {
  process.umask(0o077);
  const token = await ensureClaudeHostToken();
  const runtime = localClaudeQueryRuntime();
  const server = startClaudeHostServer({
    hostname: process.env.OPENSESSION_CLAUDE_HOST_BIND || "127.0.0.1",
    port: positiveInteger(
      process.env.OPENSESSION_CLAUDE_HOST_PORT,
      CLAUDE_HOST_DEFAULT_PORT,
    ),
    token,
    maxQueries: positiveInteger(
      process.env.OPENSESSION_CLAUDE_HOST_MAX_QUERIES,
      48,
    ),
    prepare: ensureClaudeQueryDirs,
    startQuery: (spec, io) => startLocalClaudeQuery(spec, io, runtime),
  });
  console.log(`[claude-host] listening on port ${server.port}`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log(
      `[claude-host] stopping with ${server.queries()} running queries`,
    );
    server.stop();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (import.meta.main) await runClaudeHost();
