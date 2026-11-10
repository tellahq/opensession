import type React from "react";
import type { PrStatusMark } from "../../lib/pr-status";
import { GIT_DOT, GIT_DOT_BG } from "../../lib/pr-tone-classes";
import type { PrDetails, PrReviewer } from "../../lib/types";
import { cn } from "../../ui/cn";
import { IconCheck, IconClock, IconX } from "../icons";
import { type GitStatusRowsProps, useGitStatusRows } from "./GitStatus";
import { PrStateIcon } from "./PrStateIcon";

export interface MergeBoxChecks {
  passed: number;
  failed: number;
  pending: number;
  total: number;
}

/**
 * The overview's opening card, after GitHub's merge box: whether the pull
 * request can land, the one action that moves it, what still stands in the
 * way (behind the base, unpushed or uncommitted work), and a three-part
 * readout of checks, comments and approvals.
 *
 * It replaces the rail's Status section while the rail sits beside the
 * conversation. Stacked above it, the rail keeps that section and this card
 * does not render, so the status reads once at every width.
 */
export function MergeBox({
  status,
  statusMark,
  checks,
  showChecks,
  showApprovals,
  commentCount,
  onShowChecks,
  onShowComments,
  error,
  inPopover,
}: {
  status: GitStatusRowsProps;
  statusMark: PrStatusMark;
  checks: MergeBoxChecks;
  showChecks: boolean;
  showApprovals: boolean;
  commentCount: number;
  onShowChecks: () => void;
  onShowComments: () => void;
  error?: string | null;
  /** Drawn inside the bar's Merge status popover: the popup is the surface. */
  inPopover?: boolean;
}) {
  const pr = status.pr;
  const { rows, notes } = useGitStatusRows({ ...status, emphasis: true });
  if (!pr) return null;
  const lead = rows[0]?.key === "pr-status" ? rows[0] : undefined;
  const rest = lead ? rows.slice(1) : rows;
  const headline = lead?.label ?? "Open";
  return (
    <section
      aria-label="Merge status"
      className={
        inPopover
          ? "w-[440px] min-w-0 max-w-full"
          : // The conversation's own measure, so the box and the description
            // under it share both edges.
            "mx-auto w-full min-w-0 max-w-[760px] overflow-hidden rounded-xl bg-panel"
      }
    >
      <div className="flex items-center gap-3 px-4 py-3.5">
        <span
          aria-hidden
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-full",
            statusMark.bgClassName,
            statusMark.className,
          )}
        >
          <MergeStatusIcon pr={pr} tone={statusMark.tone} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 truncate text-body font-semibold text-fg">
            {headline}
          </h2>
          <p className="m-0 truncate text-supporting text-dim">
            {summaryLine(pr, checks)}
          </p>
        </div>
        {lead?.action}
      </div>
      {/* The branch's own discrepancies, one action each. Empty (and hidden)
          on a branch that is level with its remote and its base. */}
      <div className="border-t border-divider px-2 py-1.5 empty:hidden">
        {rest.map((row) => (
          <div
            key={row.key}
            className="flex min-h-8 items-center gap-2 px-2 text-label text-fg"
          >
            <span
              className={`${GIT_DOT} ${GIT_DOT_BG[row.tone]}`}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            {row.action}
          </div>
        ))}
        {notes}
      </div>
      {error && (
        <p role="alert" className="m-0 px-4 pb-2 text-supporting text-red">
          {error}
        </p>
      )}
      <div
        className={`grid border-t border-divider ${showChecks && showApprovals ? "grid-cols-3" : showChecks || showApprovals ? "grid-cols-2" : "grid-cols-1"}`}
      >
        {showChecks && (
          <ReadoutCell
            label="Checks"
            value={checksValue(checks)}
            onClick={checks.total > 0 ? onShowChecks : undefined}
          >
            <ChecksBar checks={checks} />
          </ReadoutCell>
        )}
        <ReadoutCell
          label="Comments"
          value={
            commentCount === 0
              ? "None yet"
              : `${commentCount} comment${commentCount === 1 ? "" : "s"}`
          }
          onClick={commentCount > 0 ? onShowComments : undefined}
        />
        {showApprovals && (
          <ReadoutCell label="Approvals" value={approvalsValue(pr)} />
        )}
      </div>
    </section>
  );
}

