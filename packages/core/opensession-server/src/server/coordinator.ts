/**
 * Coordinator mode: a session that hands work to other sessions, called
 * threads, instead of doing it itself.
 *
 * It is a per-session setting (`coordinator` on the session file), switched
 * from the composer like pstack mode. While it is on, every turn carries a
 * fenced briefing (`coordinatorNote`): delegate self-contained work with
 * spawn_task, track the threads, keep a summary asset, and keep the work
 * pointed at the workspace's goal. Turning it off makes the session ordinary
 * again from its next turn; nothing about its repo or checkout changes.
 *
 * Threads are ordinary child sessions in the coordinator's workspace. They do
 * not inherit the mode: they do the work. Workspaces created as "spaces"
 * before this setting existed (`workspace.space`) still have their root
 * session coordinate until someone switches it off.
 *
 * The full model is in CONCEPTS.md.
 */

import type { UnifiedSession } from "./types";
import { getWorkspace, type Workspace } from "./workspaces";

type CoordinatorSession = Pick<
  UnifiedSession,
  "coordinator" | "parentSessionId" | "workspaceId"
>;

/**
 * Whether `session` coordinates. An explicit setting wins; without one, the
 * root session of a legacy space workspace does.
 */
export function isCoordinating(
  session: CoordinatorSession,
  workspace: Pick<Workspace, "id" | "space"> | null | undefined,
): boolean {
  if (session.coordinator !== undefined) return session.coordinator;
  return (
    workspace?.space === true &&
    !session.parentSessionId &&
    session.workspaceId === workspace.id
  );
}

/**
 * The standing briefing. It names the workspace, its project and its goal so
 * the agent knows where threads should run and what they are for, and says
 * whether this session can read the code itself.
 */
export function coordinatorNote(ctx: {
  workspaceName?: string;
  repo?: string;
  goal?: string;
  /** The session has a checkout of the project to read. */
  hasCheckout: boolean;
}): string {
  const where = ctx.workspaceName
    ? ` for the workspace "${ctx.workspaceName}"`
    : "";
  const project = ctx.repo
    ? `Threads run in the repository \`${ctx.repo}\` unless you pass another \`repo\`.`
    : "There is no project repository. Pass `repo` when a thread's work belongs to one.";
  const checkout = ctx.hasCheckout
    ? "You have a checkout of the project: read it to plan and to answer questions, but make every change in a thread, not here."
    : "You work in a scratch directory with no checkout of the project: use it for notes and scripts, and leave reading and changing the project's code to threads.";
  return [
    `Coordinator mode is on${where}. Your job is to hand work to other sessions, called threads, follow them, and report back to the people here. ${project}`,
    ...(ctx.goal
      ? [
          "",
          `The workspace's goal: ${ctx.goal}`,
          "Keep every thread pointed at this goal. Say so when a request pulls away from it.",
        ]
      : []),
    "",
    `- Delegate. Give each self-contained piece of work its own thread with spawn_task: mode \`code\` with isolatedWorktree true for changes, so every thread gets its own branch and review; mode \`ask\` for investigation. Write each prompt so it stands alone: goal, context, constraints, and what to report. Answer questions and plan yourself. ${checkout}`,
    "- Track. Threads report back to this conversation. To wait for one, register wait_for with kind session_turn and end your turn instead of polling. When a report arrives, say in a sentence or two what it found or changed, link the thread, and decide the next step.",
    "- Share. Several people may talk here. Each message names its author; say who asked for what when it helps, and keep replies short enough to scan.",
    "- Summarize. Keep one Markdown asset named `coordinator-summary.md` up to date with write_asset: the goal, each thread and its state, decisions, and open questions. Update it when any of those change, and do it quietly: people read it in the Threads panel, so never say you updated it, and never end a reply on it. Your reply is what changed and what happens next, in your own words.",
    "- Do not paste thread transcripts here. Link the thread instead.",
  ].join("\n");
}

/** This turn's briefing, or null when the session does not coordinate. */
export async function coordinatorNoteFor(
  session: CoordinatorSession &
    Pick<UnifiedSession, "repo" | "mode" | "worktreeDir">,
): Promise<string | null> {
  if (session.coordinator === false) return null;
  const workspace = session.workspaceId
    ? await getWorkspace(session.workspaceId)
    : null;
  if (!isCoordinating(session, workspace)) return null;
  return coordinatorNote({
    workspaceName: workspace?.name,
    repo: workspace?.repo || session.repo,
    goal: workspace?.goal,
    hasCheckout: session.mode !== "scratch" && !!session.worktreeDir,
  });
}
