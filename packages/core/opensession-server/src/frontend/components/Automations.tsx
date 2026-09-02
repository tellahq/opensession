import { BASE_PATH } from "../lib/base";
import React, { useEffect, useEffectEvent, useState } from "react";
import {
  fetchAutomations,
  createAutomationApi,
  updateAutomationApi,
  deleteAutomationApi,
  runAutomationApi,
  retriggerAutomationApi,
  fetchModels,
  fetchAutomationTemplates,
  draftAutomationApi,
  fetchConnections,
  fetchProviderAccounts,
  fetchSandboxStatus,
  relativeTime,
  type ModelOption,
  type ProviderAccountOption,
  type Automation,
  type AutomationInput,
  type AutomationRun,
  type AutomationOutput,
  type AutomationTemplate,
  type AutomationDraft,
  type SandboxStatusInfo,
} from "../lib/api";
import { fetchWorkspaces } from "../lib/api/workspaces";
import { providerAccountLabel } from "../lib/provider-account";
import type { Workspace } from "../lib/types";
import { getCurrentUser } from "./UserPicker";
import { CheckStatusIcon } from "./CheckStatusIcon";
import {
  IconBolt,
  IconChevronLeft,
  IconClock,
  IconHash,
  IconPlayOutline,
  IconPlug,
  IconPlus,
} from "./icons";
import {
  AGENT_NAME,
  WEBHOOK_BASE_URL,
  docTitle,
  DEFAULT_DOC_TITLE,
} from "../lib/brand";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { cn } from "../ui/cn";
import { Input, Select, Textarea } from "../ui/input";
import { Modal, useEnterOnMount } from "../ui/modal";
import { PageDescription, PageHeader, PageTitle } from "../ui/page-header";
import { EmptyState, InlineAlert, LoadingState } from "../ui/state";
import { WorkingPill } from "../ui/status";
import { Switch } from "../ui/switch";
import { formatDuration } from "../lib/time";
import { errorMessage } from "../lib/error-message";
import {
  FIELD_LABEL,
  FORM_ROW,
  sandboxProviderLabel,
} from "../lib/automation-form";
import { AutomationDataFlowEditor } from "./AutomationDataFlowEditor";

/* The old .automation-form family, as utilities. Two of its rules reached in
   from the form to the fields inside it and have to stay descendant selectors:
   every field goes to 16px on phones (below that iOS zooms a focused field),
   and a multi-line brief keeps paragraph leading, which the type scale
   doesn't set. */
const FORM_FIELDS =
  "[&_textarea]:leading-normal phone:[&_input]:text-input-phone phone:[&_select]:text-input-phone phone:[&_textarea]:text-input-phone";
/** The form's own layout, with no chrome of its own: whatever hosts it (the
 *  detail drawer, the create dialog) already provides the surface, the padding
 *  and the heading. */
const FORM_INLINE = `flex flex-col gap-3.5 ${FORM_FIELDS}`;
/** .automation-form-actions */
const FORM_ACTIONS = "flex justify-end gap-2.5";
/** .automations-drawer-section-label */
const SECTION_LABEL = "mb-1.5 text-label font-semibold text-faint";
/** .automation-session-link */
const LINK = "cursor-pointer text-link no-underline hover:underline";
/** .automation-cron — the cron/event chip in the Configuration grid. */
const CHIP = "rounded-sm bg-active px-1.75 py-px text-meta";

interface Props {
  onOpenSession: (sessionId: string) => void;
  /** Selected automation — its id, or its name for sidebar deep-links
   *  (session rows only carry the automation's name). From the route. */
  selectedId?: string;
  /** Change the selection ("" closes the detail drawer). Routed by App. */
  onSelect: (id: string) => void;
}

const CUSTOM = "__custom__";

const PRESETS: Array<{ label: string; cron: string }> = [
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Daily · 9:00 AM PT", cron: "0 16 * * *" },
  { label: "Daily · 9:00 AM CET", cron: "0 8 * * *" },
  { label: "Weekdays · 9:00 AM PT", cron: "0 16 * * 1-5" },
  { label: "Weekdays · 9:00 AM CET", cron: "0 8 * * 1-5" },
  { label: "Mondays · 9:00 AM CET", cron: "0 8 * * 1" },
  { label: "No schedule · webhook or manual only", cron: "" },
  { label: "Custom cron…", cron: CUSTOM },
];

const EVENT_OPTIONS: Array<{ key: string; label: string }> = [
  { key: "plain:thread_created", label: "Plain · new support ticket created" },
  {
    key: "stripe:charge.dispute.created",
    label: "Stripe · dispute (chargeback) created",
  },
  { key: "github:pr_merged", label: "GitHub · PR merged" },
];

/** Claude and Codex accounts for provider-aware automation pins. */
function useProviderAccounts() {
  const [accounts, setAccounts] = useState<ProviderAccountOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    fetchProviderAccounts({
      onPoolError: (cause) =>
        setLoadError(errorMessage(cause, "Could not load provider accounts")),
    })
      .then(setAccounts)
      .catch((cause: unknown) =>
        setLoadError(errorMessage(cause, "Could not load provider accounts")),
      );
  }, []);
  return { accounts, loadError, setLoadError };
}

