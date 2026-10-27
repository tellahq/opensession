/**
 * The Sandbox agent: a small process inside a remote Sandbox that dials OUT
 * to Open Session and runs the commands and file writes the server sends it
 * (docs/self-hosting-sandboxes.md, "The Sandbox agent").
 *
 * It replaces a provider API round trip per tool call with one frame on a
 * socket the Sandbox opened itself, so a provider only has to start, stop,
 * and snapshot machines; nothing has to reach into the machine. It is
 * self-contained (no imports beyond Bun and node built-ins) because the
 * server copies this one file into the Sandbox on every launch.
 *
 * Credentials: the token arrives in a file that is read once and deleted, so
 * it is never on disk while the agent runs and never in a project snapshot.
 * Commands the agent starts never see it. A rejected token (the server
 * restarted, or the Sandbox was retired) ends the process: the server
 * launches a fresh agent with a fresh token when it next needs one, so a
 * stale agent never retries forever against the public ingress.
 */
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const SANDBOX_AGENT_PROTOCOL = 1;
/** Largest stdout one command returns (the tail is kept). */
export const AGENT_MAX_STDOUT_CHARS = 24 * 1024 * 1024;
export const AGENT_MAX_STDERR_CHARS = 512 * 1024;
const PING_INTERVAL_MS = 20_000;
/** No answer to a ping for this long means the socket is dead even though
 *  the operating system has not noticed yet. */
const PONG_DEADLINE_MS = 60_000;

/** Exponential backoff with a ceiling: 1s, 2s, 4s ... 30s. */
export function agentRetryDelayMs(failedAttempts: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, failedAttempts - 1));
}

/** Keep the end of a long output: the end is where a failure prints. */
export function keepTail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `[... ${text.length - max} characters omitted ...]\n${text.slice(-max)}`;
}

/** The environment a command gets: the agent's own minus its credential. */
export function commandEnv(
  base: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base))
    if (value !== undefined && !key.startsWith("OPENSESSION_SANDBOX_AGENT_"))
      env[key] = value;
  return env;
}

type Send = (frame: Record<string, unknown>) => void;

/** One timestamped line on stdout, which the launch sends to agent.log.
 *  Never a command, its output, or a credential. */
export function agentLog(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

/** A request's own environment on top of the agent's. Passed to spawn, never
 *  folded into the command line, so a token in it is not visible to anything
 *  that can list processes. */
export function frameEnv(
  base: Record<string, string>,
  extra: unknown,
): Record<string, string> {
  if (!extra || typeof extra !== "object") return base;
  const env = { ...base };
  for (const [key, value] of Object.entries(extra))
    if (
      typeof value === "string" &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
      !key.startsWith("OPENSESSION_SANDBOX_AGENT_")
    )
      env[key] = value;
  return env;
}

/** Run one shell script in its own process group, so a timeout reaches every
 *  process it started. Never throws. */
export async function runScript(
  script: string,
  timeoutMs: number,
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(["bash", "-c", script], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env,
      detached: true,
    });
  } catch (error) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
  let timedOut = false;
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    signalGroup("SIGTERM");
    setTimeout(() => signalGroup("SIGKILL"), 2_000).unref?.();
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text(),
    child.exited,
  ]).finally(() => clearTimeout(timer));
  return {
    exitCode: timedOut ? 124 : exitCode,
    stdout: keepTail(stdout, AGENT_MAX_STDOUT_CHARS),
    stderr:
      keepTail(stderr, AGENT_MAX_STDERR_CHARS) +
      (timedOut ? `\n[sandbox agent] command exceeded ${timeoutMs}ms` : ""),
  };
}

/** Start a long-lived process that outlives this request and this agent. */
export function spawnDetached(script: string, env: Record<string, string>) {
  const child = Bun.spawn(["bash", "-c", script], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env,
    detached: true,
  });
  child.unref();
}

