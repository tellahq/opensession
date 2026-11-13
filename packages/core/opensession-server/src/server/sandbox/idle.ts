/**
 * When an awake Sandbox goes to sleep: two timers instead of one.
 *
 * A Sandbox sleeps once the agent has done no work in it for
 * `idle.agentMinutes` (5 by default) AND nobody has interacted with it for
 * `idle.humanMinutes` (20). A turn somebody sent keeps the machine around
 * while they look at the result; a turn an automation started lets it sleep
 * five minutes after the work ends. A provider's own idle timer (Boat's TTL,
 * `idleStopMinutes`) stays as the backstop and is kept from firing while a
 * machine is in use.
 *
 * Agent work: a run's tool calls, any turn running for the session, and
 * Portal Sandbox landings after a turn. Interaction: a person's prompt, any
 * Portal request (whoever makes it), a Terminal or Desktop opened on the
 * machine, and a manual wake.
 *
 * The tracker is in memory and holds only Sandboxes that saw activity since
 * this process started, so the sweep never lists sessions or providers. A
 * machine that was awake across a restart and sees nothing afterwards falls
 * to the provider's backstop timer.
 */
import { sandboxIdlePolicy } from "./config";

/** Portal Sandboxes are keyed by `<session>--portals` at the provider
 *  (portal-sandbox.ts PORTAL_SANDBOX_SUFFIX). */
const PORTAL_SUFFIX = "--portals";
/** A session's GPU job machines, `<session>--gpu` and `<session>--gpu-<n>`
 *  (gpu-jobs.ts gpuMachineSessionId). They bill a GPU and run only jobs, so
 *  only their jobs keep them awake: not the person chatting, not the
 *  session's other turns. */
const GPU_PATTERN = /--gpu(?:-\d+)?$/;

function jobsOnly(sandboxId: string): boolean {
  return GPU_PATTERN.test(sandboxId);
}

export type SandboxActivityKind = "agent" | "human";

type IdleEntry = {
  sandboxId: string;
  /** The session the sweep sleeps the machine through. */
  sessionId: string;
  /** Every session seen working on the machine: tabs of one workspace can
   *  share it (shared-machine.ts), and a turn in any of them is work. */
  sessionIds: Set<string>;
  agentAt: number;
  humanAt: number;
  keptAliveAt: number;
  /** A sleep attempt failed: wait before trying again. */
  retryAt?: number;
};

type IdleGlobals = {
  __opensessionSandboxIdle?: Map<string, IdleEntry>;
  __opensessionSandboxIdleHuman?: Map<string, number>;
  __opensessionSandboxIdleSweep?: ReturnType<typeof setInterval>;
};
const g = globalThis as IdleGlobals;
const entries = (g.__opensessionSandboxIdle ??= new Map());
/** A person's latest prompt per session, for machines that register after
 *  it (the prompt wakes or creates the Sandbox). */
const humanBySession = (g.__opensessionSandboxIdleHuman ??= new Map());

/** The session a provider-side session id belongs to. */
export function idleSessionId(providerSessionId: string): string {
  if (providerSessionId.endsWith(PORTAL_SUFFIX))
    return providerSessionId.slice(0, -PORTAL_SUFFIX.length);
  const gpu = GPU_PATTERN.exec(providerSessionId);
  return gpu ? providerSessionId.slice(0, gpu.index) : providerSessionId;
}

/** Record activity on one Sandbox. `sessionId` may be the provider's
 *  `<session>--portals` key. */
