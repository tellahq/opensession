import type { OpenPr } from "./api";
import { buildReviewQueue, type ReviewQueueItem } from "./review-queue";
import {
  AGENT_PERSON_KEY,
  automationInPersonLens,
  automationInRepoLens,
  HOUSE_AUTOMATION,
} from "./automation-audience";
import { AGENT_NAME } from "./brand";
import type { AutomationOverviewByName } from "./automation-overview";
import type { FilterState } from "./sidebar-filter";
import { includesEmptyRepoBands, sessionRepo } from "./sidebar-filter";
import { mergeRepoOrder, normalizeRepoOrder } from "./repo-order";
import { ownerKeyOf, sessionOwners } from "./session-owner";
import { personNameForKey } from "./people";
import { sessionSharesSelectedSidebarGroup } from "./sidebar-workspaces";
import {
  placeSidebarRows,
  rowAutoCreatedInLens,
  rowWasAutoCreated,
} from "./sidebar-placement";
import { SNOOZE_SOMEDAY } from "./snoozes";
import { sessionCarriesPr } from "./session-prs";
import { workspaceCarriesPr } from "./pr-workspace";
import type { Group, WsRow } from "./sidebar-types";
import type {
  FeedItem,
  SupportThread,
  UnifiedSession,
  Workspace,
} from "./types";

