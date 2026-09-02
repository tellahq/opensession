/**
 * Slack Agent Module — handles Slack DMs, @mentions, worktree channel
 * management, and Block Kit interactions.
 *
 * Implements the AgentModule interface for the opensession webhook server.
 */

import {
  configuredIntegration,
  defaultRepo,
  personaName,
} from "../../server/config";
import { githubConfiguredCredential } from "../../server/github-app";
import { mkdirSync, existsSync, unlinkSync } from "fs";
import { timingSafeEqual } from "crypto";
import type { AgentModule } from "../types";
import { fetchWithTimeout } from "../../server/shared/fetch-with-timeout";
import { verifySlackSignature } from "../../server/shared/signature";
import {
  MAX_WEBHOOK_BODY_BYTES,
  RequestBodyTooLargeError,
  readRequestTextWithinLimit,
  webhookBodyTooLargeResponse,
} from "../../server/shared/bounded-body";
import { handleMessageEvent, handleMentionEvent } from "./handlers";
import { SlackEventInbox } from "./event-inbox";
import {
  shouldHandleAppMention,
  shouldHandleDirectMessage,
} from "./event-routing";
import { handleLinkShared } from "./unfurl";
import { inviteRelevantUsersToChannel } from "./github-reviews";
import {
  githubWebhookCompatibilityFallbackEnabled,
  handleGithubWebhook,
} from "../github/webhook-intake";
import { githubWebhookCount } from "../github/webhook-deliveries";
import {
  worktreeChannels,
  branchToChannel,
  branchToChannelName,
  loadWorktreeChannels,
  saveWorktreeChannels,
  createSlackChannel,
  archiveSlackChannel,
  setChannelTopic,
  inviteBotToChannel,
  getWorktreeDirForChannel,
} from "./worktree-channels";
import {
  interruptQueuesForRestart,
  loadQueueFromDisk,
  sessionQueues,
} from "./queue";
import { enqueueMessage, getOrCreateQueue } from "./queue";
import { cancelSession } from "./cancel";
import { cancelAgentRun } from "../../server/agent-runner";
import { worktreePathFor } from "../../server/worktree";
import { handleReportFixAction } from "./report-actions";
import {
  slackApiCall,
  sendSlackMessage,
  updateSlackBlocks,
  openSlackModal,
  openHumanAskModal,
  resolveSlackUser,
  prettifyMentions,
} from "./slack-api";
import {
  isChannelWatched,
  fireAutomationsForSlackChannel,
} from "../../server/automations";
import {
  resolveByOption as resolveHumanAsk,
  isAwaiting as isHumanAskAwaiting,
  getAsk as getHumanAsk,
} from "../../server/human-asks";
import {
  SESSION_DIR,
  GITHUB_REPO,
  activeSessions,
  isEventProcessed,
  markEventProcessed,
  loadProcessedEvents,
  pendingAnswers,
  slackTeamId,
  slackBotUserId,
  setSlackTeamId,
  setSlackBotUserId,
  loadActiveSessionsOnStartup,
} from "./state";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";

const slackEventInbox = new SlackEventInbox(`${SESSION_DIR}/event-inbox.json`, {
  handleDirectMessage: handleMessageEvent,
  handleMention: handleMentionEvent,
  isProcessed: isEventProcessed,
  markProcessed: markEventProcessed,
});

async function readWebhookBody(
  req: Request,
  maxBytes = MAX_WEBHOOK_BODY_BYTES,
): Promise<string | Response> {
  try {
    return await readRequestTextWithinLimit(req, maxBytes);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      return webhookBodyTooLargeResponse(maxBytes);
    throw error;
  }
}

/**
 * Shared-secret gate for the /worktree/* hooks. A reverse proxy fronts this
 * port with a public origin, so these routes are reachable from the open
 * internet — without this check anyone could create Slack
 * channels or archive worktree channels. Callers (the `wt` CLI) send
 * `x-worktree-secret` matching WORKTREE_HOOK_SECRET. Fail closed: no secret
 * configured means every request is rejected.
 */
