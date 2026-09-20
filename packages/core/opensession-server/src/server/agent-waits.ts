/**
 * Durable, turn-ending waits for interactive agents.
 *
 * An agent registers one wait, posts a normal user-facing status message, and
 * ends its turn. The SessionKernel owns the timer while no model is running.
 * When the trigger fires, hidden system context is delivered back to the same
 * session, which starts a fresh turn if idle or steers a busy one. It is logged
 * as context but never rendered as a message the human appears to have sent.
 *
 * One wait is active per session. Registering another replaces it. Delivery is
 * exactly-once through the wait id, and PR waits keep rescheduling durable
 * polls until checks settle or the deadline is reached.
 *
 * A session_turn wait watches another session and wakes when that session's
 * turn ends: it goes idle, stops on a question for a human, fails, or is
 * cancelled. The durable timer polls the target at a coarse interval so the
 * wait survives restarts; an in-process listener on the session-state event
 * bus pulls the timer forward the moment the target settles, so the common
 * case wakes within a drain tick rather than a poll interval.
 *
 * "Settled" is read from authoritative actor state, not the warm summary
 * cache: a prompt that send_to_session has queued or dispatched but that has
 * not started yet, and a run that is preparing or starting, both count as
 * unsettled. The event bus also retains each session's last turn end, so a
 * boundary that passes while registration or a poll is mid-await is still
 * detected instead of being mistaken for the next turn.
 */
import { randomUUIDv7 } from "bun";
import { getPrDetailsFresh, type PrDetails } from "./pr-info";
import { wrapContext } from "./prompt-context";
import { isRunStateUnsettled, type RunState } from "./run-state";
import { getSessionControl, type SessionSummary } from "./session-control";
import {
  registerSessionTimerHandler,
  sessionDelivery,
  sessionKernel,
  sessionRunStateSnapshot,
  sessionTimerSnapshot,
  type DurableTimer,
} from "./session-kernel";
import { requestSessionKernelRuntimeDrain } from "./session-kernel/wakes";
import {
  hasPendingOpening,
  isTurnEndEvent,
  lastSessionTurnEnd,
  onSessionStateChange,
  type SessionStateEvent,
  type SessionTurnEnd,
} from "./session-state-events";
import type { TranscriptEntry } from "./types";

const TIMER_KIND = "agent_wait";
const TIMER_ID = "agent-wait";

const MIN_TIMER_SECONDS = 10;
const MAX_WAIT_SECONDS = 24 * 60 * 60;
const DEFAULT_PR_POLL_SECONDS = 30;
const DEFAULT_PR_SETTLE_SECONDS = 45;
const DEFAULT_PR_TIMEOUT_SECONDS = 2 * 60 * 60;
const DEFAULT_SESSION_TURN_POLL_SECONDS = 30;
const DEFAULT_SESSION_TURN_TIMEOUT_SECONDS = 2 * 60 * 60;
/** Tail of the target's last assistant message carried in the wake-up. */
const LAST_MESSAGE_TAIL_CHARS = 4000;
const LAST_MESSAGE_SCAN_ENTRIES = 60;

export interface TimerAgentWait {
  version: 1;
  id: string;
  sessionId: string;
  kind: "timer";
  user: string;
  prompt: string;
  createdAt: number;
  dueAt: number;
}

export interface PrChecksAgentWait {
  version: 1;
  id: string;
  sessionId: string;
  kind: "pr_checks";
  user: string;
  prompt: string;
  repo: string;
  branch: string;
  createdAt: number;
  deadlineAt: number;
  pollSeconds: number;
  settleSeconds: number;
  candidateSince?: number;
  candidateSignature?: string;
  lastError?: string;
}

/** How a watched session's turn ended, as reported in the wake-up. */
export type SessionTurnOutcome =
  | "idle"
  | "pending_question"
  | "failed"
  | "cancelled"
  | "archived"
  | "missing";

