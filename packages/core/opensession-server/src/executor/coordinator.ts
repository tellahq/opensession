import { sameProcess } from "../server/process-identity";
import type {
  ExecutorHostStatus,
  ExecutorRequest,
  ExecutorResponse,
} from "@tellahq/opensession-protocol/executor";
import { EXECUTOR_PROTOCOL_VERSION } from "@tellahq/opensession-protocol/executor";
import { existsSync, mkdirSync, readFileSync } from "fs";
import type { RunHostMeta, RunHostSpec } from "../runner-host/protocol";
import {
  HOST_META_NAME,
  HOST_SOCK_NAME,
  HOST_SPEC_NAME,
  runHostsDir,
} from "../runner-host/protocol";
import { writeJsonAtomic } from "../server/shared/atomic-write";
import { envCapacity } from "../server/shared/env-capacity";
import {
  hostUnitActive,
  launchHostUnitDirect,
  runHostUnitName,
  stopHostUnitDirect,
} from "./host-unit";
import { timingSafeEqual } from "crypto";

const HOST_ID_RE =
  /^rh-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Bounds concurrent launch requests crossing the control socket, not active
// hosts. Executor service process: it does not load ~/.opensession.env, so an
// override only takes effect through a systemd drop-in on
// opensession-executor.service.
const LAUNCH_INFLIGHT_LIMIT = envCapacity(
  "OPENSESSION_EXECUTOR_LAUNCH_CONCURRENCY",
  8,
  1,
  64,
);
const HASH_RE = /^[0-9a-f]{64}$/i;

interface LaunchRecord {
  hostId: string;
  specHash: string;
  state: "starting" | "started" | "stopped" | "failed" | "uncertain";
  unit: string;
  updatedAt: string;
  error?: string;
}

export interface ExecutorCoordinatorDeps {
  launch(hostId: string, dir: string, specHash: string): Promise<void>;
  stop(hostId: string): Promise<void>;
  unitActive(hostId: string): Promise<boolean>;
  hostReady(dir: string): boolean | Promise<boolean>;
  hostStarted(dir: string): boolean | Promise<boolean>;
  now(): string;
}

