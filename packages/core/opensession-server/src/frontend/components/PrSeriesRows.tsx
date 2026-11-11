import type React from "react";
import { useEffect, useState } from "react";
import { repoLabel } from "../lib/repo-label";
import { Tooltip } from "../ui/tooltip";
import { providerFromUrl } from "../lib/provider";
import {
  refAction,
  refChipText,
  refLabel,
  refState,
  refTone,
  type SessionPrRef,
} from "../lib/pr-refs";
import {
  prChipClass,
  PR_ROW,
  PR_ROW_BG,
  PR_ROW_MAIN,
  PR_ROW_OUT,
  PR_ROW_STATE,
  PR_ROW_TITLE,
  PR_STATE_TEXT,
} from "../lib/pr-tone-classes";
import {
  WS_SUMMARY_ICON,
  WS_SUMMARY_LABEL,
  WS_SUMMARY_RAIL,
  WS_SUMMARY_ROW,
  WS_SUMMARY_STATE,
} from "../lib/workspace-summary-classes";
import { cn } from "../ui/cn";
import { IconArrowUpRight, IconPullRequest } from "./icons";
import { PrRefStagingMark, usePrRefStaging } from "./PrRefStagingMark";

/**
 * The PRs a session owns beyond the one its own branch carries, stacked under
 * the primary status strip — a feature shipped as four PRs gets four rows.
 *
 * Each row repeats the strip's anatomy one weight down: toned number chip on
 * the left where the primary's chip sits, title in the middle, toned state on
 * the right. That's the whole idea — the series should read as more of the same
 * status treatment, not as a second card stapled under the strip, so the rows
 * carry no surface of their own and take their colour from the parts that mean
 * something. Four chips crammed into the primary line was the first attempt and
 * it read as noise; a row each stays legible at four PRs.
 *
 * Kept out of PrStatusBar so the multi-PR presentation renders (and is tested)
 * without the strip's PR/git fetching.
 */

/** Ref-only, so no per-row Merge: the row opens that PR's Review tab, which has
 *  the real detail (checks, mergeability) merging needs. */
/** A row's fix: the band's action one size down, to fit a 31px row. */
const ROW_ACTION =
  "inline-flex h-6 shrink-0 items-center rounded-control border px-2 text-meta font-semibold whitespace-nowrap " +
  "transition-[background-color,filter] duration-150 focus-ring disabled:cursor-default disabled:opacity-60";
const ROW_ACTION_TONE = {
  red: "border-[color-mix(in_srgb,var(--red)_78%,black)] bg-[var(--red)] text-white hover:brightness-[1.08]",
  "status-red":
    "border-[color-mix(in_srgb,var(--red)_45%,transparent)] bg-[color-mix(in_srgb,var(--red)_12%,var(--control-surface))] text-red hover:bg-red-soft",
} as const;

