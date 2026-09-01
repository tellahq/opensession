import { mergeStylexProps, mergeStylexOverrideClassName } from "../../ui/cn";
import { utilityClassName } from "../../ui/cn";
import type { WorkspaceOverview } from "../../lib/api";
import { providerFromUrl } from "../../lib/provider";
import { sessionPrMerged, sessionPrRefs } from "../../lib/session-prs";
import {
  MAX_HOVERCARD_MEDIA,
  TONE_TEXT,
  cardRunErrorDetail,
  compactNum,
  hoverState,
  prTone,
  prettyReview,
  useSessionOverview,
  useWsOverview,
  wsPrInfo,
  type WsCardRow,
} from "../../lib/sidebar-hover";
import {
  SIDEBAR_STATUS_DOT,
  SIDEBAR_WS_SNOOZE,
  SIDEBAR_WS_TICKER,
} from "../../lib/sidebar-classes";
import {
  frontingPrSession,
  mineStatus,
  pinnedLane,
  runNeedsAttention,
  workspaceRunNeedingAttention,
} from "../../lib/sidebar-lanes";
import { type LaneChoice, type MineStatus } from "../../lib/sidebar-types";
import {
  SNOOZE_SOMEDAY,
  formatRemaining,
  snoozePresets,
} from "../../lib/snoozes";
import { elapsedSince, fullTime } from "../../lib/time";
import type { UnifiedSession } from "../../lib/types";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import {
  BottomSheet,
  SheetBody,
  SheetItem,
  SheetSeparator,
} from "../../ui/sheet";
import {
  LanePickerPage,
  LaneStatusMark,
  SheetDrillInItem,
  SheetPageHeader,
  lanePickerLabel,
  type LanePickerValue,
} from "./MobileSheetPages";
import { openLightbox } from "../../lib/media-lightbox";
import { sessionPrTone } from "../../lib/pr-refs";
import {
  CardFooter,
  CardPrChip,
  checksLabel,
  osReviewLabel,
} from "../SidebarRowCards";
import {
  IconArrowUpRight,
  IconClock,
  IconGitMerge,
  IconInbox,
  IconLink,
  IconMail,
  IconMoon,
  IconPencil,
  IconPin,
  IconPullRequest,
} from "../icons";
import React, { useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  text095em: {
    fontSize: "0.95em",
  },
  flex: {
    display: "flex",
  },
  minW0: {
    minWidth: "0",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap7px: {
    gap: "7px",
  },
  flex1: {
    flex: "1",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  textGreen: {
    color: "var(--green)",
  },
  textRed: {
    color: "var(--red)",
  },
  shrink: {
    flexShrink: "1",
  },
  textRight: {
    textAlign: "right",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  mt7px: {
    marginTop: "7px",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  bgAccentSoft: {
    backgroundColor: "var(--accent-soft)",
  },
  px2: {
    paddingInline: "calc(4px * 2)",
  },
  py5px: {
    paddingBlock: "5px",
  },
  leadingSnug: {
    lineHeight: "var(--leading-snug)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  lineClamp2: {
    overflow: "hidden",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: "2",
  },
  mt9px: {
    marginTop: "9px",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap3px: {
    gap: "3px",
  },
  gap2: {
    gap: "calc(4px * 2)",
  },
  leading135: {
    lineHeight: "1.35",
  },
  w74px: {
    width: "74px",
  },
  shrink0: {
    flexShrink: "0",
  },
  textPurple: {
    color: "var(--purple)",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  mt1: {
    marginTop: "4px",
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
  Mr13px: {
    marginRight: "calc(13px * -1)",
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  overflowXAuto: {
    overflowX: "auto",
  },
  pr13px: {
    paddingRight: "13px",
  },
  ScrollbarWidthNone: {
    scrollbarWidth: "none",
  },
  relative: {
    position: "relative",
  },
  block: {
    display: "block",
  },
  aspectVideo: {
    aspectRatio: "var(--aspect-video)",
  },
  w124px: {
    width: "124px",
  },
  snapStart: {
    scrollSnapAlign: "start",
  },
  overflowHidden: {
    overflow: "hidden",
  },
  roundedSm: {
    borderRadius: "calc(4px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },
  p0: {
    padding: "0",
  },
  hFull: {
    height: "100%",
  },
  wFull: {
    width: "100%",
  },
  objectContain: {
    objectFit: "contain",
  },
  pointerEventsNone: {
    pointerEvents: "none",
  },
  absolute: {
    position: "absolute",
  },
  inset0: {
    inset: "0",
  },
  grid: {
    display: "grid",
  },
  placeItemsCenter: {
    placeItems: "center",
  },
  textSm: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-sm--line-height))",
  },
  textWhite: {
    color: "var(--color-white)",
  },
  bgBlack55: {
    backgroundColor: "color-mix(in oklab, var(--color-black) 55%, transparent)",
  },
  textXs: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-xs--line-height))",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  opacity80: {
    opacity: "80%",
  },
  pb25: {
    paddingBottom: "calc(4px * 2.5)",
  },
  pt1: {
    paddingTop: "4px",
  },
});

// The session card, in the shape the workspace card already proved: what the
// session is, where it stands, what it last said, and the stills it produced.
// Model, mode, branch and created date used to sit here as rows; they are what
// the session's own Info tab is for, and on a hover card they pushed the one
// thing worth reading (the latest message) off the bottom. What survives as a
// row is what changes what you do next: who is behind it, a Linear issue, an
// autonomous goal or loop, and the PR's review and checks.
export function SessionCardBody({ session: s }: { session: UnifiedSession }) {
  const state = hoverState(s);
  const ov = useSessionOverview(s);
  const attentionDetail =
    s.safety?.explanation ??
    (!s.isRunning ? s.lastRunError?.message : undefined);
  const rows: Array<[string, React.ReactNode]> = [];
  const hasHead =
    (s.prAdditions != null && s.prDeletions != null) || !!s.prOsReview;

  const owner = s.automation || s.startedBy;
  if (owner) rows.push([s.automation ? "Automation" : "Started by", owner]);

  if (s.linearIssue)
    rows.push([
      "Linear",
      <span>
        <span {...stylex.props(sx.text095em)}>{s.linearIssue.identifier}</span>{" "}
        {s.linearIssue.title}
      </span>,
    ]);
  if (s.goal) rows.push(["Goal", "Autonomous goal session"]);
  if (s.loop) rows.push(["Loop", `Every ${s.loop.intervalMinutes} min`]);

  // The PR facts are worded exactly as the PR row's card words them. The
  // state itself is already the card's status line, so it isn't repeated.
  if (s.prReviewDecision)
    rows.push(["Review", prettyReview(s.prReviewDecision)]);
  const checks = checksLabel(s.prChecks);
  if (checks) rows.push(["Checks", checks]);

  return (
    <>
      {/* Same head as the workspace card: what changed, not which branch it
			    changed on. The repo used to stand in when there was no diff to
			    show, which spent the card's first line naming the band the row
			    was already filed under. */}
      {hasHead && (
        <div {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap7px)}>
          <span
            {...stylex.props(sx.minW0, sx.flex1, sx.truncate, typography.meta)}
          >
            {s.prAdditions != null && s.prDeletions != null && (
              <>
                <span {...stylex.props(sx.textGreen)}>
                  +{compactNum(s.prAdditions)}
                </span>{" "}
                <span {...stylex.props(sx.textRed)}>
                  -{compactNum(s.prDeletions)}
                </span>
              </>
            )}
          </span>
          {/* What the automated review made of this session's PR, in the same
					    place the workspace card puts it. */}
          {s.prOsReview && (
            <span
              {...stylex.props(
                sx.minW0,
                sx.shrink,
                sx.truncate,
                sx.textRight,
                typography.meta,
              )}
            >
              <span {...stylex.props(sx.textFaint)}>OS review </span>
              {osReviewLabel(s.prOsReview)}
            </span>
          )}
        </div>
      )}

      <div
        className={cn(
          utilityClassName(
            "flex min-w-0 items-center gap-[7px] text-label font-semibold leading-[1.3]",
          ),
          hasHead && utilityClassName("mt-[5px]"),
        )}
      >
        {s.isRunning && (
          <span
            className={utilityClassName(
              `size-2 shrink-0 rounded-full ${state.dotClass}`,
            )}
          />
        )}
        <span {...stylex.props(sx.minW0, sx.truncate)}>{s.title}</span>
      </div>

      {!runNeedsAttention(s) && (
        <div
          className={utilityClassName(
            `mt-[3px] text-meta font-medium ${TONE_TEXT[state.tone]}`,
          )}
        >
          {state.label}
        </div>
      )}

      {s.waitingForInput && (
        <div
          {...stylex.props(
            sx.mt7px,
            sx.roundedMd,
            sx.bgAccentSoft,
            sx.px2,
            sx.py5px,
            sx.leadingSnug,
            sx.textDim,
            typography.meta,
          )}
        >
          Blocked on a question. Open the session to answer.
        </div>
      )}
      {!s.waitingForInput && attentionDetail && (
        <div
          {...stylex.props(
            sx.mt7px,
            sx.roundedMd,
            sx.bgAccentSoft,
            sx.px2,
            sx.py5px,
            sx.leadingSnug,
            sx.textDim,
            sx.lineClamp2,
            typography.meta,
          )}
          title={attentionDetail}
        >
          {cardRunErrorDetail(attentionDetail)}
        </div>
      )}
      {!s.waitingForInput && (s.queuedCount ?? 0) > 0 && (
        <div
          {...stylex.props(
            sx.mt7px,
            sx.roundedMd,
            sx.bgAccentSoft,
            sx.px2,
            sx.py5px,
            sx.leadingSnug,
            sx.textDim,
            typography.meta,
          )}
        >
          {s.queuedCount} prompt{s.queuedCount === 1 ? "" : "s"} queued.
        </div>
      )}

      <CardOverview ov={ov} />

      {rows.length > 0 && (
        <div {...stylex.props(sx.mt9px, sx.flex, sx.flexCol, sx.gap3px)}>
          {rows.map(([label, value], i) => (
            <div
              {...stylex.props(
                sx.flex,
                sx.gap2,
                sx.leading135,
                typography.meta,
              )}
              key={i}
            >
              <span {...stylex.props(sx.w74px, sx.shrink0, sx.textFaint)}>
                {label}
              </span>
              <span {...stylex.props(sx.minW0, sx.truncate, sx.textDim)}>
                {value}
              </span>
            </div>
          ))}
        </div>
      )}

      <CardFooter>
        {s.prUrl && (
          <CardPrChip
            url={s.prUrl}
            number={s.prNumber}
            tone={sessionPrTone(s)}
          />
        )}
      </CardFooter>
    </>
  );
}

// Leading status mark for a workspace, Conductor-style: live states
// (blocked question, running) keep their animated form, then the PR lifecycle
// gets an icon — open PR (green, faint while still a draft) or merged
// (purple). Backlog rows get a quiet gray idle dot. Shared by
// the sidebar row and the hover card head so they always read the same.
// Live "in progress" ticker: counts up from when the run started, in the
// in-progress color (yellow). Ticks once a second, isolated to this tiny node
// so the whole sidebar doesn't re-render every second. `startMs` is the earliest
// running session's start (see runStartMs) — the workspace's been busy for that long.
export function RunTicker({ startMs }: { startMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  // Seconds only show in the first minute, so that is the only minute worth
  // ticking at 1Hz — after it, the label can only change once a minute.
  const fine = now - startMs < 60_000;
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), fine ? 1000 : 15_000);
    return () => clearInterval(t);
  }, [fine]);
  return (
    <span
      className={SIDEBAR_WS_TICKER}
      title="How long this run has been working"
    >
      {elapsedSince(startMs, now)}
    </span>
  );
}

