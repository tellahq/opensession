import { mergeStylexOverrideClassName } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import { repoLabel } from "../lib/repo-label";
import { BASE_PATH } from "../lib/base";
import React, { useEffect, useEffectEvent, useState } from "react";
import {
  fetchGoals,
  fetchGoal,
  createGoalApi,
  updateGoalApi,
  deleteGoalApi,
  runGoalApi,
  resumeGoalApi,
  pauseGoalApi,
  fetchModels,
  fetchRepos,
  cachedRepos,
  relativeTime,
  type Goal,
  type GoalStatus,
  type ModelOption,
  type RepoInfo,
} from "../lib/api";
import { getCurrentUser } from "./UserPicker";
import { docTitle, DEFAULT_DOC_TITLE } from "../lib/brand";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { CheckStatusIcon } from "./CheckStatusIcon";
import { IconPlus } from "./icons";
import { SOURCE_CHIP } from "../lib/source-chip-classes";
import { Field, FieldGrid, Input, Textarea } from "../ui/input";
import { OptionSelect } from "../ui/select";
import {
  SettingCard,
  SettingsForm,
  SettingsFormActions,
  SettingsFormTitle,
  SettingsHeader,
  SettingsPanel,
} from "../ui/settings";
import { EmptyState, InlineAlert, LoadingState } from "../ui/state";
import { WorkingPill } from "../ui/status";
import { errorMessage } from "../lib/error-message";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  relative: {
    position: "relative",
  },
  flex: {
    display: "flex",
  },
  minH0: {
    minHeight: "0",
  },
  minW0: {
    minWidth: "0",
  },
  flex1: {
    flex: "1",
  },
  mb3: {
    marginBottom: "calc(4px * 3)",
  },
  size2: {
    width: "calc(4px * 2)",
    height: "calc(4px * 2)",
  },
  shrink0: {
    flexShrink: "0",
  },
  roundedFull: {
    borderRadius: "calc(infinity * 1px)",
    cornerShape: "round",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fontMedium: {
    fontWeight: "var(--font-weight-medium)",
  },
  textFg: {
    color: "var(--text)",
  },
  mt05: {
    marginTop: "calc(4px * 0.5)",
  },
  textDim: {
    color: "var(--text-dim)",
  },
  flexAuto: {
    flex: "auto",
  },
  flexCol: {
    flexDirection: "column",
  },
  borderL: {
    borderLeftStyle: "solid",
    borderLeftWidth: "1px",
  },
  borderLine: {
    borderColor: "var(--border)",
  },
  bgPanel: {
    backgroundColor: "var(--bg-panel)",
  },
  max900pxBorderL0: {
    "@media (max-width: 899px)": {
      borderLeftStyle: "solid",
      borderLeftWidth: "0px",
    },
  },
  itemsCenter: {
    alignItems: "center",
  },
  gap25: {
    gap: "calc(4px * 2.5)",
  },
  borderB: {
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  borderDivider: {
    borderColor: "var(--divider)",
  },
  px4: {
    paddingInline: "calc(4px * 4)",
  },
  py3: {
    paddingBlock: "calc(4px * 3)",
  },
  My1: {
    marginBlock: "calc(4px * -1)",
  },
  Ml05: {
    marginLeft: "calc(4px * -0.5)",
  },
  hidden: {
    display: "none",
  },
  gap175: {
    gap: "calc(4px * 1.75)",
  },
  px15: {
    paddingInline: "calc(4px * 1.5)",
  },
  py1: {
    paddingBlock: "4px",
  },
  max900pxInlineFlex: {
    "@media (max-width: 899px)": {
      display: "inline-flex",
    },
  },
  fontSemibold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  mlAuto: {
    marginLeft: "auto",
  },
  gap15: {
    gap: "calc(4px * 1.5)",
  },
  size7: {
    width: "calc(4px * 7)",
    height: "calc(4px * 7)",
  },
  justifyCenter: {
    justifyContent: "center",
  },
  roundedMd: {
    borderRadius: "calc(7px * var(--rf))",
    cornerShape: "var(--cs)",
  },
  hoverBgHover: {
    "@media (hover: hover)": {
      ":hover": {
        backgroundColor: "var(--hover)",
      },
    },
  },
  hoverTextFg: {
    "@media (hover: hover)": {
      ":hover": {
        color: "var(--text)",
      },
    },
  },
  max900pxHidden: {
    "@media (max-width: 899px)": {
      display: "none",
    },
  },
  gap35: {
    gap: "calc(4px * 3.5)",
  },
  overflowYAuto: {
    overflowY: "auto",
  },
  px5: {
    paddingInline: "calc(4px * 5)",
  },
  pt45: {
    paddingTop: "calc(4px * 4.5)",
  },
  pb10: {
    paddingBottom: "calc(4px * 10)",
  },
  textFaint: {
    color: "var(--text-faint)",
  },
  leadingSnug: {
    lineHeight: "var(--leading-snug)",
  },
  bgSurface: {
    backgroundColor: "var(--bg)",
  },
  border: {
    borderStyle: "solid",
    borderWidth: "1px",
  },
  roundedPanel: {
    borderRadius: "calc(var(--radius) * var(--rf))",
    cornerShape: "var(--cs)",
  },
  px35: {
    paddingInline: "calc(4px * 3.5)",
  },
  leadingRelaxed: {
    lineHeight: "var(--leading-relaxed)",
  },
  whitespacePreWrap: {
    whiteSpace: "pre-wrap",
  },
  grid: {
    display: "grid",
  },
  gridColsMaxContent1fr: {
    gridTemplateColumns: "max-content 1fr",
  },
  itemsBaseline: {
    alignItems: "baseline",
  },
  gapX5: {
    columnGap: "calc(4px * 5)",
  },
  gapY2: {
    rowGap: "calc(4px * 2)",
  },
  mb2: {
    marginBottom: "calc(4px * 2)",
  },
  textGreen: {
    color: "var(--green)",
  },
  textRed: {
    color: "var(--red)",
  },
  leading17: {
    lineHeight: "1.7",
  },
  whitespaceNowrap: {
    whiteSpace: "nowrap",
  },
  fontMono: {
    fontFamily: "var(--mono)",
  },
  mb0: {
    marginBottom: "0",
  },
});

