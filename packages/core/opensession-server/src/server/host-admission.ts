/**
 * Resource-aware admission for detached run-host launches.
 *
 * Every accepted prompt used to launch its engine process unconditionally,
 * so the first hard wall under load was the machine itself: nothing stopped
 * the Nth engine from exhausting memory and taking the gateway and kernel
 * down with the agents. Before each launch the gateway now checks live
 * capacity — MemAvailable, CPU pressure (PSI), and the active host count —
 * and waits with bounded backoff instead of starting into an overload.
 *
 * Waiting is deliberately in-memory: the prompt's queue claim and run journal
 * are already durable, so a crash while waiting re-admits the same turn.
 * Missing signals fail open (a machine without /proc must not stop launches);
 * present signals fail the launch closed only after the configured patience
 * runs out, with a distinct error type so callers do not "fall back" to an
 * in-process run that would consume the same scarce memory.
 *
 * Gateway process: knobs read ~/.opensession.env (or a drop-in on
 * opensession.service).
 */
import { readFile } from "node:fs/promises";
import { audit } from "./audit";
import { envCapacity } from "./shared/env-capacity";

export type HostAdmissionLimits = {
  /** Hard cap on concurrently active detached hosts. */
  maxActiveHosts: number;
  /** MemAvailable floor that must remain after reserving the new host. */
  minAvailableMb: number;
  /** Expected worst-typical footprint reserved for the host being admitted. */
  reservedPerHostMb: number;
  /** Maximum acceptable CPU PSI some avg10 percentage. */
  maxCpuPressure: number;
  /** How long a launch may wait for capacity before failing closed. */
  admissionTimeoutMs: number;
};

export function hostAdmissionLimits(): HostAdmissionLimits {
  return {
    maxActiveHosts: envCapacity(
      "OPENSESSION_RUN_HOST_MAX_ACTIVE",
      128,
      1,
      4_096,
    ),
    minAvailableMb: envCapacity(
      "OPENSESSION_RUN_HOST_MIN_AVAILABLE_MB",
      4_096,
      256,
      1_048_576,
    ),
    reservedPerHostMb: envCapacity(
      "OPENSESSION_RUN_HOST_RESERVED_MB",
      1_024,
      0,
      65_536,
    ),
    maxCpuPressure: envCapacity(
      "OPENSESSION_RUN_HOST_MAX_CPU_PRESSURE",
      85,
      1,
      100,
    ),
    admissionTimeoutMs:
      envCapacity("OPENSESSION_RUN_HOST_ADMISSION_TIMEOUT_S", 900, 10, 86_400) *
      1_000,
  };
}

export type HostCapacitySnapshot = {
  /** MemAvailable in MiB, or null when the signal is unavailable. */
  memAvailableMb: number | null;
  /** CPU PSI `some avg10` percentage, or null when unavailable. */
  cpuSomeAvg10: number | null;
  /** Currently active detached hosts on this gateway. */
  activeHosts: number;
  /** Launches admitted but not yet reflected in MemAvailable. */
  pendingHosts: number;
};

export async function readMemAvailableMb(
  read: (path: string) => string | Promise<string> = readProcFile,
): Promise<number | null> {
  const match = /MemAvailable:\s+(\d+)\s*kB/.exec(await read("/proc/meminfo"));
  return match ? Math.floor(Number(match[1]) / 1_024) : null;
}

export async function readCpuSomeAvg10(
  read: (path: string) => string | Promise<string> = readProcFile,
): Promise<number | null> {
  const match = /some avg10=([\d.]+)/.exec(await read("/proc/pressure/cpu"));
  return match ? Number(match[1]) : null;
}

