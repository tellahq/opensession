import type { UnifiedSession } from "../../lib/types";

export function mergeWorkflowSeed<T extends { runId: string }>(
  current: T[],
  fetched: T[],
) {
  const have = new Set(current.map((run) => run.runId));
  const added = fetched.filter((run) => !have.has(run.runId));
  return added.length ? [...current, ...added] : current;
}

export function sessionPrTargetKeys(
  session: Pick<UnifiedSession, "repo" | "branch" | "attachedRepos" | "prs">,
) {
  return [
    `${session.repo || "repository"}\0${session.branch}`,
    ...(session.attachedRepos || []).map(
      (repo) => `${repo.repo}\0${repo.branch}`,
    ),
    ...(session.prs || []).map((ref) => `${ref.repo}\0${ref.branch}`),
  ];
}

export function runningAgentCount(
  workflowRuns: Array<{ agents: Array<{ status: string }> }>,
  subagents: Array<{ status: string }>,
) {
  return (
    workflowRuns.reduce(
      (count, run) =>
        count + run.agents.filter((agent) => agent.status === "running").length,
      0,
    ) + subagents.filter((subagent) => subagent.status === "running").length
  );
}
