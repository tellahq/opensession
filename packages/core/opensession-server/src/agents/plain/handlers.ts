/**
 * Plain agent webhook and mention handlers.
 */
import { SnoozeStatusDetail } from "@team-plain/typescript-sdk";
import {
  getThreadWithMessages,
  postNote,
  sendCustomerReply,
  formatThreadContext,
  cleanDraftText,
  createLinearIssue,
  plain,
} from "./api";
import {
  buildMentionPrompt,
  buildWorkPrompt,
  buildRefundExecutionPrompt,
} from "./prompts";
import { getDefaultModel, toPiModel } from "../../server/models";
import { runAgent } from "../../server/agent-runner";
import { STRIPE_CONFIRM_TOOLS } from "../../server/runner-shared";
import { classifyRefundApproval } from "./refund-intent";
import { createWorktree as createRepoWorktree } from "../../server/worktree";
import {
  configuredIntegration,
  defaultRepo,
  personaName,
  productName,
} from "../../server/config";

const DEFAULT_REPO_DIR = defaultRepo().repo;
const configuredMention = configuredIntegration("plain").mentionHandle;
const PLAIN_MENTION =
  typeof configuredMention === "string" && configuredMention.trim()
    ? `@${configuredMention.trim().replace(/^@/, "")}`
    : `@${personaName().toLowerCase().replace(/\s+/g, "-")}`;
const PLAIN_MENTION_RE = new RegExp(
  PLAIN_MENTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  "gi",
);

// --- State ---

const processedMessages = new Set<string>();

interface ActiveSession {
  threadId: string;
  customerId: string;
  branch: string;
  worktreeDir: string;
  claudeSessionId: string | null;
  linearIssueId?: string;
  linearIssueIdentifier?: string;
}
export const activeSessions = new Map<string, ActiveSession>();

interface PendingConfirmation {
  threadId: string;
  customerId: string;
  type: "customer_reply";
  draftText: string;
  timestamp: number;
}
export const pendingConfirmations = new Map<string, PendingConfirmation>();

// --- Webhook payload type ---

export interface PlainWebhookPayload {
  type: string;
  timestamp: string;
  workspaceId: string;
  payload: {
    thread: {
      id: string;
      externalId?: string;
      title?: string;
      previewText?: string;
      status: string;
      customer: {
        id: string;
        email?: { email: string };
        fullName?: string;
        externalId?: string;
      };
    };
    previousThread?: { id: string; status: string };
    email?: {
      id: string;
      to: { email: string; name?: string };
      from: { email: string; name?: string };
      subject?: string;
      textContent?: string;
      markdownContent?: string;
      createdBy?: { actorType: "customer" | "user" | "machineUser" | "system" };
    };
    chat?: {
      id: string;
      text?: string;
      createdBy?: { actorType: "customer" | "user" | "machineUser" | "system" };
    };
    note?: {
      id: string;
      text?: string;
      markdown?: string;
      createdBy?: { actorType: "customer" | "user" | "machineUser" | "system" };
    };
  };
}

// --- Agent runner (pi engine) ---

/** Deny message for the money-moving Stripe tools on unattended Plain runs —
 *  stripped from the tool list at the engine layer (runToolPolicy). */
const MONEY_TOOLS_DENY_MSG =
  `Money-moving Stripe actions (refunds/cancellations) can't run from a normal ${PLAIN_MENTION} note. ` +
  `They must be proposed by triage and then approved with an explicit '${PLAIN_MENTION} go ahead' on that proposal. ` +
  "Describe the proposed action instead.";

