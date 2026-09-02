import { repoLabel } from "../lib/repo-label";
import { cn } from "../ui/cn";
import { FALLBACK_REPO, sessionRepoOr } from "../lib/session-repo";
import { sessionSourceLabel } from "../lib/brand";
import { SOURCE_CHIP, sourceChipTone } from "../lib/source-chip-classes";
import {
  ARCHIVED_LIST,
  ARCHIVED_PHONE_SEARCH_DOCK,
  ARCHIVED_ROW,
  ARCHIVED_ROW_ACTION,
  ARCHIVED_SWIPE_ACTION,
  ARCHIVED_SWIPE_ROW,
  ARCHIVED_ROW_META,
  ARCHIVED_ROW_OPEN,
  ARCHIVED_ROW_TRAIL,
  ARCHIVED_ROW_TIME,
  ARCHIVED_ROW_TITLE,
  ARCHIVED_SECTION_LABEL,
  ARCHIVED_SECTION_ROWS,
} from "../lib/archived-classes";
import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { UnifiedSession } from "../lib/types";
import { relativeTime, archiveSessionApi } from "../lib/api";
import { useCurrentUser } from "./UserPicker";
import { usePeople } from "../lib/people";
import {
  canonicalNames,
  sessionHasOwner,
  sessionOwners,
} from "../lib/session-owner";
import { docTitle, DEFAULT_DOC_TITLE } from "../lib/brand";
import { useIsPhone } from "../hooks/useIsPhone";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { ContextMenu, Menu, MENU_ICON } from "../ui/menu";
import { EmptyState, ListSkeleton } from "../ui/state";
import { IconChevronRight, IconFilter, IconUnarchive } from "./icons";
import { RepoTile } from "./RepoTile";
import { UserAvatar } from "./UserAvatar";

interface Props {
  sessions: UnifiedSession[];
  /**
   * Whether the archived index has landed. Archived sessions are no longer in
   * the polled list — they're fetched separately, after first paint — so an
   * empty `sessions` here means "not yet" as often as it means "none", and
   * this page is the one place that difference is the whole screen.
   */
  loaded: boolean;
  onSelect: (session: UnifiedSession) => void;
  onChanged: () => void;
  /** The desktop pane's top bar, where this page's controls go. */
  topbarActionsEl?: HTMLElement | null;
  /** The phone header's trailing slot, where Filters goes. */
  mobileActionsEl?: HTMLElement | null;
}

// Same key the sidebar persists its group/repo/sort choices under, so the
// archived page opens with the repo filter the sidebar is already showing.
const SIDEBAR_FILTER_KEY = "opensession-sidebar-filter";

/** How many rows the list draws before asking for a narrower search. */
const PAGE_SIZE = 200;

const RESTORE_SWIPE_PX = 82;
const RESTORE_SWIPE_THRESHOLD = 36;
const RESTORE_SWIPE_AXIS_LOCK = 8;

type RestoreSwipe = { id: string; offset: number };
type RestoreSwipeOrigin = {
  id: string;
  x: number;
  y: number;
  allowRight: boolean;
};

/** Follow the finger 1:1, then add light resistance past the revealed action. */
function restoreSwipeOffset(dx: number): number {
  if (dx >= 0) return 0;
  if (dx >= -RESTORE_SWIPE_PX) return dx;
  return Math.max(-104, -RESTORE_SWIPE_PX + (dx + RESTORE_SWIPE_PX) * 0.18);
}

/**
 * `"mine"`, `"everyone"`, or one teammate's lowercased `startedBy` name — the
 * archive is shared, so "whose is this" is a person, not a boolean.
 */
type OwnerFilter = "mine" | "everyone" | (string & {});
type ReasonFilter = "all" | "manual" | "auto";

const ARCHIVE_SECTION_ORDER = ["today", "yesterday", "week", "older"] as const;
type ArchiveSectionKey = (typeof ARCHIVE_SECTION_ORDER)[number];

const ARCHIVE_SECTION_LABELS: Record<ArchiveSectionKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "Past 7 days",
  older: "Older",
};

