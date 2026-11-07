/**
 * Spaces — a shared conversation with one coordinator agent whose job is to
 * spawn and coordinate other sessions for the people in it.
 *
 * A space is a workspace with `space: true`. It is not a new store: it reuses
 * the workspace record (title, project, collaborators), the session tree
 * (`parentSessionId` links, report-back, spawn depth), comment threads and
 * session assets that already exist. What makes it a space is:
 *
 * - **The coordinator.** Every root session in a space (one with no parent)
 *   coordinates. Its turns carry a fenced briefing (`spaceCoordinatorNote`)
 *   telling it to delegate substantive work to threads instead of doing it.
 *   It is a Scratch session: a writable scratch directory shared by the
 *   space, with no checkout of its own, so every change to the project
 *   lands in a thread with its own branch and review. Its threads default
 *   to the space's project (session-control-wiring.ts).
 * - **Threads.** The sessions the coordinator spawns. A child lands in its
 *   parent's workspace, so they stay inside the space and nest under it in
 *   the sidebar.
 * - **Its own sidebar band.** The web client files space rows into a Spaces
 *   band with a + that creates one (title, project, first message).
 *
 * The full model is in CONCEPTS.md.
 */

import { getSessionControl } from "./session-control";
import { createWorkspace, getWorkspace, type Workspace } from "./workspaces";
import type { UnifiedSession } from "./types";

/** A space title is a workspace name: same bound as createWorkspace. */
export const MAX_SPACE_TITLE_LENGTH = 120;

/** Whether `session` is a coordinator of `workspace`: a root session in a space. */
export function isSpaceCoordinator(
  session: Pick<UnifiedSession, "parentSessionId">,
  workspace: Pick<Workspace, "space"> | null | undefined,
): boolean {
  return workspace?.space === true && !session.parentSessionId;
}

/**
 * The coordinator's standing briefing, fenced onto each of its turns like a
 * pinned goal. It names the space and its project so the agent knows where
 * threads should run; everything else is the same for every space.
 */
export function spaceCoordinatorNote(space: {
  name: string;
  repo?: string;
}): string {
  const project = space.repo
    ? `Its project is the repository \`${space.repo}\`: threads run there unless you pass another \`repo\`.`
    : "It has no project. Pass `repo` when a thread's work belongs to a repository.";
  return [
    `You coordinate the space "${space.name}". A space is a shared conversation whose agent spawns and coordinates other sessions, called threads, for the people in it. ${project}`,
    "",
    "- Delegate. Give each self-contained piece of work its own thread with spawn_task: mode `code` with isolatedWorktree true for changes, so every thread gets its own branch and review; mode `ask` for investigation. Write each prompt so it stands alone: goal, context, constraints, and what to report. Answer questions and plan yourself. You work in a scratch directory with no checkout of the project: use it for notes and scripts, and leave reading and changing the project's code to threads.",
    "- Track. Threads report back to this conversation. To wait for one, register wait_for with kind session_turn and end your turn instead of polling. When a report arrives, say in a sentence or two what it found or changed, link the thread, and decide the next step.",
    "- Share. Several people may talk here. Each message names its author; say who asked for what when it helps, and keep replies short enough to scan.",
    "- Summarize. Keep one Markdown asset named `space-summary.md` up to date with write_asset: the goal, each thread and its state, decisions, and open questions. Update it when any of those change.",
    "- Do not paste thread transcripts here. Link the thread instead.",
  ].join("\n");
}

/** The briefing for this turn, or null when the session does not coordinate a space. */
export async function spaceCoordinatorNoteFor(
  session: Pick<UnifiedSession, "parentSessionId" | "workspaceId">,
): Promise<string | null> {
  if (session.parentSessionId || !session.workspaceId) return null;
  const workspace = await getWorkspace(session.workspaceId);
  if (!workspace || !isSpaceCoordinator(session, workspace)) return null;
  return spaceCoordinatorNote(workspace);
}

export class SpaceInputError extends Error {}

export interface CreateSpaceInput {
  title: string;
  /** Registered repo id, or undefined for a space without a project. */
  repo?: string;
  /** The first message to the coordinator. */
  prompt: string;
  /** Display name of the person creating the space. */
  user: string;
  /** Server-authenticated login, when there is one. */
  createdByLogin?: string;
}

/**
 * Create a space and start its coordinator on the first message. The space
 * is created first so the coordinator joins it rather than minting a
 * workspace of its own; a failed session create leaves an empty space the
 * person can still open and prompt from.
 */
export async function createSpace(
  input: CreateSpaceInput,
  deps: {
    createWorkspace: typeof createWorkspace;
    createSession: ReturnType<typeof getSessionControl>["createSession"];
  } = {
    createWorkspace,
    createSession: (opts) => getSessionControl().createSession(opts),
  },
): Promise<{ workspace: Workspace; sessionId: string }> {
  const title = input.title.trim().slice(0, MAX_SPACE_TITLE_LENGTH);
  const prompt = input.prompt.trim();
  if (!title) throw new SpaceInputError("Give the space a title");
  if (!prompt) throw new SpaceInputError("Tell the agent what to work on");
  const workspace = await deps.createWorkspace({
    name: title,
    ...(input.repo ? { repo: input.repo } : {}),
    createdBy: input.user || "Anonymous",
    space: true,
  });
  const { id } = await deps.createSession({
    prompt,
    mode: "scratch",
    ...(input.repo ? { repo: input.repo } : {}),
    workspaceId: workspace.id,
    user: input.user,
    ...(input.createdByLogin ? { createdByLogin: input.createdByLogin } : {}),
  });
  return { workspace, sessionId: id };
}
