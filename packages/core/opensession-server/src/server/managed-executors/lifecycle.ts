import type { ExecutorLifecycle, ExecutorRecord } from "./state";

export type ExecutorDesiredState = "awake" | "sleeping" | "destroyed";
export type ExecutorLifecycleEffect =
  | "none"
  | "wake"
  | "pause"
  | "destroy"
  | "wait"
  | "repair";

/** Pure projection for a SessionKernel desired-state effect planner. */
export function desiredLifecycleEffect(
  lifecycle: ExecutorLifecycle,
  desired: ExecutorDesiredState,
): ExecutorLifecycleEffect {
  if (desired === "destroyed") return "destroy";
  if (lifecycle === "needs_attention") return "repair";
  if (lifecycle === "preparing" || lifecycle === "waking") return "wait";
  if (desired === "awake") return lifecycle === "awake" ? "none" : "wake";
  return lifecycle === "sleeping" ? "none" : "pause";
}

export function beginTransition(
  record: ExecutorRecord,
  lifecycle: "preparing" | "waking",
  nowMs: number,
): ExecutorRecord {
  return {
    ...record,
    instanceGeneration: record.instanceGeneration + 1,
    lifecycle,
    updatedAtMs: nowMs,
    error: undefined,
  };
}

export function settleTransition(
  record: ExecutorRecord,
  lifecycle: "awake" | "sleeping" | "needs_attention",
  nowMs: number,
  error?: string,
): ExecutorRecord {
  return {
    ...record,
    lifecycle,
    updatedAtMs: nowMs,
    ...(error ? { error } : { error: undefined }),
  };
}