function verifyWorktreeSecret(req: Request): boolean {
  const secret = process.env.WORKTREE_HOOK_SECRET || "";
  if (!secret) return false;
  const given = req.headers.get("x-worktree-secret") || "";
  const secretBuf = Buffer.from(secret);
  const givenBuf = Buffer.from(given);
  if (secretBuf.length !== givenBuf.length) return false;
  try {
    return timingSafeEqual(secretBuf, givenBuf);
  } catch {
    return false;
  }
}

/**
 * Dispatch a parsed Slack Events API callback. The HTTP `/slack/events`
 * route feeds `event_callback` JSON here so the routing lives in one place,
 * separate from signature verification and the HTTP response.
 */
export async function dispatchSlackEvent(payload: any): Promise<void> {
  if (payload.type !== "event_callback") return;
  const event = payload.event;

  if (event.type === "link_shared") {
    console.log(
      `[slack] link_shared links=${JSON.stringify((event.links || []).map((l: any) => l.url))}`,
    );
  }

  if (event.bot_id || event.subtype === "bot_message") {
    return;
  }

  // Handle message.im events (DMs)
  if (shouldHandleDirectMessage(event)) {
    const eventId = `${event.channel}-${event.ts}`;
    const result = slackEventInbox.enqueue("direct_message", event);
    if (result === "processed") {
      console.log(`[slack] Duplicate event: ${eventId}`);
    } else if (result === "pending") {
      console.log(`[slack] Pending event retry: ${eventId}`);
    }
  }

  // Channel-watch automations: one run per top-level message in a
  // watched channel (thread replies and @-mentions don't
  // re-trigger — mentions go through the interactive path below).
  if (
    event.type === "message" &&
    event.channel_type !== "im" &&
    !event.subtype &&
    !event.thread_ts &&
    !(event.text || "").includes(`<@${slackBotUserId}>`) &&
    isChannelWatched(event.channel)
  ) {
    const watchId = `watch-${event.channel}-${event.ts}`;
    if (!isEventProcessed(watchId)) {
      markEventProcessed(watchId);
      const u = event.user
        ? await resolveSlackUser(event.user)
        : { name: "Unknown", avatarUrl: undefined };
      fireAutomationsForSlackChannel(
        event.channel,
        JSON.stringify(
          {
            channel: event.channel,
            ts: event.ts,
            userId: event.user || null,
            userName: u.name,
            text: event.text || "",
            permalink: `thread ts ${event.ts} — reply in-thread via the slack MCP if your instructions say to respond`,
          },
          null,
          2,
        ),
      );
    }
  }

  // Handle app_mention events
  if (shouldHandleAppMention(event)) {
    const eventId = `${event.channel}-${event.ts}`;
    const result = slackEventInbox.enqueue("mention", event);
    if (result === "processed") {
      console.log(`[slack] Duplicate mention event: ${eventId}`);
    } else if (result === "pending") {
      console.log(`[slack] Pending mention retry: ${eventId}`);
    }
  }

  // Unfurl this instance's session links. A private host (tailnet-only,
  // VPN) is unreachable for Slack's OG-tag fetch, so we look the session
  // up in-process and post a preview via chat.unfurl. Deduped on the
  // shared message ts.
  if (event.type === "link_shared") {
    const eventId = `unfurl-${event.channel}-${event.message_ts}`;
    if (!isEventProcessed(eventId)) {
      handleLinkShared(event)
        .then(() => markEventProcessed(eventId))
        .catch((e) => {
          console.error("[slack] Error unfurling link:", e);
        });
    }
  }

  // Handle assistant_thread_started events (DM thread opened)
  if (event.type === "assistant_thread_started") {
    const thread = event.assistant_thread;
    if (thread?.channel_id && thread?.thread_ts) {
      slackApiCall("assistant.threads.setSuggestedPrompts", {
        channel_id: thread.channel_id,
        thread_ts: thread.thread_ts,
        prompts: [
          {
            title: "Check worktrees",
            message: "What worktrees are currently active?",
          },
          {
            title: "Health check",
            message: "Run a health check on all services",
          },
        ],
      }).catch((e: any) => {
        console.warn("[slack] Error setting suggested prompts:", e);
      });
    }
  }
}

