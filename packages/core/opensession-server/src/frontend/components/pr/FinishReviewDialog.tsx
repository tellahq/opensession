import { useRef, useState } from "react";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Textarea } from "../../ui/input";
import { Modal, useEnterOnMount } from "../../ui/modal";

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

interface Props {
  prNumber: number;
  pendingCount: number;
  event: ReviewEvent;
  onEventChange: (event: ReviewEvent) => void;
  defaultSummary: string;
  canMerge: boolean;
  onFixChecks?: (summary: string) => void;
  mergeAfterReview: boolean;
  onMergeAfterReviewChange: (merge: boolean) => void;
  error: string | null;
  submitting: boolean;
  submitLabel: string;
  onSubmit: (summary: string) => void;
  onClose: (summary: string) => void;
}

/**
 * The review canvas' "Finish review" dialog: pick a verdict, add an optional
 * summary, submit.
 *
 * Approving and merging are separate decisions, so they are separate controls.
 * The verdict rows are the choice; merging is an opt-in that starts off, which
 * keeps the primary action "Approve" until someone asks for more.
 *
 * The summary is held here rather than by the canvas: the canvas re-renders the
 * whole diff, and this is a field someone types a paragraph into. It is seeded
 * from `defaultSummary` and handed back on both exits, so closing the dialog
 * and reopening it still finds the draft.
 */
export function FinishReviewDialog({
  prNumber,
  pendingCount,
  event,
  onEventChange,
  defaultSummary,
  canMerge,
  onFixChecks,
  mergeAfterReview,
  onMergeAfterReviewChange,
  error,
  submitting,
  submitLabel,
  onSubmit,
  onClose,
}: Props) {
  const [summary, setSummary] = useState(defaultSummary);
  const open = useEnterOnMount();
  // Without this Base UI focuses the first tabbable, which is the header's
  // close. A focus ring on the ✕ is the wrong first read for a dialog you
  // opened in order to write in it.
  const summaryRef = useRef<HTMLTextAreaElement>(null);
  const verdicts: Array<{ event: ReviewEvent; label: string; hint: string }> = [
    { event: "APPROVE", label: "Approve", hint: "Sign off on these changes" },
    {
      event: "COMMENT",
      label: "Comment",
      hint: "Leave feedback without a verdict",
    },
    {
      event: "REQUEST_CHANGES",
      label: "Request changes",
      hint: "Ask for another pass before merging",
    },
  ];
  return (
    <Modal.Root open={open} onOpenChange={(next) => !next && onClose(summary)}>
      <Modal.Content
        widthClassName="max-w-[30rem]"
        className="bottom-[max(1rem,env(safe-area-inset-bottom))] left-auto right-4 top-auto translate-x-0 translate-y-0 origin-bottom-right phone:left-1/2 phone:right-auto phone:-translate-x-1/2 phone:origin-bottom"
        initialFocus={summaryRef}
      >
        <Modal.Header
          title="Finish review"
          description={
            pendingCount > 0
              ? `Your ${pendingCount} pending comment${pendingCount === 1 ? "" : "s"} on #${prNumber} are sent with this review.`
              : `Leave a review on #${prNumber}.`
          }
        />
        <div
          className="flex flex-col gap-1.5"
          role="radiogroup"
          aria-label="Review verdict"
        >
          {verdicts.map((verdict) => (
            <button
              key={verdict.event}
              type="button"
              role="radio"
              aria-checked={event === verdict.event}
              data-active={event === verdict.event || undefined}
              className="group focus-ring flex cursor-pointer items-start gap-2.5 rounded-row border border-line bg-surface px-3 py-2.5 text-left transition-[background-color,border-color] hover:bg-hover data-active:border-accent data-active:bg-accent-soft"
              onClick={() => onEventChange(verdict.event)}
            >
              <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded-full border border-line-strong transition-colors group-data-active:border-accent group-data-active:bg-accent">
                <span className="size-1.5 rounded-full bg-on-accent opacity-0 group-data-active:opacity-100" />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-label font-semibold text-fg">
                  {verdict.label}
                </span>
                <span className="text-supporting text-dim">{verdict.hint}</span>
              </span>
            </button>
          ))}
        </div>
        <Textarea
          ref={summaryRef}
          size="sm"
          className="h-20 resize-none"
          placeholder={
            event === "APPROVE" || pendingCount > 0
              ? "Summary (optional)"
              : "Summary"
          }
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
        {event === "APPROVE" &&
          canMerge && (
            // Quieter than the verdict rows on purpose: merging is an extra you
            // opt into here, not a fourth thing to choose between.
            <label className="flex cursor-pointer items-center gap-2.5 px-0.5">
              <Checkbox
                checked={mergeAfterReview}
                onCheckedChange={onMergeAfterReviewChange}
              />
              <span className="text-supporting text-dim">
                Squash and merge as well
              </span>
            </label>
          )}
        {event === "APPROVE" && !canMerge && onFixChecks && (
          <div className="flex items-center justify-between gap-3 rounded-row bg-red-soft px-3 py-2">
            <span className="text-supporting text-red">
              Checks must pass before you can merge.
            </span>
            <Button
              variant="danger"
              size="sm"
              className="shrink-0"
              onClick={() => onFixChecks(summary)}
            >
              Fix checks
            </Button>
          </div>
        )}
        {error && <div className="text-supporting text-red">{error}</div>}
        <Modal.Footer>
          <Button onClick={() => onClose(summary)}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => onSubmit(summary)}
            disabled={submitting}
          >
            {submitting ? "Submitting…" : submitLabel}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
