import React, { useEffect, useState } from "react";
import { z } from "zod";
import { BASE_PATH } from "../lib/base";
import type {
  WorkflowAgentSnapshot,
  WorkflowRunSnapshot,
  WorkflowSessionSnapshot,
} from "../../server/workflow-types";
import type { SessionSubagentSnapshot } from "../lib/api";
import { cn } from "../ui/cn";
import { Button } from "../ui/button";
import { CardList } from "../ui/card";
import { EmptyState } from "../ui/state";
import { IconStack } from "./icons";
import { PanelPageHeader } from "./PanelPageHeader";
import { formatDuration } from "../lib/time";
import {
  INFO_LABEL_CLASS,
  INFO_SECTION_CLASS,
} from "../lib/session-viewer-classes";
import { friendlyModelSlug, routedModelParts } from "./ModelEffortSelect";
import { WorkflowAgentTranscript } from "./WorkflowAgentTranscript";
import { Badge } from "../ui/badge";
import { workflowPhaseStats } from "../../shared/workflow-observability";

const workflowAgentDetailSchema = z.object({
  prompt: z.string(),
  outcome: z.object({
    error: z.string().optional(),
    structured: z.unknown().optional(),
    text: z.string().optional(),
  }),
});
const workflowAgentDetailEnvelopeSchema = z.object({
  entry: workflowAgentDetailSchema.optional(),
});
type WorkflowAgentDetail = z.infer<typeof workflowAgentDetailSchema>;

/**
 * Agents tab: live view of a session's dynamic workflow runs (the
 * opensession-workflows MCP). Renders WorkflowRunSnapshot cards — newest run
 * first — with agents grouped by phase, a narrator log feed, and a per-agent
 * drill-in that lazily fetches the full journal entry
 * (/api/workflows/:runId/agents/:seq). Snapshots arrive via the
 * workflow_update WS broadcast; this component is a pure renderer plus the
 * drill-in fetch. Never mounted with zero runs (the tab itself hides).
 *
 * Two levels of drill-in:
 *  - the row expands in place to the full prompt/result (journal entry), and
 *  - "View conversation" swaps the whole panel for WorkflowAgentTranscript —
 *    the agent's real conversation (its tool calls / steps), live while it
 *    runs. The selected agent is re-resolved from `runs` every render so the
 *    WS snapshot keeps its header status/duration honest.
 *
 * Write agents (opts.write — code mode in their own isolated worktree) carry a
 * branch chip + diffstat + merge badge on their row.
 */

interface Props {
  sessionId: string;
  runs: WorkflowRunSnapshot[];
  onAction: (
    runId: string,
    action: "cancel" | "pause" | "resume" | "skip" | "retry",
    seq?: number,
  ) => void;
  /** Sub-agents the session spawned directly (task tool) — rendered as their
   *  own card above the workflow runs. */
  subagents?: SessionSubagentSnapshot[];
  /** Opens a sub-agent's conversation in its own view tab. */
  onOpenSubagent?: (agentId: string, label: string) => void;
  /** Opens a nested workflow session through the app router. */
  onOpenSession?: (sessionId: string) => void;
  /** Set when this renders as a page pushed on top of the workspace panel
   *  (the Agents item in its tab strip). Page mode shows the empty state and
   *  can carry a back header; without it this is a section of the phone info
   *  page, which renders nothing until a run exists. */
  onBack?: () => void;
  /** The desktop panel's standing tab strip already names this page. */
  hideHeader?: boolean;
}

/** A finished run says so with its green marks and its totals, so `done` gets
 *  no badge. The badge is for a run that still wants your attention. */
const RUN_TONE: Record<
  WorkflowRunSnapshot["status"],
  "warning" | "danger" | "neutral" | null
> = {
  running: "warning",
  done: null,
  error: "danger",
  cancelled: "neutral",
  paused: "warning",
  interrupted: "warning",
};

/** The card's plate and the rows inside it: the Info panel's list grammar
 *  (INFO_LIST_CLASS), so an agent row lines up with a portal or a changed
 *  file rather than inventing a third row shape. */
const CARD_CLASS = "overflow-hidden rounded-lg bg-panel p-1";
const ROW_CLASS =
  "flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors";
/** A toggle under the agent rows (tool calls, the result): the same row, in
 *  the quieter ink a reading gets. */
