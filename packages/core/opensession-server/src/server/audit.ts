import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { stateDir } from "./paths";

// Structured audit log.
// One JSON line per event into a daily file under ~/.opensession-audit/.
// incident-agent ships stdout via Docker's awslogs driver; opensession runs as
// a systemd unit that hard-denies IMDS (opensession.service), so it can never
// hold AWS credentials itself — a separate amazon-cloudwatch-agent service
// tails these files into CloudWatch Logs instead (see deploy/README-audit.md).

const AUDIT_DIR = stateDir("audit");

// Match incident-agent's CloudWatch retention (400d) for the local files.
const RETENTION_DAYS = 400;

let initialized = false;

function ensureAuditDir(): void {
  if (initialized) return;
  initialized = true;
  mkdirSync(AUDIT_DIR, { recursive: true });
  pruneOldFiles();
}

function pruneOldFiles(): void {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const file of readdirSync(AUDIT_DIR)) {
      const m = file.match(/^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m) continue;
      if (new Date(`${m[1]}T00:00:00Z`).getTime() < cutoff) {
        unlinkSync(`${AUDIT_DIR}/${file}`);
      }
    }
  } catch (e) {
    console.error("[audit] prune failed:", e);
  }
}

/**
 * Emit one audit event as a JSON line. Never throws — audit failures must not
 * take down the run they're observing (they do land in journald via stderr).
 */
export function audit(event: Record<string, unknown>): void {
  try {
    // bun test shares this module with the live audit paths — keep fake-run /
    // FSM test events out of the real ~/.opensession-audit files (they feed
    // the digest and Dreaming). No test asserts on audit output today.
    if (process.env.NODE_ENV === "test") return;
    ensureAuditDir();
    const now = new Date();
    const line = JSON.stringify({
      time: now.toISOString(),
      service: "opensession",
      ...event,
    });
    appendFileSync(`${AUDIT_DIR}/audit-${now.toISOString().slice(0, 10)}.jsonl`, line + "\n");
  } catch (e) {
    console.error("[audit] write failed:", e);
  }
}

// Stored all-lowercase so the redactor's `.toLowerCase()` lookup catches
// camelCase and snake_case variants alike.
const SECRET_KEYS = new Set([
  "token",
  "apikey",
  "api_key",
  "password",
  "secret",
  "authorization",
  "auth",
  "bearer",
  "pat",
  "credential",
  "credentials",
]);

/** Scrub secret-shaped keys from a value before it lands in the audit log. */
export function redactArgs(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(redactArgs);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : redactArgs(v);
    }
    return out;
  }
  return value;
}

