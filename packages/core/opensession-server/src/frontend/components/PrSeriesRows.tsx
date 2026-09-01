import { utilityClassName } from "../ui/cn";
import { repoLabel } from "../lib/repo-label";
import { Tooltip } from "../ui/tooltip";
import { providerFromUrl } from "../lib/provider";
import {
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
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  textDim: {
    color: "var(--text-dim)",
  },
});

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
export function PrSeriesRow({
  prRef,
  primaryRepo,
  onOpen,
  variant = "bar",
}: {
  prRef: SessionPrRef;
  /** The session's own repo. A PR inside it needs no repo hint on its chip. */
  primaryRepo?: string;
  onOpen?: (r: { repo: string; branch: string }) => void;
  variant?: "bar" | "summary";
}) {
  const tone = refTone(prRef);
  const provider = providerFromUrl(prRef.url || "");
  const target = { repo: prRef.repo, branch: prRef.branch };
  const ariaLabel = `Review ${repoLabel(prRef.repo)} pull request #${prRef.number}`;
  if (variant === "summary") {
    const body = (
      <>
        <span className={WS_SUMMARY_RAIL}>
          <IconPullRequest size={20} className={WS_SUMMARY_ICON} />
        </span>
        <span className={WS_SUMMARY_LABEL}>
          {refChipText(prRef, primaryRepo)}
          {prRef.title && (
            <span {...stylex.props(sx.textDim)}> · {prRef.title}</span>
          )}
        </span>
        <span className={cn(WS_SUMMARY_STATE, PR_STATE_TEXT[tone])}>
          {refState(prRef)}
        </span>
      </>
    );
    const className = cn(
      WS_SUMMARY_ROW,
      utilityClassName("gap-2 no-underline"),
    );
    const title = refLabel(prRef);
    if (prRef.url) {
      return (
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
        </a>
      );
    }
    return (
      <button
        type="button"
        className={className}
        data-tone={tone}
        title={title}
        aria-label={ariaLabel}
        onClick={() => onOpen?.(target)}
      >
        {body}
      </button>
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
}: {
  refs: SessionPrRef[];
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
        />
      ))}
    </>
  );
}
