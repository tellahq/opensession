/**
 * Approval-gated actions for a Plain discussion session — the customer-facing
 * and money-moving steps that a triage note used to park behind a second
 * "@<handle> yes" note. Each tool reports itself as a PENDING tool call,
 * asks Plain for approval (the teammate sees an Approve/Deny card in the
 * discussion) and blocks until the decision arrives by webhook.
 *
 * Only a session with `plainDiscussionId` carries this server
 * (interactive-mcp.ts / the opening turn in session-create.ts).
 */
import { z } from "zod";
import { createSdkMcpServer, tool } from "../../server/inprocess-mcp";
import { productName } from "../../server/config";
import { findSession } from "../../server/session-cache";
import { stripeApprovalsEnforced } from "../../server/stripe-approvals";
import {
  QUESTION_LIMITS,
  requestDiscussionQuestion,
  requestDiscussionToolCallApproval,
  upsertDiscussionToolCall,
  withDiscussionOrder,
} from "./discussion-api";
import {
  awaitApproval,
  awaitQuestion,
  beginDiscussionAction,
  hasPendingQuestion,
  resolveApproval,
  resolveQuestion,
  type ApprovalOutcome,
} from "./discussions";

const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

interface GateContext {
  discussionId: string;
  toolCallId: string;
  heading: string;
}

/** A Stop that landed after the approval, while the action was executing. */
class StoppedError extends Error {
  constructor() {
    super("The teammate stopped the turn.");
  }
}

function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new StoppedError();
}

async function openGate(
  ctx: GateContext,
  justification: string,
): Promise<ApprovalOutcome> {
  // Wait before publishing: a teammate can decide the card while the
  // approval mutation's response is still in flight, and that webhook has
  // to find a waiter or the tool sits out the whole timeout.
  const decision = awaitApproval(
    ctx.discussionId,
    ctx.toolCallId,
    APPROVAL_TIMEOUT_MS,
  );
  try {
    await withDiscussionOrder(ctx.discussionId, async () => {
      await upsertDiscussionToolCall({
        discussionId: ctx.discussionId,
        toolCallId: ctx.toolCallId,
        status: "PENDING",
        text: ctx.heading,
      });
      await requestDiscussionToolCallApproval({
        discussionId: ctx.discussionId,
        toolCallId: ctx.toolCallId,
        justification,
      });
    });
  } catch (e) {
    resolveApproval(ctx.toolCallId, { status: "CANCELLED" });
    throw e;
  }
  return decision;
}

async function closeGate(
  ctx: GateContext,
  status: "SUCCESS" | "ERROR",
  detail: string,
): Promise<void> {
  await withDiscussionOrder(ctx.discussionId, () =>
    upsertDiscussionToolCall({
      discussionId: ctx.discussionId,
      toolCallId: ctx.toolCallId,
      status,
      text: status === "SUCCESS" ? `${ctx.heading} — ${detail}` : ctx.heading,
      ...(status === "ERROR" ? { error: detail } : {}),
    }),
  ).catch((e) =>
    console.warn(`[plain] closing tool call ${ctx.toolCallId} failed:`, e),
  );
}

/** The model-facing verdict for a decision that stops the action. A denial
 *  is Plain's to close: it already failed the call with the reviewer note. */
export async function explainNoGo(
  ctx: GateContext,
  outcome: Exclude<ApprovalOutcome, { status: "APPROVED" }>,
): Promise<string> {
  switch (outcome.status) {
    case "DENIED":
      return `The teammate denied this${outcome.reviewerNote ? `: ${outcome.reviewerNote}` : "."} Do not do it; revise or ask what they want instead.`;
    case "CANCELLED":
      await closeGate(ctx, "ERROR", "The teammate stopped the turn.");
      return "The teammate stopped the turn before deciding. Nothing was done.";
    case "TIMEOUT":
      await closeGate(ctx, "ERROR", "No decision within 30 minutes.");
      return "No decision arrived within 30 minutes. Nothing was done; ask again if it is still needed.";
  }
}