async function runWorkTurn(
  prompt: string,
  cwd: string = DEFAULT_REPO_DIR,
  resumeSessionId?: string,
  // Money-moving Stripe tools (refunds/cancellations) are denied unless this is
  // the approved "@<bot> go ahead" execution path. Closes the gap where any
  // mention note ran with every tool — including Stripe writes — allowed.
  allowMoneyTools: boolean = false,
): Promise<{ result: string; sessionId: string }> {
  console.log(
    `[plain] Running agent in ${cwd}${resumeSessionId ? ` (resuming ${resumeSessionId})` : ""}${allowMoneyTools ? " [money tools UNLOCKED]" : ""}`,
  );

  let result = "";
  let sessionId = resumeSessionId || "";

  try {
    for await (const event of runAgent({
      prompt,
      sessionId: resumeSessionId || undefined,
      cwd,
      mode: "code",
      model: toPiModel(getDefaultModel()),
      // Every configured connector, as this loop has always run. Untrusted
      // ticket text reaches it, so the containment is the deny-set below +
      // per-server allowedUsers — not the mount list. Narrow this to the
      // servers triage actually calls if that stops feeling like enough.
      mcpServers: "all",
      // Kind "plain" = unattended on the pi engine: untrusted customer
      // ticket text, so the deny-set below is stripped at the tool-list layer.
      // Kind-only journal (no osSessionId) — this loop tracks its own engine
      // session ids and must not be generically resumed after a restart.
      journal: { kind: "plain" },
      // Runner-layer MCP gate runs with NO user (runAgent passes user through
      // filterMcpServers): Plain runs are automation-like, so any
      // `allowedUsers`-restricted server stays fail-closed invisible here.
      deniedTools: allowMoneyTools
        ? undefined
        : Object.fromEntries(
            Object.keys(STRIPE_CONFIRM_TOOLS).map((name) => [
              name,
              MONEY_TOOLS_DENY_MSG,
            ]),
          ),
    })) {
      if (event.type === "init") {
        sessionId = event.sessionId || sessionId;
      }
      if (event.type === "done") {
        sessionId = event.sessionId || sessionId;
        result = event.result || "";
        console.log(`[plain] Agent finished. Session ID: ${sessionId}`);
      }
      if (event.type === "error") {
        result = `Error: ${event.content || "Unknown"}`;
      }
    }
  } catch (e: any) {
    console.error(`[plain] agent run error:`, e);
    result = `Error: ${e.message || String(e)}`;
  }

  return { result, sessionId };
}

// --- Worktree creation ---

async function createWorktree(
  branch: string,
  _ticketId: string,
  _title: string,
  _description: string,
): Promise<string> {
  const worktreeDir = await createRepoWorktree(branch, defaultRepo().id);
  console.log(`[plain] Created worktree: ${branch}`);
  return worktreeDir;
}

// --- Handlers ---