/* Goals is a tool surface hosted inside Settings, so it reads as one of its
   pages: the settings reading column, a SettingsHeader on top, the rows on a
   SettingCard plate, and the form in the settings form shapes. What it keeps
   of its own is the master/detail split — selecting a goal opens a drawer and
   the list steps back to a rail (see Automations.tsx, same shape). */

/** The two rules that reach in from the form to its fields: 16px on phones, so
    iOS doesn't zoom a focused field, and paragraph leading in a textarea. */
const FORM_FIELDS =
  "[&_textarea]:leading-normal phone:[&_input]:text-input-phone phone:[&_select]:text-input-phone phone:[&_textarea]:text-input-phone";
/** .automations-drawer-section-label */
const SECTION_LABEL = utilityClassName(
  "mb-1.5 text-label font-semibold text-faint",
);
/** .automation-session-link */
const LINK = utilityClassName(
  "cursor-pointer text-link no-underline hover:underline",
);

interface Props {
  onOpenSession: (sessionId: string) => void;
  /** Selected goal id (or name) — from the route. */
  selectedId?: string;
  /** Change the selection ("" closes the detail drawer). Routed by App. */
  onSelect: (id: string) => void;
}

const STATUS_COLOR: Record<GoalStatus, string> = {
  active: "var(--green)",
  paused: "var(--yellow)",
  done: "var(--blue)",
  failed: "var(--red)",
};

