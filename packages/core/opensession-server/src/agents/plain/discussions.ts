/**
 * Plain internal agent: Open Session as a pick in "Ask Sidekick".
 *
 * Plain fires `discussion.*` webhooks for every discussion in the workspace
 * (Sidekick's own, Slack and email ones included), so shouldAnswer is the
 * load-bearing filter. One discussion maps to one Open Session session
 * (`plainDiscussionId`): the first message creates it, later ones are
 * delivered into it, Stop cancels it. The turn's reply travels back through
 * discussion-mirror.ts; Approve/Deny decisions resume the waiting tool in
 * discussion-tools.ts through the approval registry below.
 */
import { wrapContext } from "../../server/prompt-context";
import { productName } from "../../server/config";
import { PLAIN_ACTOR } from "../../server/session-actors";
import {
  agentMachineUserId,
  createDiscussion,
  discussionAgentConfigured,
  keyedOrder,
  sendDiscussionMessage,
  updateDiscussionAgentStatus,
  withDiscussionOrder,
} from "./discussion-api";

export interface DiscussionRef {
  id: string;
  type: "SLACK" | "EMAIL" | "AGENT_SESSION" | string;
  agent: { id: string } | null;
  status: "OPEN" | "RESOLVED" | string;
  agentStatus?: string;
  threadId: string | null;
}

export interface DiscussionMessageCreatedPayload {
  eventType?: "discussion.message_created";
  discussion: DiscussionRef;
  message: {
    id: string;
    type: "INBOUND" | "OUTBOUND" | string;
    markdown: string;
    createdBy?: { actorType: string; userId?: string };
    createdAt?: string;
  };
}

export interface DiscussionTurnStopRequestedPayload {
  eventType?: "discussion.turn_stop_requested";
  discussion: DiscussionRef;
}

export interface DiscussionApprovalResolvedPayload {
  eventType?: "discussion.tool_call_approval_resolved";
  discussion: DiscussionRef;
  approvalId: string;
  toolCallId: string;
  status: "APPROVED" | "DENIED" | string;
  reviewerNote: string | null;
}

export interface DiscussionWebhook {
  type: string;
  payload:
    | DiscussionMessageCreatedPayload
    | DiscussionTurnStopRequestedPayload
    | DiscussionApprovalResolvedPayload;
}

/**
 * Answer only a person's turn, in an AGENT_SESSION discussion addressed to
 * this machine user, that is still open. Polarity is Plain's: the person's
 * message is OUTBOUND and the agent's own replies come back as INBOUND — an
 * agent that skips this check answers itself forever.
 */
export function shouldAnswer(
  payload: DiscussionMessageCreatedPayload,
  machineUserId: string,
): boolean {
  return (
    payload.discussion.type === "AGENT_SESSION" &&
    payload.discussion.agent?.id === machineUserId &&
    payload.message.type === "OUTBOUND" &&
    payload.discussion.status !== "RESOLVED"
  );
}

const SEEN_LIMIT = 5000;
const seenMessages = new Set<string>();

function seenBefore(messageId: string): boolean {
  if (seenMessages.has(messageId)) return true;
  if (seenMessages.size >= SEEN_LIMIT) seenMessages.clear();
  seenMessages.add(messageId);
  return false;
}

// --- Approval registry -----------------------------------------------------

export type ApprovalOutcome =
  | { status: "APPROVED"; reviewerNote: string | null }
  | { status: "DENIED"; reviewerNote: string | null }
  | { status: "CANCELLED" }
  | { status: "TIMEOUT" };

interface PendingApproval {
  discussionId: string;
  resolve: (outcome: ApprovalOutcome) => void;
}

const pendingApprovals = new Map<string, PendingApproval>();

/** Wait for the teammate's Approve/Deny on a tool call, or time out. */
export function awaitApproval(
  discussionId: string,
  toolCallId: string,
  timeoutMs: number,
): Promise<ApprovalOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(toolCallId);
      resolve({ status: "TIMEOUT" });
    }, timeoutMs);
    pendingApprovals.set(toolCallId, {
      discussionId,
      resolve: (outcome) => {
        clearTimeout(timer);
        pendingApprovals.delete(toolCallId);
        resolve(outcome);
      },
    });
  });
}

