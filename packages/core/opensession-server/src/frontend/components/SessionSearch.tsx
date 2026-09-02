import { repoLabel } from "../lib/repo-label";
import { FALLBACK_REPO, sessionRepoOr } from "../lib/session-repo";
import React, { useEffect, useRef, useState } from "react";
import type { UnifiedSession } from "../lib/types";
import {
  fetchOpenPrs,
  relativeTime,
  searchTranscripts,
  type OpenPr,
} from "../lib/api";
import {
  IconPeople,
  IconPullRequest,
  IconRepo,
  IconSearch,
  IconStatusRing,
} from "./icons";
import { Modal, useEnterOnMount } from "../ui/modal";
import { Button } from "../ui/button";
import { Menu } from "../ui/menu";
import { RepoTile } from "./RepoTile";
import { UserAvatar } from "./UserAvatar";
import {
  collapsePrLinkSessions,
  prLinksMatch,
  sessionUsesPrLink,
} from "../lib/session-prs";
import { usePeople } from "../lib/people";
import {
  canonicalNames,
  sessionHasOwner,
  sessionOwners,
} from "../lib/session-owner";

export interface CommandPaletteAction {
  id: string;
  label: string;
  description?: string;
  category: "Actions" | "Navigate" | "Tools";
  keywords?: string[];
  shortcut?: string[];
  icon?: React.ReactNode;
  run: () => void;
}

interface Props {
  sessions: UnifiedSession[];
  actions: CommandPaletteAction[];
  /** Open a session or PR (also closes the palette). */
  onSelectSession: (id: string) => void;
  onSelectPr: (pr: OpenPr) => void;
  onClose: () => void;
}

// Repo-less sessions group under the literal FALLBACK_REPO bucket, not the
// sidebar's default-repo lane (see lib/session-repo for the fork rationale).
function sessionRepo(s: UnifiedSession): string {
  return sessionRepoOr(s, FALLBACK_REPO);
}

// The status buckets a session can fall into, mirroring the sidebar's triage
// order: a blocked question first, then live activity, then PR lifecycle.
type Status =
  | "paused"
  | "needsinput"
  | "failed"
  | "running"
  | "review"
  | "merged"
  | "pending";

/** A keycap. Hidden below 720px, where the palette is driven by touch and the
 *  keyboard hints are noise. Filled with the translucent `--hover` ink rather
 *  than the `--bg-raised` surface: the palette shell is glass, and an absolute
 *  surface reads as an opaque chip cut out of it (and in dark it sat *below*
 *  the popup fill, so a "keycap" rendered sunken). */
const KBD =
  "mx-px inline-flex min-w-4 items-center justify-center rounded-md bg-hover px-1.5 py-px font-sans text-meta text-dim phone:hidden";

/** A result row. The selected wash rides on `aria-selected`, which the button
 *  already carries for the listbox — so the icon and keycap tones that used to
 *  need `.ss-item-active` descendant rules are `group-aria-selected:` here.
 *  `bg-pressed` rather than the `--bg-active` surface: the palette shell is
 *  glass, and an absolute surface would land on it as an opaque patch. */
const ITEM =
  "group flex w-full cursor-pointer items-center gap-3 rounded-lg border-none bg-transparent px-3 py-2.5 text-left text-fg aria-selected:bg-pressed";

const STATUS_META: Record<Status, { label: string; dotClass: string }> = {
  paused: { label: "Paused for safety", dotClass: "bg-yellow" },
  needsinput: { label: "Needs input", dotClass: "bg-accent" },
  failed: { label: "Run failed", dotClass: "bg-red" },
  running: { label: "Running", dotClass: "bg-yellow" },
  review: { label: "In review", dotClass: "bg-yellow" },
  merged: { label: "Merged", dotClass: "bg-purple" },
  pending: { label: "Pending", dotClass: "bg-faint" },
};

const STATUS_ORDER: Status[] = [
  "paused",
  "needsinput",
  "failed",
  "running",
  "review",
  "merged",
  "pending",
];

