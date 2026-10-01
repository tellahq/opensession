/**
 * The script host: the process that owns one script run (src/server/script-runs.ts)
 * so the run outlives the server that started it.
 *
 *   bun run src/script-host/main.ts <runDir>    (source)
 *   opensession script-host <runDir>            (compiled)
 *
 * The server launches it in its own transient user scope, outside the
 * server's cgroup, so stopping or restarting the server leaves it running.
 * It reads `<runDir>/spec.json`, runs the command in its own process group
 * with output appended to the log, and records how it ended in
 * `<runDir>/exit.json`. The server watches for that file, also after a
 * restart, so a run that finished while the server was down is still settled.
 *
 * Relays. A run that borrows a credential (keychain-runs.ts) gets one loopback
 * base URL per credential. The host answers that URL itself and forwards each
 * request over the run's relay socket to the server, which injects the
 * credential. The secret in the URL is checked by the server; the host never
 * sees a credential. While the server restarts the socket is gone, so the
 * host holds the request and retries until the server is back (up to
 * RELAY_WAIT_MS). A request cut off mid-flight is retried only when it is
 * safe to repeat (GET/HEAD); anything else is answered 502 so the script can
 * decide, since the call may already have reached the upstream.
 *
 * The host enforces the run's deadline itself, so a run cannot outlive it
 * just because the server was down when it passed.
 *
 * Kept dependency-free (node built-ins only): it must start fast and must not
 * pull the server graph into a long-lived process.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { open, rename, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ScriptHostSpec {
  id: string;
  command: string;
  cwd: string;
  logPath: string;
  /** Epoch ms after which the command is stopped. */
  deadline: number;
  /** The server's end of the relays. */
  relaySocket?: string;
  /** One per borrowed credential, in order. The secret for each is passed
   *  in the host's environment (RELAY_SECRETS_ENV), never written here. */
  relays?: Array<{ env: string[] }>;
}

export interface ScriptHostExit {
  code: number | null;
  signal: string | null;
  /** Set when the host ended the command itself. */
  reason?: "timed_out" | "stopped" | "failed";
  error?: string;
  endedAt: string;
}

/** Comma-separated base64url secrets, one per relay, in spec order. Removed
 *  from the command's environment. */
export const RELAY_SECRETS_ENV = "OPENSESSION_SCRIPT_RELAY_SECRETS";
/** Every variable with this prefix is the host's own and never reaches the
 *  command. */
const PRIVATE_ENV_PREFIX = "OPENSESSION_SCRIPT_";

export const EXIT_FILE = "exit.json";
export const SPEC_FILE = "spec.json";
export const HOST_FILE = "host.json";
/** The server answers with this header when it wants the request again
 *  later (it is starting up and has not reattached the run yet). */
export const RELAY_RETRY_HEADER = "x-opensession-relay-retry";
/** Which relay of the run a forwarded request came in on. */
export const RELAY_INDEX_HEADER = "x-opensession-relay";

const RELAY_WAIT_MS = 10 * 60_000;
const KILL_GRACE_MS = 10_000;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A connection that never reached the server: safe to try again. */
function notConnected(error: any): boolean {
  const code = String(error?.code ?? "");
  return (
    code === "FailedToOpenSocket" ||
    code === "ECONNREFUSED" ||
    code === "ENOENT" ||
    code === "ConnectionRefused"
  );
}

