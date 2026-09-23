/**
 * workspace-rpc — the server half of remote workspaces (remote-workspace.ts).
 *
 * A Sandbox session's run host (on this machine) sends every file and shell
 * operation here over the run-rpc socket, authenticated by the run's bearer.
 * The token names a session; the session's own record names its Sandbox.
 * Nothing in the request can point at another machine: a session without a
 * recorded Sandbox is refused, never run on this host.
 *
 * Each run keeps one Sandbox handle, so a burst of tool calls does not repeat
 * the provider's wake check and keepalive on every command (the handle
 * re-checks at most once a minute; see makeRemoteSandbox).
 */

import { findSessionAsync } from "../session-cache";
import { getSandboxProvider } from "./index";
import { isRemoteSandboxProvider } from "./config";
import type { Sandbox } from "./provider";
import {
  remoteGuestOsForProvider,
  remoteLayoutForProvider,
} from "./adapters/bootstrap";
import type { RemoteWorkspaceSpec } from "../../runner-host/protocol";
import { sandboxSessionScratchDir } from "../session-scratch";

/**
 * The remote workspace a run acting on this session's checkout must use, or
 * undefined for a session whose checkout is on this machine. `cwd` is the
 * checkout path the run was given; it is the Sandbox's own path for a
 * Sandbox session (its recorded worktreeDir).
 */
export function remoteWorkspaceForSession(
  session: {
    id: string;
    repo?: string | null;
    sandbox?: { provider?: string; sandboxId?: string };
  },
  cwd: string,
): RemoteWorkspaceSpec | undefined {
  const provider = session.sandbox?.provider;
  if (!isRemoteSandboxProvider(provider)) return undefined;
  return {
    provider,
    sandboxId: session.sandbox?.sandboxId || "",
    cwd,
    scratchDir: sandboxSessionScratchDir(session.id, provider),
    os: remoteGuestOsForProvider(provider),
    repo: session.repo || undefined,
  };
}

/** Largest stdout a command may return (a `read` of an 8 MiB file is ~11 MiB
 *  of base64). Beyond it the reply keeps the tail. */
const MAX_STDOUT_CHARS = 16 * 1024 * 1024;
const MAX_STDERR_CHARS = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 20 * 60_000;
/** How long a run's resolved Sandbox is reused before the session record is
 *  read again. A move cannot happen while a turn runs, so this only bounds
 *  how long a finished run's entry lives. */
const HANDLE_TTL_MS = 10 * 60_000;

type CachedHandle = {
  key: string;
  sandbox: Promise<Sandbox>;
  at: number;
};

function handles(): Map<string, CachedHandle> {
  const g = globalThis as typeof globalThis & {
    __opensessionWorkspaceRpcHandles?: Map<string, CachedHandle>;
  };
  return (g.__opensessionWorkspaceRpcHandles ??= new Map());
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, item] of Object.entries(value as Record<string, unknown>))
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof item === "string")
      out[key] = item;
  return out;
}

function primed(): Map<string, Sandbox> {
  const g = globalThis as typeof globalThis & {
    __opensessionWorkspaceRpcPrimed?: Map<string, Sandbox>;
  };
  return (g.__opensessionWorkspaceRpcPrimed ??= new Map());
}

/**
 * The launch hands over the handle it just prepared for the session's turn,
 * so the turn's first tool call neither waits on nor races the session
 * record write. Replaced by the next launch; a restarted server resolves
 * from the record instead.
 */
export function primeWorkspaceSandbox(
  sessionId: string,
  sandbox: Sandbox,
): void {
  primed().set(sessionId, sandbox);
}