export function createPlainDiscussionMcpServer(ctx: {
  sessionId: string;
  discussionId: string;
}) {
  const threadFor = (explicit?: string) =>
    explicit?.trim() || findSession(ctx.sessionId)?.plainThreadId || undefined;

  return createSdkMcpServer({
    name: "opensession-plain-discussion",
    version: "1.0.0",
    tools: [
      tool(
        "ask_teammate",
        "Ask the teammate in this Plain discussion to choose before you carry on: Plain shows a card with each question and its options, plus its own Other box and Skip. Waits for the answer and returns it. Use it when a real choice blocks you (which invoice, which account, which of two fixes), not for yes/no on an action: reply_to_customer and execute_stripe_action carry their own Approve/Deny card. Never call it in an unattended run nobody is watching.",
        {
          questions: z
            .array(
              z.object({
                question: z.string().min(1).max(QUESTION_LIMITS.questionChars),
                isMultiSelect: z
                  .boolean()
                  .optional()
                  .describe("Let the teammate pick more than one option."),
                options: z
                  .array(
                    z.object({
                      label: z
                        .string()
                        .min(1)
                        .max(QUESTION_LIMITS.labelChars)
                        .describe("Unique within the question."),
                      description: z
                        .string()
                        .min(1)
                        .max(QUESTION_LIMITS.descriptionChars),
                    }),
                  )
                  .min(QUESTION_LIMITS.optionsMin)
                  .max(QUESTION_LIMITS.optionsMax)
                  .describe(
                    "Recommended option first. Do not add an Other option; Plain adds one.",
                  ),
              }),
            )
            .min(1)
            .max(QUESTION_LIMITS.questionsPerAsk),
        },
        async (args: {
          questions: Array<{
            question: string;
            isMultiSelect?: boolean;
            options: Array<{ label: string; description: string }>;
          }>;
        }) => {
          if (hasPendingQuestion(ctx.discussionId))
            return text(
              "A question card is already open in this discussion. Wait for its answer.",
            );
          // Wait before publishing, as with approvals: the answer webhook
          // must find a waiter.
          const answer = awaitQuestion(ctx.discussionId, APPROVAL_TIMEOUT_MS);
          try {
            await withDiscussionOrder(ctx.discussionId, () =>
              requestDiscussionQuestion({
                discussionId: ctx.discussionId,
                questions: args.questions,
              }),
            );
          } catch (e) {
            resolveQuestion(ctx.discussionId, { status: "CANCELLED" });
            return text(
              `Could not show the question: ${e instanceof Error ? e.message : String(e)}. Ask in your reply instead.`,
            );
          }
          const outcome = await answer;
          switch (outcome.status) {
            case "ANSWERED":
              return text(`The teammate answered:\n\n${outcome.answer}`);
            case "DISMISSED":
              return text(
                "The teammate skipped the question. Do not guess; end the turn and wait for their next message.",
              );
            case "CANCELLED":
              return text("The teammate stopped the turn before answering.");
            case "TIMEOUT":
              return text(
                "No answer within 30 minutes. End the turn; the teammate can answer in a new message.",
              );
          }
        },
      ),
      tool(
        "reply_to_customer",
        "Send a reply to the customer on the support thread, after the teammate approves it in Plain. Shows them the exact text on an Approve/Deny card and waits for the decision; on approval the reply is sent under the approving teammate's name when Plain allows it (otherwise as the support machine user) and the thread is snoozed as waiting for the customer. Nothing is sent on a denial. Use only when the teammate asked for a reply to go out.",
        {
          text: z
            .string()
            .min(1)
            .max(10_000)
            .describe("The reply, in the customer's language, ready to send."),
          threadId: z
            .string()
            .optional()
            .describe(
              "Plain thread id (th_…). Defaults to the thread this discussion was opened on.",
            ),
        },
        async (args: { text: string; threadId?: string }) => {
          const threadId = threadFor(args.threadId);
          if (!threadId)
            return text(
              "This discussion is not on a thread. Pass threadId explicitly.",
            );
          const gate: GateContext = {
            discussionId: ctx.discussionId,
            toolCallId: `reply-${crypto.randomUUID()}`,
            heading: `Send a reply to the customer on ${threadId}`,
          };
          const action = beginDiscussionAction(
            ctx.discussionId,
            gate.toolCallId,
          );
          try {
            const outcome = await openGate(gate, args.text);
            if (outcome.status !== "APPROVED")
              return text(await explainNoGo(gate, outcome));
            const { getThreadWithMessages, sendCustomerReply } =
              await import("./api");
            throwIfStopped(action.signal);
            const thread = await getThreadWithMessages(threadId);
            const customerId: string | undefined = thread?.customer?.id;
            if (!customerId) throw new Error(`No customer on ${threadId}`);
            // Last check before the write: a Stop during the thread lookup
            // must not send.
            throwIfStopped(action.signal);
            // Sent as the teammate who approved it, when the agent key may
            // impersonate them; otherwise as the machine user.
            const sent = await sendCustomerReply(
              threadId,
              customerId,
              args.text,
              {
                asUser: outcome.approvedByUserId
                  ? [{ userId: outcome.approvedByUserId }]
                  : [],
              },
            );
            if (!sent.ok)
              throw new Error(
                sent.sentAs === "user" && sent.impersonationError
                  ? `Plain did not confirm the reply (${sent.impersonationError}); check the thread before sending again`
                  : "Plain rejected the reply",
              );
            const author =
              sent.sentAs === "user"
                ? "as the teammate who approved it"
                : `as the ${productName()} machine user${sent.impersonationError ? ` (sending as the approver failed: ${sent.impersonationError})` : ""}`;
            await closeGate(
              gate,
              "SUCCESS",
              sent.sentAs === "user" ? "sent as you" : "sent",
            );
            return text(
              sent.waitingForCustomer
                ? `Reply sent to the customer on ${threadId} ${author}; the thread is waiting for the customer.`
                : `Reply sent to the customer on ${threadId} ${author}, but its status could not be set to Waiting for customer.`,
            );
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            await closeGate(gate, "ERROR", message);
            if (e instanceof StoppedError)
              return text(
                "The teammate stopped the turn before the reply went out. Nothing was sent.",
              );
            return text(`Sending the reply failed: ${message}`);
          } finally {
            action.release();
          }
        },
      ),
      // With Stripe approvals enforced the session calls the Stripe tools
      // itself and Stripe holds the action for a reviewer, so a second
      // approval card here would only ask twice.
      ...(stripeApprovalsEnforced()
        ? []
        : [
            tool(
              "execute_stripe_action",
              "Run a specific Stripe refund or subscription cancellation/update, after the teammate approves it in Plain. Describe the exact action (customer, subscription or charge, amount, reason); the card shows that description and, on approval, a dedicated execution turn with the Stripe tools carries out that action and nothing else. Propose in your reply first; call this only when the teammate asked for the action to happen.",
              {
                proposal: z
                  .string()
                  .min(1)
                  .max(4000)
                  .describe(
                    "The exact Stripe action: who, which object (sub_/ch_/pi_ id if known), amount, reason.",
                  ),
              },
              async (args: { proposal: string }) => {
                const gate: GateContext = {
                  discussionId: ctx.discussionId,
                  toolCallId: `stripe-${crypto.randomUUID()}`,
                  heading: "Run a Stripe refund/cancellation",
                };
                const action = beginDiscussionAction(
                  ctx.discussionId,
                  gate.toolCallId,
                );
                try {
                  const outcome = await openGate(gate, args.proposal);
                  if (outcome.status !== "APPROVED")
                    return text(await explainNoGo(gate, outcome));
                  const threadId = threadFor();
                  let threadContext = "";
                  if (threadId) {
                    const { getThreadWithMessages, formatThreadContext } =
                      await import("./api");
                    threadContext = formatThreadContext(
                      await getThreadWithMessages(threadId),
                      true,
                    );
                  }
                  const { executeApprovedStripeAction } =
                    await import("./handlers");
                  // Last check before the execution turn starts; once it runs, a
                  // Stop aborts it through the engine's own cancel path.
                  throwIfStopped(action.signal);
                  const result = await executeApprovedStripeAction(
                    args.proposal,
                    threadContext,
                    "discussion",
                    action.signal,
                  );
                  if (action.signal.aborted) {
                    await closeGate(
                      gate,
                      "ERROR",
                      "The teammate stopped the turn.",
                    );
                    return text(
                      `The teammate stopped the turn while the Stripe execution was running; it was aborted. Verify in Stripe whether anything went through before telling the customer.\n\n${result}`,
                    );
                  }
                  const failed = /^error\b/i.test(result.trim());
                  await closeGate(
                    gate,
                    failed ? "ERROR" : "SUCCESS",
                    failed ? result : "done",
                  );
                  return text(
                    `Execution turn finished${failed ? " with an error" : ""}. Verify in Stripe before telling the customer.\n\n${result}`,
                  );
                } catch (e) {
                  const message = e instanceof Error ? e.message : String(e);
                  await closeGate(gate, "ERROR", message);
                  if (e instanceof StoppedError)
                    return text(
                      "The teammate stopped the turn before the Stripe execution started. Nothing was done.",
                    );
                  return text(
                    `The Stripe execution failed: ${message}. No money moved if Stripe was not reached — verify in Stripe.`,
                  );
                } finally {
                  action.release();
                }
              },
            ),
          ]),
    ],
  });
}
