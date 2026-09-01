import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
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
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  inlineFlex: {
    display: "inline-flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap7px: {
    gap: "7px",
  },
  h1: {
    height: "4px",
  },
  w46px: {
    width: "46px",
  },
  shrink0: {
    flexShrink: "0",
  },
  overflowHidden: {
    overflow: "hidden",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  bgActive: {
    backgroundColor: "var(--bg-active)",
  },
  phoneHidden: {
    "@media (max-width: 720px)": {
      display: "none",
    },
  },
  hFull: {
    height: "100%",
  },
  bgGreen: {
    backgroundColor: "var(--green)",
  },
  bgRed: {
    backgroundColor: "var(--red)",
  },
  bgYellow: {
    backgroundColor: "var(--yellow)",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap1: {
    gap: "4px",
  },
  textGreen: {
    color: "var(--green)",
  },
  textRed: {
    color: "var(--red)",
  },
  gap05: {
    gap: "calc(4px * 0.5)",
  },
  size2: {
    width: "calc(4px * 2)",
    height: "calc(4px * 2)",
  },
  roundedXs: {
    borderRadius: "calc(2px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgLineStrong: {
    backgroundColor: "var(--border-strong)",
  },
  flex: {
    display: "flex",
  },
  minH0: {
    minHeight: "0",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },
  hidden: {
    display: "none",
  },
  borderB: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  borderDivider: {
    borderColor: "var(--divider)",
  },
  px3: {
    paddingInline: "calc(4px * 3)",
  },
  py2: {
    paddingBlock: "calc(4px * 2)",
  },
  phoneFlex: {
    "@media (max-width: 720px)": {
      display: "flex",
    },
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  roundedControl: {
    borderRadius: "calc(12px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border0: {
    borderStyle: "solid",
    borderWidth: "0px",
  },
  bgTransparent: {
    backgroundColor: "transparent",
  },
  px2: {
    paddingInline: "calc(4px * 2)",
  },
  py15: {
    paddingBlock: "calc(4px * 1.5)",
  },
  textSm: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-sm--line-height))",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textFg: {
    color: "var(--text)",
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
  flex1: {
    flex: "1",
  },
  relative: {
    position: "relative",
  },
  minW0: {
    minWidth: "0",
  },
  overflowYAuto: {
    overflowY: "auto",
  },
  phoneOverflowXHidden: {
    "@media (max-width: 720px)": {
      overflowX: "hidden",
    },
  },
  sticky: {
    position: "sticky",
  },
  top0: {
    top: "0",
  },
  z3: {
    zIndex: "3",
  },
  px22px: {
    paddingInline: "22px",
  },
  pt4: {
    paddingTop: "calc(4px * 4)",
  },
  mb3: {
    marginBottom: "calc(4px * 3)",
  },
  justifyBetween: {
    justifyContent: "space-between",
  },
  gap4: {
    gap: "calc(4px * 4)",
  },
  m0: {
    margin: "0",
  },
  fontTitle: {
    fontWeight: "var(--title-weight)",
  },
  tracking001em: {
    letterSpacing: "-0.01em",
  },
  w60: {
    width: "calc(4px * 60)",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  bgRaised: {
    backgroundColor: "var(--bg-raised)",
  },
  px25: {
    paddingInline: "calc(4px * 2.5)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  transitionBorderColorBackgroundColor: {
    transitionProperty: "border-color,background-color",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  focusWithinBorderLineStrong: {
    ":focus-within": {
      borderColor: "var(--border-strong)",
    },
  },
  focusWithinBgPanel: {
    ":focus-within": {
      backgroundColor: "var(--bg-panel)",
    },
  },
  outlineNone: {
    outlineStyle: "none",
  },
  placeholderTextFaint: {
    "::placeholder": {
      color: "var(--text-faint)",
    },
  },
  Mx22px: {
    marginInline: "calc(22px * -1)",
  },
  phoneOverflowXAuto: {
    "@media (max-width: 720px)": {
      overflowX: "auto",
    },
  },
  phoneScrollbarWidthNone: {
    "@media (max-width: 720px)": {
      scrollbarWidth: "none",
    },
  },
  justifyCenter: {
    justifyContent: "center",
  },
  whitespaceNowrap: {
    whiteSpace: "nowrap",
  },
  itemsBaseline: {
    alignItems: "baseline",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  leading13: {
    lineHeight: "1.3",
  },
  selfCenter: {
    alignSelf: "center",
  },
  roundedSm: {
    borderRadius: "calc(4px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  p05: {
    padding: "calc(4px * 0.5)",
  },
  opacity0: {
    opacity: "0%",
  },
  transitionOpacity: {
    transitionProperty: "opacity",
    transitionTimingFunction: "var(--tw-ease, var(--ease))",
    transitionDuration: "var(--tw-duration, var(--dur-micro))",
  },
  focusVisibleOpacity100: {
    ":focus-visible": {
      opacity: "100%",
    },
  },
  hoverTextLink: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--link)",
      },
    },
  },
  gap3: {
    gap: "calc(4px * 3)",
  },
  maxWFull: {
    maxWidth: "100%",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  tracking002em: {
    letterSpacing: "0.02em",
  },
  textYellow: {
    color: "var(--yellow)",
  },
  size22px: {
    width: "22px",
    height: "22px",
  },
  roundedAvatar: {
    borderRadius: "calc(32% * var(--rp))",
    cornerShape: "var(--cs)",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
});

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

