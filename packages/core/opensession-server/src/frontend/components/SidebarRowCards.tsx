import { mergeStylexProps, mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React, { useState } from "react";
import type { OsReview, SupportThread, UnifiedSession } from "../lib/types";
import type { ReviewQueueItem } from "../lib/review-queue";
import { relativeTime, type OpenPr } from "../lib/api";
import { CAP_LABEL } from "../lib/cap-label";
import { providerFromUrl } from "../lib/provider";
import { osReviewText, refTone, type PrTone } from "../lib/pr-refs";
import { prChipClass } from "../lib/pr-tone-classes";
import { TONE_TEXT, prettyReview, type HoverTone } from "../lib/sidebar-hover";
import { plainThreadUrl } from "./PlainThreadPanel";
import { IconArrowUpRight, IconGitMerge } from "./icons";
import { Popover } from "../ui/popover";
import { pointerCanHover } from "../lib/pointer";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  mt9px: {
    marginTop: "9px",
  },
  flex: {
    display: "flex",
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
  textFaint: {
    color: "var(--text-faint)",
  },
  minW0: {
    minWidth: "0",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  inlineFlex: {
    display: "inline-flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap05: {
    gap: "calc(4px * 0.5)",
  },
  textXs: {
    fontSize: "var(--type-label)",
    lineHeight: "var(--tw-leading, var(--text-xs--line-height))",
  },
  noUnderline: {
    textDecorationLine: "none",
  },
  hoverTextFg: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text)",
      },
    },
  },
  opacity70: {
    opacity: "70%",
  },
  mt35: {
    marginTop: "calc(4px * 3.5)",
  },
  mlAuto: {
    marginLeft: "auto",
  },
  textRed: {
    color: "var(--red)",
  },
  textYellow: {
    color: "var(--yellow)",
  },
  textGreen: {
    color: "var(--green)",
  },
  gap7px: {
    gap: "7px",
  },
  flex1: {
    flex: "1",
  },
  mt5px: {
    marginTop: "5px",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  leading13: {
    lineHeight: "1.3",
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
  mt1: {
    marginTop: "4px",
  },
  lineClamp3: {
    overflow: "hidden",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: "3",
  },
  mt2: {
    marginTop: "calc(4px * 2)",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  gap1: {
    gap: "4px",
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
  px15: {
    paddingInline: "calc(4px * 1.5)",
  },
  py05: {
    paddingBlock: "calc(4px * 0.5)",
  },
});

/**
 * Hover cards for the sidebar's rows.
 *
 * Every row in the sidebar — workspace, session, pull request, support ticket,
 * feed item — answers "what is this, and what does it need?" on a dwell, and
 * they are all the same card: one shell (RowCardPopup) around a body that
 * differs only in what the row has to say. The bodies for the PR and support
 * rows live here; the workspace and session bodies stay in Sidebar.tsx, where
 * their data lives, but they render into this same shell.
 */

/** The card's own chrome — width and padding. Everything else (portal,
 *  positioning, collision flip, arrow, dwell) is ui/popover's, and so is the
 *  corner now: the card used to override it a step tighter than the menus it
 *  sits beside, which is a difference nobody meant. */
const ROW_CARD_CLASS = utilityClassName(
  "w-[min(300px,calc(100vw-24px))] px-[13px] pt-[11px] pb-3",
);

/**
 * The one popup every sidebar row's hover card is drawn in: to the row's
 * right, top-aligned with it, pointing back at it. Pass `anchor` for a row
 * that can't be a Popover.Trigger itself — the workspace list renders its rows
 * from a plain function, so it drives one shared card off the hovered element.
 *
 * Placement is overridable for the one card that isn't beside a list: a
 * transcript chip sits inline in a paragraph, where the card belongs under the
 * word rather than off in the margin.
 */
export function RowCardPopup({
  anchor,
  side = "right",
  align = "start",
  // Sit on the sidebar's trailing gutter instead of aligning exactly with
  // the content seam, which made the card and chat read as one surface.
  sideOffset = 0,
  children,
}: {
  anchor?: React.ComponentProps<typeof Popover.Popup>["anchor"];
  side?: React.ComponentProps<typeof Popover.Popup>["side"];
  align?: React.ComponentProps<typeof Popover.Popup>["align"];
  sideOffset?: number;
  children: React.ReactNode;
}) {
  return (
    <Popover.Popup
      side={side}
      align={align}
      sideOffset={sideOffset}
      arrow
      elevation="lg"
      anchor={anchor}
      className={ROW_CARD_CLASS}
    >
      {children}
    </Popover.Popup>
  );
}

/**
 * Hover-only card wiring for a sidebar row.
 *
 * A row's click already does something (select the PR / open the ticket), so
 * the card may only be raised by hovering: a press that toggled it open would
 * put a card over the view the same tap just opened — which is exactly what
 * touch does, where every tap is a press. Blocking non-hover opens keeps
 * mobile behaving as it did before the card existed.
 */
export function useRowHoverCard(
  /** Hold the card back entirely — the row is being renamed, and the input
   *  it turns into owns the interaction. */
  disabled?: boolean,
) {
  const [open, setOpen] = useState(false);
  return {
    rootProps: {
      open: open && !disabled,
      onOpenChange: (next: boolean, details: { reason?: string }) => {
        if (
          next &&
          (disabled || !pointerCanHover() || details.reason !== "trigger-hover")
        )
          return;
        setOpen(next);
      },
    },
    /** Spread onto Popover.Trigger. Dwell is longer than a tooltip's: rows
     *  are dense, and the card shouldn't chase a pointer crossing the list. */
    triggerProps: { openOnHover: true as const, delay: 320, closeDelay: 90 },
    close: () => setOpen(false),
  };
}

/** The card's label/value block. Every card body lays its facts out this way,
 *  so a PR reads the same whether it was raised from a row or from a chip. */
export function CardRows({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  if (rows.length === 0) return null;
  return (
    <div {...stylex.props(sx.mt9px, sx.flex, sx.flexCol, sx.gap3px)}>
      {rows.map(([label, value], i) => (
        <div
          {...stylex.props(sx.flex, sx.gap2, sx.leading135, typography.meta)}
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
  );
}

/**
 * The "open this somewhere else" link every card ends on. The app ships no
 * Tailwind Preflight (see styles/tailwind.css), so a bare `<a>` keeps the UA's
 * underline and `legacy.css`'s accent link colour — which is why this has to
 * say `no-underline` out loud, and why every card must go through it rather
 * than hand-rolling an anchor and forgetting to. The leaving arrow belongs to
 * the link, not to each caller's label: as a raw "↗" glyph it carried its own
 * font's side bearings and sat off-centre beside the text.
 */
export function CardLink({
  href,
  title,
  children,
}: {
  href: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      {...stylex.props(
        sx.inlineFlex,
        sx.shrink0,
        sx.itemsCenter,
        sx.gap05,
        sx.textXs,
        sx.textDim,
        sx.noUnderline,
        sx.hoverTextFg,
      )}
    >
      {children}
      <IconArrowUpRight
        size={15}
        className={mergeStylexOverrideClassName("", sx.opacity70)}
      />
    </a>
  );
}

/**
 * The PR a card leads to, drawn as the chip every other PR surface draws (the
 * session header, the status strip, a series row) rather than the dim text
 * link the cards used to end on. It costs the footer nothing: the number is
 * the PR's identity and the colour is its state, so the same width now says
 * which PR and how it stands.
 *
 * A pill, not the header's split button. There the two halves lead to two
 * places (the Review tab, then the provider); a card has only the one
 * destination to offer, so a seam would promise a second.
 */
export function CardPrChip({
  url,
  number,
  tone,
}: {
  url: string;
  number?: number | null;
  tone: PrTone;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open on ${providerFromUrl(url).name}`}
      className={prChipClass(tone, "card")}
    >
      {/* Cap band, so the number centres on the chip the way the action
			    button beside it centres its word. */}
      <span className={CAP_LABEL}>{number != null ? `#${number}` : "PR"}</span>
      <IconArrowUpRight
        size={15}
        className={mergeStylexOverrideClassName("", sx.opacity70)}
      />
    </a>
  );
}

/** The strip every card ends on: where this row leads on the left, and for the
 *  cards that still date themselves, when it last changed on the right. No rule
 *  above it: the card is 300px wide and everything in it is already ranged
 *  left, so a full-width line splits a small card in two to separate things
 *  nothing was confusing, and the gap does that on its own. */
export function CardFooter({
  children,
  time,
  timeTitle,
}: {
  /** Leading content — the CardLink, and for the workspace card its action. */
  children?: React.ReactNode;
  /** Omit it and the card ends on its actions; a card with neither ends on
   *  its content rather than on an empty strip's top margin. */
  time?: string;
  timeTitle?: string;
}) {
  // Not `!children`: a caller's children are a live array whose entries are
  // all conditional, so a footer with nothing to show still arrives truthy.
  // Children.toArray drops exactly the ones that render nothing.
  if (React.Children.toArray(children).length === 0 && !time) return null;
  return (
    <div {...stylex.props(sx.mt35, sx.flex, sx.minW0, sx.itemsCenter, sx.gap2)}>
      {children}
      {time && (
        <span
          {...stylex.props(
            sx.mlAuto,
            sx.shrink0,
            sx.textFaint,
            typography.meta,
          )}
          title={timeTitle}
        >
          {time}
        </span>
      )}
    </div>
  );
}

// ── Pull request ────────────────────────────────────────────────────────────

/**
 * The latest automated review's score and verdict. The score stays visible in
 * session and workspace hover cards so a PR's merge-safety reading does not
 * depend on discovering a nested browser tooltip. A blocking count changes what
 * to do next, so that stays out loud too. Tone follows the verdict; a review the
 * branch has moved past goes faint and says so rather than lending a stale
 * verdict the same weight.
 */
export function osReviewLabel(review: OsReview): React.ReactNode {
  const tone =
    review.verdict === "approve"
      ? utilityClassName("text-green")
      : review.verdict === "request_changes"
        ? utilityClassName("text-red")
        : utilityClassName("text-dim");
  return (
    <span
      className={review.stale ? utilityClassName("text-faint") : tone}
      title={
        review.stale
          ? `Reviewed ${relativeTime(review.at)}, on a commit this branch has moved past`
          : `Reviewed ${relativeTime(review.at)}`
      }
    >
      {osReviewText(review)}
    </span>
  );
}

/** Shared with the session card, so one PR's checks read the same wherever the
 *  sidebar surfaces it. */
export function checksLabel(
  checks: OpenPr["checks"] | undefined,
): React.ReactNode {
  if (!checks || checks.total === 0) return null;
  if (checks.failed > 0)
    return <span {...stylex.props(sx.textRed)}>{checks.failed} failing</span>;
  if (checks.pending > 0)
    return (
      <span {...stylex.props(sx.textYellow)}>{checks.pending} running</span>
    );
  return (
    <span {...stylex.props(sx.textGreen)}>all {checks.total} passing</span>
  );
}

/** A status worth calling out in the card's callout strip rather than a row. */
function prProblem(item: ReviewQueueItem): string | null {
  const s = item.status;
  if (!s) return null;
  if (
    s.includes("failing") ||
    s === "Merge conflict" ||
    s === "Changes requested"
  )
    return s;
  return null;
}

/** The queue's own status, said out loud. The ready bucket's raw statuses are
 *  internal shorthand ("Green"), so they get spelled out here. */
function prState(
  item: ReviewQueueItem,
): { label: string; tone: HoverTone } | null {
  if (item.bucket === "ready")
    return {
      label:
        item.status === "Approved"
          ? "Approved · ready to merge"
          : "Ready to merge",
      tone: "green",
    };
  if (!item.status) return null;
  return {
    label: item.status,
    tone: item.bucket === "attention" ? "yellow" : "dim",
  };
}

/** The card body for a Pull requests row. Everything comes off the already
 *  loaded queue item — like SessionHoverCard, the card fetches nothing. */
export function PrRowCard({ item }: { item: ReviewQueueItem }) {
  const pr = item.pr;
  const problem = prProblem(item);
  const state = prState(item);
  const rows: Array<[string, React.ReactNode]> = [
    ["Author", pr.author],
    ["Repo", pr.repo],
  ];
  if (pr.reviewDecision) rows.push(["Review", prettyReview(pr.reviewDecision)]);
  if (pr.osReview) rows.push(["OS review", osReviewLabel(pr.osReview)]);
  const checks = checksLabel(pr.checks);
  if (checks) rows.push(["Checks", checks]);
  if (pr.reviewRequested?.length)
    rows.push(["Requested", pr.reviewRequested.join(", ")]);
  rows.push(["Opened", relativeTime(pr.createdAt)]);

  return (
    <>
      <div {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap7px)}>
        <span
          {...stylex.props(
            sx.minW0,
            sx.flex1,
            sx.truncate,
            sx.textDim,
            typography.meta,
          )}
        >
          {pr.branch}
        </span>
        {pr.isDraft && (
          <span {...stylex.props(sx.shrink0, sx.textFaint, typography.meta)}>
            draft
          </span>
        )}
        <span {...stylex.props(sx.flex, sx.shrink0, sx.itemsCenter)}>
          {item.bucket === "ready" ? (
            <IconGitMerge
              className={mergeStylexOverrideClassName("", sx.textGreen)}
              size={20}
            />
          ) : (
            <span
              className={utilityClassName(
                `size-[7px] rounded-full ${
                  item.bucket === "attention" ? "bg-yellow" : "bg-faint"
                }`,
              )}
            />
          )}
        </span>
      </div>

      <div
        {...stylex.props(
          sx.mt5px,
          sx.fontSemibold,
          sx.leading13,
          typography.label,
        )}
      >
        {pr.title}
      </div>

      {problem ? (
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
          {problem}
        </div>
      ) : (
        state && (
          <div
            className={utilityClassName(
              `mt-[3px] text-meta font-medium ${TONE_TEXT[state.tone]}`,
            )}
          >
            {state.label}
          </div>
        )
      )}

      {pr.reviewActive && (
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
          An automated review is still running.
        </div>
      )}

      <CardRows rows={rows} />

      <CardFooter
        time={`Updated ${relativeTime(pr.updatedAt)}`}
        timeTitle={new Date(pr.updatedAt).toLocaleString()}
      >
        <CardPrChip url={pr.url} number={pr.number} tone={refTone(pr)} />
      </CardFooter>
    </>
  );
}

// ── Support ticket ──────────────────────────────────────────────────────────

// Mirrors SUPPORT_PRIORITY_GROUPS in Sidebar.tsx (Plain priorities are ints
// 0..3, unset buckets as Normal); kept local so the card file doesn't import
// the sidebar that renders it.
const PRIORITY_META: Record<number, { label: string; cls: string }> = {
  0: { label: "Urgent", cls: "text-red" },
  1: { label: "High", cls: "text-yellow" },
  2: { label: "Normal", cls: "text-blue" },
  3: { label: "Low", cls: "text-faint" },
};

/** The card body for a Support row. `previewText` is the ticket's equivalent
 *  of the workspace card's latest-message line — the "where things stand"
 *  snippet that makes the queue skimmable without opening each thread. */
export function SupportRowCard({
  thread: t,
  session,
}: {
  thread: SupportThread;
  session: UnifiedSession | null;
}) {
  const customer = t.customer.name || t.customer.email || "Unknown";
  const priority = PRIORITY_META[t.priority ?? 2] || PRIORITY_META[2];
  const preview = (t.previewText || "").replace(/\s+/g, " ").trim();
  const labels = t.labels || [];
  const stamp = t.statusChangedAt || t.createdAt;

  const rows: Array<[string, React.ReactNode]> = [];
  // Plain often stores the address as the name too, so only spell the email
  // out when the head isn't already showing it.
  if (t.customer.email && t.customer.email !== customer)
    rows.push(["Email", t.customer.email]);
  rows.push([
    "Assignee",
    t.assignee ? (
      t.assignee.name
    ) : (
      <span {...stylex.props(sx.textFaint)}>unassigned</span>
    ),
  ]);
  if (session) rows.push(["Session", session.title]);
  if (t.createdAt) rows.push(["Opened", relativeTime(t.createdAt)]);

  return (
    <>
      <div {...stylex.props(sx.flex, sx.minW0, sx.itemsCenter, sx.gap7px)}>
        <span
          {...stylex.props(
            sx.minW0,
            sx.flex1,
            sx.truncate,
            sx.textDim,
            typography.meta,
          )}
        >
          {customer}
        </span>
        <span
          className={utilityClassName(`shrink-0 text-meta ${priority.cls}`)}
        >
          {priority.label}
        </span>
      </div>

      <div
        {...stylex.props(
          sx.mt5px,
          sx.fontSemibold,
          sx.leading13,
          typography.label,
        )}
      >
        {t.title || customer}
      </div>

      {preview && (
        <div
          {...mergeStylexProps(
            "selectable",
            sx.mt1,
            sx.leadingSnug,
            sx.textDim,
            sx.lineClamp3,
            typography.meta,
          )}
        >
          {preview}
        </div>
      )}

      {labels.length > 0 && (
        <div {...stylex.props(sx.mt2, sx.flex, sx.flexWrap, sx.gap1)}>
          {labels.map((l) => (
            <span
              key={l.id}
              {...stylex.props(
                sx.roundedSm,
                sx.border,
                sx.borderLine,
                sx.bgSurface,
                sx.px15,
                sx.py05,
                sx.textDim,
                typography.meta,
              )}
            >
              {l.icon ? `${l.icon} ` : ""}
              {l.name}
            </span>
          ))}
        </div>
      )}

      <CardRows rows={rows} />

      <CardFooter
        time={stamp ? `Updated ${relativeTime(stamp)}` : ""}
        timeTitle={stamp ? new Date(stamp).toLocaleString() : undefined}
      >
        <CardLink href={plainThreadUrl(t.id)}>Open in Plain</CardLink>
      </CardFooter>
    </>
  );
}