export function PrSeriesRow({
  prRef,
  primaryRepo,
  onOpen,
  variant = "bar",
  sessionId,
  refreshTick,
  onPrompt,
}: {
  prRef: SessionPrRef;
  /** Summary variant: asks the session to fix this PR (its row's action). */
  onPrompt?: (content: string) => void;
  /** Summary variant: the session whose PR API reads this row's preview. */
  sessionId?: string;
  refreshTick?: number;
  /** The session's own repo. A PR inside it needs no repo hint on its chip. */
  primaryRepo?: string;
  onOpen?: (r: { repo: string; branch: string }) => void;
  variant?: "bar" | "summary";
}) {
  const tone = refTone(prRef);
  const staging = usePrRefStaging(
    variant === "summary" ? sessionId : undefined,
    prRef,
    refreshTick,
  );
  const action = variant === "summary" && onPrompt ? refAction(prRef) : null;
  const [prompted, setPrompted] = useState(false);
  useEffect(() => {
    if (!prompted) return;
    const timer = setTimeout(() => setPrompted(false), 6000);
    return () => clearTimeout(timer);
  }, [prompted]);
  const provider = providerFromUrl(prRef.url || "");
  const target = { repo: prRef.repo, branch: prRef.branch };
  const ariaLabel = `Review ${repoLabel(prRef.repo)} pull request #${prRef.number}`;
  if (variant === "summary") {
    const body = (
      <>
        <span className={WS_SUMMARY_RAIL}>
          {!staging && (
            <IconPullRequest size={20} className={WS_SUMMARY_ICON} />
          )}
        </span>
        <span className={WS_SUMMARY_LABEL}>
          {refChipText(prRef, primaryRepo)}
          {prRef.title && <span className="text-dim"> · {prRef.title}</span>}
        </span>
        {action ? (
          // Holds the action's room so the title truncates before it.
          <span
            aria-hidden="true"
            className={cn(ROW_ACTION, "invisible border-transparent")}
          >
            {prompted ? action.pending : action.label}
          </span>
        ) : (
          <span className={cn(WS_SUMMARY_STATE, PR_STATE_TEXT[tone])}>
            {refState(prRef)}
          </span>
        )}
      </>
    );
    const className = cn(WS_SUMMARY_ROW, "gap-2 no-underline");
    const title = refLabel(prRef);
    // The preview link takes the PR glyph's place in the rail, the way the
    // primary band leads with its globe, and the fix takes the state's place
    // on the right, the way the band ends in its action. Both sit over the
    // row rather than inside it: the row is itself a link, and links and
    // buttons do not nest.
    const withPreview = (row: React.ReactNode) =>
      staging || action ? (
        <div className="relative flex min-w-0">
          {row}
          {staging && (
            <PrRefStagingMark
              staging={staging}
              number={prRef.number}
              className="absolute left-3 top-1/2 -translate-y-1/2"
            />
          )}
          {action && (
            <button
              type="button"
              className={cn(
                ROW_ACTION,
                ROW_ACTION_TONE[action.tone],
                "absolute right-4 top-1/2 -translate-y-1/2",
              )}
              title={refLabel(prRef)}
              disabled={prompted}
              onClick={() => {
                onPrompt?.(action.prompt);
                setPrompted(true);
              }}
            >
              {prompted ? action.pending : action.label}
            </button>
          )}
        </div>
      ) : (
        row
      );
    if (prRef.url) {
      return withPreview(
        <a
          className={className}
          href={prRef.url}
          target="_blank"
          rel="noopener"
          data-tone={tone}
          title={title}
          aria-label={ariaLabel}
          onClick={(event) => {
            if (
              !onOpen ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            onOpen(target);
          }}
        >
          {body}
        </a>,
      );
    }
    return withPreview(
      <button
        type="button"
        className={className}
        data-tone={tone}
        title={title}
        aria-label={ariaLabel}
        onClick={() => onOpen?.(target)}
      >
        {body}
      </button>,
    );
  }
  return (
    <div className={`${PR_ROW} ${PR_ROW_BG[tone]}`} data-tone={tone}>
      <button
        type="button"
        className={PR_ROW_MAIN}
        onClick={() => onOpen?.(target)}
        title={`${refLabel(prRef)} · open in the PR tab`}
        aria-label={ariaLabel}
      >
        <span className={prChipClass(tone, "row")}>
          {refChipText(prRef, primaryRepo)}
        </span>
        {prRef.title && <span className={PR_ROW_TITLE}>{prRef.title}</span>}
        <span className={`${PR_ROW_STATE} ${PR_STATE_TEXT[tone]}`}>
          {refState(prRef)}
        </span>
      </button>
      {prRef.url && (
        <Tooltip label={`Open on ${provider.name}`}>
          <a
            className={PR_ROW_OUT}
            href={prRef.url}
            target="_blank"
            rel="noopener"
            aria-label={`Open ${repoLabel(prRef.repo)} pull request #${prRef.number} on ${provider.name}`}
          >
            <IconArrowUpRight size={16} />
          </a>
        </Tooltip>
      )}
    </div>
  );
}

export function PrSeriesRows({
  refs,
  primaryRepo,
  onOpen,
  variant = "bar",
  sessionId,
  refreshTick,
  onPrompt,
}: {
  refs: SessionPrRef[];
  onPrompt?: (content: string) => void;
  sessionId?: string;
  refreshTick?: number;
  primaryRepo?: string;
  onOpen?: (r: { repo: string; branch: string }) => void;
  variant?: "bar" | "summary";
}) {
  if (refs.length === 0) return null;
  return (
    <>
      {refs.map((ref) => (
        <PrSeriesRow
          key={`${ref.repo} ${ref.branch}`}
          prRef={ref}
          primaryRepo={primaryRepo}
          onOpen={onOpen}
          variant={variant}
          sessionId={sessionId}
          refreshTick={refreshTick}
          onPrompt={onPrompt}
        />
      ))}
    </>
  );
}
