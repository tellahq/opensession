import { getAutomation } from "./automations";
import { getReport, type ReportTask } from "./reports";
import { getSessionControl } from "./session-control";
import { sanitizeBranchSlug } from "./suggest-branch";
import { resolveUniqueBranch } from "./worktree";

/**
 * The opening prompt for one task's session.
 *
 * The task prompt stands alone by contract, so all this adds is what the agent
 * cannot know from it: that it is one item in a batch, and that it must use the
 * isolated checkout prepared for this session instead of a path copied from
 * the report-producing run.
 */
export function fanOutPrompt(
  task: ReportTask,
  report: { title: string; automationName: string },
  batchSize: number,
): string {
  const batch =
    batchSize > 1
      ? ` It is one of ${batchSize} started together from that report, each in its own session and worktree: do this item only, leave the others alone even where the report describes them, and keep your commits scoped to this change.`
      : "";
  return `${task.prompt}

---
This task comes from the "${report.automationName}" report "${report.title}".${batch} Work in the checkout you are already in, which is yours alone. If the task text names an absolute path for this repository, ignore it and use your own worktree.`;
}

/** A stable, readable branch per task: `report-<slug of the title>`. */
async function branchForTask(task: ReportTask, repo?: string): Promise<string> {
  const slug = sanitizeBranchSlug(task.title) || "task";
  return await resolveUniqueBranch(`report-${slug}`, repo);
}

export interface StartedReportSession {
  task: number;
  title: string;
  id?: string;
  error?: string;
}

export class ReportSessionsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Start one isolated code session for every selected report task. Shared by
 * the authenticated Reports route and Slack's one-tap "Fix these" action.
 */
export async function startReportSessions(input: {
  automationId: string;
  reportId: string;
  tasks?: number[];
  user?: string;
  createdByLogin?: string;
}): Promise<StartedReportSession[]> {
  const report = getReport(input.automationId, input.reportId);
  if (!report) throw new ReportSessionsError("No such report", 404);
  const tasks = report.tasks || [];
  if (!tasks.length)
    throw new ReportSessionsError("This report proposes no tasks", 400);

  const wanted = Array.isArray(input.tasks)
    ? [...new Set(input.tasks.filter((i) => Number.isInteger(i)))]
        .filter((i) => i >= 0 && i < tasks.length)
        .sort((a, b) => a - b)
    : tasks.map((_, i) => i);
  if (!wanted.length) throw new ReportSessionsError("No tasks selected", 400);

  const repo = getAutomation(input.automationId)?.repo;
  const started: StartedReportSession[] = [];
  console.log(
    `[reports] fan-out: ${wanted.length} session(s) from "${report.title}" (repo ${repo || "default"})`,
  );
  for (const index of wanted) {
    const task = tasks[index];
    const startedAt = Date.now();
    try {
      const branch = await branchForTask(task, repo);
      console.log(`[reports] fan-out: creating ${branch}`);
      const { id } = await getSessionControl().createSession({
        prompt: fanOutPrompt(task, report, wanted.length),
        mode: "code",
        branch,
        isolatedWorktree: true,
        agentStarted: true,
        createdByLogin: input.createdByLogin,
        ...(repo ? { repo } : {}),
        ...(input.user ? { user: input.user } : {}),
      });
      console.log(
        `[reports] fan-out: ${branch} → ${id} in ${Date.now() - startedAt}ms`,
      );
      started.push({ task: index, title: task.title, id });
    } catch (error) {
      console.warn(
        `[reports] fan-out: task ${index} failed after ${Date.now() - startedAt}ms:`,
        error,
      );
      started.push({
        task: index,
        title: task.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return started;
}