export function digest(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

export interface TextSummary {
  text_sha256: string;
  text_bytes: number;
  text_snippet: string;
}

/**
 * Bounded audit view of a potentially-large string: truncated snippet + byte
 * length + full sha256, so the log stays small but the exact body can still
 * be reconciled against the on-disk Claude session jsonl when needed.
 */
export function summarizeText(text: string | undefined, snippetBytes = 300): TextSummary {
  const s = text ?? "";
  return {
    text_sha256: createHash("sha256").update(s).digest("hex"),
    text_bytes: Buffer.byteLength(s, "utf8"),
    text_snippet: s.length > snippetBytes ? `${s.slice(0, snippetBytes)}…` : s,
  };
}

// ── Read side (the in-app audit viewer, Settings → Audit log) ──

/** Dates (YYYY-MM-DD, newest first) that have an audit file. */
export function listAuditDates(): string[] {
  ensureAuditDir();
  try {
    return readdirSync(AUDIT_DIR)
      .map((f) => f.match(/^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1])
      .filter((d): d is string => !!d)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** The per-turn streaming firehose — hidden by the viewer's default
 *  "significant only" filter so decisions/prompts/confirmations stand out. */
const NOISY_KINDS = new Set([
  "tool_use",
  "tool_result",
  "assistant_text",
  "assistant_thinking",
  "result",
]);

export interface AuditReadResult {
  /** Page of events, newest first. */
  events: Array<Record<string, unknown>>;
  /** Total matches for the filter (before offset/limit). */
  total: number;
  /** Distinct event types seen on this date (for the filter dropdown). */
  types: string[];
}

/** One event's display type: the runner events carry `kind`, the audited()
 *  wrapper and other emitters carry `msg`. */
function eventType(e: Record<string, unknown>): string {
  return String(e.kind || e.msg || "event");
}

export function readAuditEvents(opts: {
  date: string;
  /** Case-insensitive substring across the raw line. */
  q?: string;
  /** Exact event type (see eventType). */
  type?: string;
  /** Substring match on session_id (old events: bks_session_id). */
  session?: string;
  /** Drop the per-turn firehose kinds (default true). */
  significantOnly?: boolean;
  offset?: number;
  limit?: number;
}): AuditReadResult {
  ensureAuditDir();
  const path = `${AUDIT_DIR}/audit-${opts.date}.jsonl`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date) || !existsSync(path)) {
    return { events: [], total: 0, types: [] };
  }
  const q = (opts.q || "").toLowerCase();
  const significantOnly = opts.significantOnly !== false;
  const offset = Math.max(0, opts.offset || 0);
  const limit = Math.min(500, Math.max(1, opts.limit || 200));

  const types = new Set<string>();
  const matches: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const t = eventType(e);
    types.add(t);
    if (opts.type && t !== opts.type) continue;
    if (!opts.type && significantOnly && NOISY_KINDS.has(t)) continue;
    if (opts.session && !String(e.session_id || e.bks_session_id || "").includes(opts.session)) continue;
    if (q && !line.toLowerCase().includes(q)) continue;
    matches.push(e);
  }
  matches.reverse(); // newest first
  return {
    events: matches.slice(offset, offset + limit),
    total: matches.length,
    types: [...types].sort(),
  };
}

/** One day's audit log rolled up into a compact, LLM-consumable shape. Built
 *  for the nightly "Dreaming" reflection automation: the raw jsonl is 10-20MB
 *  (far past what the read tool can take), so it webfetches /api/audit/digest
 *  instead of shell-processing the log. The whole digest is 50-70KB, which the
 *  engine truncates as a large tool output — callers can pass `?section=` to
 *  fetch detail sections individually. Keep the field names stable — the
 *  automation prompt names them. */
export function buildAuditDigest(date: string): Record<string, unknown> | null {
  ensureAuditDir();
  const path = `${AUDIT_DIR}/audit-${date}.jsonl`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !existsSync(path)) return null;
  return buildAuditDigestFromLines(date, readFileSync(path, "utf-8"));
}

