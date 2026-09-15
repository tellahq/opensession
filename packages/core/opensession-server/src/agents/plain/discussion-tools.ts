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
import { findSession } from "../../server/session-cache";
import {
  requestDiscussionToolCallApproval,
  upsertDiscussionToolCall,
  withDiscussionOrder,
} from "./discussion-api";
import {
  awaitApproval,
  resolveApproval,
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
        "reply_to_customer",
        "Send a reply to the customer on the support thread, after the teammate approves it in Plain. Shows them the exact text on an Approve/Deny card and waits for the decision; on approval the reply is sent and the thread is snoozed as waiting for the customer. Nothing is sent on a denial. Use only when the teammate asked for a reply to go out.",
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
          try {
            const outcome = await openGate(gate, args.text);
            if (outcome.status !== "APPROVED")
              return text(await explainNoGo(gate, outcome));
            const { getThreadWithMessages, sendCustomerReply, plain } =
              await import("./api");
            const thread = await getThreadWithMessages(threadId);
            const customerId: string | undefined = thread?.customer?.id;
            if (!customerId) throw new Error(`No customer on ${threadId}`);
            const sent = await sendCustomerReply(
              threadId,
              customerId,
              args.text,
            );
            if (!sent.ok) throw new Error("Plain rejected the reply");
            const { SnoozeStatusDetail } =
              await import("@team-plain/typescript-sdk");
            await plain
              .snoozeThread({
                threadId,
                statusDetail: SnoozeStatusDetail.WaitingForCustomer,
              })
              .catch(() => {});
            await closeGate(gate, "SUCCESS", "sent");
            return text(
              `Reply sent to the customer on ${threadId}; the thread is waiting for the customer.`,
            );
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            await closeGate(gate, "ERROR", message);
            return text(`Sending the reply failed: ${message}`);
          }
        },
      ),
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
            const { executeApprovedStripeAction } = await import("./handlers");
            const result = await executeApprovedStripeAction(
              args.proposal,
              threadContext,
              "discussion",
            );
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
            return text(
              `The Stripe execution failed: ${message}. No money moved if Stripe was not reached — verify in Stripe.`,
            );
          }
        },
      ),
    ],
  });
}
