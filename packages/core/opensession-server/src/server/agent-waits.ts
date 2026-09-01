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
 */
import { randomUUIDv7 } from "bun";
import { getPrDetailsFresh, type PrDetails } from "./pr-info";
import { wrapContext } from "./prompt-context";
import { getSessionControl } from "./session-control";
import {
  registerSessionTimerHandler,
  sessionKernel,
  sessionTimerSnapshot,
  type DurableTimer,
} from "./session-kernel";

const TIMER_KIND = "agent_wait";
const TIMER_ID = "agent-wait";

const MIN_TIMER_SECONDS = 10;
const MAX_WAIT_SECONDS = 24 * 60 * 60;
const DEFAULT_PR_POLL_SECONDS = 30;
const DEFAULT_PR_SETTLE_SECONDS = 45;
const DEFAULT_PR_TIMEOUT_SECONDS = 2 * 60 * 60;

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

export type AgentWait = TimerAgentWait | PrChecksAgentWait;

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
};

function nextPrPoll(wait: PrChecksAgentWait, now: number): number {
  return Math.min(wait.deadlineAt, now + wait.pollSeconds * 1000);
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