export interface SidebarPersonOption {
  key: string;
  label: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function supportThreadFromFeedItem(
  item: FeedItem,
): SupportThread | null {
  const meta = item.meta;
  if (
    !isRecord(meta) ||
    typeof meta.id !== "string" ||
    !isNullableString(meta.title) ||
    !isNullableString(meta.previewText) ||
    !isNullableString(meta.status) ||
    !isNullableString(meta.statusChangedAt) ||
    !isNullableString(meta.createdAt) ||
    !(meta.priority === null || typeof meta.priority === "number") ||
    !isRecord(meta.customer) ||
    !isNullableString(meta.customer.name) ||
    !isNullableString(meta.customer.email)
  ) {
    return null;
  }

  let labels: SupportThread["labels"];
  if (meta.labels !== undefined) {
    if (!Array.isArray(meta.labels)) return null;
    labels = [];
    for (const label of meta.labels) {
      if (
        !isRecord(label) ||
        typeof label.id !== "string" ||
        typeof label.typeId !== "string" ||
        typeof label.name !== "string" ||
        !isNullableString(label.icon)
      ) {
        return null;
      }
      labels.push({
        id: label.id,
        typeId: label.typeId,
        name: label.name,
        icon: label.icon,
      });
    }
  }

  let assignee: SupportThread["assignee"];
  if (meta.assignee === null) {
    assignee = null;
  } else if (meta.assignee !== undefined) {
    if (
      !isRecord(meta.assignee) ||
      typeof meta.assignee.id !== "string" ||
      typeof meta.assignee.name !== "string" ||
      typeof meta.assignee.isBot !== "boolean"
    ) {
      return null;
    }
    assignee = {
      id: meta.assignee.id,
      name: meta.assignee.name,
      isBot: meta.assignee.isBot,
    };
  }

  return {
    id: meta.id,
    title: meta.title,
    previewText: meta.previewText,
    status: meta.status,
    statusChangedAt: meta.statusChangedAt,
    createdAt: meta.createdAt,
    priority: meta.priority,
    customer: {
      name: meta.customer.name,
      email: meta.customer.email,
    },
    ...(labels === undefined ? {} : { labels }),
    ...(assignee === undefined ? {} : { assignee }),
  };
}

export function supportThreadsFromFeedItems(
  items: FeedItem[],
): SupportThread[] {
  return items.flatMap((item) => {
    const thread = supportThreadFromFeedItem(item);
    return thread ? [thread] : [];
  });
}

export function latestSupportSessionsByThread(
  sessions: UnifiedSession[],
): Map<string, UnifiedSession> {
  const latest = new Map<string, UnifiedSession>();
  for (const session of sessions) {
    if (session.archived || !session.plainThreadId) continue;
    const previous = latest.get(session.plainThreadId);
    if (!previous || session.lastActivity > previous.lastActivity) {
      latest.set(session.plainThreadId, session);
    }
  }
  return latest;
}

export function discoverSidebarRepos(
  registeredRepos: string[],
  sessions: UnifiedSession[],
  openPrs: OpenPr[],
): string[] {
  const counts = new Map(registeredRepos.map((repo) => [repo, 0]));
  for (const session of sessions) {
    if (session.archived || session.repoLess) continue;
    const repo = sessionRepo(session);
    counts.set(repo, (counts.get(repo) ?? 0) + 1);
  }
  for (const pr of openPrs) {
    counts.set(pr.repo, (counts.get(pr.repo) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([repo]) => repo);
}

export function completeSidebarRepoOrder(
  savedOrder: string[],
  discoveredRepos: string[],
): string[] {
  const order = normalizeRepoOrder(savedOrder);
  const seen = new Set(order);
  for (const repo of discoveredRepos) {
    if (seen.has(repo)) continue;
    seen.add(repo);
    order.push(repo);
  }
  return order;
}

export function orderedSidebarRepos(
  draftOrder: string[] | null,
  savedOrder: string[],
  discoveredRepos: string[],
): string[] {
  return mergeRepoOrder(draftOrder ?? savedOrder, discoveredRepos);
}

export function sidebarPeople(
  sessions: UnifiedSession[],
  canonicalNames: Map<string, string>,
  openPrs: OpenPr[],
): SidebarPersonOption[] {
  const people = sessionOwners(
    sessions.filter((session) => !session.archived),
    canonicalNames,
  );
  const seen = new Set(people.map(({ key }) => key));
  for (const pr of openPrs) {
    if (!pr.person || seen.has(pr.person)) continue;
    seen.add(pr.person);
    people.push({ key: pr.person, label: personNameForKey(pr.person) });
  }
  return people;
}

export function personLensName(
  person: string,
  team: Array<{ key: string; person: { name: string } }>,
  people: SidebarPersonOption[],
): string {
  if (person === "me") return "You";
  if (person === "everyone") return "All workspaces";
  if (person === "unassigned") return "Unassigned";
  if (person === AGENT_PERSON_KEY) return AGENT_NAME;
  return (
    team.find((member) => member.key === person)?.person.name ||
    people.find((option) => option.key === person)?.label ||
    person
  );
}

interface BuildAutomationGroupsInput {
  sessions: UnifiedSession[];
  nestedSubagentIds: ReadonlySet<string>;
  automationOverview: AutomationOverviewByName;
  filter: FilterState;
  currentUser: string;
  isClaimed: (session: UnifiedSession) => boolean;
}

export function buildAutomationGroups({
  sessions,
  nestedSubagentIds,
  automationOverview,
  filter,
  currentUser,
  isClaimed,
}: BuildAutomationGroupsInput): Group[] {
  const sessionsByAutomation = new Map<string, UnifiedSession[]>();
  for (const session of sessions) {
    const name =
      typeof session.automation === "string" ? session.automation.trim() : "";
    if (!name || nestedSubagentIds.has(session.id) || isClaimed(session)) {
      continue;
    }
    const items = sessionsByAutomation.get(name) ?? [];
    items.push(session);
    sessionsByAutomation.set(name, items);
  }

  const groups: Group[] = [];
  const names = [...sessionsByAutomation.keys()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
  for (const name of names) {
    const overview = automationOverview.get(name) ?? HOUSE_AUTOMATION;
    if (
      automationOverview.size > 0 &&
      (!automationInPersonLens(overview, filter.person, currentUser) ||
        !automationInRepoLens(overview, filter.repo))
    ) {
      continue;
    }
    const items = sessionsByAutomation.get(name)!;
    groups.push({
      key: `auto:${name}`,
      label: name,
      dotColor: "var(--yellow)",
      band: "automations",
      items,
      totalItems: Math.max(
        items.length,
        ...items.map((session) => session.automationRunCount || 0),
      ),
    });
  }
  return groups;
}

export function automationActivityKey(sessions: UnifiedSession[]): string {
  let newest = "";
  let count = 0;
  for (const session of sessions) {
    if (!session.automation || session.archived) continue;
    count += 1;
    if (session.lastActivity > newest) newest = session.lastActivity;
  }
  return `${count}:${newest}`;
}

export function withAgentPerson(
  people: SidebarPersonOption[],
  automationOverview: AutomationOverviewByName,
): SidebarPersonOption[] {
  const hasUnownedAutomation = [...automationOverview.values()].some(
    (automation) => !automation.owner,
  );
  if (
    !hasUnownedAutomation ||
    people.some(({ key }) => key === AGENT_PERSON_KEY)
  ) {
    return people;
  }
  return [...people, { key: AGENT_PERSON_KEY, label: AGENT_NAME }];
}

interface FilterSidebarSessionsInput {
  sessions: UnifiedSession[];
  workspaces: Workspace[];
  filter: FilterState;
  search: string;
  canonicalNames: Map<string, string>;
  selectedSession: UnifiedSession | null;
  selectedWorkspaceId?: string | null;
}

export function filterSidebarSessions({
  sessions,
  workspaces,
  filter,
  search,
  canonicalNames,
  selectedSession,
  selectedWorkspaceId,
}: FilterSidebarSessionsInput): UnifiedSession[] {
  const belongsToSelection = (session: UnifiedSession) =>
    sessionSharesSelectedSidebarGroup(
      session,
      selectedSession,
      selectedWorkspaceId,
    );
  let visible = sessions.filter((session) => !session.archived);

  if (filter.repo !== "all") {
    const workspaceRepos = new Map(
      workspaces.map((workspace) => [workspace.id, workspace.repo]),
    );
    visible = visible.filter(
      (session) =>
        belongsToSelection(session) ||
        (!session.repoLess &&
          (sessionRepo(session) === filter.repo ||
            (!!session.workspaceId &&
              workspaceRepos.get(session.workspaceId) === filter.repo))),
    );
  }

  if (
    filter.person !== "me" &&
    filter.person !== "everyone" &&
    filter.person !== "unassigned"
  ) {
    visible = visible.filter(
      (session) =>
        belongsToSelection(session) ||
        !!session.automation ||
        (!!session.startedBy &&
          ownerKeyOf(session, canonicalNames) === filter.person),
    );
  }

  if (!search) return visible;
  const query = search.toLowerCase();
  return visible.filter(
    (session) =>
      belongsToSelection(session) ||
      session.title.toLowerCase().includes(query) ||
      (session.branch || "").toLowerCase().includes(query) ||
      (session.startedBy || "").toLowerCase().includes(query) ||
      (session.automation || "").toLowerCase().includes(query),
  );
}

interface DeriveSidebarPrRowsInput {
  openPrs: OpenPr[];
  sessions: UnifiedSession[];
  currentUser: string;
  githubLogin: string | null;
  workspaceRows: WsRow[];
  workspaceDataReady: boolean;
  filter: FilterState;
  search: string;
}

export function deriveSidebarPrRows({
  openPrs,
  sessions,
  currentUser,
  githubLogin,
  workspaceRows,
  workspaceDataReady,
  filter,
  search,
}: DeriveSidebarPrRowsInput): {
  reviewQueueItems: ReviewQueueItem[];
  workspaceCoveredPrUrls: Set<string>;
  prRowItems: ReviewQueueItem[];
} {
  const reviewQueueItems = buildReviewQueue(
    openPrs,
    sessions,
    currentUser,
    githubLogin,
  );
  const workspaceCoveredPrUrls = new Set<string>();
  for (const item of reviewQueueItems) {
    if (
      workspaceRows.some(
        (row) =>
          (!!row.workspace && workspaceCarriesPr(row.workspace, item.pr)) ||
          row.sessions.some((session) => sessionCarriesPr(session, item.pr)),
      )
    ) {
      workspaceCoveredPrUrls.add(item.pr.url);
    }
  }

  if (!workspaceDataReady || filter.prs === "none") {
    return { reviewQueueItems, workspaceCoveredPrUrls, prRowItems: [] };
  }
  const query = search.trim().toLowerCase();
  const prRowItems = reviewQueueItems.filter((item) => {
    if (workspaceCoveredPrUrls.has(item.pr.url)) return false;
    if (filter.repo !== "all" && item.pr.repo !== filter.repo) return false;
    if (
      query &&
      ![item.pr.title, item.pr.branch, item.pr.author].some((value) =>
        value.toLowerCase().includes(query),
      )
    ) {
      return false;
    }
    if (filter.person === "unassigned") return false;
    if (filter.person !== "me" && filter.person !== "everyone") {
      return item.pr.person === filter.person;
    }
    if (filter.prs === "all") return true;
    return item.source === "mine" || item.source === "requested";
  });
  return { reviewQueueItems, workspaceCoveredPrUrls, prRowItems };
}

export function workspaceRowIsFeedOnly(
  row: WsRow,
  feedRefKinds: ReadonlySet<string>,
): boolean {
  return (
    !row.workspace?.repo &&
    !!row.workspace?.externalRefs?.length &&
    feedRefKinds.has(row.workspace.externalRefs[0]!.kind)
  );
}

interface DeriveWorkspacePlacementInput {
  rows: WsRow[];
  filter: FilterState;
  currentUser: string;
  activeSnoozeKeys: ReadonlySet<string>;
  feedRefKinds: ReadonlySet<string>;
  ownsSelection: (row: WsRow) => boolean;
  isClaimed: (session: UnifiedSession) => boolean;
  hasPersonalLane: (sessionId: string) => boolean;
}

export function deriveWorkspacePlacement({
  rows,
  filter,
  currentUser,
  activeSnoozeKeys,
  feedRefKinds,
  ownsSelection,
  isClaimed,
  hasPersonalLane,
}: DeriveWorkspacePlacementInput) {
  const focus =
    filter.person === "me" ? currentUser.toLowerCase() : filter.person;
  const inScope = (row: WsRow, showAutoCreated: boolean) =>
    (ownsSelection(row) ||
      (focus === "everyone" && (showAutoCreated || !rowWasAutoCreated(row))) ||
      (showAutoCreated && rowAutoCreatedInLens(row, filter.person)) ||
      (focus === "unassigned"
        ? row.status === "pending"
        : (row.owner === focus &&
            (showAutoCreated || !rowWasAutoCreated(row))) ||
          (!!row.mention && focus === currentUser.toLowerCase()) ||
          row.sessions.some(
            (session) =>
              !session.automation &&
              (session.startedBy || "").toLowerCase() === focus,
          ) ||
          ((row.owner === "" || focus === currentUser.toLowerCase()) &&
            row.sessions.some(isClaimed)))) &&
    (!workspaceRowIsFeedOnly(row, feedRefKinds) ||
      row.running ||
      row.status === "needsinput");
  const showAutoCreated = filter.autoCreated !== "hide";
  const placedWsRows = placeSidebarRows(rows, (row) => ({
    currentUser,
    personFilter: filter.person,
    snoozed: activeSnoozeKeys.has(row.key),
    inStatusScope: inScope(row, showAutoCreated),
    claimed: row.sessions.some((session) => hasPersonalLane(session.id)),
  }));
  const autoCreatedRows = placedWsRows.filter(
    (entry) =>
      rowWasAutoCreated(entry.row) &&
      (showAutoCreated
        ? entry.placement === "status" && !inScope(entry.row, false)
        : entry.placement === "outside" && inScope(entry.row, true)),
  ).length;
  return { placedWsRows, autoCreatedRows };
}

export function sortSnoozedWorkspaceRows(
  rows: WsRow[],
  snoozes: Record<string, string>,
): WsRow[] {
  return [...rows].sort((a, b) => {
    const aUntil = snoozes[a.key];
    const bUntil = snoozes[b.key];
    if (aUntil === SNOOZE_SOMEDAY && bUntil !== SNOOZE_SOMEDAY) return 1;
    if (bUntil === SNOOZE_SOMEDAY && aUntil !== SNOOZE_SOMEDAY) return -1;
    return Date.parse(aUntil || "") - Date.parse(bUntil || "");
  });
}

export function pinnedWorkspaceRows(
  rows: WsRow[],
  pins: string[],
  activeSnoozeKeys: ReadonlySet<string>,
): WsRow[] {
  const pinSet = new Set(pins);
  const pinIndex = new Map(pins.map((pin, index) => [pin, index] as const));
  const rowIndex = (row: WsRow) => {
    const matches = [row.key, ...row.sessions.map((session) => session.id)]
      .map((key) => pinIndex.get(key))
      .filter((index): index is number => index !== undefined);
    return matches.length ? Math.min(...matches) : Infinity;
  };
  return rows
    .filter(
      (row) =>
        !activeSnoozeKeys.has(row.key) &&
        (pinSet.has(row.key) ||
          row.sessions.some((session) => pinSet.has(session.id))),
    )
    .sort((a, b) => rowIndex(a) - rowIndex(b));
}

export function sortSidebarSessions(
  sessions: UnifiedSession[],
  sort: FilterState["sort"],
): UnifiedSession[] {
  const key = sort === "created" ? "createdAt" : "lastActivity";
  return [...sessions].sort(
    (a, b) => new Date(b[key]).getTime() - new Date(a[key]).getTime(),
  );
}

export interface SidebarProjectBand {
  repo: string;
  rows: WsRow[];
  snoozedRows: WsRow[];
  needsReviewRows: WsRow[];
  approvedRows: WsRow[];
  awaitingReviewRows: WsRow[];
  prs: ReviewQueueItem[];
  requestedPrs: ReviewQueueItem[];
  urgent: number;
}

export interface SidebarProjectBands {
  scratchRows: WsRow[];
  scratchSnoozedRows: WsRow[];
  bands: SidebarProjectBand[];
  order: string[];
  fullOrder: string[];
  canReorder: boolean;
}

interface DeriveSidebarProjectBandsInput {
  activeRows: WsRow[];
  snoozedRows: WsRow[];
  needsReviewRows: WsRow[];
  approvedRows: WsRow[];
  awaitingReviewRows: WsRow[];
  lanePrItems: ReviewQueueItem[];
  requestedPrItems: ReviewQueueItem[];
  registeredRepos: string[];
  repos: string[];
  savedRepoOrder: string[];
  filter: FilterState;
  search: string;
  isPhone: boolean;
  askBand: string;
  rowIsFeedOnly: (row: WsRow) => boolean;
  rowIsScratch: (row: WsRow) => boolean;
  rowIsAsk: (row: WsRow) => boolean;
  workspaceRepo: (row: WsRow) => string;
}

/** Build the rows for each project band without deciding how a row renders. */
export function deriveSidebarProjectBands({
  activeRows,
  snoozedRows,
  needsReviewRows,
  approvedRows,
  awaitingReviewRows,
  lanePrItems,
  requestedPrItems,
  registeredRepos,
  repos,
  savedRepoOrder,
  filter,
  search,
  isPhone,
  askBand,
  rowIsFeedOnly,
  rowIsScratch,
  rowIsAsk,
  workspaceRepo,
}: DeriveSidebarProjectBandsInput): SidebarProjectBands {
  const byRepo = new Map<string, WsRow[]>();
  const snoozedByRepo = new Map<string, WsRow[]>();
  // Scratch workspaces stay in one unlabelled group above the project bands.
  // They have no project, even when an older workspace record carries a stale
  // repo.
  const scratchRows = activeRows.filter(
    (row) => !rowIsFeedOnly(row) && rowIsScratch(row),
  );
  const scratchSnoozedRows = snoozedRows.filter(
    (row) => !rowIsFeedOnly(row) && rowIsScratch(row),
  );
  const bucket = <T>(map: Map<string, T[]>, repo: string): T[] => {
    const existing = map.get(repo);
    if (existing) return existing;
    const items: T[] = [];
    map.set(repo, items);
    return items;
  };
  // Feed workspaces are represented by their feed band's item rows, so they
  // must not also mint a pseudo-repo band. Repo-less Ask rows bucket under the
  // dedicated Ask band before the workspace-repo fallback can file them under
  // the default project.
  const bandOf = (row: WsRow) => (rowIsAsk(row) ? askBand : workspaceRepo(row));
  const nestsInProject = (row: WsRow) =>
    !rowIsFeedOnly(row) && !rowIsScratch(row);

  for (const row of activeRows) {
    if (nestsInProject(row)) bucket(byRepo, bandOf(row)).push(row);
  }
  // Each project's snoozed rows stay in that project's own band, as a Snoozed
  // group beside its other lanes. A global group would strand them away from
  // the project they belong to.
  for (const row of snoozedRows) {
    if (nestsInProject(row)) bucket(snoozedByRepo, bandOf(row)).push(row);
  }

  // Session-less PR rows file into their project's status lanes. Requests
  // pointed at you are excluded because they ride Needs review instead.
  const prByRepo = new Map<string, ReviewQueueItem[]>();
  for (const item of lanePrItems) bucket(prByRepo, item.pr.repo).push(item);

  // Review rows are absent from the status rows, so bucket them separately.
  // A project whose only work is a review still earns a band.
  const reviewByRepo = (source: WsRow[]) => {
    const map = new Map<string, WsRow[]>();
    for (const row of source) {
      if (nestsInProject(row)) bucket(map, bandOf(row)).push(row);
    }
    return map;
  };
  const needsReviewByRepo = reviewByRepo(needsReviewRows);
  const approvedByRepo = reviewByRepo(approvedRows);
  const awaitingReviewByRepo = reviewByRepo(awaitingReviewRows);
  // GitHub requests pointed at you ride the Needs review lane, keyed by the
  // PR's own project. They stay out of prByRepo's status lanes.
  const requestedPrByRepo = new Map<string, ReviewQueueItem[]>();
  for (const item of requestedPrItems) {
    bucket(requestedPrByRepo, item.pr.repo).push(item);
  }

  const present = new Set([
    ...byRepo.keys(),
    ...snoozedByRepo.keys(),
    ...needsReviewByRepo.keys(),
    ...approvedByRepo.keys(),
    ...awaitingReviewByRepo.keys(),
    ...prByRepo.keys(),
    ...requestedPrByRepo.keys(),
  ]);
  // A fresh registered repo still earns a project band in the default lens.
  // Search and teammate lenses stay result-driven, as does a list configured
  // to hide empty projects. A single-project filter still shows its empty band
  // because that band is what the person explicitly asked for.
  if (includesEmptyRepoBands(filter, search)) {
    for (const repo of registeredRepos) {
      if (filter.repo === "all" || filter.repo === repo) present.add(repo);
    }
  }

  // Repositories follow the shared preference, with newly seen repositories
  // appended in discovery order. The renderer surfaces selected rows from a
  // collapsed band so the open session never disappears.
  const order = [
    ...repos.filter((repo) => present.has(repo)),
    ...Array.from(present).filter(
      (repo) => !repos.includes(repo) && repo !== askBand,
    ),
  ];
  // Ask is pinned above every project and takes no part in reorder or storage.
  // fullOrder stays sentinel-free while order describes the rendered layout.
  const fullOrder = normalizeRepoOrder([
    ...normalizeRepoOrder(savedRepoOrder),
    ...repos.filter((repo) => !savedRepoOrder.includes(repo)),
    ...order.filter((repo) => !repos.includes(repo)),
  ]);
  if (present.has(askBand)) order.unshift(askBand);

  const bands = order.map((repo) => {
    const rows = byRepo.get(repo) ?? [];
    const bandNeedsReviewRows = needsReviewByRepo.get(repo) ?? [];
    const requestedPrs = requestedPrByRepo.get(repo) ?? [];
    return {
      repo,
      rows,
      snoozedRows: snoozedByRepo.get(repo) ?? [],
      needsReviewRows: bandNeedsReviewRows,
      approvedRows: approvedByRepo.get(repo) ?? [],
      awaitingReviewRows: awaitingReviewByRepo.get(repo) ?? [],
      prs: prByRepo.get(repo) ?? [],
      requestedPrs,
      urgent:
        rows.filter((row) => row.status === "needsinput").length +
        bandNeedsReviewRows.length +
        requestedPrs.length,
    };
  });

  return {
    scratchRows,
    scratchSnoozedRows,
    bands,
    order,
    fullOrder,
    canReorder:
      !isPhone &&
      filter.repo === "all" &&
      order.filter((repo) => repo !== askBand).length > 1,
  };
}