/** Settle a waiting tool call. False when nothing waits under that id (a
 *  decision after a restart, or one the agent already gave up on). */
export function resolveApproval(
  toolCallId: string,
  outcome: ApprovalOutcome,
): boolean {
  const pending = pendingApprovals.get(toolCallId);
  if (!pending) return false;
  pending.resolve(outcome);
  return true;
}

export function cancelApprovalsFor(discussionId: string): number {
  let n = 0;
  for (const pending of [...pendingApprovals.values()]) {
    if (pending.discussionId !== discussionId) continue;
    pending.resolve({ status: "CANCELLED" });
    n++;
  }
  return n;
}

export function pendingApprovalCount(): number {
  return pendingApprovals.size;
}

// --- Active actions --------------------------------------------------------

interface ActiveAction {
  discussionId: string;
  controller: AbortController;
}

const activeActions = new Map<string, ActiveAction>();

/** Register a gated tool call for the whole of its life, so a Stop can still
 *  reach it after the teammate approves: the approval waiter is gone by then,
 *  and the customer reply or the Stripe execution turn runs outside the
 *  parent run's cancel. Registered before the card is published, so there is
 *  no window between the decision and the action where a Stop finds nothing. */
export function beginDiscussionAction(
  discussionId: string,
  toolCallId: string,
): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  activeActions.set(toolCallId, { discussionId, controller });
  return {
    signal: controller.signal,
    release: () => {
      activeActions.delete(toolCallId);
    },
  };
}

export function abortDiscussionActions(discussionId: string): number {
  let n = 0;
  for (const action of activeActions.values()) {
    if (action.discussionId !== discussionId) continue;
    action.controller.abort();
    n++;
  }
  return n;
}

// --- Session mapping -------------------------------------------------------

async function findDiscussionSession(discussionId: string) {
  const { getCachedSessionsAsync } = await import("../../server/session-cache");
  return (await getCachedSessionsAsync())
    .filter((s) => s.plainDiscussionId === discussionId && !s.archived)
    .sort(
      (a, b) =>
        new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime(),
    )[0];
}

export function discussionOpeningPrompt(
  discussion: Pick<DiscussionRef, "id" | "threadId">,
  message: string,
): string {
  const preamble = wrapContext(
    [
      `You are answering a teammate inside a Plain "Ask Sidekick" discussion (${discussion.id}).`,
      `Your final reply of every turn is posted to that discussion as Markdown; keep it concise, in English, and lead with the answer.`,
      `Nothing in the discussion reaches the customer.`,
      discussion.threadId
        ? `The discussion was opened on support thread ${discussion.threadId}; its context follows.`
        : `The discussion was opened from Plain's home, not on a thread.`,
      `To send a reply to the customer, or to run a Stripe refund/cancellation, use the opensession-plain-discussion tools. They show the teammate an Approve/Deny card in Plain and wait for the decision — never claim to have sent or refunded anything you did not do through them.`,
      `The teammate can only see this discussion, not ${productName()}; put everything they need in your reply.`,
    ].join("\n"),
    "preamble",
  );
  return `${preamble}\n\n${message}`;
}

async function createDiscussionSession(
  discussion: DiscussionRef,
  message: string,
): Promise<string> {
  const { getSessionControl } = await import("../../server/session-control");
  let workspaceId: string | undefined;
  if (discussion.threadId) {
    const { resolvePlainWorkspace } =
      await import("../../server/workspace-resolve");
    const { workspace } = await resolvePlainWorkspace({
      threadId: discussion.threadId,
      createdBy: "Plain",
    });
    workspaceId = workspace.id;
  }
  const { id } = await getSessionControl().createSession({
    prompt: discussionOpeningPrompt(discussion, message),
    mode: "ask",
    workspaceId,
    plainDiscussionId: discussion.id,
    user: PLAIN_ACTOR,
  });
  return id;
}

