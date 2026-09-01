/**
 * handoff-evidence — what a worker session actually DID, computed by the
 * server instead of summarized by the worker.
 *
 * A spawned child reports back to its parent as prose (sessions-tools.ts
 * buildChildSessionPrompt). Prose is the right carrier for judgement — did this
 * meet the bar, what am I unsure about — and the wrong carrier for facts: a
 * day of work flattens into a paragraph, and the first thing a summary drops is
 * what was TRIED AND FAILED, which is usually the most expensive thing the
 * worker learned. Meanwhile the server already knows the facts: the diff, the
 * PR, the tool calls, the failures, the usage.
 *
 * So: the facts are attached mechanically (send_to_session appends this block
 * when a child reports to its parent; task_status renders it on demand), and
 * the worker's prompt asks it for judgement and dead ends instead of a file
 * list it would only be paraphrasing.
 *
 * Honesty about what we can know: `isError` is reliable for tool-level failures
 * (a failed edit, a tool that threw) on every engine, but a bash command that
 * exits non-zero does NOT set it on the pi engine — the output comes back
 * as an ordinary result. So this block reports "failures the tool reported" and
 * a bare list of commands run; it never claims a command passed. Inferring
 * failure from the word "error" in output would mislabel every successful
 * grep for "error" as a failure, which is worse than staying quiet.
 */

import type { TranscriptEntry, UnifiedSession } from "./types";

export interface EvidenceFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface EvidenceFailure {
  /** Tool that reported it, e.g. "edit", "bash". */
  tool: string;
  /** What it was doing: the command, the file path. */
  what: string;
  /** The error text, head + tail. Compilers and test runners put the verdict
   *  at the end; permission/usage errors put it at the start and then dump
   *  config. Keeping both ends beats guessing which shape this one is. */
  errorTail: string;
  /** The same call was later retried and did not error. */
  laterPassed: boolean;
}

export interface HandoffEvidence {
  sessionId: string;
  state: "running" | "waiting" | "done" | "error";
  lastRunError?: string;
  branch?: string;
  pr?: { url: string; state?: string };
  diff?: {
    files: EvidenceFile[];
    totalAdditions: number;
    totalDeletions: number;
    /** Worktree is shared with the parent session — the diff includes the
     *  parent's own uncommitted edits and is NOT "what the worker changed". */
    shared: boolean;
    /** Files beyond the cap. */
    more: number;
  };
  failures: EvidenceFailure[];
  /** Distinct command heads the worker ran (no pass/fail claim). */
  commands: string[];
  usage?: { turns: number; costUsd?: number };
}

export interface EvidenceDeps {
  getSession: (id: string) => UnifiedSession | null | undefined;
  transcript: (session: UnifiedSession) => Promise<TranscriptEntry[]>;
  diff: (
    session: UnifiedSession,
    worktreeDir: string,
    baseBranch: string,
  ) => Promise<{
    files: EvidenceFile[];
    totalAdditions: number;
    totalDeletions: number;
  }>;
  defaultBranch: (repo?: string) => string;
  isSharedCheckout: (path: string) => boolean;
  exists: (path: string) => boolean;
}

const MAX_FILES = 20;
const MAX_FAILURES = 5;
const MAX_COMMANDS = 12;
const ERROR_HEAD = 200;
const ERROR_TAIL = 400;

/** Keep both ends of an error: the first line usually says WHAT failed, the
 *  last usually says the verdict. The middle is where the noise lives. */
export function clipError(body: string): string {
  const s = body.replace(/\s+/g, " ").trim();
  if (s.length <= ERROR_HEAD + ERROR_TAIL) return s;
  return `${s.slice(0, ERROR_HEAD)} … ${s.slice(-ERROR_TAIL)}`;
}