export function noteSandboxActivity(
  input: { sandboxId: string; sessionId: string },
  kind: SandboxActivityKind,
  now = Date.now(),
): void {
  if (!input.sandboxId || !input.sessionId) return;
  const sessionId = idleSessionId(input.sessionId);
  const ownOnly = jobsOnly(input.sandboxId);
  if (ownOnly && kind === "human") kind = "agent";
  let entry = entries.get(input.sandboxId);
  if (!entry) {
    const prompted = ownOnly ? 0 : (humanBySession.get(sessionId) ?? 0);
    entry = {
      sandboxId: input.sandboxId,
      sessionId,
      sessionIds: new Set([sessionId]),
      agentAt: now,
      humanAt: Math.max(prompted, kind === "human" ? now : 0),
      keptAliveAt: now,
    };
    entries.set(input.sandboxId, entry);
  } else if (!entry.sessionIds.has(sessionId)) {
    entry.sessionIds.add(sessionId);
    if (!ownOnly)
      entry.humanAt = Math.max(
        entry.humanAt,
        humanBySession.get(sessionId) ?? 0,
      );
  }
  if (kind === "agent") entry.agentAt = Math.max(entry.agentAt, now);
  else entry.humanAt = Math.max(entry.humanAt, now);
  entry.retryAt = undefined;
}

/** A person did something in the session (sent a prompt): every Sandbox it
 *  has, and any it wakes next, counts it as an interaction. */
export function noteSessionHumanActivity(sessionId: string, now = Date.now()) {
  if (!sessionId) return;
  humanBySession.set(sessionId, now);
  for (const entry of entries.values())
    if (entry.sessionIds.has(sessionId) && !jobsOnly(entry.sandboxId))
      entry.humanAt = Math.max(entry.humanAt, now);
}

/** Stop tracking a retired Sandbox. */
export function forgetSandboxIdle(sandboxId: string): void {
  entries.delete(sandboxId);
}

function entryBusy(
  entry: IdleEntry,
  busy: (sessionId: string) => boolean,
): boolean {
  for (const sessionId of entry.sessionIds) if (busy(sessionId)) return true;
  return false;
}

/** The sessions to act through, the first one seen first. A session on a
 *  shared machine may have been deleted since; the next one is tried. */
function entrySessions(entry: IdleEntry): string[] {
  return [
    entry.sessionId,
    ...[...entry.sessionIds].filter((id) => id !== entry.sessionId),
  ];
}

function idleNow(
  entry: IdleEntry,
  policy: { agentMs: number; humanMs: number },
  now: number,
): boolean {
  return (
    now - entry.agentAt >= policy.agentMs &&
    (jobsOnly(entry.sandboxId) || now - entry.humanAt >= policy.humanMs)
  );
}

/** When the tracked Sandbox would go to sleep, for the Sandbox badge. */
export function sandboxSleepsAt(sandboxId: string): number | null {
  const entry = entries.get(sandboxId);
  if (!entry) return null;
  const policy = sandboxIdlePolicy();
  return Math.max(
    entry.agentAt + policy.agentMs,
    entry.humanAt + policy.humanMs,
  );
}

export interface IdleSweepDeps {
  now?: number;
  policy?: { agentMs: number; humanMs: number };
  /** A turn is admitted or running for the session. */
  busy(sessionId: string): boolean;
  /** Sleep one machine of the session; resolves whether it slept. */
  sleep(
    sessionId: string,
    sandboxId: string,
    stillIdle: (sandboxId: string) => boolean,
  ): Promise<boolean>;
  /** Push the provider's own idle timer out (Boat's TTL). Resolves false
   *  when the session no longer records the machine, so another session on
   *  it is tried. */
  keepAlive(sessionId: string, sandboxId: string): Promise<boolean | void>;
}

/** How often an in-use machine's provider timer is pushed out. Well inside
 *  the provider backstop (30 minutes by default). */
export const KEEP_ALIVE_EVERY_MS = 5 * 60_000;
const RETRY_AFTER_MS = 10 * 60_000;

/**
 * One pass: busy sessions count as agent work, idle machines are put to
 * sleep, in-use ones get their provider timer pushed out. Resolves the
 * Sandboxes it put to sleep.
 */