/**
 * Dispatch a parsed Slack interactive payload (Block Kit buttons, modal
 * submits) from the HTTP `/slack/actions` route.
 */
export async function dispatchSlackInteractive(payload: any): Promise<void> {
  // Handle block_actions (button clicks)
  if (payload.type === "block_actions") {
    const action = payload.actions?.[0];
    if (!action) {
      return;
    }

    const actionId: string = action.action_id;

    // Check if this is an "Other..." button — must open modal BEFORE returning
    if (actionId.endsWith("-other")) {
      // Human-in-the-loop ask "Other…" — open the free-text modal.
      const haOther = actionId.match(/^humanask-(.+)-other$/);
      if (haOther?.[1]) {
        const askId = haOther[1];
        const ask = getHumanAsk(askId);
        if (ask && isHumanAskAwaiting(askId) && payload.trigger_id) {
          const r = await openHumanAskModal(
            payload.trigger_id,
            askId,
            ask.question,
          );
          if (!r?.ok) console.error("[slack] human-ask modal open failed:", r);
        }
        return;
      }
      // Extract questionId: "askq-{questionId}-other"
      const match = actionId.match(/^askq-(.+)-other$/);
      if (match?.[1]) {
        const questionId = match[1];
        const pending = pendingAnswers.get(questionId);
        if (pending) {
          const triggerId = payload.trigger_id;
          if (triggerId) {
            const modalResult = await openSlackModal(
              triggerId,
              questionId,
              pending.questionText,
            );
            if (!modalResult?.ok) {
              console.error("[slack] Failed to open modal:", modalResult);
            }
          }
        }
      }
      return;
    }

    // Regular option button — handle in background
    const optMatch = actionId.match(/^askq-(.+)-opt-(\d+)$/);
    if (optMatch?.[1]) {
      const questionId = optMatch[1];
      const selectedLabel = action.value;

      // Respond immediately, resolve in background
      setImmediate(() => {
        const pending = pendingAnswers.get(questionId);
        if (pending) {
          clearTimeout(pending.timeoutId);
          pendingAnswers.delete(questionId);
          pending.resolve(selectedLabel);
        }
      });
      return;
    }

    // Human-in-the-loop ask: resolve it, then let the ask registry replace
    // the original card with its read-only answered state.
    const haOpt = actionId.match(/^humanask-(.+)-opt-(\d+)$/);
    if (haOpt?.[1]) {
      const askId = haOpt[1];
      const label = action.value;
      setImmediate(() => resolveHumanAsk(askId, label));
      return;
    }

    // A report notification can start every proposed fix without leaving Slack.
    if (actionId === "report-fix-all") {
      await handleReportFixAction(payload, action.value);
      return;
    }

    // Stop button on a Grafana-poller investigation card — cancel the
    // automation-run session by its opensession id (registered in activeRuns
    // under the bks id, so cancelAgentRun reaches it). `investigate-stop:`
    // is the current prefix; `export-stop:`/`upload-stop:` are kept for any
    // cards posted before the generic poller landed.
    const stopPrefix = [
      "investigate-stop:",
      "export-stop:",
      "upload-stop:",
      "pr-stop:",
    ].find((p) => actionId.startsWith(p));
    if (stopPrefix) {
      const bksId = actionId.slice(stopPrefix.length);
      const didCancel = await cancelAgentRun(bksId);

      const msgChannel = payload.channel?.id;
      const msgTs = payload.message?.ts;
      if (msgTs && msgChannel) {
        const label = didCancel ? "Stopped" : "Nothing to stop";
        const keptBlocks = (payload.message?.blocks || []).filter(
          (b: any) => b.type !== "actions",
        );
        keptBlocks.push({
          type: "context",
          elements: [{ type: "mrkdwn", text: `_${label}_` }],
        });
        await updateSlackBlocks(msgChannel, msgTs, label, keptBlocks);
      }
      return;
    }

    // Stop button — cancel the running session
    if (actionId.startsWith("stop:")) {
      const sessionKey = actionId.slice("stop:".length);
      const didCancel = cancelSession(sessionKey);

      const msgChannel = payload.channel?.id;
      const msgTs = payload.message?.ts;
      if (msgTs && msgChannel) {
        const label = didCancel ? "Cancelled" : "Nothing to cancel";
        await updateSlackBlocks(msgChannel, msgTs, label, [
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: `_${label}_` }],
          },
        ]);
      }
      return;
    }

    // GitHub PR review — "Address this feedback" button
    if (actionId.startsWith("gh-review-address-")) {
      const reviewData = JSON.parse(action.value);
      const {
        branch,
        channelId: reviewChannelId,
        prNumber,
        prUrl,
        reviewerName,
        reviewState,
        reviewBody,
        inlineCommentCount,
      } = reviewData;

      // Update message to remove buttons and show status
      const msgChannel = payload.channel?.id || reviewChannelId;
      const msgTs = payload.message?.ts;
      if (msgTs) {
        const updatedBlocks = (payload.message?.blocks || []).filter(
          (b: any) => b.type !== "actions",
        );
        updatedBlocks.push({
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "\u23f3 _Addressing this feedback..._",
            },
          ],
        });
        await updateSlackBlocks(
          msgChannel,
          msgTs,
          "Addressing PR review feedback...",
          updatedBlocks,
        );
      }

      // Enqueue prompt to the worktree's Claude session
      const sessionKey = reviewChannelId;
      const worktreeDir = getWorktreeDirForChannel(reviewChannelId);
      const worktreeBranch = worktreeChannels.get(reviewChannelId);

      const prompt = `A PR review was submitted on PR #${prNumber} (${prUrl}) by ${reviewerName}.

Review type: ${reviewState}
${reviewBody ? `Review comment: "${reviewBody}"` : "No overall review comment."}
${inlineCommentCount > 0 ? `There are ${inlineCommentCount} inline comments on specific files.` : ""}

Please address this feedback:
1. Read the PR review comments by running: gh api repos/${defaultRepo().ghRepo}/pulls/${prNumber}/reviews --jq '.[-1]' and gh api repos/${defaultRepo().ghRepo}/pulls/${prNumber}/comments
2. Understand each piece of feedback
3. Make the necessary code changes to address the review
4. Commit and push the changes (ALWAYS push \u2014 never leave changes unpushed)
5. Respond to each individual review comment on the PR by posting replies via: gh api repos/${defaultRepo().ghRepo}/pulls/${prNumber}/comments/{comment_id}/replies -f body="<your response>"
6. Summarize what you changed in response to the review`;

      enqueueMessage(sessionKey, {
        prompt,
        channel: reviewChannelId,
        threadTs: msgTs || "",
        messageTs: msgTs || "",
        userName: "GitHub PR Review",
        userId: slackBotUserId,
        isNewSession: false,
        worktreeDir: worktreeDir || undefined,
        branch: worktreeBranch || undefined,
      });

      return;
    }

    // GitHub PR review — "Dismiss" button
    if (actionId.startsWith("gh-review-dismiss-")) {
      const msgChannel = payload.channel?.id;
      const msgTs = payload.message?.ts;
      if (msgTs && msgChannel) {
        const updatedBlocks = (payload.message?.blocks || []).filter(
          (b: any) => b.type !== "actions",
        );
        updatedBlocks.push({
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "\ud83d\udeab _Dismissed_",
            },
          ],
        });
        await updateSlackBlocks(
          msgChannel,
          msgTs,
          "PR review feedback dismissed",
          updatedBlocks,
        );
      }
      return;
    }

    return;
  }

  // Handle view_submission (modal submit for "Other...")
  if (payload.type === "view_submission") {
    const callbackId: string = payload.view?.callback_id || "";

    // Human-in-the-loop ask — free-text "Other…" answer.
    const haModal = callbackId.match(/^humanask-modal-(.+)$/);
    if (haModal?.[1]) {
      const askId = haModal[1];
      const answer: string =
        payload.view?.state?.values?.answer_block?.answer_input?.value || "";
      if (answer.trim())
        setImmediate(() => resolveHumanAsk(askId, answer.trim()));
      return;
    }

    const match = callbackId.match(/^askq-modal-(.+)$/);

    if (match?.[1]) {
      const questionId = match[1];
      const values = payload.view?.state?.values;
      const answerValue: string =
        values?.answer_block?.answer_input?.value || "";

      setImmediate(() => {
        const pending = pendingAnswers.get(questionId);
        if (pending) {
          clearTimeout(pending.timeoutId);
          pendingAnswers.delete(questionId);
          pending.resolve(answerValue);
        }
      });
    }

    // Must return 200 with empty body to close the modal
    return;
  }
}

