import React, { useState } from "react";
import type { WorkflowRunSnapshot } from "../../server/workflow-types";
import type { SessionSubagentSnapshot } from "../lib/api";
import {
  currentPlanItem,
  planDoneCount,
  type PlanItem,
} from "@tellahq/opensession-protocol/todo-plan";
import { composerFlapBorder } from "../lib/composer-classes";
import { cn } from "../ui/cn";
import { IconChevronDown, IconChevronRight } from "./icons";
import { PlanChecklist } from "./PlanChecklist";

/**
 * The run-status flap above the composer: what this session is doing right
 * now, as a three-step progression.
 *
 *   collapsed pill  →  expanded mini-card  →  full Agents panel
 *
 * It carries two things the transcript hides:
 *
 * - **Plan** — the model's own `todowrite` checklist (packages/core/protocol/src/todo-plan.ts).
 *   Otherwise it exists only as one dim row inside a collapsed turn fold, so
 *   this is its only glance. Shown at every width, and only while the run is
 *   live (the caller gates that) — a finished turn's plan belongs to the
 *   transcript.
 * - **Agents** — running workflow runs and task-tool sub-agents. Phone-only,
 *   because on desktop the Agents panel tab is always visible with its own
 *   pulsing dot; on a phone that panel is behind a closed overlay.
 *
 * Either half can be absent: with no agents the card is just the plan, and the
 * "Open full panel" hand-off (which is agent-scoped) drops out with them. The
 * parent unmounts us when both are empty.
 *
 * The queue flap next door is deliberately separate: that one is pending user
 * input with destructive/drag actions, this one is read-only run status.
 */
interface Props {
  runs: WorkflowRunSnapshot[];
  subagents?: SessionSubagentSnapshot[];
  plan?: readonly PlanItem[];
  onOpenPanel: () => void;
}

/** The tally/label subset both agent flavors share. */
interface GlanceAgent {
  key: string;
  label: string;
  status: string;
  phase?: string;
}

// Expanded/collapsed sticks across turns: the flap unmounts whenever the run
// ends, so without this someone watching a long plan re-expands every turn.
const OPEN_KEY = "opensession-composer-status-open";

/** Section caption inside the expanded card (the workflow's name, "Plan · 2/5").
 *  text-meta rather than the stylesheet's off-scale 12px: it is secondary
 *  metadata above the list it labels. */
const sectionName = "truncate text-meta font-semibold text-dim";

/** The live dot. The keyframes stay in the stylesheet (see the report — they
 *  belong in base.css now that no class of ours carries them), and the
 *  reduced-motion blanket in base.css deliberately stops this one. */
const liveDot =
  "flex-none rounded-full bg-yellow animate-[composer-agents-pulse_1.4s_ease-in-out_infinite]";