const FOOTER_ROW =
  "flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-meta " +
  "font-medium text-dim transition-colors hover:bg-hover hover:text-fg";

/** Status mark: glyphs for the terminal states (✓/✕ stay legible at a glance
 *  — a red accent dot and an error dot would read the same), pulsing yellow
 *  dot = running (matches the run pill, and the "In progress" lane), dim dot =
 *  pending/cancelled. */
function StatusMark({ status }: { status: WorkflowAgentSnapshot["status"] }) {
  if (status === "done" || status === "error") {
    const ok = status === "done";
    return (
      <svg
        viewBox="0 0 12 12"
        className={cn("size-3 shrink-0", ok ? "text-green" : "text-red")}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {ok ? <path d="M2.5 6.5 5 9l4.5-6" /> : <path d="M3 3l6 6M9 3l-6 6" />}
      </svg>
    );
  }
  return (
    <span className="flex size-3 shrink-0 items-center justify-center">
      <span
        className={cn(
          "size-2 rounded-full",
          status === "running" ? "bg-yellow animate-pulse" : "bg-line-strong",
        )}
      />
    </span>
  );
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  return formatDuration(ms) ?? "0s";
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** "pi/anthropic/claude-sonnet-5" → "Sonnet 5", and
 *  "…/claude-haiku-4-5-20251001" → "Haiku 4.5": the trailing release date is
 *  version noise that doubles the width of every row's model readout. */
function shortModel(id: string): string {
  const oc = routedModelParts(id);
  return friendlyModelSlug((oc ? oc.model : id).replace(/-\d{8}$/, ""));
}

function agentDuration(a: WorkflowAgentSnapshot, now: number): string {
  if (!a.startedAt) return "";
  const end = a.endedAt
    ? new Date(a.endedAt).getTime()
    : a.status === "running"
      ? now
      : undefined;
  if (end === undefined) return "";
  return fmtDuration(end - new Date(a.startedAt).getTime());
}

/** Row chips report an outcome worth a second look: a branch, a merge, a cache
 *  hit. Everything a row always carries (its model, its tokens, its duration)
 *  is plain text in the rail instead, because a chip on every row in every
 *  column made this list read as a table of boxes. */
function Chip({
  children,
  tone,
  title,
}: {
  children: React.ReactNode;
  /** Merge outcome tints; default is the neutral outlined chip. */
  tone?: "green" | "red";
  title?: string;
}) {
  return (
    <Badge
      title={title}
      tone={
        tone === "green" ? "success" : tone === "red" ? "danger" : "neutral"
      }
      variant={tone ? "soft" : "outline"}
      className="max-w-[120px] truncate"
    >
      {children}
    </Badge>
  );
}

/** Write-agent readout: branch, diffstat (or "no changes") and merge outcome.
 *  Its own line under the label rather than more cargo on the row, because a
 *  branch name and a diffstat beside a model and two numbers left nothing of
 *  the filename in a panel this narrow. */
function WriteLine({ a }: { a: WorkflowAgentSnapshot }) {
  const files = a.filesChanged ?? 0;
  return (
    <div className="flex min-w-0 items-center gap-1.5 pl-5 text-meta text-faint">
      {a.branch && (
        <span className="min-w-0 truncate" title={a.branch}>
          ⑂ {a.branch}
        </span>
      )}
      {a.changed ? (
        <span className="shrink-0 tabular-nums">
          <span className="text-green">+{a.insertions ?? 0}</span>{" "}
          <span className="text-red">−{a.deletions ?? 0}</span>
          {files > 0 && (
            <span>
              {" "}
              · {files} file{files === 1 ? "" : "s"}
            </span>
          )}
        </span>
      ) : (
        a.status === "done" && <span className="shrink-0">no changes</span>
      )}
      {a.merged === "merged" && (
        <span className="shrink-0 font-medium text-green">merged</span>
      )}
      {a.merged === "conflict" && (
        <span className="shrink-0 font-medium text-red">conflict</span>
      )}
    </div>
  );
}

/** The readout every agent row ends with: model, tokens, duration. The two
 *  numbers keep fixed columns so a list of rows reads down as well as across,
 *  and they hold their width when a row has nothing to report. */
function AgentRail({
  model,
  tokens,
  duration,
}: {
  model?: string;
  tokens?: number;
  duration: string;
}) {
  return (
    <>
      {model && (
        <span className="min-w-0 max-w-[84px] shrink truncate text-meta text-faint">
          {shortModel(model)}
        </span>
      )}
      <span className="w-[46px] shrink-0 whitespace-nowrap text-right text-meta text-faint tabular-nums">
        {tokens ? `${fmtTokens(tokens)} tok` : ""}
      </span>
      <span className="w-11 shrink-0 whitespace-nowrap text-right text-meta text-faint tabular-nums">
        {duration}
      </span>
    </>
  );
}

function NestedSessionRow({
  session,
  onOpen,
}: {
  session: WorkflowSessionSnapshot;
  onOpen?: (sessionId: string) => void;
}) {
  const markStatus =
    session.status === "error"
      ? "error"
      : session.status === "running" || session.status === "waiting"
        ? "running"
        : session.status === "cancelled"
          ? "cancelled"
          : "done";
  const details = [
    session.branch,
    session.worktreeDir?.split("/").filter(Boolean).at(-1),
  ].filter(Boolean);
  return (
    <a
      href={session.url}
      onClick={(event) => {
        if (
          !onOpen ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        onOpen(session.id);
      }}
      className={cn(
        ROW_CLASS,
        "min-h-11 flex-col items-stretch gap-0.5 no-underline hover:bg-hover desktop:min-h-0",
      )}
      title={`Open ${session.id}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <StatusMark status={markStatus} />
        <span className="min-w-0 flex-1 truncate text-label text-fg">
          {session.label}
        </span>
        <span className="shrink-0 text-meta text-faint">
          {session.status.replace("_", " ")}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pl-5 text-meta text-faint">
        <span className="min-w-0 truncate" title={details.join(" · ")}>
          {details.join(" · ")}
        </span>
        {session.prUrl && (
          <Badge tone="success" variant="soft" className="ml-auto shrink-0">
            PR
          </Badge>
        )}
      </span>
    </a>
  );
}

function DetailPre({ text }: { text: string }) {
  return (
    <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-hover p-2 font-mono text-meta leading-relaxed text-dim">
      {text}
    </pre>
  );
}

export function WorkflowPanel({
  sessionId: _sessionId,
  runs,
  onAction,
  subagents,
  onOpenSubagent,
  onOpenSession,
  onBack,
  hideHeader = false,
}: Props) {
  // Server list + WS prepends both keep newest-first; re-sorting is cheap
  // insurance against an out-of-order upsert.
  const ordered = [...runs].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
  const subs = subagents ?? [];
  const anyRunning =
    ordered.some((r) => r.status === "running") ||
    subs.some((s) => s.status === "running");
  // 1s heartbeat for elapsed/duration readouts, only while something is live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyRunning) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [anyRunning]);

  // The open agent conversation, if any. Held as ids (not the snapshot) so the
  // drilled-in view tracks the live WS snapshot rather than a frozen copy.
  const [openConvo, setOpenConvo] = useState<{
    runId: string;
    seq: number;
  } | null>(null);
  const onOpenAgent = (runId: string, seq: number) =>
    setOpenConvo({ runId, seq });
  const closeConvo = () => setOpenConvo(null);
  const convoAgent = (() => {
    if (!openConvo) return undefined;
    return ordered
      .find((r) => r.runId === openConvo.runId)
      ?.agents.find((a) => a.seq === openConvo.seq);
  })();

  if (openConvo && convoAgent)
    return (
      <WorkflowAgentTranscript
        runId={openConvo.runId}
        agent={convoAgent}
        onBack={closeConvo}
      />
    );

  const empty = ordered.length === 0 && subs.length === 0;
  const cards = (
    <>
      {subs.length > 0 && (
        <SubagentsCard subagents={subs} now={now} onOpen={onOpenSubagent} />
      )}
      {ordered.map((run) => (
        <RunCard
          key={run.runId}
          run={run}
          now={now}
          onAction={onAction}
          onOpenAgent={onOpenAgent}
          onOpenSession={onOpenSession}
        />
      ))}
    </>
  );

  // Page mode: selected in the workspace panel's tab strip, the same level
  // that Portals opens to. It owns the whole column, so
  // it carries the back header and can afford the empty state.
  if (onBack)
    return (
      <>
        {!hideHeader && (
          <PanelPageHeader
            title="Agents"
            onBack={onBack}
            trailing={
              anyRunning && (
                <Badge tone="warning" dot className="mr-1 animate-pulse">
                  running
                </Badge>
              )
            }
          />
        )}
        <div className="grid gap-4 px-2 pt-1 pb-[22px]">
          {empty ? (
            <WorkflowsEmptyState />
          ) : (
            <div className="grid gap-3">{cards}</div>
          )}
        </div>
      </>
    );

  if (empty) return null;
  // Section mode (the phone info page): a faint label over a stack of plates,
  // like Git status or the changed-files list. No padding of its own, because
  // the page owns the inset.
  return (
    <div className={INFO_SECTION_CLASS}>
      <div
        className={cn(
          INFO_LABEL_CLASS,
          "flex items-center justify-between gap-2",
        )}
      >
        <span>Agents</span>
        {anyRunning && (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-yellow">
            <span className="size-1.5 animate-pulse rounded-full bg-current" />
            running
          </span>
        )}
      </div>
      {cards}
    </div>
  );
}

/** Sub-agents the session spawned directly with the task tool (pi child
 *  sessions / Claude-SDK Task agents) — one card in the same visual grammar as
 *  a workflow run: StatusMark rows with agent-type/model chips, tokens and
 *  duration. Clicking a row opens the sub-agent's real conversation in the
 *  sub-agent view tab (the id doubles as the fetchSubagent key). */
function SubagentsCard({
  subagents,
  now,
  onOpen,
}: {
  subagents: SessionSubagentSnapshot[];
  now: number;
  onOpen?: (agentId: string, label: string) => void;
}) {
  const runningN = subagents.filter((s) => s.status === "running").length;
  const errorN = subagents.filter((s) => s.status === "error").length;
  const tokens = subagents.reduce((n, s) => n + (s.tokensOut ?? 0), 0);
  const meta: string[] = [
    `${subagents.length} sub-agent${subagents.length === 1 ? "" : "s"}`,
  ];
  if (runningN) meta.push(`${runningN} running`);
  if (errorN) meta.push(`${errorN} failed`);
  if (tokens) meta.push(`${fmtTokens(tokens)} tok`);
  return (
    <div className={CARD_CLASS}>
      <div className="px-2 pb-2.5 pt-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-label font-semibold text-fg">
            Sub-agents
          </span>
          {runningN > 0 && (
            <Badge tone="warning" dot className="animate-pulse">
              running
            </Badge>
          )}
        </div>
        <div className="mt-0.5 truncate text-meta text-faint tabular-nums">
          {meta.join(" · ")}
        </div>
      </div>
      <div className="flex flex-col">
        {subagents.map((s, i) => {
          const openable = Boolean(s.id && onOpen);
          const durMs =
            s.startedAt !== undefined
              ? (s.endedAt ?? (s.status === "running" ? now : undefined)) !==
                undefined
                ? (s.endedAt ?? now) - s.startedAt
                : undefined
              : undefined;
          return (
            <button
              key={s.id ?? `pending-${i}`}
              className={cn(
                ROW_CLASS,
                "flex-col items-stretch gap-0.5",
                openable ? "hover:bg-hover" : "cursor-default",
              )}
              onClick={() => {
                if (s.id && onOpen) onOpen(s.id, s.label);
              }}
              title={
                openable ? "Open this sub-agent's conversation" : undefined
              }
            >
              <span className="flex min-w-0 items-center gap-2">
                <StatusMark status={s.status} />
                <span className="min-w-0 flex-1 truncate text-label text-fg">
                  {s.label}
                </span>
                <AgentRail
                  tokens={s.tokensOut}
                  duration={durMs !== undefined ? fmtDuration(durMs) : ""}
                />
              </span>
              {/* A sub-agent is asked for in a sentence, so its label wants
							    the whole line. What kind it is and what it runs on go
							    under it, the same second line a write agent gets. */}
              {(s.agentType || s.model) && (
                <span className="truncate pl-5 text-meta text-faint">
                  {[s.agentType, s.model && shortModel(s.model)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The discovery surface: with nothing running, this page is the only place
 *  that says workflows exist and how to start one. Same shape as every other
 *  empty surface, the EmptyState block over one card of rows, and short enough
 *  to read in a panel column. */
function WorkflowsEmptyState() {
  return (
    <div className="grid gap-4">
      <EmptyState
        icon={<IconStack size={22} />}
        title="No agents yet"
        className="px-2 py-7"
      >
        Ask this session to <span className="text-fg">use a workflow</span> and
        it fans out many small agents at once, then combines what they find.
      </EmptyState>
      <div className="grid gap-[5px]">
        <div className={INFO_LABEL_CLASS}>Try</div>
        <CardList as="ul" className="rounded-lg">
          {[
            "Use a workflow to audit every route for missing auth checks.",
            "Use a workflow to compare 3 approaches and pick a winner.",
            "Use a workflow with write agents: one per file, then merge.",
          ].map((s) => (
            <li
              key={s}
              className="px-3 py-2.5 text-label leading-snug text-dim"
            >
              {s}
            </li>
          ))}
        </CardList>
      </div>
      <p className="px-2 text-supporting leading-snug text-faint">
        Agents read this worktree. Write agents each get their own branch, and
        merging back is explicit.
      </p>
    </div>
  );
}

function RunCard({
  run,
  now,
  onAction,
  onOpenAgent,
  onOpenSession,
}: {
  run: WorkflowRunSnapshot;
  now: number;
  onAction: Props["onAction"];
  onOpenAgent: (runId: string, seq: number) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  // Expanded agent rows (by seq) + their lazily-fetched journal entries.
  const [openAgents, setOpenAgents] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const [details, setDetails] = useState<
    Record<number, WorkflowAgentDetail | "loading" | "missing">
  >({});
  const [allLogs, setAllLogs] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [showMcp, setShowMcp] = useState(false);

  // Phase order: meta-seeded titles first, then first-seen agent phases;
  // agents without a phase render as a leading ungrouped block.
  const groups = (() => {
    const order: string[] = [];
    const seen = new Set<string>();
    for (const t of run.phases)
      if (!seen.has(t)) {
        seen.add(t);
        order.push(t);
      }
    for (const a of run.agents)
      if (a.phase && !seen.has(a.phase)) {
        seen.add(a.phase);
        order.push(a.phase);
      }
    for (const title of Object.keys(run.phaseToolTotals || {}))
      if (!seen.has(title)) {
        seen.add(title);
        order.push(title);
      }
    const byPhase = new Map<string, WorkflowAgentSnapshot[]>();
    for (const t of order) byPhase.set(t, []);
    const loose: WorkflowAgentSnapshot[] = [];
    for (const a of run.agents) {
      if (a.phase && byPhase.has(a.phase)) byPhase.get(a.phase)!.push(a);
      else loose.push(a);
    }
    return { order, byPhase, loose };
  })();

  const toggleAgent = (seq: number) => {
    setOpenAgents((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  };

  const loadDetail = async (seq: number) => {
    setDetails((prev) => ({ ...prev, [seq]: "loading" }));
    await (async () => {
      const res = await fetch(
        `${BASE_PATH}/api/workflows/${encodeURIComponent(run.runId)}/agents/${seq}`,
      );
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const bareEntry = workflowAgentDetailSchema.safeParse(data);
      // Tolerate both a bare journal entry and an { entry } envelope.
      const entry = bareEntry.success
        ? bareEntry.data
        : workflowAgentDetailEnvelopeSchema.parse(data).entry;
      if (!entry) throw new Error("bad shape");
      setDetails((prev) => ({ ...prev, [seq]: entry }));
    })().catch(async () => {
      setDetails((prev) => ({ ...prev, [seq]: "missing" }));
    });
  };

  const startMs = new Date(run.startedAt).getTime();
  const currentPauseMs = run.pausedAt
    ? Math.max(0, now - new Date(run.pausedAt).getTime())
    : 0;
  const elapsedMs = Math.max(
    0,
    (run.endedAt
      ? new Date(run.endedAt).getTime()
      : run.status === "running" || run.status === "paused"
        ? now
        : startMs) -
      startMs -
      (run.totalPausedMs || 0) -
      currentPauseMs,
  );
  const phaseStats = new Map(
    workflowPhaseStats(run, now).map((stats) => [stats.title, stats]),
  );
  const hasPhaseActivity = [...phaseStats.values()].some(
    (stats) => stats.agents > 0 || stats.toolCalls > 0,
  );
  const runningN = run.agents.filter((a) => a.status === "running").length;
  const errorN = run.agents.filter((a) => a.status === "error").length;
  const meta: string[] = [
    `${run.totals.agents} agent${run.totals.agents === 1 ? "" : "s"}`,
  ];
  if (runningN) meta.push(`${runningN} running`);
  if (errorN) meta.push(`${errorN} failed`);
  if (run.sessions?.length)
    meta.push(
      `${run.sessions.length} session${run.sessions.length === 1 ? "" : "s"}`,
    );
  // Direct mcp.* calls the script made — cheap work that never became an
  // agent row, so without this the panel understates what the run did.
  if (run.totals.mcpCalls) {
    const failed = run.totals.mcpErrors
      ? `, ${run.totals.mcpErrors} failed`
      : "";
    meta.push(
      `${run.totals.mcpCalls} tool call${run.totals.mcpCalls === 1 ? "" : "s"}${failed}`,
    );
  }
  if (run.totals.tokensOut) meta.push(`${fmtTokens(run.totals.tokensOut)} tok`);
  if (elapsedMs > 0 || run.status === "running" || run.status === "paused")
    meta.push(fmtDuration(elapsedMs));

  const openConversation = (seq: number) => onOpenAgent(run.runId, seq);

  function agentRow(a: WorkflowAgentSnapshot) {
    return (
      <AgentRow
        key={a.seq}
        a={a}
        open={openAgents.has(a.seq)}
        detail={details[a.seq]}
        // Precomputed string so the 1s ticker only re-renders rows whose
        // readout actually changes (running rows) — done rows memo-bail.
        duration={agentDuration(a, now)}
        onToggle={toggleAgent}
        onLoadDetail={loadDetail}
        onOpenConversation={openConversation}
        onAction={(seq, action) => onAction(run.runId, action, seq)}
      />
    );
  }

  const tone = RUN_TONE[run.status];
  const stringResult = z.string().safeParse(run.result);
  return (
    <div className={CARD_CLASS}>
      <div className="flex items-center justify-between gap-2 px-2 pb-2.5 pt-1">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-label font-semibold text-fg">
              {run.name}
            </span>
            {tone && (
              <Badge
                tone={tone}
                dot={run.status === "running"}
                className={cn(run.status === "running" && "animate-pulse")}
              >
                {run.status}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 truncate text-meta text-faint tabular-nums">
            {meta.join(" · ")}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {run.status === "running" && (
            <Button
              variant="soft"
              size="sm"
              className="phone:min-h-11"
              onClick={() => onAction(run.runId, "pause")}
            >
              Pause
            </Button>
          )}
          {(run.status === "paused" || run.status === "interrupted") && (
            <Button
              variant="default"
              size="sm"
              className="phone:min-h-11"
              onClick={() => onAction(run.runId, "resume")}
            >
              Resume
            </Button>
          )}
          {(run.status === "running" || run.status === "paused") && (
            <Button
              variant="default"
              size="sm"
              className="phone:min-h-11"
              onClick={() => onAction(run.runId, "cancel")}
            >
              Stop
            </Button>
          )}
        </div>
      </div>
      {run.warnings?.map((warning) => (
        <div
          key={warning.kind}
          className="px-2 pb-2 text-meta leading-snug text-yellow"
        >
          {warning.message}
        </div>
      ))}
      {!!run.sessions?.length && (
        <div className="flex flex-col">
          <div className="flex items-baseline gap-2 px-2 pb-px pt-0.5">
            <span className="min-w-0 flex-1 truncate text-meta font-medium text-faint">
              Sessions
            </span>
            <span className="shrink-0 text-meta text-faint tabular-nums">
              {run.sessions.length}
            </span>
          </div>
          {run.sessions.map((session) => (
            <NestedSessionRow
              key={session.id}
              session={session}
              onOpen={onOpenSession}
            />
          ))}
        </div>
      )}
      {(hasPhaseActivity ||
        ((run.status === "running" || run.status === "paused") &&
          groups.order.length > 0)) && (
        <div className="flex flex-col">
          {groups.loose.map(agentRow)}
          {groups.order.map((title) => {
            const agents = groups.byPhase.get(title)!;
            const stats = phaseStats.get(title);
            // Empty phases only preview upcoming work on a live run. A phase
            // with direct tool calls is real work even when it has no agents.
            if (
              agents.length === 0 &&
              !stats?.toolCalls &&
              run.status !== "running" &&
              run.status !== "paused"
            )
              return null;
            const phaseMeta = [
              agents.length
                ? `${(stats?.done || 0) + (stats?.error || 0) + (stats?.cancelled || 0)}/${agents.length}`
                : "queued",
              stats && stats.tokensIn + stats.tokensOut
                ? `${fmtTokens(stats.tokensIn + stats.tokensOut)} tok`
                : "",
              stats?.toolCalls ? `${stats.toolCalls} tools` : "",
              stats?.durationMs ? fmtDuration(stats.durationMs) : "",
            ].filter(Boolean);
            return (
              <div key={title}>
                {/* The phase label sits quieter than the agent names under
								    it, and its count holds the rail's right edge, so a
								    group reads as a heading over rows. */}
                <div className="flex items-baseline gap-2 px-2 pb-px pt-2 first:pt-0.5 phone:flex-col phone:items-stretch phone:gap-0">
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-meta font-medium",
                      run.status === "running" && title === run.currentPhase
                        ? "text-dim"
                        : "text-faint",
                    )}
                  >
                    {title}
                  </span>
                  <span className="shrink-0 text-meta text-faint tabular-nums phone:truncate">
                    {phaseMeta.join(" · ")}
                  </span>
                </div>
                {agents.map(agentRow)}
              </div>
            );
          })}
        </div>
      )}
      {/* What the run left behind: its tool calls, its narration, its result.
			    One rule under the agent rows separates the readings from the work,
			    and each toggle is a row in the same shape as an agent above it
			    rather than a band of its own. */}
      {(!!run.mcpCalls?.length ||
        run.logs.length > 0 ||
        (run.status === "error" && run.error) ||
        (run.status === "done" && run.result !== undefined)) && (
        <div className="mx-2 mt-1 border-t border-divider" />
      )}
      {!!run.mcpCalls?.length && (
        <div>
          <button className={FOOTER_ROW} onClick={() => setShowMcp((v) => !v)}>
            {showMcp ? "Hide" : "Show"} tool calls
            <span className="ml-auto shrink-0 tabular-nums text-faint">
              {run.totals.mcpCalls ?? run.mcpCalls.length}
            </span>
          </button>
          {showMcp && (
            <div className="flex flex-col gap-0.5 px-2 pb-1.5 pt-0.5">
              {run.mcpCalls.map((c, i) => (
                <div
                  key={`${c.seq}-${i}`}
                  className="flex items-baseline gap-2 text-meta leading-snug"
                >
                  <span
                    className={cn("shrink-0", c.ok ? "text-faint" : "text-red")}
                  >
                    {c.ok ? "·" : "✗"}
                  </span>
                  <span className="truncate text-dim">
                    {c.server}.{c.tool}
                  </span>
                  <span className="ml-auto shrink-0 text-meta text-faint tabular-nums">
                    {c.cached ? "cached" : `${c.ms}ms`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {run.logs.length > 0 && (
        <div className="px-2 py-1.5">
          <div className="flex flex-col gap-0.5">
            {(allLogs ? run.logs : run.logs.slice(-20)).map((l, i) => (
              <div
                key={`${l.ts}-${i}`}
                className="text-meta leading-snug text-faint"
              >
                {l.message}
              </div>
            ))}
          </div>
          {run.logs.length > 20 && (
            <button
              className="mt-1 text-meta font-medium text-dim transition-colors hover:text-fg"
              onClick={() => setAllLogs((v) => !v)}
            >
              {allLogs ? "Show recent" : `Show all ${run.logs.length}`}
            </button>
          )}
        </div>
      )}
      {run.status === "error" && run.error && (
        <div className="px-2 py-1.5 text-meta leading-snug text-red">
          {run.error}
        </div>
      )}
      {run.status === "done" && run.result !== undefined && (
        <div>
          <button
            className={FOOTER_ROW}
            onClick={() => setShowResult((v) => !v)}
          >
            {showResult ? "Hide result" : "Show result"}
          </button>
          {showResult && (
            <div className="px-2 pb-1.5 pt-0.5">
              <DetailPre
                text={
                  stringResult.success
                    ? stringResult.data
                    : JSON.stringify(run.result, null, 2)
                }
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One agent row + its lazy drill-in. Memoized so the 1s elapsed ticker only
 *  re-renders rows whose props change (running rows get a new `duration`
 *  string; settled rows bail) — a 200-agent run must not re-render thousands
 *  of nodes per second. The drill-in body mounts only while expanded: the 0fr
 *  grid wrapper stays mounted so the expand still animates (enter-only —
 *  collapse unmounts the content immediately). */
const AgentRow = function AgentRow({
  a,
  open,
  detail,
  duration,
  onToggle,
  onLoadDetail,
  onOpenConversation,
  onAction,
}: {
  a: WorkflowAgentSnapshot;
  open: boolean;
  detail: WorkflowAgentDetail | "loading" | "missing" | undefined;
  duration: string;
  onToggle: (seq: number) => void;
  onLoadDetail: (seq: number) => void;
  onOpenConversation: (seq: number) => void;
  onAction: (seq: number, action: "skip" | "retry") => void;
}) {
  const full =
    detail === "loading" || detail === "missing" ? undefined : detail;
  const promptText = full?.prompt ?? a.promptPreview;
  const resultText = full
    ? (full.outcome.error ??
      (full.outcome.structured !== undefined
        ? JSON.stringify(full.outcome.structured, null, 2)
        : full.outcome.text))
    : (a.error ?? a.resultPreview);
  return (
    <>
      <button
        className={cn(
          ROW_CLASS,
          "flex-col items-stretch gap-0.5 hover:bg-hover",
        )}
        aria-expanded={open}
        onClick={() => onToggle(a.seq)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <StatusMark status={a.status} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-label",
              a.status === "cancelled" ? "text-faint line-through" : "text-fg",
            )}
          >
            {a.label}
          </span>
          {a.cached && <Chip>cached</Chip>}
          {a.modelSubstitutedFrom && (
            <Chip title={`Requested ${shortModel(a.modelSubstitutedFrom)}`}>
              switched
            </Chip>
          )}
          <AgentRail
            model={a.model}
            tokens={a.tokens?.output}
            duration={duration}
          />
        </span>
        {a.write && <WriteLine a={a} />}
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          open ? "[grid-template-rows:1fr]" : "[grid-template-rows:0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          {open && (
            <div className="mx-1 mb-1.5 mt-0.5 flex flex-col gap-1.5 rounded-md bg-hover p-2">
              {/* The headline affordance: what the agent actually DID, not
							    just what it said at the end. Available even while it runs
							    (the transcript view polls). */}
              <div className="flex flex-wrap items-center gap-1">
                {a.status !== "pending" && (
                  <Button
                    size="sm"
                    className="phone:min-h-11"
                    onClick={() => onOpenConversation(a.seq)}
                  >
                    View conversation
                    <span className="text-faint">→</span>
                  </Button>
                )}
                {a.status === "running" && (
                  <Button
                    variant="soft"
                    size="sm"
                    className="phone:min-h-11"
                    onClick={() => onAction(a.seq, "retry")}
                  >
                    Retry
                  </Button>
                )}
                {(a.status === "running" || a.status === "pending") && (
                  <Button
                    variant="soft"
                    size="sm"
                    className="phone:min-h-11"
                    onClick={() => onAction(a.seq, "skip")}
                  >
                    Stop agent
                  </Button>
                )}
              </div>
              <div className="text-meta font-medium text-faint">Prompt</div>
              <DetailPre text={promptText} />
              {(resultText || a.status === "error") && (
                <>
                  <div
                    className={cn(
                      "text-meta font-medium",
                      a.status === "error" || full?.outcome.error
                        ? "text-red"
                        : "text-faint",
                    )}
                  >
                    {a.status === "error" || full?.outcome.error
                      ? "Error"
                      : "Result"}
                  </div>
                  <DetailPre text={resultText || "(no output)"} />
                </>
              )}
              {detail === undefined &&
                (a.status === "done" || a.status === "error") && (
                  <button
                    className="self-start text-meta font-medium text-link hover:underline"
                    onClick={() => onLoadDetail(a.seq)}
                  >
                    Show full prompt & result
                  </button>
                )}
              {detail === "loading" && (
                <span className="text-meta text-faint">Loading…</span>
              )}
              {detail === "missing" && (
                // Transient failures happen (the snapshot flips done before
                // the journal entry lands) — keep the miss retryable.
                <button
                  className="self-start text-meta font-medium text-link hover:underline"
                  onClick={() => onLoadDetail(a.seq)}
                >
                  Couldn't load the full record. Retry
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
};
