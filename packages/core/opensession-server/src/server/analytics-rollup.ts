/**
 * Audit-day rollups for Analytics and Home: one pass over a day's audit log
 * (audit-YYYY-MM-DD.jsonl) into a compact per-day summary.
 *
 * Pure. The cached file I/O lives in the analytics read worker
 * (audit-read-worker.ts): a day's file reaches 100 MB, and reading or
 * parsing it on the gateway thread blocked every request behind it. Do not
 * import server modules here; the worker loads this file on its own.
 */

// Bump when the rollup shape changes — stale disk caches recompute.
export const ROLLUP_VERSION = 10;
/** When Pi became the only engine; usage before it comes from audit rows. */
export const PI_USAGE_CUTOVER_MS = Date.parse("2026-08-19T13:35:30Z");

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelAgg extends TokenTotals {
  turns: number;
  costUsd: number;
  /** Turns that reported a price. Models billed against a subscription pool
   *  (the OpenAI accounts) report 0 per turn, so cost without this count
   *  reads as "cheap" when it means "not billed by token". */
  costedTurns: number;
}

export interface SessionAgg {
  kind: string;
  turns: number;
  output: number;
  /** input + output + cache read + cache write. */
  tokens: number;
  costUsd: number;
  errors: number;
}

/** Per-day PR-review telemetry from `review_*` audit events. `completed`
 *  (verdict/confidence/findings) only exists from 2026-07-28 on — earlier
 *  days legitimately roll up to zeros. */
export interface ReviewDayAgg {
  completed: number;
  updates: number;
  verdicts: Record<string, number>;
  confidenceSum: number;
  confidenceN: number;
  findings: number;
  blocking: number;
  withheld: number;
  missedBugs: number;
  repliesPositive: number;
  repliesDismissive: number;
}

export function emptyReviewAgg(): ReviewDayAgg {
  return {
    completed: 0,
    updates: 0,
    verdicts: {},
    confidenceSum: 0,
    confidenceN: 0,
    findings: 0,
    blocking: 0,
    withheld: 0,
    missedBugs: 0,
    repliesPositive: 0,
    repliesDismissive: 0,
  };
}

export interface DayRollup {
  date: string;
  turns: number;
  errors: number;
  cancelled: number;
  durationMs: number;
  oneshots: number;
  tokens: TokenTotals;
  costUsd: number;
  costedTurns: number;
  /** Turns recorded before per-step usage accounting landed (2026-08-14),
   *  whose result event carries only the turn's LAST model request. They
   *  undercount tokens and cost by the number of steps in the turn, measured
   *  at ~7x. Their events have no `steps` field, which is how we tell. */
  legacyUsageTurns: number;
  byModel: Record<string, ModelAgg>;
  /** Turns whose audit events carried no model (pre-2026-07-09 SDK-runner
   *  days), keyed by session id — resolved against the session store's
   *  `model` at compose time. */
  unknownModel: Record<string, ModelAgg>;
  bySession: Record<string, SessionAgg>;
  review: ReviewDayAgg;
}