function sessionStatus(s: UnifiedSession): Status {
  if (s.safety) return "paused";
  if (s.waitingForInput) return "needsinput";
  if (s.lastRunError && !s.isRunning) return "failed";
  if (s.isRunning) return "running";
  if (s.prState === "OPEN") return "review";
  if (s.prState === "MERGED") return "merged";
  // Idle-but-unfinished — not "Done"; finishing is explicit (Archive).
  return "pending";
}

// The searchable haystack for a session — title plus every field a person might
// recall it by (branch, owner, automation, repo, Linear id).
function haystack(s: UnifiedSession): string {
  return [
    s.title,
    s.branch,
    s.startedBy,
    s.automation,
    sessionRepo(s),
    s.linearIssue?.identifier,
    s.linearIssue?.title,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** The two per-session values the result list reads, derived once per pool. */
export interface SessionSearchIndex {
  hay: Map<UnifiedSession, string>;
  activityAt: Map<UnifiedSession, number>;
}

/**
 * Both of these used to be derived inside the results memo, so every keystroke
 * walked the whole live pool re-joining and re-lowercasing each session's
 * metadata (twice, since the snippet check called haystack again), and the
 * sort allocated two Date objects per comparison on top.
 *
 * Keyed on the session objects, which the sessions poll replaces rather than
 * mutates, and rebuilt only when the pool array itself changes.
 */
export function sessionSearchIndex(pool: UnifiedSession[]): SessionSearchIndex {
  const hay = new Map<UnifiedSession, string>();
  const activityAt = new Map<UnifiedSession, number>();
  for (const session of pool) {
    hay.set(session, haystack(session));
    activityAt.set(session, new Date(session.lastActivity).getTime());
  }
  return { hay, activityAt };
}

/**
 * Most-recently-active first: the same order the sidebar defaults to.
 *
 * Reads the precomputed key instead of allocating two Dates per comparison.
 * The numbers are identical, so the order is too, ties included: sort is
 * stable, so equal timestamps keep pool order. A session the index has never
 * seen falls back to deriving its key, which keeps this correct for any input
 * rather than ordering it as if it were epoch.
 */
export function sortByRecentActivity(
  rows: UnifiedSession[],
  index: SessionSearchIndex,
): UnifiedSession[] {
  const at = (s: UnifiedSession) =>
    index.activityAt.get(s) ?? new Date(s.lastActivity).getTime();
  return rows.sort((a, b) => at(b) - at(a));
}

function prStatus(pr: OpenPr): string {
  if (pr.isDraft) return "Draft";
  if (pr.checks.failed > 0)
    return `${pr.checks.failed} failing check${pr.checks.failed === 1 ? "" : "s"}`;
  if (pr.checks.pending > 0)
    return `${pr.checks.pending} check${pr.checks.pending === 1 ? "" : "s"} running`;
  if (pr.reviewDecision === "APPROVED") return "Approved";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "Changes requested";
  if (pr.reviewRequested?.length) return "Review requested";
  return "Open";
}

type PaletteResult =
  | { type: "action"; category: string; action: CommandPaletteAction }
  | { type: "pr"; category: string; pr: OpenPr }
  | {
      type: "session";
      category: string;
      session: UnifiedSession;
      snippet?: string;
    };

function resultKey(result: PaletteResult): string {
  if (result.type === "action") return `action:${result.action.id}`;
  if (result.type === "pr") return `pr:${result.pr.url}`;
  return `session:${result.session.id}`;
}

interface FilterOption<Value extends string> {
  value: Value;
  label: string;
  icon?: React.ReactNode;
}

function FilterMenu<Value extends string>({
  label,
  value,
  options,
  onChange,
  icon,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<FilterOption<Value>>;
  onChange: (value: Value) => void;
  icon: React.ReactNode;
}) {
  const current = options.find((option) => option.value === value);
  const hasIcons = options.some((option) => option.icon != null);
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="phone:min-h-11"
            icon={icon}
            caret
            data-session-filter
            aria-label={`${label}: ${current?.label ?? value}`}
          >
            {current?.label ?? value}
          </Button>
        }
      />
      <Menu.Popup
        align="start"
        sideOffset={6}
        className="max-w-[min(320px,calc(100vw-1rem))]"
      >
        <Menu.RadioGroup
          value={value}
          onValueChange={(next) => {
            const selected = options.find(
              (option) => option.value === String(next),
            );
            if (selected) onChange(selected.value);
          }}
        >
          {options.map((option) => (
            <Menu.RadioItem
              key={option.value}
              value={option.value}
              closeOnClick
              className="justify-between gap-3"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2.5">
                {hasIcons && (
                  <span className="flex size-[18px] shrink-0 items-center justify-center text-dim">
                    {option.icon}
                  </span>
                )}
                <span className="min-w-0 truncate">{option.label}</span>
              </span>
              <Menu.Check on={option.value === value} />
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      </Menu.Popup>
    </Menu.Root>
  );
}

export function SessionSearch({
  sessions,
  actions,
  onSelectSession,
  onSelectPr,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [person, setPerson] = useState("all");
  const [repo, setRepo] = useState("all");
  const [status, setStatus] = useState<Status | "all">("all");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [openPrs, setOpenPrs] = useState<OpenPr[]>([]);
  const [loadingPrs, setLoadingPrs] = useState(true);
  // Content matches from the backend transcript search, keyed by session id →
  // snippet. Populated (debounced) as the query changes; empty when the query
  // is too short or nothing matched inside any conversation.
  const [snippets, setSnippets] = useState<Map<string, string>>(new Map());
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // One frame closed so the palette animates in; App mounts us already-open.
  const open = useEnterOnMount();

  useEffect(() => {
    let alive = true;
    fetchOpenPrs()
      .then((prs) => {
        if (alive) setOpenPrs(prs);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoadingPrs(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Search inside conversations too — the metadata filter is instant/local, but
  // transcript text lives on disk, so we debounce a backend call and fold its
  // hits into the result set. A stale/aborted request never clobbers newer
  // state (AbortController + the trailing-edge guard).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setSnippets(new Map());
      setSearching(false);
      return;
    }
    setSearching(true);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      await (async () => {
        const matches = await searchTranscripts(q, ctrl.signal);
        setSnippets(new Map(matches.map((m) => [m.id, m.snippet])));
      })()
        .catch(async (e) => {
          if (!ctrl.signal.aborted) setSnippets(new Map());
        })
        .finally(async () => {
          if (!ctrl.signal.aborted) setSearching(false);
        });
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  // Only live sessions are searchable.
  const pool = sessions.filter((s) => !s.archived);

  const searchIndex = sessionSearchIndex(pool);

  // Workspace members only. `startedBy` is a free-text name that also carries
  // workers, goals, integration senders and unmapped Slack ids, so the team
  // directory decides who is a person here, and merges the spellings one
  // person has: "Michiel Westerbeek", "Michiel" and "Kent (loop)" are not
  // three more teammates (lib/session-owner).
  const roster = usePeople();
  const canonical = canonicalNames(roster);
  const personOptions = [
    { value: "all", label: "Anyone", icon: <IconPeople size={18} /> },
    ...sessionOwners(pool, canonical).map(({ key, label }) => ({
      value: key,
      label,
      icon: <UserAvatar name={label} size={18} edge={false} />,
    })),
  ];

  const repoOptions = (() => {
    const counts = new Map<string, number>();
    for (const session of pool) {
      const project = sessionRepo(session);
      counts.set(project, (counts.get(project) || 0) + 1);
    }
    return [
      { value: "all", label: "Any repo", icon: <IconRepo size={18} /> },
      ...Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([value]) => ({
          value,
          label: repoLabel(value),
          icon: <RepoTile name={value} size={18} />,
        })),
    ];
  })();

  const statusOptions = [
    { value: "all", label: "Any status", icon: <IconStatusRing size={18} /> },
    ...STATUS_ORDER.map((value) => ({
      value,
      label: STATUS_META[value].label,
      icon: (
        <span
          className={`size-2 rounded-full ${STATUS_META[value].dotClass}`}
        />
      ),
    })),
  ] satisfies ReadonlyArray<FilterOption<Status | "all">>;
  const hasSessionFilter =
    person !== "all" || repo !== "all" || status !== "all";

  // Commands, PRs, and sessions share one flat result list so arrow-key navigation
  // crosses group boundaries the way a command menu should.
  const results = (() => {
    const q = query.trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const hasQuery = terms.length > 0;
    // The command menu is a search surface, not a second full list page. Keep
    // its resting suggestions and each searched category bounded so opening or
    // typing never mounts hundreds of rows before the person can read them.
    const prLimit = hasQuery ? 20 : 8;
    const sessionLimit = hasQuery || hasSessionFilter ? 40 : 12;
    const matches = (values: Array<string | undefined>) => {
      if (terms.length === 0) return true;
      const text = values.filter(Boolean).join(" ").toLowerCase();
      return terms.every((term) => text.includes(term));
    };
    const actionResults: PaletteResult[] = (hasSessionFilter ? [] : actions)
      .filter((action) =>
        matches([
          action.label,
          action.description,
          ...(action.keywords || []),
          ...(action.shortcut || []),
        ]),
      )
      .slice(0, hasQuery ? 24 : 16)
      .map((action) => ({ type: "action", category: action.category, action }));
    const prResults: PaletteResult[] = (hasSessionFilter ? [] : openPrs)
      .filter(
        (pr) =>
          prLinksMatch(q, pr.url) ||
          matches([
            pr.title,
            pr.repo,
            pr.branch,
            pr.author,
            `#${pr.number}`,
            prStatus(pr),
            pr.url,
          ]),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, prLimit)
      .map((pr) => ({ type: "pr", category: "Pull requests", pr }));
    // Falls back to deriving the text for a session the index hasn't seen, so
    // a pool and an index that are momentarily out of step still search.
    const hayOf = (s: UnifiedSession) => searchIndex.hay.get(s) ?? haystack(s);
    let sessionResults = pool.filter((s) => {
      if (person !== "all" && !sessionHasOwner(s, person, canonical))
        return false;
      if (repo !== "all" && sessionRepo(s) !== repo) return false;
      if (status !== "all" && sessionStatus(s) !== status) return false;
      if (terms.length === 0) return true;
      // A session shows if its metadata matches every term OR the query turned
      // up inside its conversation, or the pasted PR link belongs to it.
      const hay = hayOf(s);
      return (
        terms.every((t) => hay.includes(t)) ||
        sessionUsesPrLink(s, q) ||
        snippets.has(s.id)
      );
    });
    sessionResults = sortByRecentActivity(sessionResults, searchIndex);
    if (sessionResults.some((session) => sessionUsesPrLink(session, q))) {
      sessionResults = collapsePrLinkSessions(sessionResults);
    }
    const sessionRows: PaletteResult[] = sessionResults
      .slice(0, sessionLimit)
      .map((s) => {
        // Show the snippet only when the title/metadata didn't already match —
        // otherwise the row explains itself.
        const metaMatch =
          terms.length > 0 &&
          (terms.every((t) => hayOf(s).includes(t)) || sessionUsesPrLink(s, q));
        return {
          type: "session",
          category: "Sessions",
          session: s,
          snippet: metaMatch ? undefined : snippets.get(s.id),
        };
      });
    return [...actionResults, ...prResults, ...sessionRows];
  })();
  const keyedActive = results.findIndex(
    (result) => resultKey(result) === activeKey,
  );
  const active = keyedActive >= 0 ? keyedActive : 0;

  // Keep the highlighted row scrolled into view during keyboard nav.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${active}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [active, activeKey, results.length]);

  // Result navigation only. Tab cycling, Escape and backdrop dismissal are the
  // dialog's job now (Modal → Base UI), so this handler no longer duplicates
  // them. Filter and clear buttons keep their own arrow/Enter behavior.
  function onKeyDown(e: React.KeyboardEvent) {
    if (
      e.target instanceof HTMLElement &&
      e.target.closest("[data-session-filter], [data-session-filter-clear]")
    )
      return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.min(active + 1, results.length - 1);
      if (results[next]) setActiveKey(resultKey(results[next]));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(active - 1, 0);
      if (results[next]) setActiveKey(resultKey(results[next]));
    } else if (e.key === "Enter") {
      e.preventDefault();
      selectResult(results[active]);
    }
  }

  function selectResult(result?: PaletteResult) {
    if (!result) return;
    onClose();
    if (result.type === "action") result.action.run();
    else if (result.type === "pr") onSelectPr(result.pr);
    else onSelectSession(result.session.id);
  }

  return (
    <Modal.Root
      open={open}
      // Escape and outside presses both land here; App unmounts us in turn.
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      // Focus is trapped, but the page isn't inerted or scroll-locked — the
      // palette has never done either, and inerting would break popups that
      // portal outside it.
      modal="trap-focus"
    >
      <Modal.Content
        variant="palette"
        widthClassName="w-[min(640px,100%)]"
        className="h-[min(500px,76vh)] max-[560px]:h-[min(560px,82vh)]"
        aria-label="Command menu"
        initialFocus={inputRef}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-3 border-b border-divider px-5 py-4">
          <IconSearch className="shrink-0 text-faint" size={22} />
          <input
            ref={inputRef}
            // 16px at every width on purpose: anything smaller makes iOS zoom
            // the page when the palette's field takes focus.
            className="flex-1 border-none bg-transparent font-sans text-input-phone leading-[1.4] text-fg outline-none placeholder:text-faint"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveKey(null);
            }}
            placeholder="Search actions, pull requests & conversations…"
            spellCheck={false}
            role="combobox"
            aria-label="Search commands and conversations"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="command-palette-results"
            aria-activedescendant={
              results[active] ? `command-result-${active}` : undefined
            }
          />
          {(searching || loadingPrs) && (
            <span
              className={
                "size-[13px] shrink-0 animate-[spin_0.7s_linear_infinite] rounded-full border-2 border-line-strong border-t-accent " +
                // Keeps turning under reduced motion — it is the only "still
                // searching" signal, and the blanket rule would freeze it.
                "motion-reduce:[animation-duration:0.7s]! motion-reduce:[animation-iteration-count:infinite]!"
              }
              aria-label="Searching"
            />
          )}
          <kbd className={KBD}>esc</kbd>
        </div>

        <div
          className="flex flex-wrap items-center gap-2 border-b border-divider px-4 py-2.5"
          aria-label="Session filters"
        >
          <FilterMenu
            label="Person"
            value={person}
            options={personOptions}
            onChange={setPerson}
            icon={<IconPeople size={18} />}
          />
          <FilterMenu
            label="Repo"
            value={repo}
            options={repoOptions}
            onChange={setRepo}
            icon={<IconRepo size={18} />}
          />
          <FilterMenu
            label="Status"
            value={status}
            options={statusOptions}
            onChange={setStatus}
            icon={<IconStatusRing size={18} />}
          />
          {hasSessionFilter && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto text-faint"
              data-session-filter-clear
              onClick={() => {
                setPerson("all");
                setRepo("all");
                setStatus("all");
              }}
            >
              Clear
            </Button>
          )}
        </div>

        <div
          id="command-palette-results"
          className="min-h-0 flex-1 overflow-y-auto p-2"
          ref={listRef}
          role="listbox"
        >
          {results.length === 0 && (
            <div className="px-4 py-7 text-center text-label text-faint">
              {searching ? "Searching conversations…" : "Nothing found"}
            </div>
          )}
          {results.map((result, i) => {
            const startsGroup =
              i === 0 || results[i - 1]?.category !== result.category;
            if (result.type === "action") {
              return (
                <React.Fragment key={`action:${result.action.id}`}>
                  {startsGroup && (
                    <div className="px-3 pb-1.5 pt-2.5 text-meta font-semibold text-faint">
                      {result.category}
                    </div>
                  )}
                  <button
                    id={`command-result-${i}`}
                    data-idx={i}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    tabIndex={-1}
                    className={ITEM}
                    onMouseMove={() => setActiveKey(resultKey(result))}
                    onClick={() => selectResult(result)}
                  >
                    {result.action.icon && (
                      <span className="inline-flex size-5 shrink-0 items-center justify-center text-dim group-aria-selected:text-fg">
                        {result.action.icon}
                      </span>
                    )}
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-label font-medium">
                        {result.action.label}
                      </span>
                      {result.action.description && (
                        <span className="max-w-full truncate text-supporting leading-[1.35] text-dim">
                          {result.action.description}
                        </span>
                      )}
                    </span>
                    {result.action.shortcut && (
                      <span className="inline-flex shrink-0 items-center gap-[3px] max-[560px]:hidden">
                        {result.action.shortcut.map((key) => (
                          <kbd key={key} className={KBD}>
                            {key}
                          </kbd>
                        ))}
                      </span>
                    )}
                  </button>
                </React.Fragment>
              );
            }
            if (result.type === "pr") {
              const pr = result.pr;
              return (
                <React.Fragment key={`pr:${pr.url}`}>
                  {startsGroup && (
                    <div className="px-3 pb-1.5 pt-2.5 text-meta font-semibold text-faint">
                      {result.category}
                    </div>
                  )}
                  <button
                    id={`command-result-${i}`}
                    data-idx={i}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    tabIndex={-1}
                    className={ITEM}
                    onMouseMove={() => setActiveKey(resultKey(result))}
                    onClick={() => selectResult(result)}
                  >
                    <span className="inline-flex size-5 shrink-0 items-center justify-center text-dim group-aria-selected:text-fg">
                      <IconPullRequest size={18} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-label font-medium">
                        {pr.title}
                      </span>
                      <span className="flex items-center gap-2 overflow-hidden whitespace-nowrap text-meta text-faint">
                        <span className="text-dim">
                          {repoLabel(pr.repo)} #{pr.number}
                        </span>
                        <span className="max-w-[220px] truncate max-[560px]:hidden">
                          {pr.branch}
                        </span>
                        <span>{pr.author}</span>
                      </span>
                    </span>
                    <span className="shrink-0 text-meta text-faint max-[560px]:hidden">
                      {prStatus(pr)}
                    </span>
                  </button>
                </React.Fragment>
              );
            }
            const s = result.session;
            const st = sessionStatus(s);
            const meta = STATUS_META[st];
            return (
              <React.Fragment key={`session:${s.id}`}>
                {startsGroup && (
                  <div className="px-3 pb-1.5 pt-2.5 text-meta font-semibold text-faint">
                    {result.category}
                  </div>
                )}
                <button
                  id={`command-result-${i}`}
                  data-idx={i}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  tabIndex={-1}
                  className={ITEM}
                  onMouseMove={() => setActiveKey(resultKey(result))}
                  onClick={() => selectResult(result)}
                >
                  <span
                    className={`size-2 shrink-0 rounded-full ${meta.dotClass}`}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-label font-medium">
                      {s.title}
                    </span>
                    {result.snippet && (
                      <span className="max-w-full truncate text-supporting leading-[1.35] text-dim">
                        {result.snippet}
                      </span>
                    )}
                    <span className="flex items-center gap-2 overflow-hidden whitespace-nowrap text-meta text-faint">
                      {s.automation ? (
                        <span className="rounded-sm bg-[color-mix(in_srgb,var(--yellow)_16%,transparent)] px-1.5 py-px text-meta text-yellow">
                          {s.automation}
                        </span>
                      ) : (
                        s.startedBy && <span>{s.startedBy}</span>
                      )}
                      <span className="text-dim">{sessionRepo(s)}</span>
                      {s.branch && (
                        <span className="max-w-[220px] truncate max-[560px]:hidden">
                          {s.branch}
                        </span>
                      )}
                      <span className="ml-auto shrink-0">
                        {relativeTime(s.lastActivity)}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 text-meta text-faint max-[560px]:hidden">
                    {meta.label}
                  </span>
                </button>
              </React.Fragment>
            );
          })}
        </div>

        <div className="flex items-center gap-4 border-t border-line px-4 py-2.5 text-meta text-faint">
          <span className="phone:hidden">
            <kbd className={KBD}>↑</kbd>
            <kbd className={KBD}>↓</kbd> navigate
          </span>
          <span className="phone:hidden">
            <kbd className={KBD}>↵</kbd> open
          </span>
          <span className="ml-auto">
            {results.length} result{results.length === 1 ? "" : "s"}
          </span>
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}