export interface SessionTurnAgentWait {
  version: 1;
  id: string;
  sessionId: string;
  kind: "session_turn";
  user: string;
  prompt: string;
  targetSessionId: string;
  createdAt: number;
  deadlineAt: number;
  pollSeconds: number;
  /** The target's last retained turn end when the wait was registered. A
   * different record later means a boundary passed since registration, even
   * if the target is busy again by the time anyone looks. */
  turnEndBefore?: { at: number; seq: number };
  /** Set once a turn end was observed (at registration when the target was
   * already settled, by the in-process state listener, or from the retained
   * turn-end record). The durable handler then delivers even if the target
   * has already started another turn, so a busy target cannot make the wait
   * miss the boundary. */
  observedEndAt?: number;
  observedOutcome?: SessionTurnOutcome;
}

export type AgentWait =
  | TimerAgentWait
  | PrChecksAgentWait
  | SessionTurnAgentWait;

export type AgentWaitRegistration =
  | { ok: true; wait: AgentWait; replaced: boolean }
  | { ok: false; error: string };

function boundedSeconds(
  value: number | undefined,
  fallback: number,
  minimum: number,
): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_WAIT_SECONDS, Math.max(minimum, Math.round(value)));
}

function isAgentWait(value: unknown): value is AgentWait {
  if (!value || typeof value !== "object") return false;
  const wait = value as Partial<AgentWait>;
  const common =
    wait.version === 1 &&
    typeof wait.id === "string" &&
    typeof wait.sessionId === "string" &&
    typeof wait.user === "string" &&
    typeof wait.prompt === "string" &&
    typeof wait.createdAt === "number";
  if (!common) return false;
  if (wait.kind === "timer")
    return typeof (wait as Partial<TimerAgentWait>).dueAt === "number";
  if (wait.kind === "session_turn") {
    const turn = wait as Partial<SessionTurnAgentWait>;
    return (
      typeof turn.targetSessionId === "string" &&
      typeof turn.deadlineAt === "number" &&
      typeof turn.pollSeconds === "number"
    );
  }
  if (wait.kind !== "pr_checks") return false;
  const pr = wait as Partial<PrChecksAgentWait>;
  return (
    typeof pr.repo === "string" &&
    typeof pr.branch === "string" &&
    typeof pr.deadlineAt === "number" &&
    typeof pr.pollSeconds === "number" &&
    typeof pr.settleSeconds === "number"
  );
}

export async function getAgentWait(
  sessionId: string,
): Promise<AgentWait | undefined> {
  const timer = await sessionTimerSnapshot(sessionId, TIMER_ID);
  return timer?.kind === TIMER_KIND && isAgentWait(timer.payload)
    ? timer.payload
    : undefined;
}

export async function cancelAgentWait(sessionId: string): Promise<boolean> {
  if (!(await getAgentWait(sessionId))) return false;
  await sessionKernel(sessionId).cancelTimer(TIMER_ID);
  return true;
}

export async function registerTimerAgentWait(input: {
  sessionId: string;
  user: string;
  prompt?: string;
  seconds: number;
  waitId?: string;
  now?: number;
}): Promise<AgentWaitRegistration> {
  const sessionId = input.sessionId.trim();
  if (!sessionId)
    return { ok: false, error: "Current session id is required." };
  if (!Number.isFinite(input.seconds) || input.seconds < MIN_TIMER_SECONDS)
    return {
      ok: false,
      error: `Timer waits must be at least ${MIN_TIMER_SECONDS} seconds.`,
    };
  if (input.seconds > MAX_WAIT_SECONDS)
    return { ok: false, error: "Timer waits cannot exceed 24 hours." };
  const now = input.now ?? Date.now();
  const wait: TimerAgentWait = {
    version: 1,
    id: input.waitId || `wait-${randomUUIDv7()}`,
    sessionId,
    kind: "timer",
    user: input.user.trim() || "Anonymous",
    prompt: input.prompt?.trim() || "Continue the task now.",
    createdAt: now,
    dueAt: now + Math.round(input.seconds * 1000),
  };
  const current = await getAgentWait(sessionId);
  if (current?.id === wait.id)
    return { ok: true, wait: current, replaced: false };
  await sessionKernel(sessionId).scheduleTimer({
    timerId: TIMER_ID,
    kind: TIMER_KIND,
    dueAt: wait.dueAt,
    payload: wait,
  });
  return { ok: true, wait, replaced: !!current };
}

