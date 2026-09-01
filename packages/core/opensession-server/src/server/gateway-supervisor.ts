#!/usr/bin/env bun

import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
import {
  createGatewayTcpProxyMetrics,
  startGatewayTcpProxy,
  type GatewayTcpProxyMetrics,
} from "./gateway-tcp-proxy";
import { createStableFrontendResponder } from "./stable-frontend";
import { publishGatewayBackendPort } from "./gateway-routing";

export const GATEWAY_CONTROL_SOCKET =
  process.env.OPENSESSION_GATEWAY_CONTROL_SOCKET ||
  "/run/opensession-gateway/control.sock";

const PUBLIC_HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_PORT = Number(process.env.PORT || 3850);
const BACKEND_HOST = "127.0.0.1";
let nextBackendPort = Number(
  process.env.OPENSESSION_GATEWAY_BACKEND_PORT_BASE || 0,
);
const PRELOAD_TIMEOUT_MS = 30_000;
const FAST_HANDOFF_EXIT_TIMEOUT_MS = 2_500;
// Heavy recovery can keep /ready false well after the backend is serving
// liveness traffic. Peer mismatches are rejected by the pre-cut-over check;
// do not destroy a healthy candidate merely because recovery takes a minute.
const READY_TIMEOUT_MS = 60_000;

export function inheritedGatewaySocketFd(
  env: Record<string, string | undefined> = process.env,
  pid = process.pid,
): number | undefined {
  if (env.LISTEN_PID !== String(pid)) return undefined;
  const count = Number(env.LISTEN_FDS || 0);
  return Number.isInteger(count) && count >= 1 ? 3 : undefined;
}

type GatewayIpcMessage = {
  type: string;
  nonce?: string;
  pid?: number;
};

type HandoffRequest = {
  type: "handoff" | "prepare_coordinated";
  releaseRoot: string;
  sha: string;
  kernelGeneration?: string;
  executorGeneration?: string;
};

type PeerGenerations = {
  kernel: string;
  executor: string;
};

type CoordinatedRequest = {
  type:
    | "activate_coordinated"
    | "park_coordinated"
    | "abort_coordinated"
    | "commit_coordinated"
    | "drain_supervisor"
    | "status";
};

export type GatewayHandoffPhase =
  | "preparing"
  | "parked"
  | "activating"
  | "active-uncommitted"
  | "rollback-parked";

export type GatewayHandoffTransaction = {
  phase: GatewayHandoffPhase;
  targetRelease: string;
  previousRelease: string;
  candidatePid: number;
  updatedAt: string;
  failure?: string;
};

type ControlResponse = {
  ok: boolean;
  message: string;
  pid?: number;
  backendPort?: number;
  phase?: GatewayHandoffPhase | "idle";
  proxy?: GatewayTcpProxyMetrics;
};

export interface ManagedGateway {
  pid: number;
  releaseRoot: string;
  backendPort: number;
  peerGenerations?: PeerGenerations;
  exited: Promise<number>;
  kill(signal?: number): void;
  activate?(nonce: string): void;
  preloaded?: Promise<void>;
}

export interface GatewaySupervisorDependencies {
  spawn(
    releaseRoot: string,
    role: "active" | "standby",
    nonce?: string,
    peerGenerations?: PeerGenerations,
    precheckPeers?: boolean,
  ): ManagedGateway;
  waitReady(gateway: ManagedGateway): Promise<void>;
  waitLive?(gateway: ManagedGateway): Promise<void>;
  validateRelease(releaseRoot: string, sha: string): string;
  promoteCurrent(releaseRoot: string): void;
  onUnexpectedExit?(gateway: ManagedGateway, code: number): void;
  recordTransaction?(transaction: GatewayHandoffTransaction): void;
  clearTransaction?(): void;
  quiescePublicListener?(): void;
  publishBackendPort?(port: number): void;
}

function timeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer!));
}

export class GatewaySupervisor {
  private handoffPromise: Promise<ControlResponse> | null = null;
  private standby: ManagedGateway | null = null;
  private coordinated: {
    candidate: ManagedGateway;
    previous: ManagedGateway;
    nonce: string;
    timeout: ReturnType<typeof setTimeout>;
    phase: GatewayHandoffPhase;
    failure?: string;
  } | null = null;
  private shuttingDown = false;
  private routeToActive = true;

  constructor(
    private active: ManagedGateway,
    private readonly dependencies: GatewaySupervisorDependencies,
    private readonly proxyMetrics?: GatewayTcpProxyMetrics,
  ) {
    this.watchActive(active);
    this.dependencies.publishBackendPort?.(active.backendPort);
  }

