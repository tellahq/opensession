/**
 * Workspace Runner registry.
 *
 * A Runner is a deliberately trusted, persistent machine.  This module owns
 * its durable identity and policy only; the outbound control channel lives in
 * runner-ws.ts.  Tokens are one-time pairing material followed by a hashed
 * long-lived credential.  Never put the latter in a session record or a URL.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { existsSync, readFileSync } from "fs";
import { randomUUIDv7 } from "bun";
import { statePath } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import { isTailnetAddress, normalizeAddress } from "./shared/network-address";

export { isTailnetAddress, normalizeAddress } from "./shared/network-address";

export type RunnerPlatform = "darwin" | "linux" | "win32";
export type RunnerState = "online" | "busy" | "offline" | "maintenance";
export type RunnerExecutionPermissions = {
  commands: boolean;
  fullSessions: boolean;
  terminals: boolean;
  portals: boolean;
  /** Explicit operator assertion that descendant runs use a separate OS
   * identity/filesystem and cannot read host credentials. */
  automationDescendants: boolean;
};

export type RunnerResources = {
  cpuCores?: number;
  memoryGb?: number;
  freeDiskGb?: number;
  gpu?: {
    kind: "nvidia" | "amd" | "apple" | "intel" | "other";
    model?: string;
    vramGb?: number;
    driver?: string;
    cuda?: string;
    metal?: boolean;
    rocm?: string;
  };
  concurrentJobs?: number;
  localInference?: Array<{
    runtime: "ollama" | "vllm" | "llama-cpp" | "other";
    models: string[];
  }>;
};

export type RunnerCapabilities = {
  platform: RunnerPlatform;
  toolchains: string[];
  hardware?: RunnerResources;
  tags: string[];
};

export type RunnerReservation = {
  sessionId?: string;
  reason: string;
  reservedBy?: string;
  expiresAt: string;
};

/** Operator-supplied migration context. This is diagnostic metadata only: it
 * carries no SSH key, kubeconfig, pairing token, or runtime authority. */
export type RunnerMigration =
  | { kind: "ssh"; label: string; host: string; user: string; port: number }
  | {
      kind: "kubernetes";
      label: string;
      context: string;
      namespace: string;
      workload: string;
    };

export type RunnerInferenceTask = "chat" | "embedding" | "image" | "video";
/** Local inference is opt-in. Presence of Ollama/vLLM on a Runner never
 * authorizes model traffic until an admin enables a narrow policy. */
export type RunnerLocalInferencePolicy = {
  enabled: boolean;
  allowedUsers: string[];
  allowedModels: string[];
  allowedTasks: RunnerInferenceTask[];
};

export type Runner = {
  id: string;
  name: string;
  platform: RunnerPlatform;
  arch: string;
  address: string;
  tokenHash: string;
  createdAt: string;
  createdBy?: string;
  lastSeenAt?: string;
  softwareVersion?: string;
  label?: string;
  description?: string;
  location?: string;
  capabilities: RunnerCapabilities;
  resources?: RunnerResources;
  permissions: RunnerExecutionPermissions;
  allowedUsers: string[];
  allowedRepos: string[];
  workspaceRoots: string[];
  /** Session workspaces are retained by default. Deletion is an explicit
   * administrator policy because a Runner may hold unpushed work. */
  workspaceRetention?: "retain" | "delete";
  migration?: RunnerMigration;
  localInferencePolicy?: RunnerLocalInferencePolicy;
  maintenance?: boolean;
  reservation?: RunnerReservation;
  workload?: { sessionId?: string; operation?: string; startedAt?: string };
  /** Durable active claims. `workload` is retained as the primary display
   * summary while older runner records migrate in place. */
  workloads?: Array<{
    sessionId?: string;
    operation?: string;
    startedAt?: string;
  }>;
};

type Store = { runners: Runner[] };
type Pairing = {
  code: string;
  expiresAt: number;
  createdBy?: string;
  migration?: RunnerMigration;
};

function storePath(): string {
  return statePath(".opensession-runners.json");
}

