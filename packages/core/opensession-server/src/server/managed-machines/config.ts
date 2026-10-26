/**
 * Managed machines: `managedMachines` in config.json.
 *
 * A managed machine is a computer Open Session can turn on and off without
 * any Open Session software on it. An operator gives it commands that the
 * Open Session server runs: `start`, `stop`, `status` and, optionally,
 * `exec`, a prefix the agent's command is appended to as one final argument
 * (`ssh host --`, `kubectl exec -i pod -- bash -lc`). They are argv arrays,
 * run without a shell and with a minimal environment. Nothing a person or an
 * agent types is ever added to them; this file is their only input, and
 * neither workspace settings nor agents can change it.
 *
 * Imported by config.ts's parseConfig, so this module must not import it.
 */

export type IdlePolicy = {
  /** Stop after this many minutes of unbroken idle evidence. */
  minutes: number;
  /** CPU utilization (0-1) at or above this is activity. Required metric. */
  cpuBelow?: number;
  /** GPU utilization (0-1) at or above this is activity. Required metric. */
  gpuBelow?: number;
};

export type ManagedMachineConfig = {
  id: string;
  label: string;
  description?: string;
  start: string[];
  stop: string[];
  status: string[];
  /** Argv prefix; the command to run is appended as one more argument. */
  exec?: string[];
  /** Extra environment for the commands (PATH and HOME are passed). */
  env?: Record<string, string>;
  pollSeconds: number;
  commandTimeoutSeconds: number;
  /** Absent: never stopped automatically. */
  idle?: IdlePolicy;
  /** A start whose status has not reached `on` after this long is flagged. */
  startTimeoutMinutes: number;
  /** Empty: every signed-in teammate may start, stop and reserve it. */
  allowedUsers: string[];
};

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function num(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : undefined;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max
    ? value.trim()
    : undefined;
}

function argv(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 200)
    return undefined;
  const ok = value.every(
    (part) =>
      typeof part === "string" && part.length <= 4_000 && !part.includes("\0"),
  );
  return ok && (value[0] as string).trim() ? (value as string[]) : undefined;
}

export function parseManagedMachine(
  value: unknown,
): ManagedMachineConfig | { error: string } {
  const raw = record(value);
  if (!raw) return { error: "entry must be an object" };
  const id = text(raw.id, 63) ?? "";
  if (!ID.test(id))
    return { error: `id '${id}' must be lowercase letters, digits and dashes` };
  const start = argv(raw.start);
  const stop = argv(raw.stop);
  const status = argv(raw.status);
  if (!start || !stop || !status)
    return {
      error: `${id}: start, stop and status must be non-empty argv arrays, not shell strings`,
    };
  const exec = raw.exec === undefined ? undefined : argv(raw.exec);
  if (raw.exec !== undefined && !exec)
    return { error: `${id}: exec must be a non-empty argv array` };
  const envRaw = record(raw.env);
  const env = envRaw
    ? Object.fromEntries(
        Object.entries(envRaw).filter(
          (entry): entry is [string, string] =>
            ENV_NAME.test(entry[0]) && typeof entry[1] === "string",
        ),
      )
    : undefined;
  const minutes = num(raw.idleStopMinutes, 5, 7 * 24 * 60);
  const cpuBelow = num(raw.idleCpuBelow, 0.0001, 1_024);
  const gpuBelow = num(raw.idleGpuBelow, 0.0001, 1_024);
  if (minutes && cpuBelow === undefined && gpuBelow === undefined)
    return {
      error: `${id}: idleStopMinutes needs idleCpuBelow or idleGpuBelow, so a busy machine is never stopped on time alone`,
    };
  return {
    id,
    label: text(raw.label, 120) ?? id,
    ...(text(raw.description, 500)
      ? { description: text(raw.description, 500) }
      : {}),
    start,
    stop,
    status,
    ...(exec ? { exec } : {}),
    ...(env && Object.keys(env).length ? { env } : {}),
    pollSeconds: num(raw.pollSeconds, 15, 3_600) ?? 60,
    commandTimeoutSeconds: num(raw.commandTimeoutSeconds, 5, 3_600) ?? 120,
    ...(minutes
      ? {
          idle: {
            minutes,
            ...(cpuBelow !== undefined ? { cpuBelow } : {}),
            ...(gpuBelow !== undefined ? { gpuBelow } : {}),
          },
        }
      : {}),
    startTimeoutMinutes: num(raw.startTimeoutMinutes, 1, 24 * 60) ?? 20,
    allowedUsers: Array.isArray(raw.allowedUsers)
      ? [
          ...new Set(
            raw.allowedUsers
              .filter((user): user is string => typeof user === "string")
              .map((user) => user.trim())
              .filter(Boolean),
          ),
        ]
      : [],
  };
}

/** Parse `managedMachines`. Invalid entries are dropped with a warning. */
export function parseManagedMachines(value: unknown): ManagedMachineConfig[] {
  if (!Array.isArray(value)) return [];
  const machines: ManagedMachineConfig[] = [];
  for (const item of value) {
    const machine = parseManagedMachine(item);
    if ("error" in machine) {
      console.warn(`[config] managedMachines: ${machine.error}; entry ignored`);
      continue;
    }
    if (machines.some((existing) => existing.id === machine.id)) {
      console.warn(
        `[config] managedMachines: ${machine.id} is listed twice; later entry ignored`,
      );
      continue;
    }
    machines.push(machine);
  }
  return machines;
}