export async function registerPrChecksAgentWait(input: {
  sessionId: string;
  user: string;
  repo: string;
  branch: string;
  prompt?: string;
  timeoutSeconds?: number;
  pollSeconds?: number;
  settleSeconds?: number;
  waitId?: string;
  now?: number;
}): Promise<AgentWaitRegistration> {
  const sessionId = input.sessionId.trim();
  const repo = input.repo.trim();
  const branch = input.branch.trim();
  if (!sessionId)
    return { ok: false, error: "Current session id is required." };
  if (!repo)
    return { ok: false, error: "Repository id is required for a PR wait." };
  if (!branch) return { ok: false, error: "Branch is required for a PR wait." };
  const now = input.now ?? Date.now();
  const pollSeconds = boundedSeconds(
    input.pollSeconds,
    DEFAULT_PR_POLL_SECONDS,
    15,
  );
  const settleSeconds = boundedSeconds(
    input.settleSeconds,
    DEFAULT_PR_SETTLE_SECONDS,
    15,
  );
  const timeoutSeconds = boundedSeconds(
    input.timeoutSeconds,
    DEFAULT_PR_TIMEOUT_SECONDS,
    pollSeconds,
  );
  const wait: PrChecksAgentWait = {
    version: 1,
    id: input.waitId || `wait-${randomUUIDv7()}`,
    sessionId,
    kind: "pr_checks",
    user: input.user.trim() || "Anonymous",
    prompt:
      input.prompt?.trim() ||
      "Inspect the settled PR checks. Fix failures if needed, then finish the task.",
    repo,
    branch,
    createdAt: now,
    deadlineAt: now + timeoutSeconds * 1000,
    pollSeconds,
    settleSeconds,
  };
  const current = await getAgentWait(sessionId);
  if (current?.id === wait.id)
    return { ok: true, wait: current, replaced: false };
  await sessionKernel(sessionId).scheduleTimer({
    timerId: TIMER_ID,
    kind: TIMER_KIND,
    dueAt: Math.min(wait.deadlineAt, now + pollSeconds * 1000),
    payload: wait,
  });
  return { ok: true, wait, replaced: !!current };
}

/** The authoritative reads a session_turn wait classifies a target with.
 * `getSession` is the same visibility gate as get_session; the rest cross
 * the actor boundary so a prompt that was just queued or admitted counts. */
export interface SessionTurnWaitDeps {
  now: () => number;
  /** Same visibility as get_session: undefined when the caller cannot see it. */
  getSession: (id: string) => SessionSummary | undefined;
  /** Durable run state from the session actor, not the gateway projection. */
  runState: (id: string) => Promise<string>;
  /** A prompt queued or dispatched for the session that no run owns yet, or
   * an accepted create whose opening turn has not started. */
  hasQueuedWork: (id: string) => Promise<boolean>;
  lastTurnEnd: (id: string) => SessionTurnEnd | undefined;
}

async function authoritativeRunState(id: string): Promise<string> {
  return (await sessionRunStateSnapshot(id)).state;
}

async function authoritativeQueuedWork(id: string): Promise<boolean> {
  if (hasPendingOpening(id)) return true;
  const delivery = await sessionDelivery({ op: "snapshot", sessionId: id });
  return delivery.queued.length > 0 || delivery.dispatch !== undefined;
}

const defaultSessionTurnDeps: SessionTurnWaitDeps = {
  now: () => Date.now(),
  getSession: (id) => getSessionControl().getSession(id),
  runState: authoritativeRunState,
  hasQueuedWork: authoritativeQueuedWork,
  lastTurnEnd: lastSessionTurnEnd,
};

