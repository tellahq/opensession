import type {
  ExecutorHostStatus,
  ExecutorRequest,
  ExecutorResponse,
} from "@tellahq/opensession-protocol/executor";
import {
  EXECUTOR_PROTOCOL_MIN_VERSION,
  EXECUTOR_PROTOCOL_VERSION,
  executorSocketPath,
} from "@tellahq/opensession-protocol/executor";
import { existsSync, readFileSync } from "fs";
import type { RunHostMeta } from "../runner-host/protocol";
import { HOST_META_NAME, HOST_SOCK_NAME } from "../runner-host/protocol";
import { OPENSESSION_SESSIONS_DIR } from "./paths";
import { readExecutorCredential } from "../executor/auth";
import { sameProcess } from "./process-identity";

interface ExecutorClientStats {
  delegatedLaunches: number;
  fallbackLaunches: number;
  lastContactAt?: string;
  lastError?: string;
  protocolVersion?: number;
}

const stats: ExecutorClientStats = ((
  globalThis as any
).__executorClientStats ??= {
  delegatedLaunches: 0,
  fallbackLaunches: 0,
});

export class ExecutorProtocolError extends Error {
  constructor(
    message: string,
    readonly ambiguousLaunch = false,
  ) {
    super(message);
  }
}

export function executorClientHealth(): Record<string, unknown> {
  const socketPath = executorSocketPath(OPENSESSION_SESSIONS_DIR);
  return {
    socketPresent: existsSync(socketPath),
    configured: process.env.OPENSESSION_EXECUTOR !== "0",
    ...stats,
  };
}

let readinessCache: { at: number; ready: boolean; error?: string } | undefined;
let readinessRefresh: Promise<{ ready: boolean; error?: string }> | undefined;

function refreshExecutorReadiness(): Promise<{
  ready: boolean;
  error?: string;
}> {
  if (!readinessRefresh) {
    readinessRefresh = (async () => {
      const socketPath = executorSocketPath(OPENSESSION_SESSIONS_DIR);
      const token = readExecutorCredential();
      if (!existsSync(socketPath) || !token) {
        readinessCache = {
          at: Date.now(),
          ready: false,
          error: "executor socket or credential is unavailable",
        };
        return readinessCache;
      }
      const requestId = crypto.randomUUID();
      try {
        const response = await requestExecutor(
          socketPath,
          {
            t: "hello",
            requestId,
            token,
            minVersion: EXECUTOR_PROTOCOL_MIN_VERSION,
            maxVersion: EXECUTOR_PROTOCOL_VERSION,
          },
          2_000,
        );
        const ready = response.ok && response.compatible === true;
        readinessCache = {
          at: Date.now(),
          ready,
          ...(ready ? {} : { error: "executor protocol is incompatible" }),
        };
      } catch (cause) {
        readinessCache = { at: Date.now(), ready: false, error: String(cause) };
      }
      return readinessCache;
    })().finally(() => {
      readinessRefresh = undefined;
    });
  }
  return readinessRefresh;
}

/** Readiness probes report executor degradation but never wait on its IPC
 * lane. The executor still fails closed at launchHostViaExecutor(). */
export function executorClientReadinessSnapshot(): {
  ready: boolean;
  error?: string;
} {
  if (process.env.OPENSESSION_EXECUTOR === "0") return { ready: true };
  if (!readinessCache || Date.now() - readinessCache.at >= 2_000)
    void refreshExecutorReadiness();
  return (
    readinessCache ?? { ready: false, error: "executor readiness is pending" }
  );
}

export async function executorClientReady(): Promise<{
  ready: boolean;
  error?: string;
}> {
  if (process.env.OPENSESSION_EXECUTOR === "0") return { ready: true };
  if (readinessCache && Date.now() - readinessCache.at < 2_000)
    return readinessCache;
  return refreshExecutorReadiness();
}

export function noteExecutorFallback(): void {
  stats.fallbackLaunches++;
}

/**
 * Ask the independently restartable executor to launch the already-persisted
 * local run host. False means the executor was unavailable before any
 * side-effecting request was sent. Direct launch is available only when the
 * operator explicitly sets OPENSESSION_EXECUTOR=0; an unavailable configured
 * executor fails closed.
 */
