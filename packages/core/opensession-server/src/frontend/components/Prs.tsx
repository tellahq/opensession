import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  UnifiedSession,
  WSClientMessage,
  WSServerMessage,
} from "../lib/types";
import {
  fetchHomeStats,
  fetchRecentPrs,
  type HomeStats,
  type RecentPr,
} from "../lib/api";
import { prStatusMark } from "../lib/pr-status";
import {
  expandPrRenderWindow,
  INITIAL_PR_ROWS,
  PR_ROWS_PAGE,
  visiblePrRowLimit,
} from "../lib/pr-render-window";
import {
  buildWorktreeRows,
  compactAge,
  compactDiff,
  dateGroup,
  personLabel,
  type WorktreeRow,
} from "../lib/pr-rows";
import { Button } from "../ui/button";
import { useIsPhone } from "../hooks/useIsPhone";
import { ResponsiveDialog } from "../ui/sheet";
import { toast } from "../ui/toast";
import { PrQueuePreview } from "./PrQueuePreview";
import { useCurrentUser } from "./UserPicker";
import { UserAvatar } from "./UserAvatar";
import { RepoTile, repoLabel } from "./RepoTile";
import { usePeople } from "../lib/people";
import { Menu } from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
import { Input } from "../ui/input";
import { EmptyState } from "../ui/state";
import { cn } from "../ui/cn";
import {
  PR_GROUP_LABEL,
  PR_LIST,
  PR_PAGE_COLUMN,
  PR_ROW,
  PR_SECTION_LABEL,
} from "../lib/pr-list-classes";
import {
  IconArchive,
  IconDotsHorizontal,
  IconGitMerge,
  IconPeople,
  IconPlus,
  IconPullRequest,
  IconRepo,
  IconSearch,
  IconSidebarLeft,
  IconX,
} from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  minW0: {
    minWidth: "0",
  },
  roundedXl: {
    borderRadius: "calc(18px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgRaised: {
    backgroundColor: "var(--bg-raised)",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  py4: {
    paddingBlock: "calc(4px * 4)",
  },
  flex: {
    display: "flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
  block: {
    display: "block",
  },
  h6: {
    height: "calc(4px * 6)",
  },
  w16: {
    width: "calc(4px * 16)",
  },
  roundedSm: {
    borderRadius: "calc(4px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgLine: {
    backgroundColor: "var(--border)",
  },
  motionSafeAnimatePulse: {
    "@media (prefers-reduced-motion: no-preference)": {
      animation: "var(--animate-pulse)",
    },
  },
  mt1: {
    marginTop: "4px",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  textFg: {
    color: "var(--text)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  grid: {
    display: "grid",
  },
  wFull: {
    width: "100%",
  },
  cursorPointer: {
    cursor: "pointer",
  },
  gridCols2: {
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  },
  itemsStretch: {
    alignItems: "stretch",
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  textLeft: {
    textAlign: "left",
  },
  desktopGridCols4: {
    "@media (min-width: 721px)": {
      gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    },
  },
  mlAuto: {
    marginLeft: "auto",
  },
  maxW150px: {
    maxWidth: "150px",
  },
  minW200px: {
    minWidth: "200px",
  },
  maxW320px: {
    maxWidth: "320px",
  },
  size18px: {
    width: "18px",
    height: "18px",
  },
  shrink0: {
    flexShrink: "0",
  },
  flex1: {
    flex: "1",
  },
  minH0: {
    minHeight: "0",
  },
  overflowYAuto: {
    overflowY: "auto",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },
  mb6: {
    marginBottom: "calc(4px * 6)",
  },
  max560pxMb4: {
    "@media (max-width: 559px)": {
      marginBottom: "calc(4px * 4)",
    },
  },
  mb8: {
    marginBottom: "calc(4px * 8)",
  },
  mb5: {
    marginBottom: "calc(4px * 5)",
  },
  itemsBaseline: {
    alignItems: "baseline",
  },
  leading13: {
    lineHeight: "1.3",
  },
  justifySelfEnd: {
    justifySelf: "flex-end",
  },
  phoneHidden: {
    "@media (max-width: 720px)": {
      display: "none",
    },
  },
  textGreen: {
    color: "var(--green)",
  },
  ml2: {
    marginLeft: "calc(4px * 2)",
  },
  textRed: {
    color: "var(--red)",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  pb4: {
    paddingBottom: "calc(4px * 4)",
  },
  minH13: {
    minHeight: "calc(4px * 13)",
  },
  borderB: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  phoneMinH14: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 14)",
    },
  },
  px1: {
    paddingInline: "4px",
  },
  fontNormal: {
    fontWeight: "var(--font-weight-normal)",
  },
  minH10: {
    minHeight: "calc(4px * 10)",
  },
  phoneMinH11: {
    "@media (max-width: 720px)": {
      minHeight: "calc(4px * 11)",
    },
  },
  size10: {
    width: "calc(4px * 10)",
    height: "calc(4px * 10)",
  },
  phoneSize11: {
    "@media (max-width: 720px)": {
      width: "calc(4px * 11)",
      height: "calc(4px * 11)",
    },
  },
});

