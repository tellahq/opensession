/**
 * Fix each: one session per task a report proposes.
 *
 * A report that finds twenty things is a list of twenty units of work, and
 * handing all twenty to one session produces one branch nobody can review.
 * This picks them apart: each task starts its own session, in its own
 * workspace, on its own worktree, so they can be read and tested one at a
 * time.
 *
 * The picker is the point, not decoration. A report proposes everything it
 * found, and the honest thing to do with most of them is start six.
 */

import React, { useState } from "react";
import { startReportSessions, type StartedReportSession } from "../lib/api";
import type { ReportMeta } from "../lib/types";
import { errorMessage } from "../lib/error-message";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Modal, useEnterOnMount } from "../ui/modal";
import { Spinner } from "../ui/spinner";
import { InlineAlert } from "../ui/state";
import { toast } from "../ui/toast";

export function ReportTasksDialog({
  report,
  onClose,
}: {
  report: ReportMeta;
  onClose: () => void;
}) {
  const tasks = report.tasks || [];
  const [picked, setPicked] = useState<Set<number>>(
    () => new Set(tasks.map((_, index) => index)),
  );
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState<StartedReportSession[]>([]);
  const open = useEnterOnMount();

  const toggle = (index: number) =>
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(index)) next.add(index);
      return next;
    });

  async function start() {
    setStarting(true);
    setFailed([]);
    await (async () => {
      const results = await startReportSessions(
        report.automationId,
        report.id,
        [...picked].sort((a, b) => a - b),
      );
      const started = results.filter((result) => result.id);
      if (started.length)
        toast(
          `Started ${started.length} session${started.length === 1 ? "" : "s"}`,
        );
      const errors = results.filter((result) => !result.id);
      // Partial failure keeps the dialog open: the sessions that did start
      // are already in the sidebar, and the ones that did not are the only
      // thing left to say.
      if (!errors.length) return onClose();
      setFailed(errors);
      setPicked(new Set(errors.map((result) => result.task)));
    })()
      .catch(async (error) => {
        setFailed([
          {
            task: -1,
            title: "",
            error: errorMessage(error, "Failed to start sessions"),
          },
        ]);
      })
      .finally(async () => {
        setStarting(false);
      });
  }

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !starting) onClose();
      }}
      disablePointerDismissal={starting}
    >
      <Modal.Content widthClassName="max-w-[34rem]">
        <Modal.Header
          title="Fix each"
          description="Every task starts its own session, workspace and branch, so you can review and test them one at a time."
        />

        {/* The list scrolls inside the dialog rather than growing it, so a
				    report with twenty tasks still leaves the footer on screen. */}
        <div className="-mx-1 flex max-h-[46dvh] min-h-0 flex-col gap-0.5 overflow-y-auto overscroll-contain px-1">
          {tasks.map((task, index) => (
            <label
              key={index}
              className="flex cursor-pointer items-start gap-2.5 rounded-control px-2 py-2 hover:bg-hover"
            >
              <Checkbox
                className="mt-0.5"
                checked={picked.has(index)}
                onCheckedChange={() => toggle(index)}
                disabled={starting}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm leading-snug text-fg">
                  {task.title}
                </span>
                {/* No `block` beside the clamp: both set `display`, and the
								    plain one wins, which silently unclamps the preview. */}
                <span className="mt-0.5 line-clamp-2 text-supporting leading-normal text-faint">
                  {task.prompt}
                </span>
              </span>
            </label>
          ))}
        </div>

        {failed.length > 0 && (
          <InlineAlert>
            {failed.length === 1 && failed[0].task < 0
              ? failed[0].error
              : `${failed.length} didn't start: ${failed
                  .map((result) => `${result.title} (${result.error})`)
                  .join(", ")}`}
          </InlineAlert>
        )}

        <Modal.Footer>
          <span className="mr-auto text-meta text-faint">
            {starting ? (
              <span className="flex items-center gap-2">
                <Spinner size="sm" />
                Starting {picked.size} session{picked.size === 1 ? "" : "s"}
              </span>
            ) : (
              `${picked.size} of ${tasks.length} selected`
            )}
          </span>
          <Button variant="soft" onClick={onClose} disabled={starting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={start}
            disabled={starting || picked.size === 0}
          >
            Start {picked.size} session{picked.size === 1 ? "" : "s"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
