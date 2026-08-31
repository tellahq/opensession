/**
 * opensession-sessions — an in-process MCP server that lets the agent see and steer
 * every other Open Session session from Slack: what's running, what's waiting on a
 * question, and the controls to answer / message / cancel / spin up sessions.
 *
 * Like opensession-admin and opensession-github, this is an in-process SDK MCP wired
 * ONLY into interactive Slack runs (handlers.ts processMessage). Its tools call
 * the session-control registry (src/server/session-control.ts), which opensession.ts
 * populates at startup with the same live state + helpers the WebSocket handlers
 * use — so steering a run from here behaves exactly like a human typing in the
 * web UI. It is never wired into automation runs (untrusted ticket text must not
 * be able to puppet other sessions).
 *
 * Gating: the read tools (list/get) are available to any whitelisted user who
 * can talk to the bot; the control tools (answer/send/cancel/create, and the
 * spawn_task/task_status/cancel_task task primitives) are gated to the trusted
 * user via `isAdmin`, matching opensession-admin.
 */
import { audit } from "../../server/audit";
import {
  cancelAgentWait,
  getAgentWait,
  registerPrChecksAgentWait,
  registerTimerAgentWait,
} from "../../server/agent-waits";
import {
  configuredServer,
  defaultRepo,
  personaName,
  productName,
} from "../../server/config";
import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { z } from "zod";
import { existsSync, readFileSync } from "fs";
import {
  getSessionControl,
  type SessionControl,
  type SessionState,
  type SessionSummary,
} from "../../server/session-control";
import { OPENSESSION_SESSIONS_DIR } from "../../server/paths";
import {
  agentActor,
  isWorkerActor,
  workerActor,
} from "../../server/session-actors";
import { writeJsonAtomic } from "../../server/shared/atomic-write";
import { userMatchesAny } from "../../server/shared/user-mappings";
import { migrateSessionEngine } from "../../server/session-model-migration";
import { resolveSessionRepoContext } from "../../server/session-repos";
import { transferSessionFile } from "../../server/session-file-transfer";
import type { NativeSessionFile, TranscriptEntry } from "../../server/types";