export async function runScriptHost(runDir: string): Promise<number> {
  // First, so a stop that arrives while the host is still starting is not
  // lost: the command then never starts.
  let child: ChildProcess | undefined;
  let reason: ScriptHostExit["reason"];
  let ending = false;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Already gone.
    }
  };
  const endChild = (why: NonNullable<ScriptHostExit["reason"]>) => {
    if (ending) return;
    ending = true;
    reason = why;
    signalGroup("SIGTERM");
    setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS).unref?.();
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.on(signal, () => endChild("stopped"));

  const spec = JSON.parse(
    await readFile(join(runDir, SPEC_FILE), "utf-8"),
  ) as ScriptHostSpec;
  const secrets = (process.env[RELAY_SECRETS_ENV] ?? "")
    .split(",")
    .filter(Boolean);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !name.startsWith(PRIVATE_ENV_PREFIX))
      env[name] = value;

  const socket = spec.relaySocket ?? "";
  const servers: Array<ReturnType<typeof Bun.serve>> = [];
  for (const [index, relay] of (spec.relays ?? []).entries()) {
    const secret = secrets[index];
    if (!secret) throw new Error(`relay ${index} has no secret`);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      // A slow upstream page must not be cut by Bun's idle timeout.
      idleTimeout: 0,
      fetch: (req) => forward(req, socket, index),
    });
    servers.push(server);
    for (const name of relay.env)
      env[name] = `http://127.0.0.1:${server.port}/${secret}`;
  }

  const log = await open(spec.logPath, "a", 0o600);
  if (ending) {
    for (const server of servers) server.stop(true);
    await log.close().catch(() => {});
    await writeExit(runDir, {
      code: null,
      signal: null,
      reason: reason ?? "stopped",
      endedAt: new Date().toISOString(),
    });
    return 0;
  }
  try {
    child = spawn(Bun.which("bash") ?? "/bin/sh", ["-c", spec.command], {
      cwd: spec.cwd,
      env: env as NodeJS.ProcessEnv,
      // Its own process group, so a stop reaches everything it started.
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
  } catch (error) {
    await writeExit(runDir, {
      code: null,
      signal: null,
      reason: "failed",
      error: error instanceof Error ? error.message : String(error),
      endedAt: new Date().toISOString(),
    });
    return 1;
  }

  const started = child;
  // Listen before anything else awaits: a quick command can exit while the
  // host file below is being written.
  const exited = new Promise<ScriptHostExit>((resolve) => {
    started.once("exit", (code, signal) =>
      resolve({
        code,
        signal,
        ...(reason ? { reason } : {}),
        endedAt: new Date().toISOString(),
      }),
    );
    started.once("error", (error) =>
      resolve({
        code: null,
        signal: null,
        reason: "failed",
        error: error.message,
        endedAt: new Date().toISOString(),
      }),
    );
  });
  const deadline = setTimeout(
    () => endChild("timed_out"),
    Math.max(0, spec.deadline - Date.now()),
  );

  await writeFile(
    join(runDir, HOST_FILE),
    JSON.stringify({ pid: process.pid, childPid: started.pid ?? null }),
    { mode: 0o600 },
  ).catch(() => {});

  const ended = await exited;
  clearTimeout(deadline);
  // Anything the command left in the background goes with it.
  signalGroup("SIGTERM");
  for (const server of servers) server.stop(true);
  await log.close().catch(() => {});
  await writeExit(runDir, ended);
  return 0;
}

async function writeExit(runDir: string, exit: ScriptHostExit): Promise<void> {
  const tmp = join(runDir, `${EXIT_FILE}.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(exit), { mode: 0o600 });
  await rename(tmp, join(runDir, EXIT_FILE));
}

async function forward(
  req: Request,
  socket: string,
  index: number,
): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  let body: ArrayBuffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    if (Number(req.headers.get("content-length") || 0) > MAX_REQUEST_BYTES)
      return Response.json(
        { error: "request body is too large" },
        { status: 413 },
      );
    body = await req.arrayBuffer();
    if (body.byteLength > MAX_REQUEST_BYTES)
      return Response.json(
        { error: "request body is too large" },
        { status: 413 },
      );
  }
  const headers = new Headers(req.headers);
  headers.set(RELAY_INDEX_HEADER, String(index));
  const until = Date.now() + RELAY_WAIT_MS;
  let delay = 250;
  for (;;) {
    try {
      const res = await fetch(`http://localhost${url.pathname}${url.search}`, {
        method,
        headers,
        body,
        redirect: "manual",
        unix: socket,
        // Bun would otherwise transparently decompress and leave a stale
        // content-encoding header for the script.
        decompress: false,
      } as RequestInit);
      if (res.headers.get(RELAY_RETRY_HEADER) && Date.now() < until) {
        await res.body?.cancel().catch(() => {});
      } else {
        return res;
      }
    } catch (error: any) {
      const repeatable = method === "GET" || method === "HEAD";
      if (!(notConnected(error) || repeatable) || Date.now() >= until)
        return Response.json(
          {
            error: notConnected(error)
              ? "Open Session did not come back in time to relay this request"
              : "the relay was interrupted (Open Session restarted); the request may or may not have reached the API",
          },
          { status: 502 },
        );
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 5_000);
  }
}

/** Process entry: `script-host <runDir>`. Exits when the command has. */
export function scriptHostMain(runDir: string | undefined): void {
  if (!runDir) {
    console.error("usage: script-host <runDir>");
    process.exit(2);
  }
  runScriptHost(runDir).then(
    (code) => process.exit(code),
    async (error) => {
      await writeExit(runDir, {
        code: null,
        signal: null,
        reason: "failed",
        error: error instanceof Error ? error.message : String(error),
        endedAt: new Date().toISOString(),
      }).catch(() => {});
      console.error("[script-host]", error);
      process.exit(1);
    },
  );
}

if (import.meta.main) scriptHostMain(process.argv[2]);
