/**
 * Idle evidence for managed machines. Pure functions only.
 *
 * A machine is stopped only on positive, unbroken evidence that it is idle.
 * Every way of not knowing keeps it on:
 *
 * - A status poll that failed, timed out, printed no JSON, reported a state
 *   other than `on`, or left out a metric the idle policy uses resets the
 *   idle window. A missing metric is not zero.
 * - A gap between successful polls longer than `maxGapMs` (a slow command,
 *   a restarted server, a stalled poller) resets the window too: a fresh
 *   idle poll after a gap says nothing about the time before it.
 * - Activity (CPU or GPU at or above the threshold), an exec in flight, or a
 *   reservation resets the window. Holds are also checked at decision time.
 * - Evidence lives in memory only. A server restart starts every window
 *   again, which can only make a stop later, never earlier.
 */

import type { IdlePolicy } from "./config";

export type MachineState = "off" | "starting" | "on" | "stopping";

export type StatusReport = {
  state: MachineState;
  /** Utilization, 0-1 per device (a value above 1 is allowed for CPU cores). */
  cpu?: number;
  gpu?: number;
  detail?: string;
};

export type PollResult =
  | { ok: true; at: number; report: StatusReport }
  | { ok: false; at: number; error: string };

export type IdleEvidence = {
  /** Start of the current unbroken idle window. */
  since?: number;
  /** Last successful poll, whatever it reported. */
  lastOkAt?: number;
  /** Why the window is not running, while it is not. */
  reason?: string;
};

export type IdleDecision =
  | { kind: "disabled" }
  | { kind: "held"; reasons: string[] }
  | { kind: "not-idle"; reason: string }
  | { kind: "idle"; since: number; stopAt: number; stop: boolean };

const STATES: MachineState[] = ["off", "starting", "on", "stopping"];

/** Parse the status command's stdout: one JSON object, last line wins. */
export function parseStatusOutput(stdout: string): StatusReport | string {
  const line = stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) return "The status command printed nothing.";
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return "The status command did not print JSON.";
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return "The status command did not print a JSON object.";
  const value = raw as Record<string, unknown>;
  if (!STATES.includes(value.state as MachineState))
    return `The status command reported an unknown state (${JSON.stringify(value.state)?.slice(0, 40)}).`;
  const metric = (key: "cpu" | "gpu") =>
    typeof value[key] === "number" &&
    Number.isFinite(value[key]) &&
    (value[key] as number) >= 0
      ? (value[key] as number)
      : undefined;
  const cpu = metric("cpu");
  const gpu = metric("gpu");
  return {
    state: value.state as MachineState,
    ...(cpu !== undefined ? { cpu } : {}),
    ...(gpu !== undefined ? { gpu } : {}),
    ...(typeof value.detail === "string" && value.detail.trim()
      ? { detail: value.detail.trim().slice(0, 300) }
      : {}),
  };
}

/** Why this poll is not idle evidence, or undefined when it is. */
function notIdle(
  poll: PollResult,
  policy: IdlePolicy,
  holds: string[],
): string | undefined {
  if (!poll.ok) return `Status check failed: ${poll.error}`;
  const { report } = poll;
  if (report.state !== "on") return `The machine is ${report.state}.`;
  if (policy.cpuBelow !== undefined) {
    if (report.cpu === undefined) return "The status check did not report CPU.";
    if (report.cpu >= policy.cpuBelow) return `CPU is busy (${report.cpu}).`;
  }
  if (policy.gpuBelow !== undefined) {
    if (report.gpu === undefined) return "The status check did not report GPU.";
    if (report.gpu >= policy.gpuBelow) return `GPU is busy (${report.gpu}).`;
  }
  if (holds.length) return holds.join("; ");
  return undefined;
}

/** Fold one status poll into the evidence. */
export function ingestPoll(
  evidence: IdleEvidence,
  input: {
    poll: PollResult;
    policy: IdlePolicy;
    holds: string[];
    maxGapMs: number;
  },
): IdleEvidence {
  const { poll } = input;
  const gap =
    evidence.lastOkAt === undefined ||
    poll.at - evidence.lastOkAt > input.maxGapMs;
  const lastOkAt = poll.ok ? poll.at : evidence.lastOkAt;
  const reason = notIdle(poll, input.policy, input.holds);
  if (reason) return { ...(lastOkAt ? { lastOkAt } : {}), reason };
  return {
    lastOkAt: poll.at,
    since: gap || evidence.since === undefined ? poll.at : evidence.since,
  };
}

/** Something used the machine now (an exec started or ended). */
export function resetIdle(
  evidence: IdleEvidence,
  reason: string,
): IdleEvidence {
  return {
    ...(evidence.lastOkAt ? { lastOkAt: evidence.lastOkAt } : {}),
    reason,
  };
}

export function decideIdle(input: {
  now: number;
  policy?: IdlePolicy;
  maxGapMs: number;
  holds: string[];
  evidence: IdleEvidence;
}): IdleDecision {
  const { now, policy, evidence } = input;
  if (!policy) return { kind: "disabled" };
  if (input.holds.length) return { kind: "held", reasons: input.holds };
  if (evidence.since === undefined)
    return {
      kind: "not-idle",
      reason: evidence.reason ?? "No status check has completed yet.",
    };
  if (
    evidence.lastOkAt === undefined ||
    now - evidence.lastOkAt > input.maxGapMs
  )
    return {
      kind: "not-idle",
      reason: "The last successful status check is too old.",
    };
  const stopAt = evidence.since + policy.minutes * 60_000;
  return { kind: "idle", since: evidence.since, stopAt, stop: now >= stopAt };
}
