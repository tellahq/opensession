import { BASE_PATH } from "../lib/base";
import React, { useEffect, useMemo, useState, useCallback } from "react";
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
  relativeTime,
  type ModelOption,
  type ProviderAccountOption,
  type AutomationTemplate,
  type AutomationDraft,
} from "../lib/api";
import { getCurrentUser } from "./UserPicker";
import { AGENT_NAME, PUBLIC_BASE_URL, docTitle, DEFAULT_DOC_TITLE } from "../lib/brand";
import { Button } from "../ui/button";
import { PageDescription, PageHeader, PageTitle } from "../ui/page-header";
import { InlineAlert } from "../ui/state";
import { cn } from "../ui/cn";

interface AutomationRun {
  at: string;
  sessionId: string;
  trigger: "cron" | "webhook" | "manual" | "event";
  status: "running" | "ok" | "error";
  error?: string;
  durationMs?: number;
}

interface Automation {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  mode: "ask" | "code";
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  webhookSecret?: string;
  eventKey?: string;
  mcpServers?: string[];
  slackWatch?: { channel: string };
  model?: string;
  fallbackModel?: string;
  accountId?: string;
  accountStrict?: boolean;
  usageCredits?: boolean;
  lastRunAt?: string;
  lastRunSessionId?: string;
  lastRunStatus?: "running" | "ok" | "error";
  lastRunError?: string;
  lastTrigger?: "cron" | "webhook" | "manual" | "event";
  nextRunAt: string | null;
  isRunning?: boolean;
  runs?: AutomationRun[];
}

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
  { label: "No schedule — webhook / manual only", cron: "" },
  { label: "Custom cron…", cron: CUSTOM },
];

const EVENT_OPTIONS: Array<{ key: string; label: string }> = [
  { key: "plain:thread_created", label: "Plain — new support ticket created" },
  { key: "stripe:charge.dispute.created", label: "Stripe — dispute (chargeback) created" },
  { key: "github:pr_merged", label: "GitHub — PR merged" },
];

/** Claude and Codex accounts for provider-aware automation pins. */
function useProviderAccounts(): ProviderAccountOption[] {
  const [accounts, setAccounts] = useState<ProviderAccountOption[]>([]);
  useEffect(() => {
    fetchProviderAccounts()
      .then(setAccounts)
      .catch(() => {});
  }, []);
  return accounts;
}

