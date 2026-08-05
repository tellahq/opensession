import React, { useEffect, useMemo, useState } from "react";
import type { Project, UnifiedSession } from "../lib/types";
import { fetchHomeStats, fetchRecentPrs, type HomeStats, type RecentPr } from "../lib/api";
import { prStatusMark, type PrStatusInput } from "../lib/pr-status";
import { Button } from "../ui/button";
import { useIsPhone } from "../hooks/useIsPhone";
import { useCurrentUser } from "./UserPicker";
import { UserAvatar } from "./UserAvatar";
import { RepoTile, repoLabel } from "./RepoTile";
import { TeamFacepile, useTeamPresence } from "./TeamPresence";
import { Menu } from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
import {
  IconArchive,
  IconCheck,
  IconChevronDown,
  IconDotsHorizontal,
  IconFolder,
  IconGitMerge,
  IconPullRequest,
  IconRepo,
  IconSearch,
  IconX,
} from "./icons";

interface Props {
  sessions: UnifiedSession[];
  projects: Project[];
  onSelect: (session: UnifiedSession) => void;
  onNewSession: () => void;
  onOpenAnalytics?: () => void;
  /** Who's viewing what right now (global presence), for the team face pile. */
  teamViewing?: Array<{ user: string; sessionId: string }>;
}

interface WorktreeRow extends PrStatusInput {
  key: string;
  session?: UnifiedSession;
  title: string;
  repo: string;
  branch: string;
  url?: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  number?: number;
  additions?: number;
  deletions?: number;
  updatedAt: string;
  projectId?: string | null;
  archived: boolean;
  person: string | null;
  author?: string;
}

function cleanTitle(title: string): string {
  return (
    title
      .replace(/^(Review|Auto-fix|Mention|Simplify|Fix)\s*·\s*PR\s*#\d+\s*/i, "")
      .trim() || title
  );
}

function worktreesForSession(session: UnifiedSession): WorktreeRow[] {
  if (session.sideChatOf || session.desk) return [];

  if (session.prs?.some((pr) => pr.url)) {
    return session.prs
      .filter((pr) => pr.url)
      .map((pr) => {
        const primary = pr.source === "primary" || pr.url === session.prUrl;
        return {
          key: pr.url || `${pr.repo}:${pr.branch}`,
          session,
          title: cleanTitle(pr.title || (primary ? session.prTitle : "") || session.title),
          repo: pr.repo,
          branch: pr.branch,
          url: pr.url,
          state: pr.state || "OPEN",
          number: pr.number,
          isDraft: pr.isDraft,
          reviewDecision: pr.reviewDecision,
          // Only the primary branch's PR carries a conflict probe.
          mergeable: primary ? session.prMergeable : undefined,
          checks: pr.checks,
          additions: primary ? session.prAdditions : undefined,
          deletions: primary ? session.prDeletions : undefined,
          updatedAt: primary ? session.prUpdatedAt || session.lastActivity : session.lastActivity,
          projectId: session.projectId,
          archived: !!session.archived,
          person: session.startedBy?.toLowerCase() || null,
          author: primary ? session.prAuthor : undefined,
        };
      });
  }

  if (!session.prUrl) return [];
  return [
    {
      key: session.prUrl,
      session,
      title: cleanTitle(session.prTitle || session.title),
      repo: session.repo || "repository",
      branch: session.branch || "",
      url: session.prUrl,
      state: session.prState || "OPEN",
      number: session.prNumber,
      isDraft: session.prIsDraft,
      reviewDecision: session.prReviewDecision,
      mergeable: session.prMergeable,
      checks: session.prChecks,
      additions: session.prAdditions,
      deletions: session.prDeletions,
      updatedAt: session.prUpdatedAt || session.lastActivity,
      projectId: session.projectId,
      archived: !!session.archived,
      person: session.startedBy?.toLowerCase() || null,
      author: session.prAuthor,
    },
  ];
}

function dateGroup(value: string): string {
  const date = new Date(value);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const then = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.max(0, Math.floor((start - then) / 86_400_000));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 35) {
    const weeks = Math.floor(days / 7);
    return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  }
  const months = Math.max(
    1,
    (now.getFullYear() - date.getFullYear()) * 12 + now.getMonth() - date.getMonth(),
  );
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

function compactAge(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 86_400)}d`;
  if (seconds < 31_536_000) return `${Math.floor(seconds / 2_592_000)}mo`;
  return `${Math.floor(seconds / 31_536_000)}y`;
}

function compactDiff(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) return String(abs);
  if (abs < 10_000) return `${(abs / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(abs / 1000)}k`;
}

function personLabel(person: string): string {
  return person
    .split(/[._-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const compactFmt = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const fmtCompact = (n: number) => compactFmt.format(n);
const HOME_STATS_CACHE_KEY = "opensession.homeStats.v1";

function readCachedHomeStats(): HomeStats | null {
  try {
    const cached = JSON.parse(
      localStorage.getItem(HOME_STATS_CACHE_KEY) || "null",
    ) as Partial<HomeStats> | null;
    return cached?.today && cached.week ? (cached as HomeStats) : null;
  } catch {
    return null;
  }
}

function cacheHomeStats(stats: HomeStats): void {
  try {
    localStorage.setItem(HOME_STATS_CACHE_KEY, JSON.stringify(stats));
  } catch {
    // Stats still render when storage is unavailable.
  }
}

function fmtAgentTime(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.round(ms / 60_000)}m`;
  return `${hours >= 10 ? Math.round(hours) : hours.toFixed(1)}h`;
}