export async function launchHostViaExecutor(
  hostId: string,
  dir: string,
  options?: { socketPath?: string; token?: string; specHash?: string },
): Promise<boolean> {
  if (process.env.OPENSESSION_EXECUTOR === "0") return false;
  const socketPath =
    options?.socketPath ?? executorSocketPath(OPENSESSION_SESSIONS_DIR);
  if (!existsSync(socketPath))
    throw new ExecutorProtocolError(
      `executor socket is unavailable: ${socketPath}`,
    );
  const token = options?.token ?? readExecutorCredential();
  if (!token)
    throw new ExecutorProtocolError("executor credential is unavailable");

  let hello: ExecutorResponse;
  const helloRequestId = crypto.randomUUID();
  try {
    hello = await requestExecutor(socketPath, {
      t: "hello",
      requestId: helloRequestId,
      token,
      minVersion: EXECUTOR_PROTOCOL_MIN_VERSION,
      maxVersion: EXECUTOR_PROTOCOL_VERSION,
    });
  } catch (cause) {
    stats.lastError = String(cause);
    throw new ExecutorProtocolError(
      `executor handshake failed: ${String(cause)}`,
    );
  }
  const negotiated = assertResponse(
    hello,
    helloRequestId,
    "executor handshake failed",
  );
  if (!hello.ok || !hello.compatible || negotiated) {
    // Hello never carries a host status. A status here means a malformed peer.
    throw new ExecutorProtocolError(
      "executor handshake returned an invalid shape",
    );
  }
  const version = hello.version;
  stats.protocolVersion = version;
  stats.lastContactAt = new Date().toISOString();

  const specHash =
    options?.specHash ??
    new Bun.CryptoHasher("sha256")
      .update(readFileSync(`${dir}/spec.json`))
      .digest("hex");
  let launched: ExecutorResponse;
  const launchRequestId = crypto.randomUUID();
  const launchDeadline = Date.now() + 30_000;
  for (;;) {
    try {
      launched = await requestExecutor(
        socketPath,
        {
          t: "launch_host",
          requestId: launchRequestId,
          token,
          version,
          hostId,
          specHash,
        },
        Math.max(1_000, launchDeadline - Date.now()),
      );
    } catch (cause) {
      if (cause instanceof ExecutorTransportError && !cause.sent)
        throw new ExecutorProtocolError(
          `executor launch transport failed: ${String(cause)}`,
        );
      return reconcileLaunch({
        socketPath,
        token,
        version,
        hostId,
        specHash,
        dir,
      });
    }
    if (
      launched.ok ||
      launched.code !== "executor_busy" ||
      Date.now() >= launchDeadline
    )
      break;
    await Bun.sleep(250);
  }
  const status = assertResponse(
    launched,
    launchRequestId,
    "executor launch failed",
    true,
  );
  if (
    !status?.ready ||
    status.hostId !== hostId ||
    status.specHash !== specHash
  ) {
    throw new ExecutorProtocolError(
      `executor returned a non-ready launch for ${hostId}`,
      true,
    );
  }
  noteDelegatedLaunch();
  return true;
}

export async function waitForLocalHost(
  dir: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(`${dir}/${HOST_SOCK_NAME}`)) {
      try {
        const meta = JSON.parse(
          readFileSync(`${dir}/${HOST_META_NAME}`, "utf8"),
        ) as RunHostMeta;
        const matches = sameProcess(meta);
        if (matches !== undefined) return matches;
        process.kill(meta.pid, 0);
        return true;
      } catch {}
    }
    await Bun.sleep(100);
  }
  return false;
}

function assertResponse(
  response: ExecutorResponse,
  requestId: string,
  prefix: string,
  sideEffectPossible = false,
): ExecutorHostStatus | undefined {
  if (
    !response ||
    response.requestId !== requestId ||
    typeof response.ok !== "boolean"
  ) {
    throw new ExecutorProtocolError(
      `${prefix}: malformed or mismatched response`,
      sideEffectPossible,
    );
  }
  if (!response.ok) {
    stats.lastError = `${response.code}: ${response.error}`;
    throw new ExecutorProtocolError(
      `${prefix}: ${stats.lastError}`,
      response.code === "launch_uncertain",
    );
  }
  if (
    !Number.isInteger(response.version) ||
    response.version < EXECUTOR_PROTOCOL_MIN_VERSION ||
    response.version > EXECUTOR_PROTOCOL_VERSION
  ) {
    stats.lastError = `unsupported executor protocol ${response.version}`;
    throw new ExecutorProtocolError(
      `${prefix}: ${stats.lastError}`,
      sideEffectPossible,
    );
  }
  if (
    response.status !== undefined &&
    (typeof response.status !== "object" ||
      typeof response.status.hostId !== "string" ||
      typeof response.status.ready !== "boolean" ||
      typeof response.status.state !== "string")
  ) {
    throw new ExecutorProtocolError(
      `${prefix}: malformed host status`,
      sideEffectPossible,
    );
  }
  return response.status;
}