export function Automations({ onOpenSession, selectedId, onSelect }: Props) {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [loading, setLoading] = useState(true);
  const providerAccounts = useProviderAccounts();

  useEffect(() => {
    fetchModels()
      .then((m) => setDefaultModel(m.default))
      .catch(() => {});
  }, []);
  // The modal is create-only; editing happens inline in the detail drawer.
  const [showModal, setShowModal] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Leaving/changing the selection always drops back to the read view.
  useEffect(() => setEditMode(false), [selectedId]);

  const load = useCallback(async () => {
    try {
      setAutomations(await fetchAutomations());
      setLoading(false);
    } catch {}
  }, []);

  useEffect(() => {
    document.title = docTitle("Automations");
    load();
    const id = setInterval(load, 10000);
    return () => {
      clearInterval(id);
      document.title = DEFAULT_DOC_TITLE;
    };
  }, [load]);

  // The routed selection — matched by id, or by name for sidebar deep-links.
  const sel = useMemo(
    () =>
      selectedId
        ? automations.find((a) => a.id === selectedId || a.name === selectedId) ||
          null
        : null,
    [automations, selectedId],
  );

  // Escape backs out one layer: inline edit → read view → closed. (The create
  // modal handles its own Escape — don't close both from one keypress.)
  useEffect(() => {
    if (!sel || showModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (editMode) setEditMode(false);
      else onSelect("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [!!sel, showModal, editMode, onSelect]);

  async function handleToggle(a: Automation) {
    try {
      await updateAutomationApi(a.id, { enabled: !a.enabled });
      load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleDelete(a: Automation) {
    if (!confirm(`Delete automation "${a.name}"?`)) return;
    try {
      await deleteAutomationApi(a.id);
      if (sel?.id === a.id) onSelect("");
      load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleRunNow(a: Automation) {
    try {
      await runAutomationApi(a.id);
      setTimeout(load, 800);
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleRetrigger(sessionId: string) {
    try {
      await retriggerAutomationApi(sessionId);
      setTimeout(load, 800);
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
    <div className={cn("min-w-0 flex-1 overflow-y-auto px-6 pb-[60px] pt-7 max-[560px]:px-4 max-[560px]:pb-12 max-[560px]:pt-5", sel && "basis-[340px] grow-0 border-r border-line px-3.5 pb-10 pt-4 max-[900px]:hidden")}>
    <div className={cn("mx-auto max-w-[860px]", sel && "max-w-none")}>
      <PageHeader
        className={`max-[560px]:mb-5 max-[560px]:flex-col max-[560px]:items-start max-[560px]:gap-3.5 ${sel ? "mb-3.5 items-center" : ""}`}
      >
        <div>
          <PageTitle className={sel ? "text-body" : undefined}>Automations</PageTitle>
          <PageDescription className={sel ? "hidden" : undefined}>
            Scheduled {AGENT_NAME} sessions — cron runs in UTC (server time).
          </PageDescription>
        </div>
        <Button
					variant="primary"
					size="lg"
					className="px-[18px] text-control-label font-medium"
					onClick={() => setShowModal(true)}
				>
					+ New automation
				</Button>
      </PageHeader>

      {error && (
        <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
      )}

      {loading ? (
        <div className="loading">Loading…</div>
      ) : automations.length === 0 && !showModal ? (
        <div className="px-4 py-12 text-center text-dim">
          <p>No automations yet.</p>
          <p className="text-control-label text-faint">
            Schedule recurring work: daily PR-review sweeps, dependency checks, weekly
            changelog drafts, flaky-test hunts…
          </p>
        </div>
      ) : (
        <div className="flex flex-col border-t border-line">
          {automations.map((a) => {
            const running = a.isRunning || a.lastRunStatus === "running";
            return (
              <button
                key={a.id}
                className={cn("flex w-full min-w-0 items-center gap-3 border-0 border-b border-line bg-transparent px-2.5 py-2.5 text-left text-fg hover:bg-hover max-[560px]:gap-2.5 max-[560px]:px-1 max-[560px]:py-3", sel?.id === a.id && "bg-active", !a.enabled && "[&_.automation-row-main]:opacity-55")}
                onClick={() => onSelect(a.id)}
              >
                {/* Inner controls are spans — the row itself is a button. */}
                <span
                  role="button"
                  className={cn("relative h-[19px] w-[34px] shrink-0 rounded-full border border-line-strong bg-active p-0 transition-colors", a.enabled && "border-green bg-green-soft [&>span]:translate-x-[15px] [&>span]:bg-green")}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggle(a);
                  }}
                  title={a.enabled ? "Disable" : "Enable"}
                >
                  <span className="absolute left-0.5 top-0.5 size-[13px] rounded-full bg-faint transition-[transform,background-color]" />
                </span>
                <span className="automation-row-main flex min-w-0 flex-1 flex-col gap-px">
                  <span className="truncate text-body font-semibold">{a.name}</span>
                  <span className="truncate font-mono text-meta text-faint">{triggerSummary(a)}</span>
                </span>
                {running ? (
                  <span className="working-pill">
                    <span className="working-dot" /> Running
                  </span>
                ) : a.lastRunStatus === "ok" ? (
                  <span
                    className="text-green"
                    title={`Last run ok${a.lastRunAt ? ` — ${relativeTime(a.lastRunAt)}` : ""}`}
                  >
                    ✓
                  </span>
                ) : a.lastRunStatus === "error" ? (
                  <span className="text-red" title={a.lastRunError || "Last run failed"}>
                    ✗
                  </span>
                ) : null}
                <span className="flex shrink-0 max-[560px]:hidden">
                  {(a.runs?.length ?? 0) > 0 && <TriggerGraph runs={a.runs!} compact />}
                </span>
                <span className="w-[84px] shrink-0 text-right text-label text-faint max-[560px]:hidden">
                  {!a.enabled ? "off" : a.nextRunAt ? `next ${formatNext(a.nextRunAt)}` : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
    </div>

      {sel && (
        <aside className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-line bg-panel max-[900px]:border-l-0">
          <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-4 py-3">
            <button
              className="-my-1 -ml-0.5 hidden shrink-0 items-center gap-1.5 border-0 bg-transparent px-1.5 py-1 text-body font-medium text-fg max-[900px]:inline-flex"
              onClick={() => onSelect("")}
              title="Back to automations"
            >
              <svg width="19" height="19" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.749.749 0 1 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z" />
              </svg>
              Automations
            </button>
            <span className="min-w-0 truncate text-control-label font-semibold">
              {editMode ? `Edit — ${sel.name}` : sel.name}
            </span>
            {!editMode && (
              <div className="ml-auto flex shrink-0 gap-1.5">
                <Button
                  size="sm"
                  className="border-line-strong bg-transparent shadow-none hover:bg-transparent"
                  onClick={() => handleRunNow(sel)}
                  disabled={sel.isRunning}
                >
                  Run now
                </Button>
                <Button size="sm" className="border-line-strong bg-transparent shadow-none hover:bg-transparent" onClick={() => setEditMode(true)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  className="border-line-strong bg-transparent text-dim shadow-none hover:border-red hover:bg-transparent hover:text-red"
                  onClick={() => handleDelete(sel)}
                >
                  Delete
                </Button>
              </div>
            )}
            <button
              className="flex size-7 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-dim hover:bg-hover hover:text-fg max-[900px]:hidden"
              onClick={() => onSelect("")}
              title="Close"
            >
              <svg width="19" height="19" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.749.749 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.749.749 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
              </svg>
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 pb-10 pt-[18px]">
            {editMode ? (
              <div>
                <AutomationForm
                  key={sel.id}
                  kind={sel.slackWatch?.channel ? "watch" : "classic"}
                  inline
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
                  <button
                    className={cn("relative h-[19px] w-[34px] shrink-0 rounded-full border border-line-strong bg-active p-0 transition-colors", sel.enabled && "border-green bg-green-soft [&>span]:translate-x-[15px] [&>span]:bg-green")}
                    onClick={() => handleToggle(sel)}
                    title={sel.enabled ? "Disable" : "Enable"}
                  >
                    <span className="absolute left-0.5 top-0.5 size-[13px] rounded-full bg-faint transition-[transform,background-color]" />
                  </button>
                  <span className="text-dim text-control-label">
                    {sel.enabled ? "Enabled" : "Disabled"}
                  </span>
                  {(sel.isRunning || sel.lastRunStatus === "running") && (
                    <span className="working-pill">
                      <span className="working-dot" /> Running
                    </span>
                  )}
                  {sel.enabled && sel.nextRunAt && (
                    <span className="text-faint text-label ml-auto shrink-0">
                      next run {formatNext(sel.nextRunAt)}
                    </span>
                  )}
                </div>

                <div>
                  <div className="mb-1.5 text-label font-semibold text-faint">Instructions</div>
                  <div className="whitespace-pre-wrap rounded-panel border border-line bg-surface px-3.5 py-3 text-control-label leading-relaxed text-dim">
                    {sel.prompt}
                  </div>
                </div>

                <div>
                  <div className="mb-1.5 text-label font-semibold text-faint">Configuration</div>
                  <div className="grid grid-cols-[max-content_1fr] items-baseline gap-x-5 gap-y-2 text-control-label">
                    <DetailKey>Trigger</DetailKey>
                    <span className="text-dim min-w-0">
                      {sel.slackWatch?.channel ? (
                        <>
                          watches{" "}
                            <span className="rounded-sm bg-active px-1.5 py-px font-mono text-meta">
                            #{sel.slackWatch.channel}
                          </span>{" "}
                          — one run per top-level message
                        </>
                      ) : (
                        <>
                          {sel.schedule && (
                            <>
                              {scheduleLabel(sel.schedule) &&
                                `${scheduleLabel(sel.schedule)} · `}
                              <span className="rounded-sm bg-active px-1.5 py-px font-mono text-meta" title="Cron, UTC">
                                {sel.schedule}
                              </span>
                            </>
                          )}
                          {sel.schedule && sel.eventKey && " · "}
                          {sel.eventKey && <>on {eventLabel(sel.eventKey)}</>}
                          {!sel.schedule && !sel.eventKey && "webhook / manual only"}
                        </>
                      )}
                    </span>

                    <DetailKey>Mode</DetailKey>
                    <span className="text-dim">
                      {sel.mode === "ask"
                        ? "Ask — read-only on the main checkout"
                        : "Code — isolated worktree, can open PRs"}
                    </span>

                    <DetailKey>Model</DetailKey>
                    <span className="text-dim">
                      {sel.model || `${defaultModel || "default"} (default)`}
                      {sel.fallbackModel && sel.fallbackModel !== "none" && (
                        <span
                          className="text-faint"
                          title="Fallback — used only when every account for the primary model has hit its usage limit"
                        >
                          {" "}· falls back to {sel.fallbackModel}
                        </span>
                      )}
                    </span>

                    {sel.accountId && (
                      <>
                        <DetailKey>Account</DetailKey>
                        <span className="text-dim">
                          {providerAccounts.find((x) => x.id === sel.accountId)?.name ||
                            "pinned account"}
                          <span className="text-faint">
                            {sel.accountStrict === false
                              ? " — preferred, falls back to the shared pool"
                              : " — hard pin (cost cap)"}
                            {sel.usageCredits ? " · paid usage-credits allowed" : ""}
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

                    {sel.webhookSecret && (
                      <>
                        <DetailKey>Webhook</DetailKey>
                        <WebhookUrl id={sel.id} secret={sel.webhookSecret} />
                      </>
                    )}

                    <DetailKey>Created</DetailKey>
                    <span className="text-dim">
                      by {sel.createdBy}
                      {sel.createdAt &&
                        ` · ${new Date(sel.createdAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}`}
                    </span>
                  </div>
                </div>

                <div>
                  <div className="mb-1.5 text-label font-semibold text-faint">Activity</div>
                  {sel.lastRunAt ? (
                    <div className="text-dim text-supporting">
                      last run {relativeTime(sel.lastRunAt)}
                      {sel.lastTrigger ? ` via ${sel.lastTrigger}` : ""}
                      {sel.lastRunStatus === "ok" && <span className="text-green"> ✓</span>}
                      {sel.lastRunStatus === "error" && (
                        <span className="text-red" title={sel.lastRunError}> ✗</span>
                      )}
                      {sel.lastRunSessionId && (
                        <>
                          {" · "}
                          <a
                            className="text-accent hover:underline"
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
                    <div className="text-faint text-supporting">No runs yet.</div>
                  )}
                  {(sel.runs?.length ?? 0) > 0 && (
                    <>
                      <TriggerGraph runs={sel.runs!} />
                      <RunLedger runs={sel.runs!} onOpenSession={onOpenSession} onRetrigger={handleRetrigger} />
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

/** One-line trigger summary for the list rows. */
function triggerSummary(a: Automation): string {
  if (a.slackWatch) return `watching #${a.slackWatch.channel}`;
  const parts: string[] = [];
  if (a.schedule) parts.push(a.schedule);
  if (a.eventKey) parts.push(`on ${a.eventKey}`);
  if (!parts.length) parts.push("webhook / manual");
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
    <span className="text-faint text-label leading-[1.7] whitespace-nowrap">{children}</span>
  );
}

// ── Trigger history graph ────────────────────────────────────

const GRAPH_DAYS = 30;
const SLOT = 9; // 7px bar + 2px gap
const PLOT_H = 26;

/** Runs-per-day bar strip for the last 30 days. Status is state, so it uses
 *  the reserved status tokens (green/yellow/red); per-bar tooltips carry the
 *  counts in text and the expanded run ledger is the table view. */
function TriggerGraph({ runs, compact }: { runs: AutomationRun[]; compact?: boolean }) {
  const buckets = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const out = Array.from({ length: GRAPH_DAYS }, (_, i) => {
      const date = new Date(today.getTime() - (GRAPH_DAYS - 1 - i) * 86_400_000);
      return { date, ok: 0, error: 0, running: 0 };
    });
    for (const r of runs) {
      const d = new Date(r.at);
      d.setHours(0, 0, 0, 0);
      const idx = Math.round((d.getTime() - out[0].date.getTime()) / 86_400_000);
      if (idx >= 0 && idx < out.length) out[idx][r.status]++;
    }
    return out;
  }, [runs]);

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
        <rect x={0} y={PLOT_H} width={GRAPH_DAYS * SLOT - 2} height={1} fill="var(--border)" />
        {buckets.map((b, i) => {
          const count = b.ok + b.error + b.running;
          const label = b.date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
          if (count === 0) {
            return (
              <rect key={i} x={i * SLOT} y={PLOT_H - 2} width={SLOT - 2} height={2} rx={1} fill="var(--border)">
                <title>{`${label} — no runs`}</title>
              </rect>
            );
          }
          const h = Math.max(4, Math.round((count / max) * PLOT_H));
          const fill = b.error > 0 ? "var(--red)" : b.running > 0 ? "var(--yellow)" : "var(--green)";
          const parts = [
            b.ok ? `${b.ok} ok` : "",
            b.error ? `${b.error} failed` : "",
            b.running ? `${b.running} running` : "",
          ].filter(Boolean);
          return (
            <rect key={i} x={i * SLOT} y={PLOT_H - h} width={SLOT - 2} height={h} rx={1.5} fill={fill}>
              <title>{`${label} — ${count} run${count === 1 ? "" : "s"} (${parts.join(", ")})`}</title>
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

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
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
        <div key={r.sessionId + r.at} className="flex items-baseline gap-2 text-label text-dim min-w-0">
          {r.status === "running" ? (
            <span className="text-yellow shrink-0">●</span>
          ) : r.status === "ok" ? (
            <span className="text-green shrink-0">✓</span>
          ) : (
            <span className="text-red shrink-0" title={r.error}>✗</span>
          )}
          <span className="shrink-0" title={new Date(r.at).toLocaleString()}>
            {relativeTime(r.at)}
          </span>
          <span className="text-faint shrink-0">via {r.trigger}</span>
          {r.durationMs != null && (
            <span className="text-faint shrink-0">{formatDuration(r.durationMs)}</span>
          )}
          {r.error && (
            <span className="text-red truncate" title={r.error}>
              {r.error}
            </span>
          )}
          <a
            className="ml-auto shrink-0 text-accent hover:underline"
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
              className="shrink-0 border-0 bg-transparent p-0 font-[inherit] text-label text-accent hover:underline"
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
  const url = `${PUBLIC_BASE_URL}/automations/${id}/${secret}`;

  return (
    <span className="flex items-center gap-2 min-w-0">
      <span className="min-w-0 flex-1 truncate font-mono text-meta text-dim" title={url}>
        POST {url.replace(secret, secret.slice(0, 6) + "…")}
      </span>
      <Button
        size="sm"
        className="shrink-0 border-line-strong bg-transparent shadow-none hover:bg-transparent"
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

/** Create-only — editing renders AutomationForm inline in the detail drawer. */
function CreateAutomationModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [step, setStep] = useState<Step>("type");
  const [prefill, setPrefill] = useState<AutomationDraft | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[300] bg-black/45 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-[680px] my-auto rounded-panel border border-line-strong bg-panel p-[18px] shadow-2xl">
        {step === "type" ? (
          <TypeChooser
            onPick={(draft, s) => {
              setPrefill(draft);
              setStep(s);
            }}
            onClose={onClose}
          />
        ) : (
          <AutomationForm
            kind={step}
            initial={null}
            prefill={prefill}
            onBack={() => setStep("type")}
            onClose={onClose}
            onSaved={onSaved}
          />
        )}
      </div>
    </div>
  );
}

/** Step 1: choose the automation type (plus templates and the AI drafter). */
function TypeChooser({
  onPick,
  onClose,
}: {
  onPick: (prefill: AutomationDraft | null, step: Exclude<Step, "type">) => void;
  onClose: () => void;
}) {
  const [templates, setTemplates] = useState<AutomationTemplate[]>([]);
  const [description, setDescription] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAutomationTemplates().then(setTemplates).catch(() => {});
  }, []);

  async function handleDraft() {
    if (description.trim().length < 10 || drafting) return;
    setDrafting(true);
    setError(null);
    try {
      onPick(await draftAutomationApi(description), "classic");
    } catch (e: any) {
      setError(e.message);
      setDrafting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3.5 [&_label]:flex [&_label]:flex-1 [&_label]:flex-col [&_label]:gap-1.5 [&_label]:text-supporting [&_label]:font-medium [&_label]:text-dim [&_input]:rounded-md [&_input]:border [&_input]:border-line-strong [&_input]:bg-raised [&_input]:px-3 [&_input]:py-2 [&_input]:text-control-label [&_input]:text-fg [&_input]:outline-none [&_input:focus]:border-accent [&_select]:rounded-md [&_select]:border [&_select]:border-line-strong [&_select]:bg-raised [&_select]:px-3 [&_select]:py-2 [&_select]:text-control-label [&_select]:text-fg [&_select]:outline-none [&_select:focus]:border-accent [&_textarea]:resize-y [&_textarea]:rounded-md [&_textarea]:border [&_textarea]:border-line-strong [&_textarea]:bg-raised [&_textarea]:px-3 [&_textarea]:py-2 [&_textarea]:text-control-label [&_textarea]:leading-relaxed [&_textarea]:text-fg [&_textarea]:outline-none [&_textarea:focus]:border-accent">
      <div>
        <div className="text-body font-semibold">Create automation</div>
        <div className="mt-0.5 text-control-label text-dim">
          Choose the type of automation you want to create.
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <button
          className="text-left bg-surface border border-line rounded-panel px-4 py-3.5 cursor-pointer hover:border-line-strong hover:bg-hover transition-colors"
          onClick={() => onPick(null, "classic")}
        >
          <div className="text-fg text-body font-medium mb-1">Classical automation</div>
          <div className="text-dim text-supporting leading-snug">
            Trigger {AGENT_NAME} sessions based on schedules, internal events, and webhooks.
          </div>
        </button>
        <button
          className="text-left bg-surface border border-line rounded-panel px-4 py-3.5 cursor-pointer hover:border-line-strong hover:bg-hover transition-colors"
          onClick={() => onPick(null, "watch")}
        >
          <div className="text-fg text-body font-medium mb-1">Watch a channel</div>
          <div className="text-dim text-supporting leading-snug">
            {AGENT_NAME} triages every incoming message in a Slack channel, using the
            channel's memory as standing context.
          </div>
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="text-dim text-label">Or describe it and {AGENT_NAME} drafts the automation:</div>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleDraft();
          }}
          rows={2}
          placeholder="“every weekday morning, check Sentry for new errors and rank them by impact”"
        />
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            className="px-4 py-1.5"
            onClick={handleDraft}
            disabled={drafting || description.trim().length < 10}
          >
            {drafting ? "Drafting…" : "Draft it"}
          </Button>
          {error && <span className="text-red text-label">{error}</span>}
        </div>
      </div>

      {templates.length > 0 && (
        <div>
          <div className="text-dim text-label mb-1.5">Or start from a template. Everything stays editable:</div>
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
            {templates.map((t) => (
              <button
                key={t.id}
                className="text-left bg-surface border border-line rounded-panel px-3 py-2.5 cursor-pointer hover:border-line-strong hover:bg-hover transition-colors"
                onClick={() => onPick(t, "classic")}
              >
                <div className="flex items-baseline gap-2 mb-1">
					<span className="text-control-label font-medium text-fg">{t.name}</span>
					<span className="ml-auto shrink-0 text-meta tracking-[-0.01em] text-faint">
                    {CATEGORY_LABELS[t.category] || t.category}
                  </span>
                </div>
                <div className="text-dim text-label leading-snug">{t.description}</div>
              </button>
            ))}
          </div>
        </div>
      )}

        <div className="flex justify-end gap-2.5">
        <Button size="sm" className="px-3 text-control-label" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
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
  const [servers, setServers] = useState<Array<{ name: string; status: string }>>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetchConnections()
      .then((c) =>
        setServers(
          (c.mcpServers || []).map((s: any) => ({ name: s.name, status: s.status })),
        ),
      )
      .catch(() => {});
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
        <span className="text-fg text-control-label font-medium">MCPs</span>
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
      <div className="bg-surface border border-line rounded-panel overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search MCPs…"
            className="flex-1 bg-transparent border-0 outline-none text-control-label text-fg placeholder:text-faint"
            style={{ border: "none", padding: 0, background: "transparent" }}
          />
          <span className="text-faint text-[11px] shrink-0">
            {all ? "all connectors" : `${selected.length} selected`}
          </span>
        </div>
        <label
          className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-hover border-b border-line"
          style={{ flexDirection: "row", fontSize: 13 }}
        >
          <input
            type="checkbox"
            checked={all}
            onChange={() => onChange(all ? [] : undefined)}
            style={{ width: "auto" }}
          />
          <span className="text-fg">All connectors</span>
          <span className="text-faint text-[11px]">
            every configured server (pre-least-privilege default)
          </span>
        </label>
        <div className="max-h-[180px] overflow-y-auto">
          {shown.map((s) => (
            <label
              key={s.name}
              className="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer hover:bg-hover"
              style={{ flexDirection: "row", fontSize: 13 }}
            >
              <input
                type="checkbox"
                checked={all || selected.includes(s.name)}
                onChange={() => toggle(s.name)}
                style={{ width: "auto" }}
              />
              <span className="text-fg">{s.name}</span>
              {s.status !== "connected" && s.status !== "ready" && (
                <span className="text-yellow text-[11px]">{s.status}</span>
              )}
            </label>
          ))}
          {shown.length === 0 && (
            <div className="px-3 py-2 text-faint text-label">No connectors match.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Classic / watch form (step 2) ────────────────────────────

function AutomationForm({
  kind,
  initial,
  prefill,
  onBack,
  onClose,
  onSaved,
  inline,
}: {
  kind: "classic" | "watch";
  initial: Automation | null;
  prefill?: AutomationDraft | null;
  onBack: (() => void) | null;
  onClose: () => void;
  onSaved: () => void;
  /** Hosted in the detail drawer (whose head already names the automation)
   *  rather than the create modal — drop the form's own title row. */
  inline?: boolean;
}) {
  const startSchedule = initial ? initial.schedule : (prefill?.schedule ?? PRESETS[2].cron);
  const matchesPreset = PRESETS.some((p) => p.cron === startSchedule && p.cron !== CUSTOM);
  const initialPreset = matchesPreset ? startSchedule : CUSTOM;

  const [name, setName] = useState(initial?.name || prefill?.name || "");
  const [prompt, setPrompt] = useState(initial?.prompt || prefill?.prompt || "");
  const [preset, setPreset] = useState(initialPreset);
  const [customCron, setCustomCron] = useState(!matchesPreset ? startSchedule : "");
  const [mode, setMode] = useState<"ask" | "code">(initial?.mode || prefill?.mode || "ask");
  const [eventKey, setEventKey] = useState(initial?.eventKey || prefill?.eventKey || "");
  const [watchChannel, setWatchChannel] = useState(initial?.slackWatch?.channel || "");
  const [mcpServers, setMcpServers] = useState<string[] | undefined>(
    initial ? initial.mcpServers : (prefill?.mcpServers ?? (kind === "watch" ? ["slack"] : undefined)),
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [model, setModel] = useState(initial?.model || "");
  const [fallbackModel, setFallbackModel] = useState(initial?.fallbackModel || "");
  const [accountId, setAccountId] = useState(initial?.accountId || "");
  const [accountStrict, setAccountStrict] = useState(initial?.accountStrict !== false);
  const [usageCredits, setUsageCredits] = useState(!!initial?.usageCredits);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const providerAccounts = useProviderAccounts();

  useEffect(() => {
    fetchModels()
      .then((m) => {
        setModels(m.models);
        setDefaultModel(m.default);
      })
      .catch(() => {});
  }, []);
  const effectiveModel = model || defaultModel;
  const accountProvider = models.find((item) => item.id === effectiveModel)?.accountProvider;
  const eligibleAccounts = providerAccounts.filter((account) => account.provider === accountProvider);
  useEffect(() => {
    const account = providerAccounts.find((item) => item.id === accountId);
    if (account && account.provider !== accountProvider) setAccountId("");
  }, [accountId, accountProvider, providerAccounts]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isWatch = kind === "watch";
  const schedule = isWatch ? "" : preset === CUSTOM ? customCron.trim() : preset;
  const scheduleValid = isWatch || preset !== CUSTOM || customCron.trim().length > 0;
  const watchValid = !isWatch || /^[CG][A-Z0-9]{6,}$/i.test(watchChannel.trim());

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
          mcpServers: mcpServers ?? null,
          slackWatch,
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
          mcpServers,
          slackWatch,
          createdBy: getCurrentUser(),
        });
      }
      onSaved();
    } catch (e: any) {
      setError(e.message);
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3.5 [&_label]:flex [&_label]:flex-1 [&_label]:flex-col [&_label]:gap-1.5 [&_label]:text-supporting [&_label]:font-medium [&_label]:text-dim [&_input]:rounded-md [&_input]:border [&_input]:border-line-strong [&_input]:bg-raised [&_input]:px-3 [&_input]:py-2 [&_input]:text-control-label [&_input]:text-fg [&_input]:outline-none [&_input:focus]:border-accent [&_select]:rounded-md [&_select]:border [&_select]:border-line-strong [&_select]:bg-raised [&_select]:px-3 [&_select]:py-2 [&_select]:text-control-label [&_select]:text-fg [&_select]:outline-none [&_select:focus]:border-accent [&_textarea]:resize-y [&_textarea]:rounded-md [&_textarea]:border [&_textarea]:border-line-strong [&_textarea]:bg-raised [&_textarea]:px-3 [&_textarea]:py-2 [&_textarea]:text-control-label [&_textarea]:leading-relaxed [&_textarea]:text-fg [&_textarea]:outline-none [&_textarea:focus]:border-accent">
      {!inline && (
        <div className="flex items-center gap-2">
          {onBack && (
            <Button size="sm" className="border-line-strong bg-transparent shadow-none hover:bg-transparent" onClick={onBack} title="Back to type chooser">
              ←
            </Button>
          )}
          <div className="text-body font-semibold">
            {initial
              ? `Edit "${initial.name}"`
              : isWatch
                ? "Watch a channel"
                : "New automation"}
          </div>
        </div>
      )}

      <label>
        Automation name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isWatch ? "Support channel triage" : "Daily PR review sweep"}
        />
      </label>

      {isWatch ? (
        <label>
          Slack channel — what channel should {AGENT_NAME} watch?
          <input
            value={watchChannel}
            onChange={(e) => setWatchChannel(e.target.value)}
            placeholder="C0123456789 (channel id)"
            className="mono-input"
          />
			<span className="mt-1 text-meta leading-snug text-faint">
            Invite @michael to the channel first — the bot only receives messages
            for channels it's a member of. One run per top-level message; thread
            replies don't re-trigger. Channel id is in the channel's “About” tab.
          </span>
        </label>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div>
            <span className="text-fg text-control-label font-medium">Triggers</span>
            <span className="text-dim text-label ml-2">
              Run the automation when any of these conditions are met
            </span>
          </div>
          <div className="bg-surface border border-line rounded-panel px-3 py-2.5 flex flex-col gap-2.5">
            <label style={{ marginBottom: 0 }}>
              Schedule
              <select value={preset} onChange={(e) => setPreset(e.target.value)}>
                {PRESETS.map((p) => (
                  <option key={p.label} value={p.cron}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            {preset === CUSTOM && (
              <label style={{ marginBottom: 0 }}>
                Cron expression (UTC)
                <input
                  value={customCron}
                  onChange={(e) => setCustomCron(e.target.value)}
                  placeholder="0 16 * * 1-5"
                  className="mono-input"
                />
              </label>
            )}
            <label style={{ marginBottom: 0 }}>
              Internal event
              <select value={eventKey} onChange={(e) => setEventKey(e.target.value)}>
                <option value="">None</option>
                {EVENT_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
			<div className="text-meta text-faint">
              Every automation also gets a secret webhook URL you can POST to —
              shown on its card after creation.
            </div>
          </div>
        </div>
      )}

      <label>
        Instructions — what {AGENT_NAME} does {isWatch ? "with each message" : "when triggers activate"}
        <textarea
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

      <div>
        <Button
          size="sm"
          className="border-line-strong bg-transparent shadow-none hover:bg-transparent"
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced ? "Hide advanced" : "Advanced"}
        </Button>
      </div>

      {showAdvanced && (
        <div className="flex gap-3.5">
          <label>
            Mode
            <select value={mode} onChange={(e) => setMode(e.target.value as "ask" | "code")}>
              <option value="ask">Ask — read-only on main</option>
              <option value="code">Code — fresh worktree per run</option>
            </select>
          </label>

          <label>
            Model
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Default{defaultModel ? ` — ${defaultModel}` : ""}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} ({m.provider === "codex" ? "OpenAI Codex" : "Claude"})
                </option>
              ))}
            </select>
          </label>

          <label>
            Fallback (when all accounts hit usage limits)
            <select value={fallbackModel} onChange={(e) => setFallbackModel(e.target.value)}>
              <option value="">None — fail instead of falling back</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} ({m.provider === "codex" ? "OpenAI Codex" : "Claude"})
                </option>
              ))}
            </select>
          </label>

          <label title="Pin runs to one account from the selected model's provider pool.">
            Provider account
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Auto — shared pool rotation</option>
              {eligibleAccounts.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                  {x.owner ? ` — ${x.owner}'s` : ""}
                </option>
              ))}
            </select>
          </label>

          {accountId && (
            <label title="This account only: when it's out of usage, runs switch to the fallback model — never the shared pool — so this account's limits are the automation's cost ceiling. Prefer it: exhausted runs rotate into the shared pool instead.">
              When the pinned account is out of usage
              <select
                value={accountStrict ? "strict" : "pool"}
                onChange={(e) => setAccountStrict(e.target.value === "strict")}
              >
                <option value="strict">This account only — fall back by model (cost cap)</option>
                <option value="pool">Prefer it — fall back to the shared pool</option>
              </select>
            </label>
          )}

          <label title="Usage-credits are pay-as-you-go spend past the subscription's included limits. Only takes effect on accounts with extra usage enabled at claude.ai — and their monthly credit cap still bounds the spend.">
            Usage credits
            <select
              value={usageCredits ? "allow" : "never"}
              onChange={(e) => setUsageCredits(e.target.value === "allow")}
            >
              <option value="never">Never — stop / fall back at the limit</option>
              <option value="allow">Allowed — keep going on paid credits</option>
            </select>
          </label>
        </div>
      )}

      {error && <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>}

      <div className="flex justify-end gap-2.5">
        <Button size="sm" className="px-3 text-control-label" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="md"
          className="px-[22px] py-2"
          onClick={handleSave}
          disabled={saving || !name.trim() || !prompt.trim() || !scheduleValid || !watchValid}
        >
          {saving ? "Saving…" : initial ? "Save changes" : "Create automation"}
        </Button>
      </div>
    </div>
  );
}
