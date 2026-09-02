import type { OpenPr } from "./api";
import { spawnedSessionBelongsInSidebar } from "./sidebar-workspaces";
import { sessionPrKeys } from "./sidebar-filter";
import { pickUnreadWorkspaceSession } from "./sidebar-unread-session";
import { ownerKey } from "./session-owner";
import type { SortBy } from "./sidebar-filter";
import type { MineStatus, WsRow } from "./sidebar-types";
import type { UnifiedSession, Workspace } from "./types";

interface BuildWorkspaceRowsInput {
  sessions: UnifiedSession[];
  workspaces: Workspace[];
  openPrs: OpenPr[];
  nestedSubagentIds: ReadonlySet<string>;
  selectedWorkspaceId?: string | null;
  selectedSessionId: string | null;
  reads: Record<string, string>;
  canonicalNames: Map<string, string>;
  sort: SortBy;
  isClaimed: (session: UnifiedSession) => boolean;
  statusForSession: (session: UnifiedSession) => MineStatus;
  pinnedLaneForSession: (
    session: UnifiedSession,
  ) => MineStatus | null | undefined;
  prLaneForSessions: (sessions: UnifiedSession[]) => MineStatus | null;
  mentionForSession: (sessionId: string) => { by?: string } | undefined;
}

const STATUS_PRIORITY: MineStatus[] = [
  "needsinput",
  "inprogress",
  "review",
  "merged",
  "pending",
];

export function buildWorkspaceRows({
  sessions,
  workspaces,
  openPrs,
  nestedSubagentIds,
  selectedWorkspaceId,
  selectedSessionId,
  reads,
  canonicalNames,
  sort,
  isClaimed,
  statusForSession,
  pinnedLaneForSession,
  prLaneForSessions,
  mentionForSession,
}: BuildWorkspaceRowsInput): WsRow[] {
  const activeReviewPrKeys = new Set(
    openPrs
      .filter((pr) => pr.reviewActive)
      .map((pr) => `${pr.repo}\n${pr.branch}`),
  );
  const rows: WsRow[] = [];
  const sessionsByWorkspace = new Map<string, UnifiedSession[]>();
  const ungrouped: UnifiedSession[] = [];

  for (const session of sessions) {
    if (
      nestedSubagentIds.has(session.id) &&
      session.workspaceId !== selectedWorkspaceId
    ) {
      continue;
    }
    if (session.automation && !isClaimed(session)) continue;
    if (session.desk) continue;
    if (
      !spawnedSessionBelongsInSidebar(
        session,
        statusForSession(session) === "needsinput",
        isClaimed(session),
      )
    ) {
      continue;
    }
    if (!session.workspaceId) {
      ungrouped.push(session);
      continue;
    }
    const members = sessionsByWorkspace.get(session.workspaceId) ?? [];
    members.push(session);
    sessionsByWorkspace.set(session.workspaceId, members);
  }

  const createRow = (
    key: string,
    workspace: Workspace | null,
    name: string,
    members: UnifiedSession[],
  ): WsRow => {
    members.sort((a, b) =>
      (a.createdAt || "").localeCompare(b.createdAt || ""),
    );
    const parentSessions = members.filter(
      (session) => !session.parentSessionId,
    );
    const statusSources = parentSessions.length ? parentSessions : members;
    const workerRunning = members.some(
      (session) => session.parentSessionId && session.isRunning,
    );
    const reviewRunning = members.some((session) =>
      sessionPrKeys(session).some((prKey) => activeReviewPrKeys.has(prKey)),
    );
    const hasPinnedLane = members.some((session) =>
      pinnedLaneForSession(session),
    );
    // The first member with an outstanding mention of you. Both the badge's
    // face (who tagged you) and its jump target (which session to open to
    // clear it) come from the same entry, so they can never disagree.
    const mentionEntry = members
      .filter((session) => session.id !== selectedSessionId)
      .map((session) => ({
        session,
        mention: mentionForSession(session.id),
      }))
      .find((entry) => entry.mention);
    let status =
      STATUS_PRIORITY.find((candidate) =>
        statusSources.some(
          (session) => statusForSession(session) === candidate,
        ),
      ) ?? "pending";

    if (workerRunning && status !== "needsinput" && !hasPinnedLane) {
      status = "inprogress";
    }
    if (status === "pending" && !hasPinnedLane) {
      status = reviewRunning
        ? "inprogress"
        : (prLaneForSessions(statusSources) ?? status);
    }

    return {
      key,
      workspace,
      name,
      sessions: members,
      status,
      lastActivity: members.reduce(
        (latest, session) =>
          session.lastActivity > latest ? session.lastActivity : latest,
        "",
      ),
      createdAt: workspace?.createdAt || members[0]?.createdAt || "",
      unread: !!pickUnreadWorkspaceSession(members, selectedSessionId, reads),
      mention: mentionEntry?.mention?.by,
      mentionSessionId: mentionEntry?.session.id,
      running: members.some((session) => session.isRunning) || reviewRunning,
      owner: ownerKey(
        workspace?.createdBy || members[0]?.startedBy,
        canonicalNames,
      ),
    };
  };

  for (const [workspaceId, members] of sessionsByWorkspace) {
    const workspace =
      workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
    const namedSession = members.find((session) => session.workspaceName);
    rows.push(
      createRow(
        `workspace:${workspaceId}`,
        workspace,
        workspace?.name ||
          namedSession?.workspaceName ||
          members[0]?.title ||
          "Workspace",
        members,
      ),
    );
  }

  for (const workspace of workspaces) {
    if (!workspace.draft || sessionsByWorkspace.has(workspace.id)) continue;
    rows.push({
      ...createRow(`workspace:${workspace.id}`, workspace, workspace.name, []),
      lastActivity: workspace.draft.updatedAt,
      createdAt: workspace.createdAt,
    });
  }

  const sessionsByWorktree = new Map<string, UnifiedSession[]>();
  const looseSessions: UnifiedSession[] = [];
  for (const session of ungrouped) {
    if (!session.worktreeDir?.includes("/worktrees/")) {
      looseSessions.push(session);
      continue;
    }
    const members = sessionsByWorktree.get(session.worktreeDir) ?? [];
    members.push(session);
    sessionsByWorktree.set(session.worktreeDir, members);
  }

  for (const [worktreeDir, members] of sessionsByWorktree) {
    members.sort((a, b) =>
      (a.createdAt || "").localeCompare(b.createdAt || ""),
    );
    const renamed = members.find((session) => session.titleOverridden);
    rows.push(
      createRow(
        `wt:${worktreeDir}`,
        null,
        renamed?.title ||
          members[0]?.branch ||
          members[0]?.title ||
          "Workspace",
        members,
      ),
    );
  }
  for (const session of looseSessions) {
    rows.push(createRow(session.id, null, session.title, [session]));
  }

  const sortKey = sort === "created" ? "createdAt" : "lastActivity";
  return rows.sort((a, b) =>
    (b[sortKey] || "").localeCompare(a[sortKey] || ""),
  );
}