export function Automations({ onOpenSession, selectedId, onSelect }: Props) {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const pendingToggles = React.useRef(
    new Map<string, { enabled: boolean; request: number }>(),
  );
  const toggleRequest = React.useRef(0);
  const [defaultModel, setDefaultModel] = useState("");
  const [modelLoadError, setModelLoadError] = useState<string | null>(null);
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatusInfo | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const {
    accounts: providerAccounts,
    loadError: providerAccountsError,
    setLoadError: setProviderAccountsError,
  } = useProviderAccounts();

  useEffect(() => {
    fetchModels()
      .then((m) => setDefaultModel(m.default))
      .catch((cause: unknown) =>
        setModelLoadError(errorMessage(cause, "Could not load models")),
      );
    fetchSandboxStatus(getCurrentUser())
      .then(setSandboxStatus)
      .catch(() => setSandboxStatus(null));
  }, []);
  // The modal is create-only; editing happens inline in the detail drawer.
  const [showModal, setShowModal] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Leaving/changing the selection always drops back to the read view.
  useEffect(() => setEditMode(false), [selectedId]);

  const load = async () => {
    try {
      const next = await fetchAutomations();
      setAutomations(
        next.map((automation) => {
          const pending = pendingToggles.current.get(automation.id);
          return pending
            ? { ...automation, enabled: pending.enabled }
            : automation;
        }),
      );
      setLoading(false);
    } catch (cause: unknown) {
      setError(errorMessage(cause, "Could not load automations"));
      setLoading(false);
    }
  };
  const loadForEffect = useEffectEvent(() => load());

  useEffect(() => {
    document.title = docTitle("Automations");
    void loadForEffect();
    const id = setInterval(() => void loadForEffect(), 10000);
    return () => {
      clearInterval(id);
      document.title = DEFAULT_DOC_TITLE;
    };
  }, []);

  // The routed selection — matched by id, or by name for sidebar deep-links.
  const sel = selectedId
    ? automations.find((a) => a.id === selectedId || a.name === selectedId) ||
      null
    : null;

  // Escape backs out one layer: inline edit → read view → closed. (The create
  // modal handles its own Escape — don't close both from one keypress.)
  const hasSelection = !!sel;
  useEffect(() => {
    if (!hasSelection || showModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
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
  }, [hasSelection, showModal, editMode, onSelect]);

  async function handleToggle(a: Automation, enabled: boolean) {
    const previous = a.enabled;
    const request = ++toggleRequest.current;
    pendingToggles.current.set(a.id, { enabled, request });
    setError(null);
    setAutomations((current) =>
      current.map((automation) =>
        automation.id === a.id ? { ...automation, enabled } : automation,
      ),
    );

    try {
      await updateAutomationApi(a.id, { enabled });
      // A second click may have superseded this request. Only the latest intent
      // gets to reconcile the optimistic state with the server response.
      if (pendingToggles.current.get(a.id)?.request !== request) return;
      await load();
      if (pendingToggles.current.get(a.id)?.request === request) {
        pendingToggles.current.delete(a.id);
      }
    } catch (cause: unknown) {
      if (pendingToggles.current.get(a.id)?.request !== request) return;
      pendingToggles.current.delete(a.id);
      setAutomations((current) =>
        current.map((automation) =>
          automation.id === a.id && automation.enabled === enabled
            ? { ...automation, enabled: previous }
            : automation,
        ),
      );
      setError(errorMessage(cause, "Could not update automation"));
    }
  }

  async function handleDelete(automation: Automation) {
    if (!confirm(`Delete automation "${automation.name}"?`)) return;
    try {
      await deleteAutomationApi(automation.id);
      if (sel?.id === automation.id) onSelect("");
      void load();
    } catch (cause: unknown) {
      setError(errorMessage(cause, "Could not delete automation"));
    }
  }

  async function handleRunNow(automation: Automation) {
    try {
      await runAutomationApi(automation.id);
      setTimeout(load, 800);
    } catch (cause: unknown) {
      setError(errorMessage(cause, "Could not run automation"));
    }
  }

  async function handleRetrigger(sessionId: string) {
    try {
      await retriggerAutomationApi(sessionId);
      setTimeout(load, 800);
    } catch (cause: unknown) {
      setError(errorMessage(cause, "Could not retrigger automation"));
    }
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      {/* Drawer open: the list compresses to a narrow rail (Reviews-style), and
        on phones it steps aside entirely — Back returns to it. */}
      <div
        className={cn(
          "min-w-0 overflow-y-auto",
          sel
            ? "flex-[0_0_340px] border-r border-line px-3.5 pt-4 pb-10 max-[900px]:hidden"
            : "flex-1 px-6 pt-7 pb-15 max-[560px]:px-4 max-[560px]:pt-5 max-[560px]:pb-12",
        )}
      >
        <div className={cn("mx-auto", !sel && "max-w-[860px]")}>
          <PageHeader
            className={`max-[560px]:mb-5 max-[560px]:flex-col max-[560px]:items-start max-[560px]:gap-3.5 ${sel ? "mb-3.5 items-center" : ""}`}
          >
            <div>
              <PageTitle className={sel ? "text-base" : undefined}>
                Automations
              </PageTitle>
              <PageDescription className={sel ? "hidden" : undefined}>
                Scheduled {AGENT_NAME} sessions. Cron runs in UTC (server time).
              </PageDescription>
            </div>
            <Button
              variant="primary"
              size="lg"
              icon={<IconPlus size={20} />}
              className="text-control-label font-medium"
              onClick={() => setShowModal(true)}
            >
              New automation
            </Button>
          </PageHeader>

          {error && (
            <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
          )}
          {modelLoadError && (
            <InlineAlert onDismiss={() => setModelLoadError(null)}>
              {modelLoadError}
            </InlineAlert>
          )}
          {providerAccountsError && (
            <InlineAlert onDismiss={() => setProviderAccountsError(null)}>
              {providerAccountsError}
            </InlineAlert>
          )}

          {loading ? (
            <LoadingState>Loading…</LoadingState>
          ) : automations.length === 0 && !showModal ? (
            <EmptyState title="No automations yet.">
              Schedule recurring work: daily PR-review sweeps, dependency
              checks, weekly changelog drafts, flaky-test hunts…
            </EmptyState>
          ) : (
            <div className="flex flex-col border-t border-line">
              {automations.map((a) => {
                const running = a.isRunning || a.lastRunStatus === "running";
                return (
                  <div
                    key={a.id}
                    className={cn(
                      "relative flex w-full min-w-0 items-center gap-3 border-b border-line px-2.5 py-2.75 text-left text-item-title text-fg",
                      "max-[560px]:gap-2.5 max-[560px]:px-1 max-[560px]:py-3",
                      sel?.id === a.id ? "bg-active" : "hover:bg-hover",
                    )}
                  >
                    {/* Two controls in one row: opening the automation, and
                    turning it on. So the row can't be a button around the
                    switch. The open target is a button stretched under the
                    content instead, which keeps the whole row clickable and
                    keyboard-reachable without nesting one inside the other.
                    Content above it is inert unless it has its own tooltip. */}
                    <button
                      className="absolute inset-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50"
                      onClick={() => onSelect(a.id)}
                    >
                      <span className="sr-only">Open {a.name}</span>
                    </button>
                    <TriggerIcon automation={a} />
                    <span
                      className={cn(
                        "pointer-events-none relative flex min-w-0 flex-1 flex-col gap-0.75",
                        !a.enabled && "opacity-55",
                      )}
                    >
                      <span className="truncate text-item-title font-semibold leading-5">
                        {a.name}
                      </span>
                      <span className="truncate text-meta text-faint">
                        {triggerSummary(a)}
                      </span>
                    </span>
                    {running ? (
                      <WorkingPill className="pointer-events-none relative max-[560px]:max-w-[92px] max-[560px]:overflow-hidden max-[560px]:text-ellipsis" />
                    ) : a.lastRunStatus === "ok" ||
                      a.lastRunStatus === "error" ? (
                      // Its own click target rather than an inert glyph: keeping
                      // pointer events is what keeps the tooltip, and the click
                      // does what the row does.
                      <span
                        className={cn(
                          "relative flex size-5 shrink-0 self-start cursor-pointer items-center justify-center [&_svg]:size-3.5",
                          a.lastRunStatus === "ok" ? "text-green" : "text-red",
                        )}
                        onClick={() => onSelect(a.id)}
                        title={
                          a.lastRunStatus === "ok"
                            ? `Last run ok${a.lastRunAt ? ` · ${relativeTime(a.lastRunAt)}` : ""}`
                            : a.lastRunError || "Last run failed"
                        }
                      >
                        <CheckStatusIcon
                          kind={
                            a.lastRunStatus === "ok" ? "success" : "failure"
                          }
                        />
                      </span>
                    ) : null}
                    {/* The graph and the next-run column are the first things to
                    go when width is scarce: the drawer's rail and phones. */}
                    <span
                      className={cn(
                        "relative shrink-0 cursor-pointer",
                        sel ? "hidden" : "flex max-[560px]:hidden",
                      )}
                      onClick={() => onSelect(a.id)}
                    >
                      {(a.runs?.length ?? 0) > 0 && (
                        <TriggerGraph runs={a.runs!} compact />
                      )}
                    </span>
                    <span
                      className={cn(
                        "pointer-events-none relative w-21 shrink-0 text-right text-meta text-faint",
                        sel ? "hidden" : "max-[560px]:hidden",
                      )}
                    >
                      {/* No "off" here any more: it used to be the only state a
                      row carried at this end, and now it sits beside a switch
                      that already says it. */}
                      {a.enabled && a.nextRunAt
                        ? `next ${formatNext(a.nextRunAt)}`
                        : ""}
                    </span>
                    {/* Last in the row: the switch is the one thing you act on
                    here, so it sits on the edge, in a column of its own. */}
                    <Switch
                      size="sm"
                      className="relative"
                      checked={a.enabled}
                      onCheckedChange={(enabled) => handleToggle(a, enabled)}
                      aria-label={`${a.name} · ${a.enabled ? "on" : "off"}`}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {sel && (
        <aside className="flex min-h-0 min-w-0 flex-auto flex-col border-l border-line bg-panel max-[900px]:border-l-0">
          <div className="flex shrink-0 items-center gap-2.5 border-b border-divider px-4 py-3">
            {/* Phones get Back instead of Close: there the drawer is the page. */}
            <button
              className="-my-1 -ml-0.5 hidden shrink-0 items-center gap-1.75 px-1.5 py-1 text-item-title font-medium text-fg max-[900px]:inline-flex"
              onClick={() => onSelect("")}
              title="Back to automations"
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
              Automations
            </button>
            <span className="min-w-0 truncate text-label font-semibold">
              {editMode ? `Edit ${sel.name}` : sel.name}
            </span>
            {!editMode && (
              <div className="ml-auto flex shrink-0 gap-1.5">
                <Button
                  size="sm"
                  variant="soft"
                  onClick={() => handleRunNow(sel)}
                  disabled={sel.isRunning}
                >
                  Run now
                </Button>
                <Button
                  size="sm"
                  variant="soft"
                  onClick={() => setEditMode(true)}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="soft"
                  className="hover:bg-red-soft hover:text-red"
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
              <div className={FORM_INLINE}>
                <AutomationForm
                  key={sel.id}
                  kind={sel.slackWatch?.channel ? "watch" : "classic"}
                  initial={sel}
                  prefill={null}
                  onBack={null}
                  onClose={() => setEditMode(false)}
                  onSaved={() => {
                    setEditMode(false);
                    load();
                  }}
                />
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2.5">
                  <Switch
                    checked={sel.enabled}
                    onCheckedChange={(enabled) => handleToggle(sel, enabled)}
                    aria-label={`${sel.name} · ${sel.enabled ? "on" : "off"}`}
                  />
                  <span className="text-dim text-label">
                    {sel.enabled ? "Enabled" : "Disabled"}
                  </span>
                  {(sel.isRunning || sel.lastRunStatus === "running") && (
                    <WorkingPill />
                  )}
                  {sel.enabled && sel.nextRunAt && (
                    <span className="text-faint text-label ml-auto shrink-0">
                      next run {formatNext(sel.nextRunAt)}
                    </span>
                  )}
                </div>

                <div>
                  <div className={SECTION_LABEL}>Instructions</div>
                  <div className="bg-surface rounded-panel px-3.5 py-3 text-label leading-relaxed text-dim whitespace-pre-wrap">
                    {sel.prompt}
                  </div>
                </div>

                <div>
                  <div className={SECTION_LABEL}>Configuration</div>
                  <div className="grid grid-cols-[max-content_1fr] items-baseline gap-x-5 gap-y-2 text-label">
                    <DetailKey>Trigger</DetailKey>
                    <span className="text-dim min-w-0">
                      {sel.slackWatch?.channel ? (
                        <>
                          watches{" "}
                          <span className={`${CHIP} text-yellow`}>
                            #{sel.slackWatch.channel}
                          </span>{" "}
                          · one run per top-level message
                        </>
                      ) : (
                        <>
                          {sel.schedule && (
                            <>
                              {scheduleLabel(sel.schedule) &&
                                `${scheduleLabel(sel.schedule)} · `}
                              <span className={CHIP} title="Cron, UTC">
                                {sel.schedule}
                              </span>
                            </>
                          )}
                          {sel.schedule && sel.eventKey && " · "}
                          {sel.eventKey && <>on {eventLabel(sel.eventKey)}</>}
                          {!sel.schedule &&
                            !sel.eventKey &&
                            (sel.webhookEnabled === false
                              ? "manual only"
                              : "webhook / manual only")}
                        </>
                      )}
                    </span>

                    <DetailKey>Mode</DetailKey>
                    <span className="text-dim">
                      {sel.mode === "ask"
                        ? sel.sandbox
                          ? "Ask · disposable Sandbox workspace"
                          : "Ask · read-only on the main checkout"
                        : sel.sandbox
                          ? "Code · disposable Sandbox workspace"
                          : "Code · isolated worktree, can open PRs"}
                    </span>

                    <DetailKey>Environment</DetailKey>
                    <span className="text-dim">
                      {sel.sandbox
                        ? sandboxStatus?.automation?.available
                          ? `${sandboxProviderLabel(sandboxStatus.automation.provider)} · fresh disposable Executor`
                          : `Sandbox unavailable${sandboxStatus?.automation?.reason ? ` · ${sandboxStatus.automation.reason}` : ""}`
                        : "Host worktree"}
                    </span>

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

                    {sel.accountId && (
                      <>
                        <DetailKey>Account</DetailKey>
                        <span className="text-dim">
                          {providerAccountLabel(
                            providerAccounts.find(
                              (x) => x.id === sel.accountId,
                            ) ?? {
                              name: "pinned account",
                            },
                          )}
                          <span className="text-faint">
                            {sel.accountStrict === false
                              ? " · preferred, falls back to the shared pool"
                              : " · hard pin (cost cap)"}
                            {sel.usageCredits
                              ? " · paid usage-credits allowed"
                              : ""}
                          </span>
                        </span>
                      </>
                    )}

                    <DetailKey>MCPs</DetailKey>
                    <span className="text-dim min-w-0">
                      {sel.mcpServers === undefined
                        ? "all connectors"
                        : sel.mcpServers.length === 0
                          ? "none"
                          : sel.mcpServers.join(", ")}
                    </span>

                    {sel.inputs?.length ? (
                      <>
                        <DetailKey>Inputs</DetailKey>
                        <span className="text-dim min-w-0">
                          {sel.inputs
                            .map(
                              (input) =>
                                input.label ||
                                (input.source.type === "slack_channel"
                                  ? `Slack ${input.source.channel}`
                                  : input.source.automationId === "self"
                                    ? "previous reports"
                                    : `reports ${input.source.automationId}`),
                            )
                            .join(", ")}
                        </span>
                      </>
                    ) : null}

                    {sel.outputs?.length ? (
                      <>
                        <DetailKey>Outputs</DetailKey>
                        <span className="text-dim min-w-0">
                          {sel.outputs
                            .map((output) => {
                              if (output.type === "report")
                                return `Reports · ${output.publish || "always"}`;
                              return `Slack ${output.channel} · ${output.enabled === false ? "disabled" : `${output.minUrgency || "high"}/${output.minConfidence || "high"}`}`;
                            })
                            .join(", ")}
                        </span>
                      </>
                    ) : null}

                    {sel.webhookEnabled !== false && sel.webhookSecret && (
                      <>
                        <DetailKey>Webhook</DetailKey>
                        <WebhookUrl id={sel.id} secret={sel.webhookSecret} />
                      </>
                    )}

                    <DetailKey>Created</DetailKey>
                    <span className="text-dim">
                      by {sel.createdBy}
                      {sel.createdAt &&
                        ` · ${new Date(sel.createdAt).toLocaleDateString(
                          undefined,
                          {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          },
                        )}`}
                    </span>
                  </div>
                </div>

                <div>
                  <div className={SECTION_LABEL}>Activity</div>
                  {sel.lastRunAt ? (
                    <div className="text-dim text-supporting">
                      last run {relativeTime(sel.lastRunAt)}
                      {sel.lastTrigger ? ` via ${sel.lastTrigger}` : ""}
                      {sel.lastRunStatus === "ok" && (
                        <span className="text-green"> ✓</span>
                      )}
                      {sel.lastRunStatus === "error" && (
                        <span className="text-red" title={sel.lastRunError}>
                          {" "}
                          ✗
                        </span>
                      )}
                      {sel.lastRunSessionId && (
                        <>
                          {" · "}
                          <a
                            className={LINK}
                            onClick={(e) => {
                              e.preventDefault();
                              onOpenSession(sel.lastRunSessionId!);
                            }}
                            href={`${BASE_PATH}/session/${sel.lastRunSessionId}`}
                          >
                            view session
                          </a>
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="text-faint text-supporting">
                      No runs yet.
                    </div>
                  )}
                  {(sel.runs?.length ?? 0) > 0 && (
                    <>
                      <TriggerGraph runs={sel.runs!} />
                      <RunLedger
                        runs={sel.runs!}
                        onOpenSession={onOpenSession}
                        onRetrigger={handleRetrigger}
                      />
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </aside>
      )}

      {showModal && (
        <CreateAutomationModal
          onClose={() => setShowModal(false)}
          onSaved={() => {
            setShowModal(false);
            load();
          }}
        />
      )}
    </div>
  );
}

/**
 * The row's leading glyph: what makes this automation run. Most of them are
 * the clock, which is the point. The few that aren't (an event, a webhook, a
 * watched channel) are what you scan for, and they now show up without
 * reading the line under the name.
 */
function TriggerIcon({ automation }: { automation: Automation }) {
  // Normalize each glyph's drawn height, not just its SVG box. These icons
  // occupy different proportions of the shared 24px viewBox.
  const { Icon, scale } = automation.slackWatch
    ? { Icon: IconHash, scale: "scale-[1.15]" }
    : automation.schedule
      ? { Icon: IconClock, scale: "scale-[1.15]" }
      : automation.eventKey
        ? { Icon: IconBolt, scale: "scale-[1.15]" }
        : automation.webhookEnabled === false
          ? { Icon: IconPlayOutline, scale: "scale-110" }
          : { Icon: IconPlug, scale: "scale-[1.15]" };
  return (
    <span
      className={cn(
        "pointer-events-none relative flex size-5 shrink-0 self-start items-center justify-center text-faint",
        !automation.enabled && "opacity-55",
      )}
    >
      <Icon size={20} className={cn("max-w-none", scale)} />
    </span>
  );
}

/** One-line trigger summary for the list rows. */
function triggerSummary(a: Automation): string {
  if (a.slackWatch) return `watching #${a.slackWatch.channel}`;
  const parts: string[] = [];
  if (a.schedule) parts.push(a.schedule);
  if (a.eventKey) parts.push(`on ${a.eventKey}`);
  if (!parts.length)
    parts.push(a.webhookEnabled === false ? "manual only" : "webhook / manual");
  return parts.join(" · ");
}

/** The preset's human label for a cron, when it matches one ("Daily · 9:00 AM PT"). */
function scheduleLabel(cron: string): string | null {
  const p = PRESETS.find((p) => p.cron === cron && p.cron && p.cron !== CUSTOM);
  return p ? p.label : null;
}

function eventLabel(key: string): string {
  return EVENT_OPTIONS.find((o) => o.key === key)?.label || key;
}

/** Left column of the drawer's Configuration grid. */
function DetailKey({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-faint text-label leading-[1.7] whitespace-nowrap">
      {children}
    </span>
  );
}

// ── Trigger history graph ────────────────────────────────────

const GRAPH_DAYS = 30;
const SLOT = 9; // 7px bar + 2px gap
const PLOT_H = 26;

/** Runs-per-day bar strip for the last 30 days. Status is state, so it uses
 *  the reserved status tokens (green/yellow/red); per-bar tooltips carry the
 *  counts in text and the expanded run ledger is the table view. */
function TriggerGraph({
  runs,
  compact,
}: {
  runs: AutomationRun[];
  compact?: boolean;
}) {
  const buckets = (() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const out = Array.from({ length: GRAPH_DAYS }, (_, i) => {
      const date = new Date(
        today.getTime() - (GRAPH_DAYS - 1 - i) * 86_400_000,
      );
      return { date, ok: 0, error: 0, running: 0 };
    });
    for (const r of runs) {
      const d = new Date(r.at);
      d.setHours(0, 0, 0, 0);
      const idx = Math.round(
        (d.getTime() - out[0].date.getTime()) / 86_400_000,
      );
      if (idx >= 0 && idx < out.length) out[idx][r.status]++;
    }
    return out;
  })();

  const max = Math.max(1, ...buckets.map((b) => b.ok + b.error + b.running));
  const total = buckets.reduce((n, b) => n + b.ok + b.error + b.running, 0);
  if (total === 0) return null;

  return (
    <div className={`flex items-end gap-2 ${compact ? "" : "mt-2"}`}>
      <svg
        width={GRAPH_DAYS * SLOT - 2}
        height={PLOT_H + 1}
        role="img"
        aria-label={`Trigger history: ${total} runs in the last ${GRAPH_DAYS} days`}
        className="shrink-0"
      >
        {/* baseline */}
        <rect
          x={0}
          y={PLOT_H}
          width={GRAPH_DAYS * SLOT - 2}
          height={1}
          fill="var(--border)"
        />
        {buckets.map((b, i) => {
          const count = b.ok + b.error + b.running;
          const label = b.date.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          });
          if (count === 0) {
            return (
              <rect
                key={i}
                x={i * SLOT}
                y={PLOT_H - 2}
                width={SLOT - 2}
                height={2}
                rx={1}
                fill="var(--border)"
              >
                <title>{`${label} · no runs`}</title>
              </rect>
            );
          }
          const h = Math.max(4, Math.round((count / max) * PLOT_H));
          const fill =
            b.error > 0
              ? "var(--red)"
              : b.running > 0
                ? "var(--yellow)"
                : "var(--green)";
          const parts = [
            b.ok ? `${b.ok} ok` : "",
            b.error ? `${b.error} failed` : "",
            b.running ? `${b.running} running` : "",
          ].filter(Boolean);
          // rx 3 of a 7px bar rounds the cap without closing it into a
          // capsule, so a tall bar still shows a straight side to read a
          // height off. Short ones pill anyway: ry clamps to half the height.
          return (
            <rect
              key={i}
              x={i * SLOT}
              y={PLOT_H - h}
              width={SLOT - 2}
              height={h}
              rx={3}
              fill={fill}
            >
              <title>{`${label} · ${count} run${count === 1 ? "" : "s"} (${parts.join(", ")})`}</title>
            </rect>
          );
        })}
      </svg>
      {!compact && (
        <span className="pb-px text-meta leading-none text-faint">
          {total} run{total === 1 ? "" : "s"} · last {GRAPH_DAYS}d
        </span>
      )}
    </div>
  );
}

/** Expandable run-history ledger for one automation (newest first). */
function RunLedger({
  runs,
  onOpenSession,
  onRetrigger,
}: {
  runs: AutomationRun[];
  onOpenSession: (sessionId: string) => void;
  onRetrigger: (sessionId: string) => void;
}) {
  return (
    <div className="mt-2.5 border-t border-line pt-2 flex flex-col gap-1">
      {runs.map((r) => (
        <div
          key={r.sessionId + r.at}
          className="flex items-baseline gap-2 text-label text-dim min-w-0"
        >
          {r.status === "running" ? (
            <span className="text-yellow shrink-0">●</span>
          ) : r.status === "ok" ? (
            <span className="text-green shrink-0">✓</span>
          ) : (
            <span className="text-red shrink-0" title={r.error}>
              ✗
            </span>
          )}
          <span className="shrink-0" title={new Date(r.at).toLocaleString()}>
            {relativeTime(r.at)}
          </span>
          <span className="text-faint shrink-0">via {r.trigger}</span>
          {r.durationMs != null && (
            <span className="text-faint shrink-0">
              {formatDuration(r.durationMs)}
            </span>
          )}
          {r.error && (
            <span className="text-red truncate" title={r.error}>
              {r.error}
            </span>
          )}
          <a
            className={cn(LINK, "ml-auto shrink-0")}
            href={`${BASE_PATH}/session/${r.sessionId}`}
            onClick={(e) => {
              e.preventDefault();
              onOpenSession(r.sessionId);
            }}
          >
            view session
          </a>
          {r.status !== "running" && (
            <button
              className={cn(LINK, "shrink-0 text-label")}
              title={
                r.trigger === "event" || r.trigger === "webhook"
                  ? "Start a fresh run replaying this run's triggering event"
                  : "Start a fresh run of this automation"
              }
              onClick={() => onRetrigger(r.sessionId)}
            >
              retrigger
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Secret webhook URL as a Configuration-grid value: truncated URL + copy. */
function WebhookUrl({ id, secret }: { id: string; secret: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${WEBHOOK_BASE_URL}/automations/${id}/${secret}`;

  return (
    <span className="flex items-center gap-2 min-w-0">
      <span className="min-w-0 flex-1 truncate text-meta text-dim" title={url}>
        POST {url.replace(secret, secret.slice(0, 6) + "…")}
      </span>
      <Button
        size="sm"
        variant="soft"
        className="shrink-0"
        onClick={() => {
          navigator.clipboard.writeText(url).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied ✓" : "Copy URL"}
      </Button>
    </span>
  );
}

function formatNext(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 60_000) return "in <1m";
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`;
  return `in ${Math.round(diff / 86_400_000)}d`;
}

// ── Create / edit modal ──────────────────────────────────────

type Step = "type" | "classic" | "watch";

const CATEGORY_LABELS: Record<AutomationTemplate["category"], string> = {
  sweep: "Sweep",
  digest: "Digest",
  investigator: "Investigator",
  triage: "Triage",
  hygiene: "Hygiene",
};

/** Create-only: editing renders AutomationForm in the detail drawer instead. */
function CreateAutomationModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [step, setStep] = useState<Step>("type");
  const [prefill, setPrefill] = useState<AutomationDraft | null>(null);
  // The page mounts this only while it should be open, so the enter animation
  // needs one frame at open={false} first (see ui/modal.tsx).
  const open = useEnterOnMount();
  // Describing it is the first path on offer, so the caret starts there rather
  // than on the close button Base UI would otherwise pick.
  const describeRef = React.useRef<HTMLTextAreaElement>(null);

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content
        widthClassName="max-w-[40rem]"
        initialFocus={step === "type" ? describeRef : undefined}
      >
        {step === "type" ? (
          <TypeChooser
            describeRef={describeRef}
            onPick={(draft, s) => {
              setPrefill(draft);
              setStep(s);
            }}
          />
        ) : (
          <>
            <Modal.Header
              title={
                step === "watch" ? "Watch a Slack channel" : "New automation"
              }
              description={
                step === "watch"
                  ? `${AGENT_NAME} triages every new message in the channel.`
                  : "Runs on a schedule, an internal event, or a webhook."
              }
            />
            <div className={FORM_INLINE}>
              <AutomationForm
                kind={step}
                initial={null}
                prefill={prefill}
                onBack={() => setStep("type")}
                onClose={onClose}
                onSaved={onSaved}
              />
            </div>
          </>
        )}
      </Modal.Content>
    </Modal.Root>
  );
}

/**
 * One starting point: a blank type, or a template. Same anatomy as a row in
 * the list this creates — trigger glyph, name, one line about it — so the
 * choice looks like the thing it makes.
 */
function ChooserRow({
  icon: Icon,
  title,
  description,
  meta,
  onClick,
}: {
  icon: (props: { size?: number; className?: string }) => React.ReactElement;
  title: string;
  description: string;
  meta?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full cursor-pointer items-start gap-3 rounded-row px-2.5 py-2.25 text-left transition-colors hover:bg-hover"
      onClick={onClick}
    >
      {/* Normalize the drawn height, not the SVG box, the way the list rows do. */}
      <span className="flex size-5 shrink-0 items-center justify-center text-faint">
        <Icon size={20} className="max-w-none scale-[1.15]" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.75">
        <span className="text-item-title font-semibold leading-5 text-fg">
          {title}
        </span>
        <span className="text-supporting leading-normal text-faint">
          {description}
        </span>
      </span>
      {meta && (
        <span className="mt-0.5 shrink-0 text-meta text-faint">{meta}</span>
      )}
    </button>
  );
}

/** Step 1: describe it, start blank, or start from a template. */
function TypeChooser({
  describeRef,
  onPick,
}: {
  describeRef: React.RefObject<HTMLTextAreaElement | null>;
  onPick: (
    prefill: AutomationDraft | null,
    step: Exclude<Step, "type">,
  ) => void;
}) {
  const [templates, setTemplates] = useState<AutomationTemplate[]>([]);
  const [templateLoadError, setTemplateLoadError] = useState<string | null>(
    null,
  );
  const [description, setDescription] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAutomationTemplates()
      .then(setTemplates)
      .catch((cause: unknown) =>
        setTemplateLoadError(
          errorMessage(cause, "Could not load automation templates"),
        ),
      );
  }, []);

  async function handleDraft() {
    if (description.trim().length < 10 || drafting) return;
    setDrafting(true);
    setError(null);
    try {
      onPick(await draftAutomationApi(description), "classic");
    } catch (cause: unknown) {
      setError(errorMessage(cause, "Could not draft automation"));
      setDrafting(false);
    }
  }

  return (
    <>
      <Modal.Header
        title="New automation"
        description="Describe what you want, or start from a template. Everything stays editable."
      />

      <div className="flex flex-col gap-2">
        <Textarea
          ref={describeRef}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleDraft();
          }}
          rows={2}
          aria-label="Describe the automation"
          placeholder="Every weekday morning, check Sentry for new errors and rank them by impact"
        />
        {error && (
          <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
        )}
        {templateLoadError && (
          <InlineAlert onDismiss={() => setTemplateLoadError(null)}>
            {templateLoadError}
          </InlineAlert>
        )}
        <div className="flex justify-end">
          <Button
            variant="primary"
            onClick={handleDraft}
            disabled={drafting || description.trim().length < 10}
          >
            {drafting ? "Drafting…" : "Draft it"}
          </Button>
        </div>
      </div>

      {/* Outdented by the rows' own padding, so each group's label shares an x
          with the rows under it (see src/frontend/AGENTS.md). */}
      <div className="-mx-2.5">
        <div className={cn(SECTION_LABEL, "px-2.5")}>Start from scratch</div>
        <ChooserRow
          icon={IconClock}
          title="Schedule, event or webhook"
          description={`${AGENT_NAME} runs once each time the trigger fires.`}
          onClick={() => onPick(null, "classic")}
        />
        <ChooserRow
          icon={IconHash}
          title="Slack channel watch"
          description={`${AGENT_NAME} triages every new message, with the channel's memory as context.`}
          onClick={() => onPick(null, "watch")}
        />
      </div>

      {templates.length > 0 && (
        <div className="-mx-2.5 flex min-h-0 flex-col">
          <div className={cn(SECTION_LABEL, "px-2.5")}>Templates</div>
          {/* The gallery scrolls inside the dialog rather than growing it, so
              the describe field and the two blank starts stay on screen. */}
          <div className="min-h-0 overflow-y-auto overscroll-contain phone:max-h-none desktop:max-h-[32dvh]">
            {templates.map((t) => (
              <ChooserRow
                key={t.id}
                icon={t.schedule ? IconClock : t.eventKey ? IconBolt : IconPlug}
                title={t.name}
                description={t.description}
                meta={CATEGORY_LABELS[t.category] || t.category}
                onClick={() => onPick(t, "classic")}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ── MCP multi-select picker ──────────────────────────────────

/** Devin-style connector picker. `value` semantics match the server:
 *  undefined = all servers, [] = none, else the named allowlist. */
function McpPicker({
  value,
  onChange,
}: {
  value: string[] | undefined;
  onChange: (v: string[] | undefined) => void;
}) {
  const [servers, setServers] = useState<
    Array<{ name: string; status: string }>
  >([]);
  const [search, setSearch] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetchConnections()
      .then((c) =>
        setServers(
          (c.mcpServers || []).map((server) => ({
            name: server.name,
            status: server.status,
          })),
        ),
      )
      .catch((cause: unknown) =>
        setLoadError(errorMessage(cause, "Could not load MCP servers")),
      );
  }, []);

  const all = value === undefined;
  const selected = value || [];
  const shown = servers.filter((s) =>
    s.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  function toggle(name: string) {
    if (all) {
      // Leaving "all" mode by picking: start an explicit list with just this one
      onChange([name]);
      return;
    }
    onChange(
      selected.includes(name)
        ? selected.filter((n) => n !== name)
        : [...selected, name],
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-fg text-label font-medium">MCPs</span>
        <span className="text-dim text-label">
          Select which connectors this automation's runs can use
        </span>
        <a
          className="text-dim text-label underline ml-auto shrink-0"
          href={`${BASE_PATH}/settings`}
        >
          Manage MCPs
        </a>
      </div>
      {loadError && (
        <InlineAlert onDismiss={() => setLoadError(null)}>
          {loadError}
        </InlineAlert>
      )}
      <div className="bg-surface rounded-panel overflow-hidden">
        <div className="flex items-center gap-2 border-b border-divider px-3 py-2">
          {/* Chrome-less on purpose: the picker's own panel is the surface, so
              a second well inside it would read as a box in a box. */}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search MCPs…"
            className="flex-1 bg-transparent border-0 outline-none text-label text-fg placeholder:text-faint"
            style={{ border: "none", padding: 0, background: "transparent" }}
          />
          <span className="text-faint text-meta shrink-0">
            {all ? "all connectors" : `${selected.length} selected`}
          </span>
        </div>
        <label className="flex items-center gap-2.5 border-b border-line px-3 py-2 text-label cursor-pointer hover:bg-hover">
          <Checkbox
            checked={all}
            onCheckedChange={() => onChange(all ? [] : undefined)}
          />
          <span className="text-fg">All connectors</span>
          <span className="text-faint text-meta">
            every configured server (pre-least-privilege default)
          </span>
        </label>
        <div className="max-h-[180px] overflow-y-auto">
          {shown.map((s) => (
            <label
              key={s.name}
              className="flex items-center gap-2.5 px-3 py-1.5 text-label cursor-pointer hover:bg-hover"
            >
              <Checkbox
                checked={all || selected.includes(s.name)}
                onCheckedChange={() => toggle(s.name)}
              />
              <span className="text-fg">{s.name}</span>
              {s.status !== "connected" && s.status !== "ready" && (
                <span className="text-yellow text-meta">{s.status}</span>
              )}
            </label>
          ))}
          {shown.length === 0 && (
            <div className="px-3 py-2 text-faint text-label">
              No connectors match.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Classic / watch form (step 2) ────────────────────────────

/** " (Claude)" / " (OpenAI Codex)" by the model's ACCOUNT POOL — the engine
 *  provider ("pi"/"pi") says nothing about whose subscription pays, and
 *  keying off it labeled every engine entry "(Claude)". Pool-less models get
 *  no suffix. */
function accountPoolSuffix(m: ModelOption): string {
  if (m.accountProvider === "codex") return " (OpenAI Codex)";
  if (m.accountProvider === "claude") return " (Claude)";
  return "";
}

/** The fields themselves. Both hosts (the detail drawer and the create dialog)
 *  already name the surface, so the form carries no heading of its own. It only
 *  adds Back to its actions when there is a step to go back to. */
function AutomationForm({
  kind,
  initial,
  prefill,
  onBack,
  onClose,
  onSaved,
}: {
  kind: "classic" | "watch";
  initial: Automation | null;
  prefill?: AutomationDraft | null;
  onBack: (() => void) | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const startSchedule = initial
    ? initial.schedule
    : (prefill?.schedule ?? PRESETS[2].cron);
  const matchesPreset = PRESETS.some(
    (p) => p.cron === startSchedule && p.cron !== CUSTOM,
  );
  const initialPreset = matchesPreset ? startSchedule : CUSTOM;

  const [name, setName] = useState(initial?.name || prefill?.name || "");
  const [prompt, setPrompt] = useState(
    initial?.prompt || prefill?.prompt || "",
  );
  const [preset, setPreset] = useState(initialPreset);
  const [customCron, setCustomCron] = useState(
    !matchesPreset ? startSchedule : "",
  );
  const [mode, setMode] = useState<"ask" | "code">(
    initial?.mode || prefill?.mode || "ask",
  );
  const [eventKey, setEventKey] = useState(
    initial?.eventKey || prefill?.eventKey || "",
  );
  const [watchChannel, setWatchChannel] = useState(
    initial?.slackWatch?.channel || "",
  );
  const [webhookEnabled, setWebhookEnabled] = useState(
    initial ? initial.webhookEnabled !== false : false,
  );
  const [inputs, setInputs] = useState<AutomationInput[]>(() =>
    initial?.inputs ? structuredClone(initial.inputs) : [],
  );
  const [outputs, setOutputs] = useState<AutomationOutput[]>(() =>
    initial?.outputs ? structuredClone(initial.outputs) : [],
  );
  const [mcpServers, setMcpServers] = useState<string[] | undefined>(
    initial
      ? initial.mcpServers
      : (prefill?.mcpServers ?? (kind === "watch" ? ["slack"] : undefined)),
  );
  // Who is accountable for what this automation does to the codebase. Empty
  // means nobody has taken it, which is what every automation written before
  // owners existed still says.
  const [owner, setOwner] = useState(initial?.owner || "");
  const [workspaceId, setWorkspaceId] = useState(initial?.workspaceId || "");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [model, setModel] = useState(initial?.model || "");
  const [fallbackModel, setFallbackModel] = useState(
    initial?.fallbackModel || "",
  );
  const [accountId, setAccountId] = useState(initial?.accountId || "");
  const [accountStrict, setAccountStrict] = useState(
    initial?.accountStrict !== false,
  );
  const [usageCredits, setUsageCredits] = useState(!!initial?.usageCredits);
  const [sandbox, setSandbox] = useState(!!initial?.sandbox);
  const [sandboxAvailability, setSandboxAvailability] = useState<
    SandboxStatusInfo["automation"] | null
  >(null);
  const [sandboxProviders, setSandboxProviders] = useState<
    SandboxStatusInfo["providers"]
  >([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [modelLoadError, setModelLoadError] = useState<string | null>(null);
  const [workspaceLoadError, setWorkspaceLoadError] = useState<string | null>(
    null,
  );
  const {
    accounts: providerAccounts,
    loadError: providerAccountsError,
    setLoadError: setProviderAccountsError,
  } = useProviderAccounts();

  useEffect(() => {
    fetchModels()
      .then((m) => {
        setModels(m.models);
        setDefaultModel(m.default);
      })
      .catch((cause: unknown) =>
        setModelLoadError(errorMessage(cause, "Could not load models")),
      );
    fetchWorkspaces({
      onError: (cause) =>
        setWorkspaceLoadError(errorMessage(cause, "Could not load workspaces")),
    }).then(setWorkspaces);
    fetchSandboxStatus(getCurrentUser())
      .then((status) => {
        setSandboxProviders(status.providers);
        setSandboxAvailability(
          status.automation || {
            provider: "daytona",
            available: false,
            reason: "The server does not support sandbox automations yet.",
          },
        );
      })
      .catch((cause: unknown) =>
        setSandboxAvailability({
          provider: "daytona",
          available: false,
          reason: errorMessage(
            cause,
            "Could not check sandbox automation availability",
          ),
        }),
      );
  }, []);
  const effectiveModel = model || defaultModel;
  const accountProvider = models.find(
    (item) => item.id === effectiveModel,
  )?.accountProvider;
  const eligibleAccounts = providerAccounts.filter(
    (account) => account.provider === accountProvider,
  );
  useEffect(() => {
    const account = providerAccounts.find((item) => item.id === accountId);
    if (account && account.provider !== accountProvider) setAccountId("");
  }, [accountId, accountProvider, providerAccounts]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isWatch = kind === "watch";
  const schedule = isWatch
    ? ""
    : preset === CUSTOM
      ? customCron.trim()
      : preset;
  const scheduleValid =
    isWatch || preset !== CUSTOM || customCron.trim().length > 0;
  const watchValid =
    !isWatch || /^[CG][A-Z0-9]{6,}$/i.test(watchChannel.trim());

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const slackWatch = isWatch
        ? { channel: watchChannel.trim().toUpperCase() }
        : initial?.slackWatch
          ? { channel: "" } // editing a watch automation into a classic one clears it
          : undefined;
      if (initial) {
        await updateAutomationApi(initial.id, {
          name,
          prompt,
          schedule,
          mode,
          eventKey: isWatch ? "" : eventKey,
          model,
          fallbackModel,
          accountId,
          accountStrict,
          usageCredits,
          sandbox,
          mcpServers: mcpServers ?? null,
          slackWatch,
          webhookEnabled: isWatch ? false : webhookEnabled,
          inputs: isWatch ? [] : inputs,
          outputs: isWatch ? [] : outputs,
          owner: owner.trim(),
          workspaceId,
        });
      } else {
        await createAutomationApi({
          name,
          prompt,
          schedule,
          mode,
          eventKey: (!isWatch && eventKey) || undefined,
          model: model || undefined,
          fallbackModel: fallbackModel || undefined,
          accountId: accountId || undefined,
          accountStrict: accountId && !accountStrict ? false : undefined,
          usageCredits: usageCredits || undefined,
          sandbox: sandbox || undefined,
          mcpServers,
          slackWatch,
          webhookEnabled: isWatch ? false : webhookEnabled,
          inputs: isWatch ? undefined : inputs,
          outputs: isWatch ? undefined : outputs,
          owner: owner.trim() || undefined,
          workspaceId: workspaceId || undefined,
          createdBy: getCurrentUser(),
        });
      }
      onSaved();
    } catch (cause: unknown) {
      setError(errorMessage(cause, "Could not save automation"));
      setSaving(false);
    }
  }

  return (
    <>
      <label className={FIELD_LABEL}>
        Automation name
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={
            isWatch ? "Support channel triage" : "Daily PR review sweep"
          }
        />
      </label>

      <div className="flex gap-3">
        <label className={FIELD_LABEL}>
          Owner
          <Input
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder={getCurrentUser() || "Kent"}
          />
          <span className="mt-1 text-supporting leading-snug text-faint">
            Who reviews what it does. It appears in their sidebar.
          </span>
        </label>
        <label className={FIELD_LABEL}>
          Workspace
          <Select
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
          >
            <option value="">No workspace</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
          <span className="mt-1 text-supporting leading-snug text-faint">
            Files the automation under a workspace. Its runs stay in the
            Automations section.
          </span>
        </label>
      </div>

      {isWatch ? (
        <label className={FIELD_LABEL}>
          Slack channel: what channel should {AGENT_NAME} watch?
          <Input
            value={watchChannel}
            onChange={(e) => setWatchChannel(e.target.value)}
            placeholder="C0123456789 (channel id)"
            className="mono-input"
          />
          <span className="mt-1 text-supporting leading-snug text-faint">
            Invite @{AGENT_NAME} to the channel first. The bot only receives
            messages for channels it's a member of. One run per top-level
            message; thread replies don't re-trigger. Channel id is in the
            channel's “About” tab.
          </span>
        </label>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div>
            <span className="text-fg text-label font-medium">Triggers</span>
            <span className="text-dim text-label ml-2">
              Run the automation when any of these conditions are met
            </span>
          </div>
          <div className="bg-surface rounded-panel px-3 py-2.5 flex flex-col gap-2.5">
            <label className={FIELD_LABEL}>
              Schedule
              <Select
                value={preset}
                onChange={(e) => setPreset(e.target.value)}
              >
                {PRESETS.map((p) => (
                  <option key={p.label} value={p.cron}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </label>
            {preset === CUSTOM && (
              <label className={FIELD_LABEL}>
                Cron expression (UTC)
                <Input
                  value={customCron}
                  onChange={(e) => setCustomCron(e.target.value)}
                  placeholder="0 16 * * 1-5"
                  className="mono-input"
                />
              </label>
            )}
            <label className={FIELD_LABEL}>
              Internal event
              <Select
                value={eventKey}
                onChange={(e) => setEventKey(e.target.value)}
              >
                <option value="">None</option>
                {EVENT_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </label>
            <div className="text-supporting text-faint">
              Schedules and events can be combined. Manual “Run now” is always
              available.
            </div>
            <label className="flex min-h-10 items-center gap-2.5 text-label text-dim">
              <Checkbox
                checked={webhookEnabled}
                onCheckedChange={setWebhookEnabled}
              />
              <span>
                Accept webhook triggers
                <span className="ml-1.5 text-faint">
                  Creates a secret external POST URL
                </span>
              </span>
            </label>
          </div>
        </div>
      )}

      <label className={FIELD_LABEL}>
        Instructions: what {AGENT_NAME} does{" "}
        {isWatch ? "with each message" : "when triggers activate"}
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
          placeholder={
            isWatch
              ? `Tell ${AGENT_NAME} how to handle messages in this channel. e.g. “triage each report: reproduce, check Sentry, file a Linear issue, reply in the thread with what you found.”`
              : `What should ${AGENT_NAME} do on each run?`
          }
        />
      </label>

      <McpPicker value={mcpServers} onChange={setMcpServers} />

      {!isWatch && (
        <AutomationDataFlowEditor
          inputs={inputs}
          outputs={outputs}
          onInputsChange={setInputs}
          onOutputsChange={setOutputs}
        />
      )}

      <div>
        <Button
          size="sm"
          variant="soft"
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced ? "Hide advanced" : "Advanced"}
        </Button>
      </div>

      {showAdvanced && (
        <div className={cn(FORM_ROW, "desktop:flex-wrap")}>
          <label className={FIELD_LABEL}>
            Mode
            <Select
              value={mode}
              onChange={(e) =>
                setMode(e.target.value === "code" ? "code" : "ask")
              }
            >
              <option value="ask">Ask · read-only on main</option>
              <option value="code">Code · fresh worktree per run</option>
            </Select>
          </label>

          <label
            className={cn(FIELD_LABEL, "desktop:w-full desktop:flex-none")}
          >
            Execution environment
            <Select
              value={sandbox ? "daytona" : ""}
              onChange={(event) => {
                const checked = event.target.value === "daytona";
                setSandbox(checked);
                if (checked) {
                  setAccountStrict(true);
                  setFallbackModel("");
                  setMcpServers((current) => current ?? []);
                }
              }}
            >
              <option value="">Host worktree</option>
              <option
                value="daytona"
                disabled={!sandbox && !sandboxAvailability?.available}
              >
                Daytona
                {sandboxAvailability?.available ? "" : " · unavailable"}
              </option>
              {sandboxProviders
                .filter((provider) => provider.id !== "daytona")
                .map((provider) => (
                  <option key={provider.id} value={provider.id} disabled>
                    {sandboxProviderLabel(provider.id)} · unavailable for
                    automations
                  </option>
                ))}
            </Select>
            <span className="mt-1 text-supporting leading-snug text-faint">
              {sandboxAvailability?.available
                ? "Daytona uses a fresh disposable Executor with pinned credentials and restricted network access."
                : sandboxAvailability?.reason || "Checking availability"}
            </span>
          </label>

          <label className={FIELD_LABEL}>
            Model
            <Select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">
                Default{defaultModel ? ` · ${defaultModel}` : ""}
              </option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {accountPoolSuffix(m)}
                </option>
              ))}
            </Select>
          </label>

          <label className={FIELD_LABEL}>
            Fallback (when all accounts hit usage limits)
            <Select
              value={fallbackModel}
              onChange={(e) => setFallbackModel(e.target.value)}
              disabled={sandbox}
            >
              <option value="">None · fail instead of falling back</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {accountPoolSuffix(m)}
                </option>
              ))}
            </Select>
          </label>

          <label
            className={FIELD_LABEL}
            title="Pin runs to one account from the selected model's provider pool."
          >
            Provider account
            <Select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">Auto · shared pool rotation</option>
              {eligibleAccounts.map((x) => (
                <option key={x.id} value={x.id}>
                  {providerAccountLabel(x)}
                  {x.owner ? ` · ${x.owner}'s` : ""}
                </option>
              ))}
            </Select>
          </label>

          {accountId && (
            <label
              className={FIELD_LABEL}
              title="Out of usage, runs switch to the fallback model rather than the shared pool, so this account's limits cap the cost. Prefer it rotates into the pool instead."
            >
              When the pinned account is out of usage
              <Select
                value={accountStrict ? "strict" : "pool"}
                onChange={(e) => setAccountStrict(e.target.value === "strict")}
                disabled={sandbox}
              >
                <option value="strict">
                  This account only · fall back by model (cost cap)
                </option>
                <option value="pool">
                  Prefer it · fall back to the shared pool
                </option>
              </Select>
            </label>
          )}

          <label
            className={FIELD_LABEL}
            title="Pay-as-you-go spend past the subscription's included limits. Only applies to accounts with extra usage enabled at claude.ai, bounded by their monthly credit cap."
          >
            Usage credits
            <Select
              value={usageCredits ? "allow" : "never"}
              onChange={(e) => setUsageCredits(e.target.value === "allow")}
            >
              <option value="never">
                Never · stop or fall back at the limit
              </option>
              <option value="allow">
                Allowed · keep going on paid credits
              </option>
            </Select>
          </label>
        </div>
      )}

      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}
      {modelLoadError && (
        <InlineAlert onDismiss={() => setModelLoadError(null)}>
          {modelLoadError}
        </InlineAlert>
      )}
      {workspaceLoadError && (
        <InlineAlert onDismiss={() => setWorkspaceLoadError(null)}>
          {workspaceLoadError}
        </InlineAlert>
      )}
      {providerAccountsError && (
        <InlineAlert onDismiss={() => setProviderAccountsError(null)}>
          {providerAccountsError}
        </InlineAlert>
      )}

      <div className={FORM_ACTIONS}>
        {onBack && (
          <Button
            variant="ghost"
            className="mr-auto"
            icon={<IconChevronLeft size={20} />}
            onClick={onBack}
            disabled={saving}
          >
            Back
          </Button>
        )}
        <Button variant="soft" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={
            saving ||
            !name.trim() ||
            !prompt.trim() ||
            !scheduleValid ||
            !watchValid ||
            (sandbox && (!accountId || sandboxAvailability?.available !== true))
          }
        >
          {saving ? "Saving…" : initial ? "Save changes" : "Create automation"}
        </Button>
      </div>
    </>
  );
}