function archiveSectionKey(dateString: string, today: Date): ArchiveSectionKey {
  const date = new Date(dateString);
  if (!Number.isFinite(date.getTime())) return "older";
  // Compare local calendar days through UTC ordinals. A raw millisecond
  // difference misclassifies rows across daylight-saving boundaries.
  const todayOrdinal = Date.UTC(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const dateOrdinal = Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  const daysAgo = Math.max(
    0,
    Math.round((todayOrdinal - dateOrdinal) / 86_400_000),
  );
  if (daysAgo === 0) return "today";
  if (daysAgo === 1) return "yesterday";
  if (daysAgo < 7) return "week";
  return "older";
}

function archiveSections(sessions: UnifiedSession[]) {
  const groups = new Map<ArchiveSectionKey, UnifiedSession[]>();
  const today = new Date();
  for (const session of sessions) {
    const key = archiveSectionKey(session.lastActivity, today);
    const group = groups.get(key);
    if (group) group.push(session);
    else groups.set(key, [session]);
  }
  return ARCHIVE_SECTION_ORDER.flatMap((key) => {
    const items = groups.get(key);
    return items ? [{ key, label: ARCHIVE_SECTION_LABELS[key], items }] : [];
  });
}

// Manual archiving is the only reason an old registry/file entry can be
// missing `archivedReason` (it predates the field) — treat unset as manual.
function isAutoReason(s: UnifiedSession): boolean {
  return !!s.archivedReason && s.archivedReason !== "manual";
}

// Repo-less sessions group under the literal FALLBACK_REPO bucket, not the
// sidebar's default-repo lane (see lib/session-repo for the fork rationale).
function sessionRepo(s: UnifiedSession): string {
  return sessionRepoOr(s, FALLBACK_REPO);
}

// The repo the sidebar is currently filtered to ("all" when unset), read fresh
// so we inherit it as the archived page's starting repo.
function sidebarRepo(): string {
  try {
    const v = JSON.parse(localStorage.getItem(SIDEBAR_FILTER_KEY) || "{}");
    return typeof v.repo === "string" ? v.repo : "all";
  } catch {
    return "all";
  }
}

/**
 * The chip naming where a session came from — rendered only when it says
 * something. An automation's name is worth a chip; so is a session that
 * arrived from Slack or Linear, or one that ran read-only. A code session
 * started here is the default and gets none: `os¹` on all six hundred rows is
 * a column of noise dressed as data.
 */
function originChip(s: UnifiedSession): { label: string; tone: string } | null {
  if (s.automation) return { label: s.automation, tone: "" };
  if (s.mode === "ask") return { label: "ask", tone: sourceChipTone("ask") };
  if (s.source && s.source !== "opensession") {
    return {
      label: sessionSourceLabel(s.source),
      tone: sourceChipTone(s.source),
    };
  }
  return null;
}

export function Archived({
  sessions,
  loaded,
  onSelect,
  onChanged,
  topbarActionsEl,
  mobileActionsEl,
}: Props) {
  const currentUser = useCurrentUser();
  const isPhone = useIsPhone();
  const roster = usePeople();
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // Scope: default to *my* archived sessions, and inherit the sidebar's
  // repo filter — both still adjustable here.
  const [owner, setOwner] = useState<OwnerFilter>("mine");
  const [repo, setRepo] = useState<string>(sidebarRepo);
  const [reason, setReason] = useState<ReasonFilter>("all");
  const [restoreSwipe, setRestoreSwipe] = useState<RestoreSwipe | null>(null);
  const [draggingRestoreId, setDraggingRestoreId] = useState<string | null>(
    null,
  );
  const restoreSwipeOrigin = useRef<RestoreSwipeOrigin | null>(null);
  const restoreSwiping = useRef(false);
  const restoreSwipeOffsetRef = useRef(0);

  useEffect(() => {
    if (isPhone) return;
    setRestoreSwipe(null);
    restoreSwipeOffsetRef.current = 0;
  }, [isPhone]);

  useEffect(() => {
    document.title = docTitle("Archived");
    return () => {
      document.title = DEFAULT_DOC_TITLE;
    };
  }, []);

  const allArchived = sessions.filter((s) => s.archived);
  const hasAutoArchived = allArchived.some(isAutoReason);
  const activeFilterCount =
    (owner !== "everyone" ? 1 : 0) +
    (repo !== "all" ? 1 : 0) +
    (reason !== "all" ? 1 : 0);

  // Teammates who archived something, most-archived first — the Owner options
  // beyond you. Built from the whole archived set, not the filtered one, so
  // choosing a person doesn't empty the list you chose them from.
  const meKey = currentUser.toLowerCase();
  const canonical = canonicalNames(roster);
  const people = sessionOwners(allArchived, canonical, meKey);

  // Repos present in the archived set, most-used first — the repo dropdown options.
  const repos = (() => {
    const counts = new Map<string, number>();
    for (const s of allArchived) {
      const p = sessionRepo(s);
      counts.set(p, (counts.get(p) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name]) => name);
  })();

  // If the inherited repo isn't among the archived sessions, fall back to "all"
  // so the list isn't mysteriously empty on open.
  useEffect(() => {
    if (repo !== "all" && !repos.includes(repo)) setRepo("all");
  }, [repo, repos]);

  // Same for a teammate who no longer has anything archived — but only once
  // people have been seen at all, so a reload doesn't drop the choice mid-flight.
  useEffect(() => {
    if (
      owner !== "mine" &&
      owner !== "everyone" &&
      people.length > 0 &&
      !people.some((p) => p.key === owner)
    )
      setOwner("everyone");
  }, [owner, people]);

  const archived = (() => {
    let list = allArchived;
    if (owner !== "everyone") {
      const user = owner === "mine" ? meKey : owner;
      list = list.filter((s) => sessionHasOwner(s, user, canonical));
    }
    if (repo !== "all") list = list.filter((s) => sessionRepo(s) === repo);
    if (reason !== "all")
      list = list.filter((s) =>
        reason === "auto" ? isAutoReason(s) : !isAutoReason(s),
      );
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          sessionRepo(s).toLowerCase().includes(q) ||
          (s.branch || "").toLowerCase().includes(q) ||
          (s.startedBy || "").toLowerCase().includes(q) ||
          (s.automation || "").toLowerCase().includes(q),
      );
    }
    return list;
  })();
  const visibleArchived = archived.slice(0, PAGE_SIZE);
  const sections = archiveSections(visibleArchived);

  async function handleUnarchive(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    setBusy(id);
    await (async () => {
      await archiveSessionApi(id, false);
      onChanged();
    })().finally(async () => {
      setBusy(null);
    });
  }

  function closeRestoreSwipe() {
    setRestoreSwipe(null);
    restoreSwipeOffsetRef.current = 0;
  }

  function restoreTouchStart(id: string, e: React.TouchEvent<HTMLElement>) {
    if (!isPhone || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const existingOffset = restoreSwipe?.id === id ? restoreSwipe.offset : 0;
    if (restoreSwipe?.id && restoreSwipe.id !== id) closeRestoreSwipe();
    restoreSwiping.current = false;
    restoreSwipeOffsetRef.current = existingOffset;
    restoreSwipeOrigin.current = {
      id,
      x: touch.clientX - existingOffset,
      y: touch.clientY,
      allowRight: existingOffset < 0,
    };
  }

  function restoreTouchMove(id: string, e: React.TouchEvent<HTMLElement>) {
    if (!isPhone || e.touches.length !== 1) return;
    const origin = restoreSwipeOrigin.current;
    if (!origin || origin.id !== id) return;
    const touch = e.touches[0];
    const dx = touch.clientX - origin.x;
    const dy = touch.clientY - origin.y;
    if (!restoreSwiping.current) {
      const horizontal =
        Math.abs(dx) > RESTORE_SWIPE_AXIS_LOCK && Math.abs(dx) > Math.abs(dy);
      if (!horizontal || (dx > 0 && !origin.allowRight)) return;
      restoreSwiping.current = true;
      setDraggingRestoreId(id);
    }
    e.preventDefault();
    const offset = restoreSwipeOffset(dx);
    restoreSwipeOffsetRef.current = offset;
    const row = e.currentTarget;
    row.style.setProperty("--swipe-x", `${offset}px`);
    row.parentElement?.style.setProperty(
      "--swipe-action-w",
      `${Math.max(RESTORE_SWIPE_PX, Math.abs(offset))}px`,
    );
  }

  function restoreTouchEnd(id: string, e: React.TouchEvent<HTMLElement>) {
    const wasSwiping = restoreSwiping.current;
    restoreSwipeOrigin.current = null;
    restoreSwiping.current = false;
    setDraggingRestoreId(null);
    const row = e.currentTarget;
    row.style.removeProperty("--swipe-x");
    row.parentElement?.style.removeProperty("--swipe-action-w");
    if (wasSwiping) {
      e.preventDefault();
      const snapped =
        restoreSwipeOffsetRef.current < -RESTORE_SWIPE_THRESHOLD
          ? -RESTORE_SWIPE_PX
          : 0;
      restoreSwipeOffsetRef.current = snapped;
      setRestoreSwipe(snapped ? { id, offset: snapped } : null);
      return;
    }
    if (restoreSwipe?.id === id) {
      e.preventDefault();
      closeRestoreSwipe();
    }
  }

  function restoreTouchCancel(e: React.TouchEvent<HTMLElement>) {
    restoreSwipeOrigin.current = null;
    restoreSwiping.current = false;
    setDraggingRestoreId(null);
    const row = e.currentTarget;
    row.style.removeProperty("--swipe-x");
    row.parentElement?.style.removeProperty("--swipe-action-w");
    closeRestoreSwipe();
  }

  // Match Pull requests on desktop. On a phone the title and filter share the
  // top bar, while Search floats at the thumb edge below the list.
  const searchAction = (
    <Input
      className="w-[200px] min-w-[90px] shrink-[100] phone:min-h-11 phone:w-full phone:px-3.5 phone:text-input-phone"
      type="search"
      aria-label="Search archived sessions"
      placeholder="Search archived…"
      value={search}
      onChange={(e) => setSearch(e.target.value)}
      spellCheck={false}
    />
  );
  const filterAction = (
    <>
      <Menu.Root>
        <Menu.Trigger
          render={
            <Button
              variant="ghost"
              icon={<IconFilter size={18} />}
              aria-label={`Filters, ${activeFilterCount} active`}
              className={
                activeFilterCount > 0 ? "shrink-0 text-fg" : "shrink-0"
              }
            >
              Filters{activeFilterCount > 0 ? ` ${activeFilterCount}` : ""}
            </Button>
          }
        />
        <Menu.Popup align="end" className="min-w-[220px]">
          <Menu.Group>
            <Menu.GroupLabel>Owner</Menu.GroupLabel>
            <Menu.RadioGroup
              value={owner}
              onValueChange={(value) => setOwner(String(value))}
            >
              <Menu.RadioItem value="mine" closeOnClick>
                <UserAvatar name={currentUser} size={18} />
                <span className="min-w-0 flex-1">My archived</span>
                <Menu.Check on={owner === "mine"} />
              </Menu.RadioItem>
              {people.map(({ key, label }) => (
                <Menu.RadioItem key={key} value={key} closeOnClick>
                  <UserAvatar name={label} size={18} />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <Menu.Check on={owner === key} />
                </Menu.RadioItem>
              ))}
              <Menu.RadioItem value="everyone" closeOnClick>
                <span className="size-[18px] shrink-0" />
                <span className="min-w-0 flex-1">Everyone</span>
                <Menu.Check on={owner === "everyone"} />
              </Menu.RadioItem>
            </Menu.RadioGroup>
          </Menu.Group>
          {repos.length > 1 && (
            <>
              <Menu.Separator />
              <Menu.Group>
                <Menu.GroupLabel>Repository</Menu.GroupLabel>
                <Menu.RadioGroup
                  value={repo}
                  onValueChange={(value) => setRepo(String(value))}
                >
                  <Menu.RadioItem value="all" closeOnClick>
                    <span className="size-[18px] shrink-0" />
                    <span className="min-w-0 flex-1">All repos</span>
                    <Menu.Check on={repo === "all"} />
                  </Menu.RadioItem>
                  {repos.map((name) => (
                    <Menu.RadioItem key={name} value={name} closeOnClick>
                      <RepoTile name={name} size={18} />
                      <span className="min-w-0 flex-1 truncate">
                        {repoLabel(name)}
                      </span>
                      <Menu.Check on={repo === name} />
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
              </Menu.Group>
            </>
          )}
          {hasAutoArchived && (
            <>
              <Menu.Separator />
              <Menu.Group>
                <Menu.GroupLabel>Reason</Menu.GroupLabel>
                <Menu.RadioGroup
                  value={reason}
                  onValueChange={(value) => setReason(value as ReasonFilter)}
                >
                  {(["all", "auto", "manual"] as const).map((value) => (
                    <Menu.RadioItem key={value} value={value} closeOnClick>
                      <span className="min-w-0 flex-1">
                        {
                          {
                            all: "All",
                            auto: "Auto-archived",
                            manual: "Manual",
                          }[value]
                        }
                      </span>
                      <Menu.Check on={reason === value} />
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
              </Menu.Group>
            </>
          )}
          {activeFilterCount > 0 && (
            <>
              <Menu.Separator />
              <Menu.Item
                onClick={() => {
                  setOwner("everyone");
                  setRepo("all");
                  setReason("all");
                }}
              >
                Clear filters
              </Menu.Item>
            </>
          )}
        </Menu.Popup>
      </Menu.Root>
    </>
  );
  const count = loaded
    ? archived.length === allArchived.length
      ? `${archived.length} archived session${archived.length === 1 ? "" : "s"}`
      : `${archived.length} of ${allArchived.length} archived sessions`
    : "Loading archived sessions";

  const actions = (
    <>
      {searchAction}
      <span className="ml-auto whitespace-nowrap text-supporting text-dim tabular-nums">
        {count}
      </span>
      {filterAction}
    </>
  );

  const desktopPortaled = !!topbarActionsEl && !isPhone;
  const mobileFilterPortaled = !!mobileActionsEl && isPhone;

  return (
    <div data-page-scroll className="min-h-0 w-full flex-1 overflow-y-auto">
      {desktopPortaled ? createPortal(actions, topbarActionsEl) : null}
      {mobileFilterPortaled
        ? createPortal(filterAction, mobileActionsEl)
        : null}
      <div className="mx-auto w-full max-w-[860px] px-6 pb-[60px] pt-7 phone:px-3.5 phone:pb-[calc(5.5rem+env(safe-area-inset-bottom,0px))] phone:pt-2 phone:[body.kb-open_&]:pb-[5rem] phone:[body.kb-open_&]:pt-[max(env(safe-area-inset-top,0px),8px)]">
        {!isPhone && !desktopPortaled ? (
          <div className="mb-3 flex items-center gap-2">{actions}</div>
        ) : null}
        <p className="m-0 mb-3.5 hidden text-supporting text-dim tabular-nums phone:block">
          {count}
        </p>
        {archived.length === 0 && !loaded ? (
          // Not "nothing archived" — nothing YET. Claiming the list is empty
          // while it is still in flight is what makes a slow load read as data
          // loss. Match the borderless list geometry so the rows land where
          // these sat instead of changing surface when loading completes.
          <ListSkeleton
            variant="rows"
            rows={8}
            label="Loading archived sessions"
            className={ARCHIVED_LIST}
            rowClassName="px-3"
          />
        ) : archived.length === 0 ? (
          <Card>
            <EmptyState>
              Nothing archived
              {search || owner !== "everyone" || repo !== "all"
                ? " matches"
                : " yet"}
              .
            </EmptyState>
          </Card>
        ) : (
          <div className={ARCHIVED_LIST}>
            {sections.map((section, sectionIndex) => (
              <section
                key={section.key}
                className={sectionIndex > 0 ? "mt-6" : undefined}
              >
                <h2 className={ARCHIVED_SECTION_LABEL}>{section.label}</h2>
                <ul className={ARCHIVED_SECTION_ROWS}>
                  {section.items.map((s) => {
                    const chip = originChip(s);
                    // A field the current filter already fixes is the same word on
                    // every row, so each one only appears when it varies: who,
                    // while looking at everyone's; why, while not filtered by
                    // reason. The repo is the tile, which carries it in a glance.
                    const meta = [
                      chip && (
                        <span key="chip" className={cn(SOURCE_CHIP, chip.tone)}>
                          {chip.label}
                        </span>
                      ),
                      owner === "everyone" && s.startedBy && (
                        <span key="by" className="truncate">
                          {s.startedBy}
                        </span>
                      ),
                      reason === "all" && isAutoReason(s) && (
                        <span
                          key="auto"
                          className={cn(SOURCE_CHIP, "bg-active text-dim")}
                          title={`Auto-archived (${s.archivedReason})`}
                        >
                          auto
                        </span>
                      ),
                    ].filter(Boolean);
                    const swipeOffset =
                      restoreSwipe?.id === s.id ? restoreSwipe.offset : 0;
                    const dragging = draggingRestoreId === s.id;
                    return (
                      <li
                        key={s.id}
                        className={ARCHIVED_SWIPE_ROW}
                        data-swipe-row=""
                        style={
                          swipeOffset
                            ? ({
                                "--swipe-action-w": `${Math.max(
                                  RESTORE_SWIPE_PX,
                                  Math.abs(swipeOffset),
                                )}px`,
                              } as React.CSSProperties)
                            : undefined
                        }
                      >
                        <button
                          type="button"
                          className={ARCHIVED_SWIPE_ACTION}
                          data-open={dragging || swipeOffset ? "" : undefined}
                          disabled={busy === s.id}
                          onClick={(e) => {
                            closeRestoreSwipe();
                            void handleUnarchive(e, s.id);
                          }}
                        >
                          <IconUnarchive size={20} />
                          <span>Restore</span>
                        </button>
                        <ContextMenu.Root>
                          <ContextMenu.Trigger
                            render={
                              <div
                                className={cn(
                                  ARCHIVED_ROW,
                                  dragging &&
                                    "phone:transition-none phone:will-change-transform",
                                  swipeOffset && "phone:will-change-transform",
                                )}
                                style={
                                  swipeOffset
                                    ? ({
                                        "--swipe-x": `${swipeOffset}px`,
                                      } as React.CSSProperties)
                                    : undefined
                                }
                                onTouchStart={(e) => restoreTouchStart(s.id, e)}
                                onTouchMove={(e) => restoreTouchMove(s.id, e)}
                                onTouchEnd={(e) => restoreTouchEnd(s.id, e)}
                                onTouchCancel={restoreTouchCancel}
                              />
                            }
                          >
                            <RepoTile name={sessionRepo(s)} />
                            <button
                              type="button"
                              className={ARCHIVED_ROW_OPEN}
                              onClick={() => {
                                if (restoreSwipe?.id === s.id) {
                                  closeRestoreSwipe();
                                  return;
                                }
                                onSelect(s);
                              }}
                            >
                              <span className={ARCHIVED_ROW_TITLE}>
                                {s.title}
                              </span>
                              {meta.length > 0 ? (
                                <span className={ARCHIVED_ROW_META}>
                                  {meta}
                                  <span className="hidden shrink-0 phone:inline">
                                    {relativeTime(s.lastActivity)}
                                  </span>
                                </span>
                              ) : (
                                <span className="mt-1 hidden text-meta text-faint phone:block">
                                  {relativeTime(s.lastActivity)}
                                </span>
                              )}
                            </button>
                            <span className={ARCHIVED_ROW_TRAIL}>
                              <span className={ARCHIVED_ROW_TIME}>
                                {relativeTime(s.lastActivity)}
                              </span>
                              <IconChevronRight
                                size={16}
                                className="shrink-0"
                              />
                            </span>
                            <Button
                              size="sm"
                              className={ARCHIVED_ROW_ACTION}
                              icon={<IconUnarchive size={15} />}
                              aria-label="Restore session"
                              disabled={busy === s.id}
                              onClick={(e) => void handleUnarchive(e, s.id)}
                            >
                              Restore
                            </Button>
                          </ContextMenu.Trigger>
                          <ContextMenu.Popup>
                            <ContextMenu.Item
                              disabled={busy === s.id}
                              onClick={(e) => void handleUnarchive(e, s.id)}
                            >
                              <IconUnarchive size={18} className={MENU_ICON} />
                              <span>Restore</span>
                            </ContextMenu.Item>
                          </ContextMenu.Popup>
                        </ContextMenu.Root>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {archived.length > PAGE_SIZE && (
              <p className="m-0 px-3 pt-4 text-meta text-faint">
                Showing the first {PAGE_SIZE} of {archived.length}. Search to
                reach the older ones.
              </p>
            )}
          </div>
        )}
      </div>
      {isPhone ? (
        <div className={ARCHIVED_PHONE_SEARCH_DOCK}>{searchAction}</div>
      ) : null}
    </div>
  );
}
