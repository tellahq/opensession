/**
 * Turn outcomes for unattended runs — did this run actually reach anybody?
 *
 * An unattended run (automation, Plain triage, a github behavior) exists to
 * produce an outward effect: a note on the ticket, a message in a channel, a
 * published report, a question to a teammate. When one ends without producing
 * any of those, two very different things look identical from the outside:
 *
 *   1. the run correctly decided there was nothing to say, or
 *   2. the run lost the thread and stopped early.
 *
 * (2) is real and has bitten us: Plain triage would spawn a background
 * sub-agent, end its turn on "ok", and post no note — indistinguishable from a
 * quiet day on the support inbox until someone opened the thread.
 *
 * The fix, borrowed from qm's harness: make silence something a run has to
 * *declare*. `finish_silently` (background fires) and `stay_silent` (asked
 * directly, chose not to answer) are no-op tools whose only job is to record
 * the decision and its reason — see src/agents/slack/turn-tools.ts. This
 * module holds the ledger they write into, and the verdict computed when the
 * run ends:
 *
 *   reached      — an outward-effect tool was called. Nothing to check.
 *   declared     — no effect, but the run said so, with a reason. Fine.
 *   silent-drop  — no effect and no declaration. Logged as a papercut so it
 *                  shows up in Settings → Papercuts and the nightly digest.
 *
 * A silent-drop is a signal, not an error: it never fails a run, and the
 * remedy is usually that the model should have called `finish_silently`.
 * Treating it as advisory is deliberate — a noisy false positive costs one
 * papercut line, while a hard failure on a legitimately quiet run would push
 * people to turn the check off.
 *
 * Ledger state is per-run and in-process (a run's own lifetime), so it is
 * deliberately NOT parked on globalThis: a hot reload mid-run drops the
 * ledger, and a dropped ledger just means no verdict for that run.
 */

import { audit } from "./audit";

export type TurnVerdict = "reached" | "declared" | "silent-drop";

export type SilenceTool = "finish_silently" | "stay_silent";

export interface TurnDeclaration {
  tool: SilenceTool;
  reason?: string;
}

export interface TurnOutcome {
  verdict: TurnVerdict;
  /** Outward-effect tool calls observed, in call order (deduped by name). */
  effects: string[];
  declaration?: TurnDeclaration;
}

/**
 * Tool calls that count as "this run reached somebody outside itself",
 * keyed the way runs name them (`mcp__<server>__<tool>`) plus the bare
 * pi form (`<server>_<tool>`) that the engine's tool_use events carry.
 *
 * Deliberately a short, explicit list rather than a heuristic over tool names:
 * a wrong entry here either hides a real silent drop (missing effect → false
 * alarm) or masks one (a read tool counted as an effect). Both are worse than
 * a list someone has to extend on purpose. Add a tool when its call is, by
 * itself, a thing a human will see.
 */
const REACH_TOOLS = [
  // Plain — the support inbox. `create_note` is the triage deliverable.
  "mcp__plain__create_note",
  "mcp__plain__reply_to_thread",
  // Slack — a message in a channel or DM.
  "mcp__slack__conversations_add_message",
  // Linear — a comment or a new issue on the team's board.
  "mcp__linear__create_comment",
  "mcp__linear__create_issue",
  // Gmail — outbound mail (a draft is not delivery; sending is).
  "mcp__gmail__send_email",
  // Our own in-process servers: a published report, and asking a teammate.
  "mcp__opensession-report__publish_report",
  "mcp__opensession-humans__ask_human",
] as const;

/** Every spelling of a reach tool an engine might report, lowercased. */
const REACH_TOOL_IDS: ReadonlySet<string> = new Set(
  REACH_TOOLS.flatMap((name) => {
    const m = name.match(/^mcp__(.+?)__(.+)$/);
    return m ? [name, `${m[1]}_${m[2]}`] : [name];
  }).map((id) => id.toLowerCase())
);

export function isReachTool(toolName: string | undefined): boolean {
  return !!toolName && REACH_TOOL_IDS.has(toolName.toLowerCase());
}