  private watchActive(gateway: ManagedGateway): void {
    void gateway.exited.then((code) => {
      setTimeout(() => {
        if (
          this.active === gateway &&
          !this.handoffPromise &&
          !this.coordinated &&
          !this.shuttingDown
        ) {
          this.dependencies.onUnexpectedExit?.(gateway, code);
        }
      }, 0);
    });
  }

  private selectActive(gateway: ManagedGateway): void {
    this.active = gateway;
    this.watchActive(gateway);
    if (this.routeToActive)
      this.dependencies.publishBackendPort?.(gateway.backendPort);
  }

  private setRouteToActive(value: boolean): void {
    this.routeToActive = value;
    this.dependencies.publishBackendPort?.(value ? this.active.backendPort : 0);
  }

  private peerGenerations(gateway: ManagedGateway): PeerGenerations {
    const fallback = releaseGeneration(gateway.releaseRoot);
    return gateway.peerGenerations ?? { kernel: fallback, executor: fallback };
  }

  private waitLive(gateway: ManagedGateway): Promise<void> {
    return this.dependencies.waitLive?.(gateway) ?? Promise.resolve();
  }

  activeGateway(): ManagedGateway {
    return this.active;
  }

  backendPort(): number {
    return this.routeToActive ? this.active.backendPort : 0;
  }

  handoff(request: HandoffRequest): Promise<ControlResponse> {
    if (this.shuttingDown) {
      return Promise.resolve({
        ok: false,
        message: "gateway supervisor is shutting down",
      });
    }
    if (this.handoffPromise || this.coordinated) {
      return Promise.resolve({
        ok: false,
        message: "a gateway handoff is already in progress",
      });
    }
    this.handoffPromise = this.performHandoff(request).finally(() => {
      this.handoffPromise = null;
    });
    return this.handoffPromise;
  }

  prepareCoordinated(request: HandoffRequest): Promise<ControlResponse> {
    if (this.shuttingDown || this.handoffPromise || this.coordinated) {
      return Promise.resolve({
        ok: false,
        message: "a gateway handoff is already in progress",
      });
    }
    this.handoffPromise = this.performCoordinatedPrepare(request).finally(
      () => {
        this.handoffPromise = null;
      },
    );
    return this.handoffPromise;
  }

  async activateCoordinated(): Promise<ControlResponse> {
    const pending = this.coordinated;
    if (!pending || pending.phase !== "parked") {
      return {
        ok: false,
        message: "no parked coordinated handoff is prepared",
      };
    }
    pending.phase = "activating";
    this.recordCoordinated();
    try {
      pending.candidate.activate!(pending.nonce);
      await timeout(
        this.waitLive(pending.candidate),
        10_000,
        "candidate gateway did not become live in time",
      );
      this.setRouteToActive(true);
      await timeout(
        this.dependencies.waitReady(pending.candidate),
        READY_TIMEOUT_MS,
        "candidate gateway did not become ready in time",
      );
      pending.phase = "active-uncommitted";
      this.standby = null;
      this.recordCoordinated();
      return {
        ok: true,
        message: "coordinated gateway activated; awaiting commit",
        pid: pending.candidate.pid,
        phase: pending.phase,
      };
    } catch (error) {
      pending.failure = error instanceof Error ? error.message : String(error);
      await this.parkCoordinated();
      return {
        ok: false,
        message: `${pending.failure}; target gateway parked for peer rollback`,
        phase: "rollback-parked",
      };
    }
  }

  async parkCoordinated(): Promise<ControlResponse> {
    const pending = this.coordinated;
    if (!pending)
      return {
        ok: true,
        message: "no coordinated handoff was pending",
        phase: "idle",
      };
    pending.candidate.kill(9);
    await pending.candidate.exited.catch(() => 0);
    pending.phase = "rollback-parked";
    this.standby = null;
    this.recordCoordinated();
    return {
      ok: true,
      message: "target gateway parked; restore previous peers before abort",
      phase: pending.phase,
    };
  }

  async abortCoordinated(): Promise<ControlResponse> {
    const pending = this.coordinated;
    if (!pending)
      return {
        ok: true,
        message: "no coordinated handoff was pending",
        phase: "idle",
      };
    if (pending.phase !== "rollback-parked") {
      return {
        ok: false,
        message:
          "refusing to restore the previous gateway before the target is parked",
        phase: pending.phase,
      };
    }
    this.dependencies.promoteCurrent(pending.previous.releaseRoot);
    const rollback = this.dependencies.spawn(
      pending.previous.releaseRoot,
      "active",
      undefined,
      this.peerGenerations(pending.previous),
    );
    this.selectActive(rollback);
    try {
      await timeout(
        this.waitLive(rollback),
        10_000,
        "rollback gateway did not become live",
      );
      this.setRouteToActive(true);
      await timeout(
        this.dependencies.waitReady(rollback),
        READY_TIMEOUT_MS,
        "rollback gateway did not become ready",
      );
      clearTimeout(pending.timeout);
      this.coordinated = null;
      this.dependencies.clearTransaction?.();
      return {
        ok: true,
        message: "previous gateway restored after peer rollback",
        pid: rollback.pid,
        phase: "idle",
      };
    } catch {
      this.dependencies.onUnexpectedExit?.(rollback, 1);
      return {
        ok: false,
        message: "rollback gateway failed",
        phase: "rollback-parked",
      };
    }
  }