/** Classify a watched session. `undefined` means its turn has not ended:
 * it is running, or work is queued, dispatched, or starting that will run. */
export function sessionTurnOutcome(
  session: SessionSummary | undefined,
  runState: string,
  queuedWork = false,
): SessionTurnOutcome | undefined {
  if (!session) return "missing";
  if (session.state === "archived") return "archived";
  if (session.state === "waiting_question") return "pending_question";
  if (session.state === "running" || session.state === "queued")
    return undefined;
  if (queuedWork || isRunStateUnsettled(runState as RunState)) return undefined;
  if (runState === "stopped") return "cancelled";
  if (runState === "failed" || session.lastRunError) return "failed";
  return "idle";
}

async function classifyTarget(
  targetSessionId: string,
  deps: Pick<SessionTurnWaitDeps, "getSession" | "runState" | "hasQueuedWork">,
): Promise<{
  target: SessionSummary | undefined;
  outcome: SessionTurnOutcome | undefined;
}> {
  const target = deps.getSession(targetSessionId);
  if (!target) return { target, outcome: "missing" };
  const [runState, queuedWork] = await Promise.all([
    deps.runState(targetSessionId),
    deps.hasQueuedWork(targetSessionId),
  ]);
  return { target, outcome: sessionTurnOutcome(target, runState, queuedWork) };
}

/** A retained turn end that is not the one the wait was registered against. */
function turnEndSince(
  wait: SessionTurnAgentWait,
  retained: SessionTurnEnd | undefined,
): SessionTurnEnd | undefined {
  if (!retained) return undefined;
  const before = wait.turnEndBefore;
  if (before && before.at === retained.at && before.seq === retained.seq)
    return undefined;
  return retained;
}

export async function registerSessionTurnAgentWait(
  input: {
    sessionId: string;
    user: string;
    targetSessionId: string;
    prompt?: string;
    timeoutSeconds?: number;
    pollSeconds?: number;
    waitId?: string;
    now?: number;
  },
  deps: SessionTurnWaitDeps = defaultSessionTurnDeps,
): Promise<AgentWaitRegistration> {
  const sessionId = input.sessionId.trim();
  const targetSessionId = input.targetSessionId.trim();
  if (!sessionId)
    return { ok: false, error: "Current session id is required." };
  if (!targetSessionId)
    return {
      ok: false,
      error: "session_id is required for a session_turn wait.",
    };
  if (targetSessionId === sessionId)
    return {
      ok: false,
      error:
        "A session cannot wait for its own turn to end. Use kind=timer to wake this session later.",
    };
  // Snapshot the retained boundary before classifying, so a turn that ends
  // anywhere between here and the recheck below is seen as new.
  const turnEndBefore = deps.lastTurnEnd(targetSessionId);
  const { target, outcome: settledNow } = await classifyTarget(
    targetSessionId,
    deps,
  );
  if (!target)
    return {
      ok: false,
      error: `No session with id \`${targetSessionId}\` is visible to this session, so it cannot be watched.`,
    };
  const now = input.now ?? deps.now();
  const pollSeconds = boundedSeconds(
    input.pollSeconds,
    DEFAULT_SESSION_TURN_POLL_SECONDS,
    10,
  );
  const timeoutSeconds = boundedSeconds(
    input.timeoutSeconds,
    DEFAULT_SESSION_TURN_TIMEOUT_SECONDS,
    pollSeconds,
  );
  const wait: SessionTurnAgentWait = {
    version: 1,
    id: input.waitId || `wait-${randomUUIDv7()}`,
    sessionId,
    kind: "session_turn",
    user: input.user.trim() || "Anonymous",
    prompt:
      input.prompt?.trim() ||
      "Read the watched session's reply above and continue the task.",
    targetSessionId,
    createdAt: now,
    deadlineAt: now + timeoutSeconds * 1000,
    pollSeconds,
    ...(turnEndBefore
      ? { turnEndBefore: { at: turnEndBefore.at, seq: turnEndBefore.seq } }
      : {}),
    ...(settledNow ? { observedEndAt: now, observedOutcome: settledNow } : {}),
  };
  const current = await getAgentWait(sessionId);
  if (current?.id === wait.id)
    return { ok: true, wait: current, replaced: false };
  // An already settled target behaves like a zero-delay timer: the durable
  // handler still runs and still carries the result payload.
  await sessionKernel(sessionId).scheduleTimer({
    timerId: TIMER_ID,
    kind: TIMER_KIND,
    dueAt: settledNow
      ? now
      : Math.min(wait.deadlineAt, now + pollSeconds * 1000),
    payload: wait,
  });
  if (settledNow) {
    requestSessionKernelRuntimeDrain();
    return { ok: true, wait, replaced: !!current };
  }
  watchSessionTurn(wait);
  // The listener was not installed while the awaits above ran. If the
  // target's turn ended in that window, the retained record is newer than
  // the snapshot: treat it as the observed boundary rather than waiting for
  // a later turn.
  const missed = turnEndSince(wait, deps.lastTurnEnd(targetSessionId));
  if (missed) {
    await observeSessionTurnEnd(sessionId, {
      sessionId: targetSessionId,
      isRunning: false,
      pendingQuestion: missed.pendingQuestion,
      at: missed.at,
    });
    const observed = await getAgentWait(sessionId);
    if (observed?.kind === "session_turn" && observed.id === wait.id)
      return { ok: true, wait: observed, replaced: !!current };
  }
  return { ok: true, wait, replaced: !!current };
}

