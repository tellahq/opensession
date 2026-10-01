/**
 * Where a session's script run (script-runs.ts) may start, and the
 * environment it gets. Shared by start_script and run_with_credential.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { findSession } from "./session-cache";
import { hostSessionScratchDir } from "./session-scratch";
import type { UnifiedSession } from "./types";

export type ScriptSessionLookup = (
  sessionId: string,
) =>
  | Partial<Pick<UnifiedSession, "worktreeDir" | "sandbox" | "runner">>
  | undefined;

/** The directory a run starts in, or why it can't start. Script hosts run on
 *  this server's machine, so the workspace must be here too. */
export function scriptWorkspace(
  sessionId: string,
  cwd: string | undefined,
  lookup: ScriptSessionLookup = findSession,
): { cwd: string } | { error: string } {
  const session = lookup(sessionId);
  if (session?.sandbox || session?.runner)
    return {
      error:
        "scripts start on this server, and this session's workspace is in a Sandbox or on a Runner",
    };
  const root = session?.worktreeDir;
  if (cwd && isAbsolute(cwd)) return { cwd };
  if (!root)
    return {
      error: "this session has no workspace here; pass an absolute cwd",
    };
  return { cwd: cwd ? resolve(root, cwd) : root };
}

/** The run's whole environment: no server tokens, only the basics. */
export function scriptEnv(sessionId: string): Record<string, string> {
  const scratch = hostSessionScratchDir(sessionId);
  const env: Record<string, string> = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME || homedir(),
    LANG: process.env.LANG || "C.UTF-8",
    TERM: "dumb",
    TMPDIR: scratch,
    OPENSESSION_SCRATCH: scratch,
  };
  for (const name of ["USER", "LOGNAME", "SHELL"])
    if (process.env[name]) env[name] = process.env[name]!;
  return env;
}

/** Where a session's script logs go: its scratch dir, which its agent can
 *  read. */
export function scriptLogDir(sessionId: string): string {
  return join(hostSessionScratchDir(sessionId), "scripts");
}