async function defaultDeps(): Promise<EvidenceDeps> {
  const [
    { findSession },
    { mergedSessionTranscriptAsync },
    gitDiff,
    worktree,
    { sessionTouchedPaths },
    fs,
  ] = await Promise.all([
    import("./session-cache"),
    import("./sessions"),
    import("./git-diff"),
    import("./worktree"),
    import("./session-touched"),
    import("fs"),
  ]);
  return {
    getSession: (id) => findSession(id),
    transcript: (session) => mergedSessionTranscriptAsync(session),
    diff: async (session, dir, base) => {
      const ownPaths = worktree.isSharedCheckoutDir(dir)
        ? await sessionTouchedPaths(session, dir)
        : undefined;
      const d = await gitDiff.getSessionDiff(
        dir,
        base,
        undefined,
        false,
        undefined,
        ownPaths,
      );
      return {
        files: d.files.map((f) => ({
          path: f.path,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
        })),
        totalAdditions: d.totalAdditions,
        totalDeletions: d.totalDeletions,
      };
    },
    defaultBranch: (repo) => {
      try {
        return worktree.getRepo(repo as string).defaultBranch;
      } catch {
        return "main";
      }
    },
    isSharedCheckout: (path) => worktree.isSharedCheckoutDir(path),
    exists: (p) => fs.existsSync(p),
  };
}

/** The bit of a command worth listing: drop `cd … &&` preambles and keep the
 *  program plus its first argument, so 40 greps collapse to "grep". */
export function commandHead(cmd: string): string {
  let c = cmd.replace(/\s+/g, " ").trim();
  c = c.replace(/^(cd\s+\S+\s*&&\s*)+/i, "");
  c = c.split(/\s*(?:\||;|&&)\s*/)[0] || c;
  const parts = c.split(" ").filter(Boolean);
  if (!parts.length) return "";
  const head = parts.slice(0, 2).join(" ");
  return head.slice(0, 60);
}

/** What a tool call was doing, for the failure list. */
function callSubject(e: TranscriptEntry | undefined): string {
  const input = e?.toolInput as Record<string, unknown> | undefined;
  if (input && typeof input === "object") {
    for (const key of [
      "command",
      "filePath",
      "file_path",
      "path",
      "pattern",
      "url",
    ]) {
      const v = input[key];
      if (typeof v === "string" && v.trim())
        return v.replace(/\s+/g, " ").slice(0, 200);
    }
  }
  return (e?.content || "").replace(/\s+/g, " ").slice(0, 120);
}

/** Failures the tools themselves reported, plus the commands that were run.
 *  Exported for tests. */