// Countdown badge for a snoozed row: time until it wakes ("57m", "14h").
// Isolated 30s ticker (RunTicker-style) so the sidebar doesn't re-render
// for the countdown.
export function SnoozeBadge({
  until,
  className,
}: {
  until: string;
  /** The row hands this the left margin: the badge pins itself to the right
	    edge, unless a ticker ahead of it already did that pushing. */
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <span
      className={cn(SIDEBAR_WS_SNOOZE, className)}
      title={
        until === SNOOZE_SOMEDAY
          ? "Snoozed: Someday"
          : `Snoozed until ${new Date(until).toLocaleString()}`
      }
    >
      <IconMoon size={20} />
      {formatRemaining(until, now)}
    </span>
  );
}

export function WsPrStatusMark({
  sessions,
  size,
  workspace,
  shipsDirectlyToMain = false,
}: {
  sessions: UnifiedSession[];
  size: number;
  workspace?: {
    branch?: string | null;
    prNumber?: number;
    draft?: { text: string } | null;
  } | null;
  /** This work lands on the default branch, so an absent PR is not missing work. */
  shipsDirectlyToMain?: boolean;
}) {
  // Read the authoritative multi-PR projection before the legacy flat fields.
  // A Slack session can own a discovered PR through `prs[]` while `prUrl` and
  // `prState` stay empty, and that landed work still needs the merged mark.
  if (sessions.some(sessionPrMerged)) {
    return (
      <span {...stylex.props(sx.flex, sx.itemsCenter)} title="PR merged">
        <IconPullRequest
          size={size}
          className={mergeStylexOverrideClassName("", sx.textPurple)}
        />
      </span>
    );
  }
  const pr = [...sessions]
    .sort((a, b) => (b.lastActivity || "").localeCompare(a.lastActivity || ""))
    .flatMap(sessionPrRefs)
    .find((candidate) => candidate.url || candidate.number !== undefined);
  if (!pr) {
    // Rows that can never have a PR — feed/scratch workspaces (repo-less
    // sessions, no workspace branch/PR) — get an empty alignment slot, not a
    // misleading git glyph. A draft workspace (no session at all yet) gets
    // the same pencil the row's own unsent-draft mark uses elsewhere.
    const canPr =
      sessions.some((c) => c.branch || c.prUrl || c.repo) ||
      !!workspace?.branch ||
      workspace?.prNumber !== undefined;
    if (!canPr) {
      if (workspace?.draft)
        return (
          <span {...stylex.props(sx.flex, sx.itemsCenter)} title="Draft">
            <IconPencil
              size={size}
              className={mergeStylexOverrideClassName("", sx.textFaint)}
            />
          </span>
        );
      return (
        <span
          {...stylex.props(
            sx.flex,
            sx.shrink0,
            sx.itemsCenter,
            sx.justifyCenter,
          )}
          style={{ width: size, height: size }}
        />
      );
    }
    // A shared checkout ships on the default branch. The grey PR glyph used to
    // imply that this row was missing a PR it should create; here no PR is the
    // intended path, so keep the lane's quiet idle dot instead.
    if (shipsDirectlyToMain)
      return (
        <span
          {...stylex.props(
            sx.flex,
            sx.shrink0,
            sx.itemsCenter,
            sx.justifyCenter,
          )}
          style={{ width: size, height: size }}
        >
          <span
            className={utilityClassName(
              `size-2 shrink-0 rounded-full ${SIDEBAR_STATUS_DOT.idle}`,
            )}
          />
        </span>
      );
    return (
      <span {...stylex.props(sx.flex, sx.itemsCenter)} title="No pull request">
        <IconPullRequest
          size={size}
          className={mergeStylexOverrideClassName("", sx.textFaint)}
        />
      </span>
    );
  }
  const failed = (pr.checks?.failed || 0) > 0;
  const pending = (pr.checks?.pending || 0) > 0;
  const changesRequested = pr.reviewDecision === "CHANGES_REQUESTED";
  const className =
    pr.state === "CLOSED" || failed || changesRequested
      ? utilityClassName("text-red")
      : pending
        ? utilityClassName("text-yellow")
        : pr.isDraft
          ? utilityClassName("text-faint")
          : utilityClassName("text-green");
  const label =
    pr.state === "CLOSED"
      ? "PR closed"
      : changesRequested
        ? "PR changes requested"
        : failed
          ? "PR checks failing"
          : pending
            ? "PR checks running"
            : pr.isDraft
              ? "Draft PR"
              : pr.reviewDecision === "APPROVED"
                ? "PR approved"
                : "PR open";
  return (
    <span {...stylex.props(sx.flex, sx.itemsCenter)} title={label}>
      <IconPullRequest size={size} className={className} />
    </span>
  );
}