function load(): Store {
  if (!existsSync(storePath())) return { runners: [] };
  try {
    const parsed = JSON.parse(readFileSync(storePath(), "utf8"));
    return Array.isArray(parsed?.runners)
      ? { runners: parsed.runners.map(normalizeRunner) }
      : { runners: [] };
  } catch {
    return { runners: [] };
  }
}

function save(store: Store): void {
  writeJsonAtomic(storePath(), store);
}

function cleanStrings(value: unknown, max = 64): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map(String)
        .map((v) => v.trim())
        .filter((v) => v && v.length <= max),
    ),
  ].slice(0, 64);
}

function defaultPermissions(): RunnerExecutionPermissions {
  return {
    commands: true,
    fullSessions: false,
    terminals: false,
    portals: false,
    automationDescendants: false,
  };
}

function normalizeInferencePolicy(
  value: unknown,
): RunnerLocalInferencePolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const raw = value as Record<string, unknown>;
  const allowedTasks = cleanStrings(raw.allowedTasks).filter(
    (task): task is RunnerInferenceTask =>
      ["chat", "embedding", "image", "video"].includes(task),
  );
  return {
    enabled: raw.enabled === true,
    allowedUsers: cleanStrings(raw.allowedUsers),
    allowedModels: cleanStrings(raw.allowedModels, 160),
    allowedTasks,
  };
}