/** Strip an engine and upstream-provider prefix for aggregation. */
export function shortModel(model: string): string {
  return (
    model.replace(/^(?:pi|claude|codex|opencode)\/[^/]+\//, "") || "unknown"
  );
}

export function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function emptyModelAgg(): ModelAgg {
  return { turns: 0, costUsd: 0, costedTurns: 0, ...emptyTokens() };
}

export function rollupAuditContents(date: string, contents: string): DayRollup {
  const rollup: DayRollup = {
    date,
    turns: 0,
    errors: 0,
    cancelled: 0,
    durationMs: 0,
    oneshots: 0,
    tokens: emptyTokens(),
    costUsd: 0,
    costedTurns: 0,
    legacyUsageTurns: 0,
    byModel: {},
    unknownModel: {},
    bySession: {},
    review: emptyReviewAgg(),
  };
  const promptModel = new Map<string, string>();
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
    return (rollup.bySession[id] ||= {
      // A restart-reattached turn is still its base kind for analytics.
      kind: String(e.run_kind || "?").replace(/-reattach$/, ""),
      turns: 0,
      output: 0,
      tokens: 0,
      costUsd: 0,
      errors: 0,
    });
  };

  const events: Record<string, unknown>[] = [];
  for (const line of contents.split("\n")) {
    if (!line) continue;
    const relevant =
      line.includes('"kind":"result"') ||
      line.includes('"kind":"user_prompt"') ||
      line.includes('"kind":"error"') ||
      line.includes('"kind":"cancelled"') ||
      line.includes('"kind":"session_turn_metric"') ||
      line.includes('"msg":"pi_turn"') ||
      line.includes('"msg":"pi_oneshot"') ||
      line.includes('"msg":"opencode_oneshot"') ||
      line.includes('"msg":"opencode_meridian_run"') ||
      line.includes('"msg":"opencode_openai_run"') ||
      line.includes('"msg":"review_');
    if (!relevant) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }

  // Before the Pi-only cutover, the outer runner mirrored a generic terminal
  // beside Pi's own attempt event. Pair attempts with the one logical turn
  // metric and suppress those mirrors so mixed-format days do not double count.
  const pendingPi = new Map<string, Record<string, unknown>[]>();
  const pendingGeneric = new Map<string, Record<string, unknown>[]>();
  const piLogicalMetrics = new Map<
    Record<string, unknown>,
    Record<string, unknown>[]
  >();
  const genericTerminalsToSkip = new Set<Record<string, unknown>>();
  for (const e of events) {
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
      if (attempts.length) {
        piLogicalMetrics.set(e, attempts);
        for (const terminal of pendingGeneric.get(id) || [])
          genericTerminalsToSkip.add(terminal);
      }
      pendingPi.delete(id);
      pendingGeneric.delete(id);
    }
  }

  const addUsage = (e: Record<string, unknown>, countAsTurn: boolean) => {
    const input = Number(e.input_tokens) || 0;
    const output = Number(e.output_tokens) || 0;
    const cacheRead = Number(e.cache_read_input_tokens) || 0;
    const cacheWrite = Number(e.cache_creation_input_tokens) || 0;
    const cost = Number(e.total_cost_usd) || 0;
    rollup.tokens.input += input;
    rollup.tokens.output += output;
    rollup.tokens.cacheRead += cacheRead;
    rollup.tokens.cacheWrite += cacheWrite;
    rollup.costUsd += cost;
    if (cost > 0) rollup.costedTurns++;
    const model = e.model
      ? shortModel(String(e.model))
      : promptModel.get(eventSessionId(e)) || "";
    const m = model
      ? (rollup.byModel[model] ||= emptyModelAgg())
      : (rollup.unknownModel[eventSessionId(e)] ||= emptyModelAgg());
    if (countAsTurn) m.turns++;
    m.input += input;
    m.output += output;
    m.cacheRead += cacheRead;
    m.cacheWrite += cacheWrite;
    m.costUsd += cost;
    if (cost > 0) m.costedTurns++;
    const s = sessionOf(e);
    if (s) {
      s.output += output;
      s.tokens += input + output + cacheRead + cacheWrite;
      s.costUsd += cost;
    }
  };

  for (const e of events) {
    const isReviewEvt = String(e.msg || "").startsWith("review_");
    if (isReviewEvt) {
      const rv = rollup.review;
      switch (String(e.msg || "")) {
        case "review_completed": {
          rv.completed++;
          if (e.is_update) rv.updates++;
          const verdict = String(e.verdict || "");
          if (verdict) rv.verdicts[verdict] = (rv.verdicts[verdict] || 0) + 1;
          if (typeof e.confidence === "number") {
            rv.confidenceSum += e.confidence;
            rv.confidenceN++;
          }
          rv.findings += Number(e.findings) || 0;
          rv.blocking += Number(e.blocking) || 0;
          break;
        }
        case "review_findings_withheld":
          rv.withheld += Number(e.withheld) || 0;
          break;
        case "review_missed_bug":
          rv.missedBugs++;
          break;
        case "review_reply_signal":
          rv.repliesPositive += Number(e.positive) || 0;
          rv.repliesDismissive += Number(e.dismissive) || 0;
          break;
      }
      continue;
    }
    if (e.msg === "pi_oneshot" || e.msg === "opencode_oneshot") {
      rollup.oneshots++;
      continue;
    }
    if (
      (e.msg === "opencode_meridian_run" || e.msg === "opencode_openai_run") &&
      e.phase === "end"
    ) {
      rollup.durationMs += Number(e.duration_ms) || 0;
      continue;
    }
    if (e.msg === "pi_turn" && e.direction === "out") {
      // Every Pi attempt owns its model usage, including retries and utility
      // calls. Only session_turn_metric below owns logical turn activity.
      if (
        e.input_tokens !== undefined ||
        e.output_tokens !== undefined ||
        e.cache_read_input_tokens !== undefined ||
        e.cache_creation_input_tokens !== undefined
      )
        addUsage(e, true);
      if (e.status === "cancelled") rollup.cancelled++;
      continue;
    }
    const attempts = piLogicalMetrics.get(e);
    const metricTime =
      e.kind === "session_turn_metric" ? Date.parse(String(e.time || "")) : 0;
    if (attempts || metricTime >= PI_USAGE_CUTOVER_MS) {
      rollup.turns++;
      rollup.durationMs += Number(e.duration_ms) || 0;
      const terminalAttempt = attempts?.[attempts.length - 1] || e;
      const s = sessionOf(terminalAttempt);
      if (s) {
        s.turns++;
        if (e.outcome === "failed") s.errors++;
      }
      if (e.outcome === "failed") rollup.errors++;
      continue;
    }
    if (genericTerminalsToSkip.has(e)) continue;
    const s = sessionOf(e);
    switch (String(e.kind || "")) {
      // Some engines' result events carry no model — remember the turn's
      // model from its user_prompt so those turns don't land in "unknown".
      case "user_prompt":
        if (e.model && (e.session_id || e.bks_session_id)) {
          promptModel.set(
            String(e.session_id || e.bks_session_id),
            shortModel(String(e.model)),
          );
        }
        break;
      case "result":
        rollup.turns++;
        if (e.steps === undefined) rollup.legacyUsageTurns++;
        addUsage(e, true);
        if (s) s.turns++;
        break;
      case "error":
        rollup.errors++;
        if (s) s.errors++;
        break;
      case "cancelled":
        rollup.cancelled++;
        break;
    }
  }
  return rollup;
}