async function handleAgentMention(
  threadId: string,
  customerId: string,
  noteText: string,
  thread: any,
): Promise<void> {
  console.log(
    `[plain] Processing ${PLAIN_MENTION} mention in thread ${threadId}`,
  );

  const request = noteText.replace(PLAIN_MENTION_RE, "").trim();

  // Check for confirmation of pending actions
  const pending = pendingConfirmations.get(threadId);
  if (
    pending &&
    (request.toLowerCase().includes("yes") ||
      request.toLowerCase().includes("send") ||
      request.toLowerCase().includes("confirm") ||
      request.toLowerCase().includes("create"))
  ) {
    pendingConfirmations.delete(threadId);

    if (pending.type === "customer_reply") {
      const sent = await sendCustomerReply(
        threadId,
        customerId,
        pending.draftText,
      );
      if (sent.ok) {
        try {
          await plain.snoozeThread({
            threadId,
            statusDetail: SnoozeStatusDetail.WaitingForCustomer,
          });
          await postNote(
            threadId,
            customerId,
            "✓ Reply sent to customer. Thread set to Waiting for Customer.",
          );
        } catch (e) {
          console.error("Error setting thread status:", e);
          await postNote(threadId, customerId, "✓ Reply sent to customer.");
        }
      } else {
        await postNote(
          threadId,
          customerId,
          "✗ Failed to send reply to customer.",
        );
      }
      return;
    }
  }

  const threadContext = formatThreadContext(thread, true);

  // Refund/cancellation approval: a teammate approving a refund the agent proposed
  // earlier in this thread. Fail-closed classifier; only this path unlocks the
  // Stripe money tools, and only to execute the EXACT proposed action.
  const refundVerdict = await classifyRefundApproval(request, threadContext);
  if (refundVerdict.approve) {
    console.log(
      `[plain] Refund go-ahead on thread ${threadId}: ${refundVerdict.reason}`,
    );
    try {
      const { result } = await runWorkTurn(
        buildRefundExecutionPrompt(request, threadContext),
        DEFAULT_REPO_DIR,
        undefined,
        /*allowMoneyTools*/ true,
      );
      // If it produced a customer draft, route it through the existing
      // "@<bot> yes - to send" confirmation; otherwise post its note as-is.
      const draftMatch = result.match(
        /DRAFT REPLY:\s*([\s\S]*?)(?:$|(?=\n##|\n---))/i,
      );
      if (draftMatch) {
        const draft = cleanDraftText(draftMatch[1]);
        const summary = result.slice(0, draftMatch.index).trim();
        if (summary) await postNote(threadId, customerId, summary);
        pendingConfirmations.set(threadId, {
          threadId,
          customerId,
          type: "customer_reply",
          draftText: draft,
          timestamp: Date.now(),
        });
        await postNote(
          threadId,
          customerId,
          `**Draft reply for customer:**\n\n${draft}\n\n---\n\n${PLAIN_MENTION} yes - to send this reply`,
          `**Draft reply for customer:**\n\n${draft}\n\n---\n\n*${PLAIN_MENTION} yes* - to send this reply`,
        );
      } else {
        await postNote(threadId, customerId, result);
      }
    } catch (e) {
      console.error("[plain] Error executing approved refund:", e);
      await postNote(
        threadId,
        customerId,
        `Error executing the approved refund: ${e}. No money was moved if Stripe wasn't reached — please verify in Stripe.`,
      );
    }
    return;
  }

  const prompt = buildMentionPrompt(request, threadContext);

  try {
    const { result } = await runWorkTurn(prompt);

    console.log(
      `[plain] Claude response (first 500 chars): ${result.substring(0, 500)}`,
    );

    // Draft reply
    if (result.includes("DRAFT REPLY:")) {
      const draftMatch = result.match(
        /DRAFT REPLY:\s*([\s\S]*?)(?:$|(?=\n##|\n---))/i,
      );
      if (draftMatch) {
        const draft = cleanDraftText(draftMatch[1]);
        if (!draft) {
          console.log("[plain] WARNING: Draft was empty after cleaning!");
        }
        pendingConfirmations.set(threadId, {
          threadId,
          customerId,
          type: "customer_reply",
          draftText: draft,
          timestamp: Date.now(),
        });

        await postNote(
          threadId,
          customerId,
          `**Draft reply for customer:**\n\n${draft}\n\n---\n\n${PLAIN_MENTION} yes - to send this reply`,
          `**Draft reply for customer:**\n\n${draft}\n\n---\n\n*${PLAIN_MENTION} yes* - to send this reply`,
        );
        return;
      }
    }

    // Code work
    if (result.includes("CODE WORK NEEDED:")) {
      const codeMatch = result.match(
        /CODE WORK NEEDED:\s*([\s\S]*?)(?:$|(?=\n\n[A-Z]))/i,
      );
      if (codeMatch) {
        const codeDescription = codeMatch[1].trim();
        await postNote(
          threadId,
          customerId,
          `**Code work suggested:**\n\n${codeDescription}\n\n---\n\n${PLAIN_MENTION} start worktree - to begin working on this`,
          `**Code work suggested:**\n\n${codeDescription}\n\n---\n\n*${PLAIN_MENTION} start worktree* - to begin working on this`,
        );
        return;
      }
    }

    // Linear issue
    if (result.includes("LINEAR ISSUE:")) {
      const issueMatch = result.match(
        /LINEAR ISSUE:\s*([\s\S]*?)(?:$|(?=\n\n[A-Z]))/i,
      );
      if (issueMatch) {
        const issueText = issueMatch[1].trim();
        const titleMatch = issueText.match(/Title:\s*(.+?)(?:\n|$)/i);
        const descMatch = issueText.match(/Description:\s*([\s\S]*?)(?:$)/i);

        if (titleMatch) {
          const title = titleMatch[1].trim();
          const description = descMatch ? descMatch[1].trim() : issueText;

          const issue = await createLinearIssue(title, description);
          if (issue) {
            await postNote(
              threadId,
              customerId,
              `Created Linear issue: ${issue.identifier}\n${issue.url}`,
              `Created Linear issue: [${issue.identifier}](${issue.url})`,
            );
          } else {
            await postNote(
              threadId,
              customerId,
              `Failed to create Linear issue. Check Linear auth (OAuth token store / LINEAR_API_KEY) in the opensession logs.`,
            );
          }
          return;
        }
      }
    }

    // Start worktree command
    if (request.toLowerCase().includes("start worktree")) {
      const branchName = `plain-${threadId.substring(0, 8)}`;
      const title = thread.title || "Support ticket work";

      try {
        const issue = await createLinearIssue(
          title,
          `Work from Plain support thread.\n\nThread: ${threadId}\nCustomer: ${thread.customer.fullName || thread.customer.email?.email || "Unknown"}`,
        );

        if (issue) {
          const worktreeDir = await createWorktree(
            branchName,
            issue.identifier,
            title,
            result,
          );

          const session: ActiveSession = {
            threadId,
            customerId,
            branch: branchName,
            worktreeDir,
            claudeSessionId: null,
            linearIssueId: issue.id,
            linearIssueIdentifier: issue.identifier,
          };
          activeSessions.set(threadId, session);

          await postNote(
            threadId,
            customerId,
            `Started worktree for code work.\n\nBranch: ${branchName}\nLinear: ${issue.identifier} (${issue.url})\nDirectory: ${worktreeDir}\n\n${PLAIN_MENTION} work on <description> - to have me work on something in this worktree`,
            `Started worktree for code work.\n\n- **Branch:** \`${branchName}\`\n- **Linear:** [${issue.identifier}](${issue.url})\n- **Directory:** \`${worktreeDir}\`\n\n*${PLAIN_MENTION} work on \\<description\\>* - to have me work on something in this worktree`,
          );
        } else {
          await postNote(
            threadId,
            customerId,
            "Failed to create Linear issue for worktree. Check Linear auth (OAuth token store / LINEAR_API_KEY) in the opensession logs.",
          );
        }
      } catch (e) {
        console.error("Error creating worktree:", e);
        await postNote(threadId, customerId, `Failed to create worktree: ${e}`);
      }
      return;
    }

    // Work on command
    if (request.toLowerCase().startsWith("work on")) {
      const session = activeSessions.get(threadId);
      if (session) {
        const workDescription = request.replace(/^work on\s*/i, "").trim();
        await postNote(
          threadId,
          customerId,
          `Starting work: ${workDescription}\n\nI'll post updates as I make progress.`,
        );

        const workPrompt = buildWorkPrompt(workDescription, threadContext);
        const { result: workResult, sessionId } = await runWorkTurn(
          workPrompt,
          session.worktreeDir,
          session.claudeSessionId || undefined,
        );
        session.claudeSessionId = sessionId;

        await postNote(
          threadId,
          customerId,
          `Completed work.\n\n${workResult.substring(0, 1500)}${workResult.length > 1500 ? "..." : ""}`,
        );
      } else {
        await postNote(
          threadId,
          customerId,
          `No active worktree for this thread. Use '${PLAIN_MENTION} start worktree' first.`,
        );
      }
      return;
    }

    // Default: post Claude's response as a note
    await postNote(threadId, customerId, result);
  } catch (e) {
    console.error(`[plain] Error handling ${PLAIN_MENTION} mention:`, e);
    await postNote(threadId, customerId, `Error processing request: ${e}`);
  }
}

export async function processAgentMention(
  threadId: string,
  noteId: string,
  noteText: string,
): Promise<void> {
  const triggerId = `note-${noteId}`;
  if (processedMessages.has(triggerId)) {
    return;
  }
  processedMessages.add(triggerId);

  try {
    const thread = await getThreadWithMessages(threadId);
    if (!thread) {
      console.log(`[plain] Could not fetch thread ${threadId}`);
      return;
    }

    const customerId = thread.customer?.id;
    if (!customerId) {
      console.log(`[plain] No customer ID in thread`);
      return;
    }

    await handleAgentMention(threadId, customerId, noteText, thread);
  } catch (e) {
    console.error(`[plain] Error processing ${PLAIN_MENTION} mention:`, e);
  }
}

/** Actor typename of the earliest email/chat message in a thread, or null if none yet. */
function firstMessageActorType(thread: any): string | null {
  const messages = (thread?.timelineEntries?.edges || [])
    .map((e: any) => e?.node)
    .filter(
      (n: any) =>
        n?.entry?.__typename === "EmailEntry" ||
        n?.entry?.__typename === "ChatEntry",
    );
  if (messages.length === 0) return null;
  messages.sort((a: any, b: any) =>
    String(a.timestamp?.iso8601 || "").localeCompare(
      String(b.timestamp?.iso8601 || ""),
    ),
  );
  return messages[0].actor?.__typename || null;
}

/** Total timeline entries of any kind (messages, links, label/status changes). */
function threadEntryCount(thread: any): number {
  return (thread?.timelineEntries?.edges || []).length;
}

/**
 * Route a new ticket, then fire the automation event bus.
 *
 * A no-tools Haiku call (see ticket-router.ts) routes the ticket before any
 * triage automation starts a session. Confident spam → no run, just an
 * internal note explaining the skip. A very basic ask (simple refund,
 * how-do-I) → triage runs on the router's cheaper model instead of the
 * automation's default (Fable). Everything else — including router errors —
 * fails open and fires the event on the default model as before.
 */
async function gateAndFireThreadCreated(
  payload: PlainWebhookPayload,
): Promise<void> {
  const thread = payload.payload.thread;

  const { fireAutomationsForEvent, listAutomations } =
    await import("../../server/automations");

  // No subscriber, no run to protect — skip the classifier call too
  const hasSubscriber = listAutomations().some(
    (a) => a.enabled && a.eventKey === "plain:thread_created",
  );
  if (!hasSubscriber) return;

  // Outbound follow-ups fire thread_created too: when a teammate emails a
  // customer on a done thread, or the Linear integration links a thread and
  // sets it to "close the loop", Plain spins up a fresh thread — same event,
  // and thread.createdBy is the state machine either way. Two outbound shapes
  // to reject:
  //   1. First message is a teammate/bot (UserActor/MachineUserActor).
  //   2. No customer message at all — the thread was created by a Linear link
  //      / status change and any reply is outbound. The outbound EmailEntry can
  //      lag the webhook by MINUTES (seen: 147s), longer than we poll, so we
  //      can't wait for it. But a genuine inbound ticket opens WITH the
  //      customer's message as its genesis entry — so a thread that already has
  //      OTHER activity (links, labels, status) yet still no customer/teammate
  //      message after a short grace is outbound, not a ticket.
  // A truly empty thread is API lag on a real ticket: keep polling, then fail
  // open and triage (never drop a real ticket).
  let full: any = null;
  let firstActor: string | null = null;
  let outboundNoCustomer = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 15_000));
    try {
      full = await getThreadWithMessages(thread.id);
    } catch {}
    firstActor = firstMessageActorType(full);
    if (firstActor) break;
    // No message yet, but the thread already carries non-message activity
    // (link/label/status) after ~30s → outbound / close-the-loop, not a ticket.
    if (attempt >= 2 && threadEntryCount(full) > 0) {
      outboundNoCustomer = true;
      break;
    }
  }
  if (
    outboundNoCustomer ||
    firstActor === "UserActor" ||
    firstActor === "MachineUserActor"
  ) {
    const why = outboundNoCustomer
      ? "no customer message — outbound / close-the-loop thread"
      : `opened by an outbound ${firstActor === "UserActor" ? "teammate" : "bot"} message`;
    console.log(
      `[plain] Skipping auto-triage for thread ${thread.id} — ${why}, not a customer ticket`,
    );
    return;
  }

  // Give the classifier the real ticket content when we can fetch it; the
  // webhook payload (title + preview) is the fallback
  let ticketContent =
    `Title: ${thread.title || "(none)"}\n` +
    `Customer: ${thread.customer?.fullName || "(unknown)"} <${thread.customer?.email?.email || "no email"}>\n` +
    `Preview: ${thread.previewText || "(none)"}`;
  if (full) ticketContent = formatThreadContext(full, true);

  const { classifyTicketRoute, getRouterConfig } =
    await import("./ticket-router");
  const verdict = await classifyTicketRoute(ticketContent);

  if (verdict?.route === "spam") {
    console.log(
      `[plain] Skipping auto-triage for thread ${thread.id} — spam: ${verdict.reason}`,
    );
    if (thread.customer?.id) {
      await postNote(
        thread.id,
        thread.customer.id,
        `Auto-triage skipped — this ticket looks like spam.\n\nReason: ${verdict.reason}\n\nIf this is a real ticket, mention ${PLAIN_MENTION} or run the triage automation manually from ${productName()}.`,
        `**Auto-triage skipped — this ticket looks like spam.**\n\nReason: ${verdict.reason}\n\n*If this is a real ticket, mention ${PLAIN_MENTION} or run the triage automation manually from ${productName()}.*`,
      );
    }
    return;
  }

  // "basic" → run triage on the router's cheaper model; "full"/no-verdict →
  // the automation's own model (fail open, never downgrade on router errors).
  const modelOverride =
    verdict?.route === "basic" ? getRouterConfig().basicModel : undefined;
  if (modelOverride) {
    console.log(
      `[plain] Routing thread ${thread.id} to ${modelOverride} — basic: ${verdict!.reason}`,
    );
  }

  fireAutomationsForEvent(
    "plain:thread_created",
    JSON.stringify(
      {
        threadId: thread.id,
        title: thread.title || null,
        previewText: thread.previewText || null,
        status: thread.status,
        customer: {
          email: thread.customer?.email?.email || null,
          fullName: thread.customer?.fullName || null,
        },
      },
      null,
      2,
    ),
    modelOverride ? { modelOverride } : undefined,
  );
}

/**
 * A teammate's note on a thread that has a live linked session is a message
 * TO that session. Deliver it as the session's next prompt via the same
 * surface the UI composer uses (steer if busy, queue behind an external run,
 * fresh turn when idle — the queue is persisted, so unlike the old in-memory
 * one-shot a restart can't silently drop it). Returns false when there's no
 * live linked session (or delivery failed) so the caller can fall back to
 * the legacy mention flow.
 */
async function deliverNoteToLinkedSession(
  threadId: string,
  noteId: string,
  noteText: string,
): Promise<boolean> {
  const triggerId = `note-${noteId}`;
  if (processedMessages.has(triggerId)) return true;
  try {
    const { tryGetSessionControl } =
      await import("../../server/session-control");
    const { getCachedSessions } = await import("../../server/session-cache");
    const control = tryGetSessionControl();
    if (!control) return false;
    const session = getCachedSessions()
      .filter((s) => s.plainThreadId === threadId && !s.archived)
      .sort(
        (a, b) =>
          new Date(b.lastActivity).getTime() -
          new Date(a.lastActivity).getTime(),
      )[0];
    if (!session) return false;

    const request = noteText.replace(PLAIN_MENTION_RE, "").trim();
    PLAIN_MENTION_RE.lastIndex = 0;
    if (!request) return false;

    processedMessages.add(triggerId);
    const result = await control.deliverToSession(
      session.id,
      `Internal note from a teammate on this ticket's Plain thread (${threadId}):\n\n${request}\n\nAct on it. If a reply is useful, post it as an internal note on the thread.`,
      "Plain",
      { deliveryId: `plain-note:${noteId}` },
    );
    if (result.status === "error") {
      console.error(
        `[plain] Note delivery to session ${session.id} failed: ${result.message}`,
      );
      processedMessages.delete(triggerId);
      return false;
    }
    console.log(
      `[plain] Note on thread ${threadId} → session ${session.id} (${result.status})`,
    );
    return true;
  } catch (e) {
    console.error(
      `[plain] Note→session delivery failed for thread ${threadId}:`,
      e,
    );
    return false;
  }
}

export async function handleWebhook(
  payload: PlainWebhookPayload,
): Promise<Response> {
  const eventType = payload.type;
  console.log(`[plain] Webhook received: ${eventType}`);

  const thread = payload.payload.thread;
  if (!thread) {
    console.log(`[plain] No thread in payload`);
    return Response.json({ ok: true });
  }

  // Publish new tickets to the automation event bus (e.g. auto-triage),
  // behind a cheap spam gate so spam never starts an expensive session.
  // Runs async — the webhook response doesn't wait for the classifier.
  if (eventType === "thread.thread_created") {
    void gateAndFireThreadCreated(payload).catch((e) =>
      console.error("[plain] thread_created gate failed:", e),
    );
  }

  // Archive triage sessions when their ticket is done
  if (
    eventType === "thread.thread_status_transitioned" &&
    thread.status === "DONE"
  ) {
    const { archiveSessionsForThread } =
      await import("../../server/plain-archive");
    const n = await archiveSessionsForThread(thread.id);
    if (n > 0)
      console.log(
        `[plain] Archived ${n} session(s) for done thread ${thread.id}`,
      );
  }

  // Internal notes that explicitly mention the persona: a thread with a live
  // linked session gets the note delivered INTO that session (steered into a
  // busy run, queued behind it, or starting a fresh turn — persisted, so a
  // restart can't drop it). The legacy one-shot @mention flow only handles
  // threads with no session. Notes without the mention are teammate-to-
  // teammate and are left alone.
  if (eventType === "thread.note_created" && payload.payload.note) {
    const note = payload.payload.note;
    const noteText = note.text || note.markdown || "";
    const mentioned = PLAIN_MENTION_RE.test(noteText);
    PLAIN_MENTION_RE.lastIndex = 0;
    if (!mentioned) return Response.json({ ok: true });

    // SECURITY: Only act on notes from support agents (user) — never the
    // machine user's own notes (feedback loops) or customer/system actors.
    const actorType = note.createdBy?.actorType;
    if (actorType !== "user") {
      console.log(
        `[plain] Ignoring ${PLAIN_MENTION} mention from non-user actor: ${actorType}`,
      );
      return Response.json({ ok: true });
    }

    const delivered = await deliverNoteToLinkedSession(
      thread.id,
      note.id,
      noteText,
    );
    if (!delivered) {
      processAgentMention(thread.id, note.id, noteText).catch((e) =>
        console.error(`[plain] Error processing ${PLAIN_MENTION} mention:`, e),
      );
    }

    return Response.json({ ok: true });
  }

  console.log(`[plain] Ignoring event type: ${eventType}`);
  return Response.json({ ok: true });
}