function normalizeResources(value: unknown): RunnerResources | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const raw = value as Record<string, unknown>;
  const number = (key: string) =>
    typeof raw[key] === "number" && Number.isFinite(raw[key]) && raw[key] >= 0
      ? raw[key]
      : undefined;
  let gpu: RunnerResources["gpu"];
  if (raw.gpu && typeof raw.gpu === "object" && !Array.isArray(raw.gpu)) {
    const candidate = raw.gpu as Record<string, unknown>;
    const kind = ["nvidia", "amd", "apple", "intel", "other"].includes(
      String(candidate.kind),
    )
      ? (String(candidate.kind) as NonNullable<RunnerResources["gpu"]>["kind"])
      : "other";
    gpu = {
      kind,
      ...(typeof candidate.model === "string" && candidate.model.length <= 160
        ? { model: candidate.model }
        : {}),
      ...(typeof candidate.vramGb === "number" && candidate.vramGb >= 0
        ? { vramGb: candidate.vramGb }
        : {}),
      ...(typeof candidate.driver === "string" && candidate.driver.length <= 120
        ? { driver: candidate.driver }
        : {}),
      ...(typeof candidate.cuda === "string" && candidate.cuda.length <= 80
        ? { cuda: candidate.cuda }
        : {}),
      ...(typeof candidate.rocm === "string" && candidate.rocm.length <= 80
        ? { rocm: candidate.rocm }
        : {}),
      ...(typeof candidate.metal === "boolean"
        ? { metal: candidate.metal }
        : {}),
    };
  }
  const result = {
    ...(number("cpuCores") !== undefined
      ? { cpuCores: number("cpuCores") }
      : {}),
    ...(number("memoryGb") !== undefined
      ? { memoryGb: number("memoryGb") }
      : {}),
    ...(number("freeDiskGb") !== undefined
      ? { freeDiskGb: number("freeDiskGb") }
      : {}),
    ...(number("concurrentJobs") !== undefined
      ? { concurrentJobs: number("concurrentJobs") }
      : {}),
    ...(gpu ? { gpu } : {}),
    ...(Array.isArray(raw.localInference)
      ? {
          localInference: raw.localInference.flatMap(
            (value): NonNullable<RunnerResources["localInference"]> => {
              if (!value || typeof value !== "object" || Array.isArray(value))
                return [];
              const item = value as Record<string, unknown>;
              const runtime = ["ollama", "vllm", "llama-cpp", "other"].includes(
                String(item.runtime),
              )
                ? (String(item.runtime) as NonNullable<
                    RunnerResources["localInference"]
                  >[number]["runtime"])
                : "other";
              return [
                {
                  runtime,
                  models: cleanStrings(item.models, 160).slice(0, 64),
                },
              ];
            },
          ),
        }
      : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

function normalizeRunner(value: Runner): Runner {
  const raw = value as unknown as Record<string, unknown>;
  const platform: RunnerPlatform = ["darwin", "linux", "win32"].includes(
    String(raw.platform),
  )
    ? (raw.platform as RunnerPlatform)
    : "linux";
  const legacyCapabilities = cleanStrings(raw.capabilities);
  const capabilities =
    raw.capabilities &&
    typeof raw.capabilities === "object" &&
    !Array.isArray(raw.capabilities)
      ? (raw.capabilities as Record<string, unknown>)
      : {};
  const permissions =
    raw.permissions && typeof raw.permissions === "object"
      ? (raw.permissions as Record<string, unknown>)
      : {};
  const workloads = Array.isArray(raw.workloads)
    ? raw.workloads
        .filter(
          (item): item is NonNullable<Runner["workload"]> =>
            !!item && typeof item === "object",
        )
        .slice(0, 64)
    : value.workload
      ? [value.workload]
      : [];
  return {
    ...value,
    platform,
    capabilities: {
      platform,
      toolchains: cleanStrings(capabilities.toolchains ?? legacyCapabilities),
      tags: cleanStrings(capabilities.tags ?? raw.tags),
      ...(normalizeResources(capabilities.hardware)
        ? { hardware: normalizeResources(capabilities.hardware) }
        : {}),
    },
    ...(normalizeResources(raw.resources)
      ? { resources: normalizeResources(raw.resources) }
      : {}),
    permissions: {
      commands: permissions.commands !== false,
      // Runner full sessions remain disabled until the isolated execution
      // implementation ships. The automation flag records operator policy but
      // cannot reactivate this separate execution gate.
      fullSessions: false,
      terminals: false,
      portals: false,
      automationDescendants: permissions.automationDescendants === true,
    },
    allowedUsers: cleanStrings(raw.allowedUsers),
    allowedRepos: cleanStrings(raw.allowedRepos),
    workspaceRoots: cleanStrings(raw.workspaceRoots, 512),
    ...(workloads.length ? { workloads, workload: workloads[0] } : {}),
    ...(normalizeInferencePolicy(raw.localInferencePolicy)
      ? {
          localInferencePolicy: normalizeInferencePolicy(
            raw.localInferencePolicy,
          ),
        }
      : {}),
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const g = globalThis as Record<string, unknown>;
const pairings: Map<string, Pairing> = (g.__opensessionRunnerPairings ??=
  new Map()) as Map<string, Pairing>;
const PAIRING_TTL_MS = 10 * 60_000;

function pairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const raw = randomBytes(12);
  const chars = Array.from(raw, (b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}`;
}

export function createRunnerPairing(createdBy?: string): {
  code: string;
  expiresAt: number;
} {
  const code = pairingCode();
  const expiresAt = Date.now() + PAIRING_TTL_MS;
  pairings.set(code, { code, expiresAt, createdBy });
  return { code, expiresAt };
}

/** Attach preconfigured migration diagnostics to an existing one-time code.
 * It is set only by the admin bootstrap flow before the Runner registers. */
export function bindRunnerPairingMigration(
  code: string,
  migration: RunnerMigration,
): boolean {
  const pairing = pairings.get(code);
  if (!pairing || pairing.expiresAt <= Date.now()) {
    pairings.delete(code);
    return false;
  }
  pairing.migration = migration;
  return true;
}

export function listRunnerPairings(): Pairing[] {
  for (const [code, value] of pairings)
    if (value.expiresAt <= Date.now()) pairings.delete(code);
  return [...pairings.values()];
}

/** Bootstrap failures must not leave an unseen pairing credential live. */
export function discardRunnerPairing(code: string): void {
  pairings.delete(code);
}

function redeemPairing(code: string): Pairing | undefined {
  const pairing = pairings.get(code.trim().toUpperCase());
  if (!pairing) return undefined;
  pairings.delete(pairing.code);
  return pairing.expiresAt > Date.now() ? pairing : undefined;
}

export function listRunners(): Runner[] {
  return load().runners;
}

export function getRunner(id: string): Runner | undefined {
  return load().runners.find((runner) => runner.id === id);
}

export type RegisterRunnerInput = {
  code: string;
  name: string;
  platform: RunnerPlatform;
  arch: string;
  capabilities?: Partial<RunnerCapabilities> | string[];
  resources?: RunnerResources;
  label?: string;
  description?: string;
  address: string;
  softwareVersion?: string;
};

export function registerRunner(
  input: RegisterRunnerInput,
): { ok: true; runner: Runner; token: string } | { ok: false; error: string } {
  if (!isTailnetAddress(input.address))
    return { ok: false, error: "Runners must connect from the tailnet." };
  const pairing = redeemPairing(input.code);
  if (!pairing)
    return { ok: false, error: "Pairing code is invalid or expired." };
  const name = input.name.trim();
  if (!name || name.length > 120)
    return { ok: false, error: "Runner name is required." };
  const token = randomBytes(32).toString("hex");
  const store = load();
  const existingIndex = store.runners.findIndex(
    (runner) => runner.name === name && runner.platform === input.platform,
  );
  const existing =
    existingIndex >= 0 ? store.runners[existingIndex] : undefined;
  const capabilityInput = Array.isArray(input.capabilities)
    ? { toolchains: input.capabilities }
    : (input.capabilities ?? {});
  const runner = normalizeRunner({
    id: existing?.id ?? `runner-${randomUUIDv7()}`,
    name,
    platform: input.platform,
    arch: input.arch.trim() || "unknown",
    address: normalizeAddress(input.address),
    tokenHash: hashToken(token),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    createdBy: pairing.createdBy,
    label: input.label?.trim() || existing?.label,
    description: input.description?.trim() || existing?.description,
    softwareVersion: input.softwareVersion?.trim() || existing?.softwareVersion,
    capabilities: {
      platform: input.platform,
      toolchains: cleanStrings(capabilityInput.toolchains),
      tags: cleanStrings(capabilityInput.tags),
      ...(normalizeResources(capabilityInput.hardware)
        ? { hardware: normalizeResources(capabilityInput.hardware) }
        : {}),
    },
    resources: input.resources,
    permissions: existing?.permissions ?? defaultPermissions(),
    allowedUsers: existing?.allowedUsers ?? [],
    allowedRepos: existing?.allowedRepos ?? [],
    workspaceRoots: existing?.workspaceRoots ?? [],
    migration: pairing.migration ?? existing?.migration,
    localInferencePolicy: existing?.localInferencePolicy,
    maintenance: existing?.maintenance,
  });
  if (existingIndex >= 0) store.runners[existingIndex] = runner;
  else store.runners.push(runner);
  save(store);
  return { ok: true, runner, token };
}

export function authenticateRunner(
  id: string,
  token: string,
): Runner | undefined {
  const runner = getRunner(id);
  if (!runner) return undefined;
  const expected = Buffer.from(runner.tokenHash, "hex");
  const actual = Buffer.from(hashToken(token), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual)
    ? runner
    : undefined;
}

export type RunnerPatch = Partial<
  Pick<
    Runner,
    | "label"
    | "description"
    | "location"
    | "maintenance"
    | "allowedUsers"
    | "allowedRepos"
    | "workspaceRoots"
    | "resources"
    | "localInferencePolicy"
  >
> & {
  workspaceRetention?: "retain" | "delete";
  permissions?: Partial<RunnerExecutionPermissions>;
  capabilities?: Partial<RunnerCapabilities>;
};

export function updateRunner(
  id: string,
  patch: RunnerPatch,
): Runner | undefined {
  const store = load();
  const index = store.runners.findIndex((runner) => runner.id === id);
  if (index < 0) return undefined;
  const current = store.runners[index];
  store.runners[index] = normalizeRunner({
    ...current,
    ...patch,
    workspaceRetention:
      patch.workspaceRetention === "delete"
        ? "delete"
        : patch.workspaceRetention === "retain"
          ? "retain"
          : (current.workspaceRetention ?? "retain"),
    permissions: { ...current.permissions, ...patch.permissions },
    capabilities: { ...current.capabilities, ...patch.capabilities },
  });
  save(store);
  return store.runners[index];
}

export function touchRunner(
  id: string,
  patch: Partial<
    Pick<Runner, "softwareVersion" | "capabilities" | "resources">
  > = {},
): void {
  const store = load();
  const runner = store.runners.find((candidate) => candidate.id === id);
  if (!runner) return;
  runner.lastSeenAt = new Date().toISOString();
  if (patch.softwareVersion) runner.softwareVersion = patch.softwareVersion;
  if (patch.capabilities)
    runner.capabilities = normalizeRunner({
      ...runner,
      capabilities: patch.capabilities,
    }).capabilities;
  if (patch.resources) runner.resources = normalizeResources(patch.resources);
  save(store);
}

export function setRunnerWorkload(
  id: string,
  workload?: Runner["workload"],
  clearSessionId?: string,
): void {
  const store = load();
  const runner = store.runners.find((candidate) => candidate.id === id);
  if (!runner) return;
  const previous =
    runner.workloads ?? (runner.workload ? [runner.workload] : []);
  const next = workload?.sessionId
    ? [
        ...previous.filter((item) => item.sessionId !== workload.sessionId),
        workload,
      ]
    : clearSessionId
      ? previous.filter((item) => item.sessionId !== clearSessionId)
      : [];
  runner.workloads = next;
  runner.workload = next[0];
  if (!next.length) {
    delete runner.workload;
    delete runner.workloads;
  }
  save(store);
}

/** Atomically check and claim one capacity slot. The registry is single-writer
 * in this server process, so this synchronous load/mutate/save sequence cannot
 * interleave with another turn between eligibility and reservation. */
export function claimRunnerWorkload(
  id: string,
  input: {
    user?: string;
    repo?: string;
    sessionId: string;
    operation: string;
    automationDescendant?: boolean;
  },
): Runner | undefined {
  const store = load();
  const runner = store.runners.find((candidate) => candidate.id === id);
  if (!runner || !runnerAvailableForSession(runner, input)) return undefined;
  const previous =
    runner.workloads ?? (runner.workload ? [runner.workload] : []);
  if (!previous.some((workload) => workload.sessionId === input.sessionId)) {
    const next = [
      ...previous,
      {
        sessionId: input.sessionId,
        operation: input.operation,
        startedAt: new Date().toISOString(),
      },
    ];
    runner.workloads = next;
    runner.workload = next[0];
    save(store);
  }
  return runner;
}

export function reserveRunner(
  id: string,
  input: Omit<RunnerReservation, "expiresAt"> & { durationMinutes?: number },
): Runner | undefined {
  const store = load();
  const runner = store.runners.find((candidate) => candidate.id === id);
  if (!runner || runner.maintenance) return undefined;
  const now = Date.now();
  if (
    runner.reservation &&
    Date.parse(runner.reservation.expiresAt) > now &&
    runner.reservation.reservedBy !== input.reservedBy
  )
    return undefined;
  const minutes = Math.min(Math.max(input.durationMinutes ?? 60, 1), 24 * 60);
  runner.reservation = {
    sessionId: input.sessionId,
    reason: input.reason.trim().slice(0, 240),
    reservedBy: input.reservedBy,
    expiresAt: new Date(now + minutes * 60_000).toISOString(),
  };
  save(store);
  return runner;
}

export function releaseRunnerReservation(
  id: string,
  reservedBy?: string,
): Runner | undefined {
  const store = load();
  const runner = store.runners.find((candidate) => candidate.id === id);
  if (
    !runner ||
    (reservedBy &&
      runner.reservation?.reservedBy &&
      runner.reservation.reservedBy !== reservedBy)
  )
    return undefined;
  delete runner.reservation;
  save(store);
  return runner;
}

export function removeRunner(id: string): boolean {
  const store = load();
  const runners = store.runners.filter((runner) => runner.id !== id);
  if (runners.length === store.runners.length) return false;
  save({ runners });
  return true;
}

export function runnerAllowed(
  runner: Runner,
  input: {
    user?: string;
    repo?: string;
    permission: keyof RunnerExecutionPermissions;
  },
): boolean {
  if (runner.maintenance || !runner.permissions[input.permission]) return false;
  if (
    runner.allowedUsers.length &&
    (!input.user || !runner.allowedUsers.includes(input.user))
  )
    return false;
  if (
    runner.allowedRepos.length &&
    (!input.repo || !runner.allowedRepos.includes(input.repo))
  )
    return false;
  return true;
}

/** Eligibility gate for a future local-model caller. It deliberately returns
 * false for a merely detected runtime, for unconstrained tasks, and for a
 * user outside the policy. No generic Runner network proxy is involved. */
export function runnerAllowsLocalInference(
  runner: Runner,
  input: { user?: string; model: string; task: RunnerInferenceTask },
): boolean {
  const policy = runner.localInferencePolicy;
  if (
    !policy?.enabled ||
    !runner.resources?.localInference?.length ||
    runner.maintenance
  )
    return false;
  if (
    policy.allowedUsers.length &&
    (!input.user || !policy.allowedUsers.includes(input.user))
  )
    return false;
  if (!policy.allowedTasks.includes(input.task)) return false;
  return policy.allowedModels.includes(input.model);
}

/** Server-selected, session-owned workspace path. Keep all path construction
 * here so Windows Runners never inherit Unix separator assumptions. */
export function runnerWorkspacePath(runner: Runner, sessionId: string): string {
  const root = runner.workspaceRoots[0] ?? "";
  const separator = runner.platform === "win32" ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}sessions${separator}${sessionId}`;
}

export function runnerOwnsWorkspace(
  runner: Runner,
  workspacePath: string,
  sessionId: string,
): boolean {
  const separator = runner.platform === "win32" ? "\\" : "/";
  return runner.workspaceRoots.some(
    (root) =>
      workspacePath ===
      `${root.replace(/[\\/]+$/, "")}${separator}sessions${separator}${sessionId}`,
  );
}

/** Server-side scheduling gate for a full session. A reservation belongs to
 * its recorded session only. One live workload is intentionally conservative
 * until multi-host capacity accounting is available on the Runner channel. */
export function runnerAvailableForSession(
  runner: Runner,
  input: {
    user?: string;
    repo?: string;
    sessionId: string;
    automationDescendant?: boolean;
  },
): boolean {
  const permission = input.automationDescendant
    ? "automationDescendants"
    : "fullSessions";
  if (!runnerAllowed(runner, { ...input, permission })) return false;
  const reservation = runner.reservation;
  if (
    reservation &&
    Date.parse(reservation.expiresAt) > Date.now() &&
    reservation.sessionId &&
    reservation.sessionId !== input.sessionId
  )
    return false;
  const workloads =
    runner.workloads ?? (runner.workload ? [runner.workload] : []);
  if (workloads.some((workload) => workload.sessionId === input.sessionId))
    return true;
  const capacity = Math.max(
    1,
    Math.floor(runner.resources?.concurrentJobs ?? 1),
  );
  return workloads.length < capacity;
}

export function publicRunner(
  runner: Runner,
  online: boolean,
  busy = false,
): Omit<Runner, "tokenHash"> & { state: RunnerState } {
  const { tokenHash: _tokenHash, reservation, ...rest } = runner;
  const activeReservation =
    reservation && Date.parse(reservation.expiresAt) > Date.now()
      ? reservation
      : undefined;
  return {
    ...rest,
    ...(activeReservation ? { reservation: activeReservation } : {}),
    state: runner.maintenance
      ? "maintenance"
      : busy
        ? "busy"
        : online
          ? "online"
          : "offline",
  };
}