export async function sweepIdleSandboxes(
  deps: IdleSweepDeps,
): Promise<string[]> {
  const now = deps.now ?? Date.now();
  const policy = deps.policy ?? sandboxIdlePolicy();
  const slept: string[] = [];
  for (const entry of [...entries.values()]) {
    const ownOnly = jobsOnly(entry.sandboxId);
    if (!ownOnly && entryBusy(entry, deps.busy)) entry.agentAt = now;
    if (!idleNow(entry, policy, now)) {
      if (now - entry.keptAliveAt >= KEEP_ALIVE_EVERY_MS) {
        entry.keptAliveAt = now;
        for (const sessionId of entrySessions(entry)) {
          const kept = await deps
            .keepAlive(sessionId, entry.sandboxId)
            .catch((error) =>
              console.warn(
                `[sandbox-idle] keepalive for ${entry.sandboxId} failed:`,
                error instanceof Error ? error.message : String(error),
              ),
            );
          if (kept !== false) break;
        }
      }
      continue;
    }
    if (entry.retryAt && now < entry.retryAt) continue;
    try {
      const stillIdle = (sandboxId: string) => {
        const current = entries.get(sandboxId);
        return Boolean(
          current &&
          (jobsOnly(sandboxId) || !entryBusy(current, deps.busy)) &&
          idleNow(current, policy, Date.now()),
        );
      };
      let didSleep = false;
      for (const sessionId of entrySessions(entry)) {
        didSleep = await deps.sleep(sessionId, entry.sandboxId, stillIdle);
        if (didSleep) break;
      }
      if (didSleep) slept.push(entry.sandboxId);
      // Slept, or not sleepable (asleep already, gone, no pause): stop
      // tracking. Activity that arrived meanwhile keeps the entry.
      const current = entries.get(entry.sandboxId);
      if (current && idleNow(current, policy, Date.now()))
        entries.delete(entry.sandboxId);
    } catch (error) {
      entry.retryAt = now + RETRY_AFTER_MS;
      console.warn(
        `[sandbox-idle] could not put ${entry.sandboxId} to sleep:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  for (const [sessionId, at] of humanBySession)
    if (now - at >= policy.humanMs) humanBySession.delete(sessionId);
  return slept;
}

const SWEEP_INTERVAL_MS = 60_000;

/** Idempotent; called from boot. */
export function startSandboxIdleSweep(): void {
  if (g.__opensessionSandboxIdleSweep) return;
  let running = false;
  const timer = setInterval(() => {
    if (running || entries.size === 0) return;
    running = true;
    void defaultSweep()
      .catch((error) => console.warn("[sandbox-idle] sweep failed:", error))
      .finally(() => {
        running = false;
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  g.__opensessionSandboxIdleSweep = timer;
}

async function defaultSweep(): Promise<string[]> {
  const [
    { hostRunBusy },
    { isAgentSessionBusy },
    sleepModule,
    sessions,
    index,
  ] = await Promise.all([
    import("../host-registry"),
    import("../agent-runner"),
    import("../sandbox-archive-sleep"),
    import("../session-cache"),
    import("./index"),
  ]);
  return sweepIdleSandboxes({
    busy: (sessionId) =>
      hostRunBusy(sessionId) || isAgentSessionBusy(sessionId),
    async sleep(sessionId, sandboxId, stillIdle) {
      // A session's GPU job machine is not on its record (gpu-jobs.ts).
      const gpu = await import("../gpu-jobs");
      if (gpu.isGpuJobMachine(sandboxId))
        return (
          stillIdle(sandboxId) &&
          (await gpu.sleepGpuMachine(sessionId, sandboxId))
        );
      const slept = await sleepModule.sleepSessionSandboxes(sessionId, {
        reason: "idle",
        sandboxId,
        stillIdle,
      });
      return slept.length > 0;
    },
    async keepAlive(sessionId, sandboxId) {
      if ((await import("../gpu-jobs")).isGpuJobMachine(sandboxId)) {
        await index.getSandboxProvider("modal").keepAlive?.(sandboxId);
        return;
      }
      const session = await sessions.findSessionAsync(sessionId);
      const record =
        session?.sandbox?.sandboxId === sandboxId
          ? session.sandbox
          : session?.portalSandbox?.sandboxId === sandboxId
            ? session.portalSandbox
            : undefined;
      if (!record?.provider) return false;
      if (record.lifecycle === "sleeping") return;
      await index.getSandboxProvider(record.provider).keepAlive?.(sandboxId);
    },
  });
}

/** Test seam. */
export function resetSandboxIdleForTests(): void {
  entries.clear();
  humanBySession.clear();
}