export function Goals({ onOpenSession, selectedId, onSelect }: Props) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [modelLoadError, setModelLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchModels()
      .then((m) => setDefaultModel(m.default))
      .catch((cause: unknown) =>
        setModelLoadError(errorMessage(cause, "Could not load models")),
      );
  }, []);

  const load = async () => {
    try {
      setGoals(await fetchGoals());
    } catch (cause: unknown) {
      setError(errorMessage(cause, "Could not load goals"));
    }
    setLoading(false);
  };
  const loadForEffect = useEffectEvent(() => load());

  useEffect(() => {
    document.title = docTitle("Goals");
    void loadForEffect();
    const id = setInterval(() => void loadForEffect(), 10000);
    return () => {
      clearInterval(id);
      document.title = DEFAULT_DOC_TITLE;
    };
  }, []);

  // The routed selection — matched by id, or by name for deep-links.
  const sel = selectedId
    ? goals.find((g) => g.id === selectedId || g.name === selectedId) || null
    : null;

  // Leaving the selection also leaves edit mode.
  useEffect(() => setEditMode(false), [sel?.id]);

  // Escape backs out one layer: inline edit → read view → closed.
  const hasSelection = !!sel;
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
      if (editMode) setEditMode(false);
      else onSelect("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasSelection, editMode, onSelect]);

  async function act(action: () => Promise<unknown>, refreshDelay = 400) {
    try {
      await action();
      setTimeout(load, refreshDelay);
    } catch (cause: unknown) {
      setError(errorMessage(cause, "Could not update goal"));
    }
  }

  async function handleDelete(g: Goal) {
    if (
      !confirm(
        `Delete goal "${g.name}" and its ledger? The session it created is left as-is.`,
      )
    )
      return;
    if (sel?.id === g.id) onSelect("");
    await act(() => deleteGoalApi(g.id), 100);
  }

  return (
    <div {...stylex.props(sx.relative, sx.flex, sx.minH0, sx.minW0, sx.flex1)}>
      {/* Drawer open: the list compresses to a narrow rail, and on phones it
        steps aside entirely — Back returns to it. */}
      <div
        className={cn(
          utilityClassName("flex min-w-0 justify-center overflow-y-auto"),
          sel
            ? utilityClassName(
                "flex-[0_0_340px] border-r border-line px-2.5 pt-4 pb-10 max-[900px]:hidden",
              )
            : utilityClassName(
                "flex-1 px-8 pt-11 pb-22 phone:px-4 phone:pt-5 phone:pb-12",
              ),
        )}
      >
        <SettingsPanel
          className={cn(
            utilityClassName("self-start"),
            sel && utilityClassName("max-w-none"),
          )}
        >
          <SettingsHeader
            title="Goals"
            description={
              sel
                ? undefined
                : "Long-running missions that pace themselves, keep a ledger, and stop when done."
            }
            className={cn(
              utilityClassName("phone:flex-col phone:items-start phone:gap-3"),
              sel && utilityClassName("mb-3 px-2 [&_h1]:text-item-title"),
            )}
            actions={
              <Button
                variant="primary"
                icon={<IconPlus size={16} />}
                onClick={() => setShowForm(true)}
              >
                New goal
              </Button>
            }
          />

          {error && (
            <InlineAlert
              className={mergeStylexOverrideClassName("", sx.mb3)}
              onDismiss={() => setError(null)}
            >
              {error}
            </InlineAlert>
          )}
          {modelLoadError && (
            <InlineAlert
              className={mergeStylexOverrideClassName("", sx.mb3)}
              onDismiss={() => setModelLoadError(null)}
            >
              {modelLoadError}
            </InlineAlert>
          )}

          {showForm && (
            <GoalForm
              initial={null}
              onClose={() => setShowForm(false)}
              onSaved={() => {
                setShowForm(false);
                load();
              }}
            />
          )}

          {loading ? (
            <LoadingState>Loading…</LoadingState>
          ) : goals.length === 0 && !showForm ? (
            <EmptyState title="No goals yet">
              A goal pursues one mission over days or weeks. It wakes itself,
              reads its ledger, ships work via PRs, measures, and iterates until
              the objective is met.
            </EmptyState>
          ) : (
            <SettingCard>
              {goals.map((g) => {
                const running = g.isRunning || g.lastRunStatus === "running";
                return (
                  <button
                    key={g.id}
                    className={cn(
                      utilityClassName(
                        "flex w-full min-w-0 items-center gap-3 px-5 py-3.5 text-left outline-none transition-colors",
                      ),
                      utilityClassName(
                        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50",
                      ),
                      sel?.id === g.id
                        ? utilityClassName("bg-selected")
                        : utilityClassName("hover:bg-hover"),
                      sel && utilityClassName("gap-2.5 px-3 py-2.5"),
                    )}
                    onClick={() => onSelect(g.id)}
                  >
                    <span
                      {...stylex.props(sx.size2, sx.shrink0, sx.roundedFull)}
                      style={{ background: STATUS_COLOR[g.status] }}
                      title={g.pauseReason || g.doneReason || g.status}
                    />
                    <span
                      className={cn(
                        utilityClassName("flex min-w-0 flex-1 flex-col"),
                        g.status !== "active" && utilityClassName("opacity-55"),
                      )}
                    >
                      <span
                        {...stylex.props(
                          sx.truncate,
                          sx.fontMedium,
                          sx.textFg,
                          typography.itemTitle,
                        )}
                      >
                        {g.name}
                      </span>
                      <span
                        {...stylex.props(
                          sx.mt05,
                          sx.truncate,
                          sx.textDim,
                          typography.supporting,
                        )}
                      >
                        {g.status}
                        {g.phase ? ` · ${g.phase}` : ""}
                        {` · wake #${g.wakeCount}${g.maxWakes ? ` / ${g.maxWakes}` : ""}`}
                      </span>
                    </span>
                    {running ? (
                      <WorkingPill />
                    ) : g.lastRunStatus === "ok" ||
                      g.lastRunStatus === "error" ? (
                      <span
                        className={cn(
                          utilityClassName(
                            "flex size-5 shrink-0 items-center justify-center [&_svg]:size-3.5",
                          ),
                          g.lastRunStatus === "ok"
                            ? utilityClassName("text-green")
                            : utilityClassName("text-red"),
                        )}
                        title={
                          g.lastRunStatus === "ok"
                            ? `Last wake ok${g.lastRunAt ? ` · ${relativeTime(g.lastRunAt)}` : ""}`
                            : g.lastRunError || "Last wake failed"
                        }
                      >
                        <CheckStatusIcon
                          kind={
                            g.lastRunStatus === "ok" ? "success" : "failure"
                          }
                        />
                      </span>
                    ) : null}
                    {/* Only the next wake: the status itself is already the first
                    word of the line on the left, and saying it twice made a
                    paused goal read as two different facts. */}
                    <span
                      className={cn(
                        utilityClassName(
                          "w-21 shrink-0 text-right text-meta text-faint",
                        ),
                        sel
                          ? utilityClassName("hidden")
                          : utilityClassName("phone:hidden"),
                      )}
                    >
                      {g.status === "active" && g.nextWakeAt
                        ? `next ${formatNext(g.nextWakeAt)}`
                        : ""}
                    </span>
                  </button>
                );
              })}
            </SettingCard>
          )}
        </SettingsPanel>
      </div>

      {sel && (
        <aside
          {...stylex.props(
            sx.flex,
            sx.minH0,
            sx.minW0,
            sx.flexAuto,
            sx.flexCol,
            sx.borderL,
            sx.borderLine,
            sx.bgPanel,
            sx.max900pxBorderL0,
          )}
        >
          <div
            {...stylex.props(
              sx.flex,
              sx.shrink0,
              sx.itemsCenter,
              sx.gap25,
              sx.borderB,
              sx.borderDivider,
              sx.px4,
              sx.py3,
            )}
          >
            {/* Phones get Back instead of Close: there the drawer is the page. */}
            <button
              {...stylex.props(
                sx.My1,
                sx.Ml05,
                sx.hidden,
                sx.shrink0,
                sx.itemsCenter,
                sx.gap175,
                sx.px15,
                sx.py1,
                sx.fontMedium,
                sx.textFg,
                sx.max900pxInlineFlex,
                typography.itemTitle,
              )}
              onClick={() => onSelect("")}
              title="Back to goals"
            >
              <svg
                width="19"
                height="19"
                viewBox="0 0 16 16"
                fill="currentColor"
                {...stylex.props(sx.textDim)}
                aria-hidden
              >
                <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.749.749 0 1 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z" />
              </svg>
              Goals
            </button>
            <span
              {...stylex.props(
                sx.minW0,
                sx.truncate,
                sx.fontSemibold,
                typography.label,
              )}
            >
              {editMode ? `Edit ${sel.name}` : sel.name}
            </span>
            {!editMode && (
              <div {...stylex.props(sx.mlAuto, sx.flex, sx.shrink0, sx.gap15)}>
                {sel.status === "active" && (
                  <Button
                    size="sm"
                    variant="soft"
                    onClick={() => act(() => runGoalApi(sel.id))}
                    disabled={sel.isRunning}
                  >
                    Wake now
                  </Button>
                )}
                {sel.status === "active" ? (
                  <Button
                    size="sm"
                    variant="soft"
                    onClick={() => act(() => pauseGoalApi(sel.id))}
                  >
                    Pause
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="soft"
                    onClick={() => act(() => resumeGoalApi(sel.id))}
                  >
                    Resume
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="soft"
                  onClick={() => setEditMode(true)}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => handleDelete(sel)}
                >
                  Delete
                </Button>
              </div>
            )}
            <button
              {...stylex.props(
                sx.flex,
                sx.size7,
                sx.shrink0,
                sx.itemsCenter,
                sx.justifyCenter,
                sx.roundedMd,
                sx.textDim,
                sx.hoverBgHover,
                sx.hoverTextFg,
                sx.max900pxHidden,
              )}
              onClick={() => onSelect("")}
              title="Close"
            >
              <svg
                width="19"
                height="19"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden
              >
                <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.749.749 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.749.749 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
              </svg>
            </button>
          </div>
          <div
            {...stylex.props(
              sx.flex,
              sx.minH0,
              sx.flex1,
              sx.flexCol,
              sx.gap35,
              sx.overflowYAuto,
              sx.px5,
              sx.pt45,
              sx.pb10,
            )}
          >
            {editMode ? (
              <GoalForm
                key={sel.id}
                inline
                initial={sel}
                onClose={() => setEditMode(false)}
                onSaved={() => {
                  setEditMode(false);
                  load();
                }}
              />
            ) : (
              <>
                <div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap25)}>
                  <span
                    className={SOURCE_CHIP}
                    style={{
                      background: STATUS_COLOR[sel.status],
                      color: "#fff",
                    }}
                  >
                    {sel.status}
                  </span>
                  {(sel.isRunning || sel.lastRunStatus === "running") && (
                    <WorkingPill />
                  )}
                  {sel.status === "active" && sel.nextWakeAt && (
                    <span
                      {...stylex.props(
                        sx.textFaint,
                        sx.mlAuto,
                        sx.shrink0,
                        typography.label,
                      )}
                      title={sel.nextWakeAt}
                    >
                      next wake {formatNext(sel.nextWakeAt)}
                    </span>
                  )}
                </div>
                {sel.status === "paused" && sel.pauseReason && (
                  <div
                    {...stylex.props(
                      sx.textDim,
                      sx.leadingSnug,
                      typography.supporting,
                    )}
                  >
                    Paused: {sel.pauseReason}
                  </div>
                )}
                {(sel.status === "done" || sel.status === "failed") &&
                  sel.doneReason && (
                    <div
                      {...stylex.props(
                        sx.textDim,
                        sx.leadingSnug,
                        typography.supporting,
                      )}
                    >
                      {sel.status === "done" ? "Done" : "Failed"}:{" "}
                      {sel.doneReason}
                    </div>
                  )}

                <div>
                  <div className={SECTION_LABEL}>Mission</div>
                  <div
                    {...stylex.props(
                      sx.bgSurface,
                      sx.border,
                      sx.borderLine,
                      sx.roundedPanel,
                      sx.px35,
                      sx.py3,
                      sx.leadingRelaxed,
                      sx.textDim,
                      sx.whitespacePreWrap,
                      typography.label,
                    )}
                  >
                    {sel.mission}
                  </div>
                </div>

                <div>
                  <div className={SECTION_LABEL}>Configuration</div>
                  <div
                    {...stylex.props(
                      sx.grid,
                      sx.gridColsMaxContent1fr,
                      sx.itemsBaseline,
                      sx.gapX5,
                      sx.gapY2,
                      typography.label,
                    )}
                  >
                    <DetailKey>Mode</DetailKey>
                    <span {...stylex.props(sx.textDim)}>
                      {sel.mode === "ask"
                        ? "Ask · read-only research and measurement"
                        : `Code · persistent worktree${sel.repo ? ` in ${repoLabel(sel.repo)}` : ""}, can open PRs`}
                    </span>

                    {sel.phase && (
                      <>
                        <DetailKey>Phase</DetailKey>
                        <span {...stylex.props(sx.textDim, sx.minW0)}>
                          {sel.phase}
                        </span>
                      </>
                    )}

                    <DetailKey>Model</DetailKey>
                    <span {...stylex.props(sx.textDim)}>
                      {sel.model || `${defaultModel || "default"} (default)`}
                      {sel.fallbackModel && sel.fallbackModel !== "none" && (
                        <span
                          {...stylex.props(sx.textFaint)}
                          title="Used only when every account for the primary model has hit its usage limit"
                        >
                          {" "}
                          · falls back to {sel.fallbackModel}
                        </span>
                      )}
                    </span>

                    <DetailKey>Cadence</DetailKey>
                    <span {...stylex.props(sx.textDim)}>
                      at least {sel.minWakeMinutes}m between wakes
                      {sel.maxWakes ? ` · capped at ${sel.maxWakes} wakes` : ""}
                    </span>

                    <DetailKey>MCPs</DetailKey>
                    <span {...stylex.props(sx.textDim, sx.minW0)}>
                      {sel.mcpServers?.length
                        ? sel.mcpServers.join(", ")
                        : "all connectors"}
                    </span>

                    {sel.bksSessionId && (
                      <>
                        <DetailKey>Session</DetailKey>
                        <span {...stylex.props(sx.minW0)}>
                          <a
                            className={LINK}
                            onClick={(e) => {
                              e.preventDefault();
                              onOpenSession(sel.bksSessionId!);
                            }}
                            href={`${BASE_PATH}/session/${sel.bksSessionId}`}
                          >
                            open the goal's session
                          </a>
                        </span>
                      </>
                    )}

                    <DetailKey>Created</DetailKey>
                    <span {...stylex.props(sx.textDim)}>
                      by {sel.createdBy}
                    </span>
                  </div>
                </div>

                <div>
                  <div className={SECTION_LABEL}>Activity</div>
                  <div
                    {...stylex.props(sx.textDim, sx.mb2, typography.supporting)}
                  >
                    wake #{sel.wakeCount}
                    {sel.maxWakes ? ` of ${sel.maxWakes}` : ""}
                    {sel.lastRunAt && (
                      <>
                        {" · last wake "}
                        {relativeTime(sel.lastRunAt)}
                        {sel.lastRunStatus === "ok" && (
                          <span {...stylex.props(sx.textGreen)}> ✓</span>
                        )}
                        {sel.lastRunStatus === "error" && (
                          <span
                            {...stylex.props(sx.textRed)}
                            title={sel.lastRunError}
                          >
                            {" "}
                            ✗
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  <GoalLedger id={sel.id} />
                </div>
              </>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

/** Left column of the drawer's Configuration grid. */
function DetailKey({ children }: { children: React.ReactNode }) {
  return (
    <span
      {...stylex.props(
        sx.textFaint,
        sx.leading17,
        sx.whitespaceNowrap,
        typography.label,
      )}
    >
      {children}
    </span>
  );
}

/** Lazily fetch + show a goal's full mission + ledger. */
function GoalLedger({ id }: { id: string }) {
  const [ledger, setLedger] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchGoal(id)
      .then((g) => {
        if (alive) setLedger(g.ledger || "(ledger is empty)");
      })
      .catch((cause: unknown) => {
        if (alive)
          setLedger(`(${errorMessage(cause, "Failed to load ledger")})`);
      });
    return () => {
      alive = false;
    };
  }, [id]);
  return (
    <pre
      style={{
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        maxHeight: 360,
        overflow: "auto",
        margin: 0,
        padding: "10px 12px",
        background: "var(--bg-raised)",
        color: "var(--text)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        fontFamily: "var(--mono)",
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      {ledger === null ? "Loading ledger…" : ledger}
    </pre>
  );
}

function formatNext(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 60_000) return "in <1m";
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`;
  return `in ${Math.round(diff / 86_400_000)}d`;
}

/** " (Claude)" / " (OpenAI Codex)" by the model's ACCOUNT POOL — the engine
 *  provider ("pi"/"pi") says nothing about whose subscription pays, and
 *  keying off it labeled every engine entry "(Claude)". Pool-less models get
 *  no suffix. */
function accountPoolSuffix(m: ModelOption): string {
  if (m.accountProvider === "codex") return " (OpenAI Codex)";
  if (m.accountProvider === "claude") return " (Claude)";
  return "";
}

function GoalForm({
  initial,
  inline,
  onClose,
  onSaved,
}: {
  initial: Goal | null;
  /** Hosted in the detail drawer: drop the card chrome + redundant title. */
  inline?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [mission, setMission] = useState(initial?.mission || "");
  const [mode, setMode] = useState<"ask" | "code">(initial?.mode || "ask");
  const [repo, setRepo] = useState(initial?.repo || "");
  // Seeded from the repos this browser saw last (lib/repo-cache), so the repo
  // picker opens on the real list rather than empty; the fetch below corrects it.
  const [repos, setRepos] = useState<RepoInfo[]>(cachedRepos);
  const [model, setModel] = useState(initial?.model || "");
  const [fallbackModel, setFallbackModel] = useState(
    initial?.fallbackModel || "",
  );
  const [mcpServers, setMcpServers] = useState(
    (initial?.mcpServers || []).join(", "),
  );
  const [minWakeMinutes, setMinWakeMinutes] = useState(
    String(initial?.minWakeMinutes ?? 30),
  );
  const [maxWakes, setMaxWakes] = useState(
    initial?.maxWakes ? String(initial.maxWakes) : "",
  );
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelLoadError, setModelLoadError] = useState<string | null>(null);
  const [repoLoadError, setRepoLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetchModels()
      .then((catalog) => {
        setModels(catalog.models);
        setDefaultModel(catalog.default);
      })
      .catch((cause: unknown) =>
        setModelLoadError(errorMessage(cause, "Could not load models")),
      );
    fetchRepos()
      .then((repoItems) => {
        if (repoItems.length) setRepos(repoItems);
        setRepo(
          (current) =>
            current ||
            repoItems.find((item) => item.default)?.id ||
            repoItems[0]?.id ||
            "",
        );
      })
      .catch((cause: unknown) =>
        setRepoLoadError(errorMessage(cause, "Could not load repositories")),
      );
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    const servers = mcpServers
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const payload = {
      name,
      mission,
      mode,
      repo: repo.trim() || undefined,
      model: model || undefined,
      fallbackModel: fallbackModel || undefined,
      mcpServers: servers.length ? servers : undefined,
      minWakeMinutes: Number(minWakeMinutes) || undefined,
      maxWakes: maxWakes.trim() ? Number(maxWakes) : undefined,
    };
    try {
      if (initial) {
        await updateGoalApi(initial.id, payload);
      } else {
        await createGoalApi({ ...payload, createdBy: getCurrentUser() });
      }
      onSaved();
    } catch (cause: unknown) {
      setError(errorMessage(cause, "Could not save goal"));
      setSaving(false);
    }
  }

  const fields = (
    <>
      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Rank #1: screen recording software"
        />
      </Field>

      <Field label="Mission">
        <Textarea
          value={mission}
          onChange={(e) => setMission(e.target.value)}
          rows={12}
          placeholder="The full mission brief: objective, strategy, operating loop, hard rules. It's restated to the agent every wake."
        />
      </Field>

      <FieldGrid>
        <Field label="Mode">
          <OptionSelect
            label="Mode"
            value={mode}
            options={[
              {
                value: "ask",
                label: "Ask · read-only research and measurement",
              },
              {
                value: "code",
                label: "Code · persistent worktree, can open PRs",
              },
            ]}
            onChange={(next) => setMode(next as "ask" | "code")}
          />
        </Field>

        <Field label="Repository">
          <OptionSelect
            label="Repository"
            value={repo}
            options={repos.map((item) => ({
              value: item.id,
              label: item.label || repoLabel(item.id),
            }))}
            onChange={setRepo}
          />
        </Field>

        <Field label="Model">
          <OptionSelect
            label="Model"
            value={model}
            options={[
              {
                value: "",
                label: `Default${defaultModel ? ` · ${defaultModel}` : ""}`,
              },
              ...models.map((m) => ({
                value: m.id,
                label: m.label + accountPoolSuffix(m),
              })),
            ]}
            onChange={setModel}
          />
        </Field>

        <Field
          label="Fallback model"
          title="Used only when every account for the primary model has hit its usage limit"
        >
          <OptionSelect
            label="Fallback model"
            value={fallbackModel}
            options={[
              { value: "", label: "None · fail instead" },
              ...models.map((m) => ({
                value: m.id,
                label: m.label + accountPoolSuffix(m),
              })),
            ]}
            onChange={setFallbackModel}
          />
        </Field>
      </FieldGrid>

      <Field
        label="MCP servers"
        title="Comma-separated. Blank means every connector."
      >
        <Input
          value={mcpServers}
          onChange={(e) => setMcpServers(e.target.value)}
          placeholder="ahrefs, slack"
          className={mergeStylexOverrideClassName("", sx.fontMono)}
        />
      </Field>

      <FieldGrid>
        <Field
          label="Minutes between wakes"
          title="The goal never wakes sooner than this."
        >
          <Input
            type="number"
            value={minWakeMinutes}
            onChange={(e) => setMinWakeMinutes(e.target.value)}
            placeholder="30"
          />
        </Field>

        <Field label="Max wakes" title="Safety cap. Blank means no limit.">
          <Input
            type="number"
            value={maxWakes}
            onChange={(e) => setMaxWakes(e.target.value)}
            placeholder="–"
          />
        </Field>
      </FieldGrid>

      {error && <InlineAlert>{error}</InlineAlert>}
      {modelLoadError && (
        <InlineAlert onDismiss={() => setModelLoadError(null)}>
          {modelLoadError}
        </InlineAlert>
      )}
      {repoLoadError && (
        <InlineAlert onDismiss={() => setRepoLoadError(null)}>
          {repoLoadError}
        </InlineAlert>
      )}

      <SettingsFormActions>
        <Button variant="soft" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={saving || !name.trim() || !mission.trim()}
        >
          {saving ? "Saving…" : initial ? "Save changes" : "Create goal"}
        </Button>
      </SettingsFormActions>
    </>
  );

  // In the drawer the panel is already the surface, so the form drops the
  // plate and the title the drawer's own header carries.
  if (inline)
    return (
      <div className={utilityClassName(`flex flex-col gap-3.5 ${FORM_FIELDS}`)}>
        {fields}
      </div>
    );

  return (
    <SettingsForm
      className={utilityClassName(`mb-3 flex flex-col gap-3.5 ${FORM_FIELDS}`)}
    >
      <SettingsFormTitle className={mergeStylexOverrideClassName("", sx.mb0)}>
        {initial ? `Edit "${initial.name}"` : "New goal"}
      </SettingsFormTitle>
      {fields}
    </SettingsForm>
  );
}