export function evidenceFromTranscript(entries: TranscriptEntry[]): {
  failures: EvidenceFailure[];
  commands: string[];
} {
  const calls = new Map<string, TranscriptEntry>();
  for (const e of entries) {
    if (e.type === "tool_use") calls.set(e.toolUseId || e.id, e);
  }
  const commands: string[] = [];
  const seenCmd = new Set<string>();
  for (const e of entries) {
    if (e.type !== "tool_use" || !/^bash$/i.test(e.toolName || "")) continue;
    const cmd = (e.toolInput as { command?: string } | undefined)?.command;
    if (typeof cmd !== "string") continue;
    const head = commandHead(cmd);
    if (!head || seenCmd.has(head)) continue;
    seenCmd.add(head);
    commands.push(head);
  }

  const raw: (EvidenceFailure & { subject: string })[] = [];
  const laterOk = new Set<string>();
  for (const e of entries) {
    if (e.type !== "tool_result") continue;
    const call = calls.get(e.toolUseId || "");
    const subject = callSubject(call);
    const tool = call?.toolName || e.toolName || "tool";
    if (!e.isError) {
      if (subject) laterOk.add(`${tool}::${subject}`);
      continue;
    }
    raw.push({
      tool,
      what: subject,
      errorTail: clipError(e.content || ""),
      laterPassed: false,
      subject,
    });
  }
  // Dedup identical repeated failures, newest first, and mark the ones that a
  // later attempt got past — the dead end still gets recorded, honestly.
  const byKey = new Map<string, EvidenceFailure>();
  for (const f of raw.reverse()) {
    const key = `${f.tool}::${f.subject}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      tool: f.tool,
      what: f.what,
      errorTail: f.errorTail,
      laterPassed: laterOk.has(key),
    });
  }
  return {
    failures: [...byKey.values()].slice(0, MAX_FAILURES),
    commands: commands.slice(0, MAX_COMMANDS),
  };
}

export function evidenceState(session: {
  isRunning?: boolean;
  lastRunError?: unknown;
  pendingQuestion?: unknown;
}): HandoffEvidence["state"] {
  if (session.pendingQuestion) return "waiting";
  if (session.isRunning) return "running";
  return session.lastRunError ? "error" : "done";
}

/**
 * Gather the facts about a session's work. Returns null when the session is
 * unknown; never throws (a handoff must not fail because a git call did).
 */
export async function collectHandoffEvidence(
  sessionId: string,
  deps?: EvidenceDeps,
): Promise<HandoffEvidence | null> {
  const d = deps ?? (await defaultDeps());
  const session = d.getSession(sessionId);
  if (!session) return null;

  const ev: HandoffEvidence = {
    sessionId: session.id,
    state: evidenceState(session as never),
    failures: [],
    commands: [],
  };
  if (session.lastRunError?.message)
    ev.lastRunError = session.lastRunError.message;
  if (session.branch) ev.branch = session.branch;
  if (session.prUrl) ev.pr = { url: session.prUrl, state: session.prState };
  if (session.usage?.turns)
    ev.usage = { turns: session.usage.turns, costUsd: session.usage.costUsd };

  // Diff — host worktrees only (a volume-mode sandbox has no host dir; don't
  // wake its container for a status read).
  if (
    session.mode === "code" &&
    session.worktreeDir &&
    d.exists(session.worktreeDir)
  ) {
    try {
      const parent = session.parentSessionId
        ? d.getSession(session.parentSessionId)
        : null;
      const shared =
        d.isSharedCheckout(session.worktreeDir) ||
        Boolean(
          parent?.worktreeDir && parent.worktreeDir === session.worktreeDir,
        );
      const diff = await d.diff(
        session,
        session.worktreeDir,
        d.defaultBranch(session.repo),
      );
      if (diff.files.length) {
        ev.diff = {
          files: diff.files.slice(0, MAX_FILES),
          totalAdditions: diff.totalAdditions,
          totalDeletions: diff.totalDeletions,
          shared,
          more: Math.max(0, diff.files.length - MAX_FILES),
        };
      }
    } catch {}
  }

  try {
    const entries = await d.transcript(session);
    const { failures, commands } = evidenceFromTranscript(entries);
    ev.failures = failures;
    ev.commands = commands;
  } catch {}

  return ev;
}

/**
 * Render the evidence for a model. Per-section caps rather than one global
 * truncation, so the last section can't be swallowed whole; the whole block is
 * meant to cost a parent ~15 lines of context.
 */
export function formatHandoffEvidence(
  ev: HandoffEvidence,
  opts: { title?: string } = {},
): string {
  const lines: string[] = [
    opts.title ??
      `— evidence for \`${ev.sessionId}\` (computed by the server, not written by the worker) —`,
  ];
  const meta = [`state: ${ev.state}`];
  if (ev.branch) meta.push(`branch ${ev.branch}`);
  if (ev.usage) meta.push(`${ev.usage.turns} turn(s)`);
  lines.push(meta.join(" · "));
  if (ev.lastRunError)
    lines.push(`run error: ${ev.lastRunError.slice(0, 300)}`);
  if (ev.pr)
    lines.push(`PR: ${ev.pr.state ? `${ev.pr.state} ` : ""}${ev.pr.url}`);

  if (ev.diff) {
    const label = ev.diff.shared
      ? "workspace diff (worktree SHARED with the parent — includes the parent's own edits)"
      : "files changed";
    lines.push(
      `${label}: ${ev.diff.files.length + ev.diff.more} file(s), +${ev.diff.totalAdditions}/-${ev.diff.totalDeletions}`,
    );
    for (const f of ev.diff.files)
      lines.push(
        `  ${f.status.slice(0, 1).toUpperCase()} ${f.path} (+${f.additions}/-${f.deletions})`,
      );
    if (ev.diff.more) lines.push(`  … +${ev.diff.more} more`);
  }

  if (ev.failures.length) {
    lines.push(`failures the tools reported (${ev.failures.length}):`);
    for (const f of ev.failures) {
      lines.push(
        `  ✗ ${f.tool}: ${f.what}${f.laterPassed ? "  [a later attempt got past this]" : ""}`,
      );
      if (f.errorTail) lines.push(`    ${f.errorTail}`);
    }
  }

  if (ev.commands.length) {
    lines.push(`commands run: ${ev.commands.join(", ")}`);
    lines.push(
      "(non-zero shell exits are not flagged by every engine — treat 'commands run' as executed, not as passed.)",
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Failure beacon
//
// A worker reports back by calling send_to_session. A worker whose run DIED
// can't call anything — and its parent is usually idle (spawn_task returns
// immediately and the parent's turn ends), so nothing polls either. That's the
// one genuinely unrecoverable state: the parent waits forever for a report
// that will never come. So on a terminal run failure the server itself tells
// the parent, once.
//
// Deliberately narrow: failures only. Auto-delivering evidence on SUCCESS
// would double-report alongside the worker's own message.
// ---------------------------------------------------------------------------

/** A worker that already reported this recently doesn't need the server
 *  repeating it. */
const REPORT_GRACE_MS = 2 * 60_000;
/** Ceiling on beacons per worker, so a session that fails in a loop (or an
 *  auto-continue nudge that re-fails) can't spam its parent. */
const BEACON_THROTTLE_MS = 10 * 60_000;

export interface BeaconDeps {
  readSessionFile: (id: string) => Record<string, unknown> | null;
  stamp: (id: string, at: string) => void | Promise<void>;
  deliver: (
    parentId: string,
    content: string,
    deliveryId: string,
  ) => Promise<unknown>;
  evidence: (id: string) => Promise<HandoffEvidence | null>;
  now?: () => number;
}

async function defaultBeaconDeps(): Promise<BeaconDeps> {
  const [
    { OPENSESSION_SESSIONS_DIR },
    { getSessionControl },
    { touchNativeSessionStrict },
    fs,
  ] = await Promise.all([
    import("./paths"),
    import("./session-control"),
    import("./session-cache"),
    import("fs"),
  ]);
  return {
    readSessionFile: (id) => {
      try {
        const p = `${OPENSESSION_SESSIONS_DIR}/${id}.json`;
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, "utf-8"));
      } catch {
        return null;
      }
    },
    stamp: (id, at) => touchNativeSessionStrict(id, { parentNotifiedAt: at }),
    deliver: (parentId, content, deliveryId) =>
      // No user means the server is speaking, not a person or worker.
      getSessionControl().deliverToSession(parentId, content, undefined, {
        deliveryId,
      }),
    evidence: (id) => collectHandoffEvidence(id),
  };
}

export type BeaconOutcome =
  | "sent"
  | "no-parent"
  | "already-reported"
  | "throttled"
  | "failed";

/**
 * Tell a worker's parent that a run died here. Fire-and-forget from
 * recordRunOutcome; never throws.
 */
export async function notifyParentOfFailedRun(
  sessionId: string,
  errorMessage: string,
  deps?: BeaconDeps,
  projectionId?: string,
): Promise<BeaconOutcome> {
  try {
    const d = deps ?? (await defaultBeaconDeps());
    const now = d.now?.() ?? Date.now();
    const file = d.readSessionFile(sessionId);
    const parentId =
      typeof file?.parentSessionId === "string" ? file.parentSessionId : "";
    if (!file || !parentId || file.reportBack !== true) return "no-parent";

    const since = (v: unknown) => {
      const t = typeof v === "string" ? Date.parse(v) : NaN;
      return Number.isFinite(t) ? now - t : Infinity;
    };
    if (since(file.lastReportToParentAt) < REPORT_GRACE_MS)
      return "already-reported";
    if (since(file.parentNotifiedAt) < BEACON_THROTTLE_MS) return "throttled";

    let block = "";
    // Actor projections retry one permanent destination identity. Keep that
    // destination's payload immutable across a crash after delivery: live Git,
    // transcript, and tool evidence can change before the retry. Compatibility
    // beacons without a projection fence retain the richer current evidence.
    if (!projectionId) {
      try {
        const ev = await d.evidence(sessionId);
        if (ev) block = `\n\n${formatHandoffEvidence(ev)}`;
      } catch {}
    }
    const content =
      `<!--os:worker-report:${sessionId}-->\n` +
      `Worker task \`${sessionId}\` ended in error without reporting back.\n` +
      `error: ${String(errorMessage).slice(0, 300)}\n` +
      `Inspect with task_status("${sessionId}"), or resume it with send_to_session.` +
      block;

    await d.deliver(
      parentId,
      content,
      projectionId
        ? `worker-failure:${sessionId}:${projectionId}`
        : `worker-failure:${sessionId}`,
    );
    await d.stamp(sessionId, new Date(now).toISOString());
    return "sent";
  } catch {
    return "failed";
  }
}