  commitCoordinated(): ControlResponse {
    const pending = this.coordinated;
    if (!pending || pending.phase !== "active-uncommitted") {
      return {
        ok: false,
        message: "no healthy coordinated handoff awaits commit",
      };
    }
    clearTimeout(pending.timeout);
    const pid = pending.candidate.pid;
    this.coordinated = null;
    this.dependencies.clearTransaction?.();
    return {
      ok: true,
      message: "coordinated handoff committed",
      pid,
      phase: "idle",
    };
  }

  async drainForSupervisorRestart(): Promise<ControlResponse> {
    if (this.shuttingDown || this.handoffPromise || this.coordinated) {
      return {
        ok: false,
        message:
          "gateway supervisor cannot drain during another lifecycle operation",
      };
    }
    this.shuttingDown = true;
    const gateway = this.active;
    // Stop accepting from the inherited descriptor first. PID 1 keeps its copy
    // open and queues new clients while already-accepted requests get a brief
    // chance to attach to the still-active backend.
    this.dependencies.quiescePublicListener?.();
    await Bun.sleep(50);
    this.setRouteToActive(false);
    gateway.kill(12);
    try {
      await timeout(
        gateway.exited,
        FAST_HANDOFF_EXIT_TIMEOUT_MS,
        "active gateway did not complete its fast supervisor drain",
      );
    } catch {
      gateway.kill(9);
      await timeout(
        gateway.exited,
        5_000,
        "active gateway survived supervisor drain SIGKILL",
      );
    }
    const expiry = setTimeout(() => {
      this.dependencies.onUnexpectedExit?.(gateway, 75);
    }, 30_000);
    expiry.unref?.();
    return {
      ok: true,
      message: "gateway drained; restart the supervisor now",
      pid: gateway.pid,
    };
  }

  status(): ControlResponse {
    return {
      ok: true,
      message: this.coordinated
        ? "coordinated handoff in progress"
        : "gateway supervisor ready",
      pid: this.active.pid,
      backendPort: this.backendPort(),
      phase: this.coordinated?.phase ?? "idle",
      ...(this.proxyMetrics ? { proxy: { ...this.proxyMetrics } } : {}),
    };
  }

  private recordCoordinated(): void {
    const pending = this.coordinated;
    if (!pending) return;
    this.dependencies.recordTransaction?.({
      phase: pending.phase,
      targetRelease: pending.candidate.releaseRoot,
      previousRelease: pending.previous.releaseRoot,
      candidatePid: pending.candidate.pid,
      updatedAt: new Date().toISOString(),
      ...(pending.failure ? { failure: pending.failure } : {}),
    });
  }

