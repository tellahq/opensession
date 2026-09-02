import React from "react";
import { z } from "zod";
import { DEFAULT_REPO_ID } from "./brand";
import type { Group } from "./sidebar-types";
import type { FeedItem, UnifiedSession } from "./types";
import { sessionRepoOr } from "./session-repo";
import { onRepoCountChanged, repoCount } from "./repo-count";
import { RepoTile } from "../components/RepoTile";

// Per-person group dots share the repo-tile swatch palette (RepoTile.tsx) —
// the same deterministic hash keeps each teammate's color stable.
// ── Support band: priority buckets + persisted filter ──
// Plain priorities are ints 0..3; unset buckets as Normal (Plain's default).
// Colors follow SupportTinder's priority palette (Urgent red / High yellow),
// with Normal on blue so the queue reads at a glance; `dot` colors the row
// circle of tickets that have no linked session (a session's live status
// still wins the dot).
export const SUPPORT_PRIORITY_GROUPS = [
  { p: 0, label: "Urgent", cls: "text-red", dot: "var(--red)" },
  { p: 1, label: "High", cls: "text-yellow", dot: "var(--yellow)" },
  { p: 2, label: "Normal", cls: "text-blue", dot: "var(--blue)" },
  { p: 3, label: "Low", cls: "text-faint", dot: "var(--text-faint)" },
] as const;
export const SUPPORT_PRIORITY_DOT: Record<number, string> = Object.fromEntries(
  SUPPORT_PRIORITY_GROUPS.map((g) => [g.p, g.dot]),
);

// ── Generic feed-band filters (the feeds design) ──
// Every band's filter menu is driven by the feed descriptor's FeedFilterSpec
// list: arg-mode specs feed the backing list tool (tags/playlists),
// meta-mode specs filter client-side over item.meta (plain assignee/labels,
// options derived from the items). Built-ins on every feed: "Linked session"
// and (non-lane feeds) "Sort". Selections persist per browser, per feed.
// This replaced plain's bespoke SupportFilterState menu.
const feedFilterValuesSchema = z.record(z.string(), z.string());
const savedFeedFiltersSchema = z
  .record(z.string(), feedFilterValuesSchema)
  .catch({});
export type FeedFilterValues = z.infer<typeof feedFilterValuesSchema>;
export const FEED_FILTERS_KEY = "opensession-feed-filters";
export function readFeedFilters(): Record<string, FeedFilterValues> {
  try {
    return savedFeedFiltersSchema.parse(
      JSON.parse(localStorage.getItem(FEED_FILTERS_KEY) || "{}"),
    );
  } catch {
    return {};
  }
}

const feedMetadataSchema = z.json();
const feedMetadataObjectSchema = z.record(z.string(), feedMetadataSchema);
type FeedMetadataValue = z.infer<typeof feedMetadataSchema>;
type FeedMetadataInput = FeedItem["meta"] | FeedMetadataValue;

/** `a.b` getter over item meta / option objects. */
export function dget(
  obj: FeedMetadataInput,
  path?: string,
): FeedMetadataValue | undefined {
  const parsed = feedMetadataSchema.safeParse(obj);
  if (!parsed.success) return undefined;
  if (!path) return parsed.data;
  let current = parsed.data;
  for (const segment of path.split(".")) {
    const record = feedMetadataObjectSchema.safeParse(current);
    if (!record.success) return undefined;
    current = record.data[segment];
    if (current === undefined) return undefined;
  }
  return current;
}

export const EXPANDED_KEY = "opensession-sidebar-expanded";

export const DEFAULT_EXPANDED = [
  "recently",
  "pinned",
  "needsreview",
  "approvedreview",
  "awaitingreview",
  "status:needsinput",
  "status:merged",
  "status:pending",
  "status:review",
  "status:inprogress",
  "status:snoozed",
];

export function readExpanded(): Set<string> {
  try {
    return new Set(
      JSON.parse(
        localStorage.getItem(EXPANDED_KEY) || JSON.stringify(DEFAULT_EXPANDED),
      ),
    );
  } catch {
    return new Set(DEFAULT_EXPANDED);
  }
}