export function WsStatusMark({
  row,
  size = 20,
}: {
  row: {
    status: MineStatus;
    running: boolean;
    sessions: UnifiedSession[];
    workspace?: { draft?: { text: string } | null } | null;
  };
  size?: number;
}) {
  // Every mark rides in the same `size`-wide (20px) flex slot so #number/title
  // line up at one x whichever mark the row carries. It also gives the icons a
  // real CSS box: an SVG sized only by its width/height *attributes* collapses
  // to a 0 flex-basis in iOS Safari and paints on top of the title — the slot's
  // inline-styled span dodges that (the dots were always immune for this reason).
  const slot = (child: React.ReactNode) => (
    <span
      {...stylex.props(sx.flex, sx.shrink0, sx.itemsCenter, sx.justifyCenter)}
      style={{ width: size, height: size }}
    >
      {child}
    </span>
  );
  const dot = (cls: string) =>
    slot(
      <span
        className={utilityClassName(`size-2 shrink-0 rounded-full ${cls}`)}
      />,
    );
  if (row.sessions.some((session) => session.waitingForInput))
    return dot(SIDEBAR_STATUS_DOT.waiting);
  if (workspaceRunNeedingAttention(row.sessions))
    return dot(SIDEBAR_STATUS_DOT.failed);
  if (row.status === "needsinput") return dot(SIDEBAR_STATUS_DOT.waiting);
  if (row.running) return dot(SIDEBAR_STATUS_DOT.running);
  // A draft workspace has no session and so no PR to show. The flat-repo
  // grouping's mark stands in for WsPrStatusMark's own draft branch above.
  if (row.workspace?.draft && row.sessions.length === 0)
    return (
      <span {...stylex.props(sx.flex, sx.itemsCenter)} title="Draft">
        <IconPencil
          size={size}
          className={mergeStylexOverrideClassName("", sx.textFaint)}
        />
      </span>
    );
  if (row.status === "review") {
    const open = row.sessions.filter((c) => c.prState === "OPEN");
    const allDraft = open.length > 0 && open.every((c) => c.prIsDraft);
    return slot(
      <IconPullRequest
        size={size}
        className={
          allDraft
            ? utilityClassName("text-faint")
            : utilityClassName("text-green")
        }
      />,
    );
  }
  if (row.status === "merged")
    return slot(
      <IconGitMerge
        size={size}
        className={mergeStylexOverrideClassName("", sx.textPurple)}
      />,
    );
  // A landed PR files its idle row under Done (prLaneForSessions), but a
  // human-pinned lane wins, so a row parked in Backlog stays there after its
  // PR merges. Its mark should carry the PR lifecycle anyway, like the
  // lane-grouped view's WsPrStatusMark does — a grey idle dot on a merged row
  // reads as "no PR".
  const prSession = frontingPrSession(row.sessions);
  if (row.status === "pending" && prSession && sessionPrMerged(prSession))
    return slot(
      <IconGitMerge
        size={size}
        className={mergeStylexOverrideClassName("", sx.textPurple)}
      />,
    );
  return dot(SIDEBAR_STATUS_DOT.idle);
}

