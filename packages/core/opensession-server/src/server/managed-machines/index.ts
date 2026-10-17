/**
 * Managed machines: computers Open Session starts, stops, polls and runs
 * commands on through operator-configured commands, with no Open Session
 * software on the machine itself (config.ts).
 *
 * The poller runs each machine's `status` command every `pollSeconds`. Idle
 * stops follow idle.ts: a machine is stopped only after a full idle period of
 * successful polls that all said `on` with CPU/GPU below the thresholds, with
 * no exec in flight and no reservation. Anything unknown keeps it on and is
 * shown as `attention`. A failed start or stop is kept as the last action and
 * shown as an error until the next one succeeds.
 *
 * Runs in the gateway. Commands are async subprocesses. No timers start at
 * import; boot calls startManagedMachines().
 */

import { audit } from "../audit";
import { getConfig, getConfigAsync } from "../config";
import type { ManagedMachineConfig } from "./config";
import {
  decideIdle,
  ingestPoll,
  parseStatusOutput,
  resetIdle,
  type IdleDecision,
  type IdleEvidence,
  type PollResult,
} from "./idle";
import { runCommand, type CommandResult, type CommandRunner } from "./run";
import {
  loadMachineStore,
  machineRecord,
  patchMachineRecord,
  type MachineAction,
  type Reservation,
} from "./store";

export type MachineViewState =
  | "off"
  | "starting"
  | "on"
  | "stopping"
  | "unknown";

export type ManagedMachineView = {
  id: string;
  label: string;
  description?: string;
  state: MachineViewState;
  detail?: string;
  cpu?: number;
  gpu?: number;
  lastPollAt?: string;
  lastPollError?: string;
  pollSeconds: number;
  idle?:
    | { minutes: number; kind: "held"; reasons: string[] }
    | { minutes: number; kind: "not-idle"; reason: string }
    | { minutes: number; kind: "idle"; since: string; stopAt: string };
  reservation?: Reservation;
  lastAction?: MachineAction;
  /** A start or stop command is running now. */
  acting?: "start" | "stop";
  execAvailable: boolean;
  execInFlight: number;
  /** The machine may be costing money and will not stop on its own. */
  attention?: string;
  allowed: boolean;
};

type Live = {
  lastPoll?: PollResult;
  evidence: IdleEvidence;
  decision?: IdleDecision;
  polling?: Promise<void>;
  acting?: "start" | "stop";
  execInFlight: number;
  /** No idle stop retry before this, after a failed one. */
  idleRetryAt?: number;
};

type Deps = { run: CommandRunner; now: () => number };

const g = globalThis as Record<string, unknown>;
type Registry = {
  deps: Deps;
  machines: Map<string, Live>;
  timer?: ReturnType<typeof setInterval>;
};
const registry: Registry = (g.__opensessionManagedMachines ??= {
  deps: { run: runCommand, now: Date.now },
  machines: new Map(),
}) as Registry;

const TICK_MS = 15_000;
const STOP_STUCK_MS = 10 * 60_000;
const IDLE_RETRY_MS = 10 * 60_000;

export function setManagedMachineDepsForTests(deps: Partial<Deps>): void {
  registry.deps = { run: runCommand, now: Date.now, ...deps };
  registry.machines.clear();
}

export class MachineError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function configuredMachines(): ManagedMachineConfig[] {
  return getConfig().managedMachines ?? [];
}

async function machinesAsync(): Promise<ManagedMachineConfig[]> {
  return (await getConfigAsync()).managedMachines ?? [];
}