async function sandboxForRun(
  token: string,
  sessionId: string,
): Promise<Sandbox> {
  const now = Date.now();
  const cache = handles();
  for (const [key, entry] of cache)
    if (now - entry.at > HANDLE_TTL_MS) cache.delete(key);
  const cached = cache.get(token);
  if (cached) return cached.sandbox;
  const launched = primed().get(sessionId);
  if (launched) {
    const entry: CachedHandle = {
      key: `${launched.provider}:${launched.id}`,
      sandbox: Promise.resolve(launched),
      at: now,
    };
    cache.set(token, entry);
    return entry.sandbox;
  }
  const session = await findSessionAsync(sessionId);
  const record = session?.sandbox;
  if (!record?.sandboxId || !isRemoteSandboxProvider(record.provider))
    throw new Error("this session has no Sandbox workspace");
  const provider = record.provider;
  const sandboxId = record.sandboxId;
  const sandbox = getSandboxProvider(provider)
    .get(sandboxId)
    .then((handle) => {
      if (!handle)
        throw new Error(
          `the Sandbox ${sandboxId} is gone; send the prompt again to prepare a new one`,
        );
      return handle;
    });
  const entry: CachedHandle = {
    key: `${provider}:${sandboxId}`,
    sandbox,
    at: now,
  };
  cache.set(token, entry);
  sandbox.catch(() => {
    if (cache.get(token) === entry) cache.delete(token);
  });
  return sandbox;
}

/** Forget every handle for a machine being retired (session-sandbox.ts
 *  teardownSandbox): a run that still holds a token gets an error, not the
 *  machine. */
export function forgetWorkspaceSandbox(sandboxId: string): void {
  for (const [sessionId, sandbox] of primed())
    if (sandbox.id === sandboxId) primed().delete(sessionId);
  for (const [token, entry] of handles())
    if (entry.key.endsWith(`:${sandboxId}`)) handles().delete(token);
}

/** Drop a run's cached handle (its token was unregistered). */
export function forgetWorkspaceRun(token: string | undefined): void {
  if (token) handles().delete(token);
}

/**
 * Run one script in the run's Sandbox. Answers `{exitCode, stdout, stderr}`
 * or `{error}`; never throws.
 */
export async function dispatchWorkspaceExec(
  ctx: { sessionId: string },
  token: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const script = typeof body.script === "string" ? body.script : "";
  if (!script) return { error: "workspace exec needs a script" };
  const cwd =
    typeof body.cwd === "string" && body.cwd.startsWith("/") ? body.cwd : "/";
  const requested = Number(body.timeoutMs);
  const timeoutMs =
    Number.isFinite(requested) && requested > 0
      ? Math.min(requested, MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
  let sandbox: Sandbox;
  try {
    sandbox = await sandboxForRun(token, ctx.sessionId);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const layout = remoteLayoutForProvider(sandbox.provider);
  try {
    const result = await sandbox.exec(
      [
        "bash",
        "-c",
        'cd -- "$OS_CWD" 2>/dev/null || { echo "No such directory in the Sandbox: $OS_CWD" >&2; exit 125; }\n' +
          script,
      ],
      {
        // The guest's own PATH and HOME (bun, the identity command, the
        // pinned tools), which a command from this server cannot know.
        env: {
          PATH: layout.path,
          HOME: layout.home,
          ...stringRecord(body.env),
          OS_CWD: cwd,
        },
        timeoutMs,
        assumeStarted: true,
        // One lease per shell command, none per file operation: leases are
        // bounded, and a burst of reads must not evict a Portal's.
        workloadIdentity: body.identity === true,
      },
    );
    return {
      exitCode: result.exitCode,
      stdout:
        result.stdout.length > MAX_STDOUT_CHARS
          ? result.stdout.slice(-MAX_STDOUT_CHARS)
          : result.stdout,
      stderr:
        result.stderr.length > MAX_STDERR_CHARS
          ? result.stderr.slice(-MAX_STDERR_CHARS)
          : result.stderr,
    };
  } catch (error) {
    // A handle whose machine went away is re-resolved on the next call.
    forgetWorkspaceRun(token);
    return {
      error: `the Sandbox did not run the command: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