// --- In-process turn watcher -------------------------------------------------
//
// Process-local index from watched session to the sessions waiting on it. It
// is not durable: registration and every durable poll re-add the entry, so a
// restart at worst falls back to the poll interval until the first poll runs.

type TurnWatchState = {
  watchers: Map<string, Set<string>>;
  stop?: () => void;
};

const turnWatchState: TurnWatchState = ((
  globalThis as typeof globalThis & {
    __opensessionSessionTurnWatchers?: TurnWatchState;
  }
).__opensessionSessionTurnWatchers ??= { watchers: new Map() });

/** Subscribe once to session-state changes. Idempotent, called lazily from a
 * registration or a durable poll rather than at import time. */
export function ensureSessionTurnWatcher(): void {
  if (turnWatchState.stop) return;
  turnWatchState.stop = onSessionStateChange((event) => {
    if (!isTurnEndEvent(event)) return;
    const waiting = turnWatchState.watchers.get(event.sessionId);
    if (!waiting?.size) return;
    turnWatchState.watchers.delete(event.sessionId);
    for (const sessionId of waiting)
      void observeSessionTurnEnd(sessionId, event).catch((error) =>
        console.warn("[agent-waits] session turn observe failed:", error),
      );
  });
}

export function stopSessionTurnWatcherForTest(): void {
  turnWatchState.stop?.();
  turnWatchState.stop = undefined;
  turnWatchState.watchers.clear();
}

function watchSessionTurn(wait: SessionTurnAgentWait): void {
  ensureSessionTurnWatcher();
  let waiting = turnWatchState.watchers.get(wait.targetSessionId);
  if (!waiting) {
    waiting = new Set();
    turnWatchState.watchers.set(wait.targetSessionId, waiting);
  }
  waiting.add(wait.sessionId);
}

/** Pull the durable timer forward now that the target's turn ended. The
 * handler still runs through the fenced timer path, so delivery stays
 * exactly-once and a replaced or cancelled wait is never resurrected. */
async function observeSessionTurnEnd(
  sessionId: string,
  event: SessionStateEvent,
): Promise<void> {
  const wait = await getAgentWait(sessionId);
  if (
    wait?.kind !== "session_turn" ||
    wait.targetSessionId !== event.sessionId ||
    wait.observedEndAt != null
  )
    return;
  const next: SessionTurnAgentWait = {
    ...wait,
    observedEndAt: event.at,
    observedOutcome: event.pendingQuestion ? "pending_question" : "idle",
  };
  await sessionKernel(sessionId).scheduleTimer({
    timerId: TIMER_ID,
    kind: TIMER_KIND,
    dueAt: event.at,
    payload: next,
  });
  requestSessionKernelRuntimeDrain();
}