  private async performCoordinatedPrepare(
    request: HandoffRequest,
  ): Promise<ControlResponse> {
    const releaseRoot = this.dependencies.validateRelease(
      request.releaseRoot,
      request.sha,
    );
    const previous = this.active;
    const nonce = crypto.randomUUID();
    const targetGeneration = request.sha;
    const peerGenerations = {
      kernel: request.kernelGeneration || targetGeneration,
      executor: request.executorGeneration || targetGeneration,
    };
    for (const generation of Object.values(peerGenerations)) {
      if (!/^[0-9a-f]{40,64}$/.test(generation)) {
        return { ok: false, message: "invalid coordinated peer generation" };
      }
    }
    const candidate = this.dependencies.spawn(
      releaseRoot,
      "standby",
      nonce,
      peerGenerations,
    );
    this.standby = candidate;
    let previousExited = false;
    try {
      await timeout(
        candidate.preloaded!,
        PRELOAD_TIMEOUT_MS,
        "candidate gateway did not preload in time",
      );
      this.dependencies.recordTransaction?.({
        phase: "preparing",
        targetRelease: candidate.releaseRoot,
        previousRelease: previous.releaseRoot,
        candidatePid: candidate.pid,
        updatedAt: new Date().toISOString(),
      });
      this.setRouteToActive(false);
      previous.kill(12);
      try {
        await timeout(
          previous.exited,
          FAST_HANDOFF_EXIT_TIMEOUT_MS,
          "active gateway did not complete its fast coordinated drain",
        );
      } catch {
        console.warn(
          "[gateway-supervisor] fast coordinated drain expired; forcing the fenced gateway down",
        );
        previous.kill(9);
        await timeout(
          previous.exited,
          5_000,
          "active gateway survived SIGKILL",
        );
      }
      previousExited = true;
      this.dependencies.promoteCurrent(releaseRoot);
      this.selectActive(candidate);
      const expiry = setTimeout(() => {
        // Pointer authority already names the target. Do not guess that the old
        // gateway is still protocol-compatible after an abandoned peer update;
        // exit the supervisor so systemd boots the selected release cleanly.
        candidate.kill(9);
        void candidate.exited.finally(() => {
          this.dependencies.onUnexpectedExit?.(candidate, 75);
        });
      }, 180_000);
      expiry.unref?.();
      this.coordinated = {
        candidate,
        previous,
        nonce,
        timeout: expiry,
        phase: "parked",
      };
      this.recordCoordinated();
      return {
        ok: true,
        message: "coordinated gateway prepared",
        pid: candidate.pid,
        phase: "parked",
      };
    } catch (error) {
      candidate.kill(9);
      await candidate.exited.catch(() => 0);
      this.standby = null;
      if (!previousExited) this.setRouteToActive(true);
      this.dependencies.clearTransaction?.();
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.coordinated) clearTimeout(this.coordinated.timeout);
    this.setRouteToActive(false);
    const children = new Set(
      [this.active, this.standby].filter(Boolean) as ManagedGateway[],
    );
    for (const child of children) child.kill(child === this.active ? 15 : 9);
    await Promise.all(
      [...children].map((child) => child.exited.catch(() => 0)),
    );
  }