// --- Auto-triage discussions ----------------------------------------------

/** The agent's own opening message on an auto-triage discussion; it comes
 *  back INBOUND, so shouldAnswer never treats it as a person's turn. */
export const TRIAGE_DISCUSSION_SEED =
  "Auto-triage started. The run's tool calls and its summary land here; the " +
  "diagnosis is posted as an internal note as before. Ask a follow-up in this " +
  "discussion to keep investigating with the same context.";

/** Only the internal Plain event dispatch may open a triage discussion.
 * Public webhook JSON is data, never authority to select a discussion. */
export function triageDiscussionThread(input: {
  trigger: string;
  eventKey?: string;
  eventContext?: string;
}): string | undefined {
  if (input.trigger !== "event" || input.eventKey !== "plain:thread_created")
    return undefined;
  try {
    const payload = JSON.parse(input.eventContext || "null");
    return typeof payload?.threadId === "string" && payload.threadId.trim()
      ? payload.threadId
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Open the discussion an auto-triage run reports into, on the ticket it
 * triages. The run mirrors its tool calls and final message here exactly as
 * an Ask Sidekick session does, and a later message in the discussion is
 * delivered into that same session. Best effort: triage never waits on it,
 * so a failure (no agent key, Plain down) means a run with no discussion.
 *
 * `existingId` is the discussion a previous attempt at this same run already
 * opened (recorded in its durable intent): a replay after a crash reports
 * into it again instead of leaving it in progress and opening a second one.
 * `onCreated` is how the caller records a new id durably; it runs as soon as
 * Plain returns the id, before the status update is awaited, so a process
 * exit during that second call cannot lose the discussion to a replay.
 */
export async function openTriageDiscussion(
  threadId: string,
  existingId?: string,
  onCreated?: (id: string) => unknown,
): Promise<string | undefined> {
  if (!discussionAgentConfigured()) return undefined;
  try {
    const id =
      existingId ||
      (await createDiscussion({
        threadId,
        markdownContent: TRIAGE_DISCUSSION_SEED,
      }));
    if (id !== existingId) {
      try {
        await onCreated?.(id);
      } catch (e) {
        // The run still reports into the discussion; only a replay after a
        // crash could open a second one.
        console.warn(`[plain] Could not record discussion ${id}:`, e);
      }
    }
    await withDiscussionOrder(id, () =>
      updateDiscussionAgentStatus(id, "IN_PROGRESS"),
    ).catch(() => {});
    return id;
  } catch (e) {
    console.warn(`[plain] Could not open a discussion on ${threadId}:`, e);
    return undefined;
  }
}

/** One lifecycle event at a time per discussion. `createSession` resolves
 *  once the session is announced, so a message that lands while the first
 *  one is still creating waits here and is then delivered into that session
 *  instead of racing it (and losing). Stop rides the same chain: pressed
 *  during creation it waits for the announce and then cancels that session,
 *  instead of finding nothing and letting the run answer anyway. Both join
 *  the chain before their first network call, so webhook arrival order is
 *  the chain order (`agentMachineUserId` is one shared promise). */
const withMessageOrder = keyedOrder();

async function failTurn(discussionId: string, reason: string): Promise<void> {
  await withDiscussionOrder(discussionId, async () => {
    await sendDiscussionMessage(discussionId, reason).catch(() => {});
    await updateDiscussionAgentStatus(discussionId, "IDLE").catch(() => {});
  });
}

async function onMessageCreated(
  payload: DiscussionMessageCreatedPayload,
): Promise<void> {
  const me = await agentMachineUserId();
  if (!shouldAnswer(payload, me)) return;
  const { discussion, message } = payload;
  if (seenBefore(message.id)) return;
  const text = message.markdown.trim();
  if (!text) return;

  await withMessageOrder(discussion.id, async () => {
    // Inside the chain: a Stop that lands while this status update is in
    // flight must queue behind the message, not overtake it and find nothing.
    await withDiscussionOrder(discussion.id, () =>
      updateDiscussionAgentStatus(discussion.id, "IN_PROGRESS"),
    ).catch((e) =>
      console.warn(
        `[plain] discussion ${discussion.id} IN_PROGRESS failed:`,
        e,
      ),
    );
    try {
      const existing = await findDiscussionSession(discussion.id);
      if (existing) {
        const { getSessionControl } =
          await import("../../server/session-control");
        const result = await getSessionControl().deliverToSession(
          existing.id,
          text,
          PLAIN_ACTOR,
          { deliveryId: `plain-discussion:${message.id}` },
        );
        if (result.status === "error")
          throw new Error(result.message || "delivery failed");
        console.log(
          `[plain] Discussion ${discussion.id} → session ${existing.id} (${result.status})`,
        );
        return;
      }
      const id = await createDiscussionSession(discussion, text);
      console.log(`[plain] Discussion ${discussion.id} → new session ${id}`);
    } catch (e) {
      console.error(`[plain] Discussion ${discussion.id} turn failed:`, e);
      await failTurn(
        discussion.id,
        `I could not start on this: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });
}

async function onTurnStopRequested(
  payload: DiscussionTurnStopRequestedPayload,
): Promise<void> {
  const { discussion } = payload;
  const me = await agentMachineUserId();
  if (discussion.agent?.id !== me) return;
  // A waiting approval card is released right away, and an approved action
  // still executing (a customer reply, a Stripe execution turn) is aborted;
  // the session cancel queues behind any creation or delivery still in
  // flight for this discussion, so a Stop during creation reaches the
  // announced session.
  const cancelledApprovals = cancelApprovalsFor(discussion.id);
  const abortedActions = abortDiscussionActions(discussion.id);
  await withMessageOrder(discussion.id, async () => {
    const session = await findDiscussionSession(discussion.id);
    const { getSessionControl } = await import("../../server/session-control");
    const cancelled = session
      ? await getSessionControl().cancelSession(session.id)
      : false;
    console.log(
      `[plain] Stop on discussion ${discussion.id}: session ${session?.id ?? "none"}, cancelled=${cancelled}, approvals=${cancelledApprovals}, actions=${abortedActions}`,
    );
    // A cancelled run ends its turn and the mirror reports IDLE; with nothing
    // running the status has to be settled here.
    if (!cancelled)
      await withDiscussionOrder(discussion.id, () =>
        updateDiscussionAgentStatus(discussion.id, "IDLE"),
      ).catch(() => {});
  });
}

function onApprovalResolved(payload: DiscussionApprovalResolvedPayload): void {
  const outcome: ApprovalOutcome =
    payload.status === "APPROVED"
      ? { status: "APPROVED", reviewerNote: payload.reviewerNote }
      : { status: "DENIED", reviewerNote: payload.reviewerNote };
  const matched = resolveApproval(payload.toolCallId, outcome);
  console.log(
    `[plain] Approval ${payload.status} for ${payload.toolCallId} on discussion ${payload.discussion.id}${matched ? "" : " (no tool waiting — restarted since?)"}`,
  );
}

/** Ack first, work after: Plain retries a slow webhook. */
export function handleDiscussionEvent(webhook: DiscussionWebhook): Response {
  if (!discussionAgentConfigured()) {
    console.log(`[plain] Ignoring ${webhook.type}: no agent API key`);
    return Response.json({ ok: true });
  }
  const log = (e: unknown) =>
    console.error(`[plain] ${webhook.type} handler failed:`, e);
  switch (webhook.type) {
    case "discussion.message_created":
      void onMessageCreated(
        webhook.payload as DiscussionMessageCreatedPayload,
      ).catch(log);
      break;
    case "discussion.turn_stop_requested":
      void onTurnStopRequested(
        webhook.payload as DiscussionTurnStopRequestedPayload,
      ).catch(log);
      break;
    case "discussion.tool_call_approval_resolved":
      onApprovalResolved(webhook.payload as DiscussionApprovalResolvedPayload);
      break;
    default:
      break;
  }
  return Response.json({ ok: true });
}