/** The state as one glyph: the merge box's lead, and the bar's Merge status. */
export function MergeStatusIcon({
  pr,
  tone,
}: {
  pr: Pick<PrDetails, "state" | "isDraft">;
  tone: PrStatusMark["tone"];
}) {
  if (pr.state !== "OPEN" || pr.isDraft)
    return <PrStateIcon state={pr.state} isDraft={pr.isDraft} />;
  if (tone === "green") return <IconCheck size={18} />;
  if (tone === "red") return <IconX size={18} />;
  if (tone === "yellow") return <IconClock size={18} />;
  return <PrStateIcon state={pr.state} />;
}

/** One line under the headline: what the reader would check next. */
function summaryLine(pr: PrDetails, checks: MergeBoxChecks): string {
  if (pr.state === "MERGED") return `Merged into ${pr.baseRefName}`;
  if (pr.state === "CLOSED") return "Closed without merging";
  if (pr.isDraft) return "Mark it ready for review before it can merge";
  if (pr.mergeable === "CONFLICTING")
    return `Conflicts with ${pr.baseRefName} must be resolved first`;
  if (checks.failed > 0)
    return `${checks.failed} failing check${checks.failed === 1 ? "" : "s"}`;
  const decision = (pr.reviewDecision || "").toUpperCase();
  if (decision === "CHANGES_REQUESTED") return "A reviewer asked for changes";
  if (checks.pending > 0)
    return `${checks.pending} check${checks.pending === 1 ? "" : "s"} still running`;
  if (decision === "REVIEW_REQUIRED") return "Waiting on a required review";
  return "All requirements are met";
}

function checksValue(checks: MergeBoxChecks): string {
  if (checks.total === 0) return "No checks";
  if (checks.failed > 0) return `${checks.failed} failed of ${checks.total}`;
  if (checks.pending > 0) return `${checks.pending} running of ${checks.total}`;
  return `${checks.passed} passed`;
}

function approvalsValue(pr: PrDetails): string {
  const reviewers: PrReviewer[] = pr.reviewers ?? [];
  const approved = reviewers.filter((r) => r.state === "APPROVED").length;
  const changes = reviewers.filter(
    (r) => r.state === "CHANGES_REQUESTED",
  ).length;
  if (changes > 0) return "Changes requested";
  if (approved > 0) return `${approved} approved`;
  if ((pr.reviewDecision || "").toUpperCase() === "REVIEW_REQUIRED")
    return "Review required";
  return "None yet";
}

/** The checks' share of passed, failing and running, as one thin bar. */
function ChecksBar({ checks }: { checks: MergeBoxChecks }) {
  if (checks.total === 0) return null;
  const pct = (n: number) => `${(100 * n) / checks.total}%`;
  return (
    <span
      aria-hidden
      className="mt-2 flex h-1 w-full overflow-hidden rounded-[999px] bg-active"
    >
      <span className="bg-green" style={{ width: pct(checks.passed) }} />
      <span className="bg-red" style={{ width: pct(checks.failed) }} />
      <span className="bg-yellow" style={{ width: pct(checks.pending) }} />
    </span>
  );
}

function ReadoutCell({
  label,
  value,
  onClick,
  children,
}: {
  label: string;
  value: string;
  onClick?: () => void;
  children?: React.ReactNode;
}) {
  const body = (
    <>
      <span className="block text-meta font-semibold text-faint">{label}</span>
      <span className="mt-0.5 block truncate text-label text-fg">{value}</span>
      {children}
    </>
  );
  const cell =
    "flex min-w-0 flex-col items-stretch justify-start border-l border-divider px-4 py-2.5 text-left first:border-l-0";
  return onClick ? (
    <button
      type="button"
      className={`${cell} cursor-pointer border-y-0 border-r-0 bg-transparent hover:bg-hover`}
      onClick={onClick}
    >
      {body}
    </button>
  ) : (
    <div className={cell}>{body}</div>
  );
}