export function ComposerAgents({ runs, subagents, plan, onOpenPanel }: Props) {
  const [open, setOpen] = useState(
    () => localStorage.getItem(OPEN_KEY) === "1",
  );
  function toggle() {
    setOpen((v) => {
      const next = !v;
      if (next) localStorage.setItem(OPEN_KEY, "1");
      else localStorage.removeItem(OPEN_KEY);
      return next;
    });
  }

  const stats = (() => {
    const agents: GlanceAgent[] = [
      ...runs.flatMap((r) =>
        r.agents.map((a) => ({
          key: `wf-${r.runId}-${a.seq}`,
          label: a.label,
          status: a.status,
          phase: a.phase,
        })),
      ),
      ...(subagents ?? []).map((s, i) => ({
        key: s.id ?? `sub-${i}`,
        label: s.label,
        status: s.status,
      })),
    ];
    const running = agents.filter((a) => a.status === "running");
    const done = agents.filter((a) => a.status === "done").length;
    const pending = agents.filter((a) => a.status === "pending").length;
    const error = agents.filter((a) => a.status === "error").length;
    const single = runs.length === 1 ? runs[0] : null;
    const steps = single?.phases ?? [];
    // currentPhase is a title; its index in the ordered phases list is the
    // step number. -1 (unknown/absent) → treat as the first step.
    const curIdx = single?.currentPhase
      ? Math.max(0, steps.indexOf(single.currentPhase))
      : 0;
    return {
      total: agents.length,
      running,
      runningCount: running.length,
      done,
      pending,
      error,
      single,
      steps,
      curIdx,
      phase: single?.currentPhase,
    };
  })();

  const {
    total,
    running,
    runningCount,
    done,
    pending,
    error,
    single,
    steps,
    curIdx,
    phase,
  } = stats;

  const planItems = plan ?? [];
  const planTotal = planItems.length;
  const planDone = planDoneCount(planItems);
  const planStep = currentPlanItem(planItems);
  const summary = (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2 text-left text-label font-medium text-fg",
        // Open, this row is a control bar under a list that scrolls: without
        // a rule its last clipped item runs straight into it. Same gap + rule
        // + padding the agents section takes from the plan above it.
        open && "border-t border-line pt-2.5",
      )}
      aria-expanded={open}
      aria-label={open ? "Collapse run status" : "Show run status"}
      onClick={toggle}
    >
      {!open && <span className={cn(liveDot, "size-2")} />}
      {total === 0 && (
        <span className="flex-none font-medium text-faint tabular-nums">
          {planDone}/{planTotal}
        </span>
      )}
      {/* flex-auto, not flex-1: with a zero basis the label would only ever
			    take the free space left over, so a long phase name stopped pushing
			    the caret and started truncating a step early. */}
      <span className="min-w-0 flex-auto truncate">
        {total > 0 ? (
          <>
            <strong className="font-semibold">{runningCount} running</strong>
            {total > runningCount ? (
              <span className="font-medium text-faint">
                {" "}
                · {done}/{total} done
              </span>
            ) : null}
            {planTotal > 0 ? (
              <span className="font-medium text-faint">
                {" "}
                · Plan {planDone}/{planTotal}
              </span>
            ) : !open && phase ? (
              <span className="font-medium text-faint"> · {phase}</span>
            ) : null}
          </>
        ) : (
          <strong className="font-semibold">
            {!open && planStep ? planStep : "Plan"}
          </strong>
        )}
      </span>
      {/* Points the way the card moves, not at the content: closed it opens
			    upward, open it folds back down into this row. */}
      <IconChevronDown
        size={16}
        className={cn(
          "flex-none text-faint transition-transform duration-[var(--dur)]",
          !open && "rotate-180",
        )}
      />
    </button>
  );

  return (
    // A flap that folds out from behind the composer: inset from its edges,
    // rounded only on top, bottom tucked under the composer box (negative
    // margin — the composer is a later positioned sibling, so it paints on
    // top).
    //
    // The summary comes LAST, so the detail unfurls above it. Only the flap's
    // top edge moves when it opens (the bottom is pinned to the composer), so
    // a summary rendered first travels the whole height of the plan on every
    // toggle and you have to chase the caret with the mouse to fold back in.
    // Rendered last it sits the same distance above the composer in both
    // states: open and close are the same click, in the same place.
    <div
      className={cn(
        "relative -mb-3.5 flex w-full flex-col gap-2.5 rounded-t-[var(--composer-radius)] border-x border-t bg-[var(--composer-flap-surface)] px-3.5 pt-2.5 pb-[22px] text-label font-medium text-fg",
        composerFlapBorder,
      )}
      data-open={open ? "" : undefined}
    >
      {open && (
        <div className="flex flex-col gap-2.5">
          {planTotal > 0 && (
            // Its own scroller so a long plan doesn't push the composer down.
            <div className="flex max-h-[168px] flex-col gap-[7px] overflow-y-auto">
              {/* The pill right below already reads "Plan · 2/5"; the title
							    only earns its line when there's an agents section under
							    it to be told apart from. */}
              {total > 0 && (
                <div className={sectionName}>
                  Plan · {planDone}/{planTotal}
                </div>
              )}
              <PlanChecklist items={planItems} max={6} live />
            </div>
          )}

          {total > 0 && (
            // Agent half of the card. Carries a rule when the plan sits above
            // it — without one the two sections read as a single list.
            <div
              className={cn(
                "flex flex-col gap-2.5",
                planTotal > 0 && "border-t border-line pt-2.5",
              )}
            >
              <div className={sectionName}>
                {single
                  ? single.name
                  : runs.length > 0
                    ? `${runs.length} workflows active`
                    : "Sub-agents"}
              </div>

              {/* Phase stepper: current step green, past steps checked + dim,
							    future faint. */}
              {steps.length > 1 && (
                <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {steps.map((s, i) => (
                    <li
                      key={s}
                      className={cn(
                        "flex items-center gap-2",
                        i < curIdx && "font-medium text-dim",
                        i === curIdx && "font-semibold text-fg",
                        i > curIdx && "font-medium text-faint",
                      )}
                    >
                      <span
                        className={cn(
                          "inline-flex size-4 flex-none items-center justify-center rounded-full text-[10px] font-semibold",
                          i < curIdx
                            ? "border border-transparent bg-green-soft text-green"
                            : i === curIdx
                              ? "border border-green text-green"
                              : "border border-line",
                        )}
                      >
                        {i < curIdx ? "✓" : i + 1}
                      </span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ol>
              )}

              <div className="flex flex-wrap gap-x-3 gap-y-1 text-meta font-medium">
                <span className="inline-flex items-center gap-[5px]">
                  <i className={cn(liveDot, "size-2")} />
                  {runningCount} running
                </span>
                {done > 0 && (
                  <span className="inline-flex items-center gap-[5px] text-dim">
                    {done}/{total} done
                  </span>
                )}
                {pending > 0 && (
                  <span className="inline-flex items-center gap-[5px] text-faint">
                    {pending} queued
                  </span>
                )}
                {error > 0 && (
                  <span className="inline-flex items-center gap-[5px] text-red">
                    {error} failed
                  </span>
                )}
              </div>

              {running.length > 0 && (
                <ul className="m-0 flex max-h-[108px] list-none flex-col gap-[5px] overflow-y-auto p-0 text-meta font-medium">
                  {running.slice(0, 4).map((a) => (
                    <li
                      key={a.key}
                      className="flex min-w-0 items-center gap-[7px]"
                    >
                      <i className={cn(liveDot, "size-1.5")} />
                      <span className="truncate">{a.label}</span>
                      {a.phase && single?.phases?.length !== 1 ? (
                        <span className="flex-none text-faint">
                          {" "}
                          · {a.phase}
                        </span>
                      ) : null}
                    </li>
                  ))}
                  {running.length > 4 && (
                    <li className="flex min-w-0 flex-none items-center gap-[7px] text-faint">
                      +{running.length - 4} more
                    </li>
                  )}
                </ul>
              )}

              <button
                type="button"
                className="inline-flex items-center gap-0.5 self-start rounded-full border border-line bg-[var(--bg-hover)] py-[5px] pr-2.5 pl-3 text-meta font-semibold text-fg active:bg-pressed"
                onClick={onOpenPanel}
              >
                Open full panel
                <IconChevronRight size={15} />
              </button>
            </div>
          )}
        </div>
      )}
      {summary}
    </div>
  );
}