function live(id: string): Live {
  let entry = registry.machines.get(id);
  if (!entry) {
    entry = { evidence: {}, execInFlight: 0 };
    registry.machines.set(id, entry);
  }
  return entry;
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

/** Longest a run of polls may pause and still count as unbroken. */
export function maxGapMs(machine: ManagedMachineConfig): number {
  return Math.max(
    3 * machine.pollSeconds * 1_000,
    (machine.pollSeconds + machine.commandTimeoutSeconds) * 1_000,
  );
}

export function machineAllows(
  machine: ManagedMachineConfig,
  user: string | undefined,
): boolean {
  return (
    !machine.allowedUsers.length ||
    (!!user && machine.allowedUsers.includes(user))
  );
}

function activeReservation(id: string, now: number): Reservation | undefined {
  const reservation = machineRecord(id).reservation;
  return reservation && Date.parse(reservation.expiresAt) > now
    ? reservation
    : undefined;
}

/** Why the machine must not be stopped right now. */
export function machineHolds(id: string, exceptReservedBy?: string): string[] {
  const now = registry.deps.now();
  const entry = live(id);
  const holds: string[] = [];
  if (entry.execInFlight)
    holds.push(
      `${entry.execInFlight} command${entry.execInFlight === 1 ? "" : "s"} running through Open Session`,
    );
  if (entry.acting === "start") holds.push("Starting");
  const reservation = activeReservation(id, now);
  if (
    reservation &&
    !(exceptReservedBy && reservation.reservedBy === exceptReservedBy)
  )
    holds.push(
      `Reserved${reservation.reservedBy ? ` by ${reservation.reservedBy}` : ""}: ${reservation.reason}`,
    );
  return holds;
}

function failure(result: CommandResult, what: string): string {
  if (result.timedOut) return `${what} timed out.`;
  const stderr = result.stderr.trim().split("\n").slice(-5).join("\n");
  return `${what} exited ${result.code}${stderr ? `: ${stderr.slice(0, 600)}` : "."}`;
}

function commandEnv(machine: ManagedMachineConfig): Record<string, string> {
  return { ...machine.env, OPENSESSION_MACHINE_ID: machine.id };
}

/** Run the status command once and fold the result in. */
export function pollMachine(machine: ManagedMachineConfig): Promise<void> {
  const entry = live(machine.id);
  entry.polling ??= (async () => {
    try {
      const result = await registry.deps.run(machine.status, {
        env: commandEnv(machine),
        timeoutMs: machine.commandTimeoutSeconds * 1_000,
        maxOutput: 64_000,
      });
      const at = registry.deps.now();
      let poll: PollResult;
      if (result.code !== 0)
        poll = { ok: false, at, error: failure(result, "The status command") };
      else {
        const report = parseStatusOutput(result.stdout);
        poll =
          typeof report === "string"
            ? { ok: false, at, error: report }
            : { ok: true, at, report };
      }
      entry.lastPoll = poll;
      if (machine.idle)
        entry.evidence = ingestPoll(entry.evidence, {
          poll,
          policy: machine.idle,
          holds: machineHolds(machine.id),
          maxGapMs: maxGapMs(machine),
        });
      await maybeIdleStop(machine);
    } finally {
      entry.polling = undefined;
    }
  })();
  return entry.polling;
}

async function maybeIdleStop(machine: ManagedMachineConfig): Promise<void> {
  const entry = live(machine.id);
  const now = registry.deps.now();
  // Holds, decision and the stop mark are one synchronous block, so no exec
  // can start between "nothing is running" and "stopping".
  const decision = decideIdle({
    now,
    policy: machine.idle,
    maxGapMs: maxGapMs(machine),
    holds: machineHolds(machine.id),
    evidence: entry.evidence,
  });
  entry.decision = decision;
  if (decision.kind !== "idle" || !decision.stop || entry.acting) return;
  if (entry.idleRetryAt && now < entry.idleRetryAt) return;
  audit({
    msg: "managed_machine_idle_stop",
    machine_id: machine.id,
    idle_since: iso(decision.since),
    idle_minutes: machine.idle?.minutes,
  });
  console.log(
    `[managed-machines] stopping ${machine.id}: idle since ${iso(decision.since)}`,
  );
  const ok = await runPowerCommand(machine, "stop", { via: "idle" });
  entry.idleRetryAt = ok ? undefined : now + IDLE_RETRY_MS;
}

/** Run start or stop. The caller has done every check. */
async function runPowerCommand(
  machine: ManagedMachineConfig,
  kind: "start" | "stop",
  input: { via: MachineAction["via"]; user?: string },
): Promise<boolean> {
  const entry = live(machine.id);
  entry.acting = kind;
  entry.evidence = resetIdle(
    entry.evidence,
    kind === "start" ? "Started recently." : "Stop requested.",
  );
  const action: MachineAction = {
    kind,
    at: iso(registry.deps.now()),
    via: input.via,
    ...(input.user ? { by: input.user } : {}),
  };
  await patchMachineRecord(machine.id, { lastAction: action });
  let error: string | undefined;
  try {
    const result = await registry.deps.run(machine[kind], {
      env: commandEnv(machine),
      timeoutMs: machine.commandTimeoutSeconds * 1_000,
    });
    if (result.code !== 0) error = failure(result, `The ${kind} command`);
  } catch (caught) {
    error = (caught as Error).message;
  } finally {
    entry.acting = undefined;
  }
  await patchMachineRecord(machine.id, {
    lastAction: { ...action, ok: !error, ...(error ? { error } : {}) },
  });
  audit({
    msg: `managed_machine_${kind}`,
    machine_id: machine.id,
    user: input.user,
    via: input.via,
    outcome: error ? "error" : "ok",
  });
  if (error)
    console.error(`[managed-machines] ${kind} ${machine.id}: ${error}`);
  void pollMachine(machine);
  return !error;
}

async function resolve(
  id: string,
  user: string | undefined,
): Promise<ManagedMachineConfig> {
  await loadMachineStore();
  const machine = (await machinesAsync()).find((m) => m.id === id);
  if (!machine) throw new MachineError(`No managed machine '${id}'.`, 404);
  if (!machineAllows(machine, user))
    throw new MachineError(`You are not allowed to use ${machine.label}.`, 403);
  return machine;
}

export async function startMachine(
  id: string,
  input: { user?: string; via: "user" | "agent" },
): Promise<void> {
  const machine = await resolve(id, input.user);
  const entry = live(id);
  if (entry.acting === "start") return;
  if (entry.acting === "stop")
    throw new MachineError(
      `${machine.label} is running its stop command. Try again when it finishes.`,
      409,
    );
  const ok = await runPowerCommand(machine, "start", input);
  // Answer with fresh state. Not inside runPowerCommand: an idle stop runs
  // within a poll, and awaiting that poll there would wait on itself.
  await pollMachine(machine);
  if (!ok)
    throw new MachineError(
      machineRecord(id).lastAction?.error ?? "The start command failed.",
      502,
    );
}

export async function stopMachine(
  id: string,
  input: { user?: string; via: "user" | "agent"; force?: boolean },
): Promise<void> {
  const machine = await resolve(id, input.user);
  const entry = live(id);
  if (entry.acting === "stop") return;
  // Your own reservation does not stop you; someone else's does.
  const holds = machineHolds(id, input.user);
  if (holds.length && !input.force)
    throw new MachineError(
      `${machine.label} is in use: ${holds.join("; ")}.`,
      409,
    );
  const ok = await runPowerCommand(machine, "stop", input);
  await pollMachine(machine);
  if (!ok)
    throw new MachineError(
      machineRecord(id).lastAction?.error ?? "The stop command failed.",
      502,
    );
  const reservation = machineRecord(id).reservation;
  if (reservation && reservation.reservedBy === input.user)
    await patchMachineRecord(id, { reservation: undefined });
}

export async function reserveMachine(
  id: string,
  input: {
    user?: string;
    sessionId?: string;
    reason: string;
    durationMinutes?: number;
  },
): Promise<Reservation> {
  const machine = await resolve(id, input.user);
  const now = registry.deps.now();
  const current = activeReservation(id, now);
  if (current && current.reservedBy !== input.user)
    throw new MachineError(
      `${machine.label} is reserved by ${current.reservedBy ?? "someone else"} until ${current.expiresAt}.`,
      409,
    );
  const minutes = Math.min(Math.max(input.durationMinutes ?? 60, 1), 24 * 60);
  const reservation: Reservation = {
    reason: input.reason.trim().slice(0, 240) || "Session work",
    ...(input.user ? { reservedBy: input.user } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    expiresAt: iso(now + minutes * 60_000),
  };
  await patchMachineRecord(id, { reservation });
  live(id).evidence = resetIdle(live(id).evidence, "Reserved.");
  audit({ msg: "managed_machine_reserved", machine_id: id, user: input.user });
  return reservation;
}

export async function releaseMachine(
  id: string,
  input: { user?: string },
): Promise<void> {
  await resolve(id, input.user);
  const current = machineRecord(id).reservation;
  if (current?.reservedBy && current.reservedBy !== input.user)
    throw new MachineError(
      `Only ${current.reservedBy} can release this reservation.`,
      409,
    );
  await patchMachineRecord(id, { reservation: undefined });
  live(id).evidence = resetIdle(live(id).evidence, "Reservation released.");
  audit({ msg: "managed_machine_released", machine_id: id, user: input.user });
}

/** Run one command on the machine through its `exec` prefix. */
export async function execOnMachine(
  id: string,
  command: string,
  input: {
    user?: string;
    sessionId?: string;
    timeoutMs: number;
    stdin?: string;
    signal?: AbortSignal;
  },
): Promise<CommandResult> {
  const machine = await resolve(id, input.user);
  if (!machine.exec)
    throw new MachineError(
      `${machine.label} has no exec command configured, so Open Session cannot run commands on it.`,
    );
  const entry = live(id);
  const poll = entry.lastPoll;
  const fresh = poll?.ok && registry.deps.now() - poll.at <= maxGapMs(machine);
  if (entry.acting === "stop")
    throw new MachineError(`${machine.label} is stopping.`, 409);
  if (!fresh || poll.report.state !== "on")
    throw new MachineError(
      `${machine.label} is ${poll?.ok ? poll.report.state : "in an unknown state"}${poll && !poll.ok ? ` (${poll.error})` : ""}. Start it with start_runner, which waits until it is on.`,
      409,
    );
  entry.execInFlight++;
  entry.evidence = resetIdle(entry.evidence, "A command ran recently.");
  audit({
    msg: "managed_machine_exec_start",
    machine_id: id,
    user: input.user,
    session_id: input.sessionId,
    command: command.slice(0, 500),
  });
  try {
    const result = await registry.deps.run([...machine.exec, command], {
      env: commandEnv(machine),
      timeoutMs: input.timeoutMs,
      stdin: input.stdin,
      signal: input.signal,
    });
    audit({
      msg: "managed_machine_exec_end",
      machine_id: id,
      session_id: input.sessionId,
      code: result.code,
      timed_out: result.timedOut === true,
      cancelled: result.cancelled === true,
    });
    return result;
  } finally {
    entry.execInFlight--;
    entry.evidence = resetIdle(entry.evidence, "A command ran recently.");
  }
}

function attentionFor(
  machine: ManagedMachineConfig,
  entry: Live,
  lastAction: MachineAction | undefined,
  now: number,
): string | undefined {
  const poll = entry.lastPoll;
  if (poll && !poll.ok)
    return `Open Session cannot read this machine's state, so it will not stop it on its own. ${poll.error}`;
  if (poll && now - poll.at > maxGapMs(machine))
    return "The last status check is too old, so it will not stop on its own.";
  if (lastAction?.ok === false)
    return `The last ${lastAction.kind} failed: ${lastAction.error ?? "no detail"}`;
  const state = poll?.ok ? poll.report.state : undefined;
  const since = lastAction ? now - Date.parse(lastAction.at) : 0;
  if (
    lastAction?.kind === "stop" &&
    lastAction.ok &&
    state !== "off" &&
    since > STOP_STUCK_MS
  )
    return `Stop ran ${Math.round(since / 60_000)} min ago and the machine still reports ${state ?? "nothing"}.`;
  if (
    lastAction?.kind === "start" &&
    lastAction.ok &&
    state !== "on" &&
    since > machine.startTimeoutMinutes * 60_000
  )
    return `Started ${Math.round(since / 60_000)} min ago and the machine still reports ${state ?? "nothing"}.`;
  return undefined;
}

export function machineView(
  machine: ManagedMachineConfig,
  user: string | undefined,
): ManagedMachineView {
  const now = registry.deps.now();
  const entry = live(machine.id);
  const record = machineRecord(machine.id);
  const poll = entry.lastPoll;
  const report = poll?.ok ? poll.report : undefined;
  let state: MachineViewState = report?.state ?? "unknown";
  if (entry.acting === "start" && state === "off") state = "starting";
  if (entry.acting === "stop" && state === "on") state = "stopping";
  const decision = machine.idle
    ? decideIdle({
        now,
        policy: machine.idle,
        maxGapMs: maxGapMs(machine),
        holds: machineHolds(machine.id),
        evidence: entry.evidence,
      })
    : undefined;
  const minutes = machine.idle?.minutes ?? 0;
  const reservation = activeReservation(machine.id, now);
  const attention = attentionFor(machine, entry, record.lastAction, now);
  return {
    id: machine.id,
    label: machine.label,
    ...(machine.description ? { description: machine.description } : {}),
    state,
    ...(report?.detail ? { detail: report.detail } : {}),
    ...(report?.cpu !== undefined ? { cpu: report.cpu } : {}),
    ...(report?.gpu !== undefined ? { gpu: report.gpu } : {}),
    ...(poll ? { lastPollAt: iso(poll.at) } : {}),
    ...(poll && !poll.ok ? { lastPollError: poll.error } : {}),
    pollSeconds: machine.pollSeconds,
    ...(decision && decision.kind !== "disabled"
      ? {
          idle:
            decision.kind === "held"
              ? { minutes, kind: "held" as const, reasons: decision.reasons }
              : decision.kind === "not-idle"
                ? {
                    minutes,
                    kind: "not-idle" as const,
                    reason: decision.reason,
                  }
                : {
                    minutes,
                    kind: "idle" as const,
                    since: iso(decision.since),
                    stopAt: iso(decision.stopAt),
                  },
        }
      : {}),
    ...(reservation ? { reservation } : {}),
    ...(record.lastAction ? { lastAction: record.lastAction } : {}),
    ...(entry.acting ? { acting: entry.acting } : {}),
    execAvailable: Boolean(machine.exec),
    execInFlight: entry.execInFlight,
    ...(attention ? { attention } : {}),
    allowed: machineAllows(machine, user),
  };
}

export async function listMachineViews(
  user: string | undefined,
): Promise<ManagedMachineView[]> {
  await loadMachineStore();
  return (await machinesAsync()).map((machine) => machineView(machine, user));
}

export async function findMachine(
  query: string,
): Promise<ManagedMachineConfig | undefined> {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return undefined;
  await loadMachineStore();
  return (await machinesAsync()).find(
    (machine) =>
      machine.id === wanted || machine.label.toLowerCase() === wanted,
  );
}

/** Wait until the machine reports `on`, a start fails, or time runs out. */
export async function waitForMachine(
  id: string,
  user: string | undefined,
  timeoutMs: number,
  pollMs = 10_000,
): Promise<ManagedMachineView> {
  const deadline = registry.deps.now() + timeoutMs;
  for (;;) {
    const machine = await resolve(id, user);
    await pollMachine(machine);
    const view = machineView(machine, user);
    if (view.state === "on" || view.lastAction?.ok === false) return view;
    if (registry.deps.now() + pollMs > deadline) return view;
    await new Promise((done) => setTimeout(done, pollMs));
  }
}

/** One poller pass: poll every machine whose interval has passed. */
export async function tickManagedMachines(): Promise<void> {
  await loadMachineStore();
  const now = registry.deps.now();
  await Promise.all(
    (await machinesAsync()).map((machine) => {
      const last = live(machine.id).lastPoll?.at;
      return last === undefined || now - last >= machine.pollSeconds * 1_000
        ? pollMachine(machine).catch((error) =>
            console.error(`[managed-machines] poll ${machine.id}:`, error),
          )
        : undefined;
    }),
  );
}

/** Boot: start the poller. Idempotent. */
export function startManagedMachines(): void {
  if (registry.timer) return;
  const tick = () =>
    void tickManagedMachines().catch((error) =>
      console.error("[managed-machines] tick failed:", error),
    );
  tick();
  registry.timer = setInterval(tick, TICK_MS);
  registry.timer.unref?.();
}