async function reconcileLaunch(input: {
  socketPath: string;
  token: string;
  version: number;
  hostId: string;
  specHash: string;
  dir: string;
}): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await waitForLocalHost(input.dir, 250)) {
      noteDelegatedLaunch();
      return true;
    }
    if (existsSync(input.socketPath)) {
      const requestId = crypto.randomUUID();
      try {
        const response = await requestExecutor(
          input.socketPath,
          {
            t: "launch_host",
            requestId,
            token: input.token,
            version: input.version,
            hostId: input.hostId,
            specHash: input.specHash,
          },
          25_000,
        );
        const status = assertResponse(
          response,
          requestId,
          "executor launch reconciliation failed",
          true,
        );
        if (status?.ready && status.specHash === input.specHash) {
          noteDelegatedLaunch();
          return true;
        }
        if (status?.state === "failed" || status?.state === "stopped") {
          throw new ExecutorLaunchSettledError(
            `executor launch settled as ${status.state}: ${status.error || "unknown error"}`,
          );
        }
      } catch (cause) {
        if (cause instanceof ExecutorLaunchSettledError) throw cause;
        if (cause instanceof ExecutorProtocolError && !cause.ambiguousLaunch) {
          throw cause;
        }
      }
    }
    await Bun.sleep(250);
  }
  stats.lastError = "executor launch remained uncertain after reconciliation";
  throw new ExecutorProtocolError(stats.lastError, true);
}

function noteDelegatedLaunch(): void {
  stats.delegatedLaunches++;
  stats.lastContactAt = new Date().toISOString();
  stats.lastError = undefined;
}

class ExecutorLaunchSettledError extends ExecutorProtocolError {}

class ExecutorTransportError extends Error {
  constructor(
    message: string,
    readonly sent: boolean,
  ) {
    super(message);
  }
}

function requestExecutor(
  socketPath: string,
  request: ExecutorRequest,
  timeoutMs = 5_000,
): Promise<ExecutorResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    let socket: any;
    let sent = false;
    const finish = (result: ExecutorResponse | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.end();
      } catch {}
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish(
          new ExecutorTransportError(
            `executor request timed out after ${timeoutMs}ms`,
            sent,
          ),
        ),
      timeoutMs,
    );
    Bun.connect({
      unix: socketPath,
      socket: {
        open(s) {
          socket = s;
          const line = `${JSON.stringify(request)}\n`;
          const written = s.write(line);
          sent = written > 0;
          if (written < line.length) {
            finish(
              new ExecutorTransportError(
                "executor request write was partial",
                sent,
              ),
            );
          }
        },
        data(_s, chunk) {
          buffer += Buffer.from(chunk).toString("utf8");
          if (Buffer.byteLength(buffer) > 1024 * 1024) {
            finish(
              new ExecutorTransportError(
                "executor response exceeded 1 MB",
                sent,
              ),
            );
            return;
          }
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          try {
            finish(JSON.parse(buffer.slice(0, newline)) as ExecutorResponse);
          } catch (cause) {
            finish(
              new ExecutorTransportError(
                `invalid executor response: ${String(cause)}`,
                sent,
              ),
            );
          }
        },
        close() {
          if (!settled) {
            finish(
              new ExecutorTransportError(
                "executor closed without a response",
                sent,
              ),
            );
          }
        },
        error(_s, cause) {
          if (!settled) finish(new ExecutorTransportError(String(cause), sent));
        },
        connectError(_s, cause) {
          finish(new ExecutorTransportError(String(cause), sent));
        },
      },
    }).catch((cause) =>
      finish(new ExecutorTransportError(String(cause), sent)),
    );
  });
}