/**
 * Where the work stands, in the two things that carry it: the latest message,
 * and the stills the session produced. Shared by the workspace card and the
 * session card, because "what happened here" is the same question of both, and
 * it is the half of the card people actually read.
 */
export function CardOverview({ ov }: { ov: WorkspaceOverview | null }) {
  const desc = (ov?.lastMessage?.content || ov?.prompt?.content || "")
    .replace(/\s+/g, " ")
    .trim();
  const media = ov?.media || [];
  return (
    <>
      {desc && (
        <div
          {...mergeStylexProps(
            "selectable",
            sx.mt1,
            sx.leadingSnug,
            sx.textDim,
            sx.lineClamp2,
            typography.meta,
          )}
        >
          {desc}
        </div>
      )}

      {media.length > 0 && (
        // A filmstrip, like the info panel's screenshots: a 62px square
        // crop of a 1440px screenshot is a grey band of text, not a
        // picture of anything. Whole frames, scrolled sideways, and
        // everything is reachable instead of hidden behind a "+3". Bleed
        // through the card's right inset so the carousel peek is clipped
        // at the card edge rather than stopping inside its padding.
        <div
          {...mergeStylexProps(
            "snap-x snap-mandatory [&::-webkit-scrollbar]:hidden",
            sx.mt2,
            sx.Mr13px,
            sx.flex,
            sx.gap15,
            sx.overflowXAuto,
            sx.pr13px,
            sx.ScrollbarWidthNone,
          )}
        >
          {media.slice(0, MAX_HOVERCARD_MEDIA).map((m, i) => (
            <button
              key={`${m.sessionId}:${m.at}:${i}`}
              type="button"
              onClick={() => openLightbox(media, i)}
              {...stylex.props(
                sx.relative,
                sx.block,
                sx.aspectVideo,
                sx.w124px,
                sx.shrink0,
                sx.snapStart,
                sx.overflowHidden,
                sx.roundedSm,
                sx.border,
                sx.borderLine,
                sx.bgSurface,
                sx.p0,
              )}
              title={[m.sessionTitle, fullTime(m.at)]
                .filter(Boolean)
                .join(" · ")}
            >
              {m.kind === "image" ? (
                <img
                  src={m.src}
                  alt=""
                  loading="lazy"
                  {...stylex.props(sx.hFull, sx.wFull, sx.objectContain)}
                />
              ) : (
                <>
                  <video
                    src={m.src}
                    muted
                    playsInline
                    preload="metadata"
                    {...stylex.props(sx.hFull, sx.wFull, sx.objectContain)}
                  />
                  <span
                    {...mergeStylexProps(
                      "drop-shadow",
                      sx.pointerEventsNone,
                      sx.absolute,
                      sx.inset0,
                      sx.grid,
                      sx.placeItemsCenter,
                      sx.textSm,
                      sx.textWhite,
                    )}
                  >
                    ▶
                  </span>
                </>
              )}
              {i === MAX_HOVERCARD_MEDIA - 1 &&
                media.length > MAX_HOVERCARD_MEDIA && (
                  <span
                    {...stylex.props(
                      sx.absolute,
                      sx.inset0,
                      sx.grid,
                      sx.placeItemsCenter,
                      sx.bgBlack55,
                      sx.textXs,
                      sx.fontSemibold,
                      sx.textWhite,
                    )}
                  >
                    +{media.length - MAX_HOVERCARD_MEDIA + 1}
                  </span>
                )}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// The info half of the workspace card: diff + status mark, title,
// blocked-question callout, latest-message description, media thumbnails.
// Rendered inside the hover card (desktop) and the long-press sheet (mobile).
function WsOverviewInfo({
  row,
  ov,
}: {
  row: WsCardRow;
  ov: WorkspaceOverview | null;
}) {
  const { prSession } = wsPrInfo(row);
  const hasHead =
    (prSession?.prAdditions != null && prSession?.prDeletions != null) ||
    !!prSession?.prOsReview;
  const attentionSession = workspaceRunNeedingAttention(row.sessions);
  const attentionDetail =
    attentionSession?.safety?.explanation ??
    attentionSession?.lastRunError?.message ??
    "Needs attention.";
  return (
    <>
      {/* The PR facts, on one strip above the title: what changed, what the
			    automated review made of it, and where it stands. A generated branch
			    name ("auto-plain-ticket-triage-202608121249") used to hold this
			    line, truncating to answer nothing the title doesn't; so did the
			    repo, which only ever named the band the row is filed under. The
			    verdict reads better here than under the title, where it sat between
			    the name and the description and pushed them apart. */}
      {hasHead && (
        <div {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap7px)}>
          {/* The diff is two short numbers and never truncates; the verdict is
					    the variable-length half, so it takes the slack and gives it back. */}
          <span {...stylex.props(sx.shrink0, typography.meta)}>
            {prSession?.prAdditions != null &&
              prSession?.prDeletions != null && (
                <>
                  <span {...stylex.props(sx.textGreen)}>
                    +{compactNum(prSession.prAdditions)}
                  </span>{" "}
                  <span {...stylex.props(sx.textRed)}>
                    -{compactNum(prSession.prDeletions)}
                  </span>
                </>
              )}
          </span>
          {/* What os-review made of this PR: the question a Ready-to-merge row
					    raises, answered without opening GitHub. */}
          {prSession?.prOsReview && (
            <span
              {...stylex.props(
                sx.minW0,
                sx.flex1,
                sx.truncate,
                sx.textRight,
                typography.meta,
              )}
            >
              <span {...stylex.props(sx.textFaint)}>OS review </span>
              {osReviewLabel(prSession.prOsReview)}
            </span>
          )}
        </div>
      )}

      <div
        className={cn(
          utilityClassName(
            "flex min-w-0 items-center gap-[7px] text-label font-semibold leading-[1.3]",
          ),
          hasHead && utilityClassName("mt-[5px]"),
        )}
      >
        {row.running && (
          <span
            className={utilityClassName(
              `size-2 shrink-0 rounded-full ${SIDEBAR_STATUS_DOT.running}`,
            )}
          />
        )}
        <span {...stylex.props(sx.minW0, sx.truncate)}>{row.name}</span>
      </div>

      {row.status === "needsinput" &&
        (row.sessions.some((c) => c.waitingForInput) ? (
          <div
            {...stylex.props(
              sx.mt7px,
              sx.roundedMd,
              sx.bgAccentSoft,
              sx.px2,
              sx.py5px,
              sx.leadingSnug,
              sx.textDim,
              typography.meta,
            )}
          >
            Blocked on a question. Open to answer.
          </div>
        ) : (
          <div
            {...stylex.props(
              sx.mt7px,
              sx.roundedMd,
              sx.bgAccentSoft,
              sx.px2,
              sx.py5px,
              sx.leadingSnug,
              sx.textDim,
              sx.lineClamp2,
              typography.meta,
            )}
            title={attentionDetail}
          >
            {cardRunErrorDetail(attentionDetail)}
          </div>
        ))}

      <CardOverview ov={ov} />
    </>
  );
}

// The workspace counterpart of SessionCardBody: diff stats + status
// at a glance, the latest assistant message as a "where things stand" line,
// screenshot thumbnails from the workspace's sessions, and quick actions
// (Snooze, PR link), which is why its shell is the one the pointer can travel into.
export function WsCardBody({
  row,
  snoozed,
  onToggleSnooze,
  onOpen,
}: {
  row: WsCardRow;
  snoozed: boolean;
  onToggleSnooze: () => void;
  /** Open a session (the "Answer" action jumps to the blocked one). */
  onOpen: (session: UnifiedSession) => void;
}) {
  const ov = useWsOverview(row);
  const { prSession, prReady, prStatusBits } = wsPrInfo(row);

  return (
    <>
      <WsOverviewInfo row={row} ov={ov} />

      <CardFooter>
        {/* The single main action follows what the workspace needs next.
				    Unsnooze is always immediate; Snooze stays on the row and menu. */}
        {snoozed ? (
          <Button
            size="sm"
            variant="soft"
            icon={<IconMoon size={20} />}
            onClick={onToggleSnooze}
          >
            Unsnooze
          </Button>
        ) : row.status === "needsinput" && row.sessions.length > 0 ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() =>
              onOpen(
                row.sessions.find((c) => c.waitingForInput) ||
                  workspaceRunNeedingAttention(row.sessions) ||
                  row.sessions[0],
              )
            }
          >
            {row.sessions.some((c) => c.waitingForInput) ? "Answer" : "Open"}
          </Button>
        ) : row.status === "review" && prSession?.prUrl ? (
          <Button
            size="sm"
            variant={prReady ? "success-strong" : "soft"}
            trailing={
              <IconArrowUpRight
                size={15}
                className={mergeStylexOverrideClassName("", sx.opacity80)}
              />
            }
            render={
              <a
                href={prSession.prUrl}
                target="_blank"
                rel="noopener noreferrer"
              />
            }
          >
            {prReady ? "Merge" : "Review"}
          </Button>
        ) : null}
        {prSession?.prUrl && (
          <CardPrChip
            url={prSession.prUrl}
            number={prSession.prNumber}
            tone={sessionPrTone(prSession)}
          />
        )}
        {prStatusBits.length > 0 && (
          <span
            {...stylex.props(
              sx.minW0,
              sx.truncate,
              sx.textFaint,
              typography.meta,
            )}
          >
            {prStatusBits.join(" · ")}
          </span>
        )}
      </CardFooter>
    </>
  );
}

// The touch counterpart of the workspace card: long-pressing a row raises
// a bottom sheet with the same overview block (diff + status, title,
// latest message, thumbnails) followed by thumb-sized action rows — the
// status-colored main action first (answer / merge / review / archive), then
// the workspace chores that live behind right-click on desktop (pin, rename,
// color, archive, delete). Replaces the old long-press → context-menu path.
export function WsMobileSheet({
  row,
  pinned,
  onTogglePin,
  onClose,
  onArchive,
  onSetStatus,
  snoozeUntil,
  onSnooze,
  onOpen,
  onRename,
  unread,
  claimed,
  onToggleRead,
  onCopyLink,
  onDelete,
}: {
  row: WsCardRow;
  pinned: boolean;
  onTogglePin: () => void;
  onClose: () => void;
  onArchive: () => void;
  /** Pin the workspace into a lane, or clear back to derived with `null`. */
  onSetStatus: (status: LaneChoice | null) => void;
  /** Active snooze expiry (ISO), or null when not snoozed. */
  snoozeUntil: string | null;
  /** Snooze until the given ISO time, or unsnooze with `null`. */
  onSnooze: (until: string | null) => void;
  onOpen: (session: UnifiedSession) => void;
  onRename: () => void;
  /** Whether the row has unread activity — picks the read/unread direction. */
  unread: boolean;
  /** In your lanes already (true), claimable (false), or your own row with
	    nothing to claim (null — the action is hidden). */
  claimed: boolean | null;
  /** Flip every session in the row read or unread; null for sessionless rows. */
  onToggleRead: (() => void) | null;
  /** Copy a link to the row's first session; null for sessionless rows. */
  onCopyLink: (() => void) | null;
  onDelete: (() => void) | null;
}) {
  const ov = useWsOverview(row);
  const { prSession, prReady, prStatusBits } = wsPrInfo(row);
  const [page, setPage] = useState<"actions" | "status" | "snooze">("actions");
  const anyManual = row.sessions.some((session) => pinnedLane(session));
  const firstLane = pinnedLane(row.sessions[0]) ?? null;
  const currentLane: LanePickerValue = !anyManual
    ? null
    : row.sessions.every((session) => pinnedLane(session) === firstLane)
      ? firstLane
      : "mixed";
  const displayedLane = currentLane ?? row.status;
  // Lock the page behind the sheet so a scroll drags the list, not the page.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  const archiveGlyph = (
    <svg
      width="20"
      height="20"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <rect x="2.25" y="2.75" width="11.5" height="3" rx="0.6" />
      <path d="M3.25 5.75v6.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-6.5" />
      <path d="M6.5 8.5h3" strokeLinecap="round" />
    </svg>
  );
  return (
    <BottomSheet label={`Actions for ${row.name}`} onClose={onClose}>
      {(dismiss) => {
        const closing = (fn: () => void) => () => {
          fn();
          dismiss();
        };
        if (page === "status") {
          return (
            <LanePickerPage
              current={currentLane}
              onBack={() => setPage("actions")}
              onSelect={(status) => {
                onSetStatus(status);
                dismiss();
              }}
            />
          );
        }
        if (page === "snooze") {
          return (
            <>
              <SheetPageHeader
                title="Snooze"
                onBack={() => setPage("actions")}
              />
              <SheetBody>
                {snoozePresets().map((preset) => (
                  <SheetItem
                    key={preset.label}
                    onClick={closing(() => onSnooze(preset.until))}
                  >
                    <IconClock size={22} />
                    {preset.label}
                  </SheetItem>
                ))}
                {snoozeUntil && (
                  <SheetItem onClick={closing(() => onSnooze(null))}>
                    <IconMoon size={22} />
                    Unsnooze
                  </SheetItem>
                )}
              </SheetBody>
            </>
          );
        }
        return (
          <SheetBody>
            <div {...stylex.props(sx.px2, sx.pb25, sx.pt1)}>
              <WsOverviewInfo row={row} ov={ov} />
              {prStatusBits.length > 0 && (
                <div
                  {...stylex.props(
                    sx.mt2,
                    sx.flex,
                    sx.minW0,
                    sx.itemsCenter,
                    sx.gap2,
                    sx.textFaint,
                    typography.meta,
                  )}
                >
                  {prSession?.prNumber != null && (
                    <span
                      className={utilityClassName(
                        `shrink-0 text-[0.95em] font-semibold ${prTone(prSession)}`,
                      )}
                    >
                      #{prSession.prNumber}
                    </span>
                  )}
                  <span {...stylex.props(sx.minW0, sx.truncate)}>
                    {prStatusBits.join(" · ")}
                  </span>
                </div>
              )}
            </div>
            <SheetSeparator />
            {/* The most urgent contextual action stays first. */}
            {row.status === "needsinput" && row.sessions.length > 0 && (
              <SheetItem
                tone="accent"
                onClick={closing(() =>
                  onOpen(
                    row.sessions.find((c) => c.waitingForInput) ||
                      workspaceRunNeedingAttention(row.sessions) ||
                      row.sessions[0],
                  ),
                )}
              >
                <WsStatusMark row={row} size={22} />
                {row.sessions.some((c) => c.waitingForInput)
                  ? "Answer question"
                  : "Check failed run"}
              </SheetItem>
            )}
            {row.status === "review" && prSession?.prUrl && (
              <SheetItem
                tone={prReady ? "green" : "default"}
                onClick={closing(() =>
                  window.open(prSession.prUrl, "_blank", "noopener"),
                )}
              >
                <IconPullRequest size={22} />
                {prReady
                  ? `Merge on ${providerFromUrl(prSession.prUrl).name}`
                  : "Review PR"}
                {prSession.prNumber != null && ` #${prSession.prNumber}`}
              </SheetItem>
            )}
            {prSession?.prUrl && row.status !== "review" && (
              <SheetItem
                onClick={closing(() =>
                  window.open(prSession.prUrl, "_blank", "noopener"),
                )}
              >
                <IconPullRequest size={22} />
                Open PR
                {prSession.prNumber != null ? ` #${prSession.prNumber}` : ""}
              </SheetItem>
            )}
            {claimed !== null && (
              <SheetItem
                onClick={closing(() => onSetStatus(claimed ? null : "mine"))}
              >
                <IconInbox size={22} />
                {claimed ? "Stop keeping in sidebar" : "Keep in sidebar"}
              </SheetItem>
            )}
            {onToggleRead && (
              <SheetItem onClick={closing(onToggleRead)}>
                <IconMail size={22} />
                {unread ? "Mark as read" : "Mark as unread"}
              </SheetItem>
            )}
            <SheetItem onClick={closing(onTogglePin)}>
              <IconPin size={22} fill={pinned ? "currentColor" : "none"} />
              {pinned ? "Unpin" : "Pin"}
            </SheetItem>
            {snoozeUntil && (
              <SheetItem onClick={closing(() => onSnooze(null))}>
                <IconMoon size={22} />
                Unsnooze
              </SheetItem>
            )}
            <SheetItem onClick={closing(onRename)}>
              <svg
                width="20"
                height="20"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
              >
                <path d="M10.5 2.5l3 3L6 13l-3.5.5L3 10z" />
              </svg>
              Rename
            </SheetItem>
            {onCopyLink && (
              <SheetItem onClick={closing(onCopyLink)}>
                <IconLink size={22} />
                Copy link
              </SheetItem>
            )}
            {row.sessions.length > 0 && (
              <>
                <SheetDrillInItem
                  icon={<LaneStatusMark value={displayedLane} />}
                  label="Status"
                  value={lanePickerLabel(displayedLane)}
                  onClick={() => setPage("status")}
                />
                {!snoozeUntil && (
                  <SheetDrillInItem
                    icon={<IconMoon size={22} />}
                    label="Snooze"
                    onClick={() => setPage("snooze")}
                  />
                )}
              </>
            )}
            {(row.sessions.length > 0 || onDelete) && <SheetSeparator />}
            {/* Archive stays explicit and destructive after Pin and Snooze. */}
            {row.sessions.length > 0 && (
              <SheetItem tone="danger" onClick={closing(onArchive)}>
                {archiveGlyph}
                Archive
              </SheetItem>
            )}
            {onDelete && (
              <SheetItem tone="danger" onClick={closing(onDelete)}>
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                >
                  <path d="M3 4.5h10M6.5 4.5V3.25a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1V4.5M4.25 4.5l.6 8.25a1 1 0 0 0 1 .93h4.3a1 1 0 0 0 1-.93l.6-8.25" />
                </svg>
                {row.workspace?.draft && row.sessions.length === 0
                  ? "Delete draft"
                  : "Delete workspace"}
              </SheetItem>
            )}
          </SheetBody>
        );
      }}
    </BottomSheet>
  );
}