function lastAssistantMessage(entries: TranscriptEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== "assistant" || entry.isReasoning) continue;
    const content = (entry.content || "").trim();
    if (content) return content;
  }
  return undefined;
}

function tailTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `[… ${text.length - max} earlier characters omitted …]\n${text.slice(-max)}`;
}

function questionHeaders(questions: unknown[]): string[] {
  return questions
    .map((q) => {
      const header = (q as { header?: unknown })?.header;
      return typeof header === "string" ? header.trim() : "";
    })
    .filter(Boolean);
}

function describeOutcome(outcome: SessionTurnOutcome | "timed_out"): string {
  switch (outcome) {
    case "idle":
      return "idle (turn finished)";
    case "pending_question":
      return "waiting on a question for a human";
    case "failed":
      return "failed (the run ended on an error)";
    case "cancelled":
      return "cancelled";
    case "archived":
      return "archived";
    case "missing":
      return "no longer visible";
    case "timed_out":
      return "still running when the wait timed out";
  }
}

/** The self-contained wake-up for a session_turn wait. */
export function sessionTurnWakeMessage(input: {
  wait: SessionTurnAgentWait;
  outcome: SessionTurnOutcome | "timed_out";
  target: SessionSummary | undefined;
  transcript: TranscriptEntry[];
  /** The target already started another turn after the observed end. */
  runningAgain?: boolean;
}): string {
  const { wait, target } = input;
  const title = target?.title?.trim();
  const label = title
    ? `Session \`${wait.targetSessionId}\` ("${title}")`
    : `Session \`${wait.targetSessionId}\``;
  const lines = [`${label} is ${describeOutcome(input.outcome)}.`];
  if (input.runningAgain)
    lines.push(
      "It has since started another turn, so the message below may not be its final word.",
    );
  if (input.outcome === "pending_question" && target?.pendingQuestion) {
    const headers = questionHeaders(target.pendingQuestion.questions);
    lines.push(
      `Pending question \`${target.pendingQuestion.questionId}\`` +
        (headers.length ? `: ${headers.join("; ")}` : "") +
        ". A human can answer it, or use answer_session_question.",
    );
  }
  if (input.outcome === "failed" && target?.lastRunError?.message)
    lines.push(`Error: ${target.lastRunError.message.slice(0, 500)}`);
  const last = lastAssistantMessage(input.transcript);
  lines.push(
    last
      ? `Last assistant message (tail):\n${tailTruncate(last, LAST_MESSAGE_TAIL_CHARS)}`
      : "It has not written an assistant message yet.",
  );
  lines.push(
    `Use get_session with id \`${wait.targetSessionId}\` for more of the transcript.`,
  );
  return lines.join("\n\n");
}

export interface PrCheckSettlement {
  settled: boolean;
  signature: string;
  total: number;
  pending: number;
  failed: number;
  passed: number;
  other: number;
}

function checkPending(check: PrDetails["checks"][number]): boolean {
  const status = (check.status || "").toUpperCase();
  const conclusion = (check.conclusion || "").toUpperCase();
  return (
    (status !== "" && status !== "COMPLETED") ||
    conclusion === "" ||
    conclusion === "PENDING" ||
    conclusion === "EXPECTED"
  );
}

function checkFailed(check: PrDetails["checks"][number]): boolean {
  return ["FAILURE", "TIMED_OUT", "ERROR", "ACTION_REQUIRED"].includes(
    (check.conclusion || "").toUpperCase(),
  );
}