/** The `opensession-turn` server's two tools, in the spellings a run reports. */
const SILENCE_TOOL_IDS: ReadonlyMap<string, SilenceTool> = new Map(
  (["finish_silently", "stay_silent"] as SilenceTool[]).flatMap(
    (tool) =>
      [
        [`mcp__opensession-turn__${tool}`, tool],
        [`opensession-turn_${tool}`, tool],
      ] as Array<[string, SilenceTool]>
  )
);

export function silenceToolFor(toolName: string | undefined): SilenceTool | undefined {
  return toolName ? SILENCE_TOOL_IDS.get(toolName.toLowerCase()) : undefined;
}

export interface ObservedToolCall {
  name: string;
  args: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The tool a `tool_use` event is really about.
 *
 * Pi does not hand the model one tool per bridged MCP tool. The catalog is
 * kept server-side and reached through two dispatcher tools, `mcp_search` and
 * `mcp_call` (createPiMcpBridge, src/server/pi-mcp-bridge.ts) — so a Slack
 * post arrives as `mcp_call` with `{name: "slack_...", arguments: {...}}`,
 * and the tool that was actually called sits one level down.
 *
 * The ledger read the envelope. That was harmless while unattended runs used
 * an engine that named the tool directly, and became total the day automations
 * moved to Pi (2026-08-19): 214 turn_outcome rows the following day, every one
 * a silent-drop, not one carrying an effect, against 8 successful
 * `finish_silently` calls that same day.
 *
 * Unwrapping here rather than widening REACH_TOOLS is the point. The reach
 * list stays exactly as explicit as it was; it is simply asked about the tool
 * the run called instead of the dispatcher it called it through.
 */
export function observedToolCall(event: {
  toolName?: string;
  toolInput?: unknown;
}): ObservedToolCall | undefined {
  const outer = event.toolName;
  if (!outer) return undefined;
  const input = asRecord(event.toolInput);
  if (outer.toLowerCase() !== "mcp_call") return { name: outer, args: input };
  // A dispatcher call with no resolvable target names no tool at all — a
  // malformed call, not something the run reached anybody with.
  const inner = input.name;
  if (typeof inner !== "string" || !inner) return undefined;
  return { name: inner, args: asRecord(input.arguments) };
}

/**
 * Fold one observed tool call into the ledger: an outward effect, a declared
 * silence, or neither.
 *
 * Declarations are recorded here as well as by the tool itself
 * (src/agents/slack/turn-tools.ts), because since 2026-08-19 those two things
 * happen in DIFFERENT PROCESSES. An automation's turn runs in a detached run
 * host (host-client.ts -> src/runner-host/host.ts), which is where beginTurn
 * and endTurn run; the opensession-turn MCP server is built in the server
 * process (automations.ts, interactive-mcp.ts) and reached from the host
 * through the run-rpc proxy, so its recordDeclaration writes into a `ledgers`
 * map the turn's ledger does not live in, finds nothing, and returns. The host
 * sees the call in its own event stream, which is the one place both halves of
 * the turn are already together — no new frame, no second ledger.
 *
 * The duplicate on an in-process run is free: the last declaration wins and
 * both carry the same value. An attended turn, where `finish_silently` is a
 * no-op the tool refuses, cannot be affected — attended runs are interactive
 * kinds and never carry a ledger at all (CHECKED_KINDS above).
 */
export function observeToolCall(
  key: string | undefined,
  event: { toolName?: string; toolInput?: unknown }
): void {
  if (!key) return;
  const call = observedToolCall(event);
  if (!call) return;
  if (isReachTool(call.name)) {
    recordEffect(key, call.name);
    return;
  }
  const silence = silenceToolFor(call.name);
  if (!silence) return;
  const reason = call.args.reason;
  recordDeclaration(key, {
    tool: silence,
    ...(typeof reason === "string" && reason ? { reason } : {}),
  });
}

/**
 * Run kinds whose whole point is to reach somebody, so ending without an
 * effect is worth a look. Interactive kinds are excluded because the reply
 * itself IS the effect and the human is right there; `goal` and `workflow`
 * runs are excluded because silence is their normal resting state (a goal
 * tick with nothing to do, a workflow worker returning data to its parent).
 * github-* kinds are excluded because their deliverable is posted by server
 * code (review.ts postReview → REST) after the run's ledger closes — the
 * ledger only ever sees agent tool calls, so every github run would verdict
 * as a silent drop no matter what it shipped.
 */
// "action" is the retired Actions feature — kept so historical runs still
// classify the way they did when they ran.
const CHECKED_KINDS = new Set(["automation", "plain", "action", "security-scan"]);

export function isCheckedKind(journalKind: string | undefined): boolean {
  const base = (journalKind || "").replace(/(-(resume|rerun|fallback))+$/, "");
  return CHECKED_KINDS.has(base);
}

export interface TurnLedger {
  readonly key: string;
  readonly kind: string;
  readonly sessionId?: string;
  readonly effects: string[];
  declaration?: TurnDeclaration;
  closed: boolean;
}

const ledgers = new Map<string, TurnLedger>();

/**
 * Ledger key: the opensession session id, and only that.
 *
 * Deliberately no fallback to the engine session id. The key has to be
 * something the MCP tool context can also name, or a run gets judged on a
 * ledger it had no way to write a declaration into — which is how you
 * manufacture false papercuts. Runs with no opensession session (Plain's direct
 * mention flow, which posts its result as a note unconditionally) get no
 * ledger and no verdict, which is the honest answer for them.
 */
export function turnKeyFor(opts: { osSessionId?: string }): string | undefined {
  return opts.osSessionId || undefined;
}

export function beginTurn(opts: {
  key: string;
  kind: string;
  sessionId?: string;
}): TurnLedger {
  const ledger: TurnLedger = {
    key: opts.key,
    kind: opts.kind,
    sessionId: opts.sessionId,
    effects: [],
    closed: false,
  };
  ledgers.set(opts.key, ledger);
  return ledger;
}

export function getTurn(key: string | undefined): TurnLedger | undefined {
  return key ? ledgers.get(key) : undefined;
}

/** Record an outward-effect tool call. Ignores repeats of the same tool. */
export function recordEffect(key: string | undefined, toolName: string): void {
  const ledger = getTurn(key);
  if (!ledger || ledger.closed) return;
  if (!ledger.effects.includes(toolName)) ledger.effects.push(toolName);
}

/**
 * Record a declared silence. The LAST declaration wins: a run that declares
 * silence and then finds something to say and posts it lands on "reached"
 * anyway (effects outrank declarations in `verdictFor`), and a run that
 * declares twice is describing the same decision.
 */
export function recordDeclaration(
  key: string | undefined,
  declaration: TurnDeclaration
): void {
  const ledger = getTurn(key);
  if (!ledger || ledger.closed) return;
  ledger.declaration = declaration;
}

export function verdictFor(ledger: {
  effects: string[];
  declaration?: TurnDeclaration;
}): TurnVerdict {
  if (ledger.effects.length > 0) return "reached";
  return ledger.declaration ? "declared" : "silent-drop";
}

/**
 * Close the ledger and return the verdict. Every verdict is audited and
 * nothing else; buildAuditDigest counts them (totals.silentDrops plus the
 * turnVerdicts breakdown) and states the meaning once.
 *
 * A silent-drop used to ALSO be mirrored into the papercut log, one row per
 * occurrence. Measured 2026-08-18: 583 identical rows, 22% of the whole
 * papercut store, still landing 30-50 a day — crowding out the friction a run
 * actually noticed and wrote down, which is what that store is for. A verdict
 * the server computes is not a papercut, and a message worth reading once is
 * not worth 583 copies.
 */
export function endTurn(
  key: string | undefined,
  ctx?: { repo?: string; model?: string; by?: string }
): TurnOutcome | undefined {
  const ledger = getTurn(key);
  if (!ledger) return undefined;
  ledgers.delete(ledger.key);
  if (ledger.closed) return undefined;
  ledger.closed = true;

  const verdict = verdictFor(ledger);
  const outcome: TurnOutcome = {
    verdict,
    effects: [...ledger.effects],
    ...(ledger.declaration ? { declaration: ledger.declaration } : {}),
  };

  audit({
    kind: "turn_outcome",
    session_id: ledger.sessionId,
    run_kind: ledger.kind,
    verdict,
    effects: outcome.effects.join(",") || undefined,
    declared: ledger.declaration?.tool,
    reason: ledger.declaration?.reason,
    by: ctx?.by,
  });

  return outcome;
}
