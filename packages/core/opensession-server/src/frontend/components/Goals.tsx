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
const SECTION_LABEL = "mb-1.5 text-label font-semibold text-faint";
/** .automation-session-link */
const LINK = "cursor-pointer text-link no-underline hover:underline";

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
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      )
        return;
      if (editMode) setEditMode(false);
      else onSelect("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasSelection, editMode, onSelect]);

  async function act<Result>(
    action: () => Promise<Result>,
    refreshDelay = 400,
  ) {
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
    <div className="relative flex min-h-0 min-w-0 flex-1">
      {/* Drawer open: the list compresses to a narrow rail, and on phones it
        steps aside entirely — Back returns to it. */}
      <div
        className={cn(
          "flex min-w-0 justify-center overflow-y-auto",
          sel
            ? "flex-[0_0_340px] border-r border-line px-2.5 pt-4 pb-10 max-[900px]:hidden"
            : "flex-1 px-8 pt-11 pb-22 phone:px-4 phone:pt-5 phone:pb-12",
        )}
      >
        <SettingsPanel className={cn("self-start", sel && "max-w-none")}>
          <SettingsHeader
            title="Goals"
            description={
              sel
                ? undefined
                : "Long-running missions that pace themselves, keep a ledger, and stop when done."
            }
            className={cn(
              "phone:flex-col phone:items-start phone:gap-3",
              sel && "mb-3 px-2 [&_h1]:text-item-title",
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
            <InlineAlert className="mb-3" onDismiss={() => setError(null)}>
              {error}
            </InlineAlert>
          )}
          {modelLoadError && (
            <InlineAlert
              className="mb-3"
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
                      "flex w-full min-w-0 items-center gap-3 px-5 py-3.5 text-left outline-none transition-colors",
                      "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50",
                      sel?.id === g.id ? "bg-selected" : "hover:bg-hover",
                      sel && "gap-2.5 px-3 py-2.5",
                    )}
                    onClick={() => onSelect(g.id)}
                  >
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: STATUS_COLOR[g.status] }}
                      title={g.pauseReason || g.doneReason || g.status}
                    />
                    <span
                      className={cn(
                        "flex min-w-0 flex-1 flex-col",
                        g.status !== "active" && "opacity-55",
                      )}
                    >
                      <span className="truncate text-item-title font-medium text-fg">
                        {g.name}
                      </span>
                      <span className="mt-0.5 truncate text-supporting text-dim">
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
                          "flex size-5 shrink-0 items-center justify-center [&_svg]:size-3.5",
                          g.lastRunStatus === "ok" ? "text-green" : "text-red",
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
                        "w-21 shrink-0 text-right text-meta text-faint",
                        sel ? "hidden" : "phone:hidden",
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
        <aside className="flex min-h-0 min-w-0 flex-auto flex-col border-l border-line bg-panel max-[900px]:border-l-0">
          <div className="flex shrink-0 items-center gap-2.5 border-b border-divider px-4 py-3">
            {/* Phones get Back instead of Close: there the drawer is the page. */}
            <button
              className="-my-1 -ml-0.5 hidden shrink-0 items-center gap-1.75 px-1.5 py-1 text-item-title font-medium text-fg max-[900px]:inline-flex"
              onClick={() => onSelect("")}
              title="Back to goals"
            >
              <svg
                width="19"
                height="19"
                viewBox="0 0 16 16"
                fill="currentColor"
                className="text-dim"
                aria-hidden
              >
                <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.749.749 0 1 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z" />
              </svg>
              Goals
            </button>
            <span className="min-w-0 truncate text-label font-semibold">
              {editMode ? `Edit ${sel.name}` : sel.name}
            </span>
            {!editMode && (
              <div className="ml-auto flex shrink-0 gap-1.5">
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
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-dim hover:bg-hover hover:text-fg max-[900px]:hidden"
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
          <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 pt-4.5 pb-10">
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
                <div className="flex items-center gap-2.5">
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
                      className="text-faint text-label ml-auto shrink-0"
                      title={sel.nextWakeAt}
                    >
                      next wake {formatNext(sel.nextWakeAt)}
                    </span>
                  )}
                </div>
                {sel.status === "paused" && sel.pauseReason && (
                  <div className="text-dim text-supporting leading-snug">
                    Paused: {sel.pauseReason}
                  </div>
                )}
                {(sel.status === "done" || sel.status === "failed") &&
                  sel.doneReason && (
                    <div className="text-dim text-supporting leading-snug">
                      {sel.status === "done" ? "Done" : "Failed"}:{" "}
                      {sel.doneReason}
                    </div>
                  )}

                <div>
                  <div className={SECTION_LABEL}>Mission</div>
                  <div className="bg-surface border border-line rounded-panel px-3.5 py-3 text-label leading-relaxed text-dim whitespace-pre-wrap">
                    {sel.mission}
                  </div>
                </div>

                <div>
                  <div className={SECTION_LABEL}>Configuration</div>
                  <div className="grid grid-cols-[max-content_1fr] items-baseline gap-x-5 gap-y-2 text-label">
                    <DetailKey>Mode</DetailKey>
                    <span className="text-dim">
                      {sel.mode === "ask"
                        ? "Ask · read-only research and measurement"
                        : `Code · persistent worktree${sel.repo ? ` in ${repoLabel(sel.repo)}` : ""}, can open PRs`}
                    </span>

                    {sel.phase && (
                      <>
                        <DetailKey>Phase</DetailKey>
                        <span className="text-dim min-w-0">{sel.phase}</span>
                      </>
                    )}

                    <DetailKey>Model</DetailKey>
                    <span className="text-dim">
                      {sel.model || `${defaultModel || "default"} (default)`}
                      {sel.fallbackModel && sel.fallbackModel !== "none" && (
                        <span
                          className="text-faint"
                          title="Used only when every account for the primary model has hit its usage limit"
                        >
                          {" "}
                          · falls back to {sel.fallbackModel}
                        </span>
                      )}
                    </span>

                    <DetailKey>Cadence</DetailKey>
                    <span className="text-dim">
                      at least {sel.minWakeMinutes}m between wakes
                      {sel.maxWakes ? ` · capped at ${sel.maxWakes} wakes` : ""}
                    </span>

                    <DetailKey>MCPs</DetailKey>
                    <span className="text-dim min-w-0">
                      {sel.mcpServers?.length
                        ? sel.mcpServers.join(", ")
                        : "all connectors"}
                    </span>

                    {sel.bksSessionId && (
                      <>
                        <DetailKey>Session</DetailKey>
                        <span className="min-w-0">
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
                    <span className="text-dim">by {sel.createdBy}</span>
                  </div>
                </div>

                <div>
                  <div className={SECTION_LABEL}>Activity</div>
                  <div className="text-dim text-supporting mb-2">
                    wake #{sel.wakeCount}
                    {sel.maxWakes ? ` of ${sel.maxWakes}` : ""}
                    {sel.lastRunAt && (
                      <>
                        {" · last wake "}
                        {relativeTime(sel.lastRunAt)}
                        {sel.lastRunStatus === "ok" && (
                          <span className="text-green"> ✓</span>
                        )}
                        {sel.lastRunStatus === "error" && (
                          <span className="text-red" title={sel.lastRunError}>
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
    <span className="text-faint text-label leading-[1.7] whitespace-nowrap">
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
  if (m.accountProvider === "xai") return " (SuperGrok)";
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
          <OptionSelect<"ask" | "code">
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
            onChange={setMode}
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
          className="font-mono"
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
      <div className={`flex flex-col gap-3.5 ${FORM_FIELDS}`}>{fields}</div>
    );

  return (
    <SettingsForm className={`mb-3 flex flex-col gap-3.5 ${FORM_FIELDS}`}>
      <SettingsFormTitle className="mb-0">
        {initial ? `Edit "${initial.name}"` : "New goal"}
      </SettingsFormTitle>
      {fields}
    </SettingsForm>
  );
}