export function prCheckSettlement(details: PrDetails): PrCheckSettlement {
  const checks = [...details.checks].sort((a, b) =>
    `${a.workflowName || ""}\0${a.name}`.localeCompare(
      `${b.workflowName || ""}\0${b.name}`,
    ),
  );
  let pending = 0;
  let failed = 0;
  let passed = 0;
  for (const check of checks) {
    if (checkPending(check)) pending += 1;
    else if (checkFailed(check)) failed += 1;
    else if ((check.conclusion || "").toUpperCase() === "SUCCESS") passed += 1;
  }
  const signature = [
    details.headRefOid,
    ...checks.map(
      (check) =>
        `${check.workflowName || ""}\0${check.name}\0${check.status}\0${check.conclusion}`,
    ),
  ].join("\n");
  return {
    settled: pending === 0,
    signature,
    total: checks.length,
    pending,
    failed,
    passed,
    other: Math.max(0, checks.length - pending - failed - passed),
  };
}

export interface AgentWaitHandlerDeps {
  now: () => number;
  getPrDetails: (branch: string, repo: string) => Promise<PrDetails | null>;
  schedule: (wait: AgentWait, dueAt: number) => void;
  deliver: (wait: AgentWait, message: string) => Promise<void>;
  getSession: (id: string) => SessionSummary | undefined;
  runState: (id: string) => Promise<string>;
  hasQueuedWork: (id: string) => Promise<boolean>;
  lastTurnEnd: (id: string) => SessionTurnEnd | undefined;
  transcriptTail: (id: string, n: number) => Promise<TranscriptEntry[]>;
  /** Re-arm the in-process listener for a still-running target. */
  watch: (wait: SessionTurnAgentWait) => void;
}

export function agentWaitWakePrompt(wait: AgentWait, message: string): string {
  return wrapContext(
    `A durable background wait registered by the assistant has completed. ` +
      `This is system context, not a new user message.\n\n` +
      `Trigger: ${message}\n\nContinue with: ${wait.prompt}`,
    "background-wait",
  );
}

const defaultHandlerDeps: AgentWaitHandlerDeps = {
  now: () => Date.now(),
  getPrDetails: getPrDetailsFresh,
  schedule: async (wait, dueAt) => {
    // A cancel or replacement can land while a GitHub request is in flight.
    // Never let that stale response recreate the old wait over the newer one.
    if ((await getAgentWait(wait.sessionId))?.id !== wait.id) return;
    await sessionKernel(wait.sessionId).scheduleTimer({
      timerId: TIMER_ID,
      kind: TIMER_KIND,
      dueAt,
      payload: wait,
    });
  },
  deliver: async (wait, message) => {
    const result = await getSessionControl().deliverToSession(
      wait.sessionId,
      agentWaitWakePrompt(wait, message),
      undefined,
      {
        deliveryId: `agent-wait:${wait.id}:wake`,
        // The same in-flight race applies to terminal poll results. This
        // check runs inside the session command that admits the delivery.
        // The durable timer token fenced this callback and the awaited check
        // above proved this wait was still current before delivery admission.
        admit: () => true,
      },
    );
    if (result.status === "error") throw new Error(result.message);
  },
  getSession: (id) => getSessionControl().getSession(id),
  runState: authoritativeRunState,
  hasQueuedWork: authoritativeQueuedWork,
  lastTurnEnd: lastSessionTurnEnd,
  transcriptTail: (id, n) => getSessionControl().transcriptTail(id, n),
  watch: watchSessionTurn,
};

function nextPrPoll(
  wait: PrChecksAgentWait | SessionTurnAgentWait,
  now: number,
): number {
  return Math.min(wait.deadlineAt, now + wait.pollSeconds * 1000);
}