async function readProcFile(path: string): Promise<string> {
  try {
    // Failures (macOS, containers without PSI) simply disable that signal.
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export type AdmissionDecision =
  | { admit: true }
  | { admit: false; reason: string };

/** Pure decision: admit unless a *present* signal says the machine is full. */
export function decideRunHostAdmission(
  snapshot: HostCapacitySnapshot,
  limits: HostAdmissionLimits,
): AdmissionDecision {
  const admittedHosts = snapshot.activeHosts + snapshot.pendingHosts;
  if (admittedHosts >= limits.maxActiveHosts)
    return {
      admit: false,
      reason: `active and pending run hosts at cap (${admittedHosts}/${limits.maxActiveHosts})`,
    };
  const reservedMb = limits.reservedPerHostMb * (snapshot.pendingHosts + 1);
  if (
    snapshot.memAvailableMb !== null &&
    snapshot.memAvailableMb - reservedMb < limits.minAvailableMb
  )
    return {
      admit: false,
      reason: `MemAvailable ${snapshot.memAvailableMb}MiB would drop below the ${limits.minAvailableMb}MiB floor after reserving ${reservedMb}MiB`,
    };
  if (
    snapshot.cpuSomeAvg10 !== null &&
    snapshot.cpuSomeAvg10 > limits.maxCpuPressure
  )
    return {
      admit: false,
      reason: `CPU pressure some avg10 ${snapshot.cpuSomeAvg10}% exceeds ${limits.maxCpuPressure}%`,
    };
  return { admit: true };
}

/** Launch was refused because capacity never appeared within the timeout.
 * Callers must fail the turn visibly, not fall back to an in-process run. */
export class RunHostAdmissionError extends Error {
  constructor(reason: string) {
    super(`Run host launch refused: ${reason}`);
    this.name = "RunHostAdmissionError";
  }
}

export type WaitForAdmissionOptions = {
  sessionId: string;
  activeHosts: () => number;
  pendingHosts?: () => number;
  /** Reserve capacity synchronously with a successful decision. */
  onAdmit?: () => void;
  shouldCancel?: () => boolean;
  limits?: HostAdmissionLimits;
  snapshot?: (
    activeHosts: number,
    pendingHosts: number,
  ) => HostCapacitySnapshot | Promise<HostCapacitySnapshot>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

async function defaultSnapshot(
  activeHosts: number,
  pendingHosts: number,
): Promise<HostCapacitySnapshot> {
  const [memAvailableMb, cpuSomeAvg10] = await Promise.all([
    readMemAvailableMb(),
    readCpuSomeAvg10(),
  ]);
  return {
    memAvailableMb,
    cpuSomeAvg10,
    activeHosts,
    pendingHosts,
  };
}

/**
 * Wait until the machine can take one more run host. Returns "admitted" or
 * "cancelled"; throws RunHostAdmissionError when the timeout elapses while
 * the machine is still full.
 */
export async function waitForRunHostAdmission(
  options: WaitForAdmissionOptions,
): Promise<"admitted" | "cancelled"> {
  const limits = options.limits ?? hostAdmissionLimits();
  const snapshot = options.snapshot ?? defaultSnapshot;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = options.now ?? Date.now;
  const startedAt = now();
  let waited = false;
  let backoffMs = 1_000;
  let lastReason = "";
  for (;;) {
    if (options.shouldCancel?.()) return "cancelled";
    const decision = decideRunHostAdmission(
      await snapshot(options.activeHosts(), options.pendingHosts?.() ?? 0),
      limits,
    );
    if (decision.admit) {
      if (waited)
        audit({
          msg: "run_host_admission_resumed",
          session_id: options.sessionId,
          waited_ms: now() - startedAt,
        });
      // No await separates the final capacity check from this reservation.
      // Concurrent callers therefore see it in their own pendingHosts count.
      options.onAdmit?.();
      return "admitted";
    }
    if (!waited || decision.reason !== lastReason) {
      audit({
        msg: "run_host_admission_wait",
        session_id: options.sessionId,
        reason: decision.reason,
      });
      console.warn(
        `[host-admission] deferring run host launch for ${options.sessionId}: ${decision.reason}`,
      );
    }
    waited = true;
    lastReason = decision.reason;
    if (now() - startedAt >= limits.admissionTimeoutMs) {
      audit({
        msg: "run_host_admission_refused",
        session_id: options.sessionId,
        reason: decision.reason,
        waited_ms: now() - startedAt,
      });
      throw new RunHostAdmissionError(decision.reason);
    }
    const remainingMs = limits.admissionTimeoutMs - (now() - startedAt);
    await sleep(Math.min(backoffMs, remainingMs));
    backoffMs = Math.min(30_000, backoffMs * 2);
  }
}
