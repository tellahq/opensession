/**
 * Where and how this machine runs Claude Code for a passthrough query
 * (claude-sdk-query.ts): the binary, an empty working directory, one isolated
 * config directory per account, and the spawn wrapper that keeps the process
 * out of the control-plane cgroup.
 *
 * Shared by the in-process pi provider and the Claude host service, so a
 * conversation started by either finds the same SDK session files.
 */

import { mkdir } from "node:fs/promises";
import { configuredPaths } from "./config";
import { stateDir } from "./paths";
import { spawnClaudeCodeInWorkload } from "./workload-scope";
import type { ClaudeQueryRuntime } from "./claude-sdk-query";

/** Empty, dedicated cwd for the SDK subprocess: every tool is a passthrough
 *  the client executes, so no worktree must ever be visible to it. */
export const CLAUDE_QUERY_CWD = `${stateDir("anthropic-bridge")}/bridge-cwd`;

/** Per-account isolated SDK config dir, never the host's ~/.claude. */
export function claudeConfigDirFor(accountId: string): string {
  return `${stateDir("pi")}/claude-cfg/${accountId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/** Create the SDK cwd and the account's config dir off the event loop. */
export async function ensureClaudeQueryDirs(accountId: string): Promise<void> {
  await Promise.all([
    mkdir(CLAUDE_QUERY_CWD, { recursive: true }),
    mkdir(claudeConfigDirFor(accountId), { recursive: true }),
  ]);
}

export function localClaudeQueryRuntime(): ClaudeQueryRuntime {
  return {
    claudeBin: configuredPaths().claudeBin,
    cwd: CLAUDE_QUERY_CWD,
    configDir: claudeConfigDirFor,
    spawn: spawnClaudeCodeInWorkload("model"),
  };
}
