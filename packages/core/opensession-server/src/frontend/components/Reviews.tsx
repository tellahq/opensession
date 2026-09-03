import { repoLabel } from "../lib/repo-label";
import { cleanSessionTitle } from "../lib/session-title";
import { AGENT_NAME } from "../lib/brand";
import React, { useEffect, useState } from "react";
import type {
  UnifiedSession,
  WSClientMessage,
  WSServerMessage,
} from "../lib/types";
import { relativeTime } from "../lib/api";
import { PrPanel } from "./PrPanel";
import { providerFromUrl, avatarUrl } from "../lib/provider";
import { EmptyState } from "../ui/state";
import { Badge } from "../ui/badge";

interface Props {
  sessions: UnifiedSession[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenSession: (id: string) => void;
  /** Open another PR in the review panel (stack map layer links). */
  onOpenPr?: (repo: string, branch: string) => void;
  onAddToInput: (id: string, text: string) => void;
  send?: (msg: WSClientMessage) => void;
  addHandler?: (handler: (msg: WSServerMessage) => void) => () => void;
}

type FilterKey = "review" | "open" | "merged" | "closed" | "all";
type StateKind = "open" | "draft" | "merged" | "closed";

const STATE_RANK = {
  OPEN: 0,
  CLOSED: 1,
  MERGED: 2,
} satisfies Record<NonNullable<UnifiedSession["prState"]>, number>;

function stateRank(state: UnifiedSession["prState"]): number {
  return state ? STATE_RANK[state] : 1;
}

/* ── Table geometry ──────────────────────────────────────────────────────────
   The row grid and its cells are shared by the header row and every PR row, so
   they live here as finished utility strings rather than being repeated (and
   drifting) at each call site.

   Two responsive steps, and both are ranges rather than a stack of max-*
   variants: ≤1180px drops the Review and Author columns, and ≤720px turns the
   grid into a wrapped card that shows them again. Writing the middle step as
   `desktop:max-[1180px]` keeps it independent of how Tailwind happens to
   order two max-* variants against each other. */
const ROW =
  "grid w-full grid-cols-[92px_minmax(0,1fr)_156px_132px_116px_132px_78px] items-center gap-3.5 border-b border-line px-[22px] text-left max-[1180px]:grid-cols-[88px_minmax(0,1fr)_150px_118px_78px]";

const C_STATE =
  "flex items-center gap-[7px] text-meta font-medium phone:order-1";
const C_TITLE =
  "flex min-w-0 flex-col gap-[3px] phone:order-2 phone:flex-[1_1_calc(100%-90px)]";
const C_CHECKS = "phone:order-3 phone:inline-flex";
const C_CHANGES =
  "phone:order-4 phone:inline-flex phone:flex-row phone:items-center phone:gap-2";
const C_REVIEW = "desktop:max-[1180px]:hidden phone:order-5 phone:inline-flex";
const C_AUTHOR =
  "flex min-w-0 items-center gap-2 desktop:max-[1180px]:hidden phone:order-6 phone:inline-flex";
const C_UPDATED =
  "text-meta whitespace-nowrap text-faint tabular-nums phone:order-7 phone:ml-auto";

/** "—" and other absent values, wherever a cell has nothing to say. */
const DIM = "text-meta text-faint";

/** Ink per PR state — replaces the render-time `rv-state-${key}`. */
const STATE_TONE = {
  open: "text-green",
  draft: "text-dim",
  merged: "text-purple",
  closed: "text-red",
} satisfies Record<StateKind, string>;

const STATE_META = {
  open: { key: "open", label: "Open" },
  draft: { key: "draft", label: "Draft" },
  merged: { key: "merged", label: "Merged" },
  closed: { key: "closed", label: "Closed" },
} satisfies Record<StateKind, { key: StateKind; label: string }>;

type ChecksTone = "pass" | "fail" | "pending";

/** Dot fill and label ink per CI rollup tone — replaces `rv-checks-${tone}`
 *  and `rv-check-dot-${tone}`, both of which were built at render time.
 *  `rv-check-dot-pending` stays on the markup as a bare hook: base.css names it
 *  in the reduced-motion exceptions, so dropping it would freeze the one dot
 *  that means "still running". */
const CHECKS_TONE: Record<ChecksTone, { dot: string; label: string }> = {
  pass: { dot: "bg-green", label: "text-green" },
  fail: { dot: "bg-red", label: "text-red" },
  pending: {
    dot: "bg-yellow rv-check-dot-pending animate-[pulse_1.4s_ease-in-out_infinite]",
    label: "text-yellow",
  },
};

function prNum(s: UnifiedSession): string | null {
  if (s.prNumber) return `#${s.prNumber}`;
  const m = s.prUrl?.match(/\/pull\/(\d+)/);
  return m ? `#${m[1]}` : null;
}

// Sessions name themselves "Review · PR #1234 <real title>". Prefer the real PR
// title when we have it; otherwise strip that bookkeeping prefix so the row
// shows the actual change, not the automation that opened it.
function cleanTitle(s: UnifiedSession): string {
  const t = s.prTitle?.trim();
  if (t) return t;
  return cleanSessionTitle(s.title || "") || s.title;
}

function stateMeta(s: UnifiedSession) {
  const state = s.prState || "OPEN";
  if (state === "MERGED") return STATE_META.merged;
  if (state === "CLOSED") return STATE_META.closed;
  if (s.prIsDraft) return STATE_META.draft;
  return STATE_META.open;
}

function needsReview(s: UnifiedSession): boolean {
  return (
    (s.prState || "OPEN") === "OPEN" &&
    !s.prIsDraft &&
    (s.prReviewDecision || "") !== "APPROVED"
  );
}

/** A GitHub-style icon for a PR's open/merged/closed/draft state. */
function StateIcon({ kind }: { kind: StateKind }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: "0 0 16 16",
    fill: "currentColor" as const,
  };
  if (kind === "merged")
    return (
      <svg {...common} aria-hidden>
        <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 2.122a2.25 2.25 0 1 0-1.5 0v5.256a2.251 2.251 0 1 0 1.5 0V7.5a3.5 3.5 0 0 0 3.5 3.5h1.128a2.251 2.251 0 1 0 0-1.5H8.5A2 2 0 0 1 6.5 7.5v-2.128ZM4.25 12a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5ZM12 9.25a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Z" />
      </svg>
    );
  if (kind === "closed")
    return (
      <svg {...common} aria-hidden>
        <path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.81-1.97 1.97a.75.75 0 1 1-1.06-1.06l1.97-1.97-1.97-1.97a.75.75 0 0 1 1.06-1.06l1.97 1.97 1.97-1.97a.75.75 0 1 1 1.06 1.06l-1.97 1.97 1.97 1.97a.75.75 0 1 1-1.06 1.06l-1.97-1.97ZM2.5 13.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z" />
      </svg>
    );
  // open + draft share the branch glyph
  return (
    <svg {...common} aria-hidden>
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}

/** Compact CI rollup: a tone dot, count, and a thin proportional bar. */
function ChecksCell({ s }: { s: UnifiedSession }) {
  const c = s.prChecks;
  if (!c || c.total === 0) return <span className={DIM}>–</span>;
  const tone: ChecksTone =
    c.failed > 0 ? "fail" : c.pending > 0 ? "pending" : "pass";
  const label =
    tone === "fail"
      ? `${c.failed} failing`
      : tone === "pending"
        ? `${c.pending} running`
        : `${c.passed} passed`;
  const pct = (n: number) => `${(n / c.total) * 100}%`;
  return (
    <span
      className="inline-flex items-center gap-[7px] text-meta"
      title={`${c.passed} passed · ${c.failed} failed · ${c.pending} pending · ${c.total} total`}
    >
      <span
        className={`size-2 shrink-0 rounded-full ${CHECKS_TONE[tone].dot}`}
      />
      <span className={`whitespace-nowrap ${CHECKS_TONE[tone].label}`}>
        {label}
      </span>
      <span
        className="inline-flex h-1 w-[46px] shrink-0 overflow-hidden rounded-full bg-active phone:hidden"
        aria-hidden
      >
        <span className="h-full bg-green" style={{ width: pct(c.passed) }} />
        <span className="h-full bg-red" style={{ width: pct(c.failed) }} />
        <span className="h-full bg-yellow" style={{ width: pct(c.pending) }} />
      </span>
    </span>
  );
}

function ReviewCell({ s }: { s: UnifiedSession }) {
  const d = s.prReviewDecision || "";
  const review = "text-meta font-medium whitespace-nowrap";
  if ((s.prState || "OPEN") !== "OPEN") return <span className={DIM}>–</span>;
  if (d === "APPROVED")
    return <span className={`${review} text-green`}>Approved</span>;
  if (d === "CHANGES_REQUESTED")
    return <span className={`${review} text-yellow`}>Changes</span>;
  if (s.prIsDraft) return <span className={`${review} text-faint`}>Draft</span>;
  return <span className={`${review} text-faint`}>Review required</span>;
}

function ChangesCell({ s }: { s: UnifiedSession }) {
  const add = s.prAdditions ?? 0;
  const del = s.prDeletions ?? 0;
  const files = s.prChangedFiles ?? 0;
  if (!s.prChangedFiles && !add && !del) return <span className={DIM}>–</span>;
  const total = add + del || 1;
  const blocks = 5;
  const greens = Math.max(add > 0 ? 1 : 0, Math.round((add / total) * blocks));
  const reds = Math.max(del > 0 ? 1 : 0, Math.round((del / total) * blocks));
  const grays = Math.max(0, blocks - greens - reds);
  return (
    <span
      className="inline-flex flex-col gap-1"
      title={`${files} file${files === 1 ? "" : "s"} changed`}
    >
      <span className="inline-flex gap-[7px] text-meta tabular-nums">
        <span className="text-green">+{add}</span>
        <span className="text-red">−{del}</span>
      </span>
      <span className="inline-flex gap-0.5" aria-hidden>
        {Array.from({ length: greens }).map((_, i) => (
          <span key={`g${i}`} className="size-2 rounded-xs bg-green" />
        ))}
        {Array.from({ length: reds }).map((_, i) => (
          <span key={`r${i}`} className="size-2 rounded-xs bg-red" />
        ))}
        {Array.from({ length: grays }).map((_, i) => (
          <span key={`n${i}`} className="size-2 rounded-xs bg-line-strong" />
        ))}
      </span>
    </span>
  );
}

export function Reviews({
  sessions,
  selectedId,
  onSelect,
  onOpenSession,
  onOpenPr,
  onAddToInput,
  send,
  addHandler,
}: Props) {
  const [filter, setFilter] = useState<FilterKey>("review");
  const [query, setQuery] = useState("");

  // One row per PR (deduped by URL across the sessions on a branch), newest
  // session wins for metadata.
  const prSessions = (() => {
    const byPr = new Map<string, UnifiedSession>();
    for (const s of sessions) {
      if (!s.prUrl || s.archived) continue;
      const existing = byPr.get(s.prUrl);
      if (
        !existing ||
        new Date(s.lastActivity) > new Date(existing.lastActivity)
      ) {
        byPr.set(s.prUrl, s);
      }
    }
    return [...byPr.values()].sort((a, b) => {
      const r = stateRank(a.prState) - stateRank(b.prState);
      if (r !== 0) return r;
      return (
        new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
      );
    });
  })();

  const counts = (() => {
    const c = {
      review: 0,
      open: 0,
      merged: 0,
      closed: 0,
      all: prSessions.length,
    };
    for (const s of prSessions) {
      const state = s.prState || "OPEN";
      if (state === "OPEN") c.open++;
      else if (state === "MERGED") c.merged++;
      else if (state === "CLOSED") c.closed++;
      if (needsReview(s)) c.review++;
    }
    return c;
  })();

  const filtered = (() => {
    const q = query.trim().toLowerCase();
    return prSessions.filter((s) => {
      const state = s.prState || "OPEN";
      const passesFilter =
        filter === "all"
          ? true
          : filter === "review"
            ? needsReview(s)
            : filter === "open"
              ? state === "OPEN"
              : filter === "merged"
                ? state === "MERGED"
                : state === "CLOSED";
      if (!passesFilter) return false;
      if (!q) return true;
      return (
        cleanTitle(s).toLowerCase().includes(q) ||
        (s.branch || "").toLowerCase().includes(q) ||
        (prNum(s) || "").toLowerCase().includes(q) ||
        (s.prAuthor || "").toLowerCase().includes(q)
      );
    });
  })();

  const selected =
    (selectedId && filtered.find((s) => s.id === selectedId)) ||
    (selectedId && prSessions.find((s) => s.id === selectedId)) ||
    null;

  // Escape backs out of the detail drawer (unless typing in a field).
  const hasSelection = !!selected;
  useEffect(() => {
    if (!hasSelection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      onSelect("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasSelection, onSelect]);

  // Only label rows with their repo when the list actually spans repos.
  const multiRepo =
    new Set(prSessions.map((s) => s.repo || "repository")).size > 1;

  const TABS: Array<{ key: FilterKey; label: string; count: number }> = [
    { key: "review", label: "Needs review", count: counts.review },
    { key: "open", label: "Open", count: counts.open },
    { key: "merged", label: "Merged", count: counts.merged },
    { key: "closed", label: "Closed", count: counts.closed },
    { key: "all", label: "All", count: counts.all },
  ];

  // Sidebar queue rows deep-link here with a selected session. Give the review
  // the whole main canvas: the PR info rail and diff already scroll
  // independently inside PrPanel, so retaining the old table rail only made
  // the code review cramped and duplicated the queue that remains visible in
  // the app sidebar.
  if (selected) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-surface">
        <div className="hidden shrink-0 items-center border-b border-divider px-3 py-2 phone:flex">
          <button
            className="inline-flex items-center gap-1.5 rounded-control border-0 bg-transparent px-2 py-1.5 text-sm font-medium text-fg hover:bg-hover"
            onClick={() => onSelect("")}
          >
            <svg
              width="17"
              height="17"
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden
            >
              <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.749.749 0 1 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z" />
            </svg>
            Pull requests
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <PrPanel
            onOpenPr={onOpenPr}
            key={selected.id}
            sessionId={selected.id}
            onOpenSession={() => onOpenSession(selected.id)}
            onAddToInput={(text) => onAddToInput(selected.id, text)}
            send={send}
            addHandler={addHandler}
            sessions={sessions}
            walkthrough={selected.walkthrough}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto phone:overflow-x-hidden">
        <div className="sticky top-0 z-[3] bg-surface px-[22px] pt-4">
          <div className="mb-3 flex items-center justify-between gap-4">
            <h1 className="m-0 text-section-title font-title tracking-[-0.01em]">
              Reviews
            </h1>
            <div className="flex w-60 items-center gap-[7px] rounded-md border border-line bg-raised px-2.5 py-1.5 text-faint transition-[border-color,background-color] focus-within:border-line-strong focus-within:bg-panel">
              <svg
                width="19"
                height="19"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden
              >
                <path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z" />
              </svg>
              <input
                className="min-w-0 flex-1 border-0 bg-transparent text-label text-fg outline-none placeholder:text-faint"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search pull requests…"
                spellCheck={false}
              />
            </div>
          </div>
          {/* Full-bleed hairline under the tab strip; the active tab's -1px
              underline sits on top of it. The negative margin cancels the
              header's 22px padding. Five tabs + counts don't fit a phone, so
              below 720px the strip scrolls edge to edge instead. */}
          <div className="-mx-[22px] flex gap-0.5 border-b border-divider px-[22px] phone:overflow-x-auto phone:[scrollbar-width:none] phone:[&::-webkit-scrollbar]:hidden">
            {TABS.map((t) => {
              const on = filter === t.key;
              return (
                <button
                  key={t.key}
                  className={`-mb-px flex items-center gap-[7px] border-b-2 px-[13px] pt-2 pb-[11px] text-label font-medium transition-colors phone:shrink-0 phone:px-3.5 phone:pt-[11px] phone:pb-[13px] phone:text-item-title phone:whitespace-nowrap ${
                    on
                      ? "border-b-accent text-fg"
                      : "border-b-transparent text-dim hover:text-fg"
                  }`}
                  onClick={() => setFilter(t.key)}
                >
                  {t.label}
                  <span
                    className={`min-w-5 rounded-full px-[7px] py-px text-center text-meta font-semibold ${
                      on ? "bg-accent-soft text-accent" : "bg-active text-dim"
                    }`}
                  >
                    {t.count}
                  </span>
                </button>
              );
            })}
          </div>
          {/* The header row lives inside the sticky header, so it pins with it
              as one block. Negative side margins cancel the 22px padding so its
              divider spans the full width. */}
          {filtered.length > 0 && (
            <div
              className={`${ROW} -mx-[22px] bg-surface py-[9px] text-meta font-semibold tracking-[-0.01em] text-faint phone:hidden`}
              role="row"
            >
              <span className={C_STATE}>Status</span>
              <span className={C_TITLE}>Pull request</span>
              <span className={C_CHECKS}>Checks</span>
              <span className={C_REVIEW}>Review</span>
              <span className={C_CHANGES}>Changes</span>
              <span className={C_AUTHOR}>Author</span>
              <span className={C_UPDATED}>Updated</span>
            </div>
          )}
        </div>

        {filtered.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              title={
                prSessions.length === 0
                  ? "No pull requests yet"
                  : "Nothing here"
              }
            >
              {prSessions.length === 0
                ? `Pull requests opened by ${AGENT_NAME} sessions show up here.`
                : filter === "review"
                  ? "All caught up. Nothing needs review."
                  : "No pull requests match this filter."}
            </EmptyState>
          </div>
        ) : (
          <div className="flex flex-col" role="table">
            {filtered.map((s) => {
              const meta = stateMeta(s);
              return (
                <button
                  key={s.prUrl}
                  className={`${ROW} group cursor-pointer py-[11px] text-item-title text-fg hover:bg-hover phone:flex phone:flex-wrap phone:items-center phone:gap-x-3 phone:gap-y-[9px] phone:px-4 phone:py-3.5`}
                  onClick={() => onSelect(s.id)}
                  role="row"
                >
                  <span
                    className={`${C_STATE} ${STATE_TONE[meta.key]}`}
                    role="cell"
                  >
                    <StateIcon kind={meta.key} />
                    <span className="whitespace-nowrap">{meta.label}</span>
                  </span>
                  <span className={C_TITLE} role="cell">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate text-item-title leading-[1.3] font-medium">
                        {cleanTitle(s)}
                      </span>
                      {prNum(s) && (
                        <span className="shrink-0 text-meta text-faint tabular-nums">
                          {prNum(s)}
                        </span>
                      )}
                      {s.prUrl && (
                        <span
                          className="inline-flex shrink-0 items-center self-center rounded-sm p-0.5 text-faint opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-link"
                          title={`Open on ${providerFromUrl(s.prUrl).name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            window.open(s.prUrl, "_blank", "noopener");
                          }}
                        >
                          <svg
                            width="18"
                            height="18"
                            viewBox="0 0 16 16"
                            fill="currentColor"
                            aria-hidden
                          >
                            <path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.06-1.06l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z" />
                          </svg>
                        </span>
                      )}
                    </span>
                    <span className="flex min-w-0 items-center gap-3 text-meta text-faint">
                      {multiRepo && (
                        <Badge>
                          {s.repo ? repoLabel(s.repo) : "repository"}
                        </Badge>
                      )}
                      {s.branch && (
                        <span className="inline-flex min-w-0 max-w-full items-center gap-1 overflow-hidden text-meta text-dim [&>svg]:shrink-0 [&>svg]:opacity-70">
                          <svg
                            width="17"
                            height="17"
                            viewBox="0 0 16 16"
                            fill="currentColor"
                            aria-hidden
                          >
                            <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
                          </svg>
                          <span className="truncate">{s.branch}</span>
                        </span>
                      )}
                      {s.linearIssue && (
                        <Badge className="tracking-[0.02em]">
                          {s.linearIssue.identifier}
                        </Badge>
                      )}
                      {s.isRunning && (
                        <span className="shrink-0 text-meta text-yellow">
                          ● running
                        </span>
                      )}
                    </span>
                  </span>
                  <span className={C_CHECKS} role="cell">
                    <ChecksCell s={s} />
                  </span>
                  <span className={C_REVIEW} role="cell">
                    <ReviewCell s={s} />
                  </span>
                  <span className={C_CHANGES} role="cell">
                    <ChangesCell s={s} />
                  </span>
                  <span className={C_AUTHOR} role="cell">
                    {s.prAuthor ? (
                      <>
                        {(() => {
                          // Hosts without user avatars (code.storage) fall back
                          // to an initial instead of a broken <img src="">.
                          const src = avatarUrl(
                            s.prAuthor,
                            providerFromUrl(s.prUrl),
                            40,
                          );
                          return src ? (
                            <img
                              className="size-[22px] shrink-0 rounded-avatar bg-active"
                              src={src}
                              alt=""
                              loading="lazy"
                            />
                          ) : (
                            <span
                              className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-avatar bg-active text-meta font-semibold text-faint"
                              aria-hidden
                            >
                              {s.prAuthor.charAt(0).toUpperCase()}
                            </span>
                          );
                        })()}
                        <span className="truncate text-meta text-dim">
                          {s.prAuthor}
                        </span>
                      </>
                    ) : (
                      <span className={DIM}>–</span>
                    )}
                  </span>
                  <span className={C_UPDATED} role="cell">
                    {relativeTime(s.prUpdatedAt || s.lastActivity)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
