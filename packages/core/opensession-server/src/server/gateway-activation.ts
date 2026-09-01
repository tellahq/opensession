import { mkdirSync, readFileSync } from "fs";
import { dirname } from "path";

/**
 * Fail-closed preload barrier for a future supervised gateway handoff.
 *
 * A standby process may parse and statically import the gateway graph, but it
 * must stop here before touching the shared state namespace, binding a socket,
 * starting a Worker/timer, or contacting an integration. Only the parent IPC
 * channel that launched it can release the barrier, using the exact nonce.
 */
export type GatewayRole = "active" | "standby";

export type GatewayActivationMessage = {
  type: "opensession_gateway_activate";
  nonce: string;
};

export type GatewayPreloadedMessage = {
  type: "opensession_gateway_preloaded";
  nonce: string;
  pid: number;
};

type GatewayLeaseProcess = {
  stdin: { end(): void };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
};

type ProcessPort = {
  pid: number;
  send?: (message: GatewayPreloadedMessage) => boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  removeListener(
    event: "message",
    listener: (message: unknown) => void,
  ): unknown;
};

type GatewayEnvironment = Record<string, string | undefined>;

export function gatewayRole(
  env: GatewayEnvironment = process.env,
): GatewayRole {
  const value = env.OPENSESSION_GATEWAY_ROLE?.trim() || "active";
  if (value !== "active" && value !== "standby") {
    throw new Error(`Invalid OPENSESSION_GATEWAY_ROLE: ${value}`);
  }
  return value;
}

function activationMessage(value: unknown): GatewayActivationMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Partial<GatewayActivationMessage>;
  return message.type === "opensession_gateway_activate" &&
    typeof message.nonce === "string"
    ? (message as GatewayActivationMessage)
    : null;
}

async function readBoundedLine(
  stream: ReadableStream<Uint8Array>,
  maxBytes = 128,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let value = "";
  try {
    while (value.length <= maxBytes) {
      const chunk = await reader.read();
      if (chunk.done) return value;
      value += decoder.decode(chunk.value, { stream: true });
      const newline = value.indexOf("\n");
      if (newline !== -1) return value.slice(0, newline + 1);
    }
    throw new Error("Gateway activation lease response exceeded its bound");
  } finally {
    reader.releaseLock();
  }
}

export async function acquireGatewayActivationLease(
  options: {
    env?: GatewayEnvironment;
    platform?: NodeJS.Platform;
    spawn?: (command: string[]) => GatewayLeaseProcess;
    exit?: (code: number) => never;
  } = {},
): Promise<{ release(): Promise<void> }> {
  const env = options.env ?? process.env;
  const state =
    env.OPENSESSION_DEPLOY_STATE || `${env.HOME || ""}/.opensession/deploy`;
  const lockPath =
    env.OPENSESSION_GATEWAY_LEASE || `${state}/gateway-active.lock`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const waitSeconds = env.OPENSESSION_GATEWAY_LEASE_WAIT_SECS || "5";
  if (!/^\d+$/.test(waitSeconds)) {
    throw new Error("Invalid OPENSESSION_GATEWAY_LEASE_WAIT_SECS");
  }
  const spawn =
    options.spawn ??
    ((command: string[]) =>
      Bun.spawn(command, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }) as GatewayLeaseProcess);
  const holdCommand = ["/bin/sh", "-c", "printf 'LOCKED\\n'; cat >/dev/null"];
  const leaseCommand =
    (options.platform ?? process.platform) === "darwin"
      ? ["/usr/bin/lockf", "-k", "-t", waitSeconds, lockPath, ...holdCommand]
      : ["flock", "-w", waitSeconds, lockPath, ...holdCommand];
  const lease = spawn(leaseCommand);
  const first = await readBoundedLine(lease.stdout);
  if (first !== "LOCKED\n") {
    const error = await new Response(lease.stderr).text();
    await lease.exited;
    throw new Error(
      `Gateway activation lease is already held${error.trim() ? `: ${error.trim()}` : ""}`,
    );
  }

  let releasing = false;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  void lease.exited.then((code) => {
    if (!releasing) {
      console.error(
        `[gateway-activation] ownership lease exited unexpectedly (${code})`,
      );
      exit(70);
    }
  });
  return {
    async release() {
      if (releasing) return;
      releasing = true;
      lease.stdin.end();
      await lease.exited;
    },
  };
}