// ── Grouping / filtering controls (the filter popover) ─────────────────────
// Two independent answers shape the list. "Group by" chooses the row sections:
// Inbox (Active / Snoozed), Activity (In progress / Needs action / Recent /
// Yesterday / Earlier), or Status (Needs input / In progress / …). "Group by
// project" then decides whether those sections are global or repeated inside
// each project. Repo and Person only narrow the same inventory.
export type GroupBy = "inbox" | "activity" | "status";
export type SortBy = "updated" | "created";
// Session-less PR rows folded into the project lanes. New browsers hide them.
// The historical "default" value shows your own PRs plus explicit review
// requests, "all" widens to everyone's open PRs (including automation output),
// and "none" hides PR rows entirely.
export type PrsFilter = "default" | "all" | "none";
// Workspaces an agent started for itself through the automation machine
// identity. They stay out of the list by default. When shown, they sit in the
// ordinary lanes and say so with a robot beside the name
// (components/sidebar/AutoCreatedMark).
export type AutoCreatedFilter = "show" | "hide";
// A registered project with no work in it still draws a band, so a repo you
// just connected has somewhere to start from. deriveSidebarProjectBands owns
// this inclusion rule. On an instance with more projects than you work in,
// that is a screen of empty
// headings, and this takes them out. Scoping the list to one project still
// shows that project's band: asking for it by name is not clutter.
export type EmptyProjectsFilter = "show" | "hide";
export const DEFAULT_PROJECT = DEFAULT_REPO_ID;
export const FILTER_KEY = "opensession-sidebar-filter";
// Bumped when Settled was replaced by Inbox. v8 keeps project grouping
// independent and migrates every explicit Settled choice to Inbox.
export const FILTER_VERSION = 8;

const GROUP_BYS: GroupBy[] = ["inbox", "activity", "status"];

function isGroupBy(value: unknown): value is GroupBy {
  return GROUP_BYS.some((groupBy) => groupBy === value);
}

/** Nobody choosing a section mode gets Active and Snoozed inbox sections. */
export function defaultGroupBy(): GroupBy {
  return "inbox";
}

/** Several projects default to project bands; one project does not need them. */
export function defaultByProject(): boolean {
  const count = repoCount();
  return count === null || count > 1;
}

export interface FilterState {
  groupBy: GroupBy;
  byProject: boolean;
  repo: string; // a repo id, or "all"
  // "me" (your workspaces — the default), "everyone" (literally all
  // workspaces), "unassigned" (the aggregate backlog view), or a lowercased
  // person key for a specific teammate.
  person: string;
  sort: SortBy;
  prs: PrsFilter;
  autoCreated: AutoCreatedFilter;
  emptyProjects: EmptyProjectsFilter;
}

/** Whether registered repos without visible rows belong in project grouping. */
export function includesEmptyRepoBands(
  filter: FilterState,
  search: string,
): boolean {
  return (
    !search &&
    filter.person === "me" &&
    (filter.repo !== "all" || filter.emptyProjects === "show")
  );
}

/** What either grouping axis can be on disk: a pick, or auto when unpicked. */
export type StoredGroupBy = GroupBy | "auto";
export type StoredByProject = boolean | "auto";

export interface StoredFilterState extends Omit<
  FilterState,
  "groupBy" | "byProject"
> {
  groupBy: StoredGroupBy;
  byProject: StoredByProject;
}

/**
 * The person lens is shared, not the sidebar's private business: the People
 * page, the facepiles and the sidebar's groups read and write this one value,
 * so the person you pick is the sidebar you land in. Everything else in
 * `FilterState` still only has one reader (the sidebar's own popover), but it
 * rides along here because the whole state persists as one blob.
 */
const CHANGE_EVENT = "opensession-sidebar-filter-changed";
// What is stored (grouping possibly "auto") and what the app reads (that
// resolved against the project count). Both are cached; a write, another tab,
// or a change in the number of projects drops the resolved one.
let stored: StoredFilterState | null = null;
let current: FilterState | null = null;

export function getFilter(): FilterState {
  if (!current) {
    stored ||= readStoredFilter();
    current = {
      ...stored,
      groupBy: stored.groupBy === "auto" ? defaultGroupBy() : stored.groupBy,
      byProject:
        stored.byProject === "auto" ? defaultByProject() : stored.byProject,
    };
  }
  return current;
}