const defaultDeps: ExecutorCoordinatorDeps = {
  launch: launchHostUnitDirect,
  stop: stopHostUnitDirect,
  unitActive: hostUnitActive,
  hostReady: (dir) => {
    const meta = readJson<RunHostMeta>(`${dir}/${HOST_META_NAME}`);
    if (!existsSync(`${dir}/${HOST_SOCK_NAME}`) || !meta?.pid) return false;
    const matches = sameProcess(meta);
    if (matches !== undefined) return matches;
    try {
      process.kill(meta.pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  hostStarted: (dir) =>
    !!readJson<RunHostMeta>(`${dir}/${HOST_META_NAME}`)?.pid,
  now: () => new Date().toISOString(),
};

export class ExecutorCoordinator {
  private readonly hostsDir: string;
  private readonly authTokenBytes: Buffer;
  private accepting = true;
  private inflight = new Map<
    string,
    { specHash: string; promise: Promise<ExecutorHostStatus> }
  >();
  private stopping = new Map<
    string,
    { specHash: string; promise: Promise<ExecutorHostStatus> }
  >();

  constructor(
    sessionsDir: string,
    authToken: string,
    private readonly deps: ExecutorCoordinatorDeps = defaultDeps,
  ) {
    this.hostsDir = runHostsDir(sessionsDir);
    this.authTokenBytes = Buffer.from(authToken);
    mkdirSync(this.hostsDir, { recursive: true });
  }

  async handle(request: ExecutorRequest): Promise<ExecutorResponse> {
    if (
      !request ||
      typeof request.requestId !== "string" ||
      !request.requestId
    ) {
      return this.error("", "invalid_request", "requestId is required");
    }
    if (!secureEqual(request.token, this.authTokenBytes)) {
      return this.error(
        request.requestId,
        "invalid_request",
        "invalid executor credential",
      );
    }
    if (request.t === "hello") {
      const compatible =
        request.minVersion <= EXECUTOR_PROTOCOL_VERSION &&
        request.maxVersion >= EXECUTOR_PROTOCOL_VERSION;
      return compatible
        ? {
            requestId: request.requestId,
            ok: true,
            version: EXECUTOR_PROTOCOL_VERSION,
            compatible: true,
          }
        : this.error(
            request.requestId,
            "unsupported_version",
            `executor protocol ${EXECUTOR_PROTOCOL_VERSION} is outside ${request.minVersion}..${request.maxVersion}`,
          );
    }
    if (!this.accepting) {
      return this.error(
        request.requestId,
        "invalid_request",
        "executor is shutting down",
      );
    }
    if (request.version !== EXECUTOR_PROTOCOL_VERSION) {
      return this.error(
        request.requestId,
        "unsupported_version",
        `executor protocol ${request.version} is unsupported`,
      );
    }
    if (!HOST_ID_RE.test(request.hostId)) {
      return this.error(
        request.requestId,
        "invalid_host",
        "invalid run host id",
      );
    }
    if (request.specHash !== undefined && !HASH_RE.test(request.specHash)) {
      return this.error(
        request.requestId,
        "invalid_request",
        "invalid spec hash",
      );
    }
    if (request.t === "stop_host" && !request.specHash) {
      return this.error(
        request.requestId,
        "invalid_request",
        "spec hash is required",
      );
    }

    try {
      switch (request.t) {
        case "launch_host":
          return {
            requestId: request.requestId,
            ok: true,
            version: EXECUTOR_PROTOCOL_VERSION,
            status: await this.launch(request.hostId, request.specHash),
          };
        case "host_status": {
          const status = await this.status(request.hostId);
          if (
            request.specHash &&
            status.specHash &&
            request.specHash !== status.specHash
          ) {
            return this.error(
              request.requestId,
              "spec_hash_mismatch",
              "host id is already bound to another run spec",
            );
          }
          return {
            requestId: request.requestId,
            ok: true,
            version: EXECUTOR_PROTOCOL_VERSION,
            status,
          };
        }
        case "stop_host": {
          return {
            requestId: request.requestId,
            ok: true,
            version: EXECUTOR_PROTOCOL_VERSION,
            status: await this.stop(request.hostId, request.specHash),
          };
        }
        default:
          return this.error(
            (request as any).requestId,
            "invalid_request",
            "unknown request type",
          );
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (cause instanceof CoordinatorError) {
        return this.error(request.requestId, cause.code, message);
      }
      return this.error(
        request.requestId,
        request.t === "stop_host" ? "stop_failed" : "launch_failed",
        message,
      );
    }
  }

  private async launch(
    hostId: string,
    specHash: string,
  ): Promise<ExecutorHostStatus> {
    const stopping = this.stopping.get(hostId);
    if (stopping) {
      if (stopping.specHash !== specHash) {
        throw new CoordinatorError(
          "spec_hash_mismatch",
          "host id has an in-flight stop for another run spec",
        );
      }
      await stopping.promise;
    }
    const existing = this.readRecord(hostId);
    if (existing && existing.specHash !== specHash) {
      throw new CoordinatorError(
        "spec_hash_mismatch",
        "host id is already bound to another run spec",
      );
    }
    if (existing?.state === "uncertain") {
      return this.reconcileUncertain(hostId, specHash, existing.error);
    }
    if (existing?.state === "starting") {
      const dir = `${this.hostsDir}/${hostId}`;
      try {
        if (await this.deps.hostReady(dir)) {
          this.recordStarted(hostId, specHash);
          return this.status(hostId);
        }
        const [unitActive, hostStarted] = await Promise.all([
          this.deps.unitActive(hostId),
          this.deps.hostStarted(dir),
        ]);
        if (unitActive || hostStarted) {
          const error = unitActive
            ? "a previous launch is still active but not connectable"
            : "execution evidence exists for a previous launch";
          this.record({
            hostId,
            specHash,
            state: "uncertain",
            unit: runHostUnitName(hostId),
            updatedAt: this.deps.now(),
            error,
          });
          throw new CoordinatorError("launch_uncertain", error);
        }
      } catch (cause) {
        if (cause instanceof CoordinatorError) throw cause;
        const error = `could not prove the previous starting launch absent: ${String(cause)}`;
        this.record({
          hostId,
          specHash,
          state: "uncertain",
          unit: runHostUnitName(hostId),
          updatedAt: this.deps.now(),
          error,
        });
        throw new CoordinatorError("launch_uncertain", error);
      }
    } else if (existing) {
      return this.status(hostId);
    }
    const active = this.inflight.get(hostId);
    if (active) {
      if (active.specHash !== specHash) {
        throw new CoordinatorError(
          "spec_hash_mismatch",
          "host id has an in-flight launch for another run spec",
        );
      }
      return active.promise;
    }
    if (this.inflight.size >= LAUNCH_INFLIGHT_LIMIT) {
      throw new CoordinatorError(
        "executor_busy",
        "executor launch capacity is full; retry shortly",
      );
    }
    this.prepareLaunch(hostId, specHash);
    const promise = this.launchOnce(hostId, specHash).finally(() => {
      this.inflight.delete(hostId);
    });
    this.inflight.set(hostId, { specHash, promise });
    return promise;
  }

  private async reconcileUncertain(
    hostId: string,
    specHash: string,
    previousError?: string,
  ): Promise<ExecutorHostStatus> {
    const dir = `${this.hostsDir}/${hostId}`;
    try {
      if (await this.deps.hostReady(dir)) {
        this.recordStarted(hostId, specHash);
        return this.status(hostId);
      }
      const [active, started] = await Promise.all([
        this.deps.unitActive(hostId),
        this.deps.hostStarted(dir),
      ]);
      if (active || started) {
        throw new CoordinatorError(
          "launch_uncertain",
          previousError || "previous launch may still have executed",
        );
      }
      this.record({
        hostId,
        specHash,
        state: "failed",
        unit: runHostUnitName(hostId),
        updatedAt: this.deps.now(),
        error: previousError || "previous launch was proven absent",
      });
      return this.status(hostId);
    } catch (cause) {
      if (cause instanceof CoordinatorError) throw cause;
      throw new CoordinatorError(
        "launch_uncertain",
        `${previousError || "previous launch was uncertain"}; reconciliation failed: ${String(cause)}`,
      );
    }
  }

  private prepareLaunch(hostId: string, specHash: string): void {
    const dir = `${this.hostsDir}/${hostId}`;
    const specPath = `${dir}/${HOST_SPEC_NAME}`;
    if (!existsSync(specPath)) {
      throw new CoordinatorError(
        "spec_not_found",
        `missing run spec for ${hostId}`,
      );
    }
    const raw = readFileSync(specPath);
    const actualHash = new Bun.CryptoHasher("sha256").update(raw).digest("hex");
    if (actualHash !== specHash) {
      throw new CoordinatorError(
        "spec_hash_mismatch",
        `run spec hash changed for ${hostId}`,
      );
    }
    const spec = JSON.parse(raw.toString()) as RunHostSpec;
    if (spec.hostId !== hostId) {
      throw new CoordinatorError(
        "invalid_host",
        "run spec hostId does not match request",
      );
    }
    this.record({
      hostId,
      specHash,
      state: "starting",
      unit: runHostUnitName(hostId),
      updatedAt: this.deps.now(),
    });
  }

  private async launchOnce(
    hostId: string,
    specHash: string,
  ): Promise<ExecutorHostStatus> {
    const dir = `${this.hostsDir}/${hostId}`;
    if (await this.deps.hostReady(dir)) {
      this.recordStarted(hostId, specHash);
      return this.status(hostId);
    }

    try {
      if (!(await this.deps.unitActive(hostId))) {
        await this.deps.launch(hostId, dir, specHash);
      }
      await this.waitReady(dir, 20_000);
      this.recordStarted(hostId, specHash);
    } catch (cause) {
      let error = cause instanceof Error ? cause.message : String(cause);
      try {
        await this.deps.stop(hostId);
      } catch (stopCause) {
        error += `; cleanup failed: ${String(stopCause)}`;
      }
      let effectRemains = true;
      let launchObserved = true;
      try {
        effectRemains =
          (await this.deps.unitActive(hostId)) ||
          (await this.deps.hostReady(dir));
        launchObserved = await this.deps.hostStarted(dir);
      } catch (probeCause) {
        error += `; cleanup probe failed: ${String(probeCause)}`;
      }
      const uncertain = effectRemains || launchObserved;
      this.record({
        hostId,
        specHash,
        state: uncertain ? "uncertain" : "failed",
        unit: runHostUnitName(hostId),
        updatedAt: this.deps.now(),
        error,
      });
      throw new CoordinatorError(
        uncertain ? "launch_uncertain" : "launch_failed",
        error,
      );
    }
    return this.status(hostId);
  }

  private async status(hostId: string): Promise<ExecutorHostStatus> {
    const record = this.readRecord(hostId);
    const dir = `${this.hostsDir}/${hostId}`;
    const meta = readJson<RunHostMeta>(`${dir}/${HOST_META_NAME}`);
    const ready = await this.deps.hostReady(dir);
    return {
      hostId,
      specHash: record?.specHash,
      unit: record?.unit ?? runHostUnitName(hostId),
      state: ready ? "started" : (record?.state ?? "unknown"),
      ready,
      pid: meta?.pid,
      error: record?.error,
    };
  }

  private stop(hostId: string, specHash: string): Promise<ExecutorHostStatus> {
    const existing = this.stopping.get(hostId);
    if (existing) {
      if (existing.specHash !== specHash) {
        return Promise.reject(
          new CoordinatorError(
            "spec_hash_mismatch",
            "host id has an in-flight stop for another run spec",
          ),
        );
      }
      return existing.promise;
    }
    const deferred = Promise.withResolvers<ExecutorHostStatus>();
    this.stopping.set(hostId, { specHash, promise: deferred.promise });
    void this.stopOnce(hostId, specHash).then(
      deferred.resolve,
      deferred.reject,
    );
    void deferred.promise
      .finally(() => this.stopping.delete(hostId))
      .catch(() => {});
    return deferred.promise;
  }

  private async stopOnce(
    hostId: string,
    specHash: string,
  ): Promise<ExecutorHostStatus> {
    const active = this.inflight.get(hostId);
    if (active && active.specHash !== specHash) {
      throw new CoordinatorError(
        "spec_hash_mismatch",
        "host id has an in-flight launch for another run spec",
      );
    }
    if (active) await active.promise.catch(() => undefined);
    const record = this.readRecord(hostId);
    if (!record) {
      throw new CoordinatorError(
        "invalid_host",
        "executor has no launch record for this host",
      );
    }
    if (record.specHash !== specHash) {
      throw new CoordinatorError(
        "spec_hash_mismatch",
        "host id is already bound to another run spec",
      );
    }
    await this.deps.stop(hostId);
    this.record({
      hostId,
      specHash,
      state: "stopped",
      unit: runHostUnitName(hostId),
      updatedAt: this.deps.now(),
    });
    return this.status(hostId);
  }

  private async waitReady(dir: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.deps.hostReady(dir)) return;
      await Bun.sleep(100);
    }
    throw new Error("run host did not become ready before the launch deadline");
  }

  private recordStarted(hostId: string, specHash: string): void {
    this.record({
      hostId,
      specHash,
      state: "started",
      unit: runHostUnitName(hostId),
      updatedAt: this.deps.now(),
    });
  }

  private record(record: LaunchRecord): void {
    writeJsonAtomic(this.recordPath(record.hostId), record);
  }

  private readRecord(hostId: string): LaunchRecord | null {
    return readJson<LaunchRecord>(this.recordPath(hostId));
  }

  private recordPath(hostId: string): string {
    return `${this.hostsDir}/${hostId}/executor.json`;
  }

  private error(
    requestId: string,
    code: Extract<ExecutorResponse, { ok: false }>["code"],
    error: string,
  ): ExecutorResponse {
    return {
      requestId,
      ok: false,
      version: EXECUTOR_PROTOCOL_VERSION,
      code,
      error,
    };
  }

  async drain(): Promise<void> {
    await Promise.allSettled([
      ...[...this.inflight.values()].map((entry) => entry.promise),
      ...[...this.stopping.values()].map((entry) => entry.promise),
    ]);
  }

  closeAdmission(): void {
    this.accepting = false;
  }
}

class CoordinatorError extends Error {
  constructor(
    readonly code: Extract<ExecutorResponse, { ok: false }>["code"],
    message: string,
  ) {
    super(message);
  }
}

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function secureEqual(actual: string, expected: Buffer): boolean {
  const a = Buffer.from(actual || "");
  return (
    a.length === expected.length && a.length > 0 && timingSafeEqual(a, expected)
  );
}