  private async performHandoff(
    request: HandoffRequest,
  ): Promise<ControlResponse> {
    const releaseRoot = this.dependencies.validateRelease(
      request.releaseRoot,
      request.sha,
    );
    if (releaseRoot === this.active.releaseRoot) {
      return {
        ok: true,
        message: "gateway already runs the requested release",
        pid: this.active.pid,
      };
    }

    const previous = this.active;
    const nonce = crypto.randomUUID();
    const candidate = this.dependencies.spawn(
      releaseRoot,
      "standby",
      nonce,
      this.peerGenerations(previous),
      true,
    );
    this.standby = candidate;
    let previousExited = false;
    try {
      if (!candidate.preloaded || !candidate.activate) {
        throw new Error(
          "standby gateway did not expose the activation protocol",
        );
      }
      await timeout(
        candidate.preloaded,
        PRELOAD_TIMEOUT_MS,
        "candidate gateway did not preload in time",
      );
      this.dependencies.recordTransaction?.({
        phase: "preparing",
        targetRelease: candidate.releaseRoot,
        previousRelease: previous.releaseRoot,
        candidatePid: candidate.pid,
        updatedAt: new Date().toISOString(),
      });

      if (this.shuttingDown)
        throw new Error("gateway supervisor is shutting down");
      this.setRouteToActive(false);
      previous.kill(12);
      try {
        await timeout(
          previous.exited,
          FAST_HANDOFF_EXIT_TIMEOUT_MS,
          "active gateway did not exit before the fast handoff deadline",
        );
      } catch {
        console.warn(
          "[gateway-supervisor] active gateway missed its exit deadline; forcing the fenced process down",
        );
        previous.kill(9);
        await timeout(
          previous.exited,
          5_000,
          "active gateway survived SIGKILL",
        );
      }
      previousExited = true;
      if (this.shuttingDown)
        throw new Error("gateway supervisor is shutting down");

      // Pointer and process authority move as one transaction. A supervisor or
      // host crash from here boots the candidate; failure below restores the
      // pointer before the previous release is started again.
      this.dependencies.promoteCurrent(releaseRoot);
      this.dependencies.recordTransaction?.({
        phase: "activating",
        targetRelease: candidate.releaseRoot,
        previousRelease: previous.releaseRoot,
        candidatePid: candidate.pid,
        updatedAt: new Date().toISOString(),
      });
      candidate.activate(nonce);
      this.selectActive(candidate);
      await timeout(
        this.waitLive(candidate),
        10_000,
        "candidate gateway did not become live in time",
      );
      this.setRouteToActive(true);
      await timeout(
        this.dependencies.waitReady(candidate),
        READY_TIMEOUT_MS,
        "candidate gateway did not become ready in time",
      );
      this.standby = null;
      this.dependencies.clearTransaction?.();
      return {
        ok: true,
        message: "gateway handoff completed",
        pid: candidate.pid,
      };
    } catch (error) {
      candidate.kill(9);
      await candidate.exited.catch(() => 0);
      if (this.standby === candidate) this.standby = null;
      const message = error instanceof Error ? error.message : String(error);
      if (this.shuttingDown) {
        return { ok: false, message };
      }
      if (!previousExited) {
        this.dependencies.clearTransaction?.();
        return {
          ok: false,
          message: `candidate rejected before cut-over: ${message}`,
        };
      }

      this.dependencies.promoteCurrent(previous.releaseRoot);
      const rollback = this.dependencies.spawn(
        previous.releaseRoot,
        "active",
        undefined,
        this.peerGenerations(previous),
      );
      this.selectActive(rollback);
      try {
        await timeout(
          this.waitLive(rollback),
          10_000,
          "rollback gateway did not become live",
        );
        this.setRouteToActive(true);
        await timeout(
          this.dependencies.waitReady(rollback),
          READY_TIMEOUT_MS,
          "rollback gateway did not become ready in time",
        );
        this.dependencies.clearTransaction?.();
        return {
          ok: false,
          message: `candidate failed after cut-over; previous gateway restored: ${message}`,
        };
      } catch (rollbackError) {
        console.error("[gateway-supervisor] rollback failed", rollbackError);
        process.exitCode = 1;
        setTimeout(() => process.exit(1), 0);
        return {
          ok: false,
          message: `candidate and rollback gateway failed: ${message}`,
        };
      }
    }
  }
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function allocateBackendPort(): number {
  if (nextBackendPort > 0) return nextBackendPort++;
  const reservation = Bun.listen({
    hostname: BACKEND_HOST,
    port: 0,
    socket: {
      open(socket) {
        socket.end();
      },
      data() {},
    },
  });
  const port = reservation.port;
  reservation.stop();
  return port;
}

function releaseGeneration(releaseRoot: string): string {
  const marker = join(releaseRoot, ".opensession-release");
  return existsSync(marker)
    ? readFileSync(marker, "utf8").trim()
    : "development";
}

export async function discoverRuntimePeerGenerations(
  options: {
    fetchReady?: () => Promise<Response>;
    readExecutorReady?: () => string;
    sleep?: (ms: number) => Promise<void>;
    attempts?: number;
  } = {},
): Promise<PeerGenerations> {
  const fetchReady =
    options.fetchReady ??
    (() =>
      fetch(
        new URL(
          "/ready",
          process.env.OPENSESSION_SESSION_KERNEL_URL ?? "http://127.0.0.1:3849",
        ),
        { signal: AbortSignal.timeout(1_000) },
      ));
  const readExecutorReady =
    options.readExecutorReady ??
    (() =>
      readFileSync(
        process.env.OPENSESSION_EXECUTOR_READY_FILE ??
          "/run/opensession-executor/ready",
        "utf8",
      ));
  const sleep = options.sleep ?? Bun.sleep;
  for (let attempt = 0; attempt < (options.attempts ?? 30); attempt += 1) {
    try {
      const [kernelResponse, executorText] = await Promise.all([
        fetchReady(),
        Promise.resolve().then(readExecutorReady),
      ]);
      const kernel = kernelResponse.ok
        ? ((await kernelResponse.json()) as { generation?: string })
        : null;
      const executor = JSON.parse(executorText) as { generation?: string };
      if (
        kernel?.generation &&
        executor.generation &&
        /^[0-9a-f]{40,64}$/.test(kernel.generation) &&
        /^[0-9a-f]{40,64}$/.test(executor.generation)
      ) {
        return { kernel: kernel.generation, executor: executor.generation };
      }
    } catch {}
    await sleep(100);
  }
  throw new Error("runtime peer generations are unavailable");
}

export async function resolveInitialPeerGenerations(
  releaseRoot: string,
  discover: () => Promise<PeerGenerations> = discoverRuntimePeerGenerations,
): Promise<PeerGenerations> {
  const generation = releaseGeneration(releaseRoot);
  if (generation === "development") {
    return { kernel: generation, executor: generation };
  }
  return discover();
}

export function spawnGateway(
  releaseRoot: string,
  role: "active" | "standby",
  nonce?: string,
  peerGenerations?: PeerGenerations,
  precheckPeers = false,
  entry = "packages/core/opensession-server/opensession.ts",
): ManagedGateway {
  const preloaded = deferred();
  const backendPort = allocateBackendPort();
  const generation = releaseGeneration(releaseRoot);
  let expectedNonce = nonce;
  const child = Bun.spawn([process.execPath, "run", entry], {
    cwd: releaseRoot,
    env: {
      ...process.env,
      OPENSESSION_GATEWAY_ROLE: role,
      PORT: String(PUBLIC_PORT),
      OPENSESSION_GATEWAY_BACKEND_HOST: BACKEND_HOST,
      OPENSESSION_GATEWAY_BACKEND_PORT: String(backendPort),
      OPENSESSION_RELEASE_GENERATION: generation,
      OPENSESSION_KERNEL_GENERATION: peerGenerations?.kernel ?? generation,
      OPENSESSION_EXECUTOR_GENERATION: peerGenerations?.executor ?? generation,
      OPENSESSION_GATEWAY_PRECHECK_PEERS: precheckPeers ? "1" : "0",
      ...(nonce ? { OPENSESSION_GATEWAY_NONCE: nonce } : {}),
    },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    ipc(message) {
      const value = message as GatewayIpcMessage;
      if (
        role === "standby" &&
        value?.type === "opensession_gateway_preloaded" &&
        value.nonce === expectedNonce &&
        value.pid === child.pid
      ) {
        preloaded.resolve();
      }
    },
  });
  const exited = child.exited.then((code) => {
    if (role === "standby") {
      preloaded.reject(
        new Error(`candidate gateway exited during preload (${code})`),
      );
    }
    return code;
  });
  return {
    pid: child.pid,
    releaseRoot,
    backendPort,
    peerGenerations: peerGenerations ?? {
      kernel: generation,
      executor: generation,
    },
    exited,
    kill(signal = 15) {
      child.kill(signal);
    },
    ...(role === "standby"
      ? {
          preloaded: preloaded.promise,
          activate(activationNonce: string) {
            if (activationNonce !== expectedNonce) {
              throw new Error("gateway activation nonce mismatch");
            }
            child.send({
              type: "opensession_gateway_activate",
              nonce: activationNonce,
            });
            expectedNonce = undefined;
          },
        }
      : {}),
  };
}

export function validateGatewayRelease(
  releaseRoot: string,
  sha: string,
  releasesRoot = process.env.OPENSESSION_DEPLOY_STATE
    ? join(process.env.OPENSESSION_DEPLOY_STATE, "releases")
    : join(process.env.HOME || "", ".opensession/deploy/releases"),
): string {
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error("invalid release sha");
  const root = realpathSync(releaseRoot);
  const allowed = `${realpathSync(releasesRoot)}/`;
  if (!root.startsWith(allowed))
    throw new Error("candidate is outside the immutable release store");
  const marker = readFileSync(
    join(root, ".opensession-release"),
    "utf8",
  ).trim();
  if (marker !== sha)
    throw new Error(
      "candidate release marker does not match the requested sha",
    );
  if (!existsSync(join(root, ".frontend-dist", ".bundle-meta.json"))) {
    throw new Error("candidate frontend was not prepared");
  }
  return root;
}

async function waitForGatewayLive(gateway: ManagedGateway): Promise<void> {
  for (;;) {
    const state = await Promise.race([
      gateway.exited.then((code) => ({ exited: code }) as const),
      fetch(`http://${BACKEND_HOST}:${gateway.backendPort}/live`, {
        signal: AbortSignal.timeout(1_000),
      })
        .then(async (response) => {
          const body = (await response.json()) as { ok?: boolean };
          return { live: response.ok && body.ok === true } as const;
        })
        .catch(() => ({ live: false }) as const),
    ]);
    if ("exited" in state)
      throw new Error(`gateway exited before liveness (${state.exited})`);
    if (state.live) return;
    await Bun.sleep(50);
  }
}

async function waitForGatewayReady(gateway: ManagedGateway): Promise<void> {
  const marker = join(gateway.releaseRoot, ".opensession-release");
  const expected = existsSync(marker)
    ? readFileSync(marker, "utf8").trim()
    : "development";
  for (;;) {
    const state = await Promise.race([
      gateway.exited.then((code) => ({ exited: code }) as const),
      fetch(`http://${BACKEND_HOST}:${gateway.backendPort}/ready`, {
        signal: AbortSignal.timeout(1_000),
      })
        .then(async (response) => {
          const body = (await response.json()) as {
            ok?: boolean;
            generation?: string;
          };
          return {
            ready:
              response.ok && body.ok === true && body.generation === expected,
          } as const;
        })
        .catch(() => ({ ready: false }) as const),
    ]);
    if ("exited" in state)
      throw new Error(`gateway exited before readiness (${state.exited})`);
    if (state.ready) return;
    await Bun.sleep(100);
  }
}

export function promoteGatewayCurrent(
  releaseRoot: string,
  state = process.env.OPENSESSION_DEPLOY_STATE ||
    join(process.env.HOME || "", ".opensession/deploy"),
): void {
  const target = realpathSync(releaseRoot);
  const current = join(state, "current");
  const next = join(state, `.gateway-current.${process.pid}`);
  if (existsSync(next)) unlinkSync(next);
  symlinkSync(target, next);
  renameSync(next, current);
}

function deployStateRoot(): string {
  return (
    process.env.OPENSESSION_DEPLOY_STATE ||
    join(process.env.HOME || "", ".opensession/deploy")
  );
}

export function resolveInitialReleaseRoot(
  state = deployStateRoot(),
  sourceRoot = process.cwd(),
): string {
  const current = join(state, "current");
  if (existsSync(current)) return realpathSync(current);

  const source = realpathSync(sourceRoot);
  if (
    existsSync(join(source, "packages/core/opensession-server/opensession.ts"))
  ) {
    return source;
  }
  throw new Error(
    `no active release at ${current} and ${source} is not an Open Session source checkout`,
  );
}

export function writeGatewayHandoffTransaction(
  transaction: GatewayHandoffTransaction,
  state = deployStateRoot(),
): void {
  const path = join(state, "gateway-handoff.json");
  const next = `${path}.${process.pid}.tmp`;
  writeFileSync(next, `${JSON.stringify(transaction, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(next, path);
}

export function clearGatewayHandoffTransaction(
  state = deployStateRoot(),
): void {
  const path = join(state, "gateway-handoff.json");
  if (existsSync(path)) unlinkSync(path);
}

export function readGatewayHandoffTransaction(
  state = deployStateRoot(),
): GatewayHandoffTransaction | null {
  try {
    return JSON.parse(
      readFileSync(join(state, "gateway-handoff.json"), "utf8"),
    ) as GatewayHandoffTransaction;
  } catch {
    return null;
  }
}

function serveControl(
  supervisor: GatewaySupervisor,
): ReturnType<typeof Bun.listen> {
  if (existsSync(GATEWAY_CONTROL_SOCKET)) unlinkSync(GATEWAY_CONTROL_SOCKET);
  const listener = Bun.listen({
    unix: GATEWAY_CONTROL_SOCKET,
    socket: {
      open(socket) {
        (socket as any).__buffer = "";
      },
      data(socket, chunk) {
        const value = `${(socket as any).__buffer}${Buffer.from(chunk).toString("utf8")}`;
        const newline = value.indexOf("\n");
        if (newline === -1) {
          if (value.length > 16_384) socket.end();
          else (socket as any).__buffer = value;
          return;
        }
        (socket as any).__buffer = "";
        void (async () => {
          let response: ControlResponse;
          try {
            const request = JSON.parse(value.slice(0, newline)) as
              | HandoffRequest
              | CoordinatedRequest;
            if (request.type === "handoff")
              response = await supervisor.handoff(request);
            else if (request.type === "prepare_coordinated") {
              response = await supervisor.prepareCoordinated(request);
            } else if (request.type === "activate_coordinated") {
              response = await supervisor.activateCoordinated();
            } else if (request.type === "park_coordinated") {
              response = await supervisor.parkCoordinated();
            } else if (request.type === "abort_coordinated") {
              response = await supervisor.abortCoordinated();
            } else if (request.type === "commit_coordinated") {
              response = supervisor.commitCoordinated();
            } else if (request.type === "drain_supervisor") {
              response = await supervisor.drainForSupervisorRestart();
            } else if (request.type === "status") {
              response = supervisor.status();
            } else throw new Error("unknown supervisor request");
          } catch (error) {
            response = {
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            };
          }
          socket.end(`${JSON.stringify(response)}\n`);
        })();
      },
      error(_socket, error) {
        console.error("[gateway-supervisor] control socket error", error);
      },
    },
  });
  chmodSync(GATEWAY_CONTROL_SOCKET, 0o600);
  return listener;
}

async function requestSupervisor(
  request: HandoffRequest | CoordinatedRequest,
): Promise<ControlResponse> {
  return new Promise((resolveResponse, reject) => {
    let body = "";
    const timer = setTimeout(
      () => reject(new Error("gateway supervisor request timed out")),
      190_000,
    );
    Bun.connect({
      unix: GATEWAY_CONTROL_SOCKET,
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify(request)}\n`);
        },
        data(socket, chunk) {
          body += Buffer.from(chunk).toString("utf8");
          const newline = body.indexOf("\n");
          if (newline === -1) return;
          clearTimeout(timer);
          socket.end();
          try {
            resolveResponse(
              JSON.parse(body.slice(0, newline)) as ControlResponse,
            );
          } catch (error) {
            reject(error);
          }
        },
        close() {
          if (!body.includes("\n")) {
            clearTimeout(timer);
            reject(new Error("gateway supervisor closed without a response"));
          }
        },
        connectError(_socket, error) {
          clearTimeout(timer);
          reject(error);
        },
        error(_socket, error) {
          clearTimeout(timer);
          reject(error);
        },
      },
    }).catch(reject);
  });
}

