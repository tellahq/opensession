import { request } from "./request";

export type GoalStatus = "active" | "paused" | "done" | "failed";

export interface Goal {
  id: string;
  name: string;
  mission: string;
  status: GoalStatus;
  mode: "ask" | "code";
  repo?: string;
  bksSessionId?: string;
  nextWakeAt: string;
  minWakeMinutes: number;
  maxWakes?: number;
  wakeCount: number;
  lastRunAt?: string;
  lastRunStatus?: "running" | "ok" | "error";
  lastRunError?: string;
  phase?: string;
  pauseReason?: string;
  doneReason?: string;
  model?: string;
  fallbackModel?: string;
  mcpServers?: string[];
  createdBy: string;
  isRunning?: boolean;
}

export interface GoalMutationInput {
  name: string;
  mission: string;
  mode?: "ask" | "code";
  repo?: string;
  model?: string;
  fallbackModel?: string;
  mcpServers?: string[];
  minWakeMinutes?: number;
  maxWakes?: number;
}

export function fetchGoals(): Promise<Goal[]> {
  return request<Goal[]>("/goals", { label: "Failed to fetch goals" });
}

export function fetchGoal(id: string): Promise<Goal & { ledger?: string }> {
  return request<Goal & { ledger?: string }>(
    `/goals/${encodeURIComponent(id)}`,
    {
      label: "Failed to fetch goal",
    },
  );
}

export function createGoalApi(
  input: GoalMutationInput & { createdBy: string },
): Promise<Goal> {
  return request<Goal>("/goals", { method: "POST", body: input });
}

export function updateGoalApi(
  id: string,
  patch: GoalMutationInput,
): Promise<Goal> {
  return request<Goal>(`/goals/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: patch,
  });
}

export async function deleteGoalApi(id: string): Promise<void> {
  await request<void>(`/goals/${encodeURIComponent(id)}`, {
    method: "DELETE",
    label: "Failed to delete",
  });
}

export async function runGoalApi(id: string): Promise<void> {
  await request<void>(`/goals/${encodeURIComponent(id)}/run`, {
    method: "POST",
  });
}

export function resumeGoalApi(id: string): Promise<Goal> {
  return request<Goal>(`/goals/${encodeURIComponent(id)}/resume`, {
    method: "POST",
    body: {},
  });
}

export function pauseGoalApi(id: string, reason?: string): Promise<Goal> {
  return request<Goal>(`/goals/${encodeURIComponent(id)}/pause`, {
    method: "POST",
    body: { reason },
  });
}