function StatCell({
  value,
  label,
  sub,
  title,
  dot,
  loading,
  divider,
  rowDivider,
}: {
  value: string;
  label: string;
  sub?: string;
  title?: string;
  dot?: "live" | "idle";
  loading?: boolean;
  divider?: string;
  rowDivider?: string;
}) {
  return (
    <div
      className="relative min-w-0 px-5 py-3 transition-colors group-hover:bg-panel max-[720px]:px-4 max-[720px]:py-2.5"
      title={title}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-3 left-0 w-px bg-line ${divider ?? "hidden"}`}
      />
      <span
        aria-hidden="true"
        className={`absolute inset-x-4 top-0 h-px bg-line ${rowDivider ?? "hidden"}`}
      />
      <div className="flex items-center gap-1.5">
        {loading ? (
          <span className="my-1 h-4 w-10 rounded-sm bg-line motion-safe:animate-pulse" />
        ) : (
          dot && (
            <span
              className={
                dot === "live"
                  ? "h-2 w-2 shrink-0 animate-pulse rounded-full bg-green"
                  : "h-2 w-2 shrink-0 rounded-full bg-line"
              }
            />
          )
        )}
        {!loading && (
          <span
            className="truncate text-section-title font-semibold leading-6 tabular-nums text-fg"
          >
            {value}
          </span>
        )}
      </div>
      <div className="truncate text-meta leading-4 text-dim">{label}</div>
      {loading ? (
        <div className="flex h-4 items-center">
          <span className="h-2.5 w-14 rounded-sm bg-line motion-safe:animate-pulse" />
        </div>
      ) : (
        sub && <div className="truncate text-meta leading-4 text-faint">{sub}</div>
      )}
    </div>
  );
}

function OverviewStrip({
  running,
  stats,
  onOpenAnalytics,
}: {
  running: number;
  stats: HomeStats | null;
  onOpenAnalytics?: () => void;
}) {
  const today = stats?.today;
  const week = stats?.week;
  return (
    <button
      type="button"
      onClick={onOpenAnalytics}
      title={stats ? "Open Analytics" : "Analytics are loading"}
      aria-busy={!stats}
      className="group mt-6 grid w-full cursor-pointer grid-cols-5 overflow-hidden rounded-xl bg-raised p-0 text-left outline-none transition-[background,box-shadow] hover:bg-panel focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] max-[860px]:grid-cols-3 max-[560px]:grid-cols-2"
    >
      <StatCell
        value={fmtCompact(running)}
        label={running === 1 ? "agent running now" : "agents running now"}
        dot={running > 0 ? "live" : "idle"}
      />
      <StatCell
        value={today ? fmtCompact(today.sessions) : ""}
        label="sessions today"
        sub={week ? `${fmtCompact(week.sessions)} · 7d` : undefined}
        loading={!stats}
        divider="block"
      />
      <StatCell
        value={today ? fmtCompact(today.turns) : ""}
        label="turns today"
        sub={week ? `${fmtCompact(week.turns)} · 7d` : undefined}
        title={today ? `${today.errors.toLocaleString()} errors today` : undefined}
        loading={!stats}
        divider="block max-[560px]:hidden"
        rowDivider="hidden max-[560px]:block"
      />
      <StatCell
        value={today ? fmtAgentTime(today.durationMs) : ""}
        label="agent time today"
        sub={week ? `${fmtAgentTime(week.durationMs)} · 7d` : undefined}
        loading={!stats}
        divider="hidden min-[861px]:block max-[560px]:block"
        rowDivider="hidden max-[860px]:block"
      />
      <StatCell
        value={today ? fmtCompact(today.outputTokens) : ""}
        label="tokens out today"
        sub={week ? `${fmtCompact(week.outputTokens)} · 7d` : undefined}
        title={
          today
            ? `${today.inputTokens.toLocaleString()} input · ${today.cacheReadTokens.toLocaleString()} cache read today`
            : undefined
        }
        loading={!stats}
        divider="block max-[560px]:hidden"
        rowDivider="hidden max-[860px]:block"
      />
    </button>
  );
}

function StateIcon({ state }: { state: WorktreeRow["state"] }) {
  if (state === "MERGED") return <IconGitMerge size={20} />;
  if (state === "CLOSED") return <IconArchive size={20} />;
  return <IconPullRequest size={20} />;
}

export function buildWorktreeRows(recentPrs: RecentPr[], sessions: UnifiedSession[]): WorktreeRow[] {
  const byPr = new Map<string, WorktreeRow>();
  for (const pr of recentPrs) {
    byPr.set(pr.url, {
      key: pr.url,
      title: pr.title,
      repo: pr.repo,
      branch: pr.branch,
      url: pr.url,
      state: pr.state,
      number: pr.number,
      isDraft: pr.isDraft,
      reviewDecision: pr.reviewDecision,
      checks: pr.checks,
      additions: pr.additions,
      deletions: pr.deletions,
      updatedAt: pr.updatedAt,
      projectId: null,
      archived: false,
      person: pr.person,
      author: pr.author,
    });
  }
  for (const session of sessions) {
    for (const row of worktreesForSession(session)) {
      const existing = byPr.get(row.key);
      byPr.set(row.key, {
        ...existing,
        ...row,
        // GitHub is authoritative; session enrichment can lag behind a merge.
        state: existing?.state ?? row.state,
        isDraft: existing?.isDraft ?? row.isDraft,
        reviewDecision: existing?.reviewDecision ?? row.reviewDecision,
        checks: existing?.checks ?? row.checks,
        mergeable: row.mergeable ?? existing?.mergeable,
        // Archiving a workspace should not remove its shipped PR from history.
        archived: existing ? false : row.archived,
        person: row.person || existing?.person || null,
        author: existing?.author || row.author,
        additions: row.additions ?? existing?.additions,
        deletions: row.deletions ?? existing?.deletions,
        updatedAt:
          existing && new Date(existing.updatedAt) > new Date(row.updatedAt)
            ? existing.updatedAt
            : row.updatedAt,
      });
    }
  }

  return [...byPr.values()].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export function Home({ sessions, projects, onSelect, onNewSession, onOpenAnalytics, teamViewing }: Props) {
  const currentUser = useCurrentUser();
  const isPhone = useIsPhone();
  const team = useTeamPresence({ sessions, teamViewing, currentUser });
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("all");
  const [repo, setRepo] = useState("all");
  const [person, setPerson] = useState(() =>
    currentUser === "Anonymous" ? "all" : currentUser.toLowerCase(),
  );
  const [showArchived, setShowArchived] = useState(false);
  const [recentPrs, setRecentPrs] = useState<RecentPr[]>([]);
  const [personPrs, setPersonPrs] = useState<RecentPr[]>([]);
  const [stats, setStats] = useState<HomeStats | null>(readCachedHomeStats);

  useEffect(() => {
    let active = true;
    const load = () =>
      fetchHomeStats()
        .then((data) => {
          if (!active) return;
          setStats(data);
          cacheHomeStats(data);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const running = useMemo(
    () => sessions.filter((s) => s.isRunning && !s.archived).length,
    [sessions],
  );

  useEffect(() => {
    let active = true;
    fetchRecentPrs()
      .then((prs) => active && setRecentPrs(prs))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (person === "all") {
      setPersonPrs([]);
      return;
    }
    let active = true;
    fetchRecentPrs(person)
      .then((prs) => active && setPersonPrs(prs))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [person]);

  const allWorktrees = useMemo(() => {
    const prs = new Map(recentPrs.map((pr) => [pr.url, pr]));
    for (const pr of personPrs) prs.set(pr.url, pr);
    return buildWorktreeRows([...prs.values()], sessions);
  }, [personPrs, recentPrs, sessions]);

  const worktrees = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allWorktrees
      .filter((row) => {
        if (!showArchived && row.archived) return false;
        if (projectId === "standalone" && row.projectId) return false;
        if (projectId !== "all" && projectId !== "standalone" && row.projectId !== projectId)
          return false;
        if (repo !== "all" && row.repo !== repo) return false;
        if (person !== "all" && row.person !== person) return false;
        if (!needle) return true;
        return [row.title, row.repo, row.branch, row.author, row.number ? `#${row.number}` : ""]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      });
  }, [allWorktrees, person, projectId, query, repo, showArchived]);

  const sections = useMemo(() => {
    const definitions: Array<{ state: WorktreeRow["state"]; label: string }> = [
      { state: "OPEN", label: "Open" },
      { state: "MERGED", label: "Merged" },
      { state: "CLOSED", label: "Closed" },
    ];
    return definitions.flatMap((definition) => {
      const rows = worktrees.filter((row) => row.state === definition.state);
      if (!rows.length) return [];
      const groups = new Map<string, WorktreeRow[]>();
      for (const row of rows) {
        const label = dateGroup(row.updatedAt);
        groups.set(label, [...(groups.get(label) || []), row]);
      }
      return [{ ...definition, rows, groups: [...groups.entries()] }];
    });
  }, [worktrees]);

  const projectOptions = useMemo(() => {
    const represented = new Set(sessions.filter((s) => s.prUrl || s.prs?.some((pr) => pr.url)).map((s) => s.projectId));
    return projects.filter((project) => represented.has(project.id));
  }, [projects, sessions]);

  const repoOptions = useMemo(
    () => [...new Set(allWorktrees.map((row) => row.repo).filter(Boolean))].sort(),
    [allWorktrees],
  );

  return (
    <div className="home bg-surface">
      <div className="mx-auto w-full max-w-[1040px] px-5 pb-16 pt-10 max-[720px]:px-4 max-[720px]:pt-5">
        <div className="flex items-center justify-between gap-4 px-2">
          <h1 className="m-0 text-page-title font-semibold tracking-[-0.025em] text-fg">Home</h1>
          <div className="flex min-w-0 items-center gap-3">
            {/* The team, as the person filter: a face picks whose worktrees
                this page shows, and the picked one says so in words next to
                the pile. Clicking the picked face (or the ✕) goes back to
                everyone. */}
            {team.length > 0 && (
              <div className="flex min-w-0 items-center gap-2.5">
                <TeamFacepile
                  members={team}
                  size={isPhone ? 24 : 27}
                  max={isPhone ? 4 : 8}
                  selectedKey={person === "all" ? null : person}
                  onSelect={(member) =>
                    setPerson((current) => (current === member.key ? "all" : member.key))
                  }
                />
                {person === "all" ? (
                  <span className="text-control-label text-faint max-[860px]:hidden">Everyone</span>
                ) : (
                  <button
                    className="flex items-center gap-1 rounded-md border-0 bg-transparent p-1 text-control-label text-dim hover:bg-hover hover:text-fg max-[860px]:hidden"
                    onClick={() => setPerson("all")}
                    title="Show everyone"
                  >
                    <span className="truncate">{personLabel(person)}</span>
                    <IconX size={15} />
                  </button>
                )}
              </div>
            )}
            <Button
              variant="ink"
              size="lg"
              className="text-control-label"
              onClick={onNewSession}
            >
              Create workspace
            </Button>
          </div>
        </div>

        <OverviewStrip running={running} stats={stats} onOpenAnalytics={onOpenAnalytics} />

        <div
          className={`mt-7 grid ${repoOptions.length > 1 ? "grid-cols-[minmax(180px,1fr)_auto_auto_auto]" : "grid-cols-[minmax(180px,1fr)_auto_auto]"} items-center gap-5 border-b border-line px-2 pb-4 max-[860px]:grid-cols-2 max-[720px]:grid-cols-1 max-[720px]:gap-2.5`}
        >
          <label className="flex min-w-0 items-center gap-2 text-faint focus-within:text-dim">
            <IconSearch size={20} />
            <input
              className="min-w-0 flex-1 border-0 bg-transparent p-0 text-body text-fg outline-none placeholder:text-faint"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              spellCheck={false}
            />
          </label>

          <label className="relative flex items-center gap-2 text-control-label text-dim hover:text-fg">
            <IconFolder size={20} />
            <select
              className="max-w-[190px] cursor-pointer appearance-none border-0 bg-transparent py-1 pl-0 pr-6 text-inherit outline-none"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="all">In all projects</option>
              {projectOptions.map((project) => (
                <option key={project.id} value={project.id}>
                  In {project.name}
                </option>
              ))}
              <option value="standalone">Standalone</option>
            </select>
            <IconChevronDown className="pointer-events-none absolute right-0" size={20} />
          </label>

          {repoOptions.length > 1 && (
            <Menu.Root>
              <Menu.Trigger className="flex items-center gap-2 rounded-md border-0 bg-transparent p-1 text-control-label text-dim hover:text-fg data-[popup-open]:text-fg">
                <IconRepo size={20} />
                <span className="max-w-[190px] truncate">
                  {repo === "all" ? "In all repos" : `In ${repoLabel(repo)}`}
                </span>
                <IconChevronDown size={20} />
              </Menu.Trigger>
              <Menu.Popup align="start">
                <Menu.RadioGroup value={repo} onValueChange={(value) => setRepo(String(value))}>
                  <Menu.RadioItem value="all" closeOnClick>
                    {/* Sized to the tiles below so every label shares one edge. */}
                    <span className="size-[18px] shrink-0" />
                    <span className="min-w-0 flex-1 truncate">All repos</span>
                    {repo === "all" && <IconCheck className="shrink-0 text-accent" size={17} />}
                  </Menu.RadioItem>
                  {repoOptions.map((name) => (
                    <Menu.RadioItem key={name} value={name} closeOnClick>
                      <RepoTile name={name} size={18} />
                      <span className="min-w-0 flex-1 truncate">{repoLabel(name)}</span>
                      {repo === name && <IconCheck className="shrink-0 text-accent" size={17} />}
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
              </Menu.Popup>
            </Menu.Root>
          )}

          {/* Archived is a rarely-flipped switch, so it lives behind the
              overflow menu rather than spending a slot in the bar. It keeps
              its own colour when on, so the bar still says it's narrowed. */}
          <Menu.Root>
            <Tooltip label="More filters">
              <Menu.Trigger
                aria-label="More filters"
                className={`flex items-center justify-self-end rounded-md border-0 bg-transparent p-1 hover:text-fg data-[popup-open]:text-fg ${showArchived ? "text-fg" : "text-dim"}`}
              >
                <IconDotsHorizontal size={20} />
              </Menu.Trigger>
            </Tooltip>
            <Menu.Popup align="end">
              <Menu.CheckboxItem
                checked={showArchived}
                onCheckedChange={setShowArchived}
                closeOnClick
              >
                <IconArchive size={18} />
                <span className="min-w-0 flex-1 truncate">Show archived</span>
                {showArchived && <IconCheck className="shrink-0 text-accent" size={17} />}
              </Menu.CheckboxItem>
            </Menu.Popup>
          </Menu.Root>
        </div>

        {sections.length === 0 ? (
          <div className="px-2 py-16 text-center">
			<div className="text-control-label font-medium text-fg">
				{query
					? "No matching worktrees"
					: person === "all"
						? "No pull request worktrees yet"
						: `Nothing open for ${personLabel(person)}`}
            </div>
            <div className="mt-1 text-body text-faint">
              {query
                ? "Try another search or project."
                : person === "all"
                  ? "Workspaces with pull requests will appear here."
                  : "Pick another face, or clear the filter to see everyone."}
            </div>
          </div>
        ) : (
          <div className="pt-7">
            {sections.map((section) => (
              <section key={section.state} className="mb-10">
                <div className="mb-4 flex items-baseline gap-2 px-2 text-item-title font-semibold text-fg">
                  <span>{section.label}</span>
					<span className="text-label font-medium text-faint">{section.rows.length}</span>
				</div>
				{section.groups.map(([label, rows]) => (
					<div key={label} className="mb-5">
						<div className="mb-1.5 flex items-baseline gap-2 px-2 text-label font-medium text-dim">
                      <span>{label}</span>
                      <span className="text-faint">{rows.length}</span>
                    </div>
                    <div>
                      {rows.map((row) => {
                        const status = prStatusMark(row);
                        return (
                        <button
                          key={row.key}
                          className="group grid w-full grid-cols-[22px_24px_minmax(0,1fr)_130px_44px] items-center gap-2 rounded-lg border-0 bg-transparent px-2 py-2.5 text-left text-dim hover:bg-hover hover:text-fg max-[720px]:grid-cols-[22px_24px_minmax(0,1fr)_40px]"
                          onClick={() =>
                            row.session ? onSelect(row.session) : row.url && window.open(row.url, "_blank", "noopener")
                          }
                          title={`${repoLabel(row.repo)} · ${row.branch}`}
                        >
                          <span className={status.className} title={status.label}>
                            <StateIcon state={row.state} />
                          </span>
                          {person === "all" && row.person ? (
                            <UserAvatar name={personLabel(row.person)} size={20} title={personLabel(row.person)} />
                          ) : (
                            <RepoTile name={row.repo} size={20} />
                          )}
                          <span className="min-w-0">
                            <span className="flex min-w-0 items-baseline gap-2">
                              <span className="truncate text-body text-dim group-hover:text-fg">{row.title}</span>
                              {row.number && <span className="shrink-0 text-meta text-faint">#{row.number}</span>}
                            </span>
                            <span className="flex min-w-0 items-center gap-1.5 text-meta text-faint">
                              <span className="truncate">{row.branch}</span>
                            </span>
                          </span>
								<span className="justify-self-end text-label max-[720px]:hidden">
                            {row.additions !== undefined && (
                              <span className="text-green">+{compactDiff(row.additions)}</span>
                            )}
                            {row.deletions !== undefined && (
                              <span className="ml-2 text-red">-{compactDiff(row.deletions)}</span>
                            )}
                          </span>
								<span className="justify-self-end text-label text-faint">{compactAge(row.updatedAt)}</span>
                        </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
