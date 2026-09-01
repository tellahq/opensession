import { mergeStylexProps } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
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
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  flexNone: {
    flex: "none",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  minW0: {
    minWidth: "0",
  },
  flexAuto: {
    flex: "auto",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  flex: {
    display: "flex",
  },
  flexCol: {
    flexDirection: "column",
  },
  gap25: {
    gap: "calc(4px * 2.5)",
  },
  maxH168px: {
    maxHeight: "168px",
  },
  gap7px: {
    gap: "7px",
  },
  overflowYAuto: {
    overflowY: "auto",
  },
  m0: {
    margin: "0",
  },
  listNone: {
    listStyleType: "none",
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  p0: {
    padding: "0",
  },
  flexWrap: {
    flexWrap: "wrap",
  },
  gapX3: {
    columnGap: "calc(4px * 3)",
  },
  gapY1: {
    rowGap: "4px",
  },
  inlineFlex: {
    display: "inline-flex",
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap5px: {
    gap: "5px",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  textRed: {
    color: "var(--red)",
  },
  maxH108px: {
    maxHeight: "108px",
  },
  gap05: {
    gap: "calc(4px * 0.5)",
  },
  selfStart: {
    alignSelf: "flex-start",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  bgVarBgHover: {
    backgroundColor: "var(--bg-hover)",
  },
  py5px: {
    paddingBlock: "5px",
  },
  pr25: {
    paddingRight: "calc(4px * 2.5)",
  },
  pl3: {
    paddingLeft: "calc(4px * 3)",
  },
  textFg: {
    color: "var(--text)",
  },
  activeBgPressed: {
    ":active": {
      backgroundColor: "var(--hover-strong)",
    },
  },
});

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
const sectionName = utilityClassName(
  "truncate text-meta font-semibold text-dim",
);

/** The live dot. The keyframes stay in the stylesheet (see the report — they
 *  belong in base.css now that no class of ours carries them), and the
 *  reduced-motion blanket in base.css deliberately stops this one. */
const liveDot = utilityClassName(
  "flex-none rounded-full bg-yellow animate-[composer-agents-pulse_1.4s_ease-in-out_infinite]",
);

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
        utilityClassName(
          "flex w-full items-center gap-2 text-left text-label font-medium text-fg",
        ),
        // Open, this row is a control bar under a list that scrolls: without
        // a rule its last clipped item runs straight into it. Same gap + rule
        // + padding the agents section takes from the plan above it.
        open && utilityClassName("border-t border-line pt-2.5"),
      )}
      aria-expanded={open}
      aria-label={open ? "Collapse run status" : "Show run status"}
      onClick={toggle}
    >
      {!open && <span className={cn(liveDot, utilityClassName("size-2"))} />}
      {total === 0 && (
        <span
          {...mergeStylexProps(
            "tabular-nums",
            sx.flexNone,
            sx.fontMedium,
            sx.textFaint,
          )}
        >
          {planDone}/{planTotal}
        </span>
      )}
      {/* flex-auto, not flex-1: with a zero basis the label would only ever
			    take the free space left over, so a long phase name stopped pushing
			    the caret and started truncating a step early. */}
      <span {...stylex.props(sx.minW0, sx.flexAuto, sx.truncate)}>
        {total > 0 ? (
          <>
            <strong {...stylex.props(sx.fontSemibold)}>
              {runningCount} running
            </strong>
            {total > runningCount ? (
              <span {...stylex.props(sx.fontMedium, sx.textFaint)}>
                {" "}
                · {done}/{total} done
              </span>
            ) : null}
            {planTotal > 0 ? (
              <span {...stylex.props(sx.fontMedium, sx.textFaint)}>
                {" "}
                · Plan {planDone}/{planTotal}
              </span>
            ) : !open && phase ? (
              <span {...stylex.props(sx.fontMedium, sx.textFaint)}>
                {" "}
                · {phase}
              </span>
            ) : null}
          </>
        ) : (
          <strong {...stylex.props(sx.fontSemibold)}>
            {!open && planStep ? planStep : "Plan"}
          </strong>
        )}
      </span>
      {/* Points the way the card moves, not at the content: closed it opens
			    upward, open it folds back down into this row. */}
      <IconChevronDown
        size={16}
        className={cn(
          utilityClassName(
            "flex-none text-faint transition-transform duration-[var(--dur)]",
          ),
          !open && utilityClassName("rotate-180"),
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
        utilityClassName(
          "relative -mb-3.5 flex w-full flex-col gap-2.5 rounded-t-[var(--composer-radius)] border-x border-t bg-[color-mix(in_srgb,var(--bg-panel)_80%,var(--composer-surface))] px-3.5 pt-2.5 pb-[22px] text-label font-medium text-fg",
        ),
        composerFlapBorder,
      )}
      data-open={open ? "" : undefined}
    >
      {open && (
        <div {...stylex.props(sx.flex, sx.flexCol, sx.gap25)}>
          {planTotal > 0 && (
            // Its own scroller so a long plan doesn't push the composer down.
            <div
              {...stylex.props(
                sx.flex,
                sx.maxH168px,
                sx.flexCol,
                sx.gap7px,
                sx.overflowYAuto,
              )}
            >
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
                utilityClassName("flex flex-col gap-2.5"),
                planTotal > 0 &&
                  utilityClassName("border-t border-line pt-2.5"),
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
                <ol
                  {...stylex.props(
                    sx.m0,
                    sx.flex,
                    sx.listNone,
                    sx.flexCol,
                    sx.gap15,
                    sx.p0,
                  )}
                >
                  {steps.map((s, i) => (
                    <li
                      key={s}
                      className={cn(
                        utilityClassName("flex items-center gap-2"),
                        i < curIdx && utilityClassName("font-medium text-dim"),
                        i === curIdx &&
                          utilityClassName("font-semibold text-fg"),
                        i > curIdx &&
                          utilityClassName("font-medium text-faint"),
                      )}
                    >
                      <span
                        className={cn(
                          utilityClassName(
                            "inline-flex size-4 flex-none items-center justify-center rounded-full text-[10px] font-semibold",
                          ),
                          i < curIdx
                            ? utilityClassName(
                                "border border-transparent bg-green-soft text-green",
                              )
                            : i === curIdx
                              ? utilityClassName(
                                  "border border-green text-green",
                                )
                              : utilityClassName("border border-line"),
                        )}
                      >
                        {i < curIdx ? "✓" : i + 1}
                      </span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ol>
              )}

              <div
                {...stylex.props(
                  sx.flex,
                  sx.flexWrap,
                  sx.gapX3,
                  sx.gapY1,
                  sx.fontMedium,
                  typography.meta,
                )}
              >
                <span
                  {...stylex.props(sx.inlineFlex, sx.itemsCenter, sx.gap5px)}
                >
                  <i className={cn(liveDot, utilityClassName("size-2"))} />
                  {runningCount} running
                </span>
                {done > 0 && (
                  <span
                    {...stylex.props(
                      sx.inlineFlex,
                      sx.itemsCenter,
                      sx.gap5px,
                      sx.textDim,
                    )}
                  >
                    {done}/{total} done
                  </span>
                )}
                {pending > 0 && (
                  <span
                    {...stylex.props(
                      sx.inlineFlex,
                      sx.itemsCenter,
                      sx.gap5px,
                      sx.textFaint,
                    )}
                  >
                    {pending} queued
                  </span>
                )}
                {error > 0 && (
                  <span
                    {...stylex.props(
                      sx.inlineFlex,
                      sx.itemsCenter,
                      sx.gap5px,
                      sx.textRed,
                    )}
                  >
                    {error} failed
                  </span>
                )}
              </div>

              {running.length > 0 && (
                <ul
                  {...stylex.props(
                    sx.m0,
                    sx.flex,
                    sx.maxH108px,
                    sx.listNone,
                    sx.flexCol,
                    sx.gap5px,
                    sx.overflowYAuto,
                    sx.p0,
                    sx.fontMedium,
                    typography.meta,
                  )}
                >
                  {running.slice(0, 4).map((a) => (
                    <li
                      key={a.key}
                      {...stylex.props(
                        sx.flex,
                        sx.minW0,
                        sx.itemsCenter,
                        sx.gap7px,
                      )}
                    >
                      <i
                        className={cn(liveDot, utilityClassName("size-1.5"))}
                      />
                      <span {...stylex.props(sx.truncate)}>{a.label}</span>
                      {a.phase && single?.phases?.length !== 1 ? (
                        <span {...stylex.props(sx.flexNone, sx.textFaint)}>
                          {" "}
                          · {a.phase}
                        </span>
                      ) : null}
                    </li>
                  ))}
                  {running.length > 4 && (
                    <li
                      {...stylex.props(
                        sx.flex,
                        sx.minW0,
                        sx.flexNone,
                        sx.itemsCenter,
                        sx.gap7px,
                        sx.textFaint,
                      )}
                    >
                      +{running.length - 4} more
                    </li>
                  )}
                </ul>
              )}

              <button
                type="button"
                {...stylex.props(
                  sx.inlineFlex,
                  sx.itemsCenter,
                  sx.gap05,
                  sx.selfStart,
                  sx.roundedFull,
                  sx.border,
                  sx.borderLine,
                  sx.bgVarBgHover,
                  sx.py5px,
                  sx.pr25,
                  sx.pl3,
                  sx.fontSemibold,
                  sx.textFg,
                  sx.activeBgPressed,
                  typography.meta,
                )}
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