const STATE_RANK: Record<string, number> = { OPEN: 0, CLOSED: 1, MERGED: 2 };

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

const C_STATE = utilityClassName(
  "flex items-center gap-[7px] text-meta font-medium phone:order-1",
);
const C_TITLE = utilityClassName(
  "flex min-w-0 flex-col gap-[3px] phone:order-2 phone:flex-[1_1_calc(100%-90px)]",
);
const C_CHECKS = utilityClassName("phone:order-3 phone:inline-flex");
const C_CHANGES = utilityClassName(
  "phone:order-4 phone:inline-flex phone:flex-row phone:items-center phone:gap-2",
);
const C_REVIEW = utilityClassName(
  "desktop:max-[1180px]:hidden phone:order-5 phone:inline-flex",
);
const C_AUTHOR = utilityClassName(
  "flex min-w-0 items-center gap-2 desktop:max-[1180px]:hidden phone:order-6 phone:inline-flex",
);
const C_UPDATED = utilityClassName(
  "text-meta whitespace-nowrap text-faint tabular-nums phone:order-7 phone:ml-auto",
);

/** "—" and other absent values, wherever a cell has nothing to say. */
const DIM = utilityClassName("text-meta text-faint");

/** Ink per PR state — replaces the render-time `rv-state-${key}`. */
const STATE_TONE: Record<string, string> = {
  open: "text-green",
  draft: "text-dim",
  merged: "text-purple",
  closed: "text-red",
};

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
      {...stylex.props(
        sx.inlineFlex,
        sx.itemsCenter,
        sx.gap7px,
        typography.meta,
      )}
      title={`${c.passed} passed · ${c.failed} failed · ${c.pending} pending · ${c.total} total`}
    >
      <span
        className={utilityClassName(
          `size-2 shrink-0 rounded-full ${CHECKS_TONE[tone].dot}`,
        )}
      />
      <span
        className={utilityClassName(
          `whitespace-nowrap ${CHECKS_TONE[tone].label}`,
        )}
      >
        {label}
      </span>
      <span
        {...stylex.props(
          sx.inlineFlex,
          sx.h1,
          sx.w46px,
          sx.shrink0,
          sx.overflowHidden,
          sx.roundedFull,
          sx.bgActive,
          sx.phoneHidden,
        )}
        aria-hidden
      >
        <span
          {...stylex.props(sx.hFull, sx.bgGreen)}
          style={{ width: pct(c.passed) }}
        />
        <span
          {...stylex.props(sx.hFull, sx.bgRed)}
          style={{ width: pct(c.failed) }}
        />
        <span
          {...stylex.props(sx.hFull, sx.bgYellow)}
          style={{ width: pct(c.pending) }}
        />
      </span>
    </span>
  );
}