async function runSupervisor(): Promise<void> {
  const releaseRoot = resolveInitialReleaseRoot();
  const interrupted = readGatewayHandoffTransaction();
  if (interrupted) {
    console.warn(
      `[gateway-supervisor] recovering interrupted ${interrupted.phase} transaction; ` +
        `current selects ${releaseRoot}`,
    );
  }
  // Peer generations can intentionally differ after a selective rollout. Never
  // guess from `current`: a guessed generation caused a two-minute crash loop
  // after an executor was correctly retained on its previous release. Source
  // installs have no immutable marker or separate executor, so both peers use
  // the development generation instead.
  const peerGenerations = await resolveInitialPeerGenerations(releaseRoot);
  const active = spawnGateway(
    releaseRoot,
    "active",
    undefined,
    peerGenerations,
  );
  const proxyMetrics = createGatewayTcpProxyMetrics();
  const externalIngress = process.env.OPENSESSION_EXTERNAL_INGRESS === "1";
  let publicListener: ReturnType<typeof startGatewayTcpProxy> | undefined;
  let stopping = false;
  const supervisor = new GatewaySupervisor(
    active,
    {
      spawn: spawnGateway,
      waitReady: waitForGatewayReady,
      waitLive: waitForGatewayLive,
      validateRelease: validateGatewayRelease,
      promoteCurrent: promoteGatewayCurrent,
      recordTransaction: writeGatewayHandoffTransaction,
      clearTransaction: clearGatewayHandoffTransaction,
      publishBackendPort(port) {
        if (externalIngress) publishGatewayBackendPort(deployStateRoot(), port);
      },
      quiescePublicListener() {
        publicListener?.stop(false);
      },
      onUnexpectedExit(gateway, code) {
        if (stopping) return;
        console.error(
          `[gateway-supervisor] active gateway ${gateway.pid} exited unexpectedly (${code})`,
        );
        process.exit(1);
      },
    },
    proxyMetrics,
  );
  const controlListener = serveControl(supervisor);
  if (!externalIngress) {
    const stableFrontend = createStableFrontendResponder(deployStateRoot(), {
      liveStatus: () => ({
        backendSelected: supervisor.backendPort() > 0,
        proxy: { ...proxyMetrics },
      }),
    });
    publicListener = startGatewayTcpProxy({
      hostname: PUBLIC_HOST,
      port: PUBLIC_PORT,
      backendPort: () => supervisor.backendPort(),
      metrics: proxyMetrics,
      fallbackHttp: stableFrontend,
      listenFd: inheritedGatewaySocketFd(),
    });
  }
  console.log(
    `[gateway-supervisor] ${externalIngress ? "publishing" : "proxying"} ` +
      `${PUBLIC_HOST}:${PUBLIC_PORT} to gateway ${active.pid}` +
      ` on ${BACKEND_HOST}:${active.backendPort} from ${releaseRoot}`,
  );
  if (interrupted) {
    void waitForGatewayReady(active).then(() => {
      clearGatewayHandoffTransaction();
      console.log(
        "[gateway-supervisor] interrupted handoff reconciled to the selected generation",
      );
    });
  }

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    controlListener.stop();
    publicListener?.stop();
    await supervisor.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());

  await new Promise<void>(() => {});
}