/** Slack owns GitHub intake only when the independently gated GitHub agent
 * is off. Route registration and the outbound forwarder lifecycle must use the
 * same decision or a loopback-only Slack install exposes a route nobody feeds. */
export function slackOwnsGithubWebhookIntake(): boolean {
  const flag = process.env.ENABLE_GITHUB_AGENT;
  const enabled =
    flag == null
      ? configuredIntegration("github").enabled === true
      : flag === "true";
  return !enabled;
}

export class SlackAgent implements AgentModule {
  name = "slack";
  getRoutes(): Map<string, (req: Request, url: URL) => Promise<Response>> {
    const routes = new Map<
      string,
      (req: Request, url: URL) => Promise<Response>
    >();

    // GithubAgent owns this route when enabled. Retain the historical Slack-only
    // configuration by registering the same handler only when GitHub is disabled.
    if (githubWebhookCompatibilityFallbackEnabled()) {
      routes.set("POST /github/webhook", handleGithubWebhook);
    }

    // ----- POST /slack/events -----
    routes.set("POST /slack/events", async (req) => {
      // Slack retries a delivery when the original didn't get a 200 — which,
      // since we ack every event immediately below, means we were down/erroring
      // when it first arrived (e.g. mid-restart). The old code blindly acked-and-
      // dropped every retry on the assumption it was already handled, silently
      // losing any event delivered during a restart window. Instead, let retries
      // fall through to the persisted dedup check, which drops only events we
      // actually handled and processes the ones we missed.
      const retryNum = req.headers.get("x-slack-retry-num");
      if (retryNum) {
        console.log(
          `[slack] Slack retry #${retryNum} (reason: ${req.headers.get("x-slack-retry-reason")}) — routing through dedup`,
        );
      }

      const body = await readWebhookBody(req);
      if (body instanceof Response) return body;
      const timestamp = req.headers.get("x-slack-request-timestamp") || "";
      const signature = req.headers.get("x-slack-signature") || "";

      if (
        !verifySlackSignature(body, timestamp, signature, SLACK_SIGNING_SECRET)
      ) {
        console.error("[slack] Invalid Slack signature");
        return Response.json({ error: "Invalid signature" }, { status: 401 });
      }

      const payload = JSON.parse(body);

      // URL verification challenge
      if (payload.type === "url_verification") {
        console.log("[slack] URL verification challenge received");
        return Response.json({ challenge: payload.challenge });
      }

      try {
        // DMs and mentions are atomically persisted inside dispatch before we
        // acknowledge Slack. Slow API/model work runs from that durable inbox.
        await dispatchSlackEvent(payload);
      } catch (error) {
        console.error("[slack] Failed to persist or dispatch event:", error);
        return Response.json(
          { error: "Slack event intake failed" },
          { status: 503 },
        );
      }

      return Response.json({ ok: true });
    });

    // ----- POST /slack/actions (Block Kit interactions) -----
    routes.set("POST /slack/actions", async (req) => {
      const body = await readWebhookBody(req);
      if (body instanceof Response) return body;
      const timestamp = req.headers.get("x-slack-request-timestamp") || "";
      const signature = req.headers.get("x-slack-signature") || "";

      if (
        !verifySlackSignature(body, timestamp, signature, SLACK_SIGNING_SECRET)
      ) {
        console.error("[slack] Invalid Slack action signature");
        return Response.json({ error: "Invalid signature" }, { status: 401 });
      }

      // Parse URL-encoded body
      const params = new URLSearchParams(body);
      const payloadStr = params.get("payload");
      if (!payloadStr) {
        return Response.json({ error: "No payload" }, { status: 400 });
      }

      const payload = JSON.parse(payloadStr);

      await dispatchSlackInteractive(payload);

      return new Response("", { status: 200 });
    });

    // ----- POST /worktree/create-channel -----
    routes.set("POST /worktree/create-channel", async (req) => {
      if (!verifyWorktreeSecret(req)) {
        console.error(
          "[slack] Rejected /worktree/create-channel: bad or missing x-worktree-secret",
        );
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      try {
        const rawBody = await readWebhookBody(req, 64 * 1024);
        if (rawBody instanceof Response) return rawBody;
        const body = JSON.parse(rawBody) as { branch: string };
        const { branch } = body;
        if (!branch) {
          return Response.json({ error: "branch required" }, { status: 400 });
        }

        // Check if channel already exists for this branch
        if (branchToChannel.has(branch)) {
          return Response.json({
            ok: true,
            channelId: branchToChannel.get(branch),
            existing: true,
          });
        }

        const channelName = branchToChannelName(branch);
        console.log(
          `[slack] Creating Slack channel: #${channelName} for branch: ${branch}`,
        );

        const result = await createSlackChannel(channelName);
        if (!result.ok || !result.channelId) {
          console.error(
            `[slack] Failed to create channel #${channelName}:`,
            result.error,
          );
          return Response.json(
            { ok: false, error: result.error },
            { status: 500 },
          );
        }

        const channelId = result.channelId;

        // Invite bot to channel
        await inviteBotToChannel(channelId);

        // Set topic
        const worktreeDir = worktreePathFor(branch);
        const ghCompareUrl = `https://github.com/${GITHUB_REPO}/compare/main...${encodeURIComponent(branch)}`;
        await setChannelTopic(
          channelId,
          `${ghCompareUrl} | Mention @${personaName()} to interact`,
        );

        // Post intro message
        const authResp = await fetchWithTimeout(
          "https://slack.com/api/auth.test",
          {
            headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
          },
        );
        const botId = ((await authResp.json()) as any).user_id;
        await sendSlackMessage(
          channelId,
          `\ud83d\udc4b This channel is linked to worktree \`${branch}\`.\n\nMention <@${botId}> to interact with Claude working in this worktree.\n\nWorking directory: \`${worktreeDir}\``,
        );

        // Save mapping
        worktreeChannels.set(channelId, branch);
        branchToChannel.set(branch, channelId);
        await saveWorktreeChannels();

        console.log(
          `[slack] Created and linked #${channelName} (${channelId}) -> ${branch}`,
        );

        // Auto-invite relevant GitHub users (async, don't block response)
        inviteRelevantUsersToChannel(channelId, branch).catch((e) => {
          console.warn("[slack] Error auto-inviting users:", e);
        });

        return Response.json({ ok: true, channelId, channelName });
      } catch (e: any) {
        console.error("[slack] Error in /worktree/create-channel:", e);
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    });

    // ----- POST /worktree/archive-channel -----
    routes.set("POST /worktree/archive-channel", async (req) => {
      if (!verifyWorktreeSecret(req)) {
        console.error(
          "[slack] Rejected /worktree/archive-channel: bad or missing x-worktree-secret",
        );
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      try {
        const rawBody = await readWebhookBody(req, 64 * 1024);
        if (rawBody instanceof Response) return rawBody;
        const body = JSON.parse(rawBody) as { branch: string };
        const { branch } = body;
        if (!branch) {
          return Response.json({ error: "branch required" }, { status: 400 });
        }

        const channelId = branchToChannel.get(branch);
        if (!channelId) {
          return Response.json({
            ok: true,
            message: "no channel for this branch",
          });
        }

        console.log(
          `[slack] Archiving Slack channel for branch: ${branch} (${channelId})`,
        );

        // Post farewell message
        await sendSlackMessage(
          channelId,
          `\ud83d\uddc2\ufe0f Worktree \`${branch}\` is being deleted. Archiving this channel.`,
        );

        // Archive the channel
        await archiveSlackChannel(channelId);

        // Clean up mappings
        worktreeChannels.delete(channelId);
        branchToChannel.delete(branch);
        await saveWorktreeChannels();

        // Clean up any sessions for this channel
        const sessionKey = channelId;
        const session = activeSessions.get(sessionKey);
        if (session) {
          activeSessions.delete(sessionKey);
          try {
            unlinkSync(`${SESSION_DIR}/${sessionKey}.json`);
          } catch {}
        }

        console.log(
          `[slack] Archived channel and cleaned up for branch: ${branch}`,
        );

        return Response.json({ ok: true });
      } catch (e: any) {
        console.error("[slack] Error in /worktree/archive-channel:", e);
        return Response.json({ ok: false, error: e.message }, { status: 500 });
      }
    });

    return routes;
  }

  async startup(): Promise<void> {
    // Ensure session directory exists
    if (!existsSync(SESSION_DIR)) {
      mkdirSync(SESSION_DIR, { recursive: true });
    }

    await loadActiveSessionsOnStartup();
    await loadWorktreeChannels();
    await loadQueueFromDisk();
    loadProcessedEvents();

    // Fetch team ID and bot user ID for streaming APIs
    try {
      const authResp = await fetchWithTimeout(
        "https://slack.com/api/auth.test",
        {
          headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
        },
      );
      const authData = (await authResp.json()) as any;
      if (authData.ok) {
        setSlackTeamId(authData.team_id);
        setSlackBotUserId(authData.user_id);
        console.log(
          `[slack] Slack team: ${authData.team} (${authData.team_id}), bot: ${authData.user_id}`,
        );
      } else {
        console.warn("[slack] auth.test failed:", authData.error);
      }
    } catch (e) {
      console.warn("[slack] Failed to fetch Slack team info:", e);
    }

    const pendingEvents = slackEventInbox.pendingCount();
    void slackEventInbox.start().catch((error) => {
      console.error("[slack] Failed to start durable event replay:", error);
    });
    if (pendingEvents > 0) {
      console.log(`[slack] Replaying ${pendingEvents} durable event(s)`);
    }

    console.log("[slack] Agent started");
  }

  async shutdown(): Promise<void> {
    slackEventInbox.stop();
    // A server restart must not masquerade as a person's Stop action. Keep the
    // queue head on disk and let startup continue it against the saved engine
    // session; handlers render the existing card as "Restarting".
    const interrupted = interruptQueuesForRestart();
    console.log(
      `[slack] Agent shut down (${interrupted} run(s) preserved for restart)`,
    );
  }

  health(): Record<string, unknown> {
    const queueDetails: Record<
      string,
      { queueLength: number; processing: boolean }
    > = {};
    for (const [key, sq] of sessionQueues) {
      queueDetails[key] = {
        queueLength: sq.queue.length,
        processing: sq.processing,
      };
    }

    const githubWebhookHealth = githubWebhookCompatibilityFallbackEnabled()
      ? {
          githubWebhookConfigured: !!process.env.GITHUB_WEBHOOK_SECRET,
          githubCredentialConfigured: githubConfiguredCredential(),
          githubCredentialMode: "app",
          githubWebhooksReceived: githubWebhookCount(),
        }
      : {};

    return {
      status: "operational",
      agent: `${personaName()} (Slack)`,
      transport: "http",
      activeSessions: activeSessions.size,
      activeQueues: sessionQueues.size,
      pendingInboundEvents: slackEventInbox.pendingCount(),
      inFlightInboundEvents: slackEventInbox.inFlightCount(),
      pendingQuestions: pendingAnswers.size,
      ...githubWebhookHealth,
      queueDetails,
    };
  }
}