function ReviewCell({ s }: { s: UnifiedSession }) {
  const d = s.prReviewDecision || "";
  const review = "text-meta font-medium whitespace-nowrap";
  if ((s.prState || "OPEN") !== "OPEN") return <span className={DIM}>–</span>;
  if (d === "APPROVED")
    return (
      <span className={utilityClassName(`${review} text-green`)}>Approved</span>
    );
  if (d === "CHANGES_REQUESTED")
    return (
      <span className={utilityClassName(`${review} text-yellow`)}>Changes</span>
    );
  if (s.prIsDraft)
    return (
      <span className={utilityClassName(`${review} text-faint`)}>Draft</span>
    );
  return (
    <span className={utilityClassName(`${review} text-faint`)}>
      Review required
    </span>
  );
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
      {...stylex.props(sx.inlineFlex, sx.flexCol, sx.gap1)}
      title={`${files} file${files === 1 ? "" : "s"} changed`}
    >
      <span
        {...mergeStylexProps(
          "tabular-nums",
          sx.inlineFlex,
          sx.gap7px,
          typography.meta,
        )}
      >
        <span {...stylex.props(sx.textGreen)}>+{add}</span>
        <span {...stylex.props(sx.textRed)}>−{del}</span>
      </span>
      <span {...stylex.props(sx.inlineFlex, sx.gap05)} aria-hidden>
        {Array.from({ length: greens }).map((_, i) => (
          <span
            key={`g${i}`}
            {...stylex.props(sx.size2, sx.roundedXs, sx.bgGreen)}
          />
        ))}
        {Array.from({ length: reds }).map((_, i) => (
          <span
            key={`r${i}`}
            {...stylex.props(sx.size2, sx.roundedXs, sx.bgRed)}
          />
        ))}
        {Array.from({ length: grays }).map((_, i) => (
          <span
            key={`n${i}`}
            {...stylex.props(sx.size2, sx.roundedXs, sx.bgLineStrong)}
          />
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
      const r =
        (STATE_RANK[a.prState || ""] ?? 1) - (STATE_RANK[b.prState || ""] ?? 1);
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
      const t = e.target as HTMLElement | null;
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
      <div
        {...stylex.props(sx.flex, sx.hFull, sx.minH0, sx.flexCol, sx.bgSurface)}
      >
        <div
          {...stylex.props(
            sx.hidden,
            sx.shrink0,
            sx.itemsCenter,
            sx.borderB,
            sx.borderDivider,
            sx.px3,
            sx.py2,
            sx.phoneFlex,
          )}
        >
          <button
            {...stylex.props(
              sx.inlineFlex,
              sx.itemsCenter,
              sx.gap15,
              sx.roundedControl,
              sx.border0,
              sx.bgTransparent,
              sx.px2,
              sx.py15,
              sx.textSm,
              sx.fontMedium,
              sx.textFg,
              sx.hoverBgHover,
            )}
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
        <div {...stylex.props(sx.minH0, sx.flex1)}>
          <PrPanel
            onOpenPr={onOpenPr}
            key={selected.id}
            sessionId={selected.id}
            onOpenSession={() => onOpenSession(selected.id)}
            onAddToInput={(text) => onAddToInput(selected.id, text)}
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
    <div {...stylex.props(sx.relative, sx.flex, sx.minH0, sx.flex1)}>
      <div
        {...stylex.props(
          sx.flex,
          sx.minW0,
          sx.flex1,
          sx.flexCol,
          sx.overflowYAuto,
          sx.phoneOverflowXHidden,
        )}
      >
        <div
          {...stylex.props(
            sx.sticky,
            sx.top0,
            sx.z3,
            sx.bgSurface,
            sx.px22px,
            sx.pt4,
          )}
        >
          <div
            {...stylex.props(
              sx.mb3,
              sx.flex,
              sx.itemsCenter,
              sx.justifyBetween,
              sx.gap4,
            )}
          >
            <h1
              {...stylex.props(
                sx.m0,
                sx.fontTitle,
                sx.tracking001em,
                typography.sectionTitle,
              )}
            >
              Reviews
            </h1>
            <div
              {...stylex.props(
                sx.flex,
                sx.w60,
                sx.itemsCenter,
                sx.gap7px,
                sx.roundedMd,
                sx.border,
                sx.borderLine,
                sx.bgRaised,
                sx.px25,
                sx.py15,
                sx.textFaint,
                sx.transitionBorderColorBackgroundColor,
                sx.focusWithinBorderLineStrong,
                sx.focusWithinBgPanel,
              )}
            >
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
                {...stylex.props(
                  sx.minW0,
                  sx.flex1,
                  sx.border0,
                  sx.bgTransparent,
                  sx.textFg,
                  sx.outlineNone,
                  sx.placeholderTextFaint,
                  typography.label,
                )}
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
          <div
            {...mergeStylexProps(
              "phone:[&::-webkit-scrollbar]:hidden",
              sx.Mx22px,
              sx.flex,
              sx.gap05,
              sx.borderB,
              sx.borderDivider,
              sx.px22px,
              sx.phoneOverflowXAuto,
              sx.phoneScrollbarWidthNone,
            )}
          >
            {TABS.map((t) => {
              const on = filter === t.key;
              return (
                <button
                  key={t.key}
                  className={utilityClassName(
                    `-mb-px flex items-center gap-[7px] border-b-2 px-[13px] pt-2 pb-[11px] text-label font-medium transition-colors phone:shrink-0 phone:px-3.5 phone:pt-[11px] phone:pb-[13px] phone:text-item-title phone:whitespace-nowrap ${
                      on
                        ? "border-b-accent text-fg"
                        : "border-b-transparent text-dim hover:text-fg"
                    }`,
                  )}
                  onClick={() => setFilter(t.key)}
                >
                  {t.label}
                  <span
                    className={utilityClassName(
                      `min-w-5 rounded-full px-[7px] py-px text-center text-meta font-semibold ${
                        on ? "bg-accent-soft text-accent" : "bg-active text-dim"
                      }`,
                    )}
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
              className={utilityClassName(
                `${ROW} -mx-[22px] bg-surface py-[9px] text-meta font-semibold tracking-[-0.01em] text-faint phone:hidden`,
              )}
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
          <div
            {...stylex.props(
              sx.flex,
              sx.flex1,
              sx.itemsCenter,
              sx.justifyCenter,
            )}
          >
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
          <div {...stylex.props(sx.flex, sx.flexCol)} role="table">
            {filtered.map((s) => {
              const meta = stateMeta(s);
              return (
                <button
                  key={s.prUrl}
                  className={utilityClassName(
                    `${ROW} group cursor-pointer py-[11px] text-item-title text-fg hover:bg-hover phone:flex phone:flex-wrap phone:items-center phone:gap-x-3 phone:gap-y-[9px] phone:px-4 phone:py-3.5`,
                  )}
                  onClick={() => onSelect(s.id)}
                  role="row"
                >
                  <span
                    className={`${C_STATE} ${STATE_TONE[meta.key]}`}
                    role="cell"
                  >
                    <StateIcon kind={meta.key} />
                    <span {...stylex.props(sx.whitespaceNowrap)}>
                      {meta.label}
                    </span>
                  </span>
                  <span className={C_TITLE} role="cell">
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
                          sx.leading13,
                          sx.fontMedium,
                          typography.itemTitle,
                        )}
                      >
                        {cleanTitle(s)}
                      </span>
                      {prNum(s) && (
                        <span
                          {...mergeStylexProps(
                            "tabular-nums",
                            sx.shrink0,
                            sx.textFaint,
                            typography.meta,
                          )}
                        >
                          {prNum(s)}
                        </span>
                      )}
                      {s.prUrl && (
                        <span
                          {...mergeStylexProps(
                            "group-hover:opacity-100",
                            sx.inlineFlex,
                            sx.shrink0,
                            sx.itemsCenter,
                            sx.selfCenter,
                            sx.roundedSm,
                            sx.p05,
                            sx.textFaint,
                            sx.opacity0,
                            sx.transitionOpacity,
                            sx.focusVisibleOpacity100,
                            sx.hoverTextLink,
                          )}
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
                    <span
                      {...stylex.props(
                        sx.flex,
                        sx.minW0,
                        sx.itemsCenter,
                        sx.gap3,
                        sx.textFaint,
                        typography.meta,
                      )}
                    >
                      {multiRepo && (
                        <Badge>
                          {s.repo ? repoLabel(s.repo) : "repository"}
                        </Badge>
                      )}
                      {s.branch && (
                        <span
                          {...mergeStylexProps(
                            "[&>svg]:shrink-0 [&>svg]:opacity-70",
                            sx.inlineFlex,
                            sx.minW0,
                            sx.maxWFull,
                            sx.itemsCenter,
                            sx.gap1,
                            sx.overflowHidden,
                            sx.textDim,
                            typography.meta,
                          )}
                        >
                          <svg
                            width="17"
                            height="17"
                            viewBox="0 0 16 16"
                            fill="currentColor"
                            aria-hidden
                          >
                            <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
                          </svg>
                          <span {...stylex.props(sx.truncate)}>{s.branch}</span>
                        </span>
                      )}
                      {s.linearIssue && (
                        <Badge
                          className={mergeStylexOverrideClassName(
                            "",
                            sx.tracking002em,
                          )}
                        >
                          {s.linearIssue.identifier}
                        </Badge>
                      )}
                      {s.isRunning && (
                        <span
                          {...stylex.props(
                            sx.shrink0,
                            sx.textYellow,
                            typography.meta,
                          )}
                        >
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
                              {...stylex.props(
                                sx.size22px,
                                sx.shrink0,
                                sx.roundedAvatar,
                                sx.bgActive,
                              )}
                              src={src}
                              alt=""
                              loading="lazy"
                            />
                          ) : (
                            <span
                              {...stylex.props(
                                sx.inlineFlex,
                                sx.size22px,
                                sx.shrink0,
                                sx.itemsCenter,
                                sx.justifyCenter,
                                sx.roundedAvatar,
                                sx.bgActive,
                                sx.fontSemibold,
                                sx.textFaint,
                                typography.meta,
                              )}
                              aria-hidden
                            >
                              {s.prAuthor.charAt(0).toUpperCase()}
                            </span>
                          );
                        })()}
                        <span
                          {...stylex.props(
                            sx.truncate,
                            sx.textDim,
                            typography.meta,
                          )}
                        >
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