export async function waitForRuntimePeerGeneration(
  options: {
    env?: GatewayEnvironment;
    fetchReady?: (url: string) => Promise<Response>;
    readReadyFile?: (path: string) => string;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const fallback = (
    env.OPENSESSION_PEER_GENERATION ?? env.OPENSESSION_RELEASE_GENERATION
  )?.trim();
  const expectedKernel = (
    env.OPENSESSION_KERNEL_GENERATION ?? fallback
  )?.trim();
  const expectedExecutor = (
    env.OPENSESSION_EXECUTOR_GENERATION ?? fallback
  )?.trim();
  if (
    (!expectedKernel || expectedKernel === "development") &&
    (!expectedExecutor || expectedExecutor === "development")
  )
    return;
  for (const expected of [expectedKernel, expectedExecutor]) {
    if (!expected || !/^[0-9a-f]{40,64}$/.test(expected)) {
      throw new Error("Invalid runtime peer generation");
    }
  }
  const fetchReady =
    options.fetchReady ??
    ((url: string) => fetch(url, { signal: AbortSignal.timeout(1_000) }));
  const readReadyFile =
    options.readReadyFile ?? ((path: string) => readFileSync(path, "utf8"));
  const sleep = options.sleep ?? Bun.sleep;
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const kernelUrl = new URL(
    "/ready",
    env.OPENSESSION_SESSION_KERNEL_URL ?? "http://127.0.0.1:3849",
  ).toString();
  const executorReadyFile =
    env.OPENSESSION_EXECUTOR_READY_FILE ?? "/run/opensession-executor/ready";

  while (Date.now() < deadline) {
    try {
      const [kernel, executorText] = await Promise.all([
        fetchReady(kernelUrl).then(async (response) =>
          response.ok
            ? ((await response.json()) as { generation?: string })
            : null,
        ),
        Promise.resolve().then(() => readReadyFile(executorReadyFile)),
      ]);
      const executor = JSON.parse(executorText) as { generation?: string };
      if (
        kernel?.generation === expectedKernel &&
        executor.generation === expectedExecutor
      )
        return;
    } catch {}
    await sleep(100);
  }
  throw new Error(
    `Runtime peers did not reach kernel ${expectedKernel!.slice(0, 10)} / ` +
      `executor ${expectedExecutor!.slice(0, 10)}`,
  );
}

export async function waitForGatewayActivationIfStandby(
  options: {
    env?: GatewayEnvironment;
    processPort?: ProcessPort;
  } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  if (gatewayRole(env) === "active") return;

  const nonce = env.OPENSESSION_GATEWAY_NONCE?.trim();
  if (!nonce) {
    throw new Error("A standby gateway requires OPENSESSION_GATEWAY_NONCE");
  }
  const port = options.processPort ?? process;
  if (typeof port.send !== "function") {
    throw new Error("A standby gateway requires a supervised IPC channel");
  }

  await new Promise<void>((resolve, reject) => {
    const onMessage = (raw: unknown) => {
      const message = activationMessage(raw);
      if (!message) return;
      port.removeListener("message", onMessage);
      if (message.nonce !== nonce) {
        reject(new Error("Gateway activation nonce mismatch"));
        return;
      }
      resolve();
    };
    port.on("message", onMessage);
    const sent = port.send!({
      type: "opensession_gateway_preloaded",
      nonce,
      pid: port.pid,
    });
    if (sent === false) {
      port.removeListener("message", onMessage);
      reject(new Error("Gateway preload acknowledgement was not delivered"));
    }
  });
}
