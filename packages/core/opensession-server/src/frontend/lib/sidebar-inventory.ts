import type { OpenPr } from "./api";
import { useAutomationOverview } from "./automation-overview";
import { mentionFor } from "./mentions";
import { usePeople } from "./people";
import { filterSidebarSessions, sortSidebarSessions } from "./sidebar-derived";
import { useSidebarFilter } from "./sidebar-filter";
import {
  isClaimed,
  mineStatus,
  pinnedLane,
  prLaneForSessions,
} from "./sidebar-lanes";
import { sidebarPersonSessions } from "./sidebar-people";
import { buildWorkspaceRows } from "./sidebar-workspace-rows";
import {
  subagentsByWorkspace,
  workspaceRowOwnsSelection,
} from "./sidebar-workspaces";
import type { UnifiedSession, Workspace } from "./types";

interface SidebarInventoryOptions {
  sessions: UnifiedSession[];
  workspaces: Workspace[];
  openPrs: OpenPr[];
  filter: ReturnType<typeof useSidebarFilter>;
  search: string;
  canonicalNames: Map<string, string>;
  selectedId: string | null;
  selectedWorkspaceId: string | null;
  reads: Record<string, string>;
  roster: ReturnType<typeof usePeople>;
  currentUser: string;
  peopleActivityNow: number;
  automationOverview: ReturnType<typeof useAutomationOverview>;
}

export function deriveSidebarInventory({
  sessions,
  workspaces,
  openPrs,
  filter,
  search,
  canonicalNames,
  selectedId,
  selectedWorkspaceId,
  reads,
  roster,
  currentUser,
  peopleActivityNow,
  automationOverview,
}: SidebarInventoryOptions) {
  const selectedSession =
    sessions.find(
      (session) =>
        session.id === selectedId ||
        session.aliasIds?.includes(selectedId || ""),
    ) || null;
  const filtered = filterSidebarSessions({
    sessions,
    workspaces,
    filter,
    search,
    canonicalNames,
    selectedSession,
    selectedWorkspaceId,
  });
  const sorted = sortSidebarSessions(filtered, filter.sort);

  // Child sessions belong to their root workspace, not to whichever temporary
  // workspace they created. Derive every family from the complete live list,
  // then keep only groups whose root row survives the current lens.
  const visibleWorkspaceIds = new Set(
    filtered.flatMap((session) =>
      session.workspaceId ? [session.workspaceId] : [],
    ),
  );
  const subagentsByWorkspaceId = new Map(
    Array.from(subagentsByWorkspace(sessions)).filter(([workspaceId]) =>
      visibleWorkspaceIds.has(workspaceId),
    ),
  );
  const workspaceSubagentIds = new Set(
    Array.from(subagentsByWorkspaceId.values()).flatMap((items) =>
      items.map(({ session }) => session.id),
    ),
  );

  // Team activity is independent of the workspace lens. Repo, person, and
  // search filters must not make running teammates disappear.
  const activePersonGroups = sidebarPersonSessions(
    sessions,
    roster,
    currentUser,
    peopleActivityNow,
    new Map(
      Array.from(automationOverview, ([name, overview]) => [
        name,
        overview.owner,
      ]),
    ),
    new Set(
      sessions
        .filter((session) => isClaimed(session))
        .map((session) => session.id),
    ),
  );

  const allWsRows = buildWorkspaceRows({
    sessions: filtered,
    workspaces,
    openPrs,
    nestedSubagentIds: workspaceSubagentIds,
    selectedWorkspaceId,
    selectedSessionId: selectedId,
    reads,
    canonicalNames,
    sort: filter.sort,
    isClaimed,
    statusForSession: mineStatus,
    pinnedLaneForSession: pinnedLane,
    prLaneForSessions,
    mentionForSession: mentionFor,
  });
  const rowOwnsSelection = (row: (typeof allWsRows)[number]) =>
    workspaceRowOwnsSelection(row, selectedSession, selectedWorkspaceId);
  const selectionBelongsToWorkspaceRow = allWsRows.some(rowOwnsSelection);
  const automationRowSelected = (session: UnifiedSession) =>
    session.id === selectedId && !selectionBelongsToWorkspaceRow;

  return {
    activePersonGroups,
    allWsRows,
    automationRowSelected,
    filtered,
    rowOwnsSelection,
    sorted,
    subagentsByWorkspaceId,
    workspaceSubagentIds,
  };
}