/** Handle one request frame from the server. Unknown frames are ignored. */
export async function handleFrame(
  message: any,
  send: Send,
  env: Record<string, string> = commandEnv(process.env),
): Promise<void> {
  const id = typeof message?.id === "string" ? message.id : "";
  if (!id) return;
  try {
    if (message.t === "exec") {
      const script = typeof message.script === "string" ? message.script : "";
      const timeoutMs =
        Number.isFinite(message.timeoutMs) && message.timeoutMs > 0
          ? Number(message.timeoutMs)
          : 120_000;
      send({
        t: "result",
        id,
        ...(await runScript(script, timeoutMs, frameEnv(env, message.env))),
      });
    } else if (message.t === "spawn") {
      spawnDetached(String(message.script || ""), frameEnv(env, message.env));
      send({ t: "result", id, exitCode: 0, stdout: "", stderr: "" });
    } else if (message.t === "write") {
      const path = String(message.path || "");
      if (!path.startsWith("/"))
        throw new Error("write needs an absolute path");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(String(message.b64 || ""), "base64"));
      send({ t: "result", id, exitCode: 0, stdout: "", stderr: "" });
    }
  } catch (error) {
    send({
      t: "error",
      id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Ask the server whether this token is still current, without opening a
 *  socket: "valid", "rejected" (stop for good) or "unreachable" (retry). */
export async function probeToken(
  endpoint: string,
  token: string,
): Promise<"valid" | "rejected" | "unreachable"> {
  const url = new URL(endpoint);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.searchParams.set("probe", "1");
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 204) return "valid";
    if (response.status === 403 || response.status === 410) return "rejected";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

/** One connection: resolves true when it was open at some point. */
function connectOnce(endpoint: string, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    let socket: WebSocket;
    let opened = false;
    try {
      socket = new WebSocket(endpoint, {
        headers: { authorization: `Bearer ${token}` },
      } as any);
    } catch {
      resolve(false);
      return;
    }
    let lastPong = Date.now();
    const send: Send = (frame) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(frame));
    };
    const pinger = setInterval(() => {
      if (Date.now() - lastPong > PONG_DEADLINE_MS) {
        try {
          socket.close(4000, "no pong");
        } catch {}
        return;
      }
      send({ t: "ping", id: String(Date.now()) });
    }, PING_INTERVAL_MS);
    socket.addEventListener("open", () => {
      opened = true;
      agentLog("connected");
      lastPong = Date.now();
      send({
        t: "hello",
        protocol: SANDBOX_AGENT_PROTOCOL,
        pid: process.pid,
        platform: process.platform,
      });
    });
    socket.addEventListener("message", (event) => {
      let message: any;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message?.t === "pong") lastPong = Date.now();
      else if (message?.t === "shutdown") process.exit(0);
      else void handleFrame(message, send);
    });
    socket.addEventListener(
      "close",
      (event) => {
        clearInterval(pinger);
        if (opened) agentLog(`disconnected (${event.code})`);
        resolve(opened);
      },
      { once: true },
    );
    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {}
    });
  });
}

/** Connect, serve, and reconnect until the server rejects the token. */
export async function runSandboxAgent(
  endpoint: string,
  token: string,
): Promise<void> {
  let failed = 0;
  while (true) {
    const probe = await probeToken(endpoint, token);
    if (probe === "rejected") {
      agentLog("token rejected by the server; exiting");
      return;
    }
    if (probe === "unreachable") agentLog("server unreachable; retrying");
    if (probe === "valid") {
      const opened = await connectOnce(endpoint, token);
      failed = opened ? 0 : failed + 1;
    } else failed += 1;
    await Bun.sleep(agentRetryDelayMs(Math.max(1, failed)));
  }
}

if (import.meta.main) {
  const endpoint = process.env.OPENSESSION_SANDBOX_AGENT_URL || "";
  const tokenFile = process.env.OPENSESSION_SANDBOX_AGENT_TOKEN_FILE || "";
  let token = "";
  try {
    token = (await readFile(tokenFile, "utf8")).trim();
  } catch {}
  await unlink(tokenFile).catch(() => {});
  if (!endpoint || !token) {
    agentLog("no endpoint or token; exiting");
    process.exit(2);
  }
  agentLog(`started (pid ${process.pid}, protocol ${SANDBOX_AGENT_PROTOCOL})`);
  for (const key of Object.keys(process.env))
    if (key.startsWith("OPENSESSION_SANDBOX_AGENT_")) delete process.env[key];
  await runSandboxAgent(endpoint, token);
  process.exit(0);
}