export function setFilter(patch: Partial<FilterState>) {
  getFilter();
  // Picking a grouping from the menu makes it explicit: it stores the value
  // rather than "auto", so adding a project won't move it afterwards.
  const next: StoredFilterState = { ...stored!, ...patch };
  stored = next;
  current = null;
  localStorage.setItem(
    FILTER_KEY,
    JSON.stringify({ ...next, v: FILTER_VERSION }),
  );
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function onFilterChanged(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}

// Another tab's write: drop the cache so subscribers re-read from storage.
// Guarded because this module is reached from plain `bun test` runs (the pull
// request list's row-merging test imports the component), where there is no
// window to listen on and a module-scope call throws before the first test runs.
if (globalThis.window?.addEventListener) {
  globalThis.window.addEventListener("storage", (event) => {
    if (event.key !== FILTER_KEY) return;
    stored = null;
    current = null;
    globalThis.window.dispatchEvent(new Event(CHANGE_EVENT));
  });
  // The project list landing (or a project being added) can change what
  // "auto" means, so the sidebar re-reads it.
  onRepoCountChanged(() => {
    if (stored?.byProject !== "auto") return;
    if (current?.byProject === defaultByProject()) return;
    current = null;
    globalThis.window.dispatchEvent(new Event(CHANGE_EVENT));
  });
}

export function useSidebarFilter(): FilterState {
  const [state, setState] = React.useState(getFilter);
  React.useEffect(() => onFilterChanged(() => setState(getFilter())), []);
  return state;
}

/**
 * The lens as a page that only knows about people reads it — a lowercased
 * person key, or "all" when the filter is on everyone (or nobody is signed
 * in, where "me" can't resolve to a name).
 */
export function personScope(person: string, currentUser: string): string {
  if (person === "me") {
    const me = currentUser.trim().toLowerCase();
    return !me || me === "anonymous" ? "all" : me;
  }
  return person === "everyone" || person === "unassigned" ? "all" : person;
}

/** The reverse: your own face is stored as the default lens, so the filter
 *  keeps meaning "mine" if the signed-in user changes. */
export function personFilterFor(key: string, currentUser: string): string {
  return key === currentUser.trim().toLowerCase() ? "me" : key;
}

// The person lens is picked from several places: the People page, the pull
// request list's header, and the sidebar's People row. The mapping between
// "what the menu is showing" and "what the filter stores" lives here rather
// than once per surface.

/** The lens as the menu spells it: a person key, or "everyone" / "unassigned". */
export function personLensValue(person: string, currentUser: string): string {
  if (person === "unassigned") return "unassigned";
  const scope = personScope(person, currentUser);
  return scope === "all" ? "everyone" : scope;
}

/** What the menu's pick stores on the filter. */
export function personLensFilter(picked: string, currentUser: string): string {
  return picked === "all" || picked === "everyone"
    ? "everyone"
    : personFilterFor(picked, currentUser);
}

interface StoredGrouping {
  groupBy: StoredGroupBy;
  byProject: StoredByProject;
}

const storedFilterInputSchema = z
  .object({
    v: z.number().optional(),
    groupBy: z.string().optional(),
    byProject: z.boolean().optional(),
    sections: z.string().optional(),
    lanes: z.string().optional(),
    repo: z.string().optional(),
    person: z.string().optional(),
    sort: z.string().optional(),
    prs: z.string().optional(),
    autoCreated: z.string().optional(),
    emptyProjects: z.string().optional(),
  })
  .catch({});
type StoredFilterInput = z.infer<typeof storedFilterInputSchema>;

function legacyGrouping(
  groupBy: string | undefined,
): StoredGrouping | undefined {
  switch (groupBy) {
    case "status":
      return { groupBy: "status", byProject: false };
    case "repo":
      return { groupBy: "activity", byProject: true };
    case "repo-status":
      return { groupBy: "status", byProject: true };
    case "repo-inbox":
      return { groupBy: "activity", byProject: true };
    case "inbox":
      return { groupBy: "activity", byProject: false };
    default:
      return undefined;
  }
}

/** Resolve every historical shape into the two independent v8 axes. */
function storedGrouping(v: StoredFilterInput): StoredGrouping {
  if (v.v === FILTER_VERSION) {
    return {
      groupBy: isGroupBy(v.groupBy) ? v.groupBy : "auto",
      byProject: v.byProject ?? "auto",
    };
  }
  if (v.v === 7) {
    return {
      groupBy:
        v.groupBy === "settled"
          ? "inbox"
          : isGroupBy(v.groupBy)
            ? v.groupBy
            : "auto",
      byProject: v.byProject ?? "auto",
    };
  }
  if (v.v === 6) {
    switch (v.groupBy) {
      case "none":
        return { groupBy: "inbox", byProject: false };
      case "repo":
        return { groupBy: "inbox", byProject: true };
      case "status":
        return { groupBy: "status", byProject: false };
      default:
        return { groupBy: "auto", byProject: "auto" };
    }
  }
  if (v.v === 4 || v.v === 5) {
    const sections = v.sections ?? v.lanes;
    const groupBy: StoredGroupBy =
      sections === "status"
        ? "status"
        : sections === "inbox"
          ? "activity"
          : sections === "none"
            ? "inbox"
            : "auto";
    const byProject: StoredByProject =
      v.groupBy === "repo" ? true : v.groupBy === "none" ? false : "auto";
    return { groupBy, byProject };
  }
  const mapped = legacyGrouping(v.groupBy);
  if (!mapped) return { groupBy: "auto", byProject: "auto" };
  if (v.v === 3) return mapped;
  if (v.groupBy === "repo-status")
    return { groupBy: "auto", byProject: "auto" };
  if (v.groupBy === "status" && v.v !== 2)
    return { groupBy: "auto", byProject: "auto" };
  return mapped;
}

export function readStoredFilter(): StoredFilterState {
  try {
    const parsed = JSON.parse(localStorage.getItem(FILTER_KEY) || "{}");
    const storedInput = storedFilterInputSchema.parse(parsed);
    const grouping = storedGrouping(storedInput);
    return {
      groupBy: grouping.groupBy,
      byProject: grouping.byProject,
      repo: storedInput.repo ?? "all",
      // Legacy stored "all" behaved as "you" in the lanes — map it to "me"
      // so nobody's default flips to everyone.
      person:
        storedInput.person && storedInput.person !== "all"
          ? storedInput.person
          : "me",
      sort: storedInput.sort === "created" ? "created" : "updated",
      // An absent value is the untouched preference, so new browsers hide PR
      // rows. Keep every explicit historical choice, including "default",
      // which is the persisted name for Mine + requested.
      prs:
        storedInput.prs === "default" ||
        storedInput.prs === "all" ||
        storedInput.prs === "none"
          ? storedInput.prs
          : "none",
      // v4's "show" was the default rather than a deliberate opt-in. Move
      // every older browser to the safer default; v5 was the version that
      // made it a choice, so it and everything after it say what they mean.
      // (Reading it as "at least v5" rather than "the current version" is
      // what keeps the next version bump from silently re-hiding the rows
      // of everyone who asked to see them.)
      autoCreated:
        storedInput.v !== undefined &&
        storedInput.v >= 5 &&
        storedInput.autoCreated === "show"
          ? "show"
          : "hide",
      emptyProjects: storedInput.emptyProjects === "hide" ? "hide" : "show",
    };
  } catch {
    return {
      groupBy: "auto",
      byProject: "auto",
      repo: "all",
      person: "me",
      sort: "updated",
      prs: "none",
      autoCreated: "hide",
      emptyProjects: "show",
    };
  }
}

export function sessionRepo(s: UnifiedSession): string {
  // Repo-less feed/scratch sessions file under their feed's kind so they
  // don't mislabel as the default repo (the feeds design). Other surfaces
  // use different fallbacks on purpose — see lib/session-repo.
  return sessionRepoOr(s, s.externalRefs?.[0]?.kind || DEFAULT_PROJECT);
}

// Every `repo\nbranch` key a session's work can be reached by: its own checkout
// plus each PR / attached-repo / linked-PR ref it carries. Matching sessions to
// the open-PR list runs through this, so the PR-row dedupe and the live-review
// lookup below can't drift apart.
export function sessionPrKeys(c: UnifiedSession): string[] {
  const keys = c.branch ? [`${sessionRepo(c)}\n${c.branch}`] : [];
  for (const ref of [
    ...(c.prs || []),
    ...(c.attachedRepos || []),
    ...(c.linkedPrs || []),
  ])
    keys.push(`${ref.repo}\n${ref.branch}`);
  return keys;
}