/** Pure digest builder used by focused mixed-format fixtures. */
export function buildAuditDigestFromLines(
  date: string,
  contents: string,
): Record<string, unknown> {
  interface SessionAgg {
    id: string;
    runKind: string;
    mode: string;
    models: Set<string>;
    firstPrompt: string;
    turns: number;
    errors: number;
    toolErrors: number;
    cancelled: number;
    permissionDecisions: number;
    durationMs: number;
    costUsd: number;
  }
  const sessions = new Map<string, SessionAgg>();
  const eventSessionId = (e: Record<string, unknown>): string =>
    String(
      e.session_id ||
        e.bks_session_id ||
        (e.msg === "pi_turn" ? e.session : "") ||
        "",
    );
  const sessionOf = (e: Record<string, unknown>): SessionAgg | null => {
    const id = eventSessionId(e);
    if (!id) return null;
    let s = sessions.get(id);
    if (!s) {
      s = {
        id,
        runKind: "?",
        mode: "?",
        models: new Set(),
        firstPrompt: "",
        turns: 0,
        errors: 0,
        toolErrors: 0,
        cancelled: 0,
        permissionDecisions: 0,
        durationMs: 0,
        costUsd: 0,
      };
      sessions.set(id, s);
    }
    // Session creation and queue events often arrive before runner metadata.
    // Keep the first useful identity rather than freezing those early blanks.
    if (s.runKind === "?" && e.run_kind) s.runKind = String(e.run_kind);
    if (s.mode === "?" && e.mode) s.mode = String(e.mode);
    if (e.model) s.models.add(String(e.model));
    return s;
  };

  // Group key for recurring failures: ids and counts vary per occurrence.
  const normalize = (msg: string) =>
    msg.replace(/[0-9a-f-]{12,}/gi, "*").replace(/\d+/g, "#").slice(0, 160);

  interface ErrGroup {
    count: number;
    runKinds: Set<string>;
    sample: string;
    sampleSession: string;
  }
  const errorGroups = new Map<string, ErrGroup>();
  const toolErrorGroups = new Map<string, ErrGroup & { tool: string }>();
  const toolNameById = new Map<string, string>();
  const toolCalls = new Map<string, number>();
  const models = new Map<string, number>();
  const accountSwitches = new Map<string, number>();
  const papercuts: Array<Record<string, unknown>> = [];
  // Turn verdicts (turn-outcome.ts). A silent-drop — an unattended turn that
  // ended without reaching anyone and without declaring the silence — used to
  // reach this digest by being mirrored into the papercut log, one row per
  // occurrence: 583 identical entries, 22% of the whole papercut store,
  // crowding out the friction someone actually noticed and wrote down. The
  // events were always here; the digest just never read them. Counting them is
  // both smaller and more actionable than the rows were.
  const verdicts = { reached: 0, declared: 0, silentDrop: 0 };
  const silentDropsByRunKind = new Map<string, number>();
  const oneshots = { total: 0, failed: 0 };
  let events = 0;
  let turns = 0;
  let errors = 0;
  let toolErrors = 0;
  let cancelled = 0;
  let permissionDecisions = 0;
  let engineRetries = 0;
  let costUsd = 0;

  const parsedEvents: Array<Record<string, unknown>> = [];
  for (const line of contents.split("\n")) {
    if (!line) continue;
    try {
      parsedEvents.push(JSON.parse(line));
    } catch {
      // A partially-written final line must not discard the rest of the day.
    }
  }

  interface PiLogicalTurn {
    attempts: Array<Record<string, unknown>>;
  }
  const piTurns = new Map<Record<string, unknown>, PiLogicalTurn>();
  const genericTerminalsToSkip = new Set<Record<string, unknown>>();
  const pendingPi = new Map<string, Array<Record<string, unknown>>>();
  const pendingGeneric = new Map<string, Array<Record<string, unknown>>>();

  // `pi_turn` is an attempt, not a person's turn: account retries and model
  // fallbacks each close one, and continuation/utility runs may use the same
  // shape. `session_turn_metric` is emitted once, after the outer runner walk
  // settles. Pair only session-bearing attempts with that terminal marker.
  // This excludes one-shots and lets mixed-format deployments prefer Pi's
  // logical terminal without also counting their mirrored generic terminal.
  for (const e of parsedEvents) {
    const id = eventSessionId(e);
    if (!id) continue;
    if (e.msg === "pi_turn" && e.direction === "out" && !e.kind) {
      const attempts = pendingPi.get(id) || [];
      attempts.push(e);
      pendingPi.set(id, attempts);
    }
    if ((e.kind === "result" || e.kind === "error") && pendingPi.has(id)) {
      const terminals = pendingGeneric.get(id) || [];
      terminals.push(e);
      pendingGeneric.set(id, terminals);
    }
    if (e.kind === "session_turn_metric") {
      const attempts = pendingPi.get(id) || [];
      const genericTerminals = pendingGeneric.get(id) || [];
      if (attempts.length) {
        piTurns.set(e, { attempts });
        for (const terminal of genericTerminals) genericTerminalsToSkip.add(terminal);
      }
      pendingPi.delete(id);
      pendingGeneric.delete(id);
    }
  }

  for (const e of parsedEvents) {
    events++;
    if (e.msg === "pi_oneshot") {
      oneshots.total++;
      if (e.status && e.status !== "ok") oneshots.failed++;
      continue;
    }
    if (e.msg === "pi_meridian_run" || e.msg === "pi_openai_run") {
      if (e.retry_attempt) engineRetries++;
      continue;
    }
    const s = sessionOf(e);
    const piTurn = piTurns.get(e);
    if (piTurn) {
      turns++;
      const failed = e.outcome === "failed";
      const cost = piTurn.attempts.reduce(
        (sum, attempt) => sum + (Number(attempt.total_cost_usd) || 0),
        0,
      );
      costUsd += cost;
      if (s) {
        s.turns++;
        s.durationMs += Number(e.duration_ms) || 0;
        s.costUsd += cost;
      }
      const terminalModel = [...piTurn.attempts].reverse().find((attempt) => attempt.model)?.model;
      if (terminalModel) {
        models.set(String(terminalModel), (models.get(String(terminalModel)) || 0) + 1);
      }
      if (failed) {
        errors++;
        if (s) s.errors++;
        const failedAttempt = [...piTurn.attempts]
          .reverse()
          .find((attempt) => attempt.ok === false || attempt.error);
        const raw = String(failedAttempt?.error || "Pi turn failed");
        const g = errorGroups.get(normalize(raw)) || {
          count: 0,
          runKinds: new Set<string>(),
          sample: raw.slice(0, 300),
          sampleSession: s?.id || "",
        };
        g.count++;
        g.runKinds.add(s?.runKind || "?");
        errorGroups.set(normalize(raw), g);
      }
      continue;
    }
    if (genericTerminalsToSkip.has(e)) continue;

    switch (String(e.kind || "")) {
      case "user_prompt":
        if (e.model) models.set(String(e.model), (models.get(String(e.model)) || 0) + 1);
        if (s && !s.firstPrompt) s.firstPrompt = String(e.text_snippet || "").slice(0, 200);
        break;
      case "result": {
        turns++;
        const cost = Number(e.total_cost_usd) || 0;
        costUsd += cost;
        if (s) {
          s.turns++;
          s.durationMs += Number(e.duration_ms) || 0;
          s.costUsd += cost;
        }
        break;
      }
      case "error": {
        errors++;
        if (s) s.errors++;
        const raw = String(e.error || "");
        const g = errorGroups.get(normalize(raw)) || {
          count: 0,
          runKinds: new Set<string>(),
          sample: raw.slice(0, 300),
          sampleSession: String(e.session_id || e.bks_session_id || ""),
        };
        g.count++;
        g.runKinds.add(String(e.run_kind || "?"));
        errorGroups.set(normalize(raw), g);
        break;
      }
      case "cancelled":
        cancelled++;
        if (s) s.cancelled++;
        break;
      case "tool_use":
        if (e.tool_use_id && e.tool_name) {
          toolNameById.set(String(e.tool_use_id), String(e.tool_name));
        }
        if (e.tool_name) {
          toolCalls.set(String(e.tool_name), (toolCalls.get(String(e.tool_name)) || 0) + 1);
        }
        break;
      case "tool_result": {
        if (e.is_error !== true) break;
        toolErrors++;
        if (s) s.toolErrors++;
        const tool = toolNameById.get(String(e.tool_use_id || "")) || "?";
        const snippet = String(e.text_snippet || "");
        const key = `${tool}: ${normalize(snippet)}`;
        const g = toolErrorGroups.get(key) || {
          tool,
          count: 0,
          runKinds: new Set<string>(),
          sample: snippet.slice(0, 300),
          sampleSession: String(e.session_id || e.bks_session_id || ""),
        };
        g.count++;
        g.runKinds.add(String(e.run_kind || "?"));
        toolErrorGroups.set(key, g);
        break;
      }
      case "permission_decision":
        permissionDecisions++;
        if (s) s.permissionDecisions++;
        break;
      case "account_switch": {
        const acc = String(e.account || "?");
        accountSwitches.set(acc, (accountSwitches.get(acc) || 0) + 1);
        break;
      }
      // Agent-logged friction (src/server/papercuts.ts) — surfaced verbatim so
      // the Dreaming automation can spot recurring papercuts across sessions.
      case "papercut":
        if (papercuts.length < 200) {
          papercuts.push({
            message: String(e.message || ""),
            repo: e.repo || undefined,
            runKind: e.run_kind || undefined,
            by: e.by || undefined,
            session: e.session_id || e.bks_session_id || undefined,
          });
        }
        break;
      case "turn_outcome": {
        const verdict = String(e.verdict || "");
        if (verdict === "reached") verdicts.reached++;
        else if (verdict === "declared") verdicts.declared++;
        else if (verdict === "silent-drop") {
          verdicts.silentDrop++;
          const kind = String(e.run_kind || "unknown");
          silentDropsByRunKind.set(kind, (silentDropsByRunKind.get(kind) || 0) + 1);
        }
        break;
      }
    }
  }

  const byRunKind: Record<
    string,
    { sessions: number; turns: number; errors: number; toolErrors: number; costUsd: number }
  > = {};
  for (const s of sessions.values()) {
    const k = (byRunKind[s.runKind] ||= { sessions: 0, turns: 0, errors: 0, toolErrors: 0, costUsd: 0 });
    k.sessions++;
    k.turns += s.turns;
    k.errors += s.errors;
    k.toolErrors += s.toolErrors;
    k.costUsd = +(k.costUsd + s.costUsd).toFixed(2);
  }
  // Most troubled sessions first; quiet ones fall off the capped list.
  const topSessions = [...sessions.values()]
    .sort((a, b) => b.errors + b.toolErrors - (a.errors + a.toolErrors) || b.turns - a.turns)
    .slice(0, 60)
    .map((s) => ({
      id: s.id,
      runKind: s.runKind,
      mode: s.mode,
      models: [...s.models],
      firstPrompt: s.firstPrompt,
      turns: s.turns,
      errors: s.errors,
      toolErrors: s.toolErrors,
      cancelled: s.cancelled,
      permissionDecisions: s.permissionDecisions,
      durationMs: s.durationMs,
      costUsd: +s.costUsd.toFixed(2),
    }));
  const topGroups = <T extends ErrGroup>(m: Map<string, T>) =>
    [...m.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 20)
      .map((g) => ({ ...g, runKinds: [...g.runKinds] }));

  return {
    date,
    totals: {
      events,
      sessions: sessions.size,
      turns,
      errors,
      toolErrors,
      cancelled,
      permissionDecisions,
      engineRetries,
      papercuts: papercuts.length,
      silentDrops: verdicts.silentDrop,
      costUsd: +costUsd.toFixed(2),
    },
    // One explanation, not one per occurrence — the whole reason these stopped
    // being papercuts.
    turnVerdicts: {
      ...verdicts,
      silentDropsByRunKind: Object.fromEntries(
        [...silentDropsByRunKind.entries()].sort((a, b) => b[1] - a[1]),
      ),
      // Inlined rather than imported from turn-outcome.ts: that module already
      // imports audit(), so reading its copy back would close an import cycle.
      ...(verdicts.silentDrop
        ? {
            silentDropMeaning:
              "An unattended run ended without reaching anyone — no note, message, report " +
              "or question — and without calling finish_silently to say the quiet ending was " +
              "deliberate. Either it stopped early, or it should have declared the silence.",
          }
        : {}),
    },
    byRunKind,
    models: Object.fromEntries(models),
    errorGroups: topGroups(errorGroups),
    toolErrorGroups: topGroups(toolErrorGroups),
    topTools: [...toolCalls.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([tool, count]) => ({ tool, count })),
    oneshots,
    accountSwitches: Object.fromEntries(accountSwitches),
    papercuts,
    sessions: topSessions,
    sessionsTruncated: Math.max(0, sessions.size - topSessions.length),
  };
}

/**
 * Wraps a side-effecting call with start/end audit events: redacted args on
 * both, result fingerprint + duration on completion. Results are only
 * digested, never logged verbatim (data minimization).
 */
export async function audited<T>(
  ctx: { context: string; action: string; args?: unknown },
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  const base = {
    context: ctx.context,
    action: ctx.action,
    args_digest: digest(ctx.args),
    args_redacted: redactArgs(ctx.args),
  };

  audit({ ...base, msg: "action_start" });
  try {
    const result = await fn();
    audit({
      ...base,
      msg: "action_end",
      ok: true,
      result_digest: digest(result),
      duration_ms: Date.now() - start,
    });
    return result;
  } catch (err) {
    audit({
      ...base,
      msg: "action_end",
      ok: false,
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