async function handleSessionTurnWait(
  wait: SessionTurnAgentWait,
  deps: AgentWaitHandlerDeps,
  now: number,
): Promise<"delivered" | "rescheduled"> {
  const { target, outcome: current } = await classifyTarget(
    wait.targetSessionId,
    deps,
  );
  // A boundary the listener did not see (it was not installed yet, or the
  // process restarted between the end and this poll) still counts once the
  // retained record differs from the one registration snapshotted.
  let observed: SessionTurnOutcome | undefined = wait.observedOutcome;
  if (wait.observedEndAt == null) {
    const missed = turnEndSince(wait, deps.lastTurnEnd(wait.targetSessionId));
    if (missed) observed = missed.pendingQuestion ? "pending_question" : "idle";
  }
  const timedOut = now >= wait.deadlineAt;
  if (!current && !observed && !timedOut) {
    deps.watch(wait);
    deps.schedule(wait, nextPrPoll(wait, now));
    return "rescheduled";
  }
  // A settled target wins over an earlier observation: the wake-up reports
  // what the target looks like now. When it already started another turn,
  // report the observed end and say so.
  const outcome = current ?? observed;
  let transcript: TranscriptEntry[] = [];
  try {
    transcript = await deps.transcriptTail(
      wait.targetSessionId,
      LAST_MESSAGE_SCAN_ENTRIES,
    );
  } catch {}
  await deps.deliver(
    wait,
    sessionTurnWakeMessage({
      wait,
      outcome: outcome ?? "timed_out",
      target,
      transcript,
      runningAgain: !current && outcome != null,
    }),
  );
  return "delivered";
}

export async function handleAgentWait(
  wait: AgentWait,
  deps: AgentWaitHandlerDeps = defaultHandlerDeps,
): Promise<"delivered" | "rescheduled"> {
  const now = deps.now();
  if (wait.kind === "timer") {
    await deps.deliver(
      wait,
      `Background timer finished after ${Math.max(1, Math.round((now - wait.createdAt) / 1000))} seconds.`,
    );
    return "delivered";
  }

  if (wait.kind === "session_turn")
    return handleSessionTurnWait(wait, deps, now);

  if (now >= wait.deadlineAt) {
    const detail = wait.lastError ? ` Last check: ${wait.lastError}` : "";
    await deps.deliver(
      wait,
      `Background wait timed out before PR checks settled.${detail}`,
    );
    return "delivered";
  }

  let details: PrDetails | null;
  try {
    details = await deps.getPrDetails(wait.branch, wait.repo);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const next = { ...wait, lastError: message.slice(0, 300) };
    deps.schedule(next, nextPrPoll(next, now));
    return "rescheduled";
  }
  if (!details) {
    const next = {
      ...wait,
      lastError: "No pull request found for the branch yet.",
    };
    deps.schedule(next, nextPrPoll(next, now));
    return "rescheduled";
  }
  if (details.state !== "OPEN") {
    await deps.deliver(
      wait,
      `PR ${wait.repo}#${details.number} is ${details.state.toLowerCase()}.`,
    );
    return "delivered";
  }

  const state = prCheckSettlement(details);
  if (!state.settled) {
    const next: PrChecksAgentWait = {
      ...wait,
      candidateSince: undefined,
      candidateSignature: undefined,
      lastError: undefined,
    };
    deps.schedule(next, nextPrPoll(next, now));
    return "rescheduled";
  }

  const sameCandidate = wait.candidateSignature === state.signature;
  const candidateSince = sameCandidate ? wait.candidateSince : now;
  if (
    candidateSince == null ||
    now - candidateSince < wait.settleSeconds * 1000
  ) {
    const next: PrChecksAgentWait = {
      ...wait,
      candidateSince,
      candidateSignature: state.signature,
      lastError: undefined,
    };
    deps.schedule(next, nextPrPoll(next, now));
    return "rescheduled";
  }

  const result =
    state.total === 0
      ? "No checks were registered during the settlement window."
      : `${state.total} checks settled: ${state.passed} passed, ${state.failed} failed` +
        (state.other ? `, ${state.other} skipped or neutral.` : ".");
  await deps.deliver(
    wait,
    `PR ${wait.repo}#${details.number} checks settled. ${result}`,
  );
  return "delivered";
}

registerSessionTimerHandler(TIMER_KIND, async (timer: DurableTimer) => {
  if (
    timer.timerId !== TIMER_ID ||
    !isAgentWait(timer.payload) ||
    timer.payload.sessionId !== timer.sessionId
  )
    throw new Error("Invalid agent wait timer payload");
  await handleAgentWait(timer.payload);
});
