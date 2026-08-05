import { repoLabel } from "../lib/repo-label";
import { AGENT_NAME } from "../lib/brand";
import React, { useEffect, useMemo, useState } from "react";
import type { UnifiedSession, WSServerMessage } from "../lib/types";
import { relativeTime } from "../lib/api";
import { PrPanel } from "./PrPanel";
import { providerFromUrl, avatarUrl } from "../lib/provider";

interface Props {
  sessions: UnifiedSession[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenSession: (id: string) => void;
  /** Open another PR in the review panel (stack map layer links). */
  onOpenPr?: (repo: string, branch: string) => void;
  onAddToInput: (id: string, text: string) => void;
  send?: (msg: any) => void;
  addHandler?: (handler: (msg: WSServerMessage) => void) => () => void;
}

type FilterKey = "review" | "open" | "merged" | "closed" | "all";

const STATE_RANK: Record<string, number> = { OPEN: 0, CLOSED: 1, MERGED: 2 };

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
  return (
    (s.title || "")
      .replace(/^(Review|Auto-fix|Mention|Simplify|Fix)\s*·\s*PR\s*#\d+\s*/i, "")
      .trim() || s.title
  );
}

function stateMeta(s: UnifiedSession): { key: string; label: string } {
  const state = s.prState || "OPEN";
  if (state === "MERGED") return { key: "merged", label: "Merged" };
  if (state === "CLOSED") return { key: "closed", label: "Closed" };
  if (s.prIsDraft) return { key: "draft", label: "Draft" };
  return { key: "open", label: "Open" };
}

function needsReview(s: UnifiedSession): boolean {
  return (
    (s.prState || "OPEN") === "OPEN" &&
    !s.prIsDraft &&
    (s.prReviewDecision || "") !== "APPROVED"
  );
}

/** A GitHub-style icon for a PR's open/merged/closed/draft state. */
function StateIcon({ kind }: { kind: string }) {
  const common = { width: 15, height: 15, viewBox: "0 0 16 16", fill: "currentColor" as const };
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
  if (!c || c.total === 0)
    return <span className="rv-checks rv-checks-empty inline-flex items-center gap-2 text-supporting text-faint">—</span>;
  const tone = c.failed > 0 ? "fail" : c.pending > 0 ? "pending" : "pass";
  const label =
    tone === "fail"
      ? `${c.failed} failing`
      : tone === "pending"
        ? `${c.pending} running`
        : `${c.passed} passed`;
  const pct = (n: number) => `${(n / c.total) * 100}%`;
  return (
    <span className={`rv-checks rv-checks-${tone} inline-flex items-center gap-2 text-supporting`} title={`${c.passed} passed · ${c.failed} failed · ${c.pending} pending · ${c.total} total`}>
      <span className={`rv-check-dot rv-check-dot-${tone} size-2 shrink-0 rounded-full ${tone === "pass" ? "bg-green" : tone === "fail" ? "bg-red" : "animate-[rv-pulse_1.4s_ease-in-out_infinite] bg-[#d9a23a]"}`} />
      <span className={`rv-checks-label whitespace-nowrap ${tone === "pass" ? "text-green" : tone === "fail" ? "text-red" : "text-[#d9a23a]"}`}>{label}</span>
      <span className="rv-checks-bar inline-flex h-1 w-[46px] shrink-0 overflow-hidden rounded-full bg-active" aria-hidden>
        <span className="rv-bar-seg rv-bar-pass h-full bg-green" style={{ width: pct(c.passed) }} />
        <span className="rv-bar-seg rv-bar-fail h-full bg-red" style={{ width: pct(c.failed) }} />
        <span className="rv-bar-seg rv-bar-pending h-full bg-[#d9a23a]" style={{ width: pct(c.pending) }} />
      </span>
    </span>
  );
}

function ReviewCell({ s }: { s: UnifiedSession }) {
  const d = s.prReviewDecision || "";
  if ((s.prState || "OPEN") !== "OPEN") return <span className="rv-dim text-supporting text-faint">—</span>;
  if (d === "APPROVED")
    return <span className="rv-review rv-review-approved">Approved</span>;
  if (d === "CHANGES_REQUESTED")
    return <span className="rv-review rv-review-changes">Changes</span>;
  if (s.prIsDraft) return <span className="rv-review rv-review-pending">Draft</span>;
  return <span className="rv-review rv-review-pending">Review required</span>;
}

function ChangesCell({ s }: { s: UnifiedSession }) {
  const add = s.prAdditions ?? 0;
  const del = s.prDeletions ?? 0;
  const files = s.prChangedFiles ?? 0;
  if (!s.prChangedFiles && !add && !del) return <span className="rv-dim">—</span>;
  const total = add + del || 1;
  const blocks = 5;
  const greens = Math.max(add > 0 ? 1 : 0, Math.round((add / total) * blocks));
  const reds = Math.max(del > 0 ? 1 : 0, Math.round((del / total) * blocks));
  const grays = Math.max(0, blocks - greens - reds);
  return (
    <span className="rv-changes inline-flex flex-col gap-1" title={`${files} file${files === 1 ? "" : "s"} changed`}>
      <span className="rv-diffstat inline-flex gap-2 font-mono text-label tabular-nums">
        <span className="rv-add text-green">+{add}</span>
        <span className="rv-del text-red">−{del}</span>
      </span>
      <span className="rv-diffsquares inline-flex gap-0.5" aria-hidden>
        {Array.from({ length: greens }).map((_, i) => (
          <span key={`g${i}`} className="rv-sq rv-sq-add size-2 rounded-xs bg-green" />
        ))}
        {Array.from({ length: reds }).map((_, i) => (
          <span key={`r${i}`} className="rv-sq rv-sq-del size-2 rounded-xs bg-red" />
        ))}
        {Array.from({ length: grays }).map((_, i) => (
          <span key={`n${i}`} className="rv-sq rv-sq-none size-2 rounded-xs bg-line-strong" />
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
  const prSessions = useMemo(() => {
    const byPr = new Map<string, UnifiedSession>();
    for (const s of sessions) {
      if (!s.prUrl || s.archived) continue;
      const existing = byPr.get(s.prUrl);
      if (!existing || new Date(s.lastActivity) > new Date(existing.lastActivity)) {
        byPr.set(s.prUrl, s);
      }
    }
    return [...byPr.values()].sort((a, b) => {
      const r = (STATE_RANK[a.prState || ""] ?? 1) - (STATE_RANK[b.prState || ""] ?? 1);
      if (r !== 0) return r;
      return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
    });
  }, [sessions]);

  const counts = useMemo(() => {
    const c = { review: 0, open: 0, merged: 0, closed: 0, all: prSessions.length };
    for (const s of prSessions) {
      const state = s.prState || "OPEN";
      if (state === "OPEN") c.open++;
      else if (state === "MERGED") c.merged++;
      else if (state === "CLOSED") c.closed++;
      if (needsReview(s)) c.review++;
    }
    return c;
  }, [prSessions]);

  const filtered = useMemo(() => {
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
  }, [prSessions, filter, query]);

  const selected =
    (selectedId && filtered.find((s) => s.id === selectedId)) ||
    (selectedId && prSessions.find((s) => s.id === selectedId)) ||
    null;

  // Escape backs out of the detail drawer (unless typing in a field).
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      onSelect("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [!!selected, onSelect]);

  // Only label rows with their repo when the list actually spans repos.
  const multiRepo = useMemo(
    () => new Set(prSessions.map((s) => s.repo || "repository")).size > 1,
    [prSessions],
  );

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
        <div className="hidden shrink-0 items-center border-b border-line px-3 py-2 max-[720px]:flex">
          <button
            className="inline-flex items-center gap-1.5 rounded-sm border-0 bg-transparent px-2 py-1.5 text-control-label font-medium text-fg hover:bg-hover"
            onClick={() => onSelect("")}
          >
            <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
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
            split
            reviewCanvas
            send={send}
            addHandler={addHandler}
            sessions={sessions}
            onOpenSessionById={onOpenSession}
            walkthrough={selected.walkthrough}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="reviews relative flex min-h-0 flex-1">
      <div className="reviews-main flex min-w-0 flex-1 flex-col overflow-y-auto max-[720px]:overflow-x-hidden">
        <div className="reviews-header sticky top-0 z-[3] bg-surface px-[22px] pt-4">
          <div className="reviews-header-top mb-3 flex items-center justify-between gap-4">
            <h1 className="reviews-title m-0 text-section-title font-semibold tracking-[-0.01em]">Reviews</h1>
            <div className="reviews-search flex w-60 items-center gap-2 rounded-sm border border-line bg-raised px-2.5 py-1.5 text-faint transition-[border-color,background] duration-100 focus-within:border-line-strong focus-within:bg-panel">
              <svg width="19" height="19" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z" />
              </svg>
              <input className="min-w-0 flex-1 border-0 bg-transparent text-control-label text-fg outline-none placeholder:text-faint"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search pull requests…"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="reviews-tabs -mx-[22px] flex gap-0.5 overflow-x-auto border-b border-line px-[22px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={`reviews-tab mb-[-1px] flex shrink-0 items-center gap-2 whitespace-nowrap border-0 border-b-2 border-transparent bg-transparent px-3 py-2 pb-2.5 text-control-label font-medium text-dim transition-colors hover:text-fg ${filter === t.key ? "active border-accent text-fg" : ""}`}
                onClick={() => setFilter(t.key)}
              >
                {t.label}
                <span className={`reviews-tab-count min-w-5 rounded-full bg-active px-1.5 py-px text-center text-meta font-semibold text-dim ${filter === t.key ? "bg-accent-soft text-accent" : ""}`}>{t.count}</span>
              </button>
            ))}
          </div>
          {filtered.length > 0 && (
            <div className="reviews-row reviews-row-head -mx-[22px] grid grid-cols-[92px_minmax(0,1fr)_156px_132px_116px_132px_78px] items-center gap-3.5 border-b border-line bg-surface px-[22px] py-2 text-meta font-semibold tracking-[-0.01em] text-faint max-[1180px]:grid-cols-[88px_minmax(0,1fr)_150px_118px_78px] max-[720px]:hidden" role="row">
              <span className="rv-c-state">Status</span>
              <span className="rv-c-title">Pull request</span>
              <span className="rv-c-checks">Checks</span>
              <span className="rv-c-review">Review</span>
              <span className="rv-c-changes">Changes</span>
              <span className="rv-c-author">Author</span>
              <span className="rv-c-updated">Updated</span>
            </div>
          )}
        </div>

        {filtered.length === 0 ? (
          <div className="reviews-empty flex flex-1 items-center justify-center">
            <div className="detail-empty-inner">
              <div className="detail-empty-title">
                {prSessions.length === 0 ? "No pull requests yet" : "Nothing here"}
              </div>
              <div className="detail-empty-sub">
                {prSessions.length === 0
                  ? `Pull requests opened by ${AGENT_NAME} sessions show up here.`
                  : filter === "review"
                    ? "All caught up. Nothing needs review."
                    : "No pull requests match this filter."}
              </div>
            </div>
          </div>
        ) : (
          <div className="reviews-table flex flex-col" role="table">
            {filtered.map((s) => {
              const meta = stateMeta(s);
              return (
                <button
                  key={s.prUrl}
                  className="reviews-row group grid w-full grid-cols-[92px_minmax(0,1fr)_156px_132px_116px_132px_78px] items-center gap-3.5 border-0 border-b border-line bg-transparent px-[22px] py-2.5 text-left text-fg hover:bg-hover max-[1180px]:grid-cols-[88px_minmax(0,1fr)_150px_118px_78px] max-[1180px]:[&_.rv-c-review]:hidden max-[1180px]:[&_.rv-c-author]:hidden max-[720px]:flex max-[720px]:flex-wrap max-[720px]:gap-x-3 max-[720px]:gap-y-2 max-[720px]:px-4 max-[720px]:py-3.5"
                  onClick={() => onSelect(s.id)}
                  role="row"
                >
                  <span className={`rv-c-state rv-state-${meta.key} flex items-center gap-2 text-supporting font-medium ${meta.key === "open" ? "text-green" : meta.key === "draft" ? "text-dim" : meta.key === "merged" ? "text-purple" : "text-red"} max-[720px]:order-1`} role="cell">
                    <StateIcon kind={meta.key} />
                    <span className="rv-state-label">{meta.label}</span>
                  </span>
                  <span className="rv-c-title flex min-w-0 flex-col gap-0.5 max-[720px]:order-2 max-[720px]:min-w-0 max-[720px]:flex-[1_1_calc(100%-90px)]" role="cell">
                    <span className="rv-title-line flex min-w-0 items-baseline gap-2">
                      <span className="rv-title-text overflow-hidden text-ellipsis whitespace-nowrap text-body font-medium leading-[1.3]">{cleanTitle(s)}</span>
                      {prNum(s) && <span className="rv-num shrink-0 text-supporting tabular-nums text-faint">{prNum(s)}</span>}
                      {s.prUrl && (
                        <span
                          className="rv-open-gh inline-flex shrink-0 items-center self-center rounded-xs p-0.5 text-faint opacity-0 transition-opacity hover:text-accent group-hover:opacity-100 focus-visible:opacity-100"
                          title={`Open on ${providerFromUrl(s.prUrl).name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            window.open(s.prUrl, "_blank", "noopener");
                          }}
                        >
                          <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                            <path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.06-1.06l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z" />
                          </svg>
                        </span>
                      )}
                    </span>
                    <span className="rv-sub-line flex min-w-0 items-center gap-3 text-label text-faint">
                      {multiRepo && (
                        <span className="rv-repo shrink-0 rounded-sm bg-active px-1.5 py-px font-mono text-meta font-semibold text-dim">{s.repo ? repoLabel(s.repo) : "repository"}</span>
                      )}
                      {s.branch && (
                        <span className="rv-branch inline-flex min-w-0 max-w-full items-center gap-1 overflow-hidden font-mono text-meta text-dim [&_svg]:shrink-0 [&_svg]:opacity-70">
                          <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                            <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
                          </svg>
                          <span className="rv-branch-name">{s.branch}</span>
                        </span>
                      )}
                      {s.linearIssue && (
                        <span className="rv-linear shrink-0 rounded-sm bg-active px-1.5 py-px text-meta font-semibold tracking-[0.02em] text-dim">{s.linearIssue.identifier}</span>
                      )}
                      {s.isRunning && <span className="rv-running">● running</span>}
                    </span>
                  </span>
                  <span className="rv-c-checks max-[720px]:order-3 max-[720px]:inline-flex" role="cell">
                    <ChecksCell s={s} />
                  </span>
                  <span className="rv-c-review max-[720px]:order-5 max-[720px]:inline-flex" role="cell">
                    <ReviewCell s={s} />
                  </span>
                  <span className="rv-c-changes max-[720px]:order-4 max-[720px]:inline-flex max-[720px]:flex-row max-[720px]:items-center max-[720px]:gap-2" role="cell">
                    <ChangesCell s={s} />
                  </span>
                  <span className="rv-c-author flex min-w-0 items-center gap-2 max-[720px]:order-6 max-[720px]:inline-flex" role="cell">
                    {s.prAuthor ? (
                      <>
                        <img
                          className="rv-avatar size-[22px] shrink-0 rounded-[32%] bg-active"
                          src={avatarUrl(s.prAuthor, providerFromUrl(s.prUrl), 40) || ""}
                          alt=""
                          loading="lazy"
                        />
                        <span className="rv-author-name overflow-hidden text-ellipsis whitespace-nowrap text-supporting text-dim">{s.prAuthor}</span>
                      </>
                    ) : (
                      <span className="rv-dim">—</span>
                    )}
                  </span>
                  <span className="rv-c-updated whitespace-nowrap text-supporting tabular-nums text-faint max-[720px]:order-7 max-[720px]:ml-auto" role="cell">
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