if (import.meta.main) {
  if (
    [
      "handoff",
      "prepare-coordinated",
      "activate-coordinated",
      "park-coordinated",
      "abort-coordinated",
      "commit-coordinated",
      "drain-supervisor",
      "status",
    ].includes(process.argv[2] || "")
  ) {
    const action = process.argv[2];
    const releaseRoot = resolve(process.argv[3] || "");
    const sha = process.argv[4] || "";
    const request: HandoffRequest | CoordinatedRequest =
      action === "handoff"
        ? { type: "handoff", releaseRoot, sha }
        : action === "prepare-coordinated"
          ? {
              type: "prepare_coordinated",
              releaseRoot,
              sha,
              kernelGeneration: process.argv[5] || undefined,
              executorGeneration: process.argv[6] || undefined,
            }
          : action === "activate-coordinated"
            ? { type: "activate_coordinated" }
            : action === "park-coordinated"
              ? { type: "park_coordinated" }
              : action === "abort-coordinated"
                ? { type: "abort_coordinated" }
                : action === "commit-coordinated"
                  ? { type: "commit_coordinated" }
                  : action === "drain-supervisor"
                    ? { type: "drain_supervisor" }
                    : { type: "status" };
    const response = await requestSupervisor(request);
    console.log(JSON.stringify(response));
    process.exit(response.ok ? 0 : 1);
  }
  await runSupervisor();
}