export interface SessionsToolContext {
  /** Display name credited when this session messages/creates others. */
  createdBy: string;
  /** Trusted user — gates the control tools (answer/send/cancel/create). */
  isAdmin: boolean;
  /** The session using these tools, so worker sessions can report back to it. */
  currentSessionId?: string;
  /**
   * Self-improving automation (automation.selfImprove, human-set): grants the
   * task primitives (spawn_task/task_status/cancel_task) WITHOUT isAdmin — the
   * spawn suite only, never answer/send/cancel/create on other sessions. Also
   * lifts spawnTaskImpl's automation refusal for this server instance. The
   * blast radius stays PR-gated: children open PRs, humans merge.
   */
  automationSelf?: boolean;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function durableToolRequestId(
  ctx: SessionsToolContext,
  toolName: string,
  extra:
    | {
        requestId?: string | number;
        _meta?: { opensessionToolCallId?: unknown };
      }
    | undefined,
  args?: unknown,
): string {
  const durableCallId =
    typeof extra?._meta?.opensessionToolCallId === "string"
      ? extra._meta.opensessionToolCallId
      : undefined;
  // The JSON-RPC requestId restarts from 1 on every MCP connection, so on
  // its own it is not unique across callers. Mix the tool arguments into
  // the fallback id: two different calls that happen to share a requestId
  // can no longer collide ("command id was reused with another payload"),
  // while true retries (same requestId, same payload) still deduplicate.
  const stableCallId =
    durableCallId ??
    (extra?.requestId != null
      ? `${String(extra.requestId)}:${new Bun.CryptoHasher("sha256").update(JSON.stringify(args) ?? "null").digest("hex")}`
      : crypto.randomUUID());
  const raw = `${ctx.currentSessionId || ctx.createdBy}:${toolName}:${stableCallId}`;
  const digest = new Bun.CryptoHasher("sha256").update(raw).digest("hex");
  return `mcp-${digest}`;
}

const STATE_ICON: Record<SessionState, string> = {
  running: "🟢",
  waiting_question: "❓",
  queued: "⏳",
  idle: "⚪",
  archived: "🗄️",
};

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t) return "?";
  const secs = Math.round((Date.now() - t) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Pull the human-readable headers out of a pending AskUserQuestion. */
function questionHeaders(questions: unknown[]): string {
  return questions
    .map((q) => {
      const o = q as {
        header?: string;
        question?: string;
        options?: { label?: string }[];
      };
      const opts = (o.options || []).map((opt) => opt.label).filter(Boolean);
      const head = o.header || o.question || "question";
      return `“${head}”${opts.length ? ` (${opts.join(" / ")})` : ""}`;
    })
    .join(", ");
}

function normalizedCreator(s: SessionSummary): string | null {
  return s.createdBy || s.startedBy || null;
}

/** Case-insensitive creator match against persisted display identity or
 * verified GitHub login, resolving configured aliases through the shared
 * identity table. Exported for the MCP contract tests. */
export function sessionMatchesCreatedBy(
  s: SessionSummary,
  query: string,
): boolean {
  if (!query.trim()) return true;
  return [normalizedCreator(s), s.createdByLogin]
    .filter((value): value is string => Boolean(value))
    .some((value) => userMatchesAny(value, [query]));
}

/** Stable, explicitly-labelled identity/timestamp fields keep callers from
 * guessing either value from a title or relative activity text. */
export function formatSessionLine(s: SessionSummary): string {
  const bits: string[] = [
    `${STATE_ICON[s.state]} *${s.title || "(untitled)"}*  \`${s.id}\``,
  ];
  const meta: string[] = [s.state];
  if (s.source) meta.push(s.source);
  if (s.mode) meta.push(s.mode);
  if (s.model) meta.push(s.model);
  if (s.branch) meta.push(`branch ${s.branch}`);
  if (s.parentSessionId) meta.push(`child of ${s.parentSessionId}`);
  meta.push(`createdBy=${JSON.stringify(normalizedCreator(s))}`);
  if (s.createdByLogin)
    meta.push(`createdByLogin=${JSON.stringify(s.createdByLogin)}`);
  if (s.createdAt) meta.push(`createdAt=${s.createdAt}`);
  meta.push(relTime(s.lastActivity));
  if (!s.controllable) meta.push("observe-only");
  bits.push(`   ${meta.join(" · ")}`);
  if (s.prUrl) bits.push(`   PR ${s.prState || ""} ${s.prUrl}`.trimEnd());
  if (s.queuedCount > 0) bits.push(`   ${s.queuedCount} message(s) queued`);
  if (s.state === "waiting_question" && s.pendingQuestion) {
    bits.push(
      `   ⚠️ waiting on: ${questionHeaders(s.pendingQuestion.questions)}`,
    );
  }
  return bits.join("\n");
}

function fmtTranscriptTail(entries: TranscriptEntry[]): string {
  if (!entries.length) return "_(no transcript yet)_";
  return entries
    .map((e) => {
      const who =
        e.type === "user"
          ? "user"
          : e.type === "assistant"
            ? "assistant"
            : e.type === "tool_use"
              ? `tool:${e.toolName || "?"}`
              : e.type;
      const body = (e.content || "").replace(/\s+/g, " ").slice(0, 280);
      // An errored tool call rendering identically to a successful one is
      // actively misleading in a status view.
      return `• ${who}${e.isError ? " ✗" : ""}: ${body}`;
    })
    .join("\n");
}

export function buildChildSessionPrompt(input: {
  prompt: string;
  parentSessionId?: string;
  reportBack?: boolean;
}): string {
  const parts = [
    input.prompt.trim(),
    `You are a worker session delegated by another ${personaName()} session. Keep the work narrow: execute the requested investigation/implementation, run relevant checks when practical, and do not broaden scope or make product/taste decisions unless explicitly asked.`,
  ];
  if (input.reportBack && input.parentSessionId) {
    // The facts (files changed, commands run, tool failures, PR, usage) are
    // appended to the report mechanically by handoff-evidence.ts, so the model
    // is asked for the part a server cannot compute — judgement, and the dead
    // ends a summary always drops first.
    parts.push(
      `When finished — as your LAST action, after any commit/PR — report back to the parent/orchestrator session \`${input.parentSessionId}\` with the opensession-sessions send_to_session tool. A factual evidence block (files changed, commands run, tool failures, PR, usage) is appended to your report automatically: do not re-list those. Write what the server cannot compute: whether the result meets the acceptance criteria and how confident you are, what you tried that did NOT work and why you abandoned it, assumptions you made, remaining uncertainty, and follow-ups needed.`,
    );
  }
  return parts.join("\n\n");
}

/** Hard ceiling on the appended evidence block — a handoff must inform the
 *  parent, not refill its context window. */
const EVIDENCE_MAX_CHARS = 4000;

/**
 * Marks the delivered report as agent-authored so the UI renders it as a
 * worker card rather than a message the human appears to have typed. Kept in
 * sync with WORKER_SENTINEL_RE in packages/core/protocol/src/notices.ts, which also
 * falls back to the "worker <id>" attribution so reports sent before this
 * sentinel shipped still render as cards.
 */
const WORKER_REPORT_SENTINEL = "<!--os:worker-report-->";

const SESSION_NOTICE_SENTINEL = "<!--os:session-notice-->";

/** Mark an agent-authored cross-session message for notice rendering. The
 * payload still drives the target's next turn, but it must never read as words
 * the session owner typed. */
export function sessionMessagePayload(message: string): string {
  return `${SESSION_NOTICE_SENTINEL}\n${message}`;
}

/**
 * A worker reporting to its parent gets the server's facts stapled to its
 * prose, and is attributed as a worker rather than as the human whose name it
 * inherited (a report arriving as "[Alex] …" reads to the parent model like
 * a human instruction, which it is not).
 *
 * The evidence is snapshotted HERE, at send time, not inside deliverToSession:
 * a queued message that gets requeued must redeliver what the worker actually
 * sent, not a diff recomputed minutes later.
 */
export async function workerReportPayload(
  targetId: string,
  message: string,
  ctx: Pick<SessionsToolContext, "createdBy" | "currentSessionId">,
  deps?: {
    parentOf?: (id: string) => string | undefined;
    evidence?: (id: string) => Promise<string | null>;
    stampReported?: (id: string) => void;
  },
): Promise<{ content: string; user: string }> {
  const me = ctx.currentSessionId;
  // Provenance is part of the transport contract: a message emitted by an
  // agent must never arrive looking like a human instruction merely because
  // the session inherited that human's display name.
  const fallback = {
    content: message,
    user: me && me !== targetId ? agentActor(me) : ctx.createdBy,
  };
  if (!me || me === targetId) return fallback;
  try {
    const parentOf =
      deps?.parentOf ??
      ((id: string) => {
        try {
          return getSessionControl().getSession(id)?.parentSessionId;
        } catch {
          return undefined;
        }
      });
    if (parentOf(me) !== targetId) return fallback;

    const evidence =
      deps?.evidence ??
      (async (id: string) => {
        const { collectHandoffEvidence, formatHandoffEvidence } =
          await import("../../server/handoff-evidence");
        const ev = await collectHandoffEvidence(id);
        return ev ? formatHandoffEvidence(ev) : null;
      });
    const stamp =
      deps?.stampReported ??
      ((id: string) => {
        void import("../../server/session-cache")
          .then(({ touchNativeSession }) =>
            touchNativeSession(id, {
              lastReportToParentAt: new Date().toISOString(),
            }),
          )
          .catch(() => {});
      });

    const block = await evidence(me);
    stamp(me);
    const body = block
      ? `${message}\n\n${block.slice(0, EVIDENCE_MAX_CHARS)}`
      : message;
    return {
      content: `${WORKER_REPORT_SENTINEL}\n${body}`,
      user: workerActor(me),
    };
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// spawn_task / task_status / cancel_task — the fire-and-forget child-task
// primitive (background-agents' spawn-task pattern). spawn_task rides the SAME
// SessionControl.createSession code path as create_session (never a parallel
// implementation); what it adds is the task contract: return {taskId, url}
// immediately, poll with task_status, stop with cancel_task — plus a spawn-
// depth loop guard and an automation refusal (defense-in-depth: opensession-
// sessions is never wired into automation runs in the first place; opensession.ts
// gates inProcessMcp on !isAutomationSession and admin-tools/handlers wire it
// only for interactive Slack runs).
// ---------------------------------------------------------------------------

/** A session at this spawn depth may not spawn further (root = 0, so one
 *  spawned child may spawn one grandchild; the grandchild is the floor). */
export const MAX_SPAWN_DEPTH = 2;

/** Injection seam so the depth guard / automation refusal / file stamping are
 *  unit-testable without a live server or real session files. */
export interface SpawnTaskDeps {
  control: SessionControl;
  /** Read a opensession session file by id; null when absent/unreadable. */
  readSessionFile: (id: string) => Partial<NativeSessionFile> | null;
  /** Persist spawnDepth onto the child's session file (async, best-effort). */
  stampSpawnDepth: (id: string, depth: number) => void | Promise<void>;
}

function defaultReadSessionFile(id: string): Partial<NativeSessionFile> | null {
  try {
    const path = `${OPENSESSION_SESSIONS_DIR}/${id}.json`;
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Persist spawnDepth on the child's session file. The file is first written at
 * the opening run's `init` event (opensession.ts persist(), which builds it from
 * scratch — anything written earlier would be clobbered), so poll until it
 * exists and then MERGE the field; every later update goes through
 * touchNativeSession-style merges, so it sticks. The in-memory depth map
 * (below) covers the guard in the meantime.
 */
async function defaultStampSpawnDepth(
  id: string,
  depth: number,
): Promise<void> {
  const path = `${OPENSESSION_SESSIONS_DIR}/${id}.json`;
  for (let i = 0; i < 240; i++) {
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, "utf-8"));
        if (data?.id) {
          if (data.spawnDepth !== depth)
            writeJsonAtomic(path, { ...data, spawnDepth: depth });
          return;
        }
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn(
    `[spawn_task] could not stamp spawnDepth on ${id} — session file never appeared`,
  );
}

function defaultSpawnDeps(): SpawnTaskDeps {
  return {
    control: getSessionControl(),
    readSessionFile: defaultReadSessionFile,
    stampSpawnDepth: defaultStampSpawnDepth,
  };
}

/** Depths of children spawned by THIS process, so the guard holds in the
 *  window before the child's session file exists (parked on globalThis to
 *  survive `bun --hot` reloads, capped so it never grows unbounded). */
function spawnDepthMap(): Map<string, number> {
  const g = globalThis as { __bksSpawnDepths?: Map<string, number> };
  return (g.__bksSpawnDepths ??= new Map());
}

/** A session's spawn depth: session file first (authoritative + fresh), then
 *  the in-process map (pre-init window), then the control registry's summary. */
export function resolveSpawnDepth(
  sessionId: string | undefined,
  deps: Pick<SpawnTaskDeps, "control" | "readSessionFile">,
): number {
  if (!sessionId) return 0;
  const file = deps.readSessionFile(sessionId);
  if (typeof file?.spawnDepth === "number") return file.spawnDepth;
  const mem = spawnDepthMap().get(sessionId);
  if (typeof mem === "number") return mem;
  try {
    const s = deps.control.getSession(sessionId);
    if (typeof s?.spawnDepth === "number") return s.spawnDepth;
  } catch {}
  return 0;
}

function isAutomationOwned(
  sessionId: string,
  deps: Pick<SpawnTaskDeps, "control" | "readSessionFile">,
): boolean {
  const file = deps.readSessionFile(sessionId);
  if (file?.automation) return true;
  if (file?.createdBy?.endsWith(" (automation)")) return true;
  try {
    return Boolean(deps.control.getSession(sessionId)?.automation);
  } catch {
    return false;
  }
}

export interface SpawnTaskArgs {
  prompt: string;
  repo?: string;
  branch?: string;
  model?: string;
  mode?: "ask" | "code" | "scratch";
  /** Give the child its own worktree/branch instead of sharing the parent's. */
  isolatedWorktree?: boolean;
  /** true = config default provider; or an explicit configured provider id. */
  sandbox?:
    | boolean
    | "docker"
    | "daytona"
    | "e2b"
    | "box"
    | "modal"
    | "microvm"
    | "lambda-microvm";
}

export type SpawnTaskResult =
  | {
      ok: true;
      taskId: string;
      url: string;
      createdBy: string;
      createdAt: string;
    }
  | { ok: false; error: string };

export async function spawnTaskImpl(
  args: SpawnTaskArgs,
  ctx: SessionsToolContext,
  deps: SpawnTaskDeps = defaultSpawnDeps(),
  requestId?: string,
): Promise<SpawnTaskResult> {
  if (!args.prompt?.trim())
    return { ok: false, error: "Need a prompt to spawn a task." };
  const mode = args.mode || "code";
  const caller = ctx.currentSessionId;
  // Defense-in-depth: opensession-sessions is withheld from automation runs at the
  // wiring layer already; refuse anyway if the calling session is
  // automation-owned (interactive resumes of automation sessions included).
  // Exception: a self-improving automation (automation.selfImprove, human-set)
  // gets a server instance built with `automationSelf` — spawning is the point
  // there, and the depth guard below still applies.
  if (caller && !ctx.automationSelf && isAutomationOwned(caller, deps)) {
    return {
      ok: false,
      error: "spawn_task is not available from automation sessions.",
    };
  }
  const myDepth = resolveSpawnDepth(caller, deps);
  if (myDepth >= MAX_SPAWN_DEPTH) {
    return {
      ok: false,
      error:
        `spawn_task refused: this session is already ${myDepth} spawn hops from a human-created session ` +
        `(max ${MAX_SPAWN_DEPTH}). Do the work here, or report back to your parent instead of delegating further.`,
    };
  }
  // Code mode needs somewhere to work: an explicit branch, or a parent code
  // session whose worktree the child will share (createSession's same-
  // workspace = same-worktree rule; only when the repo matches).
  if (mode === "code" && !args.branch?.trim() && !args.isolatedWorktree) {
    let sharable = false;
    if (caller) {
      try {
        const parent = deps.control.getSession(caller);
        sharable = Boolean(
          parent &&
          parent.mode === "code" &&
          resolveSessionRepoContext(parent, args.repo, args.prompt)?.dir,
        );
      } catch {}
    }
    if (!sharable) {
      return {
        ok: false,
        error:
          "Code-mode task needs a `branch` (no parent code worktree to share).",
      };
    }
  }
  const prompt = buildChildSessionPrompt({
    prompt: args.prompt,
    parentSessionId: caller,
    reportBack: Boolean(caller),
  });
  const { id, createdBy, createdAt } = await deps.control.createSession({
    requestId,
    requestScope: caller || ctx.createdBy,
    prompt,
    repo: args.repo,
    mode,
    branch: args.branch,
    model: args.model,
    isolatedWorktree: args.isolatedWorktree,
    parentSessionId: caller,
    reportBack: Boolean(caller),
    user: ctx.createdBy,
    sandbox: args.sandbox,
  });
  const depth = myDepth + 1;
  const map = spawnDepthMap();
  map.set(id, depth);
  if (map.size > 500) map.delete(map.keys().next().value!);
  void Promise.resolve(deps.stampSpawnDepth(id, depth)).catch((e) =>
    console.warn(`[spawn_task] stamping spawnDepth on ${id} failed:`, e),
  );
  const base =
    process.env.OPENSESSION_UI_BASE || configuredServer().publicBaseUrl;
  return {
    ok: true,
    taskId: id,
    url: `${base}/session/${id}`,
    createdBy,
    createdAt,
  };
}

/** Task-facing state view: running / waiting (blocked on a question) / done /
 *  error (last run died on a terminal failure). */
export function taskStateOf(
  s: SessionSummary,
): "running" | "waiting" | "done" | "error" {
  if (s.state === "running" || s.state === "queued") return "running";
  if (s.state === "waiting_question") return "waiting";
  return s.lastRunError ? "error" : "done";
}

export async function taskStatusImpl(
  args: { taskId: string; transcript_lines?: number },
  deps: SpawnTaskDeps = defaultSpawnDeps(),
): Promise<string> {
  const s = deps.control.getSession(args.taskId);
  if (!s) return `No task/session with id \`${args.taskId}\`.`;
  const state = taskStateOf(s);
  const parts = [
    `Task \`${s.id}\` — *${state}* (${s.state})`,
    formatSessionLine(s),
  ];
  if (state === "error" && s.lastRunError)
    parts.push(`*Error:* ${s.lastRunError.message}`);
  if (s.state === "waiting_question" && s.pendingQuestion) {
    parts.push(
      `*Waiting on:* ${questionHeaders(s.pendingQuestion.questions)} — answer with answer_session_question (questionId \`${s.pendingQuestion.questionId}\`).`,
    );
  }
  // The facts, computed rather than summarized: diff (labelled when the
  // worktree is shared with the parent), PR, tool-reported failures, commands,
  // usage. Same block the child's report-back carries, so a poll and a handoff
  // agree instead of telling two different stories.
  let evidenced = false;
  try {
    const { collectHandoffEvidence, formatHandoffEvidence } =
      await import("../../server/handoff-evidence");
    const ev = await collectHandoffEvidence(args.taskId);
    if (ev) {
      parts.push(
        formatHandoffEvidence(ev, { title: "*Evidence* (server-computed):" }),
      );
      evidenced = true;
    }
  } catch {}
  if (!evidenced && s.prUrl)
    parts.push(`*PR:* ${s.prState || ""} ${s.prUrl}`.trim());
  const tail = await deps.control.transcriptTail(
    args.taskId,
    args.transcript_lines ?? 12,
  );
  parts.push(`*Recent transcript:*\n${fmtTranscriptTail(tail)}`);
  return parts.join("\n");
}

export async function cancelTaskImpl(
  args: { taskId: string },
  deps: SpawnTaskDeps = defaultSpawnDeps(),
  requestId?: string,
): Promise<string> {
  const ok = await deps.control.cancelSession(args.taskId, { requestId });
  return ok
    ? `Cancelled task \`${args.taskId}\`.`
    : `Nothing to cancel on \`${args.taskId}\` (idle, done, or an external run this server doesn't own).`;
}

export function createSessionsMcpServer(
  ctx: SessionsToolContext,
  deps: { branchNameFromPrompt?: (prompt: string) => Promise<string> } = {},
) {
  const tools: any[] = [
    // -----------------------------------------------------------------------
    // Observe (any whitelisted user)
    // -----------------------------------------------------------------------
    tool(
      "list_sessions",
      `List ${productName()} sessions with their live state and explicit creator metadata. Every row includes createdBy (null when the origin did not record one) and createdAt, so callers can answer who created sessions in a time window without guessing from titles or transcripts. Use createdBy for a case-insensitive display-name, verified-login, or configured-alias filter. Use filter 'waiting' to see only sessions blocked on a question (the ones that need a human), 'active' for running+waiting+queued, or 'all' (default, hides archived).`,
      {
        filter: z
          .enum(["all", "active", "waiting"])
          .optional()
          .describe(
            "'all' (default, excludes archived), 'active' (running/waiting/queued), or 'waiting' (blocked on a question).",
          ),
        createdBy: z
          .string()
          .optional()
          .describe(
            "Case-insensitive creator display name, verified GitHub login, or configured alias. Uses persisted session identity; never title/content inference.",
          ),
      },
      async (args: {
        filter?: "all" | "active" | "waiting";
        createdBy?: string;
      }) => {
        const filter = args.filter || "all";
        let sessions = getSessionControl().listSessions();
        if (filter === "waiting") {
          sessions = sessions.filter((s) => s.state === "waiting_question");
        } else if (filter === "active") {
          sessions = sessions.filter((s) =>
            ["running", "waiting_question", "queued"].includes(s.state),
          );
        } else {
          sessions = sessions.filter((s) => s.state !== "archived");
        }
        if (args.createdBy?.trim()) {
          sessions = sessions.filter((s) =>
            sessionMatchesCreatedBy(s, args.createdBy!),
          );
        }
        if (!sessions.length)
          return text(`No ${filter === "all" ? "" : filter + " "}sessions.`);
        const waiting = sessions.filter(
          (s) => s.state === "waiting_question",
        ).length;
        const header = `${sessions.length} session(s)${waiting ? ` — ⚠️ ${waiting} waiting on input` : ""}:`;
        return text(
          [header, "", ...sessions.map(formatSessionLine)].join("\n"),
        );
      },
    ),
    tool(
      "get_session",
      "Get detail on one session by id, including explicit createdBy and createdAt metadata (createdBy is null when the origin did not record identity), state, any pending question, queue depth, and transcript tail.",
      {
        id: z
          .string()
          .describe(
            "The session id, e.g. 'bks-…' or 'slack-…' from list_sessions.",
          ),
        transcript_lines: z
          .number()
          .optional()
          .describe(
            "How many trailing transcript entries to include (default 12).",
          ),
      },
      async (args: { id: string; transcript_lines?: number }) => {
        const ctrl = getSessionControl();
        const s = ctrl.getSession(args.id);
        if (!s) return text(`No session with id \`${args.id}\`.`);
        const parts = [formatSessionLine(s)];
        if (s.goal) parts.push(`\n*Pinned goal:* ${s.goal}`);
        if (s.pendingQuestion) {
          parts.push(
            `\n*Waiting for an answer* (questionId \`${s.pendingQuestion.questionId}\`):\n` +
              questionHeaders(s.pendingQuestion.questions) +
              `\nUse answer_session_question to respond.`,
          );
        }
        const tail = await ctrl.transcriptTail(
          args.id,
          args.transcript_lines ?? 12,
        );
        parts.push(`\n*Recent transcript:*\n${fmtTranscriptTail(tail)}`);
        return text(parts.join("\n"));
      },
    ),
  ];

  if (ctx.isAdmin) {
    tools.push(
      // ---------------------------------------------------------------------
      // Control (trusted user only)
      // ---------------------------------------------------------------------
      tool(
        "wait_for",
        "End this turn cleanly and wake this same session later without sleeping in a tool call. Register the wait, then write the human a normal status/final message and STOP the turn. A timer wakes after the requested delay. A pr_checks wait polls durably outside the model turn, waits for the check set to remain settled, then starts a new turn with the result; it also wakes on PR close/merge or timeout. One wait may be active per session, and a new one replaces it. Never call sleep after this tool succeeds.",
        {
          kind: z
            .enum(["timer", "pr_checks"])
            .describe(
              "timer for a one-shot delay, or pr_checks to wake when this branch's PR checks settle.",
            ),
          seconds: z
            .number()
            .optional()
            .describe(
              "Timer delay in seconds, required for kind=timer. Minimum 10 seconds, maximum 24 hours.",
            ),
          repo: z
            .string()
            .optional()
            .describe(
              "Registered repo id for kind=pr_checks. Defaults to this session's primary repo.",
            ),
          branch: z
            .string()
            .optional()
            .describe(
              "PR branch for kind=pr_checks. Defaults to this session's primary branch.",
            ),
          timeout_seconds: z
            .number()
            .optional()
            .describe(
              "Maximum PR wait before waking anyway. Defaults to 2 hours, maximum 24 hours.",
            ),
          prompt: z
            .string()
            .optional()
            .describe(
              "Instructions for the new turn after wake-up. Keep them self-contained. A sensible continuation is supplied by default.",
            ),
        },
        async (
          args: {
            kind: "timer" | "pr_checks";
            seconds?: number;
            repo?: string;
            branch?: string;
            timeout_seconds?: number;
            prompt?: string;
          },
          extra: any,
        ) => {
          const sessionId = ctx.currentSessionId;
          if (!sessionId)
            return text(
              "This run has no Open Session id, so it cannot register a background wait.",
            );
          const waitId = durableToolRequestId(ctx, "wait_for", extra, args);
          const current = getSessionControl().getSession(sessionId);
          const result =
            args.kind === "timer"
              ? await registerTimerAgentWait({
                  sessionId,
                  user: ctx.createdBy,
                  seconds: args.seconds ?? Number.NaN,
                  prompt: args.prompt,
                  waitId,
                })
              : await registerPrChecksAgentWait({
                  sessionId,
                  user: ctx.createdBy,
                  repo: args.repo || current?.repo || "",
                  branch: args.branch || current?.branch || "",
                  timeoutSeconds: args.timeout_seconds,
                  prompt: args.prompt,
                  waitId,
                });
          if (!result.ok) return text(result.error);
          audit({
            msg: "agent_wait_registered",
            session_id: sessionId,
            wait_id: result.wait.id,
            wait_kind: result.wait.kind,
            replaced: result.replaced,
          });
          const when =
            result.wait.kind === "timer"
              ? new Date(result.wait.dueAt).toISOString()
              : `when ${result.wait.repo}/${result.wait.branch} checks settle (timeout ${new Date(result.wait.deadlineAt).toISOString()})`;
          return text(
            `Background wait \`${result.wait.id}\` registered for ${when}. ` +
              `${result.replaced ? "It replaced the previous wait. " : ""}` +
              "Now write the human a concise status message and end this turn. Do not poll or sleep; this session will be triggered automatically.",
          );
        },
      ),
      tool(
        "wait_status",
        "Inspect the background wait registered by this session.",
        {},
        async () => {
          const sessionId = ctx.currentSessionId;
          if (!sessionId) return text("This run has no Open Session id.");
          const wait = await getAgentWait(sessionId);
          if (!wait)
            return text("No background wait is registered for this session.");
          if (wait.kind === "timer")
            return text(
              `Timer wait \`${wait.id}\` wakes at ${new Date(wait.dueAt).toISOString()}.`,
            );
          return text(
            `PR wait \`${wait.id}\` watches ${wait.repo}/${wait.branch}; timeout ${new Date(wait.deadlineAt).toISOString()}.`,
          );
        },
      ),
      tool(
        "cancel_wait",
        "Cancel this session's registered background wait. This does not stop a currently running turn.",
        {},
        async () => {
          const sessionId = ctx.currentSessionId;
          if (!sessionId) return text("This run has no Open Session id.");
          const cancelled = await cancelAgentWait(sessionId);
          if (cancelled)
            audit({ msg: "agent_wait_cancelled", session_id: sessionId });
          return text(
            cancelled
              ? "Background wait cancelled."
              : "No background wait was registered.",
          );
        },
      ),
      tool(
        "answer_session_question",
        "Answer a session that's paused on a question (state 'waiting_question'). Provide answers as a map from each question's header to the chosen option label (see get_session for the headers and options). This unblocks the run so it continues.",
        {
          id: z.string().describe("The waiting session's id."),
          answers: z
            .record(z.string(), z.string())
            .describe(
              'Map of question header → chosen option label, e.g. { "Auth method": "OAuth" }.',
            ),
        },
        async (
          args: { id: string; answers: Record<string, string> },
          extra: any,
        ) => {
          const ok = await getSessionControl().answerQuestion(
            args.id,
            args.answers,
            {
              requestId: durableToolRequestId(
                ctx,
                "answer_question",
                extra,
                args,
              ),
            },
          );
          return text(
            ok
              ? `Answered \`${args.id}\` — the run continues with your choice.`
              : `\`${args.id}\` isn't waiting on a question right now.`,
          );
        },
      ),
      tool(
        "send_to_session",
        "Send a message to another session. If it's mid-run it's folded into the current turn (picked up at the next stopping point); if it's idle it starts a new turn; external runs (CLI/tmux) get the message queued. Use this to redirect or follow up on a session without opening it. Slash commands are handled by opensession itself instead of being delivered as prompt text: `/loop <interval> <prompt>` sets a recurring self-prompt on the TARGET session (fires only while it is idle; min 5m), `/loop status` / `/loop stop` inspect or clear it — works on your own session id too, so a monitor session can stop its own loop when the work is done.",
        {
          id: z.string().describe("The target session's id."),
          message: z.string().describe("The message to deliver."),
          delivery_id: z
            .string()
            .max(128)
            .optional()
            .describe(
              "Optional caller-generated correlation id. Omit to receive a generated delivery receipt.",
            ),
        },
        async (
          args: { id: string; message: string; delivery_id?: string },
          extra: any,
        ) => {
          if (!args.message?.trim())
            return text("Nothing to send (empty message).");
          // Reporting to my own parent gets a worker card with server-computed
          // evidence. Every other agent-authored delivery gets a session notice.
          // Both still drive the target's next turn; neither is human prose.
          const payload = await workerReportPayload(args.id, args.message, ctx);
          const content = isWorkerActor(payload.user)
            ? payload.content
            : sessionMessagePayload(payload.content);
          const deliveryId =
            args.delivery_id?.trim() ||
            durableToolRequestId(ctx, "send_to_session", extra, args);
          const res = await getSessionControl().deliverToSession(
            args.id,
            content,
            payload.user,
            { deliveryId },
          );
          audit({
            kind: "agent_message_delivery",
            delivery_id: res.deliveryId || deliveryId,
            source_session_id: ctx.currentSessionId,
            target_session_id: args.id,
            outcome: res.status,
            user: ctx.createdBy,
          });
          return text(
            `Delivery \`${res.deliveryId || deliveryId}\` status=${res.status}: ${res.message}`,
          );
        },
      ),
      tool(
        "send_file_to_session",
        "Copy one file from this session to another session and notify that agent. The source may be a relative path in this session's workspace (including a sandbox-only workspace) or in this session's Assets folder. The binary-safe copy lands in the recipient's Assets inbox, where its agent can read it with opensession-assets and humans can open/download it from the Assets tab. Paths are relative; host paths and traversal are refused; maximum size is 4 MiB.",
        {
          id: z.string().describe("The recipient session id."),
          path: z
            .string()
            .describe(
              "Relative source path in this session's workspace or Assets folder.",
            ),
          source: z
            .enum(["workspace", "assets"])
            .optional()
            .describe("Source area; defaults to workspace."),
          destination: z
            .string()
            .optional()
            .describe(
              "Optional relative path in the recipient's Assets folder. Defaults to inbox/<sender-session>/<filename>.",
            ),
          message: z
            .string()
            .optional()
            .describe(
              "Optional context for the recipient. The file location is appended automatically.",
            ),
        },
        async (
          args: {
            id: string;
            path: string;
            source?: "workspace" | "assets";
            destination?: string;
            message?: string;
          },
          extra: any,
        ) => {
          const fromId = ctx.currentSessionId;
          if (!fromId)
            return text(
              "File sending needs a current Open Session session id.",
            );
          const ctrl = getSessionControl();
          const from = ctrl.getSession(fromId);
          if (!from)
            return text(`The sending session \`${fromId}\` no longer exists.`);
          const to = ctrl.getSession(args.id);
          if (!to) return text(`No session with id \`${args.id}\`.`);
          try {
            const file = await transferSessionFile({
              fromSession: from,
              toSession: to,
              path: args.path,
              source: args.source,
              destination: args.destination,
              description: args.message,
            });
            const download =
              `/api/sessions/${encodeURIComponent(to.id)}/assets/raw/` +
              `${file.path.split("/").map(encodeURIComponent).join("/")}?download=1`;
            const notification = [
              args.message?.trim() || `Session ${fromId} sent you a file.`,
              `Received asset: \`${file.path}\` (${file.size} bytes). Read it with the opensession-assets tools or open ${download}.`,
            ].join("\n\n");
            const deliveryId = durableToolRequestId(
              ctx,
              "send_file_to_session",
              extra,
              args,
            );
            const delivered = await ctrl.deliverToSession(
              to.id,
              notification,
              workerActor(fromId),
              { deliveryId },
            );
            audit({
              msg: "session_file_sent",
              session_id: fromId,
              target_session_id: to.id,
              source: file.source,
              asset_path: file.path,
              bytes: file.size,
              user: ctx.createdBy,
              delivery: delivered.status,
              delivery_id: delivered.deliveryId || deliveryId,
            });
            return text(
              `Sent \`${file.path}\` (${file.size} bytes) to \`${to.id}\` as delivery \`${delivered.deliveryId || deliveryId}\`; ${delivered.message}`,
            );
          } catch (error) {
            return text(
              `Could not send the file: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
      ),
      tool(
        "cancel_session",
        "Cancel a session's in-flight run and drop any queued messages. Only works for runs this server owns (web UI / Slack / automation sessions) — external CLI/tmux sessions are observe-only.",
        { id: z.string().describe("The session id to cancel.") },
        async (args: { id: string }, extra: any) => {
          const ok = await getSessionControl().cancelSession(args.id, {
            requestId: durableToolRequestId(ctx, "cancel_session", extra, args),
          });
          if (ok) {
            audit({
              msg: "run_cancelled",
              session_id: args.id,
              source: "sessions_mcp",
              user: ctx.createdBy,
              cancelled_from: ctx.currentSessionId,
            });
          }
          return text(
            ok
              ? `Cancelled the run on \`${args.id}\`.`
              : `Nothing to cancel on \`${args.id}\` (idle, or an external run this server doesn't own).`,
          );
        },
      ),
      tool(
        "create_session",
        `Spin up a visible ${productName()} session and start it on a prompt. Use this as the sub-session primitive: workers can delegate focused tasks and report back to this parent session. mode 'ask' (default) runs read-only on the selected repo checkout; mode 'code' can edit files / open PRs (never merges). A worker targeting one of the parent's repos shares that exact primary or attached worktree, so reviewers see current/uncommitted work; pass repo explicitly for attached-repo tasks. Pass isolatedWorktree true to instead give the worker its own worktree and branch (child/report-back linkage is kept) — use it when fanning work out across separate workspaces. \`branch\` is only used when there is nothing to share — a standalone worker, or a worker targeting a repo the parent does not carry — and is generated from the prompt when omitted. Repo defaults to the parent session's repo (${defaultRepo().id} when standalone); pass another registered repo id to override. For workers that only need filesystem/code access, pass mcpServers: [] to avoid unrelated MCP startup cost/failures. When called from a session, the worker defaults to the same workspace and is instructed to report back here; set standalone true or reportBack false to opt out. When a HUMAN asks for "a new session" ("create a new session for X", "spin one up on Y"), this tool is what they mean — a detached session that appears in their sidebar and outlives the current run — never an in-process subagent or task agent; reply with the new session's URL.`,
        {
          prompt: z
            .string()
            .describe("The task/prompt to start the session on."),
          repo: z
            .string()
            .optional()
            .describe(
              `Registered repo id to run in. Defaults to ${defaultRepo().id}.`,
            ),
          mode: z
            .enum(["ask", "code"])
            .optional()
            .describe(
              "'ask' = read-only (default), 'code' = worktree with write access.",
            ),
          branch: z
            .string()
            .optional()
            .describe(
              "Optional fallback branch for code mode. When the worker can't share the parent workspace's worktree, an omitted branch is generated from the prompt. Ignored for ask.",
            ),
          model: z
            .string()
            .optional()
            .describe(
              "Optional model id or unambiguous visible slug (e.g. 'claude-opus-5' or 'glm-5.3').",
            ),
          mcpServers: z
            .array(z.string())
            .optional()
            .describe(
              "Optional MCP server allowlist for the opening run. Use [] for no MCP servers.",
            ),
          parentSessionId: z
            .string()
            .optional()
            .describe(
              "Session id this worker should report back to. Defaults to the current session when available.",
            ),
          reportBack: z
            .boolean()
            .optional()
            .describe(
              "Whether to append report-back instructions to the worker prompt. Defaults true when a parent session id is available.",
            ),
          standalone: z
            .boolean()
            .optional()
            .describe(
              "Create an unrelated standalone session instead of a child of the current session.",
            ),
          isolatedWorktree: z
            .boolean()
            .optional()
            .describe(
              "Code mode: give the worker its own worktree and branch instead of sharing the parent workspace's worktree, while keeping child/report-back linkage. Use when fanning work out across separate workspaces so each child produces its own diff. Branch is generated from the prompt when omitted.",
            ),
          sandbox: z
            .union([
              z.boolean(),
              z.enum([
                "docker",
                "daytona",
                "e2b",
                "box",
                "modal",
                "microvm",
                "lambda-microvm",
              ]),
            ])
            .optional()
            .describe(
              "Run the session in an isolated sandbox: true = the server's default provider, or an explicit provider id (must be configured server-side, else the create fails with a clear error). Omit for a host run.",
            ),
          accountId: z
            .string()
            .optional()
            .describe(
              "Pin a Claude/Codex provider account id for the session's runs (soft pin; invalid/foreign ids fall back to the pool).",
            ),
          forkFrom: z
            .object({
              sourceId: z.string().describe("Session id to fork."),
              messageId: z
                .string()
                .optional()
                .describe("Fork from this past message instead of the tip."),
            })
            .optional()
            .describe(
              "Fork an existing session: the new session shares its worktree/branch/model, cloning the conversation when the engine supports it (Claude) and handing off the transcript otherwise. mode/branch/model/sandbox inputs are ignored.",
            ),
        },
        async (
          args: {
            prompt: string;
            repo?: string;
            mode?: "ask" | "code" | "scratch";
            branch?: string;
            model?: string;
            mcpServers?: string[];
            parentSessionId?: string;
            reportBack?: boolean;
            standalone?: boolean;
            isolatedWorktree?: boolean;
            sandbox?:
              | boolean
              | "docker"
              | "daytona"
              | "e2b"
              | "box"
              | "modal"
              | "microvm"
              | "lambda-microvm";
            accountId?: string;
            forkFrom?: { sourceId: string; messageId?: string };
          },
          extra: any,
        ) => {
          if (!args.prompt?.trim())
            return text("Need a prompt to start a session.");
          const parentSessionId = args.standalone
            ? undefined
            : args.parentSessionId || ctx.currentSessionId;
          const shouldReportBack = args.reportBack ?? Boolean(parentSessionId);
          const prompt = parentSessionId
            ? buildChildSessionPrompt({
                prompt: args.prompt,
                parentSessionId,
                reportBack: shouldReportBack,
              })
            : args.prompt;
          const branch = args.branch;
          const { id, createdBy, createdAt } =
            await getSessionControl().createSession({
              requestId: durableToolRequestId(
                ctx,
                "create_session",
                extra,
                args,
              ),
              requestScope: ctx.currentSessionId || ctx.createdBy,
              prompt,
              repo: args.repo,
              mode: args.mode,
              branch,
              model: args.model,
              mcpServers: args.mcpServers,
              isolatedWorktree: args.isolatedWorktree,
              parentSessionId,
              reportBack: shouldReportBack,
              user: ctx.createdBy,
              sandbox: args.sandbox,
              accountId: args.accountId,
              forkFrom: args.forkFrom,
            });
          return text(
            [
              `Started session \`${id}\` (${args.mode === "code" ? (branch ? `code on ${branch}` : "code session") : "ask"}). Metadata: createdBy=${JSON.stringify(createdBy)} · createdAt=${createdAt}. It'll appear in list_sessions as it boots.`,
              parentSessionId && shouldReportBack
                ? `It is linked to \`${parentSessionId}\` and has instructions to report back there.`
                : "",
            ]
              .filter(Boolean)
              .join(" "),
          );
        },
      ),
      tool(
        "migrate_session_engine",
        "Migrate an existing session onto the Pi engine by flipping its model to a pi/* id (e.g. pi/anthropic/claude-sonnet-5). Does NOT start a run: the session's NEXT prompt builds a transcript handoff from its claude/codex history and continues on a fresh Pi session — file, workspace, branch, title and UI history all stay. Automation-owned sessions may migrate to Pi but not to a non-Pi engine; sessions with an in-flight run are refused.",
        {
          sessionId: z
            .string()
            .describe("The opensession session id to migrate, e.g. 'bks-…'."),
          model: z
            .string()
            .describe(
              "Target pi model id: pi/<provider>/<model>, e.g. pi/anthropic/claude-sonnet-5.",
            ),
        },
        async (args: { sessionId: string; model: string }) => {
          // Belt-and-braces busy check through the live registry (the helper
          // re-checks via the run journal): a running/queued session's model
          // must not be flipped under its in-flight turn.
          try {
            const s = getSessionControl().getSession(args.sessionId);
            if (
              s &&
              (s.state === "running" || s.state === "waiting_question")
            ) {
              return text(
                `\`${args.sessionId}\` is ${s.state} — let the run finish (or cancel it) before migrating.`,
              );
            }
          } catch {}
          const res = await migrateSessionEngine(
            args.sessionId,
            args.model,
            ctx.createdBy,
          );
          if (!res.ok) return text(res.error);
          return text(
            `Migrated \`${res.sessionId}\` to ${res.to}` +
              (res.from ? ` (was ${res.from})` : "") +
              ". The next prompt hands its history to the Pi engine and continues there.",
          );
        },
      ),
    );
  }

  // Tasks — fire-and-forget child sessions (spawn / poll / cancel). Available
  // to the trusted user, and to self-improving automations (automationSelf):
  // there the spawn suite is the ONLY control surface — no answer/send/cancel/
  // create on arbitrary sessions — and children stay PR-gated + depth-guarded.
  if (ctx.isAdmin || ctx.automationSelf) {
    tools.push(
      tool(
        "spawn_task",
        "Delegate a self-contained task to a child session and return IMMEDIATELY with {taskId, url} — the lightweight alternative to create_session + send_to_session choreography when you just want work done and a handle to poll. The child is created through the same code path as create_session (it shares this session's worktree in code mode when repos match, inherits your user, is linked as a child, and is told to report back here); poll it with task_status and stop it with cancel_task. Mode defaults to 'code' (pass a branch, or isolatedWorktree true for a generated one, unless the child can share this session's code worktree); use 'ask' for read-only investigation. Loop guard: spawned children may delegate one further level, then spawn_task refuses (depth ≥ 2)." +
          (ctx.automationSelf
            ? " Children may edit code and open PRs but NEVER merge — a human reviews every PR."
            : " Not available from automation sessions."),
        {
          prompt: z
            .string()
            .describe(
              "Self-contained task prompt: scope, relevant files, constraints, acceptance criteria, and what to report.",
            ),
          repo: z
            .string()
            .optional()
            .describe("Registered repo id. Defaults to this session's repo."),
          branch: z
            .string()
            .optional()
            .describe(
              "Branch for code mode when the child can't share this session's worktree (standalone or different repo).",
            ),
          isolatedWorktree: z
            .boolean()
            .optional()
            .describe(
              "Code mode: give the child its own worktree and branch instead of sharing this session's worktree, keeping child/report-back linkage. Branch is generated from the prompt when omitted.",
            ),
          model: z
            .string()
            .optional()
            .describe(
              "Optional model id or unambiguous visible slug (e.g. 'gpt-5.6-sol', 'claude-opus-5', or 'glm-5.3').",
            ),
          mode: z
            .enum(["ask", "code", "scratch"])
            .optional()
            .describe(
              "'code' (default) can edit files / open PRs; 'ask' is read-only.",
            ),
          sandbox: z
            .union([
              z.boolean(),
              z.enum([
                "docker",
                "daytona",
                "e2b",
                "box",
                "modal",
                "microvm",
                "lambda-microvm",
              ]),
            ])
            .optional()
            .describe(
              "Run the child in an isolated sandbox: true = the server's default provider, or an explicit configured provider id.",
            ),
        },
        async (args: SpawnTaskArgs, extra: any) => {
          const res = await spawnTaskImpl(
            args,
            ctx,
            undefined,
            durableToolRequestId(ctx, "spawn_task", extra, args),
          );
          if (!res.ok) return text(res.error);
          return text(
            `Spawned task \`${res.taskId}\` — ${res.url}\nMetadata: createdBy=${JSON.stringify(res.createdBy)} · createdAt=${res.createdAt}. It runs in the background; poll with task_status(taskId)${ctx.isAdmin ? ", answer questions with answer_session_question," : ""} and stop with cancel_task.`,
          );
        },
      ),
      tool(
        "task_status",
        "Status of a spawned task (or any session id): running / waiting (blocked on a question) / done / error, plus the recent transcript tail, a diff stat when it changed code, and its PR when one exists.",
        {
          taskId: z
            .string()
            .describe("The task/session id returned by spawn_task."),
          transcript_lines: z
            .number()
            .optional()
            .describe("Trailing transcript entries to include (default 12)."),
        },
        async (args: { taskId: string; transcript_lines?: number }) =>
          text(await taskStatusImpl(args)),
      ),
      tool(
        "cancel_task",
        "Cancel a spawned task's in-flight run (drops queued messages too). Only runs this server owns.",
        {
          taskId: z
            .string()
            .describe("The task/session id returned by spawn_task."),
        },
        async (args: { taskId: string }, extra: any) =>
          text(
            await cancelTaskImpl(
              args,
              undefined,
              durableToolRequestId(ctx, "cancel_task", extra, args),
            ),
          ),
      ),
    );
  }

  return createSdkMcpServer({
    name: "opensession-sessions",
    version: "1.0.0",
    tools,
  });
}