interface Props {
  sessions: UnifiedSession[];
  onSelect: (session: UnifiedSession) => void;
  send: (msg: WSClientMessage) => void;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  onNewSession: () => void;
  onShowArchived: () => void;
  onOpenAnalytics?: () => void;
  /** Create or adopt the PR's workspace without leaving the preview. */
  onAddToSidebar: (pr: PrPreviewTarget) => Promise<string>;
  /** Open a PR workspace after it is already represented in the sidebar. */
  onOpenWorkspace: (workspaceId: string, pr: PrPreviewTarget) => void;
  /** The pane's top bar, where this page's controls go. */
  topbarActionsEl?: HTMLElement | null;
}

type PrPreviewTarget = Pick<
  WorktreeRow,
  "repo" | "branch" | "title" | "number" | "workspaceId" | "state"
>;

const compactFmt = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const fmtCompact = (n: number) => compactFmt.format(n);
const HOME_STATS_CACHE_KEY = "opensession.homeStats.v2";

function readCachedHomeStats(): HomeStats | null {
  try {
    const cached = JSON.parse(
      localStorage.getItem(HOME_STATS_CACHE_KEY) || "null",
    ) as Partial<HomeStats> | null;
    return cached?.today &&
      cached.week &&
      cached.completeWeek &&
      cached.priorWeek
      ? (cached as HomeStats)
      : null;
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

function runningLabel(running: number): string {
  if (running === 0) return "No agents running";
  return running === 1 ? "1 agent running" : `${running} agents running`;
}

// Agent time over the last seven whole days against the seven before them. A
// percentage is the only shape a trend takes in one clause, and agent time is
// the field that answers "how much did we get through" without needing a
// second number beside it. Under 5% is noise at this scale, so it says so
// rather than reporting a 2% week as movement.
interface WeekTrend {
  value: string;
  detail: string;
  summary: string;
}

function weekTrend(stats: HomeStats | null): WeekTrend | null {
  const now = stats?.completeWeek?.durationMs ?? 0;
  const before = stats?.priorWeek?.durationMs ?? 0;
  if (!now || !before) return null;
  const pct = Math.round(((now - before) / before) * 100);
  if (Math.abs(pct) < 5) {
    return {
      value: "Level",
      detail: "with last week",
      summary: "level with last week",
    };
  }
  const direction = pct > 0 ? "busier" : "quieter";
  return {
    value: `${Math.abs(pct)}%`,
    detail: `${direction} than last week`,
    summary: `${Math.abs(pct)}% ${direction} than last week`,
  };
}

function OverviewTile({
  label,
  value,
  detail,
  live,
  loading,
}: {
  label: string;
  value?: string;
  detail?: string;
  live?: boolean;
  loading?: boolean;
}) {
  return (
    <span
      {...stylex.props(sx.minW0, sx.roundedXl, sx.bgRaised, sx.px5, sx.py4)}
    >
      <span
        {...stylex.props(
          sx.flex,
          sx.itemsCenter,
          sx.gap2,
          sx.fontMedium,
          sx.textDim,
          typography.label,
        )}
      >
        {live !== undefined ? (
          <span
            aria-hidden="true"
            className={
              live
                ? utilityClassName(
                    "size-1.5 shrink-0 rounded-full bg-green motion-safe:animate-pulse",
                  )
                : utilityClassName("size-1.5 shrink-0 rounded-full bg-line")
            }
          />
        ) : null}
        {label}
      </span>
      {loading ? (
        <span
          {...stylex.props(
            sx.mt2,
            sx.block,
            sx.h6,
            sx.w16,
            sx.roundedSm,
            sx.bgLine,
            sx.motionSafeAnimatePulse,
          )}
        />
      ) : (
        <span
          {...stylex.props(
            sx.mt1,
            sx.block,
            sx.truncate,
            sx.fontSemibold,
            sx.textFg,
            typography.stat,
          )}
        >
          {value}
        </span>
      )}
      {detail ? (
        <span
          {...stylex.props(
            sx.mt1,
            sx.block,
            sx.truncate,
            sx.textFaint,
            typography.meta,
          )}
        >
          {detail}
        </span>
      ) : null}
    </span>
  );
}

// A compact version of Analytics' stat grid. These are the four figures that
// orient the pull-request list: what is live, what happened today, and how the
// last complete week compares. The whole row remains one route to the deeper
// breakdown rather than adding four identical stops to the tab order.
function OverviewStats({
  running,
  stats,
  onOpenAnalytics,
}: {
  running: number;
  stats: HomeStats | null;
  onOpenAnalytics?: () => void;
}) {
  const today = stats?.today;
  const trend = weekTrend(stats);
  return (
    <button
      type="button"
      onClick={onOpenAnalytics}
      title={
        today
          ? `Open Analytics · ${today.turns.toLocaleString()} turns and ${fmtCompact(today.outputTokens)} tokens out today${
              trend
                ? ` · ${fmtAgentTime(stats!.completeWeek.durationMs)} of agent time over the last 7 whole days, ${trend.summary}`
                : ""
            }`
          : "Analytics are loading"
      }
      aria-label="Open Analytics"
      aria-busy={!stats}
      {...mergeStylexProps(
        "focus-ring tabular-nums",
        sx.grid,
        sx.wFull,
        sx.cursorPointer,
        sx.gridCols2,
        sx.itemsStretch,
        sx.gap3,
        sx.roundedXl,
        sx.textLeft,
        sx.desktopGridCols4,
      )}
    >
      <OverviewTile
        label="Agents running"
        value={String(running)}
        detail={runningLabel(running)}
        live={running > 0}
      />
      <OverviewTile
        label="Sessions today"
        value={today ? fmtCompact(today.sessions) : undefined}
        detail={today ? `${today.turns.toLocaleString()} turns` : undefined}
        loading={!today}
      />
      <OverviewTile
        label="Agent time today"
        value={today ? fmtAgentTime(today.durationMs) : undefined}
        loading={!today}
      />
      <OverviewTile
        label="Weekly activity"
        value={trend?.value}
        detail={trend?.detail}
        loading={!stats}
      />
    </button>
  );
}

function StateIcon({ state }: { state: WorktreeRow["state"] }) {
  if (state === "MERGED") return <IconGitMerge size={20} />;
  if (state === "CLOSED") return <IconArchive size={20} />;
  return <IconPullRequest size={20} />;
}

export function Prs({
  sessions,
  onSelect,
  send,
  addHandler,
  onNewSession,
  onShowArchived,
  onOpenAnalytics,
  onAddToSidebar,
  onOpenWorkspace,
  topbarActionsEl,
}: Props) {
  const currentUser = useCurrentUser();
  const isPhone = useIsPhone();
  const [query, setQuery] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchExpanded = searchActive || query.length > 0;
  const [repo, setRepo] = useState("all");
  // Whose pull requests to show, and nothing more. This used to be the app's
  // person lens, so narrowing the list here also swapped the sidebar out from
  // under you. It is an ordinary filter now, alongside repo: switching whose
  // work the app is showing is the People page's job.
  const [person, setPerson] = useState("all");
  // Everyone, not only whoever the default request happened to return, because
  // picking someone fetches their pull requests below.
  const roster = usePeople();
  const people = [...roster].sort(
    (a, b) =>
      Number(b.name.toLowerCase() === currentUser.toLowerCase()) -
      Number(a.name.toLowerCase() === currentUser.toLowerCase()),
  );
  const [showArchived, setShowArchived] = useState(false);
  const [recentPrs, setRecentPrs] = useState<RecentPr[]>([]);
  const [personPrs, setPersonPrs] = useState<RecentPr[]>([]);
  const [stats, setStats] = useState<HomeStats | null>(readCachedHomeStats);
  const [preview, setPreview] = useState<PrPreviewTarget | null>(null);
  const renderScope = [query, repo, person, String(showArchived)].join("\0");
  const [renderWindow, setRenderWindow] = useState(() => ({
    scope: renderScope,
    limit: INITIAL_PR_ROWS,
  }));
  const rowLimit = visiblePrRowLimit(renderWindow, renderScope);
  const [addingToSidebar, setAddingToSidebar] = useState(false);

  useEffect(() => {
    if (searchActive) searchInputRef.current?.focus();
  }, [searchActive]);

  function openPreviewTarget(repo: string, branch: string) {
    setPreview({ repo, branch, title: repo, state: "OPEN", workspaceId: null });
  }

  async function addPreviewToSidebar() {
    if (!preview || addingToSidebar) return;
    const target = preview;
    setAddingToSidebar(true);
    await (async () => {
      const workspaceId = await onAddToSidebar(target);
      setPreview((current) =>
        current?.repo === target.repo && current.branch === target.branch
          ? { ...current, workspaceId }
          : current,
      );
      toast("Added to sidebar");
    })()
      .catch(async () => {
        toast("Couldn't add to sidebar");
      })
      .finally(async () => {
        setAddingToSidebar(false);
      });
  }

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

  const running = sessions.filter((s) => s.isRunning && !s.archived).length;

  useEffect(() => {
    let active = true;
    fetchRecentPrs(undefined, showArchived ? {} : { limit: 500 })
      .then((prs) => active && setRecentPrs(prs))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [showArchived]);

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

  const allWorktrees = (() => {
    const prs = new Map(recentPrs.map((pr) => [pr.url, pr]));
    for (const pr of personPrs) prs.set(pr.url, pr);
    return buildWorktreeRows([...prs.values()], sessions);
  })();

  const worktrees = (() => {
    const needle = query.trim().toLowerCase();
    return allWorktrees.filter((row) => {
      if (!showArchived && row.archived) return false;
      if (repo !== "all" && row.repo !== repo) return false;
      if (person !== "all" && row.person !== person) return false;
      if (!needle) return true;
      return [
        row.title,
        row.repo,
        row.branch,
        row.author,
        row.number ? `#${row.number}` : "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  })();

  const visibleWorktrees = worktrees.slice(0, rowLimit);
  const remainingRows = Math.max(0, worktrees.length - visibleWorktrees.length);

  const sections = (() => {
    const definitions: Array<{ state: WorktreeRow["state"]; label: string }> = [
      { state: "OPEN", label: "Open" },
      { state: "MERGED", label: "Merged" },
      { state: "CLOSED", label: "Closed" },
    ];
    return definitions.flatMap((definition) => {
      const total = worktrees.filter(
        (row) => row.state === definition.state,
      ).length;
      const rows = visibleWorktrees.filter(
        (row) => row.state === definition.state,
      );
      if (!rows.length) return [];
      const groups = new Map<string, WorktreeRow[]>();
      for (const row of rows) {
        const label = dateGroup(row.updatedAt);
        groups.set(label, [...(groups.get(label) || []), row]);
      }
      return [{ ...definition, rows, total, groups: [...groups.entries()] }];
    });
  })();

  const repoOptions = [
    ...new Set(allWorktrees.map((row) => row.repo).filter(Boolean)),
  ].sort();

  // The page's controls, in the window's top bar rather than in a strip of
  // their own. That bar spans the pane and was empty until the heading below
  // scrolled under it, while this page spent three rows on chrome before its
  // first pull request. Search, the scopes and the one CTA go up there, and the
  // body keeps the title and the day's numbers.
  //
  // The two scopes stay two controls, side by side, rather than folding into
  // one Filters button: each says what it is set to without being opened, which
  // is the whole of what this row has to tell you at rest. They are ghost
  // buttons so the run of them reads as one group of words between the field
  // and the CTA, rather than as two more plates.
  //
  // Each names its value rather than a phrase about it ("All repos", not "In
  // all repos"): two of them and a field and a button share this row, and the
  // preposition is the first thing that does not fit. The glyph already says
  // which scope it is, and the label now matches the row it is set to in the
  // menu below.
  const actions = (
    <>
      {/* Search rests as one quiet glyph beside the page name. Activating it
          grows the field to the right, into the flexible space before the
          trailing filters. A non-empty search stays open when focus moves on,
          so the active filter remains visible. */}
      <div
        className={cn(
          utilityClassName(
            "relative h-8 shrink-0 transition-[width] duration-[var(--dur)] ease-[var(--ease)] motion-reduce:transition-none",
          ),
          searchExpanded
            ? utilityClassName("w-[200px] min-w-[90px] shrink-[100]")
            : utilityClassName("w-8"),
        )}
      >
        <Input
          ref={searchInputRef}
          className={cn(
            utilityClassName(
              "absolute inset-0 h-8 pl-8 [&::-webkit-search-cancel-button]:hidden",
            ),
            utilityClassName(
              "transition-opacity duration-[var(--dur-micro)] ease-[var(--ease)] motion-reduce:transition-none",
            ),
            searchExpanded
              ? utilityClassName("opacity-100")
              : utilityClassName("pointer-events-none opacity-0"),
          )}
          type="search"
          aria-label="Search pull requests"
          placeholder="Search pull requests…"
          value={query}
          tabIndex={searchExpanded ? 0 : -1}
          onFocus={() => setSearchActive(true)}
          onBlur={() => setSearchActive(false)}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setQuery("");
            setSearchActive(false);
            event.currentTarget.blur();
          }}
          spellCheck={false}
        />
        <Tooltip label="Search" side="bottom">
          <Button
            variant="ghost"
            icon={<IconSearch size={18} />}
            className={cn(
              utilityClassName("absolute inset-y-0 left-0 z-10"),
              searchExpanded &&
                utilityClassName("pointer-events-none text-faint"),
            )}
            aria-label="Search pull requests"
            aria-expanded={searchExpanded}
            aria-hidden={searchExpanded || undefined}
            tabIndex={searchExpanded ? -1 : 0}
            onClick={() => setSearchActive(true)}
          />
        </Tooltip>
      </div>

      {/* Search sits with the page name. The scopes and CTA remain a trailing
          group, so widening the pane grows the quiet space between the two
          jobs instead of separating the field from its heading. */}
      <div
        {...stylex.props(sx.mlAuto, sx.flex, sx.minW0, sx.itemsCenter, sx.gap2)}
      >
        {people.length > 0 && (
          <Menu.Root>
            <Menu.Trigger
              render={
                <Button
                  variant="ghost"
                  className={mergeStylexOverrideClassName("", sx.minW0)}
                  icon={<IconPeople size={18} />}
                  caret
                >
                  <span {...stylex.props(sx.maxW150px, sx.truncate)}>
                    {person === "all" ? "Anyone" : personLabel(person)}
                  </span>
                </Button>
              }
            />
            <Menu.Popup
              align="end"
              className={mergeStylexOverrideClassName(
                "",
                sx.minW200px,
                sx.maxW320px,
              )}
            >
              <Menu.RadioGroup
                value={person}
                onValueChange={(value) => setPerson(String(value))}
              >
                <Menu.RadioItem value="all" closeOnClick>
                  {/* Sized to the faces below so every label shares one edge. */}
                  <span {...stylex.props(sx.size18px, sx.shrink0)} />
                  <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                    Anyone
                  </span>
                  <Menu.Check on={person === "all"} />
                </Menu.RadioItem>
                {people.map((who) => {
                  const key = who.name.toLowerCase();
                  return (
                    <Menu.RadioItem key={key} value={key} closeOnClick>
                      <UserAvatar name={who.name} size={18} />
                      <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                        {key === currentUser.toLowerCase()
                          ? `${who.fullName} (you)`
                          : who.fullName}
                      </span>
                      <Menu.Check on={person === key} />
                    </Menu.RadioItem>
                  );
                })}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Root>
        )}

        {repoOptions.length > 1 && (
          <Menu.Root>
            <Menu.Trigger
              render={
                <Button
                  variant="ghost"
                  className={mergeStylexOverrideClassName("", sx.minW0)}
                  icon={<IconRepo size={18} />}
                  caret
                >
                  <span {...stylex.props(sx.maxW150px, sx.truncate)}>
                    {repo === "all" ? "All repos" : repoLabel(repo)}
                  </span>
                </Button>
              }
            />
            <Menu.Popup
              align="end"
              className={mergeStylexOverrideClassName(
                "",
                sx.minW200px,
                sx.maxW320px,
              )}
            >
              <Menu.RadioGroup
                value={repo}
                onValueChange={(value) => setRepo(String(value))}
              >
                <Menu.RadioItem value="all" closeOnClick>
                  {/* Sized to the tiles below so every label shares one edge. */}
                  <span {...stylex.props(sx.size18px, sx.shrink0)} />
                  <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                    All repos
                  </span>
                  <Menu.Check on={repo === "all"} />
                </Menu.RadioItem>
                {repoOptions.map((name) => (
                  <Menu.RadioItem key={name} value={name} closeOnClick>
                    <RepoTile name={name} size={18} />
                    <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                      {repoLabel(name)}
                    </span>
                    <Menu.Check on={repo === name} />
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Root>
        )}

        {/* Archived is a rarely-flipped switch, so it lives behind the overflow
          menu rather than spending a slot of its own. It keeps its own colour
          when on, so the row still says the list is narrowed. */}
        <Menu.Root>
          <Tooltip label="More filters">
            <Menu.Trigger
              render={
                <Button
                  variant="ghost"
                  className={
                    showArchived
                      ? utilityClassName("shrink-0 text-fg")
                      : utilityClassName("shrink-0")
                  }
                  aria-label="More filters"
                  icon={<IconDotsHorizontal size={18} />}
                />
              }
            />
          </Tooltip>
          <Menu.Popup align="end">
            <Menu.CheckboxItem
              checked={showArchived}
              onCheckedChange={(next) => {
                setShowArchived(next);
                if (next) onShowArchived();
              }}
              closeOnClick
            >
              <IconArchive size={18} />
              <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                Show archived
              </span>
              <Menu.Check on={showArchived} />
            </Menu.CheckboxItem>
          </Menu.Popup>
        </Menu.Root>

        {/* The page's one CTA carries its verb as a glyph as well as a word: at
          this size a label alone is a coloured rectangle you read, and the plus
          is what makes it scan as the button that makes something. */}
        <Button
          variant="primary"
          className={mergeStylexOverrideClassName("", sx.shrink0)}
          icon={<IconPlus size={18} />}
          onClick={onNewSession}
        >
          New session
        </Button>
      </div>
    </>
  );

  return (
    // The page frame every other list page in the app uses: one centred
    // column at the shared width and padding, a PageHeader on top.
    <div
      data-page-scroll
      {...stylex.props(
        sx.minH0,
        sx.wFull,
        sx.flex1,
        sx.overflowYAuto,
        sx.bgSurface,
      )}
    >
      {topbarActionsEl ? createPortal(actions, topbarActionsEl) : null}
      <div
        className={cn(
          PR_PAGE_COLUMN,
          utilityClassName(
            "pb-15 pt-7 max-[560px]:px-4 max-[560px]:pb-12 max-[560px]:pt-[18px]",
          ),
        )}
      >
        {/* The page name and search live together in the top bar. The day's
            orientation figures take the same card row Analytics uses, while
            the pull-request sections remain the page's primary content. */}
        <div {...stylex.props(sx.mb6, sx.max560pxMb4)}>
          <OverviewStats
            running={running}
            stats={stats}
            onOpenAnalytics={onOpenAnalytics}
          />
        </div>
        {sections.length === 0 ? (
          <EmptyState
            title={
              query
                ? "No matching pull requests"
                : person === "all"
                  ? "No pull requests yet"
                  : `Nothing open for ${personLabel(person)}`
            }
          >
            {query
              ? "Try another search or filter."
              : person === "all"
                ? "Pull requests appear here."
                : "Pick someone else, or set the filter back to anyone."}
          </EmptyState>
        ) : (
          <div className={PR_LIST}>
            {sections.map((section) => (
              <section key={section.state} {...stylex.props(sx.mb8)}>
                <h2 className={PR_SECTION_LABEL}>
                  {section.label}
                  <span
                    {...stylex.props(
                      sx.fontMedium,
                      sx.textFaint,
                      typography.label,
                    )}
                  >
                    {section.total}
                  </span>
                </h2>
                {section.groups.map(([label, rows]) => (
                  <div key={label} {...stylex.props(sx.mb5)}>
                    <h3 className={PR_GROUP_LABEL}>
                      {label}
                      <span {...stylex.props(sx.fontMedium)}>
                        {rows.length}
                      </span>
                    </h3>
                    <div>
                      {rows.map((row) => {
                        const status = prStatusMark(row);
                        return (
                          <button
                            key={row.key}
                            className={PR_ROW}
                            onClick={() => setPreview(row)}
                            title={`${repoLabel(row.repo)} · ${row.branch}`}
                          >
                            {/* Hue is for the rows with something to say. A
                                section of open pull requests is almost all
                                healthy, so the resting mark is drawn as
                                structure and green now means approved. */}
                            <span
                              className={utilityClassName(
                                `${status.quiet ? "text-dim" : status.className} flex items-center`,
                              )}
                              title={status.label}
                            >
                              <StateIcon state={row.state} />
                            </span>
                            {person === "all" && row.person ? (
                              <UserAvatar
                                name={personLabel(row.person)}
                                size={20}
                                title={personLabel(row.person)}
                              />
                            ) : (
                              <RepoTile name={row.repo} size={20} />
                            )}
                            {/* One line. The branch under the title restated it
                                in kebab case on most rows and cost the list
                                half its height; it stays in the row's tooltip,
                                in search, and in the panel the row opens. */}
                            <span
                              {...stylex.props(
                                sx.flex,
                                sx.minW0,
                                sx.itemsBaseline,
                                sx.gap2,
                              )}
                            >
                              <span
                                {...stylex.props(
                                  sx.truncate,
                                  sx.fontMedium,
                                  sx.leading13,
                                  sx.textFg,
                                  typography.itemTitle,
                                )}
                              >
                                {row.title}
                              </span>
                              {row.number && (
                                <span
                                  {...mergeStylexProps(
                                    "tabular-nums",
                                    sx.shrink0,
                                    sx.textFaint,
                                    typography.meta,
                                  )}
                                >
                                  #{row.number}
                                </span>
                              )}
                            </span>
                            {/* Added and removed keep diff's own green and red.
                                It is the one place on the row where the colour
                                is the convention rather than a status, and it
                                reads at a glance in a way a neutral pair of
                                numbers does not. */}
                            <span
                              {...mergeStylexProps(
                                "tabular-nums",
                                sx.justifySelfEnd,
                                sx.phoneHidden,
                                typography.meta,
                              )}
                            >
                              {row.additions !== undefined && (
                                <span {...stylex.props(sx.textGreen)}>
                                  +{compactDiff(row.additions)}
                                </span>
                              )}
                              {row.deletions !== undefined && (
                                <span {...stylex.props(sx.ml2, sx.textRed)}>
                                  −{compactDiff(row.deletions)}
                                </span>
                              )}
                            </span>
                            <span
                              {...mergeStylexProps(
                                "tabular-nums",
                                sx.justifySelfEnd,
                                sx.textFaint,
                                typography.meta,
                              )}
                            >
                              {compactAge(row.updatedAt)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </section>
            ))}
            {remainingRows > 0 && (
              <div {...stylex.props(sx.flex, sx.justifyCenter, sx.pb4)}>
                <Button
                  variant="ghost"
                  onClick={() =>
                    setRenderWindow(expandPrRenderWindow(renderScope, rowLimit))
                  }
                >
                  Show {Math.min(remainingRows, PR_ROWS_PAGE)} more
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <ResponsiveDialog
        open={Boolean(preview)}
        onClose={() => setPreview(null)}
        phone={isPhone}
        label={preview ? `Pull request: ${preview.title}` : "Pull request"}
        showPhoneGrabber={false}
        modalClassName={utilityClassName(
          "h-[min(820px,85vh)] w-[min(1280px,92vw)] max-w-none bg-surface",
        )}
        sheetClassName={utilityClassName(
          "top-0 h-[100dvh] max-h-none bg-surface [border-radius:0]! [box-shadow:none]!",
        )}
      >
        {preview && (
          <>
            <div
              {...stylex.props(
                sx.flex,
                sx.minH13,
                sx.shrink0,
                sx.itemsCenter,
                sx.gap2,
                sx.borderB,
                sx.borderLine,
                sx.bgPanel,
                sx.px3,
                sx.phoneMinH14,
              )}
            >
              <div
                {...stylex.props(
                  sx.flex,
                  sx.minW0,
                  sx.flex1,
                  sx.itemsCenter,
                  sx.gap2,
                  sx.px1,
                  sx.fontMedium,
                  sx.textFg,
                  typography.itemTitle,
                )}
              >
                <IconPullRequest
                  size={19}
                  className={mergeStylexOverrideClassName(
                    "",
                    sx.shrink0,
                    sx.textDim,
                  )}
                />
                <span {...stylex.props(sx.truncate)}>
                  {repoLabel(preview.repo)}
                </span>
                {preview.number && (
                  <span
                    {...mergeStylexProps(
                      "tabular-nums",
                      sx.shrink0,
                      sx.fontNormal,
                      sx.textFaint,
                    )}
                  >
                    #{preview.number}
                  </span>
                )}
              </div>
              {preview.workspaceId ? (
                <Button
                  variant="default"
                  className={mergeStylexOverrideClassName(
                    "",
                    sx.minH10,
                    sx.shrink0,
                    sx.phoneMinH11,
                  )}
                  icon={<IconSidebarLeft size={18} />}
                  onClick={() => {
                    onOpenWorkspace(preview.workspaceId!, preview);
                    setPreview(null);
                  }}
                >
                  Open workspace
                </Button>
              ) : preview.state === "OPEN" ? (
                <Button
                  variant="default"
                  className={mergeStylexOverrideClassName(
                    "",
                    sx.minH10,
                    sx.shrink0,
                    sx.phoneMinH11,
                  )}
                  icon={<IconSidebarLeft size={18} />}
                  disabled={addingToSidebar}
                  onClick={() => void addPreviewToSidebar()}
                >
                  {addingToSidebar ? "Adding…" : "Add to sidebar"}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                className={mergeStylexOverrideClassName(
                  "",
                  sx.size10,
                  sx.shrink0,
                  sx.phoneSize11,
                )}
                icon={<IconX size={20} />}
                aria-label="Close pull request"
                onClick={() => setPreview(null)}
              />
            </div>
            <div {...stylex.props(sx.minH0, sx.flex1)}>
              <PrQueuePreview
                key={`${preview.repo}:${preview.branch}`}
                repo={preview.repo}
                branch={preview.branch}
                sessions={sessions}
                send={send}
                addHandler={addHandler}
                onOpenSession={(id) => {
                  const session = sessions.find((item) => item.id === id);
                  if (session) onSelect(session);
                  setPreview(null);
                }}
                onOpenPr={openPreviewTarget}
              />
            </div>
          </>
        )}
      </ResponsiveDialog>
    </div>
  );
}
